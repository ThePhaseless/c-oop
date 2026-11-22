import { afterEach, beforeEach, expect, jest, test } from 'bun:test'
import { Awareness, applyAwarenessUpdate, encodeAwarenessUpdate, removeAwarenessStates } from 'y-protocols/awareness'
import * as Y from 'yjs'
import type { Collab, CompileResult, Cpp, Exit, RunIo, Session, Term } from '../shared/contracts'
import { LINE_MAX, OUT_CHUNK, OUT_FLUSH_MS, OUT_LIMIT, RUNNER_GRACE_MS } from '../shared/limits'
import { createSession } from './session'
import { exitLine, runHeaderLine } from './strings'
import { guardText } from './text-guard'

// ---- fakes ----

function fakeTerm() {
  let onData = (_: string) => {}
  const t = {
    text: '', // everything written since the last reset
    resets: 0,
    write(s: string, done?: () => void) {
      t.text += s
      done?.()
    },
    reset() {
      t.resets++
      t.text = ''
    },
    onData(cb: (data: string) => void) {
      onData = cb
    },
    focus() {},
    setTheme() {},
    screen: () => t.text,
    type: (data: string) => onData(data),
  }
  return t satisfies Term
}

type Prog = { io: RunIo; written: string[]; eofs: number; killed: boolean; exit(e: Exit): void }

function fakeCpp() {
  let pendingLoad: { resolve(): void; reject(e: Error): void } | null = null
  let pendingCompile: { resolve(r: CompileResult): void; reject(e: Error): void } | null = null
  const c = {
    autoLoad: true,
    result: { ok: true, wasm: new Uint8Array(1), diagnostics: '' } as CompileResult | 'hang',
    loaded: false,
    cancels: 0,
    programs: [] as Prog[],
    compiled: [] as string[],
    finishLoad: () => pendingLoad?.resolve(),
    failLoad() {
      c.loaded = false
      pendingLoad?.reject(new Error('boom'))
    },
    failCompile() {
      c.loaded = false
      pendingCompile?.reject(new Error('out of memory'))
    },
    load(onProgress: (f: number) => void) {
      if (c.loaded) return Promise.resolve()
      const p = new Promise<void>((resolve, reject) => {
        pendingLoad = {
          resolve() {
            c.loaded = true
            onProgress(1)
            resolve()
          },
          reject,
        }
      })
      if (c.autoLoad) pendingLoad!.resolve()
      return p
    },
    compile(source: string) {
      c.compiled.push(source)
      if (c.result !== 'hang') return Promise.resolve(c.result)
      return new Promise<CompileResult>((resolve, reject) => (pendingCompile = { resolve, reject }))
    },
    cancel() {
      c.cancels++
      c.loaded = false
      pendingLoad?.reject(new Error('cancelled'))
      pendingCompile?.resolve({ ok: false, diagnostics: '' })
    },
    run(_wasm: Uint8Array, io: RunIo) {
      let finish = (_: Exit) => {}
      const done = new Promise<Exit>(resolve => (finish = resolve))
      const prog: Prog = { io, written: [], eofs: 0, killed: false, exit: e => finish(e) }
      c.programs.push(prog)
      return {
        write: (s: string) => void prog.written.push(s),
        eof: () => void prog.eofs++,
        kill() {
          prog.killed = true
          finish('killed')
        },
        done,
      }
    },
  }
  return c satisfies Cpp
}

type Peer = { doc: Y.Doc; aw: Awareness; term: ReturnType<typeof fakeTerm>; cpp: ReturnType<typeof fakeCpp>; session: Session; changes: number }
const awarenesses: Awareness[] = []

function peer(name: string, state?: Uint8Array): Peer {
  const doc = new Y.Doc()
  if (state) Y.applyUpdate(doc, state)
  const aw = new Awareness(doc)
  awarenesses.push(aw)
  aw.setLocalState({ user: { name, color: '#0d7da2' } })
  const term = fakeTerm()
  const cpp = fakeCpp()
  const collab = { doc, text: doc.getText('code'), awareness: aw } as unknown as Collab
  const p: Peer = { doc, aw, term, cpp, session: createSession({ collab, cpp, term, canRun: () => true, source: () => `// in ${name}'s editor` }), changes: 0 }
  p.session.onChange(() => p.changes++)
  return p
}

