import { afterAll, beforeAll, expect, test } from 'bun:test'
import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, relative } from 'node:path'
import { brotliCompressSync, brotliDecompressSync } from 'node:zlib'
import { type Asset, loadStatic, reply, respond, SECURITY_HEADERS, serveStatic } from './static.ts'

const JS = 'console.log("main")\n'.repeat(50)
let root: string
let table: Map<string, Asset>

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), 'c-oop-static-'))
  const dist = join(root, 'dist')
  await mkdir(join(dist, 'toolchain/abc/.abc.1.tmp'), { recursive: true })
  await mkdir(join(dist, 'fonts'))
  await Bun.write(join(root, 'package.json'), '{"decoy":true}')
  await Bun.write(join(dist, 'index.html'), '<!doctype html><title>t</title>')
  await Bun.write(join(dist, 'main.js'), JS)
  await Bun.write(join(dist, 'main.js.br'), brotliCompressSync(JS))
  await Bun.write(join(dist, 'style.css'), 'body{}')
  await Bun.write(join(dist, 'theme.js'), 'try{}catch(e){}')
  await Bun.write(join(dist, 'favicon.svg'), '<svg xmlns="http://www.w3.org/2000/svg"/>')
  await Bun.write(join(dist, 'fonts/a.woff2'), 'font')
  await Bun.write(join(dist, 'toolchain/abc/llvm.core.wasm'), 'wasm-bytes')
  await Bun.write(join(dist, 'toolchain/abc/llvm.core.wasm.br'), brotliCompressSync('wasm-bytes'))
  await Bun.write(join(dist, 'toolchain/abc/manifest.json'), '{}')
  await Bun.write(join(dist, 'toolchain/abc/prelude.pch'), 'pch')
  await Bun.write(join(dist, 'toolchain/abc/.abc.1.tmp/bundle.js'), 'half-built')
  table = await loadStatic(dist)
})
afterAll(() => rm(root, { recursive: true, force: true }))

const get = (path: string, headers: Record<string, string> = {}, method = 'GET') =>
  serveStatic(table, new Request('http://x' + path, { method, headers }))
const secure = (r: Response) => {
  for (const [k, v] of Object.entries(SECURITY_HEADERS)) expect(r.headers.get(k)).toBe(v)
}

test('SECURITY_HEADERS is the full header set', () => {
  expect(SECURITY_HEADERS).toEqual({
    'Cross-Origin-Opener-Policy': 'same-origin',
    'Cross-Origin-Embedder-Policy': 'require-corp',
    'Cross-Origin-Resource-Policy': 'same-origin',
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer',
    'Permissions-Policy': 'camera=(), microphone=(), geolocation=()',
    'Content-Security-Policy':
      "default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self'; connect-src 'self' ws: wss:; worker-src 'self'; object-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
  })
})

test('the table holds exactly the servable files', () => {
  expect([...table.keys()].sort()).toEqual([
    '/favicon.svg', '/fonts/a.woff2', '/index.html', '/main.js', '/style.css', '/theme.js',
    '/toolchain/abc/llvm.core.wasm', '/toolchain/abc/manifest.json', '/toolchain/abc/prelude.pch',
  ])
})

test('a relative distDir, with ./ or a trailing slash, gives the same table', async () => {
  const rel = relative(process.cwd(), join(root, 'dist'))
  for (const dir of [rel, './' + rel, rel + '/']) expect([...(await loadStatic(dir)).keys()].sort()).toEqual([...table.keys()].sort())
})

test('loadStatic rejects a directory without index.html', async () => {
  await expect(loadStatic(join(root, 'dist/fonts'))).rejects.toThrow(/index\.html/)
})

