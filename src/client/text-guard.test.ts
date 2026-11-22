import { EditorSelection, EditorState, type Transaction } from '@codemirror/state'
import { expect, test } from 'bun:test'
import { ySyncAnnotation } from 'y-codemirror.next'
import * as Y from 'yjs'
import { CODE_MAX } from '../shared/limits'
import { codeLimit, guardText } from './text-guard'

const WIRE = 'wire'
const microtasks = () => new Promise<void>(resolve => queueMicrotask(resolve))

// A peer that runs the guard. `mirror` stands in for the editor: an observer registered after the guard that maps
// each delta the way y-codemirror.next's y-sync.js does (positions count through the old text; inserts do not move them).
function guarded(stored?: Uint8Array) {
  const doc = new Y.Doc()
  const text = doc.getText('code')
  const p = { doc, text, trims: 0, mirror: '', nonStrings: [] as unknown[] }
  guardText(text, () => p.trims++)
  text.observe(event => {
    let pos = 0, next = ''
    for (const d of event.delta) {
      if (d.insert != null) {
        if (typeof d.insert === 'string') next += d.insert
        else p.nonStrings.push(d.insert)
      } else if (d.delete != null) pos += d.delete
      else {
        next += p.mirror.slice(pos, pos + d.retain!)
        pos += d.retain!
      }
    }
    p.mirror = next + p.mirror.slice(pos)
  })
  if (stored) Y.applyUpdate(doc, stored, WIRE)
  return p
}

// A peer without the guard: an old or modified client.
function attacker(from?: Y.Doc) {
  const doc = new Y.Doc()
  if (from) Y.applyUpdate(doc, Y.encodeStateAsUpdate(from), WIRE)
  return { doc, text: doc.getText('code') }
}

function link(a: Y.Doc, b: Y.Doc) {
  for (const [x, y] of [[a, b], [b, a]] as const) {
    x.on('update', (u: Uint8Array, origin: unknown) => { if (origin !== WIRE) Y.applyUpdate(y, u, WIRE) })
    Y.applyUpdate(y, Y.encodeStateAsUpdate(x), WIRE)
  }
}

/** The text holds strings only, without formatting, and the editor's copy equals it. */
function expectClean(p: ReturnType<typeof guarded>, want: string) {
  expect(p.text.toString()).toBe(want)
  expect(p.text.length).toBe(want.length)
  expect(p.text.toDelta()).toEqual(want ? [{ insert: want }] : [])
  expect(p.mirror).toBe(want)
  expect(p.nonStrings).toEqual([])
}

test('plain edits pass through, local and remote', () => {
  const v = guarded(), a = attacker()
  link(v.doc, a.doc)
  v.text.insert(0, 'hello')
  a.text.insert(5, ' world')
  a.text.delete(0, 1)
  expectClean(v, 'ello world')
  expect(v.trims).toBe(0)
})

test('an embed from a peer never reaches the editor and is removed for everyone', () => {
  const v = guarded(), a = attacker()
  link(v.doc, a.doc)
  v.text.insert(0, 'int main() {}')
  a.text.insertEmbed(4, { evil: true })
  expectClean(v, 'int main() {}')
  expect(a.text.toDelta()).toEqual([{ insert: 'int main() {}' }])
  a.text.insert(4, 'x') // the document still works on both sides
  v.text.insert(0, 'y')
  expectClean(v, 'yint xmain() {}')
  expect(a.text.toString()).toBe('yint xmain() {}')
})

test('an embed in the same transaction as text leaves the text', () => {
  const v = guarded(), a = attacker()
  link(v.doc, a.doc)
  v.text.insert(0, 'abc')
  a.doc.transact(() => {
    a.text.insert(1, 'X')
    a.text.insertEmbed(2, { evil: true })
    a.text.insert(3, 'Y')
    a.text.delete(5, 1)
  })
  expectClean(v, 'aXYb')
})

