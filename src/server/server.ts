// One Bun process: static files from dist, /config, /healthz, the /signal WebSocket and, when a key is set, POST /ai.
// State is the static table, the live connections, two byte counters per topic and the /ai counters. The log gets
// the startup line (which says whether AI snippets are on, with the model and the daily limit), fatal errors, one line
// (name and message) per internal error, and one line (error class, status, the API's error type and request id) per
// call to Anthropic that failed or ran into the deadline. A file error names the file under dist; no request URL,
// topic, payload, prompt or code is ever logged.
import { AI, DEFAULT_ICE, SIGNAL } from '../shared/limits.ts'
import { type AiOptions, createAi } from './ai.ts'
import { type ConnState, handle, newConn, sweep, type TopicBuckets } from './signal.ts'
import { badRequest, loadStatic, methodAllowed, notAllowed, pathOf, reply, SECURITY_HEADERS, serveStatic } from './static.ts'

export type ServerOptions = { port: number; distDir: string; iceServers: unknown[]; ai?: AiOptions }

export async function createServer(o: ServerOptions): Promise<Bun.Server<ConnState>> {
  const table = await loadStatic(o.distDir)
  const ai = o.ai && createAi(o.ai)
  const config = JSON.stringify({ iceServers: o.iceServers, ai: !!ai })
  // The only state besides the static table and the live connections: two byte counters per topic that has
  // subscribers (signal.ts), removed when the last one leaves.
  const topics: TopicBuckets = new Map()
  const server = Bun.serve<ConnState>({
    port: o.port,
    development: false,
    // The backstop for a body with no honest Content-Length. Twice the cap, so that /ai's own 413, with the
    // security headers, answers first for an honest one; no other route reads a body.
    maxRequestBodySize: 2 * AI.bodyMax,
    fetch(req, server) {
      const pathname = pathOf(req)
      if (ai && pathname === '/ai') return ai(req, server)
      if (!methodAllowed(req)) return notAllowed(req)
      if (pathname === null) return badRequest(req) // not an internal error: nothing is logged
      if (pathname === '/signal') {
        if (server.pendingWebSockets >= SIGNAL.maxConnections) return reply(req, 503, 'too many connections')
        if (server.upgrade(req, { data: newConn(Date.now()) })) return
        return reply(req, 400, 'expected a websocket upgrade')
      }
      if (pathname === '/healthz') return reply(req, 200, 'ok')
      if (pathname === '/config') return reply(req, 200, config, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' })
      return serveStatic(table, req)
    },
    // keeps Bun's own error page (no security headers) off the wire; the log line is the error alone (a file error names the file under dist)
    error: e => {
      console.error(`c-oop: ${e.name}: ${e.message}`)
      return new Response('internal error', { status: 500, headers: SECURITY_HEADERS })
    },
    websocket: {
      maxPayloadLength: SIGNAL.maxPayload,
      idleTimeout: SIGNAL.idleSeconds,
      backpressureLimit: SIGNAL.backpressureBytes,
      closeOnBackpressureLimit: true,
      perMessageDeflate: false,
      message(ws, raw) {
        const subscribers = (topic: string) => server.subscriberCount(topic)
        for (const a of handle(ws.data, raw, Date.now(), subscribers, topics)) {
          if (a.do === 'close') ws.close(a.code, a.reason)
          else if (a.do === 'send') ws.send(a.message)
          else if (a.do === 'publish') ws.publish(a.topic, a.message) // not echoed to the sender
          else {
            ws[a.do](a.topic)
            if (a.do === 'unsubscribe') sweep(topics, subscribers, [a.topic])
          }
        }
      },
      close(ws) {
        // after the close, so it does not matter whether Bun still counts this socket inside the handler
        const left = [...ws.data.topics]
        setTimeout(() => sweep(topics, topic => server.subscriberCount(topic), left), 0)
      },
    },
  })
  return server
}

// Why a browser would refuse this RTCIceServer in `new RTCPeerConnection`, or null. Every page drops an entry
// its browser refuses (main.ts) and only warns in its console, so the server does not start with one. The legacy `url` key is not accepted.
// shortcut: only the shapes operators get wrong in practice; the page drops whatever else its browser refuses.
function iceProblem(s: unknown): string | null {
  if (typeof s !== 'object' || s === null) return 'is not an object'
  const { urls, username, credential } = s as Record<string, unknown>
  const list = typeof urls === 'string' ? [urls] : urls
  if (!Array.isArray(list) || !list.length || !list.every(u => typeof u === 'string' && /^(stuns?|turns?):./.test(u)))
    return 'needs "urls": a string or a non-empty array of strings that start with stun:, stuns:, turn: or turns:'
  if (list.some(u => u.startsWith('stun') && u.includes('?'))) return 'has a stun: URL with a "?", which browsers refuse'
  // an empty string is what an unset variable in the value expands to
  if (list.some(u => u.startsWith('turn')) && !(typeof username === 'string' && username && typeof credential === 'string' && credential))
    return 'has a turn: URL and needs non-empty "username" and "credential" strings'
  return null
}

// Throws with a message meant for the operator when a value is unusable.
export function optionsFromEnv(env: Record<string, string | undefined>): ServerOptions {
  const port = Number(env.PORT || 8080)
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error('PORT must be a number from 0 to 65535')
  let iceServers: unknown = DEFAULT_ICE
  if (env.ICE_SERVERS) {
    try {
      iceServers = JSON.parse(env.ICE_SERVERS)
    } catch {
      throw new Error('ICE_SERVERS is not valid JSON; expected an array such as [{"urls":"stun:stun.example.org:3478"}]')
    }
    if (!Array.isArray(iceServers)) throw new Error('ICE_SERVERS must be a JSON array of RTCIceServer objects')
    iceServers.forEach((s, i) => {
      const problem = iceProblem(s)
      if (problem) throw new Error(`ICE_SERVERS entry ${i + 1} ${problem}`)
    })
  }
  if (env.COOP_AI_DAILY_LIMIT && !/^\d+$/.test(env.COOP_AI_DAILY_LIMIT)) throw new Error('COOP_AI_DAILY_LIMIT must be a whole number, 0 or more')
  const dailyLimit = env.COOP_AI_DAILY_LIMIT ? Number(env.COOP_AI_DAILY_LIMIT) : AI.dailyLimit
  const options: ServerOptions = { port, distDir: env.DIST_DIR || './dist', iceServers: iceServers as unknown[] }
  // limit 0 turns the feature off with the key still in place
  if (env.ANTHROPIC_API_KEY && dailyLimit > 0) options.ai = { apiKey: env.ANTHROPIC_API_KEY, model: 'claude-sonnet-5-5', dailyLimit }
  return options
}

if (import.meta.main) {
  try {
    const options = optionsFromEnv(process.env)
    const server = await createServer(options)
    // An ANTHROPIC_API_KEY exported for another tool switches the snippets on, so the line says when they are.
    const { ai } = options
    console.log(`c-oop listening on port ${server.port}` + (ai ? `, AI snippets on (${ai.model}, ${ai.dailyLimit} requests a day)` : ''))
    const stop = () => void server.stop(true).then(() => process.exit(0))
    process.on('SIGTERM', stop)
    process.on('SIGINT', stop)
  } catch (e) {
    console.error(`c-oop: ${e instanceof Error ? e.message : e}`)
    process.exit(1)
  }
}
