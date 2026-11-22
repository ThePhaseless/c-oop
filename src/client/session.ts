// The shared run. The run lives in doc.getMap('session') under the key 'run'; every peer
// renders it from there, and only the peer that created it (the runner) writes its phase and output.
//
// The rules the comments below refer to by number:
//  1. Start: only when canRun() and no run is live. The new map replaces the old one in one transaction,
//     in phase 'compiling' when the compiler is already loaded (`ready`), otherwise 'loading'.
//  2. Still mine: the runner checks after every await, before every write and on every change that the stored
//     map is still its own; once it was replaced, it stops its compile or program and writes nothing more.
//  3. Derived view: the phase shown is derived, never stored. A live run whose runner is absent from awareness
//     shows as 'runner-left' when the runner was seen before, or after RUNNER_GRACE_MS when it never was.
//  4. Permissions: Run needs canRun() and phase idle or done; every peer may stop a live run.
//  5. Stop: any peer pushes {t:'kill'} to `in`; the runner cancels the compile or kills the program.
//  6. Input: the runner handles each event inserted into `in` once, in the order the observer reports it;
//     'line' and 'eof' only while running. A line is echoed to `out` before the program gets it.
//  7. Output: program output is buffered for OUT_FLUSH_MS, then pushed to `out`. Everything pushed counts
//     against OUT_LIMIT; reaching it ends the run with 'output-limit'.
//  8. Diagnostics: compiler messages enter `out` in the same commit as the phase change after the compile.
//  9. Rendering: every peer writes the header line, then the `out` elements it has not shown yet, then one exit
//     line. Replay and live output share that path. The runner's own text is written in commit() instead.
// 10. Pending line: shared text never lands inside a locally typed, unsent line; it is erased and redrawn.
// 11. Untrusted input: the run map comes from other peers; names, phases, exits and `out` elements are checked,
//     and at most OUT_LIMIT * 2 chars are rendered per run.
// 12. Terminal text: what a program prints and what a peer stored are filtered (term-filter.ts) twice: by the
//     runner before the text enters `out`, so the document never holds a control sequence, and by every peer
//     where it writes run text to its terminal, because `out` may be forged.
import * as Y from 'yjs'
import type { Collab, Cpp, Exit, Phase, RunHandle, RunIo, RunView, Session, Term } from '../shared/contracts'
import { LINE_MAX, OUT_CHUNK, OUT_FLUSH_MS, OUT_LIMIT, RUNNER_GRACE_MS } from '../shared/limits'
import { eraseSeq, lineDiscipline, shownPending } from './line-discipline'
import { sanitizeName } from './presence'
import { exitLine, runHeaderLine } from './strings'
import { termFilter } from './term-filter'

type StoredPhase = Exclude<Phase, 'idle'>
// A run map that passed the checks of rule 11.
type Run = { map: Y.Map<unknown>; id: string; runner: number; name: string; phase: StoredPhase; exit: Exit | null; out: Y.Array<unknown>; in: Y.Array<unknown> }
// The run this session is driving as the runner.
type Mine = { map: Y.Map<unknown>; out: Y.Array<string>; clean: (text: string) => string; buf: string; acks: (() => void)[]; timer: ReturnType<typeof setTimeout> | undefined; count: number; handle: RunHandle | null }
type Change = { phase: 'compiling' | 'running' } | { phase: 'done'; exit: Exit }

const PHASES: readonly unknown[] = ['loading', 'compiling', 'running', 'done']
const EXITS: readonly unknown[] = ['killed', 'compile-error', 'load-error', 'output-limit', 'no-wasm-eh']
// Bright black, never SGR 2 (too faint on the token palette). The reset comes first: a program may have left conceal or inverse on.
const grey = (line: string) => `\x1b[0;90m${line}\x1b[0m\n`

function readExit(v: unknown): Exit | null {
  if (typeof v !== 'string') return null
  if (EXITS.includes(v) || /^code:-?\d{1,10}$/.test(v)) return v as Exit
  // The message of a crash ends up on the terminal: no control characters, bounded length.
  if (v.startsWith('crash:')) return `crash:${v.slice(6, 206).replace(/[\x00-\x1f\x7f-\x9f]/g, '')}`
  return null
}

