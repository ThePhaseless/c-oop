import { afterEach, expect, test } from 'bun:test'
import { Awareness, applyAwarenessUpdate, encodeAwarenessUpdate } from 'y-protocols/awareness'
import * as Y from 'yjs'
import { COLOR_RE, RELAY_FRAME, RELAY_JITTER_MS, RELAY_RESYNC_MS, SIGNAL } from '../shared/limits'
import { guardAwareness } from './presence'
import { answerFor, createAssembler, createBudget, createRelay, open, type RelaySocket, seal, toFrames } from './relay'
import { guardText } from './text-guard'

const TOPIC = '0123456789abcdef0123456789abcdef'
const ASK = 0, DOC = 1, AWARENESS = 2
const ANYONE = '0000000000000000', NEWCOMER = '0000000000000001'
const isRequest = (s: { kind: number | undefined; to: string | undefined }) => s.kind === ASK && (s.to === ANYONE || s.to === NEWCOMER)
const isClaim = (s: { kind: number | undefined; to: string | undefined }) => s.kind === ASK && s.to !== undefined && !isRequest(s)
const importKey = (fill: number) => crypto.subtle.importKey('raw', new Uint8Array(32).fill(fill), 'AES-GCM', false, ['encrypt', 'decrypt'])
const key = await importKey(1)
const hex = (bytes: Uint8Array) => Array.from(bytes, b => b.toString(16).padStart(2, '0')).join('')
const bytes = (n: number) => Uint8Array.from({ length: n }, (_, i) => (i * 31 + 7) & 255)
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))
// Polls instead of sleeping a fixed time: the machine may be busy with other work.
async function until(cond: () => boolean, ms = 5000): Promise<void> {
  for (const end = Date.now() + ms; !cond(); await sleep(5)) if (Date.now() > end) throw new Error('timed out waiting for: ' + cond)
}

type Seen = { socket: Sock; from: string; seq: number; first: boolean; last: boolean; kind: number | undefined; to: string | undefined; dropped: boolean }
type Sock = RelaySocket & { ws: { readyState: number; bufferedAmount?: number }; sent: { type: string; data?: string }[]; deliver(m: unknown): void; open(): void; close(): void }

// Stands in for the server: every `relay` message goes to the other connected sockets, in the order it was sent.
// It holds the key (the real server does not) so that a test can drop or count frames by sender and kind.
function createHub() {
  const sockets: Sock[] = []
  const kinds = new Map<string, number | undefined>() // sender id -> kind of its message in progress
  const hub = {
    log: [] as Seen[],
    latency: 0, // ms before a message reaches the others
    charged: 0, // what the server would take from the room's bucket: (length + messageCost) for every receiver
    drop: (_: Seen): boolean => false,
    chain: Promise.resolve(),
    /** First frames of `kind` that `socket` sent, counted from log index `since`. */
    count: (socket: Sock, kind: number, since = 0) => hub.log.slice(since).filter(s => s.socket === socket && s.first && s.kind === kind).length,
    /** Waits until nothing has been sent for `ms`. */
    async quiet(ms = 200) {
      for (let n = -1; n !== hub.log.length; ) {
        n = hub.log.length
        await sleep(ms)
        await hub.chain
      }
    },
    socket(connected = true): Sock {
      const listeners = new Map<string, Set<(...args: any[]) => void>>()
      const emit = (name: string, ...args: unknown[]) => { for (const cb of [...(listeners.get(name) ?? [])]) cb(...args) }
      const socket: Sock = {
        connected,
        ws: { readyState: 1 },
        sent: [],
        send(m) {
          const message = m as { type: string; data: string }
          socket.sent.push(message)
          if (message.type !== 'relay') return
          hub.chain = hub.chain.then(async () => {
            const frame = (await open(key, message.data))!
            const from = hex(frame.subarray(0, 8)), first = (frame[12]! & 1) > 0
            if (first) kinds.set(from, frame[13])
            const kind = kinds.get(from)
            const seen: Seen = { socket, from, seq: new DataView(frame.buffer).getUint32(8), first, last: (frame[12]! & 2) > 0, kind, to: first && kind === ASK ? hex(frame.subarray(14, 22)) : undefined, dropped: false }
            hub.log.push(seen)
            if ((seen.dropped = hub.drop(seen))) return
            const others = sockets.filter(other => other !== socket && other.connected)
            hub.charged += (JSON.stringify(message).length + SIGNAL.messageCost) * others.length
            const deliver = () => { for (const other of others) if (other.connected) other.deliver(message) }
            if (hub.latency) setTimeout(deliver, hub.latency)
            else deliver()
          })
        },
        on: (name, cb) => void (listeners.get(name) ?? listeners.set(name, new Set()).get(name)!).add(cb),
        off: (name, cb) => void listeners.get(name)?.delete(cb),
        deliver: m => emit('message', m, socket),
        open() { socket.connected = true; emit('connect', { type: 'connect' }, socket) },
        close() { socket.connected = false; emit('disconnect', { type: 'disconnect' }, socket) },
      }
      sockets.push(socket)
      return socket
    },
  }
  return hub
}
type Hub = ReturnType<typeof createHub>

const cleanup: (() => void)[] = []
afterEach(() => { for (const f of cleanup.splice(0)) f() })

type Options = Partial<Parameters<typeof createRelay>[0]> & { name?: string; connected?: boolean }
function peer(hub: Hub, o: Options = {}) {
  const doc = new Y.Doc()
  const awareness = new Awareness(doc)
  awareness.setLocalStateField('user', { name: o.name ?? 'someone', color: '#376ce9' })
  const socket = hub.socket(o.connected ?? true)
  const text = doc.getText('code')
  const start = () => createRelay({ doc, awareness, topic: TOPIC, key, socket, flushMs: 5, jitterMs: 50, resyncMs: 20, ...o })
  const p = { doc, awareness, socket, text, relay: undefined as ReturnType<typeof createRelay> | undefined, start: () => (p.relay = start()), clock: (of: { doc: Y.Doc }) => p.awareness.meta.get(of.doc.clientID)?.clock ?? -1 }
  cleanup.push(() => { p.relay?.destroy(); awareness.destroy(); doc.destroy() })
  return p
}
const joined = (hub: Hub, o: Options = {}) => { const p = peer(hub, o); p.start(); return p }
type Peer = ReturnType<typeof peer>
const same = (...peers: Peer[]) => () => peers.every(p => p.text.toString() === peers[0]!.text.toString())
const knows = (a: Peer, b: Peer) => () => a.awareness.getStates().has(b.doc.clientID)
/** A sealed relay message as a foreign sender would put it on the wire. */
async function forged(message: Uint8Array, from = crypto.getRandomValues(new Uint8Array(8))) {
  return Promise.all(toFrames(message, from, 0).map(async frame => ({ type: 'relay', topic: TOPIC, data: await seal(key, frame) })))
}
const message = (kind: number, ...parts: Uint8Array[]) => Uint8Array.from([kind, ...parts.flatMap(p => [...p])])
/** The update of a document in which somebody typed `runs * 2` characters and deleted every other one. */
function deleted(runs: number): Uint8Array {
  const doc = new Y.Doc(), text = doc.getText('code')
  text.insert(0, 'x'.repeat(runs * 2))
  doc.transact(() => { for (let i = runs - 1; i >= 0; i--) text.delete(i * 2, 1) })
  return Y.encodeStateAsUpdate(doc)
}