test('/ serves index.html with no-cache, an ETag and the security headers', async () => {
  const r = get('/')
  expect(r.status).toBe(200)
  secure(r)
  expect(r.headers.get('Content-Type')).toBe('text/html; charset=utf-8')
  expect(r.headers.get('Cache-Control')).toBe('no-cache')
  expect(r.headers.get('ETag')).toMatch(/^"[0-9a-z]+"$/)
  expect(r.headers.get('Vary')).toBeNull()
  expect(await r.text()).toBe('<!doctype html><title>t</title>')
})

test('content types by extension', () => {
  const types: Record<string, string> = {
    '/main.js': 'text/javascript; charset=utf-8', '/style.css': 'text/css; charset=utf-8', '/favicon.svg': 'image/svg+xml',
    '/fonts/a.woff2': 'font/woff2', '/toolchain/abc/llvm.core.wasm': 'application/wasm',
    '/toolchain/abc/manifest.json': 'application/json', '/toolchain/abc/prelude.pch': 'application/octet-stream',
  }
  for (const [path, type] of Object.entries(types)) expect(get(path).headers.get('Content-Type')).toBe(type)
})

test('theme.js, the script index.html loads ahead of the stylesheet, is served like the other app files', () => {
  const r = get('/theme.js')
  expect(r.status).toBe(200)
  expect(r.headers.get('Content-Type')).toBe('text/javascript; charset=utf-8')
  expect(r.headers.get('Cache-Control')).toBe('no-cache')
  expect(r.headers.get('ETag')).toMatch(/^"[0-9a-z]+"$/)
  secure(r)
})

test('ETag round trip gives 304 with headers and no body', async () => {
  const etag = get('/style.css').headers.get('ETag')!
  for (const inm of [etag, 'W/' + etag, `"zzz", ${etag}`, '*']) {
    const r = get('/style.css', { 'If-None-Match': inm })
    expect(r.status).toBe(304)
    secure(r)
    expect(r.headers.get('ETag')).toBe(etag)
    expect(r.headers.get('Cache-Control')).toBe('no-cache')
    expect(await r.text()).toBe('')
  }
  expect(get('/style.css', { 'If-None-Match': '"zzz"' }).status).toBe(200)
})

