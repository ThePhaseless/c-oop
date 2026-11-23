// Y.Doc, awareness, local IndexedDB copy and the framed WebRTC provider behind the `Collab` type.
//
// y-webrtc 10.3.0 internals this file reads (pinned exact; read in its source):
//   provider.room                      null until y-webrtc has derived its key from the password
//   room.webrtcConns                   Map<peerId, WebrtcConn>; an entry is removed only when its peer closes
//   conn.remotePeerId, conn.connected  identity and state of one connection (`connect` emits no event)
//   conn.destroy()                     closes the peer; y-webrtc then drops the entry and announces again
//   provider.signalingConns[0]         the signaling socket (lib0 WebsocketClient), also the relay's socket: `connected`,
//                                      `ws`, `send`, `on`, `off`; `message` is emitted for every message, `pong` included
// y-webrtc ignores message types it does not know, so the relay's `relay` messages pass it by.
// provider.disconnect() clears the local awareness state, so it is never called while the room is in use,
// only when the document is destroyed.
import * as Y from 'yjs'
import { Awareness } from 'y-protocols/awareness'
import { IndexeddbPersistence } from 'y-indexeddb'
import { WebrtcProvider } from 'y-webrtc'
import type { Collab, NetStatus, Peer, RoomKeys } from '../shared/contracts'
import { CONN_FORGET_MS, CONN_RETRY_DOUBLINGS, CONN_RETRY_MS, RELAY_START_MS, STUCK_MS } from '../shared/limits'
import { chunkingWrtc } from './chunking'
import { createConnWatch, createRetry, guardAwareness, loadIdentity, sanitizeName, sanitizeUser, saveIdentity } from './presence'
import { createRelay } from './relay'
import { guardText } from './text-guard'

const TICK_MS = 2000

// `onCodeCut` is called each time this page cut the code back to CODE_MAX.
export function createCollab(o: { keys: RoomKeys; iceServers: RTCIceServer[]; signalUrl: string; isNew: boolean; template: string; onCodeCut(): void }): Collab {
  const doc = new Y.Doc()
  const text = doc.getText('code')
  guardText(text, o.onCodeCut) // the first observer of the text: before the stored copy loads, a peer connects or the editor binds
  const awareness = new Awareness(doc)

  // Registered before the provider exists and before any editor listens, so nobody reads a raw remote state.
  let identity = loadIdentity()
  guardAwareness(awareness, () => identity)
  awareness.setLocalState({ user: identity })
  saveIdentity(identity) // keeps a random identity across reloads

  // The local copy is optional: without IndexedDB (private mode, blocked storage) the room still works.
  let stored: IndexeddbPersistence | undefined
  if (typeof indexedDB !== 'undefined') {
    try { stored = new IndexeddbPersistence('c-oop-' + o.keys.topic, doc) } catch { /* optional */ }
  }

  const provider = new WebrtcProvider(o.keys.topic, doc, {
    signaling: [o.signalUrl],
    password: o.keys.password,
    awareness,
    peerOpts: { config: { iceServers: o.iceServers }, wrtc: chunkingWrtc() },
  })

  // The relay starts once the stored copy has loaded, so its first request already names what this browser holds;
  // after RELAY_START_MS without it. A copy that loads later restarts the relay, which asks the room again.
  let relay: { destroy(): void } | undefined
  let destroyed = false
  const startRelay = () => {
    if (destroyed) return
    relay?.destroy()
    relay = createRelay({ doc, awareness, topic: o.keys.topic, key: o.keys.relayKey, socket: provider.signalingConns[0] })
  }
  const relayTimer = setTimeout(startRelay, RELAY_START_MS)
  ;(stored ? stored.whenSynced : Promise.resolve()).then(() => { clearTimeout(relayTimer); startRelay() }, () => {})

  // The relay goes first: provider.disconnect() clears the own awareness state, and nothing may be sent for it.
  // provider.destroy() leaves the signaling socket open, and y-webrtc would announce this page again on it.
  doc.on('destroy', () => {
    destroyed = true
    clearTimeout(relayTimer)
    relay?.destroy()
    provider.disconnect()
  })

  if (o.isNew) text.insert(0, o.template)

  const listeners = new Set<() => void>()
  const notify = () => { for (const cb of [...listeners]) cb() }

  const conns = () => [...(provider.room?.webrtcConns.values() ?? [])]
  const watch = createConnWatch(STUCK_MS, CONN_FORGET_MS)
  const net = (): NetStatus => ({
    signaling: provider.signalingConns[0]?.connected ?? false,
    ...watch(Date.now(), conns().map(c => ({ id: c.remotePeerId, connected: c.connected }))),
  })

  // A connection that never connected stays as it is, also after ICE failed (chunking.ts hides that state from
  // simple-peer). This retry is the only thing that replaces it: the connection is destroyed, y-webrtc announces
  // again, and a peer that has left does not come back. The wait doubles per failed attempt for the same peer id;
  // the longest one (384 s) is how long such an entry outlives a person who has left.
  const retry = createRetry(CONN_RETRY_MS, CONN_RETRY_DOUBLINGS)
  let last = ''
  const tick = () => {
    const all = conns()
    const stale = new Set(retry(Date.now(), all.map(c => ({ id: c.remotePeerId, connected: c.connected }))))
    for (const c of all) if (stale.has(c.remotePeerId)) c.destroy()
    // Neither a data-channel connect nor a signaling change emits a provider event, so compare and notify here.
    const status = JSON.stringify(net())
    if (status !== last) { last = status; notify() }
  }
  setInterval(tick, TICK_MS)
  provider.on('peers', tick)
  awareness.on('change', notify)

  return {
    doc,
    text,
    awareness,
    peers() {
      const peers: Peer[] = []
      // Sanitised again on read: states set locally (origin 'local') are stored as written.
      for (const [clientId, state] of awareness.getStates()) peers.push({ clientId, user: sanitizeUser((state as { user?: unknown } | null)?.user), self: clientId === doc.clientID })
      return peers.sort((a, b) => Number(b.self) - Number(a.self) || a.clientId - b.clientId)
    },
    net,
    setName(name) {
      identity = { name: sanitizeName(name), color: identity.color }
      awareness.setLocalStateField('user', identity)
      saveIdentity(identity)
    },
    onChange(cb) {
      listeners.add(cb)
      return () => { listeners.delete(cb) }
    },
  }
}