// ---- pure helpers ----

test('seal and open round trip; a wrong key and a flipped byte give null', async () => {
  const frame = bytes(500)
  const data = await seal(key, frame)
  expect(await open(key, data)).toEqual(frame)
  expect(await seal(key, frame)).not.toBe(data) // a fresh iv each time
  expect(await open(await importKey(2), data)).toBeNull()
  const raw = Uint8Array.from(atob(data), c => c.charCodeAt(0))
  raw[40]! ^= 1
  expect(await open(key, btoa(String.fromCharCode(...raw)))).toBeNull()
  expect(await open(key, '!!! not base64 !!!')).toBeNull()
  expect(await open(key, 'AAAA')).toBeNull()
})

test('a sealed full frame inside its JSON fits SIGNAL.maxPayload', async () => {
  const [full] = toFrames(bytes(RELAY_FRAME * 2), bytes(8), 0)
  expect(full!.length).toBe(13 + RELAY_FRAME)
  const wire = JSON.stringify({ type: 'relay', topic: TOPIC, data: await seal(key, full!) })
  expect(wire.length).toBe(14_793)
  expect(wire.length).toBeLessThanOrEqual(SIGNAL.maxPayload)
})

test('a message of 0, 1, 11,000, 11,001 and 300,000 bytes splits into frames and comes back whole', () => {
  for (const [size, count] of [[0, 1], [1, 1], [11_000, 1], [11_001, 2], [300_000, 28]] as const) {
    const whole = bytes(size), from = bytes(8)
    const frames = toFrames(whole, from, 7)
    expect(frames.length).toBe(count)
    expect(frames.map(f => new DataView(f.buffer).getUint32(8))).toEqual(frames.map((_, i) => 7 + i))
    expect(frames.map(f => f[12])).toEqual(frames.map((_, i) => (i === 0 ? 1 : 0) | (i === count - 1 ? 2 : 0)))
    const assemble = createAssembler()
    const out = frames.map(f => assemble(f))
    expect(out.slice(0, -1).every(r => r.message === undefined && !r.resync)).toBe(true)
    expect(out.at(-1)).toEqual({ from: hex(from), message: whole })
  }
})

test('a missing frame delivers nothing and reports resync at the next boundary', () => {
  const assemble = createAssembler()
  const from = bytes(8)
  const [a, , c, d] = toFrames(bytes(RELAY_FRAME * 3 + 1), from, 0)
  const next = toFrames(bytes(10), from, 4)[0]!
  expect(assemble(a!)).toEqual({ from: hex(from) })
  expect(assemble(c!)).toEqual({ from: hex(from) })
  expect(assemble(d!)).toEqual({ from: hex(from), resync: true })
  expect(assemble(next)).toEqual({ from: hex(from), message: bytes(10) }) // reported once; the next message is whole
})

test('a lost single-frame message reports resync at the next first frame and still delivers that one', () => {
  const assemble = createAssembler()
  const from = bytes(8)
  expect(assemble(toFrames(bytes(3), from, 0)[0]!).message).toEqual(bytes(3))
  expect(assemble(toFrames(bytes(5), from, 2)[0]!)).toEqual({ from: hex(from), message: bytes(5), resync: true })
})

test('a sender first seen in the middle of a message delivers nothing and reports resync at its last frame', () => {
  const assemble = createAssembler()
  const from = bytes(8)
  const [, b, c] = toFrames(bytes(RELAY_FRAME * 2 + 1), from, 0)
  expect(assemble(b!)).toEqual({ from: hex(from) })
  expect(assemble(c!)).toEqual({ from: hex(from), resync: true })
  expect(assemble(toFrames(bytes(9), from, 3)[0]!)).toEqual({ from: hex(from), message: bytes(9) })
})

test('frames of two senders interleaved give both messages', () => {
  const assemble = createAssembler()
  const one = bytes(RELAY_FRAME + 5), two = bytes(RELAY_FRAME + 9).reverse()
  const [a1, a2] = toFrames(one, new Uint8Array(8).fill(1), 0), [b1, b2] = toFrames(two, new Uint8Array(8).fill(2), 0)
  expect([a1!, b1!].map(f => assemble(f).message)).toEqual([undefined, undefined])
  expect(assemble(a2!).message).toEqual(one)
  expect(assemble(b2!).message).toEqual(two)
})

test('past the maximum a message is skipped up to its last frame, without a resync, and the next one arrives', () => {
  const assemble = createAssembler(RELAY_FRAME * 2)
  const from = bytes(8)
  const big = toFrames(bytes(RELAY_FRAME * 3), from, 0)
  expect(big.map(f => assemble(f))).toEqual(big.map(() => ({ from: hex(from) })))
  expect(assemble(toFrames(bytes(RELAY_FRAME * 2), from, 3)[0]!).message).toBeUndefined()
  expect(assemble(toFrames(bytes(RELAY_FRAME * 2), from, 3)[1]!).message).toEqual(bytes(RELAY_FRAME * 2))
  // The cap counts every sender together: a second sender cannot add to what the first one holds.
  const other = new Uint8Array(8).fill(9)
  assemble(toFrames(bytes(RELAY_FRAME * 2), from, 5)[0]!)
  expect(toFrames(bytes(RELAY_FRAME * 2), other, 0).map(f => assemble(f).message)).toEqual([undefined, undefined])
  expect(assemble(toFrames(bytes(RELAY_FRAME * 2), from, 5)[1]!).message).toEqual(bytes(RELAY_FRAME * 2))
})

