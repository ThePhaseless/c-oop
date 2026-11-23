// Relay over the signaling WebSocket. Besides the direct WebRTC connections, every browser sends what it changed
// itself (document and presence) through the server, encrypted with a key derived from the room secret. The server
// forwards the ciphertext to the other sockets of the room and keeps none of it, so a room works wherever the page
// loads, whether or not any direct connection forms.
//
// One WebSocket message `{ type: 'relay', topic, data }` carries one frame; `data` is base64 of
// iv (12 random bytes) || AES-GCM(key, iv, frame). A frame is
//   bytes 0..7  sender id of the lane: 8 random bytes, new on every socket connect
//   bytes 8..11 seq, uint32 big endian, counts this lane's frames from 0
//   byte 12     flags: 1 = first frame of a message, 2 = last frame
//   bytes 13..  at most RELAY_FRAME bytes of the message
// and a message is one kind byte followed by: ASK (0), 8 bytes `to` (all zero = anyone; seven zero bytes and a 1 =
// anyone, from a newcomer), 8 bytes that sum up the sender's deletes (a state vector does not show them) and a Yjs
// state vector; DOC (1), a Yjs update; AWARENESS (2), a y-protocols awareness update. An ASK to anyone is a request,
// an ASK to one sender id is a claim: "I am answering that request, and here is what I have". A DOC answer that would
// add nothing is not sent, and one for browsers that hold the same deletes leaves the delete set out. Only a
// newcomer's request (every request of a connection until one was claimed) is also answered with everyone's presence;
// later, presence heals through the renewals.
//
// Three lanes, each with its own sender id and seq, so that receivers put their frames together independently:
// presence (the own awareness state while the fast lane is busy), fast (requests, claims, the own document changes,
// and the own awareness state while the lane is idle) and bulk (answers). The pump picks them in that order, so a
// large answer never holds back typing, and a large local change never holds back the presence renewals that keep
// this person in the others' people list. A receiver notices a lost frame as a gap in seq at the sender's next frame
// on that lane; the renewals on the idle fast lane bound how long a lost document change goes unnoticed. The request
// that follows repairs it, except in one case that waits for an audit: see the shortcut at `unconfirmed`.
//
// Received frames go through one promise chain (decrypt, reassemble, apply): WebCrypto is async, and one chain keeps
// the frames in the order they arrived. Nothing in it may throw to the outside or log an error.
//
// Presence is renewed from the socket's `message` event, for any message: y-protocols renews the own state from an
// interval, which Chrome runs once per minute in a tab that has been hidden for a while and has no open data channel,
// and the others drop a state they have not heard of for 30 s. lib0's client gets a `pong` about every 15 s from a
// timer armed inside a message event, which a hidden tab still runs on time, and emits `message` for it.
//
// Relies on y-webrtc 10.3.0 and its lib0 WebsocketClient: `connected`, `ws`, `send`, `on`, `off`, the events
// `connect`, `disconnect` and `message`, and y-webrtc ignoring message types it does not know.
// Nothing here may touch a browser-only global at import time: the module is imported under `bun test`.
//
// shortcut: answers are broadcast to the whole room because the server's pub/sub has no addressing; when rooms or
// documents grow, give each relay an inbox topic of its own (the server allows 4 topics) and publish answers there.
import { type Awareness, applyAwarenessUpdate, encodeAwarenessUpdate } from 'y-protocols/awareness'
import * as Y from 'yjs'
import { MESSAGE_MAX, RELAY_AUDIT_MS, RELAY_FLUSH_MS, RELAY_FRAME, RELAY_JITTER_MS, RELAY_RENEW_MS, RELAY_RESYNC_MS, RELAY_RETRY_MS, SIGNAL } from '../shared/limits'

// A named origin: not 'local' (guardAwareness skips that one) and not null (the editor's undo manager tracks null).
export const RELAY_ORIGIN = 'c-oop:relay'
export type RelaySocket = {
  connected: boolean
  ws: { readyState: number; bufferedAmount?: number } | null
  send(message: unknown): void
  on(name: string, cb: (...args: any[]) => void): void
  off(name: string, cb: (...args: any[]) => void): void
}

