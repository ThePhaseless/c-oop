// Real workers and the real toolchain from dist, under Bun. Not covered here: the Cache Storage wrapper and
// byte progress (a Bun worker has no `caches`) and killing a busy wasm loop (under Bun terminate() does not
// stop one); the browser suite covers those.
import { afterAll, beforeAll, expect, test } from 'bun:test'
import { existsSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { toolchainId } from '../../../scripts/toolchain.ts'
import type { Cpp, Exit, RunHandle } from '../../shared/contracts.ts'
import { createCpp } from './cpp.ts'

const compilerUrl = new URL('./compiler.worker.ts', import.meta.url)
const runnerUrl = new URL('./runner.worker.ts', import.meta.url)
const dir = resolve('dist/toolchain', toolchainId())
const make = (toolchainBase = pathToFileURL(dir + '/').href) => createCpp({ toolchainBase, compilerUrl, runnerUrl })

const HELLO = '#include <iostream>\nint main() { std::cout << "hello\\n"; }\n'
const ECHO = `#include <iostream>
#include <string>
int main() {
  std::string a, b, rest;
  std::cout << "name? ";
  std::getline(std::cin, a);
  std::cout << "hi " << a << "\\nage? ";
  std::getline(std::cin, b);
  std::cout << "age " << b << "\\n";
  while (std::getline(std::cin, rest)) std::cout << "more " << rest << "\\n";
  std::cout << "eof\\n";
  return 3;
}
`

let cpp: Cpp
const progress: number[] = []

// Runs a program and records what the RunIo sees, in order. Acks at once unless `hold` is set.
function start(wasm: Uint8Array, hold = false) {
  const events: string[] = []
  const acks: (() => void)[] = []
  let wake = () => {}
  const handle: RunHandle = cpp.run(wasm, {
    onOutput(text, ack) { events.push('out:' + text); if (hold) acks.push(ack); else ack(); wake() },
    onStdinWait(waiting) { events.push('wait:' + waiting); wake() },
  })
  // Event-driven wait: resolves on the event that makes `check` true, rejects when the program ends first.
  const until = (check: () => boolean) => new Promise<void>((res, rej) => {
    const step = () => { if (check()) res() }
    wake = step
    step()
    void handle.done.then(exit => { step(); rej(new Error(`program ended (${exit}) first; events: ${JSON.stringify(events)}`)) })
  })
  const output = () => events.filter(e => e.startsWith('out:')).map(e => e.slice(4)).join('')
  return { handle, events, acks, until, output }
}
async function build(source: string): Promise<Uint8Array> {
  const r = await cpp.compile(source)
  if (!r.ok || !r.wasm) throw new Error('compile failed: ' + r.diagnostics)
  return r.wasm
}

beforeAll(async () => {
  if (!existsSync(join(dir, 'manifest.json'))) throw new Error(`${dir}/manifest.json is missing: run \`bun run build\` (or \`bun scripts/toolchain.ts\`) first`)
  cpp = make()
  await cpp.load(p => progress.push(p))
})

afterAll(() => cpp?.cancel()) // do not leave the compiler worker running for the other test files

test('load() ends with onProgress(1) and is idempotent', async () => {
  expect(progress.at(-1)).toBe(1)
  const again: number[] = []
  await cpp.load(p => again.push(p))
  expect(again).toEqual([1])
})

test('hello world exits code:0', async () => {
  const run = start(await build(HELLO))
  expect(await run.handle.done).toBe('code:0' satisfies Exit)
  expect(run.output()).toBe('hello\n')
})

test('a compile error resolves ok: false with diagnostics, and the same worker compiles again', async () => {
  const bad = await cpp.compile('int main() { return nope; }\n')
  expect(bad.ok).toBe(false)
  expect(bad.wasm).toBeUndefined()
  expect(bad.diagnostics).toContain('error:')
  expect(bad.diagnostics).toContain('main.cpp:1:')
  expect((await cpp.compile(HELLO)).ok).toBe(true)
})

test('warnings come back with ok: true', async () => {
  const r = await cpp.compile('int main() { int unused = 1; return 0; }\n')
  expect(r.ok).toBe(true)
  expect(r.wasm).toBeInstanceOf(Uint8Array)
  expect(r.diagnostics).toContain('warning:')
})

test('a prompt without newline arrives before the stdin wait; two reads, then eof()', async () => {
  const run = start(await build(ECHO))
  await run.until(() => run.events.includes('wait:true'))
  expect(run.events).toEqual(['out:name? ', 'wait:true'])
  run.handle.write('Ala\n')
  await run.until(() => run.events.filter(e => e === 'wait:true').length === 2)
  expect(run.output()).toBe('name? hi Ala\nage? ')
  run.handle.write('7\n')
  run.handle.write('zażółć\n')
  run.handle.eof()
  expect(await run.handle.done).toBe('code:3')
  expect(run.output()).toBe('name? hi Ala\nage? age 7\nmore zażółć\neof\n')
  expect(run.events.at(-1)).not.toBe('wait:true')
})

test('C stdio prompt is unbuffered', async () => {
  const run = start(await build('#include <stdio.h>\nint main() { char b[8]; printf("n: "); if (fgets(b, 8, stdin)) printf("got %s", b); }\n'))
  await run.until(() => run.events.includes('wait:true'))
  expect(run.output()).toBe('n: ')
  run.handle.write('x\n')
  expect(await run.handle.done).toBe('code:0')
  expect(run.output()).toBe('n: got x\n')
})

test('kill() while blocked on stdin gives killed', async () => {
  const run = start(await build(ECHO))
  await run.until(() => run.events.includes('wait:true'))
  run.handle.kill()
  expect(await run.handle.done).toBe('killed')
  run.handle.write('late\n') // no effect after the end
  run.handle.kill()
})

test('an uncaught exception gives crash:uncaught C++ exception, a caught one does not', async () => {
  const thrower = (caught: boolean) => `#include <iostream>\n#include <stdexcept>
int main() {
  ${caught ? 'try { throw std::runtime_error("boom"); } catch (const std::exception& e) { std::cout << "caught " << e.what() << "\\n"; }' : 'std::cout << "before\\n"; throw std::runtime_error("boom");'}
}\n`
  const ok = start(await build(thrower(true)))
  expect(await ok.handle.done).toBe('code:0')
  expect(ok.output()).toBe('caught boom\n')
  const bad = start(await build(thrower(false)))
  expect(await bad.handle.done).toBe('crash:uncaught C++ exception')
  expect(bad.output()).toBe('before\n')
})

test('bytes that are not a C++-exceptions-capable module', async () => {
  const garbage = start(new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0, 255, 255]))
  expect(await garbage.handle.done).toBe('no-wasm-eh')
})