test('createBudget returns the exact wait', () => {
  const budget = createBudget(1000, 500, 10_000)
  expect(budget(600, 10_000)).toBe(0)
  expect(budget(600, 10_000)).toBe(400) // 200 short at 500 per second
  expect(budget(600, 10_399)).toBe(1)
  expect(budget(600, 10_400)).toBe(0)
  expect(budget(1, 10_400)).toBe(2)
  expect(budget(1000, 60_000)).toBe(0) // never above capacity
  expect(budget(1, 60_000)).toBe(2)
  expect(budget(1, 50_000)).toBe(2) // a clock that steps back refills nothing
})

test('the frames of a 256,000-character ASCII run cost less than half of the connection burst', async () => {
  const doc = new Y.Doc()
  doc.getText('out').insert(0, 'a'.repeat(256_000))
  const frames = toFrames(message(DOC, Y.encodeStateAsUpdate(doc)), bytes(8), 0)
  let cost = 0
  for (const frame of frames) cost += 69 + (await seal(key, frame)).length + SIGNAL.messageCost
  expect(frames.length).toBe(24)
  expect(cost).toBeLessThan(SIGNAL.burstBytes / 2)
})

test('an answer without the delete set is small and applies; with updates held back the whole update is sent', () => {
  const a = new Y.Doc(), b = new Y.Doc(), history = deleted(1000)
  Y.applyUpdate(a, history)
  Y.applyUpdate(b, history)
  const sv = Y.encodeStateVector(b)
  a.getText('code').insert(0, 'more ')
  expect(answerFor(a, sv, true)).toEqual(Y.encodeStateAsUpdate(a, sv))
  expect(answerFor(a, sv, true).length).toBeGreaterThan(2500)
  const cut = answerFor(a, sv, false)
  expect(cut.length).toBeLessThan(100)
  Y.applyUpdate(b, cut)
  expect(b.getText('code').toString()).toBe(a.getText('code').toString())
  expect(Y.encodeStateAsUpdate(b)).toEqual(Y.encodeStateAsUpdate(a))

  // The second of two updates alone: Yjs holds it back and merges it into every update it encodes.
  const other = new Y.Doc(), late: Uint8Array[] = []
  other.on('update', (u: Uint8Array) => late.push(u))
  other.getText('code').insert(0, 'first')
  other.getText('code').insert(5, ' second')
  other.getText('code').delete(0, 1)
  for (const held of [late[1]!, late[2]!]) {
    const c = new Y.Doc(), d = new Y.Doc()
    Y.applyUpdate(c, history)
    Y.applyUpdate(d, history)
    Y.applyUpdate(c, held)
    c.getText('code').insert(0, 'more ')
    expect(c.store.pendingStructs !== null || c.store.pendingDs !== null).toBe(true)
    const whole = answerFor(c, Y.encodeStateVector(d), false)
    expect(whole).toEqual(Y.encodeStateAsUpdate(c, Y.encodeStateVector(d)))
    Y.applyUpdate(d, whole)
    expect(d.getText('code').toString()).toBe(c.getText('code').toString())
  }
})

// ---- relays ----

const LOAD_AUDIT_MS = 40_000 // the app's is 120 s: three times the audits, so that the run is short

test('two relays converge on text and on each other\'s user, in both directions', async () => {
  const hub = createHub()
  const a = joined(hub, { name: 'Ada' }), b = joined(hub, { name: 'Bob' })
  expect(a.socket.sent[0] as unknown).toEqual({ type: 'subscribe', topics: [TOPIC] })
  a.text.insert(0, 'from a\n')
  await until(() => b.text.toString() === 'from a\n')
  b.text.insert(0, 'from b\n')
  await until(() => a.text.toString() === 'from b\nfrom a\n')
  await until(() => b.awareness.getStates().get(a.doc.clientID)?.user?.name === 'Ada' && a.awareness.getStates().get(b.doc.clientID)?.user?.name === 'Bob')
  for (const sent of [...a.socket.sent, ...b.socket.sent]) expect(JSON.stringify(sent)).not.toContain('from')
})

test('a relay that joins a room with text gets it, and its own text made before it joined reaches the room', async () => {
  const hub = createHub()
  const a = peer(hub), b = peer(hub)
  a.text.insert(0, 'template\n')
  a.start()
  b.text.insert(0, 'offline work\n')
  b.start()
  await until(() => a.text.toString().includes('offline work') && a.text.toString().includes('template') && same(a, b)())
})

test('edits made while disconnected, a delete-only one included, arrive after reconnect', async () => {
  const hub = createHub()
  const a = joined(hub), b = joined(hub)
  a.text.insert(0, 'hello world')
  await until(same(a, b))
  a.socket.close()
  a.text.insert(5, ',')
  b.text.insert(0, '> ')
  await sleep(50)
  expect(b.text.toString()).toBe('> hello world')
  a.socket.open()
  await until(() => a.text.toString() === '> hello, world' && same(a, b)())
  await hub.quiet()
  a.socket.close()
  a.text.delete(0, 2) // a state vector does not show a delete
  a.socket.open()
  await until(() => b.text.toString() === 'hello, world')
  await hub.quiet()
  a.socket.close()
  b.text.delete(5, 1) // and the other way round: a delete made by someone else meanwhile
  await hub.quiet() // B has sent it while A is away
  a.socket.open()
  await until(() => a.text.toString() === 'hello world')
})

test('a request in a room that is in sync, deletes included, draws no DOC', async () => {
  const hub = createHub()
  const a = joined(hub), b = joined(hub), c = joined(hub)
  a.text.insert(0, 'hello wrodl')
  await until(same(a, b, c))
  b.text.delete(6, 5)
  await until(() => c.text.toString() === 'hello ' && same(a, b, c)())
  await hub.quiet()
  const since = hub.log.length
  c.socket.close()
  c.socket.open() // asks, as a reload with a stored copy does
  await until(() => hub.log.slice(since).some(isClaim)) // the request was claimed
  await hub.quiet()
  expect([a, b, c].map(p => hub.count(p.socket, DOC, since))).toEqual([0, 0, 0])
})

