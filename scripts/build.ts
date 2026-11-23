// `bun run build`: toolchain, bundle, static files, fonts, brotli. Ends with a check that dist is complete.
// The app files are built in a temp directory inside dist and renamed over the old ones one by one, so a
// server or test suite reading dist during a rebuild never finds a file missing.
import { existsSync } from 'node:fs'
import { copyFile, mkdir, readdir, rename, rm } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { promisify } from 'node:util'
import { brotliCompress, constants as zlib } from 'node:zlib'
import { buildToolchain } from './toolchain.ts'

const dist = resolve('dist')
const client = resolve('src/client')
const FONTS = ['latin', 'latin-ext'].flatMap(subset => ['mono'].map(axis => `recursive-${subset}-${axis}-normal.woff2`))
const COMPRESSED = ['index.html', 'main.js', 'theme.js', 'style.css', 'compiler.worker.js', 'runner.worker.js', 'favicon.svg']

const id = await buildToolchain(dist)
// The only thing a build deletes. Dot-prefixed entries belong to a toolchain build that is still running.
for (const name of await readdir(join(dist, 'toolchain'))) {
  if (name !== id && !name.startsWith('.')) await rm(join(dist, 'toolchain', name), { recursive: true, force: true })
}

const tmp = join(dist, `.build.${process.pid}.tmp`) // loadStatic skips dot segments
try {
  const built = await Bun.build({
    entrypoints: ['main.ts', 'style.css', 'cpp/compiler.worker.ts', 'cpp/runner.worker.ts'].map(f => join(client, f)),
    outdir: tmp,
    naming: '[name].[ext]',
    target: 'browser',
    minify: true,
    external: ['/fonts/*'],
    define: { __TOOLCHAIN_ID__: JSON.stringify(id) },
  })
  if (!built.success) throw new AggregateError(built.logs, 'bundle failed')

  await copyFile(join(client, 'index.html'), join(tmp, 'index.html'))
  await copyFile(join(client, 'favicon.svg'), join(tmp, 'favicon.svg'))
  await copyFile(join(client, 'theme.js'), join(tmp, 'theme.js'))
  await mkdir(join(tmp, 'fonts'))
  for (const f of FONTS) await copyFile(resolve('node_modules/@fontsource-variable/recursive/files', f), join(tmp, 'fonts', f))

  const brotli = promisify(brotliCompress)
  await Promise.all(COMPRESSED.map(async name => {
    const raw = await Bun.file(join(tmp, name)).bytes()
    await Bun.write(join(tmp, name + '.br'), await brotli(raw, { params: { [zlib.BROTLI_PARAM_QUALITY]: 11, [zlib.BROTLI_PARAM_SIZE_HINT]: raw.length } }))
  }))

  await mkdir(join(dist, 'fonts'), { recursive: true })
  const files = (await readdir(tmp, { recursive: true, withFileTypes: true })).filter(e => e.isFile()).map(e => join(e.parentPath, e.name).slice(tmp.length + 1))
  const expected = [...COMPRESSED.flatMap(n => [n, n + '.br']), ...FONTS.map(f => join('fonts', f))]
  const extra = files.filter(f => !expected.includes(f))
  if (extra.length) throw new Error(`unexpected build output: ${extra.join(', ')}`) // a new chunk or asset needs a line here
  for (const f of expected) await rename(join(tmp, f), join(dist, f))

  const missing = [...expected, join('toolchain', id, 'manifest.json')].filter(f => !existsSync(join(dist, f)))
  if (missing.length) throw new Error(`dist is incomplete: ${missing.join(', ')}`)
  console.log(`build: dist complete, toolchain ${id}, main.js ${Bun.file(join(dist, 'main.js')).size} bytes`)
} finally {
  await rm(tmp, { recursive: true, force: true })
}