test('text typed after an embed, in a later update, lands in the right place', () => {
  const v = guarded(), a = attacker()
  v.text.insert(0, 'abc')
  Y.applyUpdate(a.doc, Y.encodeStateAsUpdate(v.doc), WIRE)
  const updates: Uint8Array[] = []
  a.doc.on('update', (u: Uint8Array) => updates.push(u))
  a.text.insertEmbed(1, { evil: true })
  a.text.insert(2, 'X') // right after the embed, before the attacker has seen it removed
  a.text.insert(0, 'Y')
  for (const u of updates) Y.applyUpdate(v.doc, u, WIRE)
  expectClean(v, 'YaXbc')
})

test('an embed in the stored copy is removed when the copy loads', () => {
  const a = attacker()
  a.text.insert(0, 'abc')
  a.text.insertEmbed(1, { evil: true })
  const v = guarded(Y.encodeStateAsUpdate(a.doc))
  expectClean(v, 'abc')
})

test('a nested shared type and content that is not text at all are removed like an embed', () => {
  const v = guarded(), a = attacker()
  link(v.doc, a.doc)
  v.text.insert(0, 'abc')
  a.text.insertEmbed(1, new Y.Map())
  expectClean(v, 'abc')
  // another document that uses the same name as a list: its items become children of the text
  const forged = new Y.Doc()
  forged.getArray('code').push([1, { two: 2 }, 'three'])
  Y.applyUpdate(v.doc, Y.encodeStateAsUpdate(forged), WIRE)
  expectClean(v, 'abc')
  v.text.insert(3, 'd')
  expectClean(v, 'abcd')
})

test('formatting is removed and the text under it stays', () => {
  const v = guarded(), a = attacker()
  link(v.doc, a.doc)
  v.text.insert(0, 'abcdef')
  a.text.format(1, 3, { bold: true })
  expectClean(v, 'abcdef')
  a.text.insert(2, 'X', { italic: true })
  expectClean(v, 'abXcdef')
  v.text.insert(7, '!')
  v.text.insert(0, '>')
  expectClean(v, '>abXcdef!')
  expect(a.text.toDelta()).toEqual([{ insert: '>abXcdef!' }])
})

test('after an embed was removed, inserts by index still land where the text says', () => {
  const v = guarded(), a = attacker()
  link(v.doc, a.doc)
  // pieces from two clients cannot merge, so Yjs caches positions inside the text
  for (let i = 0; i < 20; i++) (i % 2 ? v : a).text.insert(i * 10, '0123456789')
  v.text.insert(150, 'm')
  v.text.insert(151, 'n')
  v.text.insertEmbed(40, { evil: true })
  let want = v.text.toString()
  for (const i of [199, 41, 40, 39, 0, 120, want.length]) {
    v.text.insert(i, '#')
    want = want.slice(0, i) + '#' + want.slice(i)
    expect(v.text.toString()).toBe(want)
    expect(v.mirror).toBe(want)
  }
})

test('text beyond CODE_MAX from a peer is cut for everyone, and the notice is asked for once', async () => {
  const v = guarded(), a = attacker()
  link(v.doc, a.doc)
  v.text.insert(0, 'abc')
  a.text.insert(3, 'x'.repeat(CODE_MAX + 50))
  await microtasks()
  expectClean(v, 'abc' + 'x'.repeat(CODE_MAX - 3))
  expect(a.text.length).toBe(CODE_MAX)
  expect(v.trims).toBe(1)
  v.text.insert(0, 'y') // every later edit past the limit is cut again
  await microtasks()
  expect(v.text.length).toBe(CODE_MAX)
  expect(v.mirror).toBe(v.text.toString())
  expect(v.trims).toBe(2)
})

test('a local insert beyond CODE_MAX is cut the same way, after the transaction that made it', async () => {
  const v = guarded()
  v.text.insert(0, 'x'.repeat(CODE_MAX - 2))
  v.text.insert(0, 'abcd')
  expect(v.text.length).toBe(CODE_MAX + 2) // not inside the editor's own update
  await microtasks()
  expect(v.text.length).toBe(CODE_MAX)
  expect(v.text.toString().startsWith('abcdxx')).toBe(true)
  expect(v.mirror).toBe(v.text.toString())
  expect(v.trims).toBe(1)
})