test('an answer for a browser that has the same deletes and lacks an insert leaves the delete set out', async () => {
  const hub = createHub()
  const a = peer(hub), b = peer(hub)
  const history = deleted(1000)
  for (const p of [a, b]) { Y.applyUpdate(p.doc, history, 'seed'); p.start() }
  await until(() => knows(a, b)() && knows(b, a)())
  await hub.quiet()
  b.socket.close()
  a.text.insert(0, 'typed while B was away ')
  await hub.quiet()
  const sent = a.socket.sent.length, since = hub.log.length
  b.socket.open()
  await until(same(a, b))
  await hub.quiet()
  expect(hub.count(a.socket, DOC, since)).toBe(1)
  expect(a.socket.sent.slice(sent).reduce((n, m) => n + (m.data?.length ?? 0), 0)).toBeLessThan(2500) // the delete set alone is more
})

test('a delete that arrives between a request and its answer does not put the delete set into the answer', async () => {
  const hub = createHub()
  const a = peer(hub, { random: () => 0.99 }), b = peer(hub) // A answers 49 ms after the request
  const history = deleted(1000)
  for (const p of [a, b]) { Y.applyUpdate(p.doc, history, 'seed'); p.start() }
  a.text.insert(0, 'hello ')
  await until(() => same(a, b)() && knows(a, b)() && knows(b, a)())
  await hub.quiet()
  // A request from someone who has A's deletes and lacks 'hello': the digest is taken from A's own last ASK.
  const frames = await Promise.all(a.socket.sent.filter(m => m.type === 'relay').map(m => open(key, m.data!)))
  const digest = frames.findLast(f => f![12] === 3 && f![13] === ASK)!.subarray(22, 30)
  hub.drop = s => s.socket === b.socket && s.kind === ASK // B's claim would silence A
  const sent = a.socket.sent.length, since = hub.log.length
  const stranger = hub.socket()
  for (const m of await forged(message(ASK, new Uint8Array(8), digest, Y.encodeStateVectorFromUpdate(history)))) stranger.send(m)
  b.text.delete(0, 1) // reaches A before its answer; whoever has A's deletes gets this one the same way
  await until(() => hub.count(a.socket, DOC, since) === 1)
  await hub.quiet()
  expect(a.text.toString().startsWith('ello ')).toBe(true)
  expect(a.socket.sent.slice(sent).reduce((n, m) => n + (m.data?.length ?? 0), 0)).toBeLessThan(2500)
})

test('a delete that reaches the requester before the claim that shows it does not put the delete set into the answer', async () => {
  const hub = createHub()
  const a = peer(hub), b = peer(hub, { random: () => 0.99 }) // B claims 49 ms after the request
  const history = deleted(1000)
  for (const p of [a, b]) { Y.applyUpdate(p.doc, history, 'seed'); p.start() }
  await until(() => knows(a, b)() && knows(b, a)())
  await hub.quiet()
  a.socket.close()
  a.text.insert(0, 'typed while away ')
  const sent = a.socket.sent.length, since = hub.log.length
  a.socket.open() // asks, with the deletes it has now
  b.text.delete(0, 1) // reaches A before B's claim, and the claim shows it
  await until(() => same(a, b)() && hub.count(a.socket, DOC, since) === 1)
  await hub.quiet()
  expect(hub.count(a.socket, DOC, since)).toBe(1)
  expect(a.socket.sent.slice(sent).reduce((n, m) => n + (m.data?.length ?? 0), 0)).toBeLessThan(2500) // the delete set alone is more
})

test('an update applied with a foreign origin is not published, and a relayed one is not echoed', async () => {
  const hub = createHub()
  const a = joined(hub), b = joined(hub)
  await until(() => knows(a, b)() && knows(b, a)())
  await hub.quiet()
  const since = hub.log.length
  a.text.insert(0, 'typed ')
  await until(() => b.text.toString() === 'typed ')
  await hub.quiet()
  expect(hub.count(a.socket, DOC, since)).toBe(1)
  expect(hub.count(b.socket, DOC, since)).toBe(0)
  const other = new Y.Doc()
  other.getText('code').insert(0, 'from webrtc')
  Y.applyUpdate(a.doc, Y.encodeStateAsUpdate(other), 'somewhere else')
  await hub.quiet()
  expect(a.text.toString()).toContain('from webrtc')
  expect(hub.count(a.socket, DOC, since)).toBe(1)
  expect(b.text.toString()).toBe('typed ')
})

test('six relays and a seventh that joins: it gets the document and at most two of the six send it', async () => {
  const hub = createHub()
  const six = Array.from({ length: 6 }, (_, i) => joined(hub, { jitterMs: 1000, random: () => (i + 1) / 7 }))
  six[0]!.text.insert(0, 'the document\n')
  await until(() => same(...six)() && six.every(p => p.awareness.getStates().size === 6))
  await hub.quiet()
  const since = hub.log.length
  const seventh = joined(hub)
  await until(() => seventh.text.toString() === 'the document\n')
  await hub.quiet(400)
  const senders = six.filter(p => hub.count(p.socket, DOC, since) > 0).length
  expect(senders).toBeGreaterThanOrEqual(1)
  expect(senders).toBeLessThanOrEqual(2)
  expect(seventh.awareness.getStates().size).toBe(7)
})

test('one holder and ten joiners that ask at the same moment: all get the document from at most two answers', async () => {
  const hub = createHub()
  const holder = peer(hub)
  holder.text.insert(0, 'the document\n')
  holder.start()
  await hub.quiet()
  const since = hub.log.length
  const ten = Array.from({ length: 10 }, () => joined(hub))
  await until(() => ten.every(p => p.text.toString() === 'the document\n'))
  await hub.quiet()
  expect(hub.count(holder.socket, DOC, since)).toBeGreaterThanOrEqual(1)
  expect(hub.count(holder.socket, DOC, since)).toBeLessThanOrEqual(2)
})

// One full frame costs about 15,049, so this budget sends about four frames per second.
const SLOW = { capacity: 16_000, perSecond: 60_000 }

test('a local edit made while a slow answer is in flight arrives before the answer\'s last frame', async () => {
  const hub = createHub()
  const a = peer(hub, { budget: SLOW })
  a.text.insert(0, 'x'.repeat(70_000)) // seven frames
  a.start()
  await hub.quiet()
  const b = joined(hub)
  const answer = () => hub.log.find(s => s.socket === a.socket && s.kind === DOC && s.first && !s.last)
  await until(() => answer() !== undefined)
  const started = Date.now()
  a.text.insert(0, 'TYPED')
  // On the wire: B itself can only show the edit once it has the text the edit sits in, which is the answer.
  const typed = () => hub.log.findIndex(s => s.socket === a.socket && s.kind === DOC && s.from !== answer()!.from)
  await until(() => typed() >= 0)
  expect(hub.log.slice(0, typed()).some(s => s.from === answer()!.from && s.last)).toBe(false)
  await until(() => hub.log.some(s => s.from === answer()!.from && s.last) && same(a, b)(), 10_000)
  expect(Date.now() - started).toBeGreaterThan(1000)
})

