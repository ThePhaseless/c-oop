import { afterEach, describe, expect, test } from 'bun:test'
import * as Y from 'yjs'
import { applyAwarenessUpdate, Awareness, encodeAwarenessUpdate } from 'y-protocols/awareness'
import { COLOR_RE, NAME_MAX, PEER_COLORS } from '../shared/limits'
import { ANIMALS } from './strings'
import { createConnWatch, createRetry, guardAwareness, loadIdentity, sanitizeCursor, sanitizeName, sanitizeUser, saveIdentity } from './presence'

const HOSTILE_COLOR = 'red;background:url(//x)'

describe('sanitizeUser', () => {
  test('keeps markup in a name as plain text and never returns colorLight', () => {
    const u = sanitizeUser({ name: '<img onerror=alert(1)>', color: '#AbCdEf', colorLight: HOSTILE_COLOR })
    expect(u).toEqual({ name: '<img onerror=alert(1)>', color: '#AbCdEf' })
    expect('colorLight' in u).toBe(false)
  })
  test('cuts a 500-char name to NAME_MAX code points', () => {
    expect(sanitizeUser({ name: 'a'.repeat(500), color: '#000000' }).name).toBe('a'.repeat(NAME_MAX))
    expect([...sanitizeName('😀'.repeat(500))].length).toBe(NAME_MAX)
  })
  test('strips control and bidi characters and collapses whitespace', () => {
    expect(sanitizeName(' A\u0000l\u001b[31ma\n\t‮  B\u007f ')).toBe('Al[31ma B')
  })
  test('replaces a hostile colour', () => {
    const u = sanitizeUser({ name: 'Ala', color: HOSTILE_COLOR })
    expect(u.color).toMatch(COLOR_RE)
    expect(u.name).toBe('Ala')
  })
  test('gives a valid user for a non-object, a non-string name and an empty name', () => {
    for (const v of [null, undefined, 5, 'x', [], { name: 5, color: 5 }, { name: ' \n ', color: '#12345' }]) {
      const u = sanitizeUser(v)
      expect(Object.keys(u).sort()).toEqual(['color', 'name'])
      expect(u.name.length).toBeGreaterThan(0)
      expect(u.color).toMatch(COLOR_RE)
    }
  })
})

describe('sanitizeCursor', () => {
  const wire = (v: unknown) => JSON.parse(JSON.stringify(v))
  const pos = (item: unknown) => ({ type: null, tname: 'code', item, assoc: 0 })
  const ok = pos({ client: 1, clock: 0 })

  test('a real position pair survives and resolves to the same index', () => {
    const doc = new Y.Doc()
    const text = doc.getText('code')
    text.insert(0, 'hello')
    for (const [a, h] of [[0, 2], [2, 5], [5, 0]] as const) {
      const out = sanitizeCursor(wire({ anchor: Y.createRelativePositionFromTypeIndex(text, a), head: Y.createRelativePositionFromTypeIndex(text, h) }))!
      expect(Y.createAbsolutePositionFromRelativePosition(Y.createRelativePositionFromJSON(out.anchor), doc)!.index).toBe(a)
      expect(Y.createAbsolutePositionFromRelativePosition(Y.createRelativePositionFromJSON(out.head), doc)!.index).toBe(h)
    }
  })

  test('malformed cursors give null', () => {
    const bad: unknown[] = [
      null, undefined, 5, 'x', {}, { anchor: {}, head: {} }, { anchor: ok }, { anchor: ok, head: null }, { anchor: null, head: null },
      { anchor: ok, head: pos({ client: 1, clock: -1 }) },
      { anchor: ok, head: pos({ client: 1, clock: 1.5 }) },
      { anchor: ok, head: pos({ client: 1, clock: '1' }) },
      { anchor: ok, head: pos({ client: -1, clock: 1 }) },
      { anchor: ok, head: pos({ client: 2 ** 60, clock: 1 }) },
      { anchor: pos(5), head: ok },
      { anchor: ok, head: { type: null, tname: 'code', assoc: 0 } }, // missing item
    ]
    for (const v of bad) expect(sanitizeCursor(v)).toBeNull()
  })

  test('the result is rebuilt: tname is always code, type null, assoc an integer', () => {
    const input = { anchor: { type: { client: 1, clock: 1 }, tname: 'zzz', item: null, assoc: 'x', extra: 1 }, head: { type: null, tname: 5, item: { client: 3, clock: 4, extra: 1 }, assoc: -1 } }
    const out = sanitizeCursor(input)!
    expect(out).toEqual({ anchor: { type: null, tname: 'code', item: null, assoc: 0 }, head: { type: null, tname: 'code', item: { client: 3, clock: 4 }, assoc: -1 } })
    expect(out.anchor).not.toBe(input.anchor as unknown)
  })

  test('accepted outputs never throw in Yjs and add no key to doc.share', () => {
    const doc = new Y.Doc()
    doc.getText('code').insert(0, 'hello')
    doc.getMap('session').set('run', new Y.Map())
    const keys = [...doc.share.keys()].sort()
    const items = [null, { client: doc.clientID, clock: 0 }, { client: doc.clientID, clock: 99 }, { client: 7, clock: 0 }, { client: Number.MAX_SAFE_INTEGER, clock: Number.MAX_SAFE_INTEGER }]
    for (const item of items) for (const tname of ['code', 'zzz', 5]) {
      const out = sanitizeCursor({ anchor: { type: null, tname, item, assoc: 0 }, head: { type: null, tname, item, assoc: 0 } })!
      for (const p of [out.anchor, out.head]) {
        const abs = Y.createAbsolutePositionFromRelativePosition(Y.createRelativePositionFromJSON(p), doc)
        if (abs) expect(Number.isInteger(abs.index)).toBe(true)
      }
    }
    expect([...doc.share.keys()].sort()).toEqual(keys)
  })
})

