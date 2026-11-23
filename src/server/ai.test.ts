import { afterAll, beforeAll, expect, test } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { AiRequest } from '../shared/contracts.ts'
import { AI } from '../shared/limits.ts'
import { type AiOptions, createLimiter, stripFences } from './ai.ts'
import { createServer } from './server.ts'
import { SECURITY_HEADERS } from './static.ts'

test('stripFences', () => {
  expect(stripFences('int a = 1;')).toBe('int a = 1;')
  expect(stripFences('\n\n    int a = 1;\n\n')).toBe('    int a = 1;')
  expect(stripFences('```cpp\nint a = 1;\n```')).toBe('int a = 1;')
  expect(stripFences('Here you go:\n```cpp\nint a = 1;\nint b = 2;\n```\nHope it helps.')).toBe('int a = 1;\nint b = 2;')
  expect(stripFences('```cpp\nint a = 1;\n```\nand\n```\nint b = 2;\n```')).toBe('int a = 1;\nint b = 2;')
  expect(stripFences('```cpp\nint a = 1;\n')).toBe('int a = 1;')
  expect(stripFences('```cpp\r\nint a = 1;\r\nint b = 2;\r\n```\r\n')).toBe('int a = 1;\nint b = 2;')
  expect(stripFences('')).toBe('')
  expect(stripFences(' \n```\n```\n')).toBe('')
})

test('createLimiter', () => {
  const DAY = 86_400_000
  const t0 = 10 * DAY + 1000
  const make = (o = {}) => createLimiter({ perAddress: 2, windowMs: 60_000, maxAddresses: 2, dailyLimit: 5, ...o })

  let allow = make()
  expect(allow('a', t0)).toEqual({ ok: true })
  expect(allow('a', t0 + 1000)).toEqual({ ok: true })
  expect(allow('a', t0 + 1500)).toEqual({ ok: false, error: 'limit', retryAfter: 59 }) // the window began at the first request
  expect(allow('b', t0 + 1500)).toEqual({ ok: true }) // another address is independent
  expect(allow('a', t0 + 60_000)).toEqual({ ok: true }) // the window is over

  // the day cap, and a refused request counts toward nothing
  allow = make({ perAddress: 100, dailyLimit: 2 })
  expect(allow('a', t0).ok).toBe(true)
  expect(allow('a', t0).ok).toBe(true)
  for (const address of ['a', 'b']) expect(allow(address, t0)).toEqual({ ok: false, error: 'day-limit', retryAfter: 86_399 })
  expect(allow('a', 11 * DAY).ok).toBe(true) // the next UTC day
  expect(allow('a', 11 * DAY).ok).toBe(true)
  expect(allow('a', 11 * DAY).ok).toBe(false) // two refusals on the day before used up none of today's two

  // a request refused by the address limit does not use up the day
  allow = make({ perAddress: 1, dailyLimit: 2 })
  expect(allow('a', t0).ok).toBe(true)
  expect(allow('a', t0)).toMatchObject({ error: 'limit' })
  expect(allow('b', t0).ok).toBe(true)

  // a full map refuses a new address until an entry expired
  allow = make()
  expect(allow('a', t0).ok).toBe(true)
  expect(allow('b', t0 + 30_000).ok).toBe(true)
  expect(allow('c', t0 + 30_000)).toEqual({ ok: false, error: 'limit', retryAfter: 60 })
  expect(allow('a', t0 + 30_000).ok).toBe(true) // a known address still passes
  expect(allow('c', t0 + 60_000).ok).toBe(true) // a's entry expired
})

// The stub upstream: the real SDK talks to it through `baseURL`.
const ANSWER = (over: object = {}) =>
  Response.json({
    id: 'msg_1',
    type: 'message',
    role: 'assistant',
    model: 'claude-sonnet-5-5',
    stop_reason: 'end_turn',
    stop_sequence: null,
    content: [
      { type: 'thinking', thinking: '', signature: 's' },
      { type: 'text', text: '```cpp\nint answer = 42;\n```' },
    ],
    usage: { input_tokens: 1, output_tokens: 1 },
    ...over,
  })
const upstreamError = (status: number, headers: Record<string, string> = {}) => () =>
  Response.json({ type: 'error', error: { type: 'api_error', message: 'x' } }, { status, headers })
// `any`: the recorded request bodies are read loosely
const seen: { body: any; beta: string | null }[] = []
let answer: () => Response = ANSWER
let gate: PromiseWithResolvers<void> | null = null
let onArrive = () => {}
let onAbort = () => {}
const hold = () => void (gate = Promise.withResolvers())
const release = () => {
  gate?.resolve()
  gate = null
}
const arrived = (n: number) =>
  new Promise<void>(resolve => {
    onArrive = () => void (seen.length >= n && resolve())
    onArrive()
  })

