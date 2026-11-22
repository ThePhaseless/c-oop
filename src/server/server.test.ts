import { afterAll, beforeAll, expect, test } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { brotliCompressSync } from 'node:zlib'
import { DEFAULT_ICE, SIGNAL } from '../shared/limits.ts'
import { createServer, optionsFromEnv } from './server.ts'
import { SECURITY_HEADERS } from './static.ts'

const JS = 'console.log("main")\n'.repeat(50)
const TOPIC = 'ab'.repeat(16)
let root: string
let server: Bun.Server<unknown>
let base: string

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), 'c-oop-server-'))
  await Bun.write(join(root, 'secret.txt'), 'decoy')
  await Bun.write(join(root, 'dist/index.html'), '<!doctype html><title>t</title>')
  await Bun.write(join(root, 'dist/main.js'), JS)
  await Bun.write(join(root, 'dist/main.js.br'), brotliCompressSync(JS))
  server = await createServer({ port: 0, distDir: join(root, 'dist'), iceServers: DEFAULT_ICE })
  base = `http://localhost:${server.port}`
})
afterAll(async () => {
  await server.stop(true)
  await rm(root, { recursive: true, force: true })
})

const secure = (r: Response) => {
  for (const [k, v] of Object.entries(SECURITY_HEADERS)) expect(r.headers.get(k)).toBe(v)
}
// Bun's fetch asks for br and decodes it unless told otherwise
const raw = (path: string, init: RequestInit = {}) => fetch(base + path, { decompress: false, ...init, headers: { 'Accept-Encoding': 'identity', ...init.headers } })
const KEYS = ['content-type', 'content-length', 'etag', 'content-encoding', 'cache-control', 'vary']
const sameAsGet = async (path: string, headers: Record<string, string> = {}) => {
  const g = await raw(path, { headers })
  const h = await raw(path, { headers, method: 'HEAD' })
  const body = await g.bytes()
  expect(h.status).toBe(g.status)
  expect(await h.text()).toBe('')
  for (const k of KEYS) expect([k, h.headers.get(k)]).toEqual([k, g.headers.get(k)])
  expect(h.headers.get('content-length')).toBe(String(body.length))
  secure(g)
  secure(h)
  return g
}

test('/healthz answers ok to GET and HEAD', async () => {
  const r = await raw('/healthz')
  expect(r.status).toBe(200)
  expect(await r.text()).toBe('ok')
  await sameAsGet('/healthz')
})

test('/config returns the default ICE servers, uncached', async () => {
  const r = await raw('/config')
  expect(r.headers.get('cache-control')).toBe('no-store')
  expect(r.headers.get('content-type')).toBe('application/json')
  expect(await r.json()).toEqual({ iceServers: DEFAULT_ICE })
  await sameAsGet('/config')
})

test('/config returns custom ICE_SERVERS from the environment', async () => {
  const ice = [{ urls: 'turn:turn.example:3478', username: 'u', credential: 'p' }]
  const o = optionsFromEnv({ ICE_SERVERS: JSON.stringify(ice), PORT: '0', DIST_DIR: join(root, 'dist') })
  expect(o).toEqual({ port: 0, distDir: join(root, 'dist'), iceServers: ice })
  const s = await createServer(o)
  try {
    expect(await (await fetch(`http://localhost:${s.port}/config`)).json()).toEqual({ iceServers: ice })
  } finally {
    await s.stop(true)
  }
})

test('environment defaults', () => {
  expect(optionsFromEnv({})).toEqual({ port: 8080, distDir: './dist', iceServers: DEFAULT_ICE })
  expect(optionsFromEnv({ ICE_SERVERS: '', PORT: '' }).iceServers).toEqual(DEFAULT_ICE)
  expect(optionsFromEnv({ ICE_SERVERS: '[]' }).iceServers).toEqual([])
  // the example from the README and compose.yaml
  const turn = '[{"urls":["stun:stun.l.google.com:19302"]},{"urls":["turn:turn.example.org:3478"],"username":"c-oop","credential":"change-me"}]'
  expect(optionsFromEnv({ ICE_SERVERS: turn }).iceServers).toEqual(JSON.parse(turn))
})