test('an answer waits while the socket has a lot buffered, and the own typing does not', async () => {
  const hub = createHub()
  const a = peer(hub)
  a.text.insert(0, 'x'.repeat(30_000))
  a.start()
  await hub.quiet()
  a.socket.ws.bufferedAmount = 30_000 // a slow uplink that has not sent two frames yet
  const since = hub.log.length
  const b = joined(hub)
  const sent = (whole: boolean) => hub.log.slice(since).some(s => s.socket === a.socket && s.kind === DOC && s.first && s.last === whole)
  await until(() => hub.log.slice(since).some(s => s.socket === a.socket && isClaim(s)))
  a.text.insert(0, 'TYPED')
  await until(() => sent(true))
  await sleep(150)
  await hub.chain
  expect(sent(false)).toBe(false)
  a.socket.ws.bufferedAmount = 0
  await until(() => sent(false) && same(a, b)())
})

test('a presence renewal arrives before the last frame of a slow local edit', async () => {
  const hub = createHub()
  const a = joined(hub, { budget: { capacity: 16_000, perSecond: 30_000 } }), b = joined(hub)
  await until(() => knows(b, a)() && knows(a, b)())
  await hub.quiet()
  const since = hub.log.length
  a.text.insert(0, 'x'.repeat(60_000)) // six frames at two per second
  const edit = () => hub.log.slice(since).find(s => s.socket === a.socket && s.kind === DOC && s.first && !s.last)
  await until(() => edit() !== undefined)
  const clock = b.clock(a)
  a.awareness.meta.get(a.doc.clientID)!.lastUpdated -= 9000
  a.socket.deliver({ type: 'pong' })
  await until(() => b.clock(a) > clock)
  await hub.chain
  expect(hub.log.some(s => s.from === edit()!.from && s.seq > edit()!.seq && s.last)).toBe(false)
  await until(same(a, b), 10_000)
})

test('an update one relay holds and nobody publishes reaches the others after the audit interval', async () => {
  const hub = createHub()
  const o = { auditMs: 150 }
  const a = joined(hub, o), b = joined(hub, o), c = joined(hub, o)
  await until(() => [a, b, c].every(p => p.awareness.getStates().size === 3))
  const other = new Y.Doc()
  other.getText('code').insert(0, 'only b has this')
  Y.applyUpdate(b.doc, Y.encodeStateAsUpdate(other), 'somewhere else')
  await until(() => c.text.toString() === 'only b has this' && same(a, b, c)())
})

test('the joiner\'s first request is lost: it still gets the document after retryMs', async () => {
  const hub = createHub()
  const holder = peer(hub)
  holder.text.insert(0, 'the document\n')
  holder.start()
  await hub.quiet()
  let lost = 0
  const joiner = peer(hub, { retryMs: 150 })
  hub.drop = s => s.socket === joiner.socket && isRequest(s) && lost++ === 0
  joiner.start()
  await sleep(250) // the first follow-up passes while the joiner knows of nobody
  expect(lost).toBe(1)
  expect(joiner.text.toString()).toBe('')
  holder.awareness.setLocalStateField('cursor', null) // the holder shows up (in the app: its presence renewal)
  await until(() => joiner.text.toString() === 'the document\n')
  expect(lost).toBe(2)
})

test('an edit made while disconnected whose answer is lost arrives after retryMs', async () => {
  const hub = createHub()
  const a = joined(hub), b = joined(hub, { retryMs: 150 })
  a.text.insert(0, 'hello')
  await until(() => same(a, b)() && knows(a, b)() && knows(b, a)())
  await hub.quiet()
  a.socket.close()
  a.text.insert(5, ' offline')
  let lost = 0
  hub.drop = s => s.socket === a.socket && s.kind === DOC && lost++ === 0
  a.socket.open()
  await until(() => b.text.toString() === 'hello offline')
  expect(lost).toBeGreaterThanOrEqual(2) // the first DOC was dropped; a later one brought the edit
})

test('a request with a clock nobody has makes each relay ask once and not again', async () => {
  const hub = createHub()
  const o = { retryMs: 150 }
  const a = joined(hub, o), b = joined(hub, o)
  await until(() => knows(a, b)() && knows(b, a)())
  await hub.quiet()
  const since = hub.log.length
  const stranger = hub.socket()
  for (const m of await forged(message(ASK, new Uint8Array(16), Y.encodeStateVector(new Map([[999_999, 5]]))))) stranger.send(m)
  const asked = (p: Peer) => hub.log.slice(since).filter(s => s.socket === p.socket && isRequest(s)).length
  await until(() => asked(a) === 1 && asked(b) === 1)
  await sleep(150 * 4)
  await hub.quiet()
  expect([asked(a), asked(b)]).toEqual([1, 1])
})

test('one lost frame of a multi-frame DOC: the relays converge', async () => {
  const hub = createHub()
  const a = joined(hub), b = joined(hub)
  await until(() => knows(a, b)() && knows(b, a)())
  await hub.quiet()
  let lost = 0
  hub.drop = s => s.socket === a.socket && s.kind === DOC && !s.first && !s.last && lost++ === 0
  a.text.insert(0, 'x'.repeat(30_000))
  await until(() => b.text.length === 30_000 && same(a, b)())
  expect(lost).toBeGreaterThanOrEqual(1)
})

test('a lost single-frame DOC followed by a later frame of the same sender: the relays converge', async () => {
  const hub = createHub()
  const a = joined(hub), b = joined(hub)
  await until(() => knows(a, b)() && knows(b, a)())
  await hub.quiet()
  let lost = 0
  hub.drop = s => s.socket === a.socket && s.kind === DOC && lost++ === 0
  a.text.insert(0, 'first')
  await until(() => lost === 1)
  await hub.quiet()
  expect(b.text.toString()).toBe('')
  a.text.insert(5, ' second')
  await until(() => b.text.toString() === 'first second')
})

