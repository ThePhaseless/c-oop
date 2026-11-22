// y-webrtc signaling (pub/sub) as a pure function: one received message in, a list of actions out.
// The server applies the actions to the socket; nothing here stores or logs a topic or payload.
import { SIGNAL, TOPIC_RE } from '../shared/limits.ts'

export type ConnState = { tokens: number; last: number; topics: Set<string> }
export type Action =
  | { do: 'subscribe' | 'unsubscribe'; topic: string }
  | { do: 'publish'; topic: string; message: string }
  | { do: 'send'; message: string }
  | { do: 'close'; code: 1008; reason: string }

export const newConn = (now: number): ConnState => ({ tokens: SIGNAL.burst, last: now, topics: new Set() })

const close = (reason: string): Action => ({ do: 'close', code: 1008, reason })

export function handle(state: ConnState, raw: string | Uint8Array, now: number, subscribers: (topic: string) => number): Action[] {
  // Every message costs one token, whatever it holds.
  state.tokens = Math.min(SIGNAL.burst, state.tokens + (Math.max(0, now - state.last) / 1000) * SIGNAL.perSecond)
  state.last = Math.max(state.last, now)
  if (state.tokens < 1) return [close('rate limit')]
  state.tokens -= 1

  if (typeof raw !== 'string' || raw.length > SIGNAL.maxPayload) return []
  let m: any
  try {
    m = JSON.parse(raw)
  } catch {
    return []
  }
  if (!m || typeof m !== 'object') return []

  const actions: Action[] = []
  if (m.type === 'subscribe' && Array.isArray(m.topics)) {
    for (const topic of m.topics) {
      // typeof first: TOPIC_RE.test(['<hex>']) would pass by coercion
      if (typeof topic !== 'string' || !TOPIC_RE.test(topic) || state.topics.has(topic)) continue
      if (state.topics.size >= SIGNAL.maxTopics) return [...actions, close('too many topics')]
      if (subscribers(topic) >= SIGNAL.maxSubscribers) continue
      state.topics.add(topic)
      actions.push({ do: 'subscribe', topic })
    }
  } else if (m.type === 'unsubscribe' && Array.isArray(m.topics)) {
    for (const topic of m.topics) if (typeof topic === 'string' && state.topics.delete(topic)) actions.push({ do: 'unsubscribe', topic })
  } else if (m.type === 'publish' && typeof m.topic === 'string' && state.topics.has(m.topic) && typeof m.data === 'string') {
    actions.push({ do: 'publish', topic: m.topic, message: JSON.stringify({ type: 'publish', topic: m.topic, data: m.data }) })
  } else if (m.type === 'ping') {
    actions.push({ do: 'send', message: '{"type":"pong"}' })
  }
  return actions
}