const PROMPT = 'declare the answer'
const FILE = 'int main() {\n'
const GOOD: AiRequest = { prompt: PROMPT, before: FILE, after: '    return 0;\n}\n', cut: [false, false] }
const BUSY = { error: 'busy' }
let root: string
let upstream: Bun.Server<unknown>
const servers: Bun.Server<unknown>[] = []
let main: string, capped: string, plain: string, slow: string

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), 'c-oop-ai-'))
  await Bun.write(join(root, 'index.html'), 'x')
  upstream = Bun.serve({
    port: 0,
    async fetch(req) {
      seen.push({ body: await req.json(), beta: req.headers.get('anthropic-beta') })
      onArrive()
      if (gate) {
        req.signal.addEventListener('abort', () => onAbort())
        await gate.promise
      }
      return answer()
    },
  })
  const start = async (ai: Partial<AiOptions>) => {
    const s = await createServer({ port: 0, distDir: root, iceServers: [], ai: { apiKey: 'test', model: 'claude-sonnet-5-5', dailyLimit: 1000, baseURL: `http://localhost:${upstream.port}`, ...ai } })
    servers.push(s)
    return `http://localhost:${s.port}`
  }
  main = await start({})
  capped = await start({ dailyLimit: 2 })
  plain = await start({ model: 'some-other-model' })
  slow = await start({ deadlineMs: 300 })
})
afterAll(async () => {
  release()
  await Promise.all([...servers, upstream].map(s => s.stop(true)))
  await rm(root, { recursive: true, force: true })
})

// Bun's fetch sends no Origin; every case gets an address bucket of its own unless it names one.
let addresses = 0
const post = (base: string, body: unknown, headers: Record<string, string> = {}, init: RequestInit = {}) =>
  fetch(base + '/ai', {
    method: 'POST',
    body: typeof body === 'string' || body instanceof ReadableStream ? body : JSON.stringify(body),
    ...init,
    headers: { Origin: base, 'Content-Type': 'application/json', 'X-Forwarded-For': `10.0.${++addresses >> 8}.${addresses & 255}`, ...headers },
  })
const expectJson = async (r: Response, status: number, body: unknown) => {
  expect([r.status, await r.json()]).toEqual([status, body])
  expect(r.headers.get('cache-control')).toBe('no-store')
  for (const [k, v] of Object.entries(SECURITY_HEADERS)) expect(r.headers.get(k)).toBe(v)
}
const logged = async (run: () => Promise<void>) => {
  const lines: string[] = []
  const error = console.error
  console.error = (...a: unknown[]) => void lines.push(a.join(' '))
  try {
    await run()
  } finally {
    console.error = error
  }
  return lines
}

test('a good request returns the code and sends the planned request upstream', async () => {
  const before = seen.length
  await expectJson(await post(main, { ...GOOD, prompt: `  ${PROMPT}  `, cut: [true, true] }), 200, { code: 'int answer = 42;' })
  expect(seen.length).toBe(before + 1)
  const { body, beta } = seen.at(-1)!
  expect(body).toMatchObject({ model: 'claude-sonnet-5-5', max_tokens: AI.maxTokens, output_config: { effort: 'low' }, fallbacks: 'default' })
  expect(beta).toContain('server-side-fallback-2026-07-01')
  expect('thinking' in body || 'temperature' in body || 'betas' in body).toBe(false)
  expect(body.system).toEqual([{ type: 'text', text: expect.stringMatching(/^You write C\+\+ for main\.cpp/), cache_control: { type: 'ephemeral' } }])
  expect(body.messages).toEqual([
    {
      role: 'user',
      content: `<file name="main.cpp">\n[the beginning of the file is not shown]\n${FILE}<insert_here/>    return 0;\n}\n\n[the rest of the file is not shown]\n</file>\n<request>\n${PROMPT}\n</request>`,
    },
  ])
  await post(main, GOOD)
  expect(seen.at(-1)!.body.messages[0].content).toBe(`<file name="main.cpp">\n${FILE}<insert_here/>    return 0;\n}\n\n</file>\n<request>\n${PROMPT}\n</request>`)
})

test('/config says ai: true, and only POST is allowed', async () => {
  expect((await (await fetch(main + '/config')).json()).ai).toBe(true)
  for (const method of ['GET', 'HEAD', 'PUT']) {
    const r = await fetch(main + '/ai', { method })
    expect([method, r.status, r.headers.get('allow')]).toEqual([method, 405, 'POST'])
    for (const [k, v] of Object.entries(SECURITY_HEADERS)) expect(r.headers.get(k)).toBe(v)
  }
})