const WIRE = 'wire'
type Channel = 'doc' | 'aw'
// In-memory link. A closed channel queues what it would have carried; open() delivers it in order.
function connect(a: Peer, b: Peer, on: Record<Channel, boolean> = { doc: true, aw: true }) {
  const queue: Record<Channel, (() => void)[]> = { doc: [], aw: [] }
  const send = (ch: Channel, f: () => void) => (on[ch] ? f() : void queue[ch].push(f))
  for (const [x, y] of [[a, b], [b, a]] as const) {
    x.doc.on('update', (u: Uint8Array, origin: unknown) => {
      if (origin !== WIRE) send('doc', () => Y.applyUpdate(y.doc, u, WIRE))
    })
    x.aw.on('update', ({ added, updated, removed }: Record<string, number[]>, origin: unknown) => {
      if (origin === WIRE) return
      const u = encodeAwarenessUpdate(x.aw, [...added!, ...updated!, ...removed!])
      send('aw', () => applyAwarenessUpdate(y.aw, u, WIRE))
    })
    const state = Y.encodeStateAsUpdate(x.doc)
    send('doc', () => Y.applyUpdate(y.doc, state, WIRE))
    const presence = encodeAwarenessUpdate(x.aw, [x.doc.clientID])
    send('aw', () => applyAwarenessUpdate(y.aw, presence, WIRE))
  }
  return {
    close: (ch: Channel) => void (on[ch] = false),
    open(ch: Channel) {
      on[ch] = true
      for (const f of queue[ch].splice(0)) f()
    },
  }
}

function pair() {
  const a = peer('Ala')
  const b = peer('Bartek')
  return { a, b, link: connect(a, b) }
}

const settle = async () => {
  for (let i = 0; i < 30; i++) await Promise.resolve()
}
const flush = () => jest.advanceTimersByTime(OUT_FLUSH_MS)
const count = (text: string, part: string) => text.split(part).length - 1
const runMap = (p: Peer) => p.doc.getMap('session').get('run') as Y.Map<unknown>
const out = (p: Peer) => (runMap(p).get('out') as Y.Array<string>).toArray()
const noop = () => {}

/** A starts a run and its fake program is running. */
async function running(a: Peer): Promise<Prog> {
  a.session.start()
  await settle()
  expect(a.session.view().phase).toBe('running')
  return a.cpp.programs.at(-1)!
}

beforeEach(() => {
  jest.useFakeTimers()
})
afterEach(() => {
  for (const aw of awarenesses.splice(0)) aw.destroy()
  jest.useRealTimers() // other test files in the same process need real timers
})

// ---- output ----

test('output is batched and each chunk reaches both terminals exactly once', async () => {
  const { a, b } = pair()
  const prog = await running(a)
  let acks = 0
  prog.io.onOutput('one ', () => acks++)
  prog.io.onOutput('two ', () => acks++)
  expect(a.term.text).not.toContain('one')
  expect(b.term.text).not.toContain('one')
  expect(acks).toBe(0)
  flush()
  prog.io.onOutput('three', () => acks++)
  flush()
  for (const p of [a, b]) {
    expect(count(p.term.text, 'one two three')).toBe(1)
    expect(count(p.term.text, 'one')).toBe(1)
    expect(count(p.term.text, runHeaderLine('Ala'))).toBe(1)
    expect(p.term.resets).toBe(1)
  }
  expect(acks).toBe(3)
  expect(out(b)).toEqual(['one two ', 'three'])
  expect(b.session.view()).toMatchObject({ phase: 'running', runnerName: 'Ala', mine: false })
  expect(a.session.view()).toMatchObject({ phase: 'running', runnerName: 'Ala', mine: true })
})

test('out elements never exceed OUT_CHUNK and never split a surrogate pair', async () => {
  const { a, b } = pair()
  const prog = await running(a)
  const text = 'x'.repeat(OUT_CHUNK - 1) + '😀' + 'y'.repeat(OUT_CHUNK)
  prog.io.onOutput(text, noop)
  flush()
  expect(out(b).every(s => s.length <= OUT_CHUNK)).toBe(true)
  expect(out(b).join('')).toBe(text)
  expect(b.term.text).toContain('x😀y')
})

