import { expect, test } from 'bun:test'
import { SIGNAL } from '../shared/limits.ts'
import { handle, newConn, sweep, type TopicBuckets } from './signal.ts'

const T = (n: number) => n.toString(16).padStart(32, '0')
const none = () => 0
const msg = (o: unknown) => JSON.stringify(o)
const CLOSE: any = { do: 'close', code: 1008, reason: expect.any(String) }

test('subscribe adds each valid topic once, in order', () => {
  const c = newConn(0)
  expect(handle(c, msg({ type: 'subscribe', topics: [T(1), T(2), T(1)] }), 0, none, new Map())).toEqual([
    { do: 'subscribe', topic: T(1) },
    { do: 'subscribe', topic: T(2) },
  ])
  expect([...c.topics]).toEqual([T(1), T(2)])
})

test('topics that do not match TOPIC_RE are ignored and count for nothing', () => {
  const c = newConn(0)
  const bad = ['x', T(1).toUpperCase().replace('0', 'A'), T(1) + '0', 5, null, [T(1)], { a: 1 }]
  expect(handle(c, msg({ type: 'subscribe', topics: [...bad, ...bad, T(9)] }), 0, none, new Map())).toEqual([{ do: 'subscribe', topic: T(9) }])
  expect(c.topics.size).toBe(1)
})

test('the same topic subscribed 10 times gives one subscribe action and stays open', () => {
  const c = newConn(0)
  const actions = []
  for (let i = 0; i < 10; i++) {
    // from the second call on the topic is reported full: a repeat must still be a no-op, not a refusal
    actions.push(...handle(c, msg({ type: 'subscribe', topics: [T(1)] }), 0, () => (i ? SIGNAL.maxSubscribers : 0), new Map()))
  }
  expect(actions).toEqual([{ do: 'subscribe', topic: T(1) }])
})

test('a repeated subscribe is a no-op when the connection already holds maxTopics', () => {
  const c = newConn(0)
  const topics = Array.from({ length: SIGNAL.maxTopics }, (_, i) => T(i))
  expect(handle(c, msg({ type: 'subscribe', topics }), 0, none, new Map())).toHaveLength(SIGNAL.maxTopics)
  for (let i = 0; i < 10; i++) expect(handle(c, msg({ type: 'subscribe', topics }), 0, () => SIGNAL.maxSubscribers, new Map())).toEqual([])
})

test('a fifth distinct topic closes the connection with 1008', () => {
  const c = newConn(0)
  const topics = Array.from({ length: SIGNAL.maxTopics + 2 }, (_, i) => T(i))
  const actions = handle(c, msg({ type: 'subscribe', topics }), 0, none, new Map())
  expect(actions).toHaveLength(SIGNAL.maxTopics + 1)
  expect(actions.at(-1)).toEqual(CLOSE)
  expect(c.topics.size).toBe(SIGNAL.maxTopics)
})

test('a full topic is skipped silently and does not use a topic slot', () => {
  const c = newConn(0)
  const full = (t: string) => (t === T(1) ? SIGNAL.maxSubscribers : SIGNAL.maxSubscribers - 1)
  expect(handle(c, msg({ type: 'subscribe', topics: [T(1), T(2)] }), 0, full, new Map())).toEqual([{ do: 'subscribe', topic: T(2) }])
  expect([...c.topics]).toEqual([T(2)])
})

test('unsubscribe removes only topics in the set', () => {
  const c = newConn(0)
  handle(c, msg({ type: 'subscribe', topics: [T(1), T(2)] }), 0, none, new Map())
  expect(handle(c, msg({ type: 'unsubscribe', topics: [T(3), T(1), T(1), 'x', 7] }), 0, none, new Map())).toEqual([{ do: 'unsubscribe', topic: T(1) }])
  expect([...c.topics]).toEqual([T(2)])
})

test('publish relays exactly {type, topic, data} to a subscribed topic', () => {
  const c = newConn(0)
  handle(c, msg({ type: 'subscribe', topics: [T(1)] }), 0, none, new Map())
  const actions = handle(c, msg({ type: 'publish', topic: T(1), data: 'c2VjcmV0', clients: 9, extra: { x: 1 } }), 0, none, new Map())
  expect(actions).toEqual([{ do: 'publish', topic: T(1), message: `{"type":"publish","topic":"${T(1)}","data":"c2VjcmV0"}` }])
})

test('publish to an unsubscribed topic or with non-string data is dropped', () => {
  const c = newConn(0)
  handle(c, msg({ type: 'subscribe', topics: [T(1)] }), 0, none, new Map())
  expect(handle(c, msg({ type: 'publish', topic: T(2), data: 'x' }), 0, none, new Map())).toEqual([])
  for (const data of [{ a: 1 }, 5, null, ['x'], undefined]) expect(handle(c, msg({ type: 'publish', topic: T(1), data }), 0, none, new Map())).toEqual([])
  expect(handle(c, msg({ type: 'publish', topic: [T(1)], data: 'x' }), 0, none, new Map())).toEqual([])
})

