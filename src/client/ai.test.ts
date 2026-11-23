import { describe, expect, jest, test } from 'bun:test'
import type * as Y from 'yjs'
import type { AiReply, AiRequest } from '../shared/contracts'
import { AI } from '../shared/limits'
import { aiWindow, createAi, doubleControl, indentCode, parseTrigger, TRIGGER_LINE } from './ai'

describe('parseTrigger', () => {
  test('reads the indentation and the prompt', () => {
    expect(parseTrigger('??? x')).toEqual({ indent: '', prompt: 'x' })
    expect(parseTrigger('    ??? declare answer')).toEqual({ indent: '    ', prompt: 'declare answer' })
    expect(parseTrigger('\t??? x')).toEqual({ indent: '\t', prompt: 'x' })
    expect(parseTrigger('???   sort the vector  \t')).toEqual({ indent: '', prompt: 'sort the vector' })
  })
  test('null for everything else', () => {
    for (const line of ['???', '??? ', '???x', '???? x', 'int a; ??? x', '']) expect(parseTrigger(line)).toBeNull()
  })
  test('TRIGGER_LINE matches a prompt still being typed', () => {
    expect(TRIGGER_LINE.test('  ???')).toBe(true)
    expect(TRIGGER_LINE.test('int a; ???')).toBe(false)
  })
})

describe('aiWindow', () => {
  test('a middle line goes with its line break', () => {
    expect(aiWindow('a\n??? x\nb\n', 2, 7)).toEqual({ before: 'a\n', after: 'b\n', cut: [false, false], del: { from: 2, to: 8 } })
  })
  test('the first line', () => {
    expect(aiWindow('??? x\nb\n', 0, 5)).toEqual({ before: '', after: 'b\n', cut: [false, false], del: { from: 0, to: 6 } })
  })
  test('the last line without a line break', () => {
    expect(aiWindow('a\n??? x', 2, 7)).toEqual({ before: 'a\n', after: '', cut: [false, false], del: { from: 2, to: 7 } })
  })
  test('a doc longer than both caps is cut on both sides', () => {
    const head = 'a'.repeat(AI.beforeMax + 5) + '\n'
    const w = aiWindow(head + '??? x\n' + 'b'.repeat(AI.afterMax + 5), head.length, head.length + 5)
    expect(w.cut).toEqual([true, true])
    expect(w.before).toBe('a'.repeat(AI.beforeMax - 1) + '\n')
    expect(w.after).toBe('b'.repeat(AI.afterMax))
    expect(w.del).toEqual({ from: head.length, to: head.length + 6 })
  })
  test('a doc exactly at the caps is not cut', () => {
    const head = 'a'.repeat(AI.beforeMax)
    expect(aiWindow(head + '??? x\n' + 'b'.repeat(AI.afterMax), head.length, head.length + 5).cut).toEqual([false, false])
  })
})

test('indentCode: every non-empty line gets the indentation, blank lines stay empty', () => {
  expect(indentCode('int a;\n\nif (a) {\n    a++;\n}', '  ')).toBe('  int a;\n\n  if (a) {\n      a++;\n  }')
  expect(indentCode('int a;', '')).toBe('int a;')
})