test('the final output is on the terminal before the exit line', async () => {
  const { a, b } = pair()
  const prog = await running(a)
  prog.io.onOutput('bye', noop)
  prog.exit('code:0')
  await settle()
  for (const p of [a, b]) {
    expect(p.session.view()).toMatchObject({ phase: 'done', exit: 'code:0' })
    expect(count(p.term.text, 'bye')).toBe(1)
    expect(count(p.term.text, exitLine('code:0'))).toBe(1)
    expect(p.term.text.indexOf('bye')).toBeLessThan(p.term.text.indexOf(exitLine('code:0')))
    expect(p.term.text).toContain('bye\n') // the exit line starts on its own line
  }
})

test('output over the limit ends the run with output-limit, and the killed program cannot overwrite it', async () => {
  const { a, b } = pair()
  const prog = await running(a)
  prog.io.onOutput('x'.repeat(OUT_LIMIT - 10), noop)
  flush()
  expect(a.session.view().phase).toBe('running')
  prog.io.onOutput('y'.repeat(50), noop)
  flush()
  expect(prog.killed).toBe(true)
  await settle() // the killed program's `done` resolves 'killed'
  for (const p of [a, b]) {
    expect(p.session.view()).toMatchObject({ phase: 'done', exit: 'output-limit' })
    expect(count(p.term.text, exitLine('output-limit'))).toBe(1)
    expect(p.term.text).not.toContain(exitLine('killed'))
  }
  expect(out(b).join('').length).toBe(OUT_LIMIT)
})

// ---- input ----

test('a typed line is echoed once on both sides, whether the runner or the other peer types it', async () => {
  const { a, b } = pair()
  const prog = await running(a)
  a.term.type('hi\r')
  expect(prog.written).toEqual(['hi\n'])
  b.term.type('yo\r')
  expect(prog.written).toEqual(['hi\n', 'yo\n'])
  for (const p of [a, b]) {
    expect(count(p.term.text, 'hi\n')).toBe(1)
    expect(count(p.term.text, 'yo\n')).toBe(1)
  }
  expect(out(b).join('')).toBe('hi\nyo\n')
})

test('a prompt still in the output buffer is rendered before the echo of its answer', async () => {
  const { a, b } = pair()
  const prog = await running(a)
  prog.io.onOutput('Name: ', noop)
  b.term.type('Al\r')
  prog.io.onOutput('Age: ', noop)
  a.term.type('7\r')
  for (const p of [a, b]) {
    expect(count(p.term.text, 'Name: Al\n')).toBe(1)
    expect(count(p.term.text, 'Age: 7\n')).toBe(1)
  }
  expect(prog.written).toEqual(['Al\n', '7\n'])
})

test('lines pushed at the same moment by two peers each reach the program exactly once', async () => {
  const { a, b, link } = pair()
  const prog = await running(a)
  link.close('doc')
  a.term.type('from-a\r')
  b.term.type('from-b\r')
  link.open('doc')
  expect([...prog.written].sort()).toEqual(['from-a\n', 'from-b\n'])
  for (const p of [a, b]) {
    expect(count(p.term.text, 'from-a\n')).toBe(1)
    expect(count(p.term.text, 'from-b\n')).toBe(1)
  }
})

test('a line of maximum length still reaches the program', async () => {
  const { a, b } = pair()
  const prog = await running(a)
  b.term.type('x'.repeat(LINE_MAX + 5) + '\r')
  expect(prog.written.map(s => s.length)).toEqual([LINE_MAX])
})

test('Ctrl+D sends end of file, typing is ignored unless the program runs', async () => {
  const { a, b } = pair()
  b.term.type('early\r')
  const prog = await running(a)
  b.term.type('\x04')
  expect(prog.eofs).toBe(1)
  prog.exit('code:0')
  await settle()
  const before = b.term.text
  b.term.type('late\r')
  expect(b.term.text).toBe(before)
  expect(prog.written).toEqual([])
})

test('shared output never lands inside a local pending line', async () => {
  const { a, b } = pair()
  const prog = await running(a)
  b.term.type('a\tb')
  const before = b.term.text
  prog.io.onOutput('OUT', noop)
  flush()
  expect(b.term.text).toBe(before + '\b \b'.repeat(3) + 'OUT' + 'a b')
  b.term.type('\r')
  expect(prog.written).toEqual(['a\tb\n'])
})

