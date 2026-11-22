import { expect, test } from 'bun:test'
import { SIGNAL } from '../shared/limits.ts'
import { handle, newConn } from './signal.ts'

const T = (n: number) => n.toString(16).padStart(32, '0')
const none = () => 0
const msg = (o: unknown) => JSON.stringify(o)
const CLOSE: any = { do: 'close', code: 1008, reason: expect.any(String) }

test('subscribe adds each valid topic once, in order', () => {
  const c = newConn(0)
  expect(handle(c, msg({ type: 'subscribe', topics: [T(1), T(2), T(1)] }), 0, none)).toEqual([
    { do: 'subscribe', topic: T(1) },
    { do: 'subscribe', topic: T(2) },
  ])
  expect([...c.topics]).toEqual([T(1), T(2)])
})

test('topics that do not match TOPIC_RE are ignored and count for nothing', () => {
  const c = newConn(0)
  const bad = ['x', T(1).toUpperCase().replace('0', 'A'), T(1) + '0', 5, null, [T(1)], { a: 1 }]
  expect(handle(c, msg({ type: 'subscribe', topics: [...bad, ...bad, T(9)] }), 0, none)).toEqual([{ do: 'subscribe', topic: T(9) }])
  expect(c.topics.size).toBe(1)
})

test('the same topic subscribed 10 times gives one subscribe action and stays open', () => {
  const c = newConn(0)
  const actions = []
  for (let i = 0; i < 10; i++) {
    // from the second call on the topic is reported full: a repeat must still be a no-op, not a refusal
    actions.push(...handle(c, msg({ type: 'subscribe', topics: [T(1)] }), 0, () => (i ? SIGNAL.maxSubscribers : 0)))
  }
  expect(actions).toEqual([{ do: 'subscribe', topic: T(1) }])
})

test('a repeated subscribe is a no-op when the connection already holds maxTopics', () => {
  const c = newConn(0)
  const topics = Array.from({ length: SIGNAL.maxTopics }, (_, i) => T(i))
  expect(handle(c, msg({ type: 'subscribe', topics }), 0, none)).toHaveLength(SIGNAL.maxTopics)
  for (let i = 0; i < 10; i++) expect(handle(c, msg({ type: 'subscribe', topics }), 0, () => SIGNAL.maxSubscribers)).toEqual([])
})

test('a fifth distinct topic closes the connection with 1008', () => {
  const c = newConn(0)
  const topics = Array.from({ length: SIGNAL.maxTopics + 2 }, (_, i) => T(i))
  const actions = handle(c, msg({ type: 'subscribe', topics }), 0, none)
  expect(actions).toHaveLength(SIGNAL.maxTopics + 1)
  expect(actions.at(-1)).toEqual(CLOSE)
  expect(c.topics.size).toBe(SIGNAL.maxTopics)
})

test('a full topic is skipped silently and does not use a topic slot', () => {
  const c = newConn(0)
  const full = (t: string) => (t === T(1) ? SIGNAL.maxSubscribers : SIGNAL.maxSubscribers - 1)
  expect(handle(c, msg({ type: 'subscribe', topics: [T(1), T(2)] }), 0, full)).toEqual([{ do: 'subscribe', topic: T(2) }])
  expect([...c.topics]).toEqual([T(2)])
})

test('unsubscribe removes only topics in the set', () => {
  const c = newConn(0)
  handle(c, msg({ type: 'subscribe', topics: [T(1), T(2)] }), 0, none)
  expect(handle(c, msg({ type: 'unsubscribe', topics: [T(3), T(1), T(1), 'x', 7] }), 0, none)).toEqual([{ do: 'unsubscribe', topic: T(1) }])
  expect([...c.topics]).toEqual([T(2)])
})

test('publish relays exactly {type, topic, data} to a subscribed topic', () => {
  const c = newConn(0)
  handle(c, msg({ type: 'subscribe', topics: [T(1)] }), 0, none)
  const actions = handle(c, msg({ type: 'publish', topic: T(1), data: 'c2VjcmV0', clients: 9, extra: { x: 1 } }), 0, none)
  expect(actions).toEqual([{ do: 'publish', topic: T(1), message: `{"type":"publish","topic":"${T(1)}","data":"c2VjcmV0"}` }])
})

test('publish to an unsubscribed topic or with non-string data is dropped', () => {
  const c = newConn(0)
  handle(c, msg({ type: 'subscribe', topics: [T(1)] }), 0, none)
  expect(handle(c, msg({ type: 'publish', topic: T(2), data: 'x' }), 0, none)).toEqual([])
  for (const data of [{ a: 1 }, 5, null, ['x'], undefined]) expect(handle(c, msg({ type: 'publish', topic: T(1), data }), 0, none)).toEqual([])
  expect(handle(c, msg({ type: 'publish', topic: [T(1)], data: 'x' }), 0, none)).toEqual([])
})

test('ping answers pong', () => {
  expect(handle(newConn(0), msg({ type: 'ping' }), 0, none)).toEqual([{ do: 'send', message: '{"type":"pong"}' }])
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
  for (const raw of inputs) expect(handle(c, raw, 0, none)).toEqual([])
  expect(c.topics.size).toBe(0)
})

test('every message costs a token; an empty bucket closes with 1008', () => {
  const c = newConn(0)
  const sub = msg({ type: 'subscribe', topics: [T(1)] })
  // repeated subscribes, garbage and binary all cost one token each
  for (let i = 0; i < SIGNAL.burst; i++) {
    const raw = i % 3 === 0 ? sub : i % 3 === 1 ? '{' : new Uint8Array(1)
    expect(handle(c, raw, 0, none).some(a => a.do === 'close')).toBe(false)
  }
  expect(handle(c, msg({ type: 'ping' }), 0, none)).toEqual([CLOSE])
})

test('the bucket refills at perSecond and never above burst', () => {
  const c = newConn(1000)
  const ping = msg({ type: 'ping' })
  for (let i = 0; i < SIGNAL.burst; i++) handle(c, ping, 1000, none)
  expect(handle(c, ping, 1000, none)).toEqual([CLOSE])
  // one second later: exactly perSecond more messages pass
  for (let i = 0; i < SIGNAL.perSecond; i++) expect(handle(c, ping, 2000, none)).toHaveLength(1)
  expect(handle(c, ping, 2000, none)).toEqual([CLOSE])
  // a long pause refills to burst, not beyond; a clock that steps back gives nothing
  let passed = 0
  while (handle(c, ping, 3_600_000, none)[0]?.do === 'send') passed++
  expect(passed).toBe(SIGNAL.burst)
  expect(handle(c, ping, 0, none)).toEqual([CLOSE])
})
