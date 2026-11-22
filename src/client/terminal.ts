// xterm.js behind the `Term` type, coloured from the CSS tokens of style.css.
import { FitAddon } from '@xterm/addon-fit'
import { type ITheme, Terminal } from '@xterm/xterm'
import type { Term } from '../shared/contracts'
import { TERMINAL_INPUT_LABEL, TERMINAL_TOO_MUCH_OUTPUT } from './strings'

const FONT_WAIT_MS = 2000

function theme(): ITheme {
  const css = getComputedStyle(document.documentElement)
  const v = (name: string) => css.getPropertyValue(name).trim() || undefined
  const ink = v('--ink'), ink2 = v('--ink-2')
  // Magenta is clang's warning colour: on --warn it stands apart from the red of an error.
  const red = v('--margin'), green = v('--ok'), yellow = v('--warn'), blue = v('--syn-kw'), magenta = v('--warn'), cyan = v('--syn-type')
  // Bright colours equal the normal ones: clang's bold diagnostics stay on the token palette (xterm draws bold text in the bright colours).
  return {
    background: v('--paper'), foreground: ink, cursor: ink, cursorAccent: v('--paper'),
    selectionBackground: v('--select'), selectionInactiveBackground: v('--select'),
    black: ink2, brightBlack: ink2, red, brightRed: red, green, brightGreen: green, yellow, brightYellow: yellow,
    blue, brightBlue: blue, magenta, brightMagenta: magenta, cyan, brightCyan: cyan, white: ink, brightWhite: ink,
  }
}

export async function createTerminal(host: HTMLElement): Promise<Term> {
  // xterm measures the cell once, so the font has to be there first.
  await Promise.race([document.fonts.load('15px "Recursive Code"').catch(() => {}), new Promise(r => setTimeout(r, FONT_WAIT_MS))])
  const css = getComputedStyle(document.documentElement)
  Terminal.strings.promptLabel = TERMINAL_INPUT_LABEL
  Terminal.strings.tooMuchOutput = TERMINAL_TOO_MUCH_OUTPUT
  const term = new Terminal({
    convertEol: true, // programs write \n
    scrollback: 5000,
    screenReaderMode: true,
    cursorBlink: !matchMedia('(prefers-reduced-motion: reduce)').matches,
    fontFamily: css.getPropertyValue('--font-code').trim() || 'monospace',
    fontSize: Math.round(parseFloat(css.fontSize) * 0.9375) || 15, // 0.9375rem, follows the browser's font size
    lineHeight: 1.3, // about 1.55 of the font size, as in the editor
    fontWeight: 400,
    fontWeightBold: 600,
    linkHandler: { activate() {} }, // links in program output stay inert
    theme: theme(),
  })
  const fit = new FitAddon()
  term.loadAddon(fit)
  term.attachCustomKeyEventHandler(e => {
    if (e.key === 'Tab') return false // focus moves on
    const mod = (e.ctrlKey || e.metaKey) && !e.altKey
    if (mod && e.key.toLowerCase() === 'c' && term.hasSelection()) return false // the browser copies the selection
    if (mod && e.key.toLowerCase() === 'v') return false // the browser pastes; xterm turns the paste event into data
    return true
  })
  term.open(host)
  fit.fit()
  new ResizeObserver(() => fit.fit()).observe(host)
  const REVERSE_WRAP = '\x1b[?45h' // lets '\b' climb back over a wrapped pending line
  term.write(REVERSE_WRAP)

  return {
    write: (text, done) => term.write(text, done),
    reset: () => term.write('\x1bc' + REVERSE_WRAP), // through the write queue, so late output cannot land after it
    onData: cb => void term.onData(cb),
    focus: () => term.focus(),
    setTheme: () => void (term.options.theme = theme()),
    screen() {
      // Text up to the cursor; the cursor line keeps its trailing spaces ("Name: "). Finished lines lose theirs:
      // an erased pending line leaves real space cells behind, which xterm's own trim keeps.
      const b = term.buffer.active
      const cur = b.baseY + b.cursorY
      const lines: string[] = []
      for (let i = 0; i < cur; i++) lines.push(b.getLine(i)?.translateToString(true).trimEnd() ?? '')
      lines.push(b.getLine(cur)?.translateToString(false, 0, b.cursorX) ?? '')
      return lines.join('\n')
    },
  }
}
