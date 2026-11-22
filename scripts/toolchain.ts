// Builds dist/toolchain/<id>/: the yowasp clang files, the packed exceptions sysroot,
// the precompiled prelude, a manifest and a .br beside every file.
// Usage: bun scripts/toolchain.ts [distDir]. Imports only npm packages, built-ins and src/shared/toolchain.ts.
import { $, Glob } from 'bun'
import { existsSync } from 'node:fs'
import { copyFile, mkdir, readdir, rename, rm } from 'node:fs/promises'
import { basename, join, resolve } from 'node:path'
import { promisify } from 'node:util'
import { brotliCompress, constants as zlib } from 'node:zlib'
import type { Command } from '@yowasp/clang'
import {
  buildTree, COMPILE_ARGS, compileFiles, PCH_ARGS, PRELUDE, SYSROOT_SHA256, SYSROOT_SUBSET, SYSROOT_URL, UNBUF,
  YOWASP_VERSION, type SysrootIndex,
} from '../src/shared/toolchain.ts'

const YOWASP_FILES = ['bundle.js', 'llvm.core.wasm', 'llvm.core2.wasm', 'llvm.core3.wasm', 'llvm.core4.wasm', 'llvm-resources.tar']
// Brotli quality 11 for every file, no drop to 9 for the big ones: measured twice on 4 cores, the step takes about
// 195 s wall (410 s CPU), bounded by llvm.core.wasm, under the 6 minute budget. On 1 or 2 cores it would pass it.
const BROTLI_QUALITY = 11
const SELF_CHECK = `#include <iostream>
#include <stdexcept>
#include <string>
int main() {
  std::string line;
  std::getline(std::cin, line);
  try { throw std::runtime_error(line); }
  catch (const std::runtime_error& e) { std::cout << e.what() << "\\n"; }
}
`

// Computable without building. The parameter exists for the id test; callers pass nothing.
export function toolchainId(compileArgs: readonly string[] = COMPILE_ARGS): string {
  const parts = [YOWASP_VERSION, SYSROOT_SHA256, JSON.stringify(compileArgs), JSON.stringify(PCH_ARGS), PRELUDE, UNBUF, JSON.stringify(SYSROOT_SUBSET)]
  return new Bun.CryptoHasher('sha256').update(parts.join('\0')).digest('hex').slice(0, 12)
}

async function sha256(path: string): Promise<string> {
  const hash = new Bun.CryptoHasher('sha256')
  for await (const chunk of Bun.file(path).stream()) hash.update(chunk)
  return hash.digest('hex')
}

// Returns the verified tarball in `dir`, downloading it when missing. A file that fails the checksum
// (downloaded now or found there) is deleted and the build stops.
export async function fetchSysroot(dir: string, url = SYSROOT_URL, sha = SYSROOT_SHA256): Promise<string> {
  await mkdir(dir, { recursive: true })
  const final = join(dir, decodeURIComponent(basename(new URL(url).pathname)))
  const file = existsSync(final) ? final : `${final}.${process.pid}.part`
  try {
    if (file !== final) {
      const res = await fetch(url)
      if (!res.ok) throw new Error(`sysroot download failed: HTTP ${res.status} for ${url}`)
      await Bun.write(file, res)
    }
    const got = await sha256(file)
    if (got !== sha) throw new Error(`sysroot checksum mismatch for ${file}: expected ${sha}, got ${got}`)
  } catch (e) {
    await rm(file, { force: true })
    throw e
  }
  if (file !== final) await rename(file, final)
  return final
}

// Extracts the tarball and packs the SYSROOT_SUBSET files into one blob plus an index, sorted by path.
async function packSysroot(tarball: string, tmp: string): Promise<{ index: SysrootIndex; bin: Uint8Array }> {
  await mkdir(tmp, { recursive: true })
  try {
    await new Bun.Archive(await Bun.file(tarball).bytes()).extract(tmp, { glob: ['*/include/wasm32-wasip1/**', '*/lib/wasm32-wasip1/**'] })
  } catch (e) {
    console.log(`Bun.Archive failed (${e}), using tar`)
    await $`tar -xzf ${tarball} -C ${tmp}`.quiet()
  }
  const root = join(tmp, (await readdir(tmp))[0]!) // the tarball has one top-level directory
  const paths = new Set<string>()
  for (const pattern of SYSROOT_SUBSET.include)
    for await (const p of new Glob(pattern).scan({ cwd: root, onlyFiles: true }))
      if (!SYSROOT_SUBSET.skip.some(s => p.includes(s))) paths.add(p)
  const index: SysrootIndex = []
  let offset = 0
  for (const p of [...paths].sort()) {
    const length = Bun.file(join(root, p)).size
    index.push([p, offset, length])
    offset += length
  }
  if (!index.length) throw new Error('sysroot subset is empty')
  const bin = new Uint8Array(offset)
  for (const [p, at] of index) bin.set(await Bun.file(join(root, p)).bytes(), at)
  return { index, bin }
}