test('invalid ICE_SERVERS or PORT rejects with a clear message', () => {
  const entries = [
    '"stun:x"', 'null', '{}', '{"urls":[]}', '{"urls":5}', '{"urls":["stun:x",5]}', '{"urls":"x.example:3478"}', '{"url":"stun:x"}',
    '{"urls":"turn:x"}', '{"urls":["stun:x","turns:x"],"username":"u"}', '{"urls":"turn:x","username":"u","credential":5}',
    // Chromium refuses these two: an unset variable in a TURN entry, and a query on a STUN URL
    '{"urls":"turn:x","username":"","credential":""}', '{"urls":"stun:x?transport=udp"}',
  ]
  for (const e of entries) expect(() => optionsFromEnv({ ICE_SERVERS: `[{"urls":"stun:ok"},${e}]` })).toThrow(/ICE_SERVERS entry 2 /)
  expect(() => optionsFromEnv({ ICE_SERVERS: '[{"urls":"turn:x?transport=tcp","username":"u","credential":"p"}]' })).not.toThrow()
  for (const v of ['{', 'stun:x', '{"urls":"stun:x"}', '"stun:x"', 'null', '5']) expect(() => optionsFromEnv({ ICE_SERVERS: v })).toThrow(/ICE_SERVERS/)
  for (const v of ['x', '-1', '70000', '80.5']) expect(() => optionsFromEnv({ PORT: v })).toThrow(/PORT/)
})

test('a missing dist directory rejects', async () => {
  await expect(createServer({ port: 0, distDir: join(root, 'nope'), iceServers: [] })).rejects.toThrow()
})

test('a file that vanished after startup answers 500 and logs one line without the request', async () => {
  const dist = join(root, 'gone')
  await Bun.write(join(dist, 'index.html'), 'x')
  await Bun.write(join(dist, 'toolchain/x/a.bin'), JS) // toolchain files stream from disk
  const s = await createServer({ port: 0, distDir: dist, iceServers: [] })
  const lines: string[] = []
  const error = console.error
  console.error = (...a: unknown[]) => void lines.push(a.join(' '))
  try {
    await rm(join(dist, 'toolchain/x/a.bin'))
    const r = await fetch(`http://localhost:${s.port}/toolchain/x/a.bin?probe=1`)
    expect(r.status).toBe(500)
    secure(r)
  } finally {
    console.error = error
    await s.stop(true)
  }
  expect(lines.length).toBe(1)
  expect(lines[0]).toStartWith('c-oop: ')
  expect(lines[0]).not.toContain('probe')
})

test('static files: GET, HEAD, brotli and 304 over the wire', async () => {
  const index = await sameAsGet('/')
  expect(index.headers.get('content-type')).toBe('text/html; charset=utf-8')
  const plain = await sameAsGet('/main.js')
  expect(plain.headers.get('content-encoding')).toBeNull()
  const br = await sameAsGet('/main.js', { 'Accept-Encoding': 'gzip, br' })
  expect(br.headers.get('content-encoding')).toBe('br')
  expect(Number(br.headers.get('content-length'))).toBeLessThan(JS.length)
  expect(await (await fetch(base + '/main.js')).text()).toBe(JS)

  for (const method of ['GET', 'HEAD']) {
    const r = await raw('/', { method, headers: { 'If-None-Match': index.headers.get('etag')! } })
    expect(r.status).toBe(304)
    expect(await r.text()).toBe('')
    secure(r)
  }
  const missing = await sameAsGet('/nope')
  expect(missing.status).toBe(404)
})

test('other methods give 405 with Allow on every path', async () => {
  for (const path of ['/', '/config', '/healthz', '/signal', '/nope']) {
    const r = await raw(path, { method: 'POST', body: 'x' })
    expect(r.status).toBe(405)
    expect(r.headers.get('allow')).toBe('GET, HEAD')
    secure(r)
  }
})

test('/signal without an upgrade is 400', async () => {
  const r = await raw('/signal')
  expect(r.status).toBe(400)
  secure(r)
})

// One request written to the socket as given, which fetch cannot do; resolves with the whole answer.
const wire = (head: string) =>
  new Promise<string>((resolve, reject) => {
    let text = ''
    Bun.connect({
      hostname: 'localhost',
      port: server.port!,
      socket: {
        open: s => void s.write(head + '\r\nConnection: close\r\n\r\n'),
        data: (_s, d) => void (text += d.toString()),
        close: () => resolve(text),
        error: (_s, e) => reject(e),
      },
    }).catch(reject)
  })

test('a literal /../ on the wire cannot leave dist', async () => {
  const answer = await wire('GET /../secret.txt HTTP/1.1\r\nHost: x')
  expect(answer).toStartWith('HTTP/1.1 404')
  expect(answer).not.toContain('decoy')
})

