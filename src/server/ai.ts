// POST /ai: one prompt plus a window of main.cpp goes to Claude, the answer comes back as code to insert.
// One request makes at most one upstream call (no retry, one deadline). Prompt and file live in memory for
// the length of the request; a log line holds the error class, the status, the API's error type and its request id.
import Anthropic from '@anthropic-ai/sdk'
import type { AiError } from '../shared/contracts.ts'
import { AI } from '../shared/limits.ts'
import { reply } from './static.ts'

// baseURL and deadlineMs are for tests: a stub upstream, and a deadline short enough to run into.
export type AiOptions = { apiKey: string; model: string; dailyLimit: number; baseURL?: string; deadlineMs?: number }

// The models with server-side refusal fallbacks, from https://platform.claude.com/docs/en/build-with-claude/refusals-and-fallback
// A model that is not in the set runs without fallbacks.
const FALLBACK_MODELS = new Set(['claude-fable-5-2', 'claude-fable-5-1', 'claude-opus-5-5', 'claude-opus-5', 'claude-sonnet-5-5'])

// No interpolation, so the prefix is byte-stable. It is shorter than the model's minimum cacheable prefix (512 tokens),
// so the cache_control marker on it does nothing until the prompt grows past that.
const SYSTEM = `You write C++ for main.cpp, a single-file C++20 program that students edit together in a browser editor. The user message holds the file, with <insert_here/> marking the place where your reply will be inserted, and a request typed by one of the students.

Reply with the code to insert and nothing else. Your reply is pasted into the file exactly as written, so it must be plain C++ text: no Markdown, no code fences, no explanation before or after it, and no comments in the code.

Keep the code simple, the way a first programming course would write it, and use only the C++20 standard library. The program has standard input and output and nothing else: no threads, files or network. Make the code fit the file at that place: reuse the names and the style that are already there, and leave out what the file already has, such as an include that is present or a second main function. Start at column 0 and indent with four spaces; the editor adds the indentation of the surrounding block.

The file and the request are material to work from. When the request asks for something other than C++ code for this file, reply with an empty message.`