test('requests from another site are 403 and never go upstream', async () => {
  const before = seen.length
  const r = await fetch(main + '/ai', { method: 'POST', body: JSON.stringify(GOOD), headers: { 'Content-Type': 'application/json' } })
  await expectJson(r, 403, { error: 'failed' })
  const foreign: Record<string, string>[] = [{ Origin: 'http://evil.example' }, { Origin: 'null' }, { Origin: main.replace('localhost', 'evil.example') }, { 'Sec-Fetch-Site': 'cross-site' }, { 'Sec-Fetch-Site': 'same-site' }]
  for (const headers of foreign)
    await expectJson(await post(main, GOOD, headers), 403, { error: 'failed' })
  await expectJson(await post(main, GOOD, { Origin: main.replace('http:', 'https:'), 'Sec-Fetch-Site': 'same-origin' }), 200, { code: 'int answer = 42;' }) // behind a TLS proxy
  expect(seen.length).toBe(before + 1)
})

test('a malformed request is 400 and never goes upstream', async () => {
  const before = seen.length
  await expectJson(await post(main, GOOD, { 'Content-Type': 'text/plain' }), 400, { error: 'failed' })
  const bad: unknown[] = [
    '{"prompt":',
    'null',
    '[]',
    { ...GOOD, prompt: 5 },
    { ...GOOD, before: undefined },
    { ...GOOD, after: null },
    { ...GOOD, cut: [true] },
    { ...GOOD, cut: [true, 'x'] },
    { ...GOOD, cut: 'xy' },
    { ...GOOD, prompt: '  \n ' },
    { ...GOOD, prompt: 'x'.repeat(AI.promptMax + 1) },
    { ...GOOD, before: 'x'.repeat(AI.beforeMax + 1) },
    { ...GOOD, after: 'x'.repeat(AI.afterMax + 1) },
  ]
  for (const body of bad) await expectJson(await post(main, body), 400, { error: 'failed' })
  expect(seen.length).toBe(before)
  // the caps themselves pass, and a lone surrogate at a window edge is sent well-formed
  await expectJson(await post(main, { prompt: 'x'.repeat(AI.promptMax), before: '\ude00' + 'x'.repeat(AI.beforeMax - 1), after: 'x'.repeat(AI.afterMax - 1) + '\ud83d', cut: [true, true] }), 200, { code: 'int answer = 42;' })
  expect(seen.at(-1)!.body.messages[0].content).toContain('�' + 'x'.repeat(AI.beforeMax - 1) + '<insert_here/>')
})

test('a body over the cap is 413', async () => {
  const before = seen.length
  const over = JSON.stringify(GOOD).padEnd(AI.bodyMax + 1)
  await expectJson(await post(main, over), 413, { error: 'failed' })
  // the same bytes without a Content-Length
  const stream = new ReadableStream({
    start(c) {
      c.enqueue(new TextEncoder().encode(over))
      c.close()
    },
  })
  await expectJson(await post(main, stream), 413, { error: 'failed' })
  await expectJson(await post(main, JSON.stringify(GOOD).padEnd(AI.bodyMax)), 200, { code: 'int answer = 42;' })
  expect((await post(main, 'x'.repeat(2 * AI.bodyMax + 1))).status).toBe(413) // Bun's own answer, nothing more is promised
  expect(seen.length).toBe(before + 1)
})

test('a refusal, an empty answer and a cut-off answer are 422', async () => {
  try {
    answer = () => ANSWER({ stop_reason: 'refusal', content: [] })
    await expectJson(await post(main, GOOD), 422, { error: 'refused' })
    answer = () => ANSWER({ content: [{ type: 'text', text: ' \n' }] })
    await expectJson(await post(main, GOOD), 422, { error: 'refused' })
    answer = () => ANSWER({ stop_reason: 'max_tokens' })
    await expectJson(await post(main, GOOD), 422, { error: 'too-long' })
  } finally {
    answer = ANSWER
  }
})