// Returns the toolchain id. Does nothing when dist/toolchain/<id>/manifest.json exists.
export async function buildToolchain(distDir: string): Promise<string> {
  const id = toolchainId()
  const final = resolve(distDir, 'toolchain', id)
  if (existsSync(join(final, 'manifest.json'))) return id

  const t0 = performance.now()
  let last = t0
  const step = (what: string) => {
    const now = performance.now()
    console.log(`toolchain ${id}: ${what} (${((now - last) / 1000).toFixed(1)} s)`)
    last = now
  }
  const { runClang, version } = (await import('@yowasp/clang')) as unknown as { runClang: Command; version: string }
  if (version !== YOWASP_VERSION) throw new Error(`@yowasp/clang is ${version}, YOWASP_VERSION says ${YOWASP_VERSION}`)

  const cache = resolve('.cache/dl')
  const extracted = join(cache, `sysroot.${process.pid}.tmp`)
  // Built beside the target and renamed last, so a failed build leaves nothing that looks complete.
  const out = resolve(distDir, 'toolchain', `.${id}.${process.pid}.tmp`)
  try {
    const tarball = await fetchSysroot(cache)
    step('sysroot tarball verified')
    const { index, bin } = await packSysroot(tarball, extracted)
    await rm(extracted, { recursive: true, force: true })
    await mkdir(out, { recursive: true })
    await Bun.write(join(out, 'eh-sysroot.bin'), bin)
    await Bun.write(join(out, 'eh-sysroot.json'), JSON.stringify(index))
    step(`packed ${index.length} sysroot files, ${bin.length} bytes`)

    const eh = buildTree(index, bin)
    const quiet = { fetchProgress() {} }
    // Loads the clang wasm here: only this path honours fetchProgress (a compile would print yowasp's own progress lines).
    await runClang(['clang++', '--version'], {}, { ...quiet, stdout() {}, stderr() {} })
    const pch = ((await runClang([...PCH_ARGS], { 'prelude.h': PRELUDE, eh }, quiet)) as Record<string, Uint8Array>)['prelude.pch']
    if (!pch) throw new Error('clang produced no prelude.pch')
    await Bun.write(join(out, 'prelude.pch'), pch)
    step(`prelude.pch, ${pch.length} bytes`)

    // Self-check with exactly the worker's arguments and files; runClang throws on a non-zero exit.
    const built = (await runClang([...COMPILE_ARGS], compileFiles(SELF_CHECK, eh, pch), quiet)) as Record<string, Uint8Array>
    if (!built['a.wasm']) throw new Error('self-check failed: clang produced no a.wasm')
    step('self-check compiled')

    const gen = resolve('node_modules/@yowasp/clang/gen')
    for (const name of YOWASP_FILES) await copyFile(join(gen, name), join(out, name))
    const files: Record<string, number> = {}
    for (const name of [...YOWASP_FILES.slice(1), 'eh-sysroot.bin', 'eh-sysroot.json', 'prelude.pch']) files[name] = Bun.file(join(out, name)).size
    const total = Object.values(files).reduce((a, b) => a + b, 0)
    await Bun.write(join(out, 'manifest.json'), JSON.stringify({ files, total }))

    const brotli = promisify(brotliCompress)
    await Promise.all((await readdir(out)).map(async name => {
      const t = performance.now()
      const raw = await Bun.file(join(out, name)).bytes()
      const br = await brotli(raw, { params: { [zlib.BROTLI_PARAM_QUALITY]: BROTLI_QUALITY, [zlib.BROTLI_PARAM_SIZE_HINT]: raw.length } })
      await Bun.write(join(out, name + '.br'), br)
      console.log(`  ${name}: ${raw.length} -> ${br.length} bytes (${((performance.now() - t) / 1000).toFixed(1)} s)`)
    }))
    step(`brotli quality ${BROTLI_QUALITY}`)

    try {
      await rename(out, final)
    } catch (e) {
      // Another build finished first: its directory is complete, ours is dropped below.
      if (!existsSync(join(final, 'manifest.json'))) throw e
    }
  } finally {
    await rm(extracted, { recursive: true, force: true })
    await rm(out, { recursive: true, force: true })
  }
  console.log(`toolchain ${id}: done, self-check passed (${((performance.now() - t0) / 1000).toFixed(1)} s total)`)
  return id
}

if (import.meta.main) await buildToolchain(process.argv[2] ?? 'dist')
