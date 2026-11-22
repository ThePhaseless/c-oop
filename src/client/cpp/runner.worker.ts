// Disposable runner worker: runs one compiled program. The page ends it with worker.terminate().
// In: { wasm, sab } once. Out: { type: 'out', fd, bytes } per write, { type: 'stdin' } when a read blocks,
// { type: 'exit', exit } at the end.
// Shared buffer: Int32[0] stdin state (0 waiting, 1 data, 2 EOF), Int32[1] stdin byte length,
// Int32[2] output writes acknowledged by the page, Int32[3] output bytes acknowledged, stdin bytes from offset 16.
import { ConsoleStdout, Fd, WASI, wasi as defs } from '@bjorn3/browser_wasi_shim'
import type { Exit } from '../../shared/contracts.ts'

const WINDOW_BYTES = 64 * 1024 // the program blocks while more than this much output,
const WINDOW_WRITES = 2048 // or more than this many writes, wait for the page

// bun check has no worker lib: a local type for the two things used from `self`.
const scope = self as unknown as {
  postMessage(message: unknown): void
  onmessage: ((e: { data: { wasm: Uint8Array; sab: SharedArrayBuffer } }) => void) | null
}

// Blocks in fd_read until the page puts a line into the shared buffer.
class BlockingStdin extends Fd {
  private pending = new Uint8Array(0)
  constructor(private ctl: Int32Array, private bytes: Uint8Array) { super() }
  override fd_fdstat_get() {
    return { ret: 0, fdstat: new defs.Fdstat(defs.FILETYPE_CHARACTER_DEVICE, 0) }
  }
  override fd_read(size: number) {
    if (!this.pending.length) {
      scope.postMessage({ type: 'stdin' })
      Atomics.wait(this.ctl, 0, 0)
      const eof = Atomics.load(this.ctl, 0) === 2
      if (!eof) this.pending = this.bytes.slice(0, Atomics.load(this.ctl, 1))
      Atomics.store(this.ctl, 0, 0)
      if (eof) return { ret: 0, data: new Uint8Array(0) } // delivered once, like a terminal
    }
    const data = this.pending.slice(0, size)
    this.pending = this.pending.slice(data.length)
    return { ret: 0, data }
  }
}

scope.onmessage = async ({ data: { wasm, sab } }) => {
  const ctl = new Int32Array(sab, 0, 4)
  let writes = 0, bytes = 0
  // Every write is posted at once (a silent busy loop after a short print must still show the print);
  // then the program waits here while it is too far ahead of the page, so endless output cannot starve the UI.
  const out = (fd: number) => new ConsoleStdout(chunk => {
    if (!chunk.length) return // libc writes empty iovecs
    scope.postMessage({ type: 'out', fd, bytes: chunk })
    writes = (writes + 1) | 0
    bytes = (bytes + chunk.length) | 0
    for (;;) {
      const acked = Atomics.load(ctl, 2)
      if (((writes - acked) | 0) <= WINDOW_WRITES && ((bytes - Atomics.load(ctl, 3)) | 0) <= WINDOW_BYTES) break
      Atomics.wait(ctl, 2, acked)
    }
  })
  const wasi = new WASI(['a.wasm'], [], [new BlockingStdin(ctl, new Uint8Array(sab, 16)), out(1), out(2)], { debug: false }) // the shim logs every call when `debug` is left out
  let exit: Exit
  try {
    const module = await WebAssembly.compile(wasm as Uint8Array<ArrayBuffer>)
    const instance = await WebAssembly.instantiate(module, { wasi_snapshot_preview1: wasi.wasiImport })
    exit = `code:${wasi.start(instance as Parameters<WASI['start']>[0])}`
  } catch (e) {
    // An uncaught C++ exception leaves _start as a WebAssembly.Exception (std::terminate prints nothing).
    const Thrown = (WebAssembly as unknown as { Exception?: new () => object }).Exception
    if (Thrown && e instanceof Thrown) exit = 'crash:uncaught C++ exception'
    else if (e instanceof WebAssembly.CompileError) exit = 'no-wasm-eh' // the engine rejects the exception instructions
    else exit = `crash:${String((e as Error)?.message ?? e).slice(0, 200)}`
  }
  scope.postMessage({ type: 'exit', exit })
}