const HEADER = 13, FIRST = 1, LAST = 2
const ASK = 0, DOC = 1, AWARENESS = 2
const IV = 12, TAG = 16
const WRAP = 69 // characters of JSON around `data` in a relay message with a 32-character topic
const REQUESTS_MAX = 64 // stored requests; a further sender is ignored
const SENDERS_MAX = 6 * SIGNAL.maxSubscribers // three lanes each, old and new ids around a reconnect
const ANYONE = '0'.repeat(16), NEWCOMER = '0'.repeat(15) + '1' // the two `to` values of a request
const BUFFERED_MAX = 24 * 1024 // bytes waiting in the socket above which answers wait: more than one frame, less than two
const DRAIN_MS = 50 // how often a waiting answer looks at the socket again

const hex = (bytes: Uint8Array) => Array.from(bytes, b => b.toString(16).padStart(2, '0')).join('')
const unhex = (s: string) => Uint8Array.from({ length: s.length / 2 }, (_, i) => parseInt(s.slice(i * 2, i * 2 + 2), 16))

export async function seal(key: CryptoKey, frame: Uint8Array): Promise<string> {
  const iv = crypto.getRandomValues(new Uint8Array(IV))
  const sealed = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, frame as Uint8Array<ArrayBuffer>))
  let s = ''
  for (const part of [iv, sealed]) for (let at = 0; at < part.length; at += 8192) s += String.fromCharCode(...part.subarray(at, at + 8192))
  return btoa(s)
}

/** The frame, or null for anything that is not a frame sealed with this key. */
export async function open(key: CryptoKey, data: string): Promise<Uint8Array | null> {
  try {
    const raw = Uint8Array.from(atob(data), c => c.charCodeAt(0))
    if (raw.length < IV + TAG) return null
    return new Uint8Array(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: raw.subarray(0, IV) }, key, raw.subarray(IV)))
  } catch {
    return null
  }
}

/** `from` is the lane's 8-byte sender id. An empty message is one frame. */
export function toFrames(message: Uint8Array, from: Uint8Array, firstSeq: number): Uint8Array[] {
  const frames: Uint8Array[] = []
  for (let at = 0; at === 0 || at < message.length; at += RELAY_FRAME) {
    const chunk = message.subarray(at, at + RELAY_FRAME)
    const frame = new Uint8Array(HEADER + chunk.length)
    frame.set(from.subarray(0, 8))
    new DataView(frame.buffer).setUint32(8, (firstSeq + frames.length) >>> 0)
    frame[12] = (at === 0 ? FIRST : 0) | (at + RELAY_FRAME >= message.length ? LAST : 0)
    frame.set(chunk, HEADER)
    frames.push(frame)
  }
  return frames
}

/**
 * Puts frames back together per sender. `resync` reports, once, that something of that sender was missed (a gap in
 * seq, or a sender first seen in the middle of a message), at the first frame boundary after it: by then every
 * browser has received the damaged message, so a request sent now is answered with it.
 * `max` bounds the bytes held over all senders; a message that would pass it is skipped, without a resync.
 */
export function createAssembler(max = MESSAGE_MAX): (frame: Uint8Array) => { message?: Uint8Array; from: string; resync?: boolean } {
  // parts null: no message is being collected, so frames without the first flag are dropped
  const senders = new Map<string, { expect: number; parts: Uint8Array[] | null; size: number; broken: boolean }>()
  let total = 0
  return frame => {
    if (frame.length < HEADER) return { from: '' }
    const from = hex(frame.subarray(0, 8))
    const seq = new DataView(frame.buffer, frame.byteOffset).getUint32(8)
    const first = (frame[12]! & FIRST) > 0, last = (frame[12]! & LAST) > 0
    const chunk = frame.subarray(HEADER)
    let s = senders.get(from)
    if (!s) s = { expect: seq, parts: null, size: 0, broken: !first }
    senders.delete(from)
    senders.set(from, s) // the most recently used one is the last key
    if (senders.size > SENDERS_MAX) {
      const [oldest, dropped] = senders.entries().next().value!
      total -= dropped.size
      senders.delete(oldest)
    }
    const forget = () => { total -= s.size; s.size = 0; s.parts = null }
    if (seq !== s.expect) { forget(); s.broken = true }
    s.expect = (seq + 1) >>> 0
    const resync = s.broken && (first || last)
    if (resync) s.broken = false
    const out = resync ? { from, resync } : { from }
    if (first) { forget(); s.parts = [] }
    if (!s.parts) return out
    if (total + chunk.length > max) { forget(); return out }
    s.parts.push(chunk)
    s.size += chunk.length
    total += chunk.length
    if (!last) return out
    const message = new Uint8Array(s.size)
    let at = 0
    for (const part of s.parts) { message.set(part, at); at += part.length }
    forget()
    return { ...out, message }
  }
}