test('brotli is chosen only when Accept-Encoding has br', async () => {
  const raw = get('/main.js')
  expect(raw.headers.get('Content-Encoding')).toBeNull()
  expect(raw.headers.get('Vary')).toBe('Accept-Encoding')
  expect(await raw.text()).toBe(JS)
  for (const ae of ['gzip', 'gzip, br;q=0', 'brotli', 'identity']) expect(get('/main.js', { 'Accept-Encoding': ae }).headers.get('Content-Encoding')).toBeNull()

  for (const ae of ['br', 'gzip, deflate, br, zstd', 'gzip;q=1, BR;q=0.5']) {
    const br = get('/main.js', { 'Accept-Encoding': ae })
    expect(br.headers.get('Content-Encoding')).toBe('br')
    expect(br.headers.get('Vary')).toBe('Accept-Encoding')
    expect(br.headers.get('Content-Type')).toBe('text/javascript; charset=utf-8')
    expect(br.headers.get('ETag')).toBe(raw.headers.get('ETag')!.replace(/"$/, '-br"'))
    expect(brotliDecompressSync(await br.bytes()).toString()).toBe(JS)
  }
  // a file without a .br is served raw whatever the client accepts
  expect(get('/style.css', { 'Accept-Encoding': 'br' }).headers.get('Content-Encoding')).toBeNull()
})

test('each variant revalidates only against its own ETag', () => {
  const rawTag = get('/main.js').headers.get('ETag')!
  const brTag = get('/main.js', { 'Accept-Encoding': 'br' }).headers.get('ETag')!
  expect(get('/main.js', { 'If-None-Match': rawTag }).status).toBe(304)
  const r = get('/main.js', { 'If-None-Match': brTag, 'Accept-Encoding': 'br' })
  expect(r.status).toBe(304)
  expect(r.headers.get('Vary')).toBe('Accept-Encoding')
  expect(get('/main.js', { 'If-None-Match': brTag }).status).toBe(200)
  expect(get('/main.js', { 'If-None-Match': rawTag, 'Accept-Encoding': 'br' }).status).toBe(200)
})

test('HEAD returns the GET headers and an empty body, and 304 on a match', async () => {
  for (const [path, headers] of [['/', {}], ['/main.js', {}], ['/main.js', { 'Accept-Encoding': 'br' }], ['/toolchain/abc/llvm.core.wasm', { 'Accept-Encoding': 'br' }]] as const) {
    const g = get(path, headers)
    const h = get(path, headers, 'HEAD')
    const body = await g.bytes()
    expect(h.status).toBe(200)
    expect(await h.text()).toBe('')
    expect(h.headers.get('Content-Length')).toBe(String(body.length))
    for (const k of ['Content-Type', 'ETag', 'Content-Encoding', 'Cache-Control', 'Vary']) expect(h.headers.get(k)).toBe(g.headers.get(k))
    secure(h)
  }
  const etag = get('/').headers.get('ETag')!
  expect(get('/', { 'If-None-Match': etag }, 'HEAD').status).toBe(304)
  expect(get('/nope', {}, 'HEAD').status).toBe(404)
})

test('.br files and unknown paths are 404 with the security headers', () => {
  for (const path of ['/main.js.br', '/toolchain/abc/llvm.core.wasm.br', '/nope', '/fonts', '/fonts/', '/index', '/MAIN.JS', '/main.js/', '//main.js', '/toolchain/abc/.abc.1.tmp/bundle.js']) {
    const r = get(path)
    expect(r.status).toBe(404)
    secure(r)
  }
})

test('other methods get 405 with Allow, on known and unknown paths', () => {
  for (const method of ['POST', 'PUT', 'DELETE', 'PATCH', 'OPTIONS']) {
    for (const path of ['/', '/main.js', '/nope']) {
      const r = get(path, {}, method)
      expect(r.status).toBe(405)
      expect(r.headers.get('Allow')).toBe('GET, HEAD')
      secure(r)
    }
  }
})

test('/toolchain/ files are immutable and carry no ETag', async () => {
  const r = get('/toolchain/abc/llvm.core.wasm', { 'Accept-Encoding': 'br', 'If-None-Match': '*' })
  expect(r.status).toBe(200)
  expect(r.headers.get('Cache-Control')).toBe('public, max-age=31536000, immutable')
  expect(r.headers.get('ETag')).toBeNull()
  expect(r.headers.get('Content-Encoding')).toBe('br')
  expect(r.headers.get('Vary')).toBe('Accept-Encoding')
  expect(brotliDecompressSync(await r.bytes()).toString()).toBe('wasm-bytes')
  expect(await get('/toolchain/abc/llvm.core.wasm').text()).toBe('wasm-bytes')
  secure(r)
})

test('path traversal attempts are 404', () => {
  for (const path of ['/../package.json', '/%2e%2e/package.json', '/..%2fpackage.json', '/%2e%2e%2fpackage.json', '/..%5cpackage.json', '/fonts/../../package.json', '/fonts/..%2f..%2fpackage.json', '/%00', '/index.html%00.js']) {
    expect(get(path).status).toBe(404)
  }
})

test('respond serves one asset; reply builds any other response with the same rules', async () => {
  expect(await respond(table.get('/style.css')!, new Request('http://x/anything')).text()).toBe('body{}')
  const g = reply(new Request('http://x/'), 200, 'ok', { 'Cache-Control': 'no-store' })
  const h = reply(new Request('http://x/', { method: 'HEAD' }), 200, 'ok', { 'Cache-Control': 'no-store' })
  secure(g)
  secure(h)
  expect(await g.text()).toBe('ok')
  expect(await h.text()).toBe('')
  expect(h.headers.get('Content-Length')).toBe('2')
  expect(h.headers.get('Cache-Control')).toBe('no-store')
})