// Where to cut `s` so that at most `n` chars are taken and no surrogate pair is split
// (Yjs stores strings as UTF-8, which turns a lone surrogate into U+FFFD).
function cut(s: string, n: number): number {
  if (n >= s.length) return s.length
  const c = s.charCodeAt(n - 1)
  return n > 1 && c >= 0xd800 && c <= 0xdbff ? n - 1 : n
}

// `source` is the program to compile: the text as this page's editor shows it. A forged update can make
// `text.toString()` return what no editor shows.
export function createSession(o: { collab: Collab; cpp: Cpp; term: Term; canRun(): boolean; source(): string }): Session {
  const { cpp, term } = o
  const { doc, awareness } = o.collab
  const session = doc.getMap<unknown>('session')
  const listeners = new Set<() => void>()
  const notify = () => listeners.forEach(cb => cb())

  let ready = false // the compiler is loaded (rule 1)
  let my: Mine | null = null // set while this session drives a run
  let myMap: Y.Map<unknown> | null = null // the last run map this session created
  let progress = 0
  let stdinWaiting = false
  let seen: { id: string; firstSeen: number; seenRunner: boolean } | null = null // rule 3
  let graceTimer: ReturnType<typeof setTimeout> | undefined
  // What is on this peer's terminal (rule 9). `chars` is the rule 11 cap, `nl` whether the cursor is at a line start.
  let rendered: { id: string; shown: number; chars: number; nl: boolean; exited: boolean; left: boolean; filter: (text: string) => string } | null = null

  // ---- reading (rules 3 and 11) ----

  function read(): Run | null {
    const map = session.get('run')
    if (!(map instanceof Y.Map)) return null
    const id = map.get('id'), runner = map.get('runner'), phase = map.get('phase'), out = map.get('out'), inp = map.get('in')
    if (typeof id !== 'string' || !id || id.length > 64) return null
    if (!Number.isSafeInteger(runner) || !PHASES.includes(phase)) return null
    if (!(out instanceof Y.Array) || !(inp instanceof Y.Array)) return null
    const exit = phase === 'done' ? readExit(map.get('exit')) : null
    if (phase === 'done' && !exit) return null
    return { map, id, runner: runner as number, name: sanitizeName(map.get('name')), phase: phase as StoredPhase, exit, out, in: inp }
  }

  function runnerGone(run: Run): boolean {
    const present = awareness.getStates().has(run.runner)
    if (seen?.id !== run.id) {
      clearTimeout(graceTimer)
      seen = { id: run.id, firstSeen: Date.now(), seenRunner: false }
      if (!present) graceTimer = setTimeout(sync, RUNNER_GRACE_MS)
    }
    if (present) seen.seenRunner = true
    return !present && (seen.seenRunner || Date.now() - seen.firstSeen >= RUNNER_GRACE_MS)
  }

  function derive(): { run: Run | null; phase: Phase; exit: Exit | 'runner-left' | null; mine: boolean } {
    const run = read()
    if (!run) return { run, phase: 'idle', exit: null, mine: false }
    const mine = run.map === myMap
    if (run.phase === 'done') return { run, phase: 'done', exit: run.exit, mine }
    if (!mine && runnerGone(run)) return { run, phase: 'done', exit: 'runner-left', mine }
    return { run, phase: run.phase, exit: null, mine }
  }

  // ---- rendering (rules 9 and 10) ----

  // Run text for the rendered run (rule 12). Shared text never lands inside the local pending line.
  function emit(raw: string, done?: () => void) {
    const text = rendered ? rendered.filter(raw) : ''
    if (!text) return done?.() // all of it dropped, or the start of a sequence that is still held back
    const pending = shownPending(ld.pending())
    term.write(eraseSeq(pending) + text + pending, done)
    if (rendered) rendered.nl = text.endsWith('\n')
  }

  function sync() {
    // Rule 2: the run was replaced, removed, or ended by someone else.
    if (my && (session.get('run') !== my.map || my.map.get('phase') === 'done')) abandon(my)
    const { run, phase, exit } = derive()
    if (run) {
      const left = exit === 'runner-left'
      if (rendered?.id !== run.id || (rendered.left && !left)) {
        ld.clear()
        term.reset()
        term.write(grey(runHeaderLine(run.name)))
        rendered = { id: run.id, shown: 0, chars: 0, nl: true, exited: false, left: false, filter: termFilter() }
      }
      if (run.out.length !== rendered.shown) {
        let text = ''
        for (const s of rendered.shown < run.out.length ? run.out.slice(rendered.shown) : []) {
          if (typeof s !== 'string') continue
          const part = s.slice(0, cut(s, OUT_LIMIT * 2 - rendered.chars))
          text += part
          rendered.chars += part.length
        }
        rendered.shown = run.out.length
        if (text) emit(text)
      }
      if (phase === 'done' && exit && !rendered.exited) {
        rendered.exited = true
        rendered.left = left
        const pending = ld.pending()
        ld.clear() // nobody reads input any more
        term.write(eraseSeq(pending) + (rendered.nl ? '' : '\n') + grey(exitLine(exit)))
      }
    }
    notify()
  }

  // ---- the runner ----

  // Every cancel goes through here, so `ready` cannot be stale.
  function cancelCompiler() {
    ready = false
    cpp.cancel()
  }

  // Rule 2: stop the local compile or program and write nothing more.
  function abandon(run: Mine) {
    if (my === run) my = null
    clearTimeout(run.timer)
    stdinWaiting = false
    if (run.handle) run.handle.kill()
    else cancelCompiler()
  }

  // The only writer of a run map after its creation.
  // shortcut: output is pushed whatever the data channels have buffered; a peer on a very slow link can fall
  // behind during bursts. Upgrade: pause flushing on bufferedAmount.
  function commit(run: Mine, change?: Change) {
    if (my !== run) return
    clearTimeout(run.timer)
    run.timer = undefined
    let over = false
    doc.transact(() => {
      if (session.get('run') !== run.map || run.map.get('phase') === 'done') return abandon(run)
      const acks = run.acks.splice(0)
      const done = () => acks.forEach(ack => ack())
      let text = run.buf
      run.buf = ''
      const room = OUT_LIMIT - run.count
      // The limit ends the run as soon as it is reached, also by diagnostics alone (rules 7 and 8).
      if (text.length >= room) {
        over = true
        text = text.slice(0, cut(text, room))
      }
      if (text) {
        const parts: string[] = []
        for (let i = 0; i < text.length; ) {
          const end = i + cut(text.slice(i, i + OUT_CHUNK + 1), OUT_CHUNK)
          parts.push(text.slice(i, end))
          i = end
        }
        run.out.push(parts)
        run.count += text.length
        // The runner's terminal gets the text here, before the observers run, so before any exit line.
        if (rendered && rendered.id === run.map.get('id')) {
          rendered.shown += parts.length
          rendered.chars += text.length
          emit(text, done)
        } else done()
      } else done()
      if (over) change = { phase: 'done', exit: 'output-limit' }
      if (!change) return
      run.map.set('phase', change.phase)
      if (change.phase === 'done') {
        run.map.set('exit', change.exit)
        my = null
        stdinWaiting = false
      }
    })
    if (over) run.handle?.kill()
  }

  // Rules 5 and 6. Called once per inserted event, for local and remote pushes alike.
  function onInput(run: Mine, ev: unknown) {
    if (my !== run || typeof ev !== 'object' || ev === null) return
    const { t, d } = ev as { t?: unknown; d?: unknown }
    if (t === 'kill') {
      if (run.handle) return run.handle.kill() // the normal end path writes 'killed'
      cancelCompiler()
      return commit(run, { phase: 'done', exit: 'killed' })
    }
    if (!run.handle || run.map.get('phase') !== 'running') return
    if (t === 'eof') run.handle.eof()
    else if (t === 'line' && typeof d === 'string' && d.length <= LINE_MAX) {
      // A filter of its own: the program's filter may be holding the start of a sequence, which would take the line for its rest.
      run.buf += termFilter()(d)
      commit(run) // buffered program output, then the echo
      if (my === run) run.handle.write(d)
    }
  }

  async function drive(run: Mine) {
    let result
    try {
      await cpp.load(p => {
        progress = p
        if (my === run) notify()
      })
      if (my !== run) return
      ready = true
      commit(run, { phase: 'compiling' })
      if (my !== run) return
      result = await cpp.compile(o.source())
    } catch {
      // A cancel by this session has already finished or abandoned the run; anything else is a compiler failure.
      ready = false
      return commit(run, { phase: 'done', exit: 'load-error' })
    }
    if (my !== run) return
    run.buf += run.clean(result.diagnostics)
    if (!result.ok || !result.wasm) return commit(run, { phase: 'done', exit: 'compile-error' })
    commit(run, { phase: 'running' })
    if (my !== run) return // diagnostics alone reached the limit, or the run was replaced
    const io: RunIo = {
      onOutput(text, ack) {
        if (my !== run) return
        run.buf += run.clean(text)
        run.acks.push(ack)
        run.timer ??= setTimeout(() => commit(run), OUT_FLUSH_MS)
      },
      onStdinWait(waiting) {
        if (my !== run) return
        stdinWaiting = waiting
        notify()
      },
    }
    run.handle = cpp.run(result.wasm, io)
    const exit = await run.handle.done
    commit(run, { phase: 'done', exit })
  }

  function start() {
    if (!o.canRun()) return
    const { phase } = derive()
    if (phase !== 'idle' && phase !== 'done') return
    const map = new Y.Map<unknown>(), out = new Y.Array<string>(), inp = new Y.Array<unknown>()
    const run: Mine = { map, out, clean: termFilter(), buf: '', acks: [], timer: undefined, count: 0, handle: null }
    // Rule 6: exactly the items each event reports as inserted, in its order; no index into `in`, because
    // two peers pushing at once are ordered by client id and the later arrival can land in front.
    inp.observe(e => {
      for (const d of e.changes.delta) if (Array.isArray(d.insert)) for (const ev of d.insert) onInput(run, ev)
    })
    progress = 0
    doc.transact(() => {
      map.set('id', Math.random().toString(36).slice(2, 10).padEnd(8, '0'))
      map.set('runner', doc.clientID)
      map.set('name', sanitizeName((awareness.getLocalState() as { user?: { name?: unknown } } | null)?.user?.name))
      map.set('phase', ready ? 'compiling' : 'loading')
      map.set('out', out)
      map.set('in', inp)
      session.set('run', map)
      my = run
      myMap = map
    })
    void drive(run)
  }

  // ---- input from this peer ----

  function push(ev: { t: 'line'; d: string } | { t: 'eof' } | { t: 'kill' }) {
    const { run, phase } = derive()
    if (run && phase !== 'done') run.in.push([ev])
  }

  const ld = lineDiscipline({
    echo: s => term.write(s),
    line: d => push({ t: 'line', d }),
    eof: () => push({ t: 'eof' }),
    interrupt: () => push({ t: 'kill' }),
  })

  term.onData(data => {
    const { phase } = derive()
    if (phase === 'running') ld.feed(data)
    else if ((phase === 'loading' || phase === 'compiling') && data === '\x03') push({ t: 'kill' })
  })

  session.observeDeep(sync)
  awareness.on('change', sync)
  sync()

  return {
    start,
    stop: () => push({ t: 'kill' }),
    view(): RunView {
      const { run, phase, exit, mine } = derive()
      return {
        phase,
        runnerName: run?.name ?? '',
        mine,
        exit,
        progress: mine && phase === 'loading' ? progress : null,
        stdinWaiting: mine && phase === 'running' && stdinWaiting,
      }
    },
    onChange(cb) {
      listeners.add(cb)
      return () => void listeners.delete(cb)
    },
  }
}
