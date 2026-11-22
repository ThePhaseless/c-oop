// Cooked-mode terminal input: the program only ever gets whole lines. Editing and its echo
// are local; on Enter the echo is erased and the line is handed over, to come back as shared output.
import { LINE_MAX } from '../shared/limits'

// Every code point of a pending line takes one cell (a tab is echoed as one space).
// shortcut: a double-width character (CJK) leaves one stray cell, upgrade with a width table if that matters.
// shortcut: '\b' cannot climb above the top of the visible screen, so a pending line taller than the terminal
// (about 1000 chars at 76x13, checked in Chromium) is only partly erased and stays on screen as leftovers;
// wrapped lines that fit the screen erase cleanly. Upgrade: redraw with cursor addressing if long pastes matter.
export const eraseSeq = (pending: string): string => '\b \b'.repeat([...pending].length)

/** What a pending line looks like on screen. */
export const shownPending = (pending: string): string => pending.replaceAll('\t', ' ')

export function lineDiscipline(h: { echo(s: string): void; line(s: string): void; eof(): void; interrupt(): void }): {
  feed(data: string): void
  pending(): string
  clear(): void
} {
  let line = ''
  // The line is dropped before a handler runs, so shared output drawn by the handler finds no pending text.
  const take = () => {
    const s = line
    line = ''
    if (s) h.echo(eraseSeq(s))
    return s
  }
  return {
    feed(data) {
      if (data.length > 1 && data[0] === '\x1b') return // arrow keys, Home, End: no cursor movement inside the line
      for (const ch of data) { // a paste arrives as one string
        if (ch === '\r' || ch === '\n') h.line(take() + '\n')
        else if (ch === '\x7f' || ch === '\b') {
          if (line) {
            line = [...line].slice(0, -1).join('')
            h.echo('\b \b')
          }
        } else if (ch === '\x03') {
          take()
          h.interrupt()
        } else if (ch === '\x04') {
          if (line) h.line(take())
          else h.eof()
        } else if (ch === '\t' || (ch >= ' ' && (ch < '\x7f' || ch > '\x9f'))) { // no DEL, no C1: the echo goes to the terminal as typed
          if (line.length + ch.length >= LINE_MAX) continue // the line plus its newline must fit LINE_MAX
          line += ch
          h.echo(ch === '\t' ? ' ' : ch)
        }
      }
    },
    pending: () => line,
    clear() {
      line = ''
    },
  }
}
