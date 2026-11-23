// y-webrtc signaling (pub/sub) as a pure function: one received message in, a list of actions out.
// The server applies the actions to the socket; nothing here stores or logs a payload. What is kept: a byte
// counter per connection and, while a topic has subscribers, two byte counters under its name (TopicBuckets).
import { SIGNAL, TOPIC_RE } from '../shared/limits.ts'

export type Bucket = { tokens: number; last: number }
export type ConnState = Bucket & { topics: Set<string> }
// Bytes the server may still send out per topic, one bucket per message type: signaling cannot use up the relay's budget.
export type TopicBuckets = Map<string, { publish: Bucket; relay: Bucket }>
export type Action =
  | { do: 'subscribe' | 'unsubscribe'; topic: string }
  | { do: 'publish'; topic: string; message: string }
  | { do: 'send'; message: string }
  | { do: 'close'; code: 1008; reason: string }

export const newConn = (now: number): ConnState => ({ tokens: SIGNAL.burstBytes, last: now, topics: new Set() })

const close = (reason: string): Action => ({ do: 'close', code: 1008, reason })

// Refills the bucket (never above capacity, nothing when the clock steps back) and takes the cost, or takes nothing and returns false.
function take(bucket: Bucket, now: number, capacity: number, perSecond: number, cost: number): boolean {
  bucket.tokens = Math.min(capacity, bucket.tokens + (Math.max(0, now - bucket.last) / 1000) * perSecond)
  bucket.last = Math.max(bucket.last, now)
  if (bucket.tokens < cost) return false
  bucket.tokens -= cost
  return true
}

// Deletes the listed topics that have no subscriber left, so an abandoned room id does not stay in memory.
export function sweep(topics: TopicBuckets, subscribers: (topic: string) => number, only: Iterable<string>): void {
  for (const topic of only) if (subscribers(topic) === 0) topics.delete(topic)
}

export function handle(state: ConnState, raw: string | Uint8Array, now: number, subscribers: (topic: string) => number, topics: TopicBuckets): Action[] {
  // Every message costs its length plus messageCost, whatever it holds.
  const length = typeof raw === 'string' ? raw.length : raw.byteLength
  if (!take(state, now, SIGNAL.burstBytes, SIGNAL.bytesPerSecond, length + SIGNAL.messageCost)) return [close('rate limit')]

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
  } else if ((m.type === 'publish' || m.type === 'relay') && typeof m.topic === 'string' && state.topics.has(m.topic) && typeof m.data === 'string') {
    const type: 'publish' | 'relay' = m.type
    const others = Math.max(0, subscribers(m.topic) - 1)
    if (others > 0) {
      let entry = topics.get(m.topic)
      if (!entry) topics.set(m.topic, (entry = { publish: { tokens: SIGNAL.topicBurstBytes, last: now }, relay: { tokens: SIGNAL.topicBurstBytes, last: now } }))
      // The room is over its budget, the sender did nothing wrong: the message is dropped and the connection stays.
      if (!take(entry[type], now, SIGNAL.topicBurstBytes, SIGNAL.topicBytesPerSecond, (length + SIGNAL.messageCost) * others)) return []
    }
    actions.push({ do: 'publish', topic: m.topic, message: JSON.stringify({ type, topic: m.topic, data: m.data }) })
  } else if (m.type === 'ping') {
    actions.push({ do: 'send', message: '{"type":"pong"}' })
  }
  return actions
}