/** A token bucket, full at `now`. The returned function gives the ms to wait; 0 means send now, and the cost is taken. */
export function createBudget(capacity: number, perSecond: number, now: number): (cost: number, now: number) => number {
  let tokens = capacity, last = now
  return (cost, now) => {
    if (now > last) { tokens = Math.min(capacity, tokens + ((now - last) * perSecond) / 1000); last = now }
    cost = Math.min(cost, capacity) // a cost over the capacity would wait for ever
    if (tokens < cost) return Math.ceil(((cost - tokens) * 1000) / perSecond)
    tokens -= cost
    return 0
  }
}

type Vector = Map<number, number>
/** Some client has a higher clock in `a` than in `b`. */
const beyond = (a: Vector, b: Vector) => { for (const [client, clock] of a) if (clock > (b.get(client) ?? 0)) return true; return false }
const raise = (target: Vector, by: Vector) => { for (const [client, clock] of by) if (clock > (target.get(client) ?? 0)) target.set(client, clock) }
type Lane = { id: Uint8Array; seq: number; frames: Uint8Array[] }
// What an ASK says its sender holds. same: its deletes are this browser's, but for ones that reach it anyway. For a
// request, like `had`, the moment of arrival decides: a delete that came in through the relay since is on its way to
// the sender too (one that came in another way and was never relayed waits for this browser's audit), and compared at
// the time of the answer, every backspace in a busy room would put the whole delete set into every answer.
// deletes: a claim's digest, which is compared with `held` when the answer is built.
// shortcut: a claim whose digest this browser never held (the claimer is ahead, or deletes arrived in another order)
// and a delete that arrives between a request being built and arriving both still put the whole delete set into the
// answer, so traffic grows with the document's history while people backspace; when full rooms hold delete sets of
// tens of kB, send only the delete ranges the requester or claimer lacks.
type Have = { sv: Vector; same: boolean; deletes?: string }
// had: the own state vector when the request arrived. Only content held by then decides whether to answer although
// somebody else claimed it: compared with the current vector, every keystroke since would make everyone answer.
type Request = { covered: Vector; same: boolean; had: Vector; newcomer: boolean; claimed: boolean; timer?: ReturnType<typeof setTimeout> }

/**
 * 8 bytes that are equal for two documents exactly when they have deleted the same content (but for a hash collision,
 * which the next delete ends). Clients are sorted because every browser keeps them in its own order.
 */
function deletesOf(doc: Y.Doc): Uint8Array {
  const { clients } = Y.createDeleteSetFromStructStore(doc.store)
  let a = 0x811c9dc5, b = 0x9e3779b9
  const mix = (n: number) => { a = Math.imul(a ^ n, 0x01000193); b = Math.imul(((b << 5) | (b >>> 27)) ^ n, 0x85ebca6b) }
  for (const client of [...clients.keys()].sort((x, y) => x - y)) {
    const runs = clients.get(client)!
    mix(client)
    mix(runs.length)
    for (const { clock, len } of runs) { mix(clock); mix(len) }
  }
  const out = new Uint8Array(8)
  new DataView(out.buffer).setUint32(0, a >>> 0)
  new DataView(out.buffer).setUint32(4, b >>> 0)
  return out
}

/**
 * What `doc` has beyond the state vector `sv`, as a Yjs update. `deletes` false leaves the delete set out, for
 * receivers known to hold the same deletes: it grows with the document's history and would ride on every answer.
 */
export function answerFor(doc: Y.Doc, sv: Uint8Array, deletes: boolean): Uint8Array {
  const update = Y.encodeStateAsUpdate(doc, sv)
  // Updates Yjs holds back (after a lost frame) are merged into `update`, and its end is then not the delete set.
  if (deletes || doc.store.pendingStructs !== null || doc.store.pendingDs !== null) return update
  // An update from the own state vector is a 0 byte (no structs) followed by the delete set that ends every update.
  const tail = Y.encodeStateAsUpdate(doc, Y.encodeStateVector(doc))
  const cut = update.length - (tail.length - 1)
  if (tail[0] !== 0 || cut < 1 || !tail.subarray(1).every((byte, i) => byte === update[cut + i])) return update
  const out = update.slice(0, cut + 1)
  out[cut] = 0 // an empty delete set
  return out
}