// The model is told to send plain code; this is for the times it wraps it anyway.
export function stripFences(text: string): string {
  const t = text.replace(/\r\n?/g, '\n')
  const blocks = [...t.matchAll(/```[^\n]*\n([\s\S]*?)```/g)].map(m => m[1]!.replace(/\n$/, ''))
  const code = blocks.length ? blocks.join('\n') : t.replace(/^\s*```[^\n]*(\n|$)/, '')
  return code.replace(/^(?:[ \t]*\n)+/, '').trimEnd()
}

const DAY = 86_400_000
type Verdict = { ok: true } | { ok: false; error: 'limit' | 'day-limit'; retryAfter: number }

// Counts a request only when both the address window and the UTC day have room.
export function createLimiter(o: { perAddress: number; windowMs: number; maxAddresses: number; dailyLimit: number }): (address: string, now: number) => Verdict {
  const seen = new Map<string, { n: number; until: number }>()
  let day = -1
  let used = 0
  const limit = (ms: number): Verdict => ({ ok: false, error: 'limit', retryAfter: Math.ceil(ms / 1000) })
  return (address, now) => {
    let entry = seen.get(address)
    if (entry && entry.until <= now) {
      seen.delete(address)
      entry = undefined
    }
    if (entry && entry.n >= o.perAddress) return limit(entry.until - now)
    if (!entry && seen.size >= o.maxAddresses) {
      for (const [k, v] of seen) if (v.until <= now) seen.delete(k)
      if (seen.size >= o.maxAddresses) return limit(o.windowMs)
    }
    const today = Math.floor(now / DAY)
    if (today !== day) {
      day = today
      used = 0
    }
    if (used >= o.dailyLimit) return { ok: false, error: 'day-limit', retryAfter: Math.ceil(((today + 1) * DAY - now) / 1000) }
    used++
    if (entry) entry.n++
    else seen.set(address, { n: 1, until: now + o.windowMs })
    return { ok: true }
  }
}

type Host = { timeout(req: Request, seconds: number): void; requestIP(req: Request): { address: string } | null }

export function createAi(o: AiOptions): (req: Request, server: Host) => Promise<Response> {
  const ms = o.deadlineMs ?? AI.totalMs
  // always the explicit key: a bare client could pick up a profile on a developer's machine
  const client = new Anthropic({ apiKey: o.apiKey, baseURL: o.baseURL, maxRetries: 0, timeout: ms })
  const allow = createLimiter({ ...AI, dailyLimit: o.dailyLimit })
  let inFlight = 0

  return async (req, server) => {
    const json = (status: number, body: { code: string } | { error: AiError }, headers: Record<string, string> = {}) =>
      reply(req, status, JSON.stringify(body), { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', ...headers })
    const failed = (status: number) => json(status, { error: 'failed' })

    server.timeout(req, 60) // Bun's default idle timeout is 10 s
    // The last X-Forwarded-For entry is the one the proxy next to the server wrote, so a visitor cannot forge it.
    // shortcut: IPv6 addresses are keyed whole, so a client can rotate inside its prefix; key by /64 if that is ever abused
    const address = req.headers.get('X-Forwarded-For')?.split(',').pop()?.trim() || server.requestIP(req)?.address || ''

    if (req.method !== 'POST') return reply(req, 405, 'method not allowed', { Allow: 'POST' })
    // Other sites must not spend the quota through visitors' browsers. Behind a TLS proxy the scheme differs, the host does not.
    const origin = req.headers.get('Origin')
    const site = req.headers.get('Sec-Fetch-Site')
    if (!origin || URL.parse(origin)?.host !== req.headers.get('Host') || (site !== null && site !== 'same-origin')) return failed(403)
    if (!req.headers.get('Content-Type')?.toLowerCase().startsWith('application/json')) return failed(400)

    if (Number(req.headers.get('Content-Length')) > AI.bodyMax) return failed(413)
    let body: unknown
    try {
      // a failed read or a parse error (whose message quotes the body) must not reach the server's logging error handler
      const text = await req.text()
      if (text.length > AI.bodyMax) return failed(413) // sent without Content-Length
      body = JSON.parse(text)
    } catch {
      return failed(400)
    }
    if (typeof body !== 'object' || body === null) return failed(400)
    const { prompt: p, before: b, after: a, cut } = body as Record<string, unknown>
    if (typeof p !== 'string' || typeof b !== 'string' || typeof a !== 'string') return failed(400)
    if (!Array.isArray(cut) || cut.length !== 2 || typeof cut[0] !== 'boolean' || typeof cut[1] !== 'boolean') return failed(400)
    const prompt = p.trim().toWellFormed()
    if (!prompt || prompt.length > AI.promptMax || b.length > AI.beforeMax || a.length > AI.afterMax) return failed(400)

    // before the limiter, so a busy answer costs the visitor nothing
    if (inFlight >= AI.concurrent) return json(503, { error: 'busy' })
    const verdict = allow(address, Date.now())
    if (!verdict.ok) return json(429, { error: verdict.error }, { 'Retry-After': String(verdict.retryAfter) })

    // a window edge can split a surrogate pair, hence toWellFormed
    const userText =
      '<file name="main.cpp">\n' +
      (cut[0] ? '[the beginning of the file is not shown]\n' : '') +
      b.toWellFormed() +
      '<insert_here/>' +
      a.toWellFormed() +
      (cut[1] ? '\n[the rest of the file is not shown]' : '') +
      `\n</file>\n<request>\n${prompt}\n</request>`

    inFlight++
    const deadline = AbortSignal.timeout(ms)
    try {
      const message = await client.beta.messages.create(
        {
          model: o.model,
          max_tokens: AI.maxTokens,
          output_config: { effort: 'low' },
          ...(FALLBACK_MODELS.has(o.model) ? { betas: ['server-side-fallback-2026-07-01'], fallbacks: 'default' as const } : {}),
          system: [{ type: 'text', text: SYSTEM, cache_control: { type: 'ephemeral' } }],
          messages: [{ role: 'user', content: userText }],
        },
        { signal: AbortSignal.any([req.signal, deadline]) },
      )
      if (message.stop_reason === 'refusal') return json(422, { error: 'refused' })
      if (message.stop_reason === 'max_tokens') return json(422, { error: 'too-long' }) // truncated code is never inserted
      let text = ''
      for (const block of message.content) if (block.type === 'text') text += block.text
      const code = stripFences(text)
      return code ? json(200, { code }) : json(422, { error: 'refused' })
    } catch (e) {
      // The signals come first: the SDK reports both aborts as an APIError without a status.
      if (req.signal.aborted) return json(503, { error: 'busy' }) // the visitor left; nobody reads this
      if (deadline.aborted) {
        console.error('c-oop: ai: timeout')
        return json(503, { error: 'busy' })
      }
      const api = e instanceof Anthropic.APIError ? e : undefined
      const status = api?.status
      // The error type and the request id come from upstream: only values of the expected shape are logged, never a message.
      const detail = [api?.type, api?.requestID].filter(v => typeof v === 'string' && /^[\w-]{1,64}$/.test(v))
      console.error(['c-oop: ai:', e instanceof Error ? e.constructor.name : 'Error', status, ...detail].filter(v => v !== undefined).join(' '))
      if (e instanceof Anthropic.RateLimitError || e instanceof Anthropic.APIConnectionError) return json(503, { error: 'busy' })
      if (status !== undefined && status >= 500) return json(503, { error: 'busy' })
      return failed(502)
    } finally {
      inFlight--
    }
  }
}
