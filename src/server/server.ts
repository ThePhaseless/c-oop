// One Bun process: static files from dist, /config, /healthz and the /signal WebSocket.
// State is the static table and the live connections. The log gets the startup line, fatal errors and one
// line (name and message) per internal error. A file error names the file under dist; no request URL,
// topic or payload is ever logged.
import { DEFAULT_ICE, SIGNAL } from '../shared/limits.ts'
import { type ConnState, handle, newConn, sweep, type TopicBuckets } from './signal.ts'
import { badRequest, loadStatic, methodAllowed, notAllowed, pathOf, reply, SECURITY_HEADERS, serveStatic } from './static.ts'

export type ServerOptions = { port: number; distDir: string; iceServers: unknown[] }

export async function createServer(o: ServerOptions): Promise<Bun.Server<ConnState>> {
  const table = await loadStatic(o.distDir)
  const config = JSON.stringify({ iceServers: o.iceServers })
  // The only state besides the static table and the live connections: two byte counters per topic that has
  // subscribers (signal.ts), removed when the last one leaves.
  const topics: TopicBuckets = new Map()
  const server = Bun.serve<ConnState>({
    port: o.port,
    development: false,
    fetch(req, server) {
      if (!methodAllowed(req)) return notAllowed(req)
      const pathname = pathOf(req)
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
  return { port, distDir: env.DIST_DIR || './dist', iceServers: iceServers as unknown[] }
}

if (import.meta.main) {
  try {
    const server = await createServer(optionsFromEnv(process.env))
    console.log(`c-oop listening on port ${server.port}`)
    const stop = () => void server.stop(true).then(() => process.exit(0))
    process.on('SIGTERM', stop)
    process.on('SIGINT', stop)
  } catch (e) {
    console.error(`c-oop: ${e instanceof Error ? e.message : e}`)
    process.exit(1)
  }
}