// ---- compile ----

test('diagnostics of a failed compile reach the other peer and the run ends compile-error', async () => {
  const { a, b } = pair()
  a.cpp.result = { ok: false, diagnostics: 'main.cpp:1:1: error: nope\n' }
  a.session.start()
  await settle()
  for (const p of [a, b]) {
    expect(p.session.view()).toMatchObject({ phase: 'done', exit: 'compile-error' })
    expect(count(p.term.text, 'error: nope')).toBe(1)
    expect(count(p.term.text, exitLine('compile-error'))).toBe(1)
  }
  expect(a.cpp.programs.length).toBe(0)
  expect(a.cpp.cancels).toBe(0)
})

test('warnings of a successful compile are rendered before the first program output', async () => {
  const { a, b } = pair()
  a.cpp.result = { ok: true, wasm: new Uint8Array(1), diagnostics: 'warning: unused\n' }
  const prog = await running(a)
  prog.io.onOutput('ok\n', noop)
  flush()
  for (const p of [a, b]) {
    expect(count(p.term.text, 'warning: unused\nok\n')).toBe(1)
  }
})

test('diagnostics longer than the limit end the run with output-limit and no program starts', async () => {
  const { a, b } = pair()
  a.cpp.result = { ok: true, wasm: new Uint8Array(1), diagnostics: 'w'.repeat(OUT_LIMIT + 1) }
  a.session.start()
  await settle()
  for (const p of [a, b]) expect(p.session.view()).toMatchObject({ phase: 'done', exit: 'output-limit' })
  expect(a.cpp.programs.length).toBe(0)
  expect(out(b).join('').length).toBe(OUT_LIMIT)
})

test('a compile that rejects ends load-error on both sides and the next run loads again', async () => {
  const { a, b } = pair()
  a.cpp.result = 'hang'
  a.session.start()
  await settle()
  expect(b.session.view().phase).toBe('compiling')
  a.cpp.failCompile()
  await settle()
  for (const p of [a, b]) {
    expect(p.session.view()).toMatchObject({ phase: 'done', exit: 'load-error' })
    expect(count(p.term.text, exitLine('load-error'))).toBe(1)
  }
  a.cpp.autoLoad = false
  a.session.start()
  expect(a.session.view().phase).toBe('loading')
})

// ---- start and stop ----

test('a run after a loaded compiler starts in compiling, with progress only while loading', async () => {
  const { a } = pair()
  a.cpp.autoLoad = false
  a.session.start()
  expect(a.session.view()).toMatchObject({ phase: 'loading', mine: true, progress: 0 })
  a.cpp.finishLoad()
  const prog = await running(a)
  expect(a.session.view().progress).toBe(null)
  prog.io.onStdinWait(true)
  expect(a.session.view().stdinWaiting).toBe(true)
  prog.exit('code:3')
  await settle()
  expect(a.session.view()).toMatchObject({ phase: 'done', exit: 'code:3', stdinWaiting: false })
  a.cpp.result = 'hang'
  a.session.start()
  expect(a.session.view().phase).toBe('compiling')
})

test('start does nothing while a run is live or when running is not allowed', async () => {
  const { a, b } = pair()
  await running(a)
  const id = runMap(a).get('id')
  a.session.start()
  b.session.start()
  await settle()
  expect(runMap(b).get('id')).toBe(id)
  expect(b.cpp.programs.length).toBe(0)

  const doc = new Y.Doc()
  const aw = new Awareness(doc)
  awarenesses.push(aw)
  const blocked = createSession({ collab: { doc, text: doc.getText('code'), awareness: aw } as unknown as Collab, cpp: fakeCpp(), term: fakeTerm(), canRun: () => false, source: () => '' })
  blocked.start()
  expect(blocked.view().phase).toBe('idle')
})

test("the program compiled is what the runner's editor shows, whatever the shared text returns", async () => {
  const { a, b } = pair()
  a.doc.getText('code').insert(0, 'what a forged update can make toString() return')
  await running(a)
  expect(a.cpp.compiled).toEqual(["// in Ala's editor"])
  expect(b.cpp.compiled).toEqual([])
})

