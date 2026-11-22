// The background download and the compiler start that waits for it, against a fake Cache Storage, network and
// Worker. The real ones are covered by the browser suite.
import { afterEach, beforeEach, expect, test } from 'bun:test'
import { prefetchToolchain } from './cache-fetch.ts'
import { createCpp } from './cpp.ts'

const BASE = 'https://x.test/toolchain/new/'
const CACHE = 'c-oop-toolchain-new'
const MANIFEST = { files: { 'a.wasm': 6, 'b.bin': 4 }, total: 10 }

const g = globalThis as unknown as { caches?: unknown; fetch: unknown; Worker: unknown }
const real = { caches: g.caches, fetch: g.fetch, Worker: g.Worker }

let stores: Map<string, Map<string, number>> // cache name -> url -> stored bytes
let requests: string[]
let network: Record<string, (signal?: AbortSignal) => Response | Promise<Response>>
let workers: FakeWorker[]

class FakeWorker {
  posted: unknown[] = []
  onmessage: ((e: { data: unknown }) => void) | null = null
  constructor() { workers.push(this) }
  postMessage(message: unknown) { this.posted.push(message) }
  terminate() {}
}

const body = (...chunks: number[]) => new Response(new ReadableStream<Uint8Array>({
  start(c) {
    for (const n of chunks) c.enqueue(new Uint8Array(n))
    c.close()
  },
}), { headers: { 'Content-Type': 'application/wasm' } })
const broken = () => new Response(new ReadableStream<Uint8Array>({
  start(c) {
    c.enqueue(new Uint8Array(2))
    c.error(new Error('connection lost'))
  },
}))
const stored = () => [...(stores.get(CACHE)?.keys() ?? [])].map(u => u.slice(BASE.length))
const cpp = () => createCpp({ toolchainBase: BASE, compilerUrl: 'compiler.js', runnerUrl: 'runner.js' })
const tick = () => new Promise(resolve => setTimeout(resolve, 0))

beforeEach(() => {
  stores = new Map()
  requests = []
  workers = []
  network = { 'manifest.json': () => Response.json(MANIFEST), 'a.wasm': () => body(3, 3), 'b.bin': () => body(4) }
  // Like the real one, put() reads the whole body first and stores nothing when the body breaks.
  g.caches = {
    async open(name: string) {
      const store = stores.get(name) ?? stores.set(name, new Map()).get(name)!
      return {
        match: async (url: string) => (store.has(url) ? new Response(new Uint8Array(store.get(url)!)) : undefined),
        put: async (url: string, res: Response) => { store.set(url, (await res.arrayBuffer()).byteLength) },
      }
    },
    keys: async () => [...stores.keys()],
    delete: async (name: string) => stores.delete(name),
  }
  g.fetch = async (url: string, init?: RequestInit) => {
    init?.signal?.throwIfAborted() // like the real fetch
    requests.push(url.slice(BASE.length))
    return network[url.slice(BASE.length)]!(init?.signal ?? undefined)
  }
  g.Worker = FakeWorker
})
afterEach(() => Object.assign(g, real))

test('the background download stores every manifest file and reports progress up to 1', async () => {
  stores.set('c-oop-toolchain-old', new Map())
  stores.set('unrelated', new Map())
  const seen: number[] = []
  expect(await prefetchToolchain(BASE, f => seen.push(f))).toBe(true)
  expect(stored()).toEqual(['a.wasm', 'b.bin'])
  expect(stores.get(CACHE)!.get(BASE + 'a.wasm')).toBe(6)
  expect(seen).toEqual([0.3, 0.6, 1])
  expect([...stores.keys()].sort()).toEqual([CACHE, 'unrelated']) // the old version's cache is gone
})

test('a file that is already stored is not requested again', async () => {
  await prefetchToolchain(BASE, () => {})
  requests = []
  const seen: number[] = []
  expect(await prefetchToolchain(BASE, f => seen.push(f))).toBe(true)
  expect(requests).toEqual(['manifest.json'])
  expect(seen.at(-1)).toBe(1)
})

test('a download that breaks resolves false and stores nothing for that file', async () => {
  network['b.bin'] = broken
  expect(await prefetchToolchain(BASE, () => {})).toBe(false)
  expect(stored()).toEqual(['a.wasm'])
})