test('ping answers pong', () => {
  expect(handle(newConn(0), msg({ type: 'ping' }), 0, none, new Map())).toEqual([{ do: 'send', message: '{"type":"pong"}' }])
})

test('bad JSON, binary, oversized, unknown types and bad field types are ignored', () => {
  const c = newConn(0)
  const inputs: (string | Uint8Array)[] = [
    '', '{', 'null', '5', '"ping"', '[]', msg([{ type: 'ping' }]), msg({ type: 'nope' }), msg({ type: 5 }), msg({}),
    msg({ type: 'subscribe' }), msg({ type: 'subscribe', topics: T(1) }), msg({ type: 'subscribe', topics: { 0: T(1) } }),
    msg({ type: 'unsubscribe', topics: null }), msg({ type: 'publish' }),
    new TextEncoder().encode(msg({ type: 'ping' })),
    msg({ type: 'ping', pad: 'x'.repeat(SIGNAL.maxPayload) }),
  ]
  for (const raw of inputs) expect(handle(c, raw, 0, none, new Map())).toEqual([])
  expect(c.topics.size).toBe(0)
})

test('relay forwards exactly {type, topic, data} to a subscribed topic', () => {
  const c = newConn(0)
  handle(c, msg({ type: 'subscribe', topics: [T(1)] }), 0, none, new Map())
  const actions = handle(c, msg({ type: 'relay', topic: T(1), data: 'c2VjcmV0', clients: 9, extra: { x: 1 } }), 0, none, new Map())
  expect(actions).toEqual([{ do: 'publish', topic: T(1), message: `{"type":"relay","topic":"${T(1)}","data":"c2VjcmV0"}` }])
})

test('relay to an unsubscribed topic or with non-string data is dropped', () => {
  const c = newConn(0)
  handle(c, msg({ type: 'subscribe', topics: [T(1)] }), 0, none, new Map())
  expect(handle(c, msg({ type: 'relay', topic: T(2), data: 'x' }), 0, none, new Map())).toEqual([])
  for (const data of [{ a: 1 }, 5, null, ['x'], undefined]) expect(handle(c, msg({ type: 'relay', topic: T(1), data }), 0, none, new Map())).toEqual([])
  expect(handle(c, msg({ type: 'relay', topic: [T(1)], data: 'x' }), 0, none, new Map())).toEqual([])
})

const KB = 'x'.repeat(1024 - SIGNAL.messageCost) // garbage that costs exactly 1024 bytes of the connection bucket

test('every message costs its length + messageCost; an empty bucket closes with 1008', () => {
  const c = newConn(0)
  const sub = msg({ type: 'subscribe', topics: [T(1)] })
  // subscribes, repeats, garbage, binary and oversized messages all pay for their size
  const inputs = [sub, sub, '{', new Uint8Array(7), msg({ type: 'ping' }), 'x'.repeat(SIGNAL.maxPayload + 1)]
  let left: number = SIGNAL.burstBytes
  for (const raw of inputs) {
    expect(handle(c, raw, 0, none, new Map()).some(a => a.do === 'close')).toBe(false)
    left -= (typeof raw === 'string' ? raw.length : raw.byteLength) + SIGNAL.messageCost
    expect(c.tokens).toBe(left)
  }
  const d = newConn(0)
  for (let i = 0; i < SIGNAL.burstBytes / 1024; i++) expect(handle(d, KB, 0, none, new Map())).toEqual([])
  expect(d.tokens).toBe(0)
  expect(handle(d, msg({ type: 'ping' }), 0, none, new Map())).toEqual([CLOSE])
  expect(d.tokens).toBe(0) // a refused message takes nothing
})

test('the connection bucket refills at bytesPerSecond and never above burstBytes', () => {
  const c = newConn(1000)
  for (let i = 0; i < SIGNAL.burstBytes / 1024; i++) handle(c, KB, 1000, none, new Map())
  expect(handle(c, KB, 1000, none, new Map())).toEqual([CLOSE])
  // one second later: exactly bytesPerSecond more bytes pass
  for (let i = 0; i < SIGNAL.bytesPerSecond / 1024; i++) expect(handle(c, KB, 2000, none, new Map())).toEqual([])
  expect(handle(c, KB, 2000, none, new Map())).toEqual([CLOSE])
  // a long pause refills to burstBytes, not beyond; a clock that steps back gives nothing
  let passed = 0
  while (handle(c, KB, 3_600_000, none, new Map()).length === 0) passed++
  expect(passed).toBe(SIGNAL.burstBytes / 1024)
  expect(handle(c, KB, 0, none, new Map())).toEqual([CLOSE])
})