test('stop from the other peer kills the running program', async () => {
  const { a, b } = pair()
  const prog = await running(a)
  b.session.stop()
  expect(prog.killed).toBe(true)
  await settle()
  for (const p of [a, b]) expect(p.session.view()).toMatchObject({ phase: 'done', exit: 'killed' })
})

test('stop during loading ends killed and the next run starts in loading again', async () => {
  const { a, b } = pair()
  a.cpp.autoLoad = false
  a.session.start()
  await settle()
  expect(b.session.view().phase).toBe('loading')
  b.session.stop()
  await settle()
  expect(a.cpp.cancels).toBe(1)
  for (const p of [a, b]) expect(p.session.view()).toMatchObject({ phase: 'done', exit: 'killed' })
  a.session.start()
  expect(a.session.view().phase).toBe('loading')
})

test('a load that rejects without a cancel ends load-error', async () => {
  const { a, b } = pair()
  a.cpp.autoLoad = false
  a.session.start()
  await settle()
  a.cpp.failLoad()
  await settle()
  for (const p of [a, b]) expect(p.session.view()).toMatchObject({ phase: 'done', exit: 'load-error' })
  expect(a.cpp.cancels).toBe(0)
})

test('stop during compiling ends killed, not compile-error; Ctrl+C in the terminal does the same', async () => {
  const { a, b } = pair()
  a.cpp.result = 'hang'
  a.session.start()
  await settle()
  a.session.stop()
  await settle()
  for (const p of [a, b]) expect(p.session.view()).toMatchObject({ phase: 'done', exit: 'killed' })
  expect(a.cpp.programs.length).toBe(0)

  a.session.start()
  expect(a.session.view().phase).toBe('loading') // the cancel discarded the compiler
  await settle()
  b.term.type('x')
  expect(a.session.view().phase).toBe('compiling')
  b.term.type('\x03')
  await settle()
  for (const p of [a, b]) expect(p.session.view()).toMatchObject({ phase: 'done', exit: 'killed' })
})

test('concurrent start leaves one run and kills the silent program of the loser', async () => {
  const { a, b, link } = pair()
  link.close('doc')
  const pa = await running(a)
  const pb = await running(b)
  link.open('doc')
  await settle()
  expect(runMap(a).get('id')).toBe(runMap(b).get('id') as string)
  const [winner, loser] = a.session.view().mine ? [a, b] : [b, a]
  expect(loser.session.view()).toMatchObject({ phase: 'running', mine: false })
  expect(winner.session.view()).toMatchObject({ phase: 'running', mine: true })
  expect(loser.cpp.programs[0]!.killed).toBe(true)
  expect(winner.cpp.programs[0]!.killed).toBe(false)
  // The loser writes nothing more: output and the end of its program stay out of the winner's run.
  const lost = loser === a ? pa : pb
  lost.io.onOutput('ghost', noop)
  flush()
  await settle()
  for (const p of [a, b]) {
    expect(p.term.text).not.toContain('ghost')
    expect(p.session.view().phase).toBe('running')
    expect(count(p.term.text, ']')).toBe(1) // one header, no exit line
  }
})

// ---- late joiners and the runner's presence ----

test('a late joiner replays the existing output exactly once', async () => {
  const { a } = pair()
  const prog = await running(a)
  prog.io.onOutput('first ', noop)
  flush()
  prog.io.onOutput('second ', noop)
  flush()
  const c = peer('Celina')
  connect(a, c)
  expect(c.term.resets).toBe(1)
  expect(count(c.term.text, runHeaderLine('Ala'))).toBe(1)
  expect(count(c.term.text, 'first second ')).toBe(1)
  prog.io.onOutput('third', noop)
  flush()
  expect(count(c.term.text, 'first second third')).toBe(1)
})

