// Data-channel framing. y-webrtc drops any message over about 256 kB without an error, so every
// message goes out as frames of 1 flag byte (1 = more follows, 0 = last) plus at most FRAME_MAX payload bytes.
// Nothing here may touch a WebRTC global at import time: the module is imported under `bun test`.
// A peer that never sends a last frame must not grow memory without bound: past MESSAGE_MAX the message is dropped.
// The RTCPeerConnection subclass also fixes two things in how y-webrtc 10.3.0 and simple-peer 9.11.1 use a connection:
// a connection that fails before it ever connected hides that state (shownState), and a data channel that arrives
// on a connection that offered one itself is used (adoptChannel).
import { FRAME_MAX, MESSAGE_MAX } from '../shared/limits'

type Channel = { send(data: Uint8Array): void; onmessage: ((e: { data: ArrayBuffer }) => void) | null }

// shortcut: all frames of a message are sent at once, so a message near the browser's send buffer
// (16 MB in Chromium) closes the channel; pace on bufferedAmount when documents get that large.
export function wrapChannel<T extends object>(ch: T): T {
  const raw = ch as unknown as Channel
  let parts: Uint8Array[] = []
  let size = 0
  return new Proxy(ch, {
    get(target, prop) {
      if (prop === 'send') return (data: ArrayBuffer | ArrayBufferView) => {
        const bytes = ArrayBuffer.isView(data) ? new Uint8Array(data.buffer, data.byteOffset, data.byteLength) : new Uint8Array(data)
        for (let at = 0; at === 0 || at < bytes.length; at += FRAME_MAX) {
          const frame = new Uint8Array(1 + Math.min(FRAME_MAX, bytes.length - at))
          frame[0] = at + FRAME_MAX < bytes.length ? 1 : 0
          frame.set(bytes.subarray(at, at + FRAME_MAX), 1)
          raw.send(frame)
        }
      }
      // Native getters and methods need the real channel as receiver and as `this`.
      const value = Reflect.get(target, prop, target)
      return typeof value === 'function' ? value.bind(target) : value
    },
    set(target, prop, value) {
      if (prop !== 'onmessage' || !value) return Reflect.set(target, prop, value, target)
      raw.onmessage = e => {
        const frame = new Uint8Array(e.data)
        size += Math.max(0, frame.length - 1)
        if (size <= MESSAGE_MAX) parts.push(frame.subarray(1))
        if (frame[0]) return
        const whole = size <= MESSAGE_MAX ? new Uint8Array(size) : null
        let at = 0
        for (const part of parts) { whole?.set(part, at); at += part.length }
        parts = []
        size = 0
        if (whole) value({ data: whole.buffer })
      }
      return true
    },
  })
}

// simple-peer destroys a connection whose state is `failed`, and y-webrtc then announces and starts a new one at once.
// For a pair that cannot connect that repeats every 15 s without end, each time with a whole offer and its candidates
// broadcast to the room. So a connection that never connected shows `instead`, which simple-peer ignores, and stays
// until the retry in collab.ts destroys it. One that was connected before still shows `failed` and is replaced at once.
export function shownState<S extends string>(real: S, everConnected: boolean, instead: S): S {
  return real === 'failed' && !everConnected ? instead : real
}

// When two pages announce at the same moment, y-webrtc makes both of them initiators and feeds the winning offer into
// the loser's connection. Each side then sends on the channel it created, and simple-peer listens for an arriving
// channel only on non-initiators: both report connected and nothing flows. So the arriving channel delivers to the
// handler of the own raw channel (not the proxy), looked up per message. That handler is the reassembler wrapChannel
// installed; it can be shared because the own channel receives nothing here: the other side sends only on its own.
export function adoptChannel(own: Pick<Channel, 'onmessage'>, incoming: Pick<Channel, 'onmessage'> & { binaryType: string }): void {
  incoming.binaryType = 'arraybuffer' // simple-peer sets it only on the channel it created
  incoming.onmessage = e => own.onmessage?.(e)
}

// The subclass is declared on call: a top-level `extends RTCPeerConnection` cannot be imported under Bun.
export function chunkingWrtc(): { RTCPeerConnection: typeof RTCPeerConnection; RTCSessionDescription: typeof RTCSessionDescription; RTCIceCandidate: typeof RTCIceCandidate } {
  class ChunkingPC extends RTCPeerConnection {
    #everConnected = false
    #ownRaw: RTCDataChannel | null = null
    constructor(config?: RTCConfiguration) {
      super(config)
      this.addEventListener('iceconnectionstatechange', () => {
        if (super.iceConnectionState === 'connected' || super.iceConnectionState === 'completed') this.#everConnected = true
      })
      // No handler means simple-peer made this connection as initiator (see adoptChannel).
      this.addEventListener('datachannel', e => {
        if (!super.ondatachannel && this.#ownRaw) adoptChannel(this.#ownRaw as unknown as Channel, e.channel as unknown as Channel & { binaryType: string })
      })
    }
    override get iceConnectionState() { return shownState(super.iceConnectionState, this.#everConnected, 'disconnected') }
    override get connectionState() { return shownState(super.connectionState, this.#everConnected, 'connecting') }
    override createDataChannel(label: string, init?: RTCDataChannelInit) { return wrapChannel(this.#ownRaw = super.createDataChannel(label, init)) }
    override get ondatachannel() { return super.ondatachannel }
    override set ondatachannel(fn: RTCPeerConnection['ondatachannel']) {
      super.ondatachannel = fn && (e => (fn as (e: { channel: RTCDataChannel }) => void).call(this, { channel: wrapChannel(e.channel) }))
    }
  }
  return { RTCPeerConnection: ChunkingPC, RTCSessionDescription, RTCIceCandidate }
}
