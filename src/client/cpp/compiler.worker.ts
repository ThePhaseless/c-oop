// Persistent compiler worker: clang++ (wasm) turns main.cpp into a wasm32-wasip1 module. Never runs user code.
// In: { type: 'init', base } once, then { type: 'compile', id, source }.
// Out: { type: 'progress', fraction }, { type: 'ready' }, { type: 'compiled', id, ok, wasm?, diagnostics },
//      { type: 'failed', message } (the page then discards this worker).
import type { Command, Tree } from '@yowasp/clang'
import { buildTree, COMPILE_ARGS, compileFiles } from '../../shared/toolchain.ts'
import { installCacheFetch } from './cache-fetch.ts'

type In = { type: 'init'; base: string } | { type: 'compile'; id: number; source: string }
// bun check has no worker lib: a local type for the two things used from `self`.
const scope = self as unknown as { postMessage(message: unknown): void; onmessage: ((e: { data: In }) => void) | null }

let compile: ((source: string) => Promise<object>) | undefined
let queue: Promise<void> = Promise.resolve() // one clang run at a time

const failed = (e: unknown) => scope.postMessage({ type: 'failed', message: String((e as Error)?.message ?? e).slice(0, 200) })

async function boot(base: string): Promise<void> {
  let bytes = 0, total = Infinity, percent = 0
  // The wrapper goes in before the bundle import, which captures fetch.
  installCacheFetch(base, n => {
    bytes += n
    const p = Math.min(100, Math.floor((100 * bytes) / total))
    if (p !== percent) scope.postMessage({ type: 'progress', fraction: (percent = p) / 100 })
  })
  const get = async (name: string) => {
    const res = await fetch(new URL(name, base).href)
    if (!res.ok) throw new Error(`${name}: HTTP ${res.status}`)
    return res
  }
  const manifest = (await (await get('manifest.json')).json()) as { total: number }
  bytes = 0
  total = manifest.total
  const { runClang, Exit } = (await import(new URL('bundle.js', base).href)) as { runClang: Command; Exit: new () => Error }
  const quiet = { stdout() {}, stderr() {}, fetchProgress() {} }
  const [index, bin, pch] = await Promise.all([
    get('eh-sysroot.json').then(r => r.json()),
    get('eh-sysroot.bin').then(async r => new Uint8Array(await r.arrayBuffer())),
    get('prelude.pch').then(async r => new Uint8Array(await r.arrayBuffer())),
    runClang(['clang++', '--version'], {}, quiet), // the cheapest call that makes yowasp fetch and compile its wasm
  ])
  const eh = buildTree(index, bin)

  compile = async source => {
    let diagnostics = ''
    const decoder = new TextDecoder()
    const collect = (b: Uint8Array | null) => { if (b) diagnostics += decoder.decode(b, { stream: true }) }
    let tree: Tree = {}
    try {
      tree = (await runClang([...COMPILE_ARGS], compileFiles(source, eh, pch), { stdout: collect, stderr: collect })) as Tree
    } catch (e) {
      if (!(e instanceof Exit)) throw e // only a clang exit status is a compile error; anything else is a crash
    }
    const wasm = tree['a.wasm']
    return wasm instanceof Uint8Array ? { ok: true, wasm, diagnostics } : { ok: false, diagnostics }
  }
}

scope.onmessage = ({ data }) => {
  queue = queue
    .then(async () => {
      if (data.type === 'init') {
        await boot(data.base)
        scope.postMessage({ type: 'ready' })
      } else {
        if (!compile) throw new Error('compiler is not loaded')
        scope.postMessage({ type: 'compiled', id: data.id, ...(await compile(data.source)) })
      }
    })
    .catch(failed)
}