test('an HTTP error resolves false and stores nothing for that file', async () => {
  network['a.wasm'] = () => new Response('gone', { status: 404 })
  expect(await prefetchToolchain(BASE, () => {})).toBe(false)
  expect(stored()).toEqual([])
  expect(requests).toEqual(['manifest.json', 'a.wasm']) // it stops there; the first Run fetches the rest
})

test('without Cache Storage nothing is requested', async () => {
  g.caches = undefined
  expect(await prefetchToolchain(BASE, () => {})).toBe(false)
  expect(requests).toEqual([])
})

test('a load during the background download starts the compiler after it and shows its progress', async () => {
  let release!: (r: Response) => void
  network['a.wasm'] = () => new Promise<Response>(resolve => { release = resolve })
  const c = cpp()
  const fetched = c.prefetch()
  while (!release) await tick()
  const seen: number[] = []
  const load = c.load(f => seen.push(f))
  await tick()
  expect(workers[0]!.posted).toEqual([]) // an `init` now would make the worker fetch a.wasm a second time
  release(body(3, 3))
  expect(await fetched).toBe(true)
  await tick()
  expect(workers[0]!.posted).toEqual([{ type: 'init', base: BASE }])
  expect(seen).toEqual([0.3, 0.6, 1])
  workers[0]!.onmessage!({ data: { type: 'progress', fraction: 0.5 } }) // the worker reading the files back from the cache
  expect(seen).toEqual([0.3, 0.6, 1])
  workers[0]!.onmessage!({ data: { type: 'ready' } })
  await load
  expect(requests).toEqual(['manifest.json', 'a.wasm', 'b.bin'])
  expect(workers.length).toBe(1)
})

test('cancel() during that wait ends the background download, so a stalled one cannot block the next load()', async () => {
  // a connection that went silent: it answers only when the request is aborted
  network['a.wasm'] = signal => new Promise<Response>((_, reject) => signal?.addEventListener('abort', () => reject(signal.reason)))
  const c = cpp()
  const fetched = c.prefetch()
  while (!requests.includes('a.wasm')) await tick()
  const load = c.load(() => {})
  c.cancel()
  expect(load).rejects.toThrow('cancelled')
  expect(await fetched).toBe(false)
  expect(stored()).toEqual([])
  void c.load(() => {})
  await tick()
  expect(workers[1]!.posted).toEqual([{ type: 'init', base: BASE }])
}, 2000)

test('the background download alone starts no worker', async () => {
  expect(await cpp().prefetch()).toBe(true)
  expect(workers).toEqual([])
})

test('a failed background download still lets load() start the compiler', async () => {
  network['a.wasm'] = () => Promise.reject(new TypeError('Failed to fetch'))
  const c = cpp()
  expect(await c.prefetch()).toBe(false)
  const seen: number[] = []
  const load = c.load(f => seen.push(f))
  await tick()
  expect(workers[0]!.posted).toEqual([{ type: 'init', base: BASE }])
  workers[0]!.onmessage!({ data: { type: 'progress', fraction: 0.5 } })
  workers[0]!.onmessage!({ data: { type: 'ready' } })
  await load
  expect(seen).toEqual([0.5, 1])
})

test('once a compiler was started the background download does nothing', async () => {
  const c = cpp()
  void c.load(() => {})
  expect(await c.prefetch()).toBe(false)
  expect(requests).toEqual([])
  expect(workers[0]!.posted).toEqual([{ type: 'init', base: BASE }])
})

test('a load that was cancelled before the background download started does not switch it off', async () => {
  const c = cpp()
  const load = c.load(() => {})
  c.cancel() // Run, then Stop, before the page was idle enough to start downloading
  expect(load).rejects.toThrow('cancelled')
  expect(await c.prefetch()).toBe(true)
  expect(stored()).toEqual(['a.wasm', 'b.bin'])
})

test('a load after a finished background download reports its own progress from zero', async () => {
  const c = cpp()
  expect(await c.prefetch()).toBe(true)
  const seen: number[] = []
  const load = c.load(f => seen.push(f))
  await tick()
  workers[0]!.onmessage!({ data: { type: 'progress', fraction: 0.5 } })
  workers[0]!.onmessage!({ data: { type: 'ready' } })
  await load
  expect(seen).toEqual([0.5, 1])
})