test('a lost single-frame DOC is noticed at the sender\'s next presence renewal', async () => {
  const hub = createHub()
  const o = { auditMs: 600_000 }
  const a = joined(hub, o), b = joined(hub, o)
  await until(() => knows(a, b)() && knows(b, a)())
  await hub.quiet()
  let lost = 0
  hub.drop = s => s.socket === a.socket && s.kind === DOC && lost++ === 0
  a.text.insert(0, 'lost edit')
  await until(() => lost === 1)
  await hub.quiet()
  expect(b.text.toString()).toBe('')
  const since = hub.log.length
  a.awareness.meta.get(a.doc.clientID)!.lastUpdated -= 9000
  a.socket.deliver({ type: 'pong' })
  await until(() => b.text.toString() === 'lost edit')
  expect(hub.log.slice(since).filter(s => s.socket === b.socket && isRequest(s)).length).toBeGreaterThanOrEqual(1)
})

test('requests after gaps that keep coming are spaced further and further apart', async () => {
  const hub = createHub()
  const a = joined(hub, { resyncMs: 100 })
  await hub.quiet()
  const since = hub.log.length
  const from = bytes(8)
  // Every frame skips a seq, so each one reports a gap. Unspaced that would be a request per 100 ms.
  for (let i = 0, end = Date.now() + 1000; Date.now() < end; i++) {
    a.socket.deliver({ type: 'relay', topic: TOPIC, data: await seal(key, toFrames(message(9), from, i * 2)[0]!) })
    await sleep(10)
  }
  await hub.chain
  const asked = hub.log.slice(since).filter(isRequest).length
  expect(asked).toBeGreaterThanOrEqual(2)
  expect(asked).toBeLessThanOrEqual(5)
})

test('64 relays that connect at the same moment stay inside the room\'s relay budget', async () => {
  const hub = createHub()
  hub.latency = 126
  // The spacing of requests and answers that the app ships.
  const all = Array.from({ length: 64 }, () => peer(hub, { jitterMs: RELAY_JITTER_MS, resyncMs: RELAY_RESYNC_MS }))
  for (const p of all) p.awareness.setLocalStateField('cursor', { anchor: { type: null, tname: 'code', item: { client: 1234567890, clock: 1234 }, assoc: 0 }, head: { type: null, tname: 'code', item: { client: 1234567890, clock: 1234 }, assoc: 0 } })
  // Everyone knows everyone, as after a server restart: each answer then carries 64 presence states.
  for (const p of all) for (const q of all) if (p !== q) applyAwarenessUpdate(q.awareness, encodeAwarenessUpdate(p.awareness, [p.doc.clientID]), 'seed')
  for (const p of all) p.start()
  await sleep(RELAY_RESYNC_MS + 5000) // past the answers that had to wait for RELAY_RESYNC_MS
  await hub.chain
  expect(hub.charged).toBeGreaterThan(0)
  expect(hub.charged).toBeLessThan(SIGNAL.topicBurstBytes)
}, 60_000)

test('a second answer with everyone\'s presence inside the window waits for the window to end and is then sent', async () => {
  const hub = createHub()
  const o = { resyncMs: 1500, auditMs: 600_000 }
  const a = joined(hub, o)
  // 80 ms per person A knows of: with 20 more the window is the whole resyncMs.
  for (let i = 0; i < 20; i++) { const q = peer(hub, { connected: false }); applyAwarenessUpdate(a.awareness, encodeAwarenessUpdate(q.awareness, [q.doc.clientID]), 'seed') }
  await hub.quiet() // A's own presence is out before B is there, so B can learn of A only from A's answer
  const b = joined(hub, o)
  await until(knows(b, a)) // A has just sent everyone's presence
  const answered = Date.now()
  b.relay!.destroy()
  b.socket.close() // gone without a word, so only A can answer the next request
  const c = joined(hub, o)
  await until(knows(a, c))
  await sleep(500)
  expect(knows(c, a)()).toBe(false) // inside the window: held back
  await until(knows(c, a), 3000) // and sent when it ends, not dropped
  expect(Date.now() - answered).toBeGreaterThanOrEqual(1400)
  expect(knows(c, b)()).toBe(true) // it was the answer with everyone's presence
})

test('in a room of three the people list reaches the next newcomer within a fraction of resyncMs', async () => {
  const hub = createHub()
  const o = { resyncMs: 5000, auditMs: 600_000 }
  const a = joined(hub, o)
  await hub.quiet()
  const b = joined(hub, o)
  await until(knows(b, a))
  b.relay!.destroy()
  b.socket.close()
  const started = Date.now()
  const c = joined(hub, o)
  await until(knows(c, a), 2000)
  expect(Date.now() - started).toBeLessThan(1500)
})

test('only a newcomer\'s request is answered with everyone\'s presence', async () => {
  const hub = createHub()
  const o = { auditMs: 150 }
  const a = joined(hub, o), b = joined(hub, o)
  await until(() => knows(a, b)() && knows(b, a)())
  await until(() => hub.log.filter(s => s.kind === ASK && s.to === NEWCOMER).length >= 2) // the hub logs a frame only after decrypting it
  await hub.quiet(50)
  const since = hub.log.length
  await until(() => hub.log.slice(since).filter(s => s.kind === ASK && s.to === ANYONE).length >= 4) // audits
  await hub.chain
  expect(hub.log.slice(since).some(s => s.kind === ASK && s.to === NEWCOMER)).toBe(false)
  expect(hub.log.slice(since).some(s => s.kind === AWARENESS)).toBe(false)
})

test('a lost delete-only edit is repaired at the next renewal although a browser that lacks it claims the request first', async () => {
  const hub = createHub()
  const o = { auditMs: 600_000 }
  const a = joined(hub, { ...o, random: () => 0.99 }), b = joined(hub, { ...o, random: () => 0.01 }), c = joined(hub, { ...o, random: () => 0.01 })
  a.text.insert(0, 'hello world')
  await until(() => same(a, b, c)() && [a, b, c].every(p => p.awareness.getStates().size === 3))
  await hub.quiet()
  let lost = 0
  hub.drop = s => s.socket === a.socket && s.kind === DOC && lost++ === 0
  a.text.delete(0, 6)
  await until(() => lost === 1)
  await hub.quiet()
  expect(b.text.toString()).toBe('hello world')
  a.awareness.meta.get(a.doc.clientID)!.lastUpdated -= 9000
  a.socket.deliver({ type: 'pong' })
  await until(() => b.text.toString() === 'world' && same(a, b, c)(), 1500)
})