test('a missing or malformed Host header never reaches the error handler or the log', async () => {
  const lines: string[] = []
  const error = console.error
  console.error = (...a: unknown[]) => void lines.push(a.join(' '))
  try {
    // Bun reports a bare path for these, and the server never needs the host
    for (const head of ['GET /healthz?x=1 HTTP/1.0', 'HEAD /healthz HTTP/1.0', 'GET /healthz HTTP/1.1\r\nHost:', 'GET /healthz HTTP/1.1\r\nHost: a b'])
      expect([head, (await wire(head)).split('\r\n')[0]]).toEqual([head, 'HTTP/1.1 200 OK'])
    expect(await wire('GET //index.html HTTP/1.0')).toStartWith('HTTP/1.1 404') // matched as written, not as a host
    for (const host of ['x:abc', '[zz', 'a:99999999', '%zz', ':']) {
      for (const method of ['GET', 'HEAD']) {
        const answer = await wire(`${method} /healthz HTTP/1.1\r\nHost: ${host}`)
        expect([host, answer.split('\r\n')[0]]).toEqual([host, 'HTTP/1.1 400 Bad Request'])
        for (const [k, v] of Object.entries(SECURITY_HEADERS)) expect(answer).toContain(`${k}: ${v}\r\n`)
      }
    }
  } finally {
    console.error = error
  }
  expect(lines).toEqual([])
})

// A WebSocket client whose frames and close event can be awaited in order.
async function client() {
  const ws = new WebSocket(base.replace('http', 'ws') + '/signal')
  const frames: string[] = []
  let wake = () => {}
  const closed = new Promise<CloseEvent>(resolve => (ws.onclose = resolve))
  ws.onmessage = e => {
    frames.push(String(e.data))
    wake()
  }
  await new Promise((resolve, reject) => {
    ws.onopen = resolve
    ws.onerror = () => reject(new Error('websocket failed to open'))
  })
  const next = async () => {
    while (!frames.length) await new Promise<void>(resolve => (wake = resolve))
    return frames.shift()!
  }
  const send = (o: unknown) => ws.send(JSON.stringify(o))
  // ping/pong is the barrier: everything sent before it has been handled when the pong arrives
  const settle = async () => {
    send({ type: 'ping' })
    const seen: string[] = []
    for (let f = await next(); f !== '{"type":"pong"}'; f = await next()) seen.push(f)
    return seen
  }
  return { ws, send, next, settle, closed }
}

test('two clients exchange a publish; the sender does not get its own', async () => {
  const a = await client()
  const b = await client()
  const c = await client() // subscribed to nothing
  a.send({ type: 'subscribe', topics: [TOPIC] })
  b.send({ type: 'subscribe', topics: [TOPIC] })
  expect(await a.settle()).toEqual([])
  expect(await b.settle()).toEqual([])

  a.send({ type: 'publish', topic: TOPIC, data: 'aGVsbG8=', clients: 7 })
  expect(await a.settle()).toEqual([])
  expect(await b.next()).toBe(`{"type":"publish","topic":"${TOPIC}","data":"aGVsbG8="}`)

  b.send({ type: 'publish', topic: TOPIC, data: 'YmFjaw==' })
  expect(await b.settle()).toEqual([])
  expect(await a.next()).toBe(`{"type":"publish","topic":"${TOPIC}","data":"YmFjaw=="}`)

  // after unsubscribing, b neither receives nor may publish
  b.send({ type: 'unsubscribe', topics: [TOPIC] })
  b.send({ type: 'publish', topic: TOPIC, data: 'bm8=' })
  await b.settle()
  a.send({ type: 'publish', topic: TOPIC, data: 'bGFzdA==' })
  expect(await a.settle()).toEqual([])
  expect(await b.settle()).toEqual([])
  expect(await c.settle()).toEqual([])
  expect(server.pendingWebSockets).toBe(3)
  for (const x of [a, b, c]) x.ws.close()
  await Promise.all([a.closed, b.closed, c.closed])
})

test('a fifth topic closes the connection with 1008', async () => {
  const a = await client()
  a.send({ type: 'subscribe', topics: Array.from({ length: SIGNAL.maxTopics + 1 }, (_, i) => i.toString(16).padStart(32, '0')) })
  expect((await a.closed).code).toBe(1008)
})

test('a flood closes the connection with 1008', async () => {
  const a = await client()
  for (let i = 0; i < SIGNAL.burst + 50; i++) a.send({ type: 'subscribe', topics: [TOPIC] })
  expect((await a.closed).code).toBe(1008)
})

test('a message over maxPayload closes the connection with 1009', async () => {
  const a = await client()
  a.ws.send('x'.repeat(SIGNAL.maxPayload + 1))
  expect((await a.closed).code).toBe(1009)
})
