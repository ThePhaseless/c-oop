import type * as Y from 'yjs'
import type { Awareness } from 'y-protocols/awareness'

export type RoomKeys = { secret: string; topic: string; password: string }

export type User = { name: string; color: string }
export type Peer = { clientId: number; user: User; self: boolean }
export type NetStatus = { signaling: boolean; connected: number; stuck: number }
export type Collab = {
  doc: Y.Doc
  text: Y.Text                 // doc.getText('code')
  awareness: Awareness
  peers(): Peer[]              // sanitised; self first
  net(): NetStatus
  setName(name: string): void
  onChange(cb: () => void): () => void
}

export type CompileResult = { ok: boolean; wasm?: Uint8Array; diagnostics: string }
// 'load-error': the compiler could not be loaded, or it failed while loading or compiling (crash, out of memory).
export type Exit = 'killed' | 'compile-error' | 'load-error' | 'output-limit' | 'no-wasm-eh' | `code:${number}` | `crash:${string}`
export type RunIo = { onOutput(text: string, ack: () => void): void; onStdinWait(waiting: boolean): void }
export type RunHandle = { write(text: string): void; eof(): void; kill(): void; done: Promise<Exit> }
export type Cpp = {
  // Idempotent. Calls onProgress(1) and then resolves. Rejects when loading fails or cancel() is called.
  // After a rejection the next load() starts over with a new worker.
  load(onProgress: (fraction: number) => void): Promise<void>
  // Needs a resolved load(). Resolves ok: false with clang's diagnostics for a compile error.
  // Rejects when the compiler itself fails (worker error, crash, out of memory); the worker is then
  // discarded and the next load() starts over.
  compile(source: string): Promise<CompileResult>
  // Terminates the compiler worker. A pending load() rejects; a pending compile() resolves
  // { ok: false, diagnostics: '' }. The caller remembers that it cancelled.
  cancel(): void
  run(wasm: Uint8Array, io: RunIo): RunHandle
}

export type Term = {
  write(text: string, done?: () => void): void
  reset(): void                // RIS, then re-enable reverse wraparound
  onData(cb: (data: string) => void): void
  focus(): void
  setTheme(): void             // re-read CSS tokens
  screen(): string             // text up to the cursor (test hook)
}

export type Phase = 'idle' | 'loading' | 'compiling' | 'running' | 'done'
export type RunView = {
  phase: Phase
  runnerName: string
  mine: boolean
  exit: Exit | 'runner-left' | null
  progress: number | null      // 0..1 while this browser loads the toolchain
  stdinWaiting: boolean        // true only on the runner
}
export type Session = { start(): void; stop(): void; view(): RunView; onChange(cb: () => void): () => void }

// 'failed': boot threw (for example a browser with WebRTC switched off); blocking, like 'insecure'.
// 'code-limit' and 'copy-failed' report something that just happened and go away by themselves (Ui.flash).
export type Notice = 'insecure' | 'bad-link' | 'failed' | 'no-isolation' | 'offline' | 'stuck' | 'code-limit' | 'copy-failed' | null
// Where this browser's copy of the compiler files stands before its first Run. 'on-run': the first Run downloads them.
export type CompilerFiles = 'on-run' | 'fetching' | 'ready'
export type UiState = { peers: Peer[]; net: NetStatus; run: RunView; notice: Notice; canRun: boolean; compiler: CompilerFiles; ai: AiView }
// ai(): the #ai button was activated. aiEscape(): Escape was pressed on it.
export type UiHandlers = { run(): void; stop(): void; rename(name: string): void; newRoom(): void; themeChanged(): void; ai(): void; aiEscape(): void }
export type Ui = { editorHost: HTMLElement; terminalHost: HTMLElement; render(s: UiState): void; flash(notice: 'code-limit' | 'copy-failed'): void }

// POST /ai, offered only when GET /config says `ai: true`. `before` and `after` are main.cpp around the place of the
// deleted `??? ` line; cut[0] and cut[1] say that text before and after that window was left out.
export type AiRequest = { prompt: string; before: string; after: string; cut: [boolean, boolean] }
export type AiError = 'limit' | 'day-limit' | 'busy' | 'refused' | 'too-long' | 'failed'
export type AiReply = { code: string } | { error: AiError }
// The requester's own view of its one request. 'off': the server offers no generation. `nudge` grows each time
// another prompt was turned away because this one is pending, so the status is announced again. `noRoom`: the
// code was not inserted because main.cpp would pass its size limit with it; the result is kept, and each such try raises `nudge` too.
export type AiView =
  | { state: 'off' }
  | { state: 'idle'; last?: 'inserted' | 'discarded' }
  | { state: 'working'; partial: boolean; nudge: number }
  | { state: 'ready'; nudge: number; noRoom?: true }
  | { state: 'failed'; why: AiError | 'prompt' }
