// The toolchain files in Cache Storage: Chromium's HTTP cache does not keep the big ones across reloads,
// Cache Storage does. The compiler worker reads and fills the cache through a replaced globalThis.fetch;
// the page fills it ahead of the first Run with prefetchToolchain.
const PREFIX = 'c-oop-toolchain-'

// `base` is an absolute URL ending in "/". Undefined when storage is missing (Bun, some private modes) or
// blocked, which means plain network fetches. Also drops the caches of other toolchain versions.
function openCache(base: string): Promise<Cache | undefined> {
  const storage: CacheStorage | undefined = globalThis.caches
  if (!storage) return Promise.resolve(undefined)
  const name = PREFIX + base.split('/').at(-2)
  storage.keys()
    .then(keys => Promise.all(keys.filter(k => k.startsWith(PREFIX) && k !== name).map(k => storage.delete(k))))
    .catch(() => {})
  return storage.open(name).catch(() => undefined)
}

const counted = (body: ReadableStream<Uint8Array>, onBytes: (n: number) => void) =>
  body.pipeThrough(new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, controller) {
      onBytes(chunk.byteLength)
      controller.enqueue(chunk)
    },
  }))

// Must run before the @yowasp/clang bundle is imported: the bundle captures fetch when it loads.
// `onBytes` gets the size of every body chunk served from under `base`.
export function installCacheFetch(base: string, onBytes: (n: number) => void): void {
  const net = globalThis.fetch
  const cache = openCache(base)

  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = input instanceof Request ? input.url : String(input)
    if (!url.startsWith(base)) return net(input, init)
    const c = await cache
    let res = await c?.match(url).catch(() => undefined)
    if (!res) {
      res = await net(input, init)
      if (res.ok && c) c.put(url, res.clone()).catch(() => {}) // not awaited: the caller streams meanwhile
    }
    if (!res.body) return res
    // Status and type only: the body is already decoded, so the encoding and length headers would be wrong.
    const type = res.headers.get('Content-Type')
    return new Response(counted(res.body, onBytes), { status: res.status, statusText: res.statusText, headers: type ? { 'Content-Type': type } : {} })
  }) as typeof fetch
}

// Downloads the manifest's files into the cache, one at a time, without keeping any of them in memory.
// Resolves true when the cache holds them all, false when it gave up or `signal` aborted it; it never rejects.
// `onProgress` gets the stored fraction of the manifest's bytes.
export async function prefetchToolchain(base: string, onProgress: (fraction: number) => void, signal?: AbortSignal): Promise<boolean> {
  try {
    const cache = await openCache(base)
    if (!cache) return false
    const manifest = (await (await fetch(base + 'manifest.json', { signal })).json()) as { files: Record<string, number>; total: number }
    let bytes = 0
    const add = (n: number) => onProgress(Math.min(1, (bytes += n) / manifest.total))
    for (const [name, size] of Object.entries(manifest.files)) {
      const url = base + name
      if (await cache.match(url)) {
        add(size)
        continue
      }
      const res = await fetch(url, { priority: 'low', signal }) // behind whatever the room itself loads
      if (!res.ok || !res.body) return false
      // put() resolves once the whole body is stored; a download that breaks rejects it and stores nothing.
      await cache.put(url, new Response(counted(res.body, add), res))
    }
    return true
  } catch {
    return false
  }
}
