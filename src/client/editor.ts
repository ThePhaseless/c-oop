// CodeMirror bound to the shared Y.Text. Colours are CSS tokens (style.css), so a theme switch needs
// no reconfiguration. No Run binding here: main.ts owns Ctrl/Cmd+Enter for the whole page.
import { cpp } from '@codemirror/lang-cpp'
import { indentWithTab } from '@codemirror/commands'
import { HighlightStyle, indentUnit, syntaxHighlighting } from '@codemirror/language'
import { EditorState, Prec } from '@codemirror/state'
import { EditorView, keymap, placeholder } from '@codemirror/view'
import { tags as t } from '@lezer/highlight'
import { basicSetup } from 'codemirror'
import { yCollab, yRemoteSelections, yUndoManagerKeymap } from 'y-codemirror.next'
import type { Awareness } from 'y-protocols/awareness'
import type * as Y from 'yjs'
import { EDITOR_LABEL, EDITOR_PLACEHOLDER } from './strings'
import { cppCompletion } from './completion'
import { codeLimit } from './text-guard'

const HINT_ID = 'editor-hint' // the Esc-then-Tab hint in the pane header (index.html)
const NAMES_MS = 2000 // a caret shows its name this long after its peer moved it, edited the text or changed the name
const tint = (token: string, percent: number) => `color-mix(in srgb, var(${token}) ${percent}%, transparent)`

// basicSetup's base theme hard-codes light greys; everything visible is put back on the tokens.
const theme = EditorView.theme({
  '&': { height: '100%', color: 'var(--ink)', backgroundColor: 'var(--paper)' },
  '&.cm-focused': { outline: 'none' }, // the pane header shows focus (style.css)
  '.cm-scroller': {
    fontFamily: 'var(--font-code)',
    fontVariationSettings: '"MONO" 1',
    fontSize: '0.9375rem',
    lineHeight: '1.55',
  },
  // The top padding is where the name of a caret on line 1 goes; the terminal's first row starts as low (style.css).
  '.cm-content': { caretColor: 'var(--ink)', paddingTop: '1.375rem' },
  // 2px more on the left: the margin line is drawn over the first 2px, and the pane title starts after it.
  '.cm-line': { padding: '0 var(--pad) 0 calc(var(--pad) + 2px)' },
  '.cm-cursor, .cm-dropCursor': { borderLeftColor: 'var(--ink)', borderLeftWidth: '2px' },
  '.cm-selectionBackground, &.cm-focused > .cm-scroller > .cm-selectionLayer .cm-selectionBackground': { backgroundColor: 'var(--select)' },
  '.cm-activeLine': { backgroundColor: tint('--select', 40) },
  '.cm-selectionMatch': { backgroundColor: tint('--warn', 12) },
  '&.cm-focused .cm-matchingBracket': { backgroundColor: 'transparent', outline: '1px solid var(--edge)' },
  '&.cm-focused .cm-nonmatchingBracket': { backgroundColor: 'transparent', outline: '1px solid var(--margin)' },
  // The gutter is exactly --gutter wide so that its right edge is the margin line drawn by style.css.
  // shortcut: line numbers of 5 digits are clipped; widen --gutter if files get that long.
  '.cm-gutters': { width: 'var(--gutter)', border: 'none', color: 'var(--ink-2)', backgroundColor: 'var(--paper)' },
  '.cm-lineNumbers': { flex: '1', minWidth: '0' },
  '.cm-lineNumbers .cm-gutterElement': { padding: '0 0.125rem 0 0.25rem' },
  '.cm-foldGutter .cm-gutterElement': { padding: '0 0.25rem 0 0', cursor: 'pointer' },
  '.cm-activeLineGutter': { color: 'var(--ink)', backgroundColor: 'transparent', fontWeight: '600' },
  '.cm-foldPlaceholder': { color: 'var(--ink-2)', backgroundColor: 'var(--paper-2)', border: '1px solid var(--line)' },
  '.cm-placeholder': {
    display: 'inline-block',
    maxWidth: 'min(30rem, calc(100vw - var(--gutter) - 2rem))',
    color: 'var(--ink-2)',
    fontFamily: 'var(--font-ui)',
    fontVariationSettings: '"CASL" 0',
    whiteSpace: 'normal',
    verticalAlign: 'top',
  },
  '.cm-panels': { color: 'var(--ink)', backgroundColor: 'var(--paper-2)', fontFamily: 'var(--font-ui)' },
  '.cm-panels.cm-panels-top': { borderBottom: '1px solid var(--line)' },
  // At most half of the editor: on a phone the search panel is higher than the editor is, and would cover all of the code.
  // No shrinking: a box that scrolls may shrink below its content, and would then give up height to the code at any size.
  '.cm-panels.cm-panels-bottom': { borderTop: '1px solid var(--line)', flexShrink: '0', maxHeight: '50%', overflowY: 'auto' },
  '.cm-panel .cm-textfield, .cm-panel .cm-button, .cm-panel label, .cm-panel.cm-search label': { fontFamily: 'inherit', fontSize: '0.8125rem' },
  '.cm-panel .cm-textfield, .cm-panel .cm-button': { minHeight: '2rem' },
  // the close button stands in the top right corner, over whatever the first row puts there
  '.cm-panel.cm-search': { paddingRight: '2.5rem' },
  '.cm-panel.cm-search label': { display: 'inline-flex', alignItems: 'center', gap: '0.25rem', minHeight: '2rem' },
  '.cm-panel.cm-search [name=close]': { minWidth: '2rem', minHeight: '2rem', color: 'var(--ink)', cursor: 'pointer' },
  '@media (pointer: coarse)': {
    '.cm-panel .cm-textfield, .cm-panel .cm-button': { minHeight: '2.75rem' },
    '.cm-panel.cm-search [name=close]': { minWidth: '2.75rem', minHeight: '2.75rem' },
  },
  '.cm-textfield': { color: 'var(--ink)', backgroundColor: 'var(--paper)', border: '1px solid var(--edge)', borderRadius: '6px' },
  '.cm-button': { color: 'var(--ink)', backgroundImage: 'none', backgroundColor: 'transparent', border: '1px solid var(--edge)', borderRadius: '6px' },
  // 12%: under a stronger tint the code drops below 4.5:1; the outline is what marks the match
  '.cm-searchMatch': { backgroundColor: tint('--warn', 12), outline: '1px solid var(--warn)' },
  // no tint at all: the current match is also the selection, and --select is as dark as the code can stand on
  '.cm-searchMatch.cm-searchMatch-selected': { backgroundColor: 'transparent', outline: '1px solid var(--accent)' },
  '.cm-tooltip': { color: 'var(--ink)', backgroundColor: 'var(--paper-2)', border: '1px solid var(--edge)', borderRadius: '6px' },
  '.cm-tooltip-autocomplete ul li[aria-selected]': { color: 'var(--accent-ink)', backgroundColor: 'var(--accent)' },
  // y-codemirror shifts a fully selected line 4px to the right
  '.cm-yLineSelection': { margin: '0' },
  // Remote carets: white on the peer colour. The name covers the line above the caret, so it is drawn only on a
  // caret that createEditor has marked (a projected classroom has no hover) and under the pointer. Not drawn is
  // display none: a name that is merely invisible still adds its width to the scroll range at the right edge.
  '.cm-ySelectionInfo': {
    display: 'none',
    top: '-1.35em',
    padding: '0 0.25rem',
    borderRadius: '3px 3px 3px 0',
    color: '#fff',
    fontFamily: 'var(--font-ui)',
    fontVariationSettings: '"CASL" 0',
    fontSize: '0.8125rem',
    fontWeight: '600',
    lineHeight: '1.3',
    opacity: '1',
    transition: 'none',
  },
  '.cm-ySelectionCaret[data-named] > .cm-ySelectionInfo, .cm-ySelectionCaret:hover > .cm-ySelectionInfo': { display: 'block' },
})

