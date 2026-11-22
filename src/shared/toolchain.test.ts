import { expect, test } from 'bun:test'
import { mkdtemp, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { fetchSysroot, toolchainId } from '../../scripts/toolchain.ts'
import { buildTree, COMPILE_ARGS, compileFiles, PCH_ARGS, PRELUDE, UNBUF } from './toolchain.ts'

test('buildTree nests by "/" and slices the blob', () => {
  const bin = new Uint8Array([1, 2, 3, 4, 5, 6])
  const tree = buildTree([['include/a/x.h', 0, 2], ['include/a/y.h', 2, 1], ['lib/z.a', 3, 3]], bin)
  expect(tree).toEqual({
    include: { a: { 'x.h': new Uint8Array([1, 2]), 'y.h': new Uint8Array([3]) } },
    lib: { 'z.a': new Uint8Array([4, 5, 6]) },
  })
})

test('COMPILE_ARGS is the expected command line', () => {
  expect(COMPILE_ARGS.join(' ')).toBe(
    'clang++ -std=c++20 -Wall -O1 -fcolor-diagnostics --sysroot=/eh -nostdinc++ -isystem /eh/include/wasm32-wasip1/eh/c++/v1 -isystem /eh/include/wasm32-wasip1/eh -fwasm-exceptions -mllvm -wasm-use-legacy-eh=false -L/eh/lib/wasm32-wasip1/eh -lunwind -include-pch prelude.pch -include unbuf.h main.cpp -o a.wasm',
  )
})

test('PCH_ARGS has the same codegen flags, no colour and no link flags', () => {
  expect(PCH_ARGS.join(' ')).toBe(
    'clang++ -std=c++20 -Wall -O1 --sysroot=/eh -nostdinc++ -isystem /eh/include/wasm32-wasip1/eh/c++/v1 -isystem /eh/include/wasm32-wasip1/eh -fwasm-exceptions -mllvm -wasm-use-legacy-eh=false -x c++-header prelude.h -o prelude.pch',
  )
})

test('prelude and unbuf', () => {
  expect(PRELUDE.split('\n').filter(Boolean)).toHaveLength(15)
  expect(PRELUDE).toContain('#include <unordered_map>\n')
  expect(UNBUF).toContain('setvbuf(stdout, 0, _IONBF, 0)')
})

test('compileFiles holds exactly what COMPILE_ARGS names', () => {
  const eh = {}, pch = new Uint8Array(1)
  expect(compileFiles('int main(){}', eh, pch)).toEqual({ 'main.cpp': 'int main(){}', 'unbuf.h': UNBUF, 'prelude.h': PRELUDE, 'prelude.pch': pch, eh })
})

test('toolchain id is stable and changes with a flag', () => {
  expect(toolchainId()).toMatch(/^[0-9a-f]{12}$/)
  expect(toolchainId()).toBe(toolchainId([...COMPILE_ARGS]))
  expect(toolchainId(COMPILE_ARGS.map(a => (a === '-O1' ? '-O2' : a)))).not.toBe(toolchainId())
})

test('sysroot download: a checksum mismatch stops and leaves no file, a match leaves the final file', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'c-oop-dl-'))
  try {
    const src = join(dir, 'src.bin')
    await Bun.write(src, 'hello')
    const url = pathToFileURL(src).href
    const dl = join(dir, 'dl')
    await expect(fetchSysroot(dl, url, '0'.repeat(64))).rejects.toThrow(/checksum/)
    expect(await readdir(dl)).toEqual([])
    const sha = new Bun.CryptoHasher('sha256').update('hello').digest('hex')
    const path = await fetchSysroot(dl, url, sha)
    expect(await Bun.file(path).text()).toBe('hello')
    expect(await readdir(dl)).toHaveLength(1)
    // an existing final file is verified again: with another expected hash it is removed
    await expect(fetchSysroot(dl, url, '1'.repeat(64))).rejects.toThrow(/checksum/)
    expect(await readdir(dl)).toEqual([])
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})
