// Data-channel framing. y-webrtc drops any message over about 256 kB without an error, so every
// message goes out as frames of 1 flag byte (1 = more follows, 0 = last) plus at most FRAME_MAX payload bytes.
// Nothing here may touch a WebRTC global at import time: the module is imported under `bun test`.
// A peer that never sends a last frame must not grow memory without bound: past MESSAGE_MAX the message is dropped.
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

// The subclass is declared on call: a top-level `extends RTCPeerConnection` cannot be imported under Bun.
export function chunkingWrtc(): { RTCPeerConnection: typeof RTCPeerConnection; RTCSessionDescription: typeof RTCSessionDescription; RTCIceCandidate: typeof RTCIceCandidate } {
  class ChunkingPC extends RTCPeerConnection {
    override createDataChannel(label: string, init?: RTCDataChannelInit) { return wrapChannel(super.createDataChannel(label, init)) }
    override get ondatachannel() { return super.ondatachannel }
    override set ondatachannel(fn: RTCPeerConnection['ondatachannel']) {
      super.ondatachannel = fn && (e => (fn as (e: { channel: RTCDataChannel }) => void).call(this, { channel: wrapChannel(e.channel) }))
    }
  }
  return { RTCPeerConnection: ChunkingPC, RTCSessionDescription, RTCIceCandidate }
}