test('a stored copy beyond CODE_MAX is cut when it loads', async () => {
  const a = attacker()
  a.text.insert(0, 'y'.repeat(CODE_MAX + 1))
  const v = guarded(Y.encodeStateAsUpdate(a.doc))
  await microtasks()
  expectClean(v, 'y'.repeat(CODE_MAX))
})

test('two peers that cut at the same moment end with the same text and stop there', async () => {
  const v = guarded(), w = guarded(), a = attacker()
  v.text.insert(0, 'v'.repeat(10))
  Y.applyUpdate(w.doc, Y.encodeStateAsUpdate(v.doc), WIRE)
  Y.applyUpdate(a.doc, Y.encodeStateAsUpdate(v.doc), WIRE)
  a.text.insert(5, 'x'.repeat(CODE_MAX))
  const big = Y.encodeStateAsUpdate(a.doc)
  Y.applyUpdate(v.doc, big, WIRE)
  Y.applyUpdate(w.doc, big, WIRE)
  await microtasks()
  link(v.doc, w.doc)
  await microtasks()
  expect(v.text.length).toBe(CODE_MAX)
  expect(w.text.toString()).toBe(v.text.toString())
  expect([v.trims, w.trims]).toEqual([1, 1])
})

test('neither the cut nor the removal lands on the undo stack', async () => {
  const v = guarded(), a = attacker()
  const undo = new Y.UndoManager(v.text)
  link(v.doc, a.doc)
  a.text.insertEmbed(0, { evil: true })
  a.text.insert(0, 'x'.repeat(CODE_MAX + 1))
  await microtasks()
  expect(v.text.length).toBe(CODE_MAX)
  expect(undo.undoStack.length).toBe(0)
})

test('the removal leaves the client id alone when another observer of the same update writes to the document', () => {
  const v = guarded(), a = attacker()
  link(v.doc, a.doc)
  v.text.insert(0, 'abc')
  // what the runner of a program does when an input line arrives: it answers with a write of its own
  v.doc.getArray('in').observe((_, tr) => { if (tr.origin === WIRE) v.doc.getArray('out').push(['echo']) })
  const id = v.doc.clientID
  a.doc.transact(() => {
    a.text.insertEmbed(1, { evil: true })
    a.doc.getArray('in').push(['line'])
  })
  expect(v.doc.clientID).toBe(id)
  expectClean(v, 'abc')
  expect(a.doc.getArray('out').toArray()).toEqual(['echo'])
})

test('an ordinary edit, local or remote, is checked without reading the event delta or walking the text', () => {
  const doc = new Y.Doc(), text = doc.getText('code'), a = attacker()
  guardText(text, () => {})
  // Counted from the moment Yjs starts calling observers until the observer after the guard runs: the guard's own reads.
  let watching = false, deltaReads = 0, walks = 0, start = text._start
  doc.on('beforeObserverCalls', () => { watching = true })
  text.observe(() => { watching = false })
  doc.on('afterTransaction', () => { watching = false }) // a transaction that did not touch the text
  const delta = Object.getOwnPropertyDescriptor(Y.YTextEvent.prototype, 'delta')!
  Object.defineProperty(Y.YTextEvent.prototype, 'delta', { ...delta, get() { if (watching) deltaReads++; return delta.get!.call(this) } })
  Object.defineProperty(text, '_start', { get: () => { if (watching) walks++; return start }, set: v => { start = v } })
  try {
    link(doc, a.doc)
    for (let i = 0; i < 40; i++) (i % 2 ? text : a.text).insert(i >> 1, 'x') // many pieces, from both sides
    text.delete(3, 2)
    a.text.delete(0, 1)
    expect(text.length).toBe(37)
    expect([deltaReads, walks]).toEqual([0, 0])
    a.text.insertEmbed(5, { evil: true }) // and the spies do see a check that reads the delta
    expect(text.toDelta()).toEqual([{ insert: 'x'.repeat(37) }])
    expect(deltaReads).toBeGreaterThan(0)
  } finally {
    Object.defineProperty(Y.YTextEvent.prototype, 'delta', delta)
  }
})

