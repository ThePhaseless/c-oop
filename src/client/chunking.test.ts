// Importing chunking.ts here, under Bun with no WebRTC global, is itself a check: the module must not touch a WebRTC global at import time.
import { expect, test } from 'bun:test'
import { FRAME_MAX } from '../shared/limits'
import { chunkingWrtc, wrapChannel } from './chunking'

class FakeChannel {
  peer: FakeChannel | null = null
  onmessage: ((e: { data: ArrayBuffer }) => void) | null = null
  binaryType = 'blob'
  label = 'fake'
  frames: number[] = []
  send(data: Uint8Array) {
    this.frames.push(data.byteLength)
    // A real channel delivers a copy as an ArrayBuffer.
    this.peer!.onmessage?.({ data: data.slice().buffer as ArrayBuffer })
  }
  whoAmI() { return this }
}

function pair() {
  const rawA = new FakeChannel(), rawB = new FakeChannel()
  rawA.peer = rawB; rawB.peer = rawA
  const received: Uint8Array[] = []
  const a = wrapChannel(rawA), b = wrapChannel(rawB)
  b.onmessage = e => { received.push(new Uint8Array(e.data)) }
  return { rawA, rawB, a, b, received }
}

const bytes = (n: number, seed: number) => Uint8Array.from({ length: n }, (_, i) => (i * 31 + seed) & 255)

test('messages of every size arrive intact, in order, in frames of at most FRAME_MAX + 1 bytes', () => {
  const { rawA, a, received } = pair()
  const sizes = [0, 1, FRAME_MAX, FRAME_MAX + 1, 3_000_000]
  const sent = sizes.map((n, i) => bytes(n, i))
  for (const m of sent) a.send(m)
  expect(received.length).toBe(sent.length)
  sent.forEach((m, i) => expect(Buffer.from(received[i]!).equals(Buffer.from(m))).toBe(true))
  expect(Math.max(...rawA.frames)).toBe(FRAME_MAX + 1)
  // 1 frame each for 0, 1 and FRAME_MAX bytes, 2 for FRAME_MAX + 1, 50 for 3 MB
  expect(rawA.frames.length).toBe(3 + 2 + 3_000_000 / FRAME_MAX)
})

test('an ArrayBuffer is sent like a Uint8Array', () => {
  const { a, received } = pair()
  ;(a as unknown as { send(d: ArrayBuffer): void }).send(bytes(10, 7).buffer as ArrayBuffer)
  expect([...received[0]!]).toEqual([...bytes(10, 7)])
})

test('other properties and methods pass through to the real channel', () => {
  const { rawA, rawB, a, b } = pair()
  a.binaryType = 'arraybuffer'
  expect(rawA.binaryType).toBe('arraybuffer')
  expect(a.label).toBe('fake')
  expect(a.whoAmI()).toBe(rawA) // methods run with the real channel as `this`
  b.onmessage = null
  expect(rawB.onmessage).toBeNull()
})

test('a message that never ends is dropped past 64 MB and the next one still arrives', () => {
  const { rawB, a, received } = pair()
  const more = new Uint8Array(FRAME_MAX + 1)
  more[0] = 1
  for (let i = 0; i < 64 * 1024 * 1024 / FRAME_MAX + 2; i++) rawB.onmessage!({ data: more.buffer as ArrayBuffer })
  rawB.onmessage!({ data: new Uint8Array([0, 9]).buffer as ArrayBuffer })
  expect(received.length).toBe(0)
  a.send(new Uint8Array([1, 2, 3]))
  expect(received.map(m => [...m])).toEqual([[1, 2, 3]])
})

test('chunkingWrtc is a function, so nothing touches a WebRTC global at import time', () => {
  expect(typeof chunkingWrtc).toBe('function')
  expect(typeof (globalThis as { RTCPeerConnection?: unknown }).RTCPeerConnection).toBe('undefined')
})
