// Page-side API (contracts.ts `Cpp`): one long-lived compiler worker, one throwaway runner worker per run.
import type { CompileResult, Cpp, Exit, RunHandle, RunIo } from '../../shared/contracts.ts'
import { prefetchToolchain } from './cache-fetch.ts'

const STDIN_CAP = 65536 // bytes of stdin handed over per read

type Compiler = {
  worker: Worker
  ready: Promise<void>
  fail(e: Error): void // rejects the pending load
  compiles: Map<number, { resolve(r: CompileResult): void; reject(e: Error): void }>
}

// `prefetch` downloads the toolchain files into Cache Storage without starting the compiler, so a later
// load() finds them there. Resolves true when all of them are stored; false when it gave up or was not needed.
export function createCpp(o: { toolchainBase: string; compilerUrl: string | URL; runnerUrl: string | URL }): Cpp & { prefetch(): Promise<boolean> } {
  let cur: Compiler | undefined
  let onProgress: (fraction: number) => void = () => {}
  let nextId = 0
  let fetching: Promise<boolean> | undefined // the background download
  let stopFetching: AbortController | undefined // of the download in `fetching`
  let shown = 0 // the highest fraction the current load() has reported
  // Never backwards: after the background download the worker counts the same files again as it reads them from the cache.
  const report = (fraction: number) => { if (fraction > shown) onProgress((shown = fraction)) }

  function boot(): Compiler {
    const worker = new Worker(o.compilerUrl, { type: 'module' })
    let fail!: (e: Error) => void
    const ready = new Promise<void>((resolve, reject) => {
      fail = reject
      // Worker failed: forget it, so the next load() starts over. Events from a forgotten worker are ignored.
      const drop = (message: string) => {
        if (cur !== c) return
        cur = undefined
        worker.terminate()
        const e = new Error(message)
        reject(e)
        for (const p of c.compiles.values()) p.reject(e)
      }
      worker.onerror = e => drop(e.message || 'compiler worker error')
      worker.onmessageerror = () => drop('compiler worker message error')
      worker.onmessage = ({ data }) => {
        if (cur !== c) return
        if (data.type === 'progress') report(data.fraction)
        else if (data.type === 'ready') resolve()
        else if (data.type === 'failed') drop(data.message)
        else if (data.type === 'compiled') {
          c.compiles.get(data.id)?.resolve({ ok: data.ok, wasm: data.wasm, diagnostics: data.diagnostics })
          c.compiles.delete(data.id)
        }
      }
    })
    const c: Compiler = { worker, ready, fail, compiles: new Map() }
    const init = () => worker.postMessage({ type: 'init', base: o.toolchainBase })
    // The worker fetches whatever the cache lacks, so it starts only after a background download has ended:
    // no file is then downloaded twice, and one that the download gave up on is fetched by the worker.
    if (fetching) void fetching.then(init)
    else init()
    return c
  }

  return {
    prefetch() {
      // A compiler that was started first downloads the files itself.
      if (cur || fetching) return Promise.resolve(false)
      stopFetching = new AbortController()
      return (fetching = prefetchToolchain(o.toolchainBase, report, stopFetching.signal))
    },

    load(progress) {
      onProgress = progress
      shown = 0
      cur ??= boot()
      return cur.ready.then(() => progress(1))
    },

    compile(source) {
      const c = cur
      if (!c) return Promise.reject(new Error('compiler is not loaded'))
      return new Promise<CompileResult>((resolve, reject) => {
        const id = nextId++
        c.compiles.set(id, { resolve, reject })
        c.worker.postMessage({ type: 'compile', id, source }) // the worker handles its messages in order, `init` first
      })
    },

    cancel() {
      const c = cur
      if (!c) return
      cur = undefined
      c.worker.terminate()
      // A load that was waiting for the background download: one that stalled would hold up every later load too.
      // The file in flight is dropped and the next load's worker fetches what is missing.
      stopFetching?.abort()
      c.fail(new Error('cancelled'))
      for (const p of c.compiles.values()) p.resolve({ ok: false, diagnostics: '' })
    },

    run(wasm, io) {
      return run(o.runnerUrl, wasm, io)
    },
  }
}

function run(url: string | URL, wasm: Uint8Array, io: RunIo): RunHandle {
  // Blocking stdin needs shared memory, which needs cross-origin isolation; callers check canRun first.
  if (typeof SharedArrayBuffer === 'undefined')
    return { write() {}, eof() {}, kill() {}, done: Promise.resolve('crash:SharedArrayBuffer is unavailable') }
  const worker = new Worker(url, { type: 'module' })
  // Layout: see runner.worker.ts.
  const sab = new SharedArrayBuffer(16 + STDIN_CAP)
  const ctl = new Int32Array(sab, 0, 4)
  const stdin = new Uint8Array(sab, 16)
  const decoders = [new TextDecoder(), new TextDecoder()] // per stream: a UTF-8 char may be split across writes
  const queue: (Uint8Array | null)[] = [] // typed ahead; null = EOF
  let blocked = false // the program is inside a read
  let reported = false // onStdinWait(true) was sent
  let ended = false
  let finish!: (exit: Exit) => void

  const pump = () => {
    if (!blocked || !queue.length) return
    const chunk = queue.shift()!
    blocked = false
    if (chunk === null) Atomics.store(ctl, 0, 2)
    else {
      stdin.set(chunk)
      Atomics.store(ctl, 1, chunk.length)
      Atomics.store(ctl, 0, 1)
    }
    Atomics.notify(ctl, 0)
    if (reported) io.onStdinWait((reported = false))
  }
  const done = new Promise<Exit>(resolve => {
    finish = exit => {
      if (ended) return
      ended = true
      worker.terminate()
      if (reported) io.onStdinWait((reported = false))
      resolve(exit)
    }
  })
  worker.onmessage = ({ data }) => {
    if (ended) return
    if (data.type === 'out') {
      const bytes: Uint8Array = data.bytes
      const text = decoders[data.fd === 2 ? 1 : 0]!.decode(bytes, { stream: true })
      const ack = () => {
        Atomics.add(ctl, 3, bytes.length) // bytes first: the worker re-reads both after the write count changes
        Atomics.add(ctl, 2, 1)
        Atomics.notify(ctl, 2)
      }
      if (text) io.onOutput(text, ack)
      else ack() // the first bytes of a split UTF-8 character
    } else if (data.type === 'stdin') {
      blocked = true
      pump()
      if (blocked) io.onStdinWait((reported = true))
    } else if (data.type === 'exit') finish(data.exit)
  }
  worker.onerror = e => finish(`crash:${(e.message || 'runner worker error').slice(0, 200)}`)
  worker.postMessage({ wasm, sab })

  const enc = new TextEncoder()
  return {
    done,
    write(text) {
      const bytes = enc.encode(text)
      for (let i = 0; i < bytes.length; i += STDIN_CAP) queue.push(bytes.subarray(i, i + STDIN_CAP))
      pump()
    },
    eof() {
      queue.push(null)
      pump()
    },
    kill() {
      finish('killed')
    },
  }
}