test('an entry stored under a key of the text, as another document would store it in a map, is removed', () => {
  const v = guarded(), a = attacker()
  link(v.doc, a.doc)
  v.text.insert(0, 'abc')
  const forged = new Y.Doc()
  forged.getMap('code').set('k', 'V'.repeat(1000))
  forged.getMap('code').set('t', new Y.Text('nested'))
  // A map stores no value as plain string content; an update written by hand can, and that one looks like text.
  forged.transact(tr => new Y.Item(Y.createID(forged.clientID, Y.getState(forged.store, forged.clientID)), null, null, null, null, forged.getMap('code'), 's', new Y.ContentString('S'.repeat(1000))).integrate(tr, 0))
  expect(forged.getMap('code').size).toBe(3)
  link(v.doc, forged)
  expectClean(v, 'abc')
  expect(forged.getMap('code').size).toBe(0)
  expect(Y.encodeStateAsUpdate(v.doc).length).toBeLessThan(200)
})

/** Puts an embed whose payload is a string at the end of `text`. insertEmbed would store a string as text; an update written by hand need not. */
function appendStringEmbed(text: Y.Text, payload: string) {
  const doc = text.doc!
  doc.transact(tr => {
    let last = text._start!
    while (last.right) last = last.right
    new Y.Item(Y.createID(doc.clientID, Y.getState(doc.store, doc.clientID)), last, last.lastId, null, null, text, null, new Y.ContentEmbed(payload)).integrate(tr, 0)
  })
}

test('an embed that holds a string is removed like any other, and the editor is not given its string as text', () => {
  const v = guarded(), a = attacker()
  link(v.doc, a.doc)
  v.text.insert(0, 'abc')
  appendStringEmbed(a.text, 'EVIL')
  expectClean(v, 'abc')
  // between text of the same change: the editor gets the text, in one piece, and nothing of the embeds
  a.doc.transact(() => {
    a.text.insert(3, 'de')
    appendStringEmbed(a.text, 'EVIL')
    appendStringEmbed(a.text, '')
    a.text.insert(a.text.length, 'fg')
    a.text.delete(0, 1)
  })
  expectClean(v, 'bcdefg')
  expect(a.text.toDelta()).toEqual([{ insert: 'bcdefg' }])
})

test('text with a carriage return is removed: CodeMirror would count "\\r\\n" as one char and every later index would be off', () => {
  const v = guarded(), a = attacker()
  link(v.doc, a.doc)
  v.text.insert(0, 'abc')
  a.doc.transact(() => {
    a.text.insert(1, 'x\r\ny')
    a.text.insert(a.text.length, 'd')
  })
  expectClean(v, 'abcd')
  expect(a.text.toString()).toBe('abcd')
})

test('what arrives already deleted, or already collected, is left alone', () => {
  const v = guarded(), a = attacker()
  v.text.insert(0, 'abc')
  Y.applyUpdate(a.doc, Y.encodeStateAsUpdate(v.doc), WIRE)
  a.text.insertEmbed(1, { evil: true })
  a.text.insertEmbed(2, new Y.Text('nested')) // deleted below, which leaves a collected struct for its content
  a.text.delete(1, 2)
  let updates = 0
  v.doc.on('update', () => updates++)
  Y.applyUpdate(v.doc, Y.encodeStateAsUpdate(a.doc), WIRE)
  expectClean(v, 'abc')
  expect(updates).toBe(1) // the guard wrote nothing
})