test('900 messages of 700 characters within 3 s pass (a 30-person join with trickle ICE)', () => {
  const c = newConn(0)
  const topics: TopicBuckets = new Map()
  handle(c, msg({ type: 'subscribe', topics: [T(1)] }), 0, none, topics)
  const frame = (data: string) => msg({ type: 'publish', topic: T(1), data })
  const raw = frame('x'.repeat(700 - frame('').length))
  expect(raw.length).toBe(700)
  for (let i = 0; i < 900; i++) expect(handle(c, raw, (i * 3000) / 900, () => 30, topics)).toHaveLength(1)
})

test('a publish or relay costs (length + messageCost) * (subscribers - 1) of its own topic bucket', () => {
  const c = newConn(0)
  const topics: TopicBuckets = new Map()
  handle(c, msg({ type: 'subscribe', topics: [T(1)] }), 0, none, topics)
  const relay = msg({ type: 'relay', topic: T(1), data: 'abcd' })
  const publish = msg({ type: 'publish', topic: T(1), data: 'abcdefgh' })
  // alone in the room: nothing is sent out, so nothing is counted or kept
  expect(handle(c, relay, 0, () => 1, topics)).toHaveLength(1)
  expect(handle(c, publish, 0, () => 1, topics)).toHaveLength(1)
  expect(topics.size).toBe(0)

  expect(handle(c, relay, 0, () => 30, topics)).toHaveLength(1)
  expect(topics.get(T(1))).toEqual({
    publish: { tokens: SIGNAL.topicBurstBytes, last: 0 },
    relay: { tokens: SIGNAL.topicBurstBytes - (relay.length + SIGNAL.messageCost) * 29, last: 0 },
  })
  expect(handle(c, publish, 0, () => 3, topics)).toHaveLength(1)
  expect(topics.get(T(1))!.publish.tokens).toBe(SIGNAL.topicBurstBytes - (publish.length + SIGNAL.messageCost) * 2)
  expect([...topics.keys()]).toEqual([T(1)])
})

test('an empty relay bucket drops the relay and nothing else; the bucket refills', () => {
  const c = newConn(0)
  const topics: TopicBuckets = new Map()
  handle(c, msg({ type: 'subscribe', topics: [T(1), T(2)] }), 0, none, topics)
  const relay = msg({ type: 'relay', topic: T(1), data: 'abcd' })
  const cost = (relay.length + SIGNAL.messageCost) * 29
  expect(handle(c, relay, 0, () => 30, topics)).toHaveLength(1)
  topics.get(T(1))!.relay.tokens = cost - 1

  expect(handle(c, relay, 0, () => 30, topics)).toEqual([]) // dropped: no action, no close
  expect(topics.get(T(1))!.relay.tokens).toBe(cost - 1)
  expect(handle(c, msg({ type: 'publish', topic: T(1), data: 'abcd' }), 0, () => 30, topics)).toHaveLength(1)
  expect(handle(c, msg({ type: 'relay', topic: T(2), data: 'abcd' }), 0, () => 30, topics)).toHaveLength(1)
  expect(handle(c, msg({ type: 'ping' }), 0, none, topics)).toEqual([{ do: 'send', message: '{"type":"pong"}' }])

  // half a second later: topicBytesPerSecond / 2 more; a clock that steps back gives nothing
  expect(handle(c, relay, 500, () => 30, topics)).toHaveLength(1)
  expect(topics.get(T(1))!.relay).toEqual({ tokens: SIGNAL.topicBytesPerSecond / 2 - 1, last: 500 })
  topics.get(T(1))!.relay.tokens = 0
  expect(handle(c, relay, 0, () => 30, topics)).toEqual([])
  // a long pause refills to topicBurstBytes, not beyond
  expect(handle(c, relay, 3_600_000, () => 30, topics)).toHaveLength(1)
  expect(topics.get(T(1))!.relay.tokens).toBe(SIGNAL.topicBurstBytes - cost)
})

test('sweep removes the listed topics without subscribers and keeps the others', () => {
  const bucket = () => ({ publish: { tokens: 1, last: 0 }, relay: { tokens: 1, last: 0 } })
  const topics: TopicBuckets = new Map([[T(1), bucket()], [T(2), bucket()], [T(3), bucket()]])
  sweep(topics, t => (t === T(2) ? 1 : 0), [T(1), T(2), T(9)])
  expect([...topics.keys()]).toEqual([T(2), T(3)]) // T(2) still has a subscriber, T(3) was not listed
})
