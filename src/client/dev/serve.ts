// Serves the states page: `bun src/client/dev/serve.ts`, then open the printed URL.
// Own server because Bun's HTML dev server cannot keep the absolute /fonts/ URLs of style.css.
import { rmSync } from 'node:fs'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const here = import.meta.dir
const out = await mkdtemp(join(tmpdir(), 'c-oop-states-'))
const built = await Bun.build({
  entrypoints: [join(here, 'states.ts'), join(here, '../style.css')],
  outdir: out,
  naming: '[name].[ext]',
  target: 'browser',
  external: ['/fonts/*'],
})
process.on('exit', () => rmSync(out, { recursive: true, force: true }))
for (const signal of ['SIGINT', 'SIGTERM'] as const) process.on(signal, () => process.exit(0))
if (!built.success) throw new AggregateError(built.logs, 'states page build failed')

const fonts = join(here, '../../../node_modules/@fontsource-variable/recursive/files')
const files: Record<string, string> = {
  '/': join(here, 'states.html'),
  '/states.js': join(out, 'states.js'),
  '/style.css': join(out, 'style.css'),
  '/theme.js': join(here, '../theme.js'),
}
for (const subset of ['latin', 'latin-ext']) for (const axis of ['mono', 'casl']) {
  const name = `recursive-${subset}-${axis}-normal.woff2`
  files[`/fonts/${name}`] = join(fonts, name)
}

const server = Bun.serve({
  port: Number(process.env.PORT ?? 4173),
  fetch(req) {
    const file = files[new URL(req.url).pathname]
    return file ? new Response(Bun.file(file)) : new Response('not found', { status: 404 })
  },
})
console.log(`states page: http://localhost:${server.port}/`)