const highlight = HighlightStyle.define([
  { tag: [t.keyword, t.self, t.null, t.bool, t.modifier], color: 'var(--syn-kw)', fontWeight: '600' },
  { tag: [t.typeName, t.className, t.namespace], color: 'var(--syn-type)' },
  { tag: [t.string, t.character, t.escape], color: 'var(--syn-str)' },
  { tag: t.number, color: 'var(--syn-num)' },
  { tag: [t.processingInstruction, t.meta, t.macroName], color: 'var(--syn-pre)' },
  { tag: t.comment, color: 'var(--syn-com)', fontStyle: 'normal' },
  { tag: t.invalid, color: 'var(--margin)' },
])

// y-codemirror.next 0.3.6 compares caret widgets by colour only, so a peer's new name never reached its caret
// label. The widget class is not exported: its prototype is taken from the first caret drawn and patched once.
type CaretWidget = { color?: unknown; name?: unknown }
type CaretSet = { iter(): { from: number; value: { spec: { widget?: CaretWidget } } | null; next(): void } }
/** y-codemirror's decorations: for every remote caret a widget at the caret's position (and marks for the selections). */
const remoteCarets = (view: EditorView) => (view.plugin(yRemoteSelections) as { decorations?: CaretSet } | null)?.decorations
let caretPatched = false
const caretNameFix = EditorView.updateListener.of(update => {
  if (caretPatched) return
  for (const it = remoteCarets(update.view)?.iter(); it?.value; it.next()) {
    const widget = it.value.spec.widget
    if (!widget) continue
    const same = function (this: CaretWidget, other: CaretWidget) { return other.color === this.color && other.name === this.name }
    Object.assign(Object.getPrototypeOf(widget), { eq: same, compare: same })
    caretPatched = true
    return
  }
})

// All a caret widget knows of its peer, so two people with the same name and colour show their names together.
const peerKey = (user: CaretWidget) => `${user.color}\n${user.name}`