test('output is paced by acks: the program stops at the window and finishes once acked', async () => {
  // 300 writes of 1 kB: the 64 kB window must stop the program well before the end.
  const run = start(await build('#include <stdio.h>\n#include <string.h>\nint main() { char b[1000]; memset(b, 120, 1000); for (int i = 0; i < 300; i++) fwrite(b, 1, 1000, stdout); }\n'), true)
  let ended = false
  void run.handle.done.then(() => { ended = true })
  await run.until(() => run.acks.length >= 60)
  await Bun.sleep(300) // nothing to wait for: this asserts that no further output arrives without acks
  expect(ended).toBe(false)
  const stalledAt = run.acks.length
  expect(stalledAt).toBeGreaterThanOrEqual(64)
  expect(stalledAt).toBeLessThan(80)
  const flush = setInterval(() => { for (const ack of run.acks.splice(0)) ack() }, 5)
  expect(await run.handle.done).toBe('code:0')
  clearInterval(flush)
  expect(run.output().length).toBe(300_000)
})

test('cancel() during a compile resolves ok: false; a later load() and compile succeed', async () => {
  const pending = cpp.compile(HELLO)
  cpp.cancel()
  expect(await pending).toEqual({ ok: false, diagnostics: '' })
  await expect(cpp.compile(HELLO)).rejects.toThrow()
  const seen: number[] = []
  await cpp.load(p => seen.push(p))
  expect(seen.at(-1)).toBe(1)
  expect((await cpp.compile(HELLO)).ok).toBe(true)
})

test('cancel() right after load() on a new Cpp rejects that load; a second load() resolves', async () => {
  const other = make()
  const first = other.load(() => {})
  other.cancel()
  await expect(first).rejects.toThrow('cancelled')
  await other.load(() => {})
  expect((await other.compile(HELLO)).ok).toBe(true)
  other.cancel()
})

test('a toolchainBase with no files rejects load() and does not hang', async () => {
  const empty = await mkdtemp(join(tmpdir(), 'c-oop-empty-'))
  try {
    const broken = make(pathToFileURL(empty + '/').href)
    const load = broken.load(() => {})
    const compile = broken.compile(HELLO) // pending while the worker fails: rejected too, not left hanging
    // allSettled, not two expect().rejects: bun attaches the second one too late and reports an unhandled rejection
    expect((await Promise.allSettled([load, compile])).map(r => r.status)).toEqual(['rejected', 'rejected'])
    await expect(broken.compile(HELLO)).rejects.toThrow('not loaded')
  } finally {
    await rm(empty, { recursive: true, force: true })
  }
})