test('a browser whose deletes nobody confirmed answers claimed requests once per resyncMs, not each of them', async () => {
  const hub = createHub()
  const o = { resyncMs: 1500, auditMs: 600_000 }
  const a = joined(hub, { ...o, random: () => 0.99 }), b = joined(hub, { ...o, random: () => 0.01 }), c = joined(hub, { ...o, random: () => 0.01 })
  a.text.insert(0, 'hello world')
  await until(() => same(a, b, c)() && [a, b, c].every(p => p.awareness.getStates().size === 3))
  await hub.quiet()
  hub.drop = s => s.socket === a.socket && s.kind === DOC // A's delete never arrives, so nobody confirms it
  a.text.delete(0, 6)
  await hub.quiet()
  const since = hub.log.length
  const claims = () => hub.log.slice(since).filter(s => s.socket === a.socket && isClaim(s)).length
  const stranger = hub.socket()
  const ask = async () => { for (const m of await forged(message(ASK, new Uint8Array(16), Y.encodeStateVector(a.doc)))) stranger.send(m) }
  for (let i = 0; i < 3; i++) { await ask(); await sleep(200) } // B or C claims each first; A's turn comes 49 ms after the request
  expect(claims()).toBe(1)
  await sleep(1500)
  await ask()
  await until(() => claims() >= 2) // the window is over
}, 15_000)

test('a delete made while a claimed request waits does not use up the extra answer that repairs its loss', async () => {
  const hub = createHub()
  const o = { resyncMs: 1500, auditMs: 600_000 }
  const a = joined(hub, { ...o, random: () => 0.99 }), b = joined(hub, { ...o, random: () => 0.01 }), c = joined(hub, { ...o, random: () => 0.01 })
  a.text.insert(0, 'hello world')
  await until(() => same(a, b, c)() && [a, b, c].every(p => p.awareness.getStates().size === 3))
  await hub.quiet()
  // A request from someone who holds what A holds: the digest is taken from A's own last ASK.
  const frames = await Promise.all(a.socket.sent.filter(m => m.type === 'relay').map(m => open(key, m.data!)))
  const digest = frames.findLast(f => f![12] === 3 && f![13] === ASK)!.subarray(22, 30)
  let lost = 0
  hub.drop = s => s.socket === a.socket && s.kind === DOC && lost++ === 0
  const stranger = hub.socket()
  for (const m of await forged(message(ASK, new Uint8Array(8), digest, Y.encodeStateVector(a.doc)))) stranger.send(m)
  await sleep(15) // B or C has claimed it; A's turn comes 49 ms after the request
  a.text.delete(0, 6)
  await until(() => lost === 1)
  await hub.quiet()
  expect(b.text.toString()).toBe('hello world')
  a.awareness.meta.get(a.doc.clientID)!.lastUpdated -= 9000
  a.socket.deliver({ type: 'pong' }) // B and C see the gap and ask, inside resyncMs of the stranger's request
  await until(() => b.text.toString() === 'world' && same(a, b, c)(), 1500)
})

test('32 relays with a long editing history that connect while one of them types stay inside a quarter of the room\'s relay budget', async () => {
  const hub = createHub()
  hub.latency = 126
  const all = Array.from({ length: 32 }, () => peer(hub, { jitterMs: RELAY_JITTER_MS, resyncMs: RELAY_RESYNC_MS }))
  for (const p of all) for (const q of all) if (p !== q) applyAwarenessUpdate(q.awareness, encodeAwarenessUpdate(p.awareness, [p.doc.clientID]), 'seed')
  const history = deleted(10_000) // a delete set of about 32 kB: three frames whenever it rides on an answer
  for (const p of all) Y.applyUpdate(p.doc, history, 'seed')
  for (const p of all) p.start()
  let typing = true
  const typist = all[0]!
  void (async () => { for (let i = 0; typing; i++, await sleep(200)) i % 4 === 3 ? typist.text.delete(0, 1) : typist.text.insert(0, 'x') })()
  cleanup.push(() => { typing = false })
  await sleep(20_000)
  await hub.chain
  expect(hub.charged).toBeGreaterThan(0)
  expect(hub.charged).toBeLessThan(SIGNAL.topicBurstBytes / 4)
  typing = false
  await until(same(...all), 20_000)
}, 90_000)

test('64 relays, one of them typing and backspacing, stay under the room\'s refill through several audits', async () => {
  const hub = createHub()
  hub.latency = 126
  const all = Array.from({ length: 64 }, () => peer(hub, { jitterMs: RELAY_JITTER_MS, resyncMs: RELAY_RESYNC_MS, auditMs: LOAD_AUDIT_MS }))
  for (const p of all) for (const q of all) if (p !== q) applyAwarenessUpdate(q.awareness, encodeAwarenessUpdate(p.awareness, [p.doc.clientID]), 'seed')
  const history = deleted(1000) // a delete set of about 3 kB, which must not ride on every answer
  for (const p of all) Y.applyUpdate(p.doc, history, 'seed')
  for (const p of all) p.start()
  await sleep(LOAD_AUDIT_MS / 2) // the first audits start now
  await hub.chain
  // Typing starts after the connect burst: this harness runs 64 browsers on one thread and falls behind with both at
  // once. The test with 32 relays above covers typing during the burst.
  let typing = true
  const typist = all[0]!
  void (async () => { for (let i = 0; typing; i++, await sleep(200)) i % 4 === 3 ? typist.text.delete(0, 1) : typist.text.insert(0, 'x') })()
  cleanup.push(() => { typing = false })
  const since = hub.log.length, charged = hub.charged, started = Date.now()
  await sleep(LOAD_AUDIT_MS / 2)
  await hub.chain
  const seconds = (Date.now() - started) / 1000, log = hub.log.slice(since)
  expect(log.filter(isRequest).length).toBeGreaterThanOrEqual(16)
  expect((hub.charged - charged) / seconds).toBeLessThan(SIGNAL.topicBytesPerSecond)
  typing = false
  await until(same(...all), 20_000)
}, 90_000)

test('a relay dropped in the middle of a multi-frame message and reconnected converges', async () => {
  const hub = createHub()
  const a = joined(hub, { budget: SLOW }), b = joined(hub)
  await until(() => knows(a, b)() && knows(b, a)())
  await hub.quiet()
  const since = hub.log.length
  a.text.insert(0, 'x'.repeat(40_000))
  await until(() => hub.log.slice(since).some(s => s.socket === a.socket && s.kind === DOC && s.first && !s.last))
  a.socket.close()
  await sleep(50)
  expect(b.text.length).toBe(0)
  a.socket.open()
  await until(() => b.text.length === 40_000 && same(a, b)(), 10_000)
})