export function createEditor(host: HTMLElement, o: { text: Y.Text; awareness: Awareness }): { focus(): void; text(): string } {
  const named = new Map<string, number>() // peers whose caret shows its name, each with the time (performance.now) that ends it
  const view: EditorView = new EditorView({
    parent: host,
    state: EditorState.create({
      doc: o.text.toString(),
      extensions: [
        keymap.of([...yUndoManagerKeymap, indentWithTab]), // before basicSetup: shared undo wins over local history
        basicSetup,
        cpp(),
        cppCompletion,
        yCollab(o.text, o.awareness),
        Prec.highest(codeLimit(o.text)), // the last filter to run: it has to see what the others (the re-indent on `}`) add
        caretNameFix,
        EditorView.updateListener.of(() => { if (named.size) markNamed() }), // an update may have drawn the carets anew
        indentUnit.of('    '),
        EditorState.tabSize.of(4),
        placeholder(EDITOR_PLACEHOLDER),
        EditorView.contentAttributes.of({ 'aria-label': EDITOR_LABEL, 'aria-describedby': HINT_ID }),
        theme,
        syntaxHighlighting(highlight),
      ],
    }),
  })
  // Whose name shows is kept per peer and put on the caret elements y-codemirror drew, as an attribute: its widgets
  // carry no peer id to style by, and CodeMirror ignores what changes inside a widget.
  type User = { user?: CaretWidget } | undefined
  function carets() {
    const list: { at: number; key: string; name: string }[] = []
    for (const it = remoteCarets(view)?.iter(); it?.value; it.next()) {
      const widget = it.value.spec.widget
      if (widget) list.push({ at: it.from, key: peerKey(widget), name: String(widget.name) })
    }
    return list
  }
  // A name that would pass the right edge of the editor moves left by as much, at most until it ends at its caret:
  // past the edge it would be cut off, or widen the scroll range.
  const fit = {
    key: named,
    read() {
      const edge = view.scrollDOM.getBoundingClientRect().left + view.scrollDOM.clientWidth
      return [...view.contentDOM.querySelectorAll<HTMLElement>('.cm-ySelectionCaret:is([data-named], :hover) > .cm-ySelectionInfo')]
        .map(label => ({ label, over: Math.min(label.offsetWidth, label.parentElement!.getBoundingClientRect().left + label.offsetWidth - edge) }))
    },
    write(labels: { label: HTMLElement; over: number }[]) {
      for (const { label, over } of labels) {
        label.style.marginLeft = over > 0 ? `${-over}px` : ''
        label.style.borderRadius = over > 0 ? '3px' : '' // the square corner is where the name meets its caret
      }
    },
  }
  // One pass over all carets for everything that asked for it in the same turn, and one timer for all names: a single
  // message can bring thousands of peers, and a pass or a timer for each of them would freeze the page.
  let marking = false
  function markNamed() {
    if (marking) return
    marking = true
    queueMicrotask(() => {
      marking = false
      // A caret element is told from another at the same place by the name it shows.
      const at = new Set(carets().filter(c => named.has(c.key)).map(c => `${c.at}\n${c.name}`))
      for (const caret of view.contentDOM.querySelectorAll('.cm-ySelectionCaret')) {
        caret.toggleAttribute('data-named', at.has(`${view.posAtDOM(caret)}\n${caret.querySelector('.cm-ySelectionInfo')?.textContent}`))
      }
      view.requestMeasure(fit)
    })
  }
  let expiry: ReturnType<typeof setTimeout> | undefined
  function expire() {
    const now = performance.now()
    let next = Infinity
    for (const [key, until] of named) {
      if (until <= now) named.delete(key)
      else next = Math.min(next, until)
    }
    expiry = next < Infinity ? setTimeout(expire, next - now) : undefined
    markNamed()
  }
  function showName(key: string) {
    named.set(key, performance.now() + NAMES_MS)
    expiry ??= setTimeout(expire, NAMES_MS) // a timer that is already set ends no later than this name does
    markNamed()
  }
  // Both listeners run after y-codemirror's own (registered when the view was built), so the carets are already where they belong.
  o.awareness.on('change', ({ added, updated }: { added: number[]; updated: number[] }) => {
    for (const id of [...added, ...updated]) {
      const user = id !== o.awareness.clientID && (o.awareness.getStates().get(id) as User)?.user
      if (user) showName(peerKey(user))
    }
  })
  // Typing does not change a peer's awareness state: y-codemirror ties the caret to the character after it. The
  // transaction says who typed, by the clients whose clocks it advanced. A deletion advances none, so there the
  // name goes to whoever's caret stands where the text went.
  o.text.observe((event, tr) => {
    if (tr.local) return
    let typed = false
    for (const [id, clock] of tr.afterState) {
      const user = clock > (tr.beforeState.get(id) ?? 0) && (o.awareness.getStates().get(id) as User)?.user
      if (!user) continue
      showName(peerKey(user))
      typed = true
    }
    if (typed) return
    const gone = new Set<number>()
    let pos = 0
    for (const d of event.delta) {
      if (d.delete) gone.add(pos)
      else pos += d.retain ?? (d.insert as string).length
    }
    for (const c of carets()) if (gone.has(c.at)) showName(c.key)
  })
  view.contentDOM.addEventListener('mouseover', e => {
    if ((e.target as Element).closest('.cm-ySelectionCaret')) view.requestMeasure(fit)
  })
  return { focus: () => view.focus(), text: () => view.state.doc.toString() }
}
