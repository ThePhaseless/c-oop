// Shared by the compiler worker (browser) and scripts/toolchain.ts (bun). No runtime imports.
// Every constant here is part of the toolchain id: changing one means a new dist/toolchain/<id>/.
import type { Tree } from '@yowasp/clang'

export const YOWASP_VERSION = '22.0.0-git20695-13'
export const SYSROOT_URL = 'https://github.com/WebAssembly/wasi-sdk/releases/download/wasi-sdk-33/wasi-sysroot-33.0%2Bm.tar.gz'
export const SYSROOT_SHA256 = '063bc1b56582b9923e08ac9b89e58789618d851763f01530b3ff20b9e5df0ca3'

// The part of the wasi sysroot that is packed into eh-sysroot.bin: wasip1 headers and the
// exceptions-enabled libc++/libc++abi/libunwind. Paths are relative to the sysroot root.
export const SYSROOT_SUBSET = {
  include: ['include/wasm32-wasip1/**/*', 'lib/wasm32-wasip1/*.{a,o}', 'lib/wasm32-wasip1/eh/*.a'],
  skip: ['/noeh/', '/llvm-lto/'],
} as const

const EH = '/eh/include/wasm32-wasip1/eh'
// A .pch is only valid for the exact clang build and exactly these language and codegen flags.
const CODEGEN = ['-std=c++20', '-Wall', '-O1']
const EH_FLAGS = ['--sysroot=/eh', '-nostdinc++', '-isystem', `${EH}/c++/v1`, '-isystem', EH,
  '-fwasm-exceptions', '-mllvm', '-wasm-use-legacy-eh=false', '-L/eh/lib/wasm32-wasip1/eh', '-lunwind']

export const COMPILE_ARGS: readonly string[] = ['clang++', ...CODEGEN, '-fcolor-diagnostics', ...EH_FLAGS,
  '-include-pch', 'prelude.pch', '-include', 'unbuf.h', 'main.cpp', '-o', 'a.wasm']
export const PCH_ARGS: readonly string[] = ['clang++', ...CODEGEN, ...EH_FLAGS.filter(f => !/^-[Ll]/.test(f)), // no link step
  '-x', 'c++-header', 'prelude.h', '-o', 'prelude.pch']

// Precompiled into prelude.pch: parsing these headers is most of the compile time.
export const PRELUDE = ['iostream', 'string', 'vector', 'memory', 'stdexcept', 'map', 'algorithm', 'sstream', 'iomanip',
  'cmath', 'functional', 'utility', 'array', 'set', 'unordered_map'].map(h => `#include <${h}>\n`).join('')
// Force-included into every program: unbuffered stdout, so a C-stdio prompt without a newline
// is on screen before the read blocks.
export const UNBUF = '#include <stdio.h>\n__attribute__((constructor)) static void __unbuffered_stdout(void) { setvbuf(stdout, 0, _IONBF, 0); }\n'

export type SysrootIndex = [path: string, offset: number, length: number][]

// eh-sysroot.json + eh-sysroot.bin -> the nested tree @yowasp/clang takes as its file system (under the key `eh`).
export function buildTree(index: SysrootIndex, bin: Uint8Array): Tree {
  const tree: Tree = {}
  for (const [path, off, len] of index) {
    const parts = path.split('/')
    const name = parts.pop()!
    let dir = tree
    for (const p of parts) dir = (dir[p] ??= {}) as Tree
    dir[name] = bin.subarray(off, off + len)
  }
  return tree
}

// The files COMPILE_ARGS refers to; used by the compiler worker and by the build self-check.
export function compileFiles(source: string, eh: Tree, pch: Uint8Array): Tree {
  return { 'main.cpp': source, 'unbuf.h': UNBUF, 'prelude.h': PRELUDE, 'prelude.pch': pch, eh }
}