test('whatever peers write, in whatever order their updates arrive, the text holds strings only after every one', () => {
  // mulberry32: all of its bits are random. The low bits of a linear congruential generator repeat after a few
  // draws, and `% n` reads those, so half of the moves below would hardly run.
  let seed = 12345
  const rnd = (n: number) => {
    let t = (seed = (seed + 0x6d2b79f5) | 0)
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) % n
  }
  const v = guarded()
  // Three clients without the guard, and three documents that use the name `code` for another type.
  const writers = [attacker(), attacker(), attacker()]
  const list = new Y.Doc(), map = new Y.Doc(), xml = new Y.Doc()
  const queue: Uint8Array[] = []
  for (const doc of [...writers.map(w => w.doc), list, map, xml]) {
    doc.on('update', (u: Uint8Array, origin: unknown) => { if (origin !== WIRE) queue.push(u) })
    v.doc.on('update', (u: Uint8Array) => Y.applyUpdate(doc, u, WIRE))
  }
  v.text.insert(0, 'int main() {}')
  const moves: ((t: Y.Text) => void)[] = [
    t => t.insert(rnd(t.length + 1), 'abc'.slice(rnd(3))),
    t => t.insert(rnd(t.length + 1), 'B', { bold: true }),
    t => t.insertEmbed(rnd(t.length + 1), { evil: rnd(9) }),
    t => t.insertEmbed(rnd(t.length + 1), rnd(2) ? new Y.Map([['k', 1]]) : new Y.Text('nested')),
    t => t.length && t.delete(rnd(t.length), 1 + rnd(3)),
    t => t.length && t.format(rnd(t.length), 1 + rnd(4), { italic: rnd(2) ? true : null }),
    () => list.getArray('code').insert(rnd(list.getArray('code').length + 1), [[1, new Uint8Array(2), { j: 1 }, new Y.Doc()][rnd(4)]]),
    () => map.getMap('code').set('k' + rnd(3), rnd(2) ? 'value' : new Y.Text('t')),
    () => xml.getXmlFragment('code').insert(0, [rnd(2) ? new Y.XmlElement('b') : new Y.XmlText('t')]),
    () => own++,
  ]
  // What the guarded peer types itself, after the writer's transaction: an update that Yjs applies inside a local
  // transaction makes that one remote, and the writer would get a new client id (and Yjs prints a warning each time).
  let own = 0
  const ran = moves.map(() => 0)
  for (let round = 0; round < 400; round++) {
    const w = writers[rnd(3)]!
    w.doc.transact(() => {
      for (let n = 1 + rnd(3); n > 0; n--) {
        const move = rnd(moves.length)
        ran[move]!++
        moves[move]!(w.text)
      }
    })
    for (; own; own--) v.text.insert(rnd(v.text.length + 1), 'v')
    // delivered out of order: an update whose predecessor is still in the queue waits inside Yjs and is integrated with it later
    while (queue.length > rnd(4)) {
      Y.applyUpdate(v.doc, queue.splice(rnd(queue.length), 1)[0]!, WIRE)
      for (let item = v.text._start; item; item = item.right) if (!item.deleted && !(item.content instanceof Y.ContentString)) throw new Error(`round ${round}: ${item.content.constructor.name} left in the text`)
      for (const item of v.text._map.values()) if (!item.deleted) throw new Error(`round ${round}: an entry left under a key`)
      if (v.mirror !== v.text.toString()) throw new Error(`round ${round}: the editor's copy differs from the text`)
    }
  }
  for (const u of queue) Y.applyUpdate(v.doc, u, WIRE)
  expect(Math.min(...ran)).toBeGreaterThanOrEqual(40) // 80 on average
  expect(v.nonStrings).toEqual([])
  expect(v.text.toDelta().length).toBeLessThanOrEqual(1)
  expect(v.mirror).toBe(v.text.toString())
  for (const w of writers) expect(w.text.toDelta()).toEqual(v.text.toDelta())
})

test('the cut does not split a surrogate pair', async () => {
  const v = guarded(), a = attacker()
  link(v.doc, a.doc)
  a.text.insert(0, 'x'.repeat(CODE_MAX - 1) + '\u{1f600}tail')
  await microtasks()
  expectClean(v, 'x'.repeat(CODE_MAX - 1))
  expect(a.text.toString()).toBe(v.mirror)
})

// ---- the editor's side of the limit ----