describe('doubleControl', () => {
  const down = (key: string, repeat = false) => ({ type: 'keydown', key, repeat })
  const up = (key: string) => ({ type: 'keyup', key })
  // Feeds [event, time] pairs and returns the times at which the detector fired.
  const fired = (...events: [{ type: string; key?: string; repeat?: boolean }, number][]) => {
    const feed = doubleControl(400)
    return events.filter(([e, at]) => feed(e, at)).map(([, at]) => at)
  }
  const tap = (at: number): [{ type: string; key?: string; repeat?: boolean }, number][] => [[down('Control'), at], [up('Control'), at + 50]]

  test('two taps inside the window fire once, on the second release', () => {
    expect(fired(...tap(0), ...tap(200))).toEqual([250])
  })
  test('a third tap alone does not fire, a fourth does', () => {
    expect(fired(...tap(0), ...tap(100), ...tap(200))).toEqual([150])
    expect(fired(...tap(0), ...tap(100), ...tap(200), ...tap(300))).toEqual([150, 350])
  })
  test('too slow: the late tap counts as a first one', () => {
    expect(fired(...tap(0), ...tap(500))).toEqual([])
    expect(fired(...tap(0), ...tap(500), ...tap(600))).toEqual([650])
  })
  test('a letter between', () => {
    expect(fired(...tap(0), [down('a'), 100], [up('a'), 120], ...tap(200))).toEqual([])
  })
  test('a Ctrl+Enter chord is no tap', () => {
    const chord = (at: number): [{ type: string; key?: string }, number][] =>
      [[down('Control'), at], [down('Enter'), at + 10], [up('Enter'), at + 20], [up('Control'), at + 30]]
    expect(fired(...chord(0), ...chord(100))).toEqual([])
    expect(fired(...tap(0), ...chord(100))).toEqual([])
    expect(fired(...chord(0), ...tap(100))).toEqual([])
  })
  test('repeat keydowns do not restart the press', () => {
    // Held for 600 ms with auto-repeat: without the repeat check the last repeat would make it look short.
    expect(fired(...tap(0), [down('Control'), 100], [down('Control', true), 600], [up('Control'), 700])).toEqual([])
    expect(fired(...tap(0), [down('Control'), 100], [down('Control', true), 130], [up('Control'), 150])).toEqual([150])
  })
  test('a Control held longer than the window is no tap', () => {
    expect(fired([down('Control'), 0], [up('Control'), 500], ...tap(600))).toEqual([])
    expect(fired(...tap(0), [down('Control'), 100], [up('Control'), 501])).toEqual([])
  })
  test('pointerdown between', () => {
    expect(fired(...tap(0), [{ type: 'pointerdown' }, 100], ...tap(200))).toEqual([])
    expect(fired([down('Control'), 0], [{ type: 'pointerdown' }, 10], [up('Control'), 20], ...tap(100))).toEqual([])
  })
  test('blur between', () => {
    expect(fired(...tap(0), [{ type: 'blur' }, 100], ...tap(200))).toEqual([])
  })
  test('AltGr arrives as Control then AltGraph and is no tap', () => {
    const altGr = (at: number): [{ type: string; key?: string }, number][] =>
      [[down('Control'), at], [down('AltGraph'), at], [up('Control'), at + 40], [up('AltGraph'), at + 40]]
    expect(fired(...altGr(0), ...altGr(100))).toEqual([])
    expect(fired(...tap(0), ...altGr(100))).toEqual([])
  })
})