test('a run restored before its runner is seen stays live, and stays as rendered when the runner shows up', async () => {
  const a = peer('Ala')
  const prog = await running(a)
  prog.io.onOutput('Name: ', noop)
  flush()
  const b = peer('Bartek', Y.encodeStateAsUpdate(a.doc)) // the reload case: the document comes from the local copy
  const link = connect(a, b, { doc: true, aw: false })
  jest.advanceTimersByTime(RUNNER_GRACE_MS - 1)
  expect(b.session.view()).toMatchObject({ phase: 'running', exit: null })
  b.session.start() // Run is disabled
  expect(runMap(b).get('runner')).toBe(a.doc.clientID)
  link.open('aw')
  jest.advanceTimersByTime(RUNNER_GRACE_MS)
  expect(b.session.view()).toMatchObject({ phase: 'running', exit: null })
  expect(b.term.resets).toBe(1)
  expect(count(b.term.text, 'Name: ')).toBe(1)
  expect(b.term.text).not.toContain(exitLine('runner-left'))
  prog.exit('code:0')
  await settle()
  expect(b.session.view()).toMatchObject({ phase: 'done', exit: 'code:0' })
})

test('a stale run whose runner never appears is live for the grace period, then runner-left', async () => {
  const a = peer('Ala')
  await running(a)
  const c = peer('Celina', Y.encodeStateAsUpdate(a.doc))
  expect(c.session.view().phase).toBe('running')
  jest.advanceTimersByTime(RUNNER_GRACE_MS - 1)
  expect(c.session.view().phase).toBe('running')
  const changes = c.changes
  jest.advanceTimersByTime(1)
  expect(c.changes).toBeGreaterThan(changes) // fired by the timer
  expect(c.session.view()).toMatchObject({ phase: 'done', exit: 'runner-left', mine: false })
  expect(count(c.term.text, exitLine('runner-left'))).toBe(1)
  c.session.start() // Run is enabled again
  await settle()
  expect(c.session.view()).toMatchObject({ phase: 'running', mine: true })
})

test('a runner that was seen and then leaves gives runner-left at once', async () => {
  const { a, b, link } = pair()
  await running(a)
  link.close('aw')
  removeAwarenessStates(b.aw, [a.doc.clientID], 'timeout')
  expect(b.session.view()).toMatchObject({ phase: 'done', exit: 'runner-left' })
  expect(count(b.term.text, exitLine('runner-left'))).toBe(1)
  expect(a.session.view()).toMatchObject({ phase: 'running', mine: true }) // a `mine` run is never runner-left
})

test('a run shown as runner-left is rendered from scratch when its runner appears, and continues', async () => {
  const a = peer('Ala')
  const prog = await running(a)
  prog.io.onOutput('before ', noop)
  flush()
  const b = peer('Bartek', Y.encodeStateAsUpdate(a.doc))
  const link = connect(a, b, { doc: true, aw: false })
  jest.advanceTimersByTime(RUNNER_GRACE_MS)
  expect(b.session.view().exit).toBe('runner-left')
  expect(b.term.resets).toBe(1)
  link.open('aw')
  expect(b.session.view()).toMatchObject({ phase: 'running', exit: null })
  expect(b.term.resets).toBe(2)
  expect(count(b.term.text, runHeaderLine('Ala'))).toBe(1)
  expect(count(b.term.text, 'before ')).toBe(1)
  expect(b.term.text).not.toContain(exitLine('runner-left'))
  prog.io.onOutput('after', noop)
  flush()
  expect(count(b.term.text, 'before after')).toBe(1)
  expect(b.term.resets).toBe(2)
})

// ---- untrusted data ----

test('malformed run maps are ignored', async () => {
  const { a, b } = pair()
  const session = b.doc.getMap('session')
  session.set('run', 'not a map')
  expect(a.session.view().phase).toBe('idle')
  const bad = new Y.Map<unknown>()
  bad.set('id', 'abcdefgh')
  bad.set('runner', b.doc.clientID)
  bad.set('name', 'Bartek')
  bad.set('phase', 'exploding')
  bad.set('out', new Y.Array())
  bad.set('in', new Y.Array())
  session.set('run', bad)
  expect(a.session.view().phase).toBe('idle')
  bad.set('phase', 'done')
  bad.set('exit', 'made-up')
  expect(a.session.view().phase).toBe('idle')
  bad.set('exit', 'code:x')
  expect(a.session.view().phase).toBe('idle')
  expect(a.term.text).toBe('')
  expect(a.term.resets).toBe(0)
  a.session.stop() // nothing to stop, nothing thrown
  a.term.type('x\r')
})