/** An editor state over a guarded peer's text, as editor.ts builds it. */
function editing(p: ReturnType<typeof guarded>) {
  return EditorState.create({ doc: p.text.toString(), extensions: codeLimit(p.text) })
}
/** Writes an editor transaction into the text the way y-codemirror.next's y-sync.js does, under an origin the undo manager tracks. */
function sync(p: ReturnType<typeof guarded>, tr: Transaction, origin: unknown) {
  p.doc.transact(() => {
    let adj = 0
    tr.changes.iterChanges((fromA, toA, _fromB, _toB, insert) => {
      if (fromA !== toA) p.text.delete(fromA + adj, toA - fromA)
      if (insert.length) p.text.insert(fromA + adj, insert.toString())
      adj += insert.length - (toA - fromA)
    })
  }, origin)
}

for (const [where, at] of [['at the top', 0], ['in the middle', 45], ['at the end', 90]] as const) {
  test(`a paste ${where} that does not fit is shortened where it was put, and undo gives back the text from before`, () => {
    const v = guarded(), before = 'int main() { /* work */ }'.padEnd(90, '.')
    v.text.insert(0, before)
    const undo = new Y.UndoManager(v.text, { trackedOrigins: new Set(['editor']) })
    const state = editing(v)
    const tr = state.update({ changes: { from: at, insert: 'P'.repeat(CODE_MAX) }, selection: EditorSelection.cursor(at + CODE_MAX), userEvent: 'input.paste' })
    const kept = CODE_MAX - 90
    expect(tr.newDoc.length).toBe(CODE_MAX)
    expect(tr.newDoc.sliceString(0, at) + tr.newDoc.sliceString(at + kept)).toBe(before)
    expect(tr.newSelection.main.head).toBe(at + kept)
    expect(tr.isUserEvent('input.paste')).toBe(true)
    expect(v.trims).toBe(1)
    sync(v, tr, 'editor')
    expect(v.text.length).toBe(CODE_MAX)
    undo.undo()
    expectClean(v, before)
    expect(v.trims).toBe(1)
  })
}

test('what is over the limit is taken from the last insertions of a change first, however many it takes', () => {
  const v = guarded()
  v.text.insert(0, 'x'.repeat(CODE_MAX - 10))
  const paste = (texts: string[]) => editing(v).update({ changes: texts.map((insert, i) => ({ from: i * 100, insert })) }).newDoc
  expect(paste(['AAAAAAAA', 'BBBBBBBB']).toString()).toBe('AAAAAAAA' + 'x'.repeat(100) + 'BB' + 'x'.repeat(CODE_MAX - 110))
  expect(paste(['AAAAAAAAAAAA', 'BBBBBBBB', 'CC']).toString()).toBe('AAAAAAAAAA' + 'x'.repeat(CODE_MAX - 10))
  expect(v.trims).toBe(2)
})

test('a replacement that leaves the text within the limit is not touched, and one that does not is shortened', () => {
  const v = guarded()
  v.text.insert(0, 'x'.repeat(CODE_MAX))
  const state = editing(v)
  expect(state.update({ changes: { from: 0, to: 5, insert: 'abcde' } }).newDoc.sliceString(0, 6)).toBe('abcdex')
  expect(v.trims).toBe(0)
  expect(state.update({ changes: { from: 0, to: 2, insert: 'abcde' } }).newDoc.sliceString(0, 4)).toBe('abxx')
  expect(state.update({ changes: { from: 7, insert: 'y' } }).docChanged).toBe(false) // typing into a full file
  expect(v.trims).toBe(2)
})

test('shortening a paste does not split a surrogate pair', () => {
  const v = guarded()
  v.text.insert(0, 'x'.repeat(CODE_MAX - 3))
  const doc = editing(v).update({ changes: { from: 0, insert: '\u{1f600}\u{1f600}' } }).newDoc
  expect(doc.sliceString(0, 3)).toBe('\u{1f600}x')
  expect(doc.length).toBe(CODE_MAX - 1)
})

test("another peer's change reaches the editor as it is, even past the limit", () => {
  const v = guarded()
  v.text.insert(0, 'x'.repeat(CODE_MAX))
  const tr = editing(v).update({ changes: { from: 0, insert: 'remote' }, annotations: ySyncAnnotation.of({} as never) })
  expect(tr.newDoc.length).toBe(CODE_MAX + 6)
  expect(v.trims).toBe(0)
})