export function createRelay(o: {
  doc: Y.Doc
  awareness: Awareness
  topic: string
  key: CryptoKey
  socket: RelaySocket
  flushMs?: number
  jitterMs?: number
  retryMs?: number
  resyncMs?: number
  auditMs?: number
  renewMs?: number
  budget?: { capacity: number; perSecond: number }
  random?: () => number
}): { destroy(): void } {
  const { doc, awareness, topic, key, socket } = o
  const flushMs = o.flushMs ?? RELAY_FLUSH_MS, jitterMs = o.jitterMs ?? RELAY_JITTER_MS, retryMs = o.retryMs ?? RELAY_RETRY_MS
  const resyncMs = o.resyncMs ?? RELAY_RESYNC_MS, auditMs = o.auditMs ?? RELAY_AUDIT_MS, renewMs = o.renewMs ?? RELAY_RENEW_MS
  // Half of what the server allows a connection, and three quarters of its refill: the rest is left for y-webrtc's
  // signaling on the same socket. A rate-limit close would take signaling down too, so the relay must never cause one.
  const allowance = o.budget ?? { capacity: SIGNAL.burstBytes / 2, perSecond: (SIGNAL.bytesPerSecond * 3) / 4 }
  const random = o.random ?? Math.random
  const vector = (): Vector => Y.decodeStateVector(Y.encodeStateVector(doc))
  const lane = (): Lane => ({ id: crypto.getRandomValues(new Uint8Array(8)), seq: 0, frames: [] })
  const ask = (to: Uint8Array) => { const sv = Y.encodeStateVector(doc); const m = new Uint8Array(17 + sv.length); m.set(to, 1); m.set(deletesOf(doc), 9); m.set(sv, 17); return m }
  const tagged = (kind: number, body: Uint8Array) => { const m = new Uint8Array(1 + body.length); m[0] = kind; m.set(body, 1); return m }

  // Everything below is per connection; `gen` changes on connect, disconnect and destroy, and whatever was started
  // under an older one stops at its next check.
  let gen = 0
  let live = false
  let presence = lane(), fast = lane(), bulk = lane()
  let budget = createBudget(allowance.capacity, allowance.perSecond, Date.now())
  let assemble = createAssembler()
  let chain = Promise.resolve()
  let control: (() => Uint8Array)[] = [] // requests and claims, built when they are sent
  let pending: Uint8Array[] = [] // local document updates not sent yet
  let dirty = false // the own awareness state changed
  let serve: Have[] = [] // what the browsers the next DOC answer is for hold
  let docDue = false, awarenessDue = false
  let lastAll = -Infinity // when the last AWARENESS answer was built
  const requests = new Map<string, Request>() // by the requester's sender id
  const want: Vector = new Map() // what others said they hold and this document lacks
  let requestQueued = false, lastRequest = -Infinity, claimed = false // claimed: a claim for this relay came since its last request
  let newcomer = true // no request of this connection has been claimed yet
  // The own delete digests since this connection's last request went out. A claim is built up to a second after the
  // request and then travels, so its digest is often older than the latest delete here. A claimer whose deletes were
  // this browser's at any moment since the request was connected then, and gets the later ones the way it got those
  // (one that came in outside the relay and was never relayed waits for this browser's next request).
  let held = new Set<string>()
  // A local change deleted something and no ASK has shown yet that anybody else holds the same deletes. While that
  // is so, this browser answers requests that somebody else claimed too: state vectors do not show a delete, so a
  // claimer that lacks it would otherwise silence the only browser that has it. At most once per resyncMs
  // (lastExtra): while many people backspace nobody's deletes are ever confirmed, and each would answer every request.
  // shortcut: one ASK with equal deletes ends it, so a delete that reached some browsers and not others is repaired
  // for the rest by the author's next audit; when that shows, put the delete set's digest per client into the ASK.
  let unconfirmed = false, lastExtra = -Infinity
  let spacing = resyncMs // the least time between two requests, see request()
  let previous: Vector = new Map() // the own state vector when the follow-up timer was started
  let pumpTimer: ReturnType<typeof setTimeout> | undefined, followTimer: typeof pumpTimer, askTimer: typeof pumpTimer, auditTimer: typeof pumpTimer, allTimer: typeof pumpTimer
  let pumping = -1 // the generation whose pump is running
  let endSleep: (() => void) | undefined

  // ---- sending ----

  // Listeners and timers only change state and call this. Nothing is sealed or sent from inside a listener.
  const wake = (ms = 0) => {
    pumpTimer ??= setTimeout(() => {
      pumpTimer = undefined
      if (pumping === gen) endSleep?.() // it picks again, so what came up meanwhile can go first
      else void pump()
    }, ms)
  }

  function build(into: Lane, make: () => Uint8Array): boolean {
    try {
      into.frames = toFrames(make(), into.id, into.seq)
      into.seq = (into.seq + into.frames.length) >>> 0
      return true
    } catch {
      return false // a message that cannot be built is skipped
    }
  }

  function take(from: string, request: Request) {
    clearTimeout(request.timer)
    requests.delete(from)
    control.push(() => ask(unhex(from)))
    serve.push({ sv: request.covered, same: request.same })
    docDue = true
    if (request.newcomer) awarenessDue = true
    wake()
  }

  /** The lane whose next frame goes out, with a message built for it when none is in progress. */
  function pick(): Lane | undefined {
    for (;;) {
      if (presence.frames.length) return presence
      if (dirty) {
        dirty = false
        // On the fast lane while that one is idle: a renewal then shows the others a gap left by a lost document change.
        const into = fast.frames.length ? presence : fast
        if (build(into, () => tagged(AWARENESS, encodeAwarenessUpdate(awareness, [doc.clientID])))) return into
        continue
      }
      if (fast.frames.length) return fast
      if (control.length) {
        if (build(fast, control.shift()!)) return fast
        continue
      }
      if (pending.length) {
        const updates = pending
        pending = []
        if (build(fast, () => tagged(DOC, Y.mergeUpdates(updates)))) return fast
        continue
      }
      if (bulk.frames.length) return bulk
      if (docDue) {
        // One answer serves every request this browser can help with now. Their claims go out first, on the fast lane.
        const mine = vector()
        for (const [from, request] of [...requests]) if (beyond(request.had, request.covered)) take(from, request)
        if (control.length) continue
        docDue = false
        const have = serve
        serve = []
        for (const h of have) if (h.deletes !== undefined) h.same = held.has(h.deletes)
        // Nothing to add for any of them: no answer, or every request in a room in sync would send the delete set around.
        if (have.every(h => !beyond(mine, h.sv) && h.same)) continue
        // A client missing from any of the vectors is left out, which Yjs reads as 0.
        const target: Vector = new Map(have[0]!.sv)
        for (const { sv } of have) for (const [client, clock] of target) {
          const theirs = sv.get(client)
          if (theirs === undefined) target.delete(client)
          else if (theirs < clock) target.set(client, theirs)
        }
        // Deletes (which state vectors do not show) travel as the whole delete set, unless everybody served has them.
        if (build(bulk, () => tagged(DOC, answerFor(doc, Y.encodeStateVector(target), have.some(h => !h.same))))) return bulk
        continue
      }
      if (awarenessDue) {
        // Everyone's state goes out at most once per window, later ones wait: when a whole room reconnects, every
        // browser takes several requests, and an answer per request would empty the room's budget on the server.
        // The cost of one such answer grows with the square of the room, so a small room waits less.
        const wait = lastAll + Math.min(resyncMs, 80 * awareness.getStates().size) - Date.now()
        if (wait > 0) {
          allTimer ??= setTimeout(() => { allTimer = undefined; wake() }, wait) // not wake(wait): that would hold back typing
          return undefined
        }
        awarenessDue = false
        lastAll = Date.now()
        if (build(bulk, () => tagged(AWARENESS, encodeAwarenessUpdate(awareness, [...awareness.getStates().keys()])))) return bulk
        continue
      }
      return undefined
    }
  }

  /** Sleeps until the time is over or wake() ends it. */
  async function nap(ms: number) {
    await new Promise<void>(resolve => {
      const timer = setTimeout(resolve, ms)
      endSleep = () => { clearTimeout(timer); resolve() }
    })
    endSleep = undefined
  }

  async function pump() {
    const g = gen
    if (pumping === g) return
    pumping = g
    try {
      while (g === gen) {
        const from = pick()
        if (!from) break
        // On an uplink slower than the budget, frames pile up in the socket and go out in the order they were handed
        // over. Answers wait for it to drain, so typing and presence queue behind two frames of them at most.
        if (from === bulk && (socket.ws?.bufferedAmount ?? 0) > BUFFERED_MAX) {
          await nap(DRAIN_MS)
          continue
        }
        const frame = from.frames[0]!
        const length = Math.ceil((IV + frame.length + TAG) / 3) * 4
        const wait = budget(WRAP + length + SIGNAL.messageCost, Date.now())
        if (wait > 0) {
          await nap(wait)
          continue
        }
        const data = await seal(key, frame)
        // lib0's send throws while the socket is connecting, and a send on a closing socket logs a console error in
        // Chromium although lib0 still reports `connected`.
        if (g !== gen || !socket.connected || socket.ws?.readyState !== 1) break
        from.frames.shift()
        socket.send({ type: 'relay', topic, data })
      }
    } catch {
      // nothing to do: the next connect starts over
    }
    if (pumping === g) pumping = -1
  }

  // ---- asking ----

  function follow() {
    followTimer = undefined
    const mine = vector()
    let again = false
    if (want.size) {
      if (!beyond(want, mine)) want.clear()
      else if (!beyond(previous, mine) && !beyond(mine, previous)) { want.clear(); again = true } // nothing arrived since: the answer was lost
      // else the answer is still arriving
    }
    // The request was lost, or nobody could take it.
    const unanswered = !claimed
    if (unanswered && awareness.getStates().size > 1) again = true
    if (again) request()
    // While the request is unanswered the timer keeps running although nobody is known yet: this browser learns of
    // the others from their next presence frame, and must ask then.
    if (want.size || again || unanswered) startFollow()
  }
  function startFollow() {
    if (followTimer !== undefined) return
    previous = vector()
    followTimer = setTimeout(follow, retryMs)
  }

  function queueRequest() {
    requestQueued = true
    control.push(() => {
      requestQueued = false
      lastRequest = Date.now()
      claimed = false
      held = new Set([hex(deletesOf(doc))])
      startFollow()
      return ask(unhex(newcomer ? NEWCOMER : ANYONE))
    })
    wake()
  }
  /**
   * Queues one request, at most one per `spacing`; inside that window it goes out when the window ends. The spacing
   * starts at resyncMs and doubles each time a request had to wait, up to 8 x resyncMs, so that a room which keeps
   * losing frames, because its budget on the server is empty, asks less and less. A quiet period resets it.
   */
  function request() {
    if (!live || requestQueued || askTimer !== undefined) return
    const now = Date.now()
    if (now - lastRequest >= 2 * spacing) spacing = resyncMs
    const wait = lastRequest + spacing - now
    if (wait <= 0) return queueRequest()
    spacing = Math.min(spacing * 2, 8 * resyncMs)
    askTimer = setTimeout(() => { askTimer = undefined; queueRequest() }, wait)
  }

  // ---- receiving ----

  function handle(message: Uint8Array, from: string) {
    const kind = message[0], body = message.subarray(1)
    if (kind === DOC) return Y.applyUpdate(doc, body, RELAY_ORIGIN)
    if (kind === AWARENESS) return applyAwarenessUpdate(awareness, body, RELAY_ORIGIN)
    if (kind !== ASK || body.length < 16) return
    const to = hex(body.subarray(0, 8)), deletes = hex(body.subarray(8, 16))
    const sv = Y.decodeStateVector(body.subarray(16))
    const same = () => deletes === hex(deletesOf(doc))
    if (unconfirmed && same()) unconfirmed = false
    if (to === ANYONE || to === NEWCOMER) {
      // The sender holds something this browser lacks (edits made offline) and will send it as its answer to a claim.
      // If that answer is lost, this browser asks again instead of waiting for an audit.
      if (beyond(sv, vector())) { raise(want, sv); startFollow() }
      const old = requests.get(from)
      if (!old && requests.size >= REQUESTS_MAX) return
      clearTimeout(old?.timer)
      const entry: Request = { covered: sv, same: same(), had: vector(), newcomer: to === NEWCOMER, claimed: false }
      requests.set(from, entry)
      // The wait spreads the answers; whoever fires first claims the request, and the others then stay silent.
      entry.timer = setTimeout(() => {
        if (requests.get(from) !== entry) return
        if (!entry.claimed || beyond(entry.had, entry.covered)) take(from, entry)
        // Not for a request that showed this browser's deletes: its answer would leave the delete set out.
        else if (unconfirmed && !entry.same && Date.now() - lastExtra >= resyncMs) { lastExtra = Date.now(); take(from, entry) }
        else requests.delete(from)
      }, random() * Math.min(jitterMs, 50 * Math.max(0, awareness.getStates().size - 1)))
    } else if (to === hex(fast.id)) {
      // A claim for this relay. Answering it gives the room what only this browser has: edits made offline, deletes included.
      serve.push({ sv, same: false, deletes })
      docDue = true
      raise(want, sv)
      claimed = true
      newcomer = false
      startFollow()
      wake()
    } else {
      // Somebody else is answering that request, with at least this much.
      const entry = requests.get(to)
      if (entry) { entry.claimed = true; raise(entry.covered, sv) }
    }
  }

  const onMessage = (m: unknown) => {
    // For every message, the server's pong included (see the header comment). The clock rises, so the others accept it.
    const state = awareness.getLocalState(), meta = awareness.meta.get(doc.clientID)
    if (state !== null && meta && Date.now() - meta.lastUpdated >= renewMs) awareness.setLocalState(state)

    const { type, topic: theirs, data } = (m ?? {}) as { type?: unknown; topic?: unknown; data?: unknown }
    if (type !== 'relay' || theirs !== topic || typeof data !== 'string') return
    const g = gen
    chain = chain.then(async () => {
      const frame = g === gen ? await open(key, data) : null
      if (!frame || g !== gen) return
      const got = assemble(frame)
      if (got.resync) request()
      if (got.message) handle(got.message, got.from)
    }).catch(() => {}) // bad frames of any kind are ignored
  }

  // ---- state changes ----

  const onUpdate = (update: Uint8Array, _origin: unknown, _doc: Y.Doc, tr: Y.Transaction) => {
    if (live && tr.deleteSet.clients.size) held.add(hex(deletesOf(doc))) // whatever the origin
    // Updates made while disconnected are not kept: the handshake on connect covers them.
    if (!tr.local) return
    if (tr.deleteSet.clients.size) unconfirmed = true
    if (!live) return
    pending.push(update)
    wake(flushMs)
  }
  // Whatever the origin: a peer that forges a removal of this state makes y-protocols raise the clock, and sending
  // the state again is the answer.
  const onAwareness = ({ added, updated, removed }: { added: number[]; updated: number[]; removed: number[] }) => {
    if (!live || ![...added, ...updated, ...removed].includes(doc.clientID)) return
    dirty = true
    wake()
  }

  function reset() {
    gen++
    live = false
    for (const timer of [pumpTimer, followTimer, askTimer, auditTimer, allTimer]) clearTimeout(timer)
    pumpTimer = followTimer = askTimer = auditTimer = allTimer = undefined
    endSleep?.()
    for (const request of requests.values()) clearTimeout(request.timer)
    requests.clear()
    want.clear()
    control = []
    pending = []
    serve = []
    held = new Set()
    dirty = docDue = awarenessDue = requestQueued = claimed = false
    lastRequest = lastAll = lastExtra = -Infinity
    newcomer = true
    spacing = resyncMs
  }
  const audit = () => {
    auditTimer = setTimeout(() => { request(); audit() }, auditMs * (0.5 + random()))
  }
  const onConnect = () => {
    reset()
    live = true
    presence = lane(); fast = lane(); bulk = lane()
    budget = createBudget(allowance.capacity, allowance.perSecond, Date.now())
    assemble = createAssembler()
    // The server treats a repeat as a no-op; y-webrtc subscribes only after its own key is derived.
    try { socket.send({ type: 'subscribe', topics: [topic] }) } catch { /* the pump checks the socket before every frame */ }
    queueRequest()
    dirty = true
    audit()
  }

  doc.on('update', onUpdate)
  awareness.on('update', onAwareness)
  socket.on('connect', onConnect)
  socket.on('disconnect', reset)
  socket.on('message', onMessage)
  if (socket.connected) onConnect()

  return {
    destroy() {
      reset()
      doc.off('update', onUpdate)
      awareness.off('update', onAwareness)
      socket.off('connect', onConnect)
      socket.off('disconnect', reset)
      socket.off('message', onMessage)
    },
  }
}