describe('identity', () => {
  const g = globalThis as { localStorage?: unknown }
  afterEach(() => { delete g.localStorage })
  const fakeStorage = () => {
    const m = new Map<string, string>()
    g.localStorage = { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => { m.set(k, v) } }
    return m
  }
  const expectRandom = (u: { name: string; color: string }) => {
    expect(ANIMALS as readonly string[]).toContain(u.name)
    expect(PEER_COLORS as readonly string[]).toContain(u.color)
  }

  test('save then load round-trips under the key c-oop.user', () => {
    const m = fakeStorage()
    saveIdentity({ name: 'Ala', color: '#376ce9' })
    expect([...m.keys()]).toEqual(['c-oop.user'])
    expect(loadIdentity()).toEqual({ name: 'Ala', color: '#376ce9' })
  })
  test('a hostile stored value comes back sanitised', () => {
    fakeStorage().set('c-oop.user', JSON.stringify({ name: '<b>' + 'x'.repeat(500), color: HOSTILE_COLOR, colorLight: HOSTILE_COLOR }))
    const u = loadIdentity()
    expect(u.name).toBe(('<b>' + 'x'.repeat(500)).slice(0, NAME_MAX))
    expect(PEER_COLORS as readonly string[]).toContain(u.color)
    expect(Object.keys(u).sort()).toEqual(['color', 'name'])
  })
  test('garbage or nothing stored gives a random identity', () => {
    const m = fakeStorage()
    expectRandom(loadIdentity())
    for (const v of ['{', '5', 'null', '{"name":""}']) { m.set('c-oop.user', v); expectRandom(loadIdentity()) }
  })
  test('no localStorage at all: random identity and a silent save', () => {
    expectRandom(loadIdentity())
    expect(() => saveIdentity({ name: 'Ala', color: '#376ce9' })).not.toThrow()
  })
  test('a throwing localStorage: random identity and a silent save', () => {
    const boom = () => { throw new Error('denied') }
    g.localStorage = { getItem: boom, setItem: boom }
    expectRandom(loadIdentity())
    expect(() => saveIdentity({ name: 'Ala', color: '#376ce9' })).not.toThrow()
  })
})

describe('guardAwareness', () => {
  const made: Awareness[] = []
  afterEach(() => { for (const a of made.splice(0)) a.destroy() })
  const aw = (clientID?: number) => {
    const doc = new Y.Doc()
    if (clientID !== undefined) doc.clientID = clientID
    const a = new Awareness(doc)
    made.push(a)
    return a
  }
  const me = { name: 'Ja', color: '#376ce9' }
  const send = (from: Awareness, to: Awareness) => applyAwarenessUpdate(to, encodeAwarenessUpdate(from, [from.clientID]), 'remote')
  const hostile = { user: { name: '<img src=x onerror=alert(1)>', color: HOSTILE_COLOR, colorLight: HOSTILE_COLOR }, cursor: { anchor: null, head: null } }

  test('a hostile remote state is sanitised before any later listener sees it', () => {
    const victim = aw(), peer = aw()
    guardAwareness(victim, () => me)
    const seen: unknown[] = []
    victim.on('change', () => seen.push(structuredClone(victim.getStates().get(peer.clientID))))
    peer.setLocalState(hostile)
    send(peer, victim)
    expect(seen).toEqual([{ user: { name: hostile.user.name.slice(0, NAME_MAX), color: '#0d7da2' } }])
  })

  test('a valid remote cursor is kept, rebuilt', () => {
    const victim = aw(), peer = aw()
    guardAwareness(victim, () => me)
    const p = { type: null, tname: 'evil', item: { client: 1, clock: 2 }, assoc: 0 }
    peer.setLocalState({ user: { name: 'Ala', color: '#e02636' }, cursor: { anchor: p, head: p } })
    send(peer, victim)
    const good = { ...p, tname: 'code' }
    expect(victim.getStates().get(peer.clientID)).toEqual({ user: { name: 'Ala', color: '#e02636' }, cursor: { anchor: good, head: good } })
  })

  test('a remote state that is not an object becomes an empty one', () => {
    const victim = aw(), peer = aw()
    guardAwareness(victim, () => me)
    for (const s of [5, 'x', [1]]) {
      peer.setLocalState(s as never)
      send(peer, victim)
      expect(victim.getStates().get(peer.clientID)).toEqual({ user: sanitizeUser(undefined) })
    }
  })

  test('a forged update for the own id leaves the own user and no cursor', () => {
    const victim = aw(1234), forger = aw(1234)
    guardAwareness(victim, () => me)
    victim.setLocalState({ user: me })
    forger.setLocalState(hostile)
    forger.setLocalState(hostile) // a clock above the victim's
    send(forger, victim)
    expect(victim.getLocalState()).toEqual({ user: me })
  })

  test('a local setLocalStateField is not touched', () => {
    const a = aw()
    guardAwareness(a, () => me)
    a.setLocalState({ user: me })
    a.setLocalStateField('user', hostile.user)
    a.setLocalStateField('cursor', { anchor: {}, head: {} })
    expect(a.getLocalState()).toEqual({ user: hostile.user, cursor: { anchor: {}, head: {} } })
  })
})