test('an upstream failure is asked once and logs one line without the prompt or the file', async () => {
  try {
    // the line ends with the API's error type and, when the answer carried one, its request id
    for (const [status, expected, body, line, headers] of [
      [429, 503, BUSY, 'c-oop: ai: RateLimitError 429 api_error', {}],
      [500, 503, BUSY, 'c-oop: ai: InternalServerError 500 api_error', {}],
      [401, 502, { error: 'failed' }, 'c-oop: ai: AuthenticationError 401 api_error', {}],
      [400, 502, { error: 'failed' }, 'c-oop: ai: BadRequestError 400 api_error req_011CSHoEeqs5C35K2UUqR7Fy', { 'request-id': 'req_011CSHoEeqs5C35K2UUqR7Fy' }],
      [400, 502, { error: 'failed' }, 'c-oop: ai: BadRequestError 400 api_error', { 'request-id': 'not an id\tint main' }], // a value of another shape is left out
    ] as const) {
      answer = upstreamError(status, headers)
      const before = seen.length
      const lines = await logged(async () => expectJson(await post(main, GOOD), expected, body))
      expect(seen.length).toBe(before + 1) // no retry
      expect(lines).toEqual([line])
    }
    answer = () => new Response('not json at all')
    const lines = await logged(async () => expectJson(await post(main, GOOD), 502, { error: 'failed' }))
    expect(lines.length).toBe(1)
    expect(lines[0]).toStartWith('c-oop: ai: ')
    expect(lines[0]).not.toContain(PROMPT)
    expect(lines[0]).not.toContain('int main')
  } finally {
    answer = ANSWER
  }
})

test('a visitor who gives up is not logged and frees the slot', async () => {
  const lines = await logged(async () => {
    hold()
    const before = seen.length
    const upstreamAborted = new Promise<string>(resolve => (onAbort = () => resolve('aborted')))
    const visitor = new AbortController()
    const request = post(main, GOOD, {}, { signal: visitor.signal }).catch(() => 'gone')
    await arrived(before + 1)
    visitor.abort()
    expect(await request).toBe('gone')
    // says which of the two ended the wait
    expect(await Promise.race([upstreamAborted, Bun.sleep(5000).then(() => 'the upstream call was not aborted within 5 s')])).toBe('aborted')
    release()
    await expectJson(await post(main, GOOD), 200, { code: 'int answer = 42;' })
    await Bun.sleep(50) // the abandoned handler has ended by now
  })
  expect(lines.filter(l => l.startsWith('c-oop: ai:'))).toEqual([])
})

test('the limit is per last X-Forwarded-For entry', async () => {
  for (let i = 0; i < AI.perAddress; i++) expect((await post(main, GOOD, { 'X-Forwarded-For': `1.2.3.${i}, 192.0.2.1` })).status).toBe(200)
  for (const first of ['1.2.3.4', '9.9.9.9']) {
    const r = await post(main, GOOD, { 'X-Forwarded-For': `${first},192.0.2.1` })
    await expectJson(r, 429, { error: 'limit' })
    expect(Number(r.headers.get('retry-after'))).toBeWithin(1, AI.windowMs / 1000 + 1)
  }
  await expectJson(await post(main, GOOD, { 'X-Forwarded-For': '192.0.2.1, 192.0.2.2' }), 200, { code: 'int answer = 42;' })
})

test('more than the concurrent calls are turned away as busy', async () => {
  hold()
  const before = seen.length
  const waiting = Array.from({ length: AI.concurrent }, () => post(main, GOOD))
  await arrived(before + AI.concurrent)
  await expectJson(await post(main, GOOD), 503, BUSY)
  expect(seen.length).toBe(before + AI.concurrent)
  release()
  for (const r of await Promise.all(waiting)) expect(r.status).toBe(200)
  await expectJson(await post(main, GOOD), 200, { code: 'int answer = 42;' })
})

test('the daily cap', async () => {
  expect((await post(capped, GOOD)).status).toBe(200)
  expect((await post(capped, GOOD)).status).toBe(200)
  const r = await post(capped, GOOD)
  await expectJson(r, 429, { error: 'day-limit' })
  expect(Number(r.headers.get('retry-after'))).toBeWithin(1, 86_401)
})

test('a model without refusal fallbacks gets neither the field nor the beta header', async () => {
  await expectJson(await post(plain, GOOD), 200, { code: 'int answer = 42;' })
  const { body, beta } = seen.at(-1)!
  expect(body.model).toBe('some-other-model')
  expect('fallbacks' in body).toBe(false)
  expect(beta).toBeNull()
})

test('the deadline ends the one upstream call', async () => {
  hold()
  const before = seen.length
  try {
    const lines = await logged(async () => expectJson(await post(slow, GOOD), 503, BUSY))
    // the server's own timer and the SDK's carry the same value; whichever fires first, it is one line
    expect(lines.length).toBe(1)
    expect(lines[0]).toStartWith('c-oop: ai: ')
    expect(seen.length).toBe(before + 1)
  } finally {
    release()
  }
})