test('a socket message renews a presence state older than RELAY_RENEW_MS, and only then', async () => {
  const hub = createHub()
  const a = joined(hub), b = joined(hub)
  await until(() => knows(a, b)() && knows(b, a)())
  await hub.quiet()
  let since = hub.log.length
  a.socket.deliver({ type: 'pong' }) // a fresh state: nothing to renew
  await sleep(100)
  await hub.chain
  expect(hub.count(a.socket, AWARENESS, since)).toBe(0)

  const clock = b.clock(a)
  a.awareness.meta.get(a.doc.clientID)!.lastUpdated -= 9000 // over RELAY_RENEW_MS, under the 15 s of y-protocols' own interval
  a.socket.deliver({ type: 'pong' })
  await until(() => hub.count(a.socket, AWARENESS, since) === 1, 500)
  await until(() => b.clock(a) > clock, 500)

  a.awareness.setLocalState(null)
  await hub.quiet()
  since = hub.log.length
  a.awareness.meta.get(a.doc.clientID)!.lastUpdated -= 9000
  a.socket.deliver({ type: 'pong' })
  await sleep(100)
  expect(a.awareness.getLocalState()).toBeNull()
  expect(hub.count(a.socket, AWARENESS, since)).toBe(0)
})

test('destroy: a pending frame is never sent, and a pong afterwards changes nothing', async () => {
  const hub = createHub()
  const a = joined(hub), b = joined(hub)
  await until(() => knows(a, b)() && knows(b, a)())
  await hub.quiet()
  const sent = a.socket.sent.length
  a.text.insert(0, 'never sent')
  a.relay!.destroy()
  a.awareness.meta.get(a.doc.clientID)!.lastUpdated -= 9000
  const clock = a.awareness.meta.get(a.doc.clientID)!.clock
  a.socket.deliver({ type: 'pong' })
  for (const m of await forged(message(DOC, Y.encodeStateAsUpdate(b.doc)))) a.socket.deliver(m)
  b.text.insert(0, 'not received')
  await sleep(150)
  expect(a.socket.sent.length).toBe(sent)
  expect(a.awareness.meta.get(a.doc.clientID)!.clock).toBe(clock)
  expect(a.text.toString()).toBe('never sent')
})

test('destroy: a state cleared in the same tick is not sent', async () => {
  const hub = createHub()
  const a = joined(hub), b = joined(hub)
  await until(() => knows(a, b)() && knows(b, a)())
  await hub.quiet()
  const sent = a.socket.sent.length
  a.awareness.setLocalState(null)
  a.relay!.destroy()
  await sleep(150)
  expect(a.socket.sent.length).toBe(sent)
})

test('destroy while a frame is being sealed: that frame is not sent', async () => {
  const hub = createHub()
  const a = joined(hub, { flushMs: 0 })
  await hub.quiet()
  const sent = a.socket.sent.length
  a.text.insert(0, 'x'.repeat(200_000))
  // Destroy at several moments around the pump's start, one of which falls inside a seal.
  for (let i = 0; i < 3 && a.socket.sent.length === sent; i++) await new Promise<void>(resolve => setTimeout(resolve, 0))
  const before = a.socket.sent.length
  a.relay!.destroy()
  await sleep(150)
  expect(a.socket.sent.length).toBe(before)
})

test('nothing is sent on a socket that is closing although it still reports connected', async () => {
  const hub = createHub()
  const a = joined(hub)
  await hub.quiet()
  const sent = a.socket.sent.length
  a.socket.ws.readyState = 2
  a.text.insert(0, 'typed')
  a.awareness.setLocalStateField('cursor', null)
  await sleep(150)
  expect(a.socket.sent.length).toBe(sent)
})

test('garbage and hostile frames do not throw, the guards still clean what arrives, and the relay keeps working', async () => {
  const hub = createHub()
  const a = peer(hub, { name: 'Ada' }), b = joined(hub)
  guardText(a.text, () => {})
  guardAwareness(a.awareness, () => ({ name: 'Ada', color: '#376ce9' }))
  a.start()
  await until(() => knows(a, b)() && knows(b, a)())
  await hub.quiet()

  const hostile = new Y.Doc()
  hostile.getText('code').insertEmbed(0, { image: 'x' })
  hostile.getText('code').insert(1, 'text from the hostile peer')
  const who = new Awareness(hostile)
  cleanup.push(() => who.destroy())
  who.setLocalState({ user: { name: 'Eve', color: 'red;background:url(//evil)' }, cursor: 'nonsense' })
  const frames = [
    { type: 'relay', topic: TOPIC, data: '!!! not base64 !!!' },
    { type: 'relay', topic: TOPIC, data: 12 },
    { type: 'relay', topic: 'f'.repeat(32), data: await seal(key, toFrames(message(DOC, Y.encodeStateAsUpdate(hostile)), bytes(8), 0)[0]!) },
    { type: 'relay', topic: TOPIC, data: await seal(key, new Uint8Array(5)) }, // shorter than a frame header
    { type: 'relay', topic: TOPIC, data: await seal(await importKey(2), toFrames(bytes(5), bytes(8), 0)[0]!) },
    null,
    'text',
    ...(await forged(new Uint8Array(0))),
    ...(await forged(message(9, bytes(20)))), // unknown kind
    ...(await forged(message(ASK, new Uint8Array(16), Uint8Array.of(255, 255)))), // a state vector that does not decode
    ...(await forged(message(ASK, bytes(3)))), // too short for an address
    ...(await forged(message(DOC, bytes(40)))), // not a Yjs update
    ...(await forged(message(AWARENESS, bytes(40)))),
    ...(await forged(message(AWARENESS, encodeAwarenessUpdate(who, [hostile.clientID])))),
    ...(await forged(message(DOC, Y.encodeStateAsUpdate(hostile)))),
  ]
  for (const m of frames) a.socket.deliver(m)
  await until(() => a.text.toString() === 'text from the hostile peer')
  expect(a.text.toDelta()).toEqual([{ insert: 'text from the hostile peer' }])
  const eve = a.awareness.getStates().get(hostile.clientID)!
  expect(eve.user.name).toBe('Eve')
  expect(eve.user.color).toMatch(COLOR_RE)
  expect(eve.cursor).toBeUndefined()

  a.doc.getMap('other').set('alive', true) // not in the text: B never got the hostile peer's text to put an insert next to
  await until(() => b.doc.getMap('other').get('alive') === true)
})