test('a remote run is rendered only through the validations: name, out elements, render cap', async () => {
  const { a, b } = pair()
  const run = new Y.Map<unknown>()
  const outArr = new Y.Array<unknown>()
  run.set('id', 'abcdefgh')
  run.set('runner', b.doc.clientID)
  run.set('name', '\x1b[31mEvil\x07' + 'n'.repeat(100))
  run.set('phase', 'running')
  run.set('out', outArr)
  run.set('in', new Y.Array())
  b.doc.getMap('session').set('run', run)
  const name = a.session.view().runnerName
  expect(name.startsWith('[31mEvil')).toBe(true)
  expect(name.length).toBeLessThanOrEqual(24)
  expect(a.term.text).not.toContain('\x1b[31m')
  expect(a.term.text).not.toContain('\x07')
  outArr.push([5, 'text', { a: 1 }, null, 'more'])
  expect(count(a.term.text, 'textmore')).toBe(1)
  outArr.push(['z'.repeat(OUT_LIMIT), 'z'.repeat(OUT_LIMIT), 'z'.repeat(OUT_LIMIT)])
  expect(count(a.term.text, 'z')).toBe(OUT_LIMIT * 2 - 'textmore'.length)
  b.doc.transact(() => {
    run.set('phase', 'done')
    run.set('exit', 'crash:\x1b[2Jboom' + 'm'.repeat(500))
  })
  expect(a.session.view().phase).toBe('done')
  expect(a.term.text).not.toContain('\x1b[2J')
  expect(a.term.text.length).toBeLessThan(OUT_LIMIT * 2 + 600)
})