describe('createAi', () => {
  const AT = { at: 1 } as unknown as Y.RelativePosition
  const REQUEST: AiRequest = { prompt: 'x', before: '', after: '', cut: [false, false] }
  const job = (cut: [boolean, boolean] = [false, false]) => ({ request: { ...REQUEST, cut }, indent: '  ', at: AT })
  // A machine whose post() waits for reply() or fail(), with everything it was asked to do recorded.
  function setup() {
    const posted: AiRequest[] = [], inserted: [Y.RelativePosition, string][] = []
    const room = { ok: true } // what the editor's insert() answers
    let settle!: { resolve(r: AiReply): void; reject(e: unknown): void }
    let changes = 0
    const ai = createAi({
      post: r => { posted.push(r); return new Promise<AiReply>((resolve, reject) => { settle = { resolve, reject } }) },
      insert: (at, code) => { inserted.push([at, code]); return room.ok },
      onChange: () => { changes++ },
    })
    const reply = async (r: AiReply) => { settle.resolve(r); await Promise.resolve() }
    const fail = async () => { settle.reject(new Error('network')); await Promise.resolve() }
    return { ai, posted, inserted, room, reply, fail, changes: () => changes }
  }

  test('working, then ready, then inserted with the indented code at the job\'s position', async () => {
    const m = setup()
    expect(m.ai.view()).toEqual({ state: 'idle' })
    expect(m.ai.accepts('x')).toBe(true)
    m.ai.submit(job())
    expect(m.ai.view()).toEqual({ state: 'working', partial: false, nudge: 0 })
    expect(m.posted).toEqual([REQUEST])
    await m.reply({ code: 'int a;\n\nint b;' })
    expect(m.ai.view()).toEqual({ state: 'ready', nudge: 0 })
    m.ai.insert()
    expect(m.inserted).toEqual([[AT, '  int a;\n\n  int b;']])
    expect(m.ai.view()).toEqual({ state: 'idle', last: 'inserted' })
    expect(m.changes()).toBe(3)
  })
  test('partial when either side of the window was cut', () => {
    for (const cut of [[true, false], [false, true]] as [boolean, boolean][]) {
      const m = setup()
      m.ai.submit(job(cut))
      expect(m.ai.view()).toEqual({ state: 'working', partial: true, nudge: 0 })
    }
  })
  test('insert() and press() insert nothing unless ready; press() inserts when ready', async () => {
    const m = setup()
    m.ai.insert()
    m.ai.press()
    m.ai.submit(job())
    m.ai.insert()
    m.ai.press()
    expect(m.inserted).toEqual([])
    expect(m.ai.view().state).toBe('working')
    await m.reply({ code: 'a' })
    m.ai.press()
    expect(m.inserted).toEqual([[AT, '  a']])
    expect(m.ai.view()).toEqual({ state: 'idle', last: 'inserted' })
  })
  test('escape() discards only when ready', async () => {
    const m = setup()
    expect(m.ai.escape()).toBe(false)
    m.ai.submit(job())
    expect(m.ai.escape()).toBe(false)
    expect(m.ai.view().state).toBe('working')
    await m.reply({ code: 'a' })
    expect(m.ai.escape()).toBe(true)
    expect(m.ai.view()).toEqual({ state: 'idle', last: 'discarded' })
    m.ai.insert()
    expect(m.inserted).toEqual([])
    expect(m.ai.escape()).toBe(false)
  })
  test('another prompt is turned away while working and while ready, and raises nudge', async () => {
    const m = setup()
    m.ai.submit(job())
    expect(m.ai.accepts('y')).toBe(false)
    expect(m.ai.view()).toEqual({ state: 'working', partial: false, nudge: 1 })
    await m.reply({ code: 'a' })
    expect(m.ai.view()).toEqual({ state: 'ready', nudge: 0 })
    expect(m.ai.accepts('y')).toBe(false)
    expect(m.ai.accepts('y')).toBe(false)
    expect(m.ai.view()).toEqual({ state: 'ready', nudge: 2 })
    expect(m.posted.length).toBe(1)
  })
  test('a prompt over the cap fails with "prompt" and posts nothing', () => {
    const m = setup()
    expect(m.ai.accepts('p'.repeat(AI.promptMax))).toBe(true)
    expect(m.ai.accepts('p'.repeat(AI.promptMax + 1))).toBe(false)
    expect(m.ai.view()).toEqual({ state: 'failed', why: 'prompt' })
    expect(m.posted).toEqual([])
  })
  test('an error reply and a rejected post each end in failed', async () => {
    const a = setup()
    a.ai.submit(job())
    await a.reply({ error: 'day-limit' })
    expect(a.ai.view()).toEqual({ state: 'failed', why: 'day-limit' })

    const b = setup()
    b.ai.submit(job())
    await b.fail()
    expect(b.ai.view()).toEqual({ state: 'failed', why: 'failed' })
  })
  test('a refused insert keeps the result: it is still ready, says so again, and goes in once there is room', async () => {
    const m = setup()
    m.room.ok = false
    m.ai.submit(job())
    await m.reply({ code: 'a' })
    m.ai.insert()
    expect(m.ai.view()).toEqual({ state: 'ready', nudge: 1, noRoom: true })
    m.ai.press()
    expect(m.ai.view()).toEqual({ state: 'ready', nudge: 2, noRoom: true })
    expect(m.ai.accepts('y')).toBe(false) // still one request at a time
    m.room.ok = true
    m.ai.insert()
    expect(m.inserted).toEqual([[AT, '  a'], [AT, '  a'], [AT, '  a']])
    expect(m.ai.view()).toEqual({ state: 'idle', last: 'inserted' })
  })
  test('failed is dismissed by press(), or by itself after AI.failedMs', async () => {
    jest.useFakeTimers()
    try {
      const m = setup()
      m.ai.accepts('p'.repeat(AI.promptMax + 1))
      m.ai.press()
      expect(m.ai.view()).toEqual({ state: 'idle' })
      m.ai.accepts('p'.repeat(AI.promptMax + 1))
      jest.advanceTimersByTime(AI.failedMs - 1)
      expect(m.ai.view().state).toBe('failed')
      jest.advanceTimersByTime(1)
      expect(m.ai.view()).toEqual({ state: 'idle' })
    } finally { jest.useRealTimers() }
  })
  test('a request accepted from failed is still working after AI.failedMs: the old timer was cleared', () => {
    jest.useFakeTimers()
    try {
      const m = setup()
      m.ai.accepts('p'.repeat(AI.promptMax + 1))
      expect(m.ai.accepts('x')).toBe(true)
      m.ai.submit(job())
      jest.advanceTimersByTime(AI.failedMs + 1)
      expect(m.ai.view()).toEqual({ state: 'working', partial: false, nudge: 0 })
    } finally { jest.useRealTimers() }
  })
})
