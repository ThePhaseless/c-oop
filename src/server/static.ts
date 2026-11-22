// Static file table for `dist`: exact-match lookup, own ETags, brotli negotiation, HEAD.
import { readdir } from 'node:fs/promises'
import { join, relative, sep } from 'node:path'

export const SECURITY_HEADERS: Record<string, string> = {
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Cross-Origin-Embedder-Policy': 'require-corp',
  'Cross-Origin-Resource-Policy': 'same-origin',
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'Permissions-Policy': 'camera=(), microphone=(), geolocation=()',
  'Content-Security-Policy':
    "default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self'; connect-src 'self' ws: wss:; worker-src 'self'; object-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
}

const TYPES: Record<string, string> = {
  html: 'text/html; charset=utf-8',
  js: 'text/javascript; charset=utf-8',
  css: 'text/css; charset=utf-8',
  json: 'application/json',
  svg: 'image/svg+xml',
  wasm: 'application/wasm',
  woff2: 'font/woff2',
}

type Body = Uint8Array<ArrayBuffer> | Blob
type Variant = { body: Body; size: number }
// `etag` is absent for /toolchain/ files, which are immutable; `br` is the `<file>.br` beside the file.
export type Asset = { type: string; cache: string; etag?: string; raw: Variant; br?: Variant }

// Walks distDir once. App files are read into memory, so body, length and ETag always agree even when
// dist is rebuilt under a running server; the large toolchain files are only stat'ed and stream from disk.
export async function loadStatic(distDir: string): Promise<Map<string, Asset>> {
  const names = new Set<string>()
  for (const e of await readdir(distDir, { recursive: true, withFileTypes: true })) {
    const rel = '/' + relative(distDir, join(e.parentPath, e.name)).replaceAll(sep, '/')
    // dot segments are unfinished build output (dist/toolchain/.<id>.<pid>.tmp)
    if (e.isFile() && !rel.includes('/.')) names.add(rel)
  }
  if (!names.has('/index.html')) throw new Error(`no index.html in ${distDir}: run "bun run build" first`)

  const table = new Map<string, Asset>()
  const variant = async (path: string, inMemory: boolean): Promise<Variant> => {
    const file = Bun.file(join(distDir, path))
    return inMemory ? { body: await file.bytes(), size: file.size } : { body: file, size: file.size }
  }
  for (const name of names) {
    if (name.endsWith('.br')) continue
    const immutable = name.startsWith('/toolchain/')
    const raw = await variant(name, !immutable)
    table.set(name, {
      type: TYPES[name.slice(name.lastIndexOf('.') + 1)] ?? 'application/octet-stream',
      cache: immutable ? 'public, max-age=31536000, immutable' : 'no-cache',
      etag: raw.body instanceof Uint8Array ? Bun.hash(raw.body).toString(36) : undefined,
      raw,
      br: names.has(name + '.br') ? await variant(name + '.br', !immutable) : undefined,
    })
  }
  return table
}

// Every response of the server is built here: security headers always, and HEAD is the GET response
// without its body.
export function reply(req: Request, status: number, body: Body | string | null, headers: Record<string, string> = {}, size?: number): Response {
  const h: Record<string, string> = { ...SECURITY_HEADERS, ...headers }
  // set here because Bun adds it to a string body on GET only, and HEAD must carry the same headers
  if (typeof body === 'string') h['Content-Type'] ??= 'text/plain; charset=utf-8'
  if (req.method !== 'HEAD' || body === null) return new Response(body, { status, headers: h })
  h['Content-Length'] = String(size ?? (typeof body === 'string' ? Buffer.byteLength(body) : body instanceof Blob ? body.size : body.length))
  return new Response(null, { status, headers: h })
}

const acceptsBr = (req: Request) =>
  (req.headers.get('Accept-Encoding') ?? '').split(',').some(part => {
    const [name, ...params] = part.split(';').map(s => s.trim().toLowerCase())
    return name === 'br' && !params.some(p => /^q=0(\.0*)?$/.test(p))
  })

export function respond(asset: Asset, req: Request): Response {
  const br = asset.br && acceptsBr(req)
  const v = br ? asset.br! : asset.raw
  const headers: Record<string, string> = { 'Content-Type': asset.type, 'Cache-Control': asset.cache }
  if (asset.br) headers['Vary'] = 'Accept-Encoding'
  if (br) headers['Content-Encoding'] = 'br'
  if (asset.etag) {
    const etag = (headers['ETag'] = `"${asset.etag}${br ? '-br' : ''}"`)
    const wanted = (req.headers.get('If-None-Match') ?? '').split(',').map(s => s.trim().replace(/^W\//, ''))
    if (wanted.includes(etag) || wanted.includes('*')) return reply(req, 304, null, headers)
  }
  return reply(req, 200, v.body, headers, v.size)
}

export const methodAllowed = (req: Request) => req.method === 'GET' || req.method === 'HEAD'
export const notAllowed = (req: Request) => reply(req, 405, 'method not allowed', { Allow: 'GET, HEAD' })

// The request path, or null when the URL does not parse (a Host such as `x:abc`), which is the client's error.
// Without a usable Host header Bun reports a bare path; it gets its base by hand, because as a relative
// reference `//x/y` would be read as host x.
export const pathOf = (req: Request) => URL.parse(req.url[0] === '/' ? 'http://localhost' + req.url : req.url)?.pathname ?? null
export const badRequest = (req: Request) => reply(req, 400, 'bad request')

// The pathname is matched as written (no decoding) against the table, so nothing outside the walk can be reached.
export function serveStatic(table: Map<string, Asset>, req: Request): Response {
  if (!methodAllowed(req)) return notAllowed(req)
  const pathname = pathOf(req)
  if (pathname === null) return badRequest(req)
  const asset = table.get(pathname === '/' ? '/index.html' : pathname)
  return asset ? respond(asset, req) : reply(req, 404, 'not found')
}
