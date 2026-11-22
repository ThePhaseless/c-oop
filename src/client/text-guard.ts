// Keeps the shared `code` text to what the editor can hold: strings only, at most CODE_MAX chars.
// Any peer can put an embed, a nested type, formatting or megabytes of text into it, and the copy in
// IndexedDB brings them back on reload. y-codemirror.next 0.3.6 hands a non-string insert to CodeMirror as if
// it were text, which kills the page, and such an item also shifts every index after it.
//
// The guard is the first observer of the text (createCollab registers it on the empty document, before anything
// can load or bind), and Yjs calls observers in the order they were added. Before the others run it removes
// everything a transaction added that is not a string, so between transactions the text holds strings only, and
// it leaves in `event.delta` only what the transaction did to the strings. Yjs builds that array once and gives the
// same one to every observer (yjs 13.6.33 YTextEvent.delta, pinned exact), so the editor binding is never shown the rest.
import { EditorState, type Extension } from '@codemirror/state'
import { ySyncAnnotation } from 'y-codemirror.next'
import * as Y from 'yjs'
import { CODE_MAX } from '../shared/limits'

// Named origins: the undo manager tracks only the editor's own and `null`.
const REMOVE = 'c-oop:remove', CUT = 'c-oop:cut'
type Op = { insert?: string; delete?: number; retain?: number }

// A cut right after the first half of a surrogate pair would leave half a character (Yjs turns it into U+FFFD).
const splitsPair = (unitBefore: string) => unitBefore >= '\ud800' && unitBefore <= '\udbff'
// Text the editor can hold. Not a string with a carriage return: CodeMirror keeps "\r\n" as one char, and every index after it would be off.
const isText = (item: Y.Item) => item.content instanceof Y.ContentString && !item.content.str.includes('\r')
const notices = new WeakMap<Y.Text, () => void>() // onCut of each guarded text, for codeLimit

// What the transaction added to the text that the editor cannot hold. Only the structs the transaction created
// are looked at, never the whole text or the event's delta (Yjs computes that by walking every item), so the
// check costs what the edit adds, however many pieces a peer has broken the text into.
function addedForeign(text: Y.Text, tr: Y.Transaction): Y.Item[] {
  const foreign: Y.Item[] = []
  for (const [client, end] of tr.afterState) {
    const from = tr.beforeState.get(client) ?? 0
    if (end === from) continue
    const structs = tr.doc.store.clients.get(client)!
    for (let i = Y.findIndexSS(structs, from); i < structs.length; i++) {
      const s = structs[i]
      // parentSub: an entry under a key, which is how a document that uses the name as a map stores its values
      if (s instanceof Y.Item && s.parent === text && !s.deleted && (s.parentSub !== null || !isText(s))) foreign.push(s)
    }
  }
  return foreign
}

// What the transaction did to the strings of the text, as a delta: the walk of YTextEvent.delta (yjs 13.6.33) over
// the string items alone. The inserts of that one cannot be sorted by their type: an embed may hold a string.
function stringDelta(text: Y.Text, tr: Y.Transaction): Op[] {
  const ops: Op[] = []
  for (let item = text._start; item; item = item.right) {
    if (!isText(item)) continue
    const added = item.id.clock >= (tr.beforeState.get(item.id.client) ?? 0), deleted = Y.isDeleted(tr.deleteSet, item.id)
    const op: Op | null = added ? (deleted ? null : { insert: (item.content as Y.ContentString).str }) : deleted ? { delete: item.length } : item.deleted ? null : { retain: item.length }
    if (!op) continue
    const last = ops.at(-1)
    if (last?.insert !== undefined && op.insert !== undefined) last.insert += op.insert
    else if (last?.delete && op.delete) last.delete += op.delete
    else if (last?.retain && op.retain) last.retain += op.retain
    else ops.push(op)
  }
  if (ops.at(-1)?.retain) ops.pop() // as Yjs does: nothing happened to the rest of the text
  return ops
}

/** `onCut` is called each time this page shortened the text to keep it within CODE_MAX. */
export function guardText(text: Y.Text, onCut: () => void): void {
  const doc = text.doc!
  notices.set(text, onCut)
  // From the end: whose text that is cannot be told for what a peer or the stored copy brought.
  const cut = () => {
    if (text.length <= CODE_MAX) return
    const keep = splitsPair(text.toString()[CODE_MAX - 1]!) ? CODE_MAX - 1 : CODE_MAX
    doc.transact(() => text.delete(keep, text.length - keep), CUT)
    onCut()
  }
  text.observe((event, tr) => {
    // The removal itself: its deletes are of items no later observer was told about.
    if (tr.origin === REMOVE) return void ((event.delta as Op[]).length = 0)
    const foreign = addedForeign(text, tr)
    if (foreign.length) {
      const delta = event.delta as Op[]
      delta.length = 0
      for (const op of stringDelta(text, tr)) delta.push(op) // no spread: a delta can have more ops than a call takes arguments
      doc.transact(t => { for (const item of foreign) item.delete(t) }, REMOVE)
      // Deleting items directly leaves the text's cache of index positions stale. Yjs empties it itself only for
      // remote transactions, and this one cannot be made to look remote: Yjs would then give the page a new client id.
      if (text._searchMarker) text._searchMarker.length = 0
    }
    // Later, not from inside this call: an observer after this one may be the editor in the middle of an update.
    if (text.length > CODE_MAX) queueMicrotask(cut)
  })
}

/**
 * For the editor bound to `text`: what the user types or pastes is shortened to what still fits, in the place where
 * it was put. The cut in guardText takes the end of the file, which for a paste at the top is somebody's work, and
 * no undo brings that back. This way the text never holds the excess, and undo removes exactly what was inserted.
 */
export const codeLimit = (text: Y.Text): Extension => EditorState.transactionFilter.of(tr => {
  let over = tr.newDoc.length - CODE_MAX
  // Changes that come from the shared text (a peer, undo, redo) are applied as they are, or the editor would differ from it.
  if (!tr.docChanged || over <= 0 || tr.annotation(ySyncAnnotation)) return tr
  const inserted: { from: number; to: number }[] = [], cuts: typeof inserted = []
  tr.changes.iterChangedRanges((_fromA, _toA, from, to) => void inserted.push({ from, to }))
  for (const { from, to } of inserted.reverse()) {
    let at = Math.max(from, to - over)
    if (at > from && splitsPair(tr.newDoc.sliceString(at - 1, at))) at--
    if (at < to) cuts.unshift({ from: at, to })
    over -= to - at
    if (over <= 0) break
  }
  if (!cuts.length) return tr
  notices.get(text)?.()
  return [tr, { changes: cuts, sequential: true }]
})