describe('createConnWatch', () => {
  const STUCK = 12_000, FORGET = 12_000
  const off = (id: string) => ({ id, connected: false })
  const on = (id: string) => ({ id, connected: true })

  test('a peer that connects in time is never stuck', () => {
    const w = createConnWatch(STUCK, FORGET)
    expect(w(0, [off('a')])).toEqual({ connected: 0, stuck: 0 })
    expect(w(11_999, [off('a')])).toEqual({ connected: 0, stuck: 0 })
    expect(w(12_000, [on('a')])).toEqual({ connected: 1, stuck: 0 })
    expect(w(60_000, [on('a')])).toEqual({ connected: 1, stuck: 0 })
  })
  test('a peer that never connects is stuck after stuckMs', () => {
    const w = createConnWatch(STUCK, FORGET)
    w(0, [off('a'), on('b')])
    expect(w(11_999, [off('a'), on('b')])).toEqual({ connected: 1, stuck: 0 })
    expect(w(12_000, [off('a'), on('b')])).toEqual({ connected: 1, stuck: 1 })
  })
  test('reconnect cycles under a stable id with short gaps keep it stuck', () => {
    const w = createConnWatch(STUCK, FORGET)
    w(0, [off('a')])
    expect(w(48_000, [off('a')]).stuck).toBe(1)
    expect(w(50_000, []).stuck).toBe(1)
    expect(w(59_999, []).stuck).toBe(1)
    expect(w(60_000 - 1, [off('a')]).stuck).toBe(1) // back within forgetMs: `since` kept, stuck at once
    expect(w(70_000, []).stuck).toBe(1)
    expect(w(71_000, [off('a')]).stuck).toBe(1)
  })
  test('a stuck id that disappears is counted until forgetMs has passed', () => {
    const w = createConnWatch(STUCK, FORGET)
    w(0, [off('a')])
    expect(w(20_000, [off('a')]).stuck).toBe(1)
    expect(w(31_999, []).stuck).toBe(1)
    expect(w(32_000, []).stuck).toBe(0)
  })
  test('a connected peer that disappears lowers connected at once', () => {
    const w = createConnWatch(STUCK, FORGET)
    expect(w(0, [on('a'), on('b')]).connected).toBe(2)
    expect(w(1, [on('b')])).toEqual({ connected: 1, stuck: 0 })
  })
  test('an id that returns after it was forgotten needs stuckMs again', () => {
    const w = createConnWatch(STUCK, FORGET)
    w(0, [off('a')])
    w(20_000, [off('a')])
    expect(w(32_000, []).stuck).toBe(0)
    expect(w(33_000, [off('a')]).stuck).toBe(0)
    expect(w(44_999, [off('a')]).stuck).toBe(0)
    expect(w(45_000, [off('a')]).stuck).toBe(1)
  })
})

describe('createRetry', () => {
  const on = (id: string) => ({ id, connected: true })
  const off = (id: string) => ({ id, connected: false })

  test('an unconnected id is returned after 48 s, then 96, 192, 384 and 384 s again', () => {
    const r = createRetry(48_000, 3)
    let t = 0
    for (const wait of [48_000, 96_000, 192_000, 384_000, 384_000]) {
      expect(r(t, [off('a')])).toEqual([]) // a new connection object: the wait starts here
      expect(r(t + wait - 1, [off('a')])).toEqual([])
      expect(r(t + wait, [off('a')])).toEqual(['a'])
      t += wait + 2000
    }
  })
  test('a connected id resets the wait, and ids wait independently', () => {
    const r = createRetry(48_000, 3)
    r(0, [off('a')])
    expect(r(48_000, [off('a'), off('b')])).toEqual(['a'])
    expect(r(50_000, [on('a'), off('b')])).toEqual([])
    r(60_000, [off('a'), off('b')])
    expect(r(96_000, [off('a'), off('b')])).toEqual(['b'])
    expect(r(107_999, [off('a')])).toEqual([])
    expect(r(108_000, [off('a')])).toEqual(['a']) // 48 s again, not 96
  })
})