// Every escape sequence in `text` that is not an SGR (colour) sequence.
const nonSgr = (text: string) => (text.match(/\x1b(?!\[[0-9;:]*m)|[\x00-\x07\x0b\x0c\x0e-\x1a\x1c-\x1f\x7f-\x9f]/g) ?? [])

test('a forged remote run cannot send the terminal anything but text and colours', async () => {
  const { a, b } = pair()
  const run = new Y.Map<unknown>()
  const outArr = new Y.Array<unknown>()
  run.set('id', 'abcdefgh')
  run.set('runner', b.doc.clientID)
  run.set('name', 'Bartek')
  run.set('phase', 'running')
  run.set('out', outArr)
  run.set('in', new Y.Array())
  outArr.push(['\x1b[2147483647Tfrozen?', '\x9b2147483647b', '\x1b]52;c;eA==\x07', '\x1b[31mred\x1b[0m\n'])
  b.doc.getMap('session').set('run', run)
  expect(nonSgr(a.term.text)).toEqual([])
  expect(a.term.text).toContain('frozen?\x1b[31mred\x1b[0m\n')
  // a sequence split across elements, also across two updates
  outArr.push(['a\x1b[21474', '83647'])
  outArr.push(['Tb\x1b[3', '2mc'])
  expect(nonSgr(a.term.text)).toEqual([])
  expect(a.term.text.endsWith('ab\x1b[32mc')).toBe(true)
})

test("a program's control sequences never enter the shared document, and both terminals show the same", async () => {
  const { a, b } = pair()
  a.cpp.result = { ok: true, wasm: new Uint8Array(1), diagnostics: '\x1b[1mmain.cpp:1:1: \x1b[0;1;35mwarning: \x1b[0mx\x1b[2J\n' }
  const prog = await running(a)
  prog.io.onOutput('one\x1b[2147483647Ttwo\x1b[', noop)
  flush()
  prog.io.onOutput('5Athree\x1b[32m!\x1b[0m\n', noop)
  flush()
  const want = '\x1b[1mmain.cpp:1:1: \x1b[0;1;35mwarning: \x1b[0mx\nonetwothree\x1b[32m!\x1b[0m\n'
  expect(out(a).join('')).toBe(want)
  expect(a.term.text.endsWith(want)).toBe(true)
  expect(b.term.text).toBe(a.term.text)
})

test('output that is dropped whole is still acknowledged, so the program goes on', async () => {
  const { a } = pair()
  const prog = await running(a)
  let acked = 0
  prog.io.onOutput('\x1b[2J', () => acked++)
  flush()
  expect(acked).toBe(1)
  expect(out(a)).toEqual([])
})

test('the echo of a forged input line is filtered; the program still gets the line as sent', async () => {
  const { a, b } = pair()
  const prog = await running(a)
  const line = 'x\x1b[2147483647Ty\n'
  ;(runMap(b).get('in') as Y.Array<unknown>).push([{ t: 'line', d: line }])
  expect(prog.written).toEqual([line])
  expect(out(a).join('')).toBe('xy\n')
  expect(nonSgr(a.term.text + b.term.text)).toEqual([])
})

test('a sequence the program left unfinished does not swallow the start of the echoed line, and still ends in its own output', async () => {
  const { a, b } = pair()
  const prog = await running(a)
  prog.io.onOutput('Wiek? \x1b[', noop)
  flush()
  b.term.type('31 lat\r')
  expect(prog.written).toEqual(['31 lat\n'])
  expect(out(a).join('')).toBe('Wiek? 31 lat\n')
  prog.io.onOutput('32mok\n', noop)
  flush()
  expect(out(a).join('')).toBe('Wiek? 31 lat\n\x1b[32mok\n')
  expect(a.term.text.endsWith('Wiek? 31 lat\n\x1b[32mok\n')).toBe(true)
  expect(b.term.text.endsWith('31 lat\n\x1b[32mok\n')).toBe(true)
})

test('the status lines reset the colours a program left behind', async () => {
  const { a, b } = pair()
  const prog = await running(a)
  prog.io.onOutput('\x1b[8mhidden', noop) // conceal
  prog.exit('code:0')
  await settle()
  for (const p of [a, b]) expect(p.term.text.endsWith(`hidden\n\x1b[0;90m${exitLine('code:0')}\x1b[0m\n`)).toBe(true)
})

test('an input line that arrives together with foreign content in the code leaves the runner its identity', async () => {
  const { a, b } = pair()
  guardText(a.doc.getText('code'), noop)
  const prog = await running(a)
  const id = a.doc.clientID
  b.doc.transact(() => {
    b.doc.getText('code').insertEmbed(0, { evil: true })
    ;(runMap(b).get('in') as Y.Array<unknown>).push([{ t: 'line', d: 'x\n' }])
  })
  expect(prog.written).toEqual(['x\n'])
  expect(a.doc.clientID).toBe(id)
  expect(a.session.view()).toMatchObject({ phase: 'running', mine: true })
  expect(b.session.view().phase).toBe('running') // not runner-left: the runner is still who the run says it is
})

test('malformed input events are ignored by the runner', async () => {
  const { a, b } = pair()
  const prog = await running(a)
  const input = runMap(b).get('in') as Y.Array<unknown>
  input.push([5, null, 'line', { t: 'line', d: 7 }, { t: 'line' }, { t: 'line', d: 'x'.repeat(LINE_MAX + 1) }, { t: 'bogus' }, [1]])
  expect(prog.written).toEqual([])
  expect(prog.eofs).toBe(0)
  expect(prog.killed).toBe(false)
  input.push([{ t: 'line', d: 'fine\n' }])
  expect(prog.written).toEqual(['fine\n'])
})

test('a run map that a peer marks done or deletes stops the local program', async () => {
  const { a, b } = pair()
  const p1 = await running(a)
  b.doc.getMap('session').delete('run')
  expect(p1.killed).toBe(true)
  await settle()
  expect(a.session.view().phase).toBe('idle')
  const p2 = await running(a)
  b.doc.transact(() => {
    runMap(b).set('phase', 'done')
    runMap(b).set('exit', 'code:0')
  })
  expect(p2.killed).toBe(true)
})

// ---- document growth ----

test('200 runs of 64 flushes of 4 kB leave less than 512 bytes per run in the document', async () => {
  const a = peer('Ala')
  const chunk = 'x'.repeat(3999) + '\n'
  const oneRun = async () => {
    const prog = await running(a)
    for (let i = 0; i < 64; i++) {
      prog.io.onOutput(chunk, noop)
      flush()
    }
    prog.exit('code:0')
    await settle()
    expect(a.session.view().phase).toBe('done')
  }
  await oneRun()
  const base = Y.encodeStateAsUpdate(a.doc).length
  for (let i = 0; i < 200; i++) await oneRun()
  expect((Y.encodeStateAsUpdate(a.doc).length - base) / 200).toBeLessThan(512)
})
