import { expect, test } from 'bun:test'
import { termFilter } from './term-filter'

const once = (s: string) => termFilter()(s)
/** Feeds `s` one UTF-16 unit at a time, as the worst split of `out` elements would. */
const byUnit = (s: string) => {
  const f = termFilter()
  let out = ''
  for (let i = 0; i < s.length; i++) out += f(s[i]!)
  return out
}

const DIAGNOSTIC = '\x1b[1mmain.cpp:3:5: \x1b[0m\x1b[0;1;31merror: \x1b[0m\x1b[1mbrak\x1b[0m\n      | \x1b[0;1;32m    ^~~\x1b[0m\n'
const HOSTILE: [name: string, input: string, kept: string][] = [
  ['a scroll with a huge count', 'a\x1b[2147483647Tb', 'ab'],
  ['erase, cursor moves and private modes', 'a\x1b[2J\x1b[H\x1b[10;10H\x1b[?1049h\x1b[3Ab', 'ab'],
  ['repeat of the preceding character', 'a\x1b[2147483647bz', 'az'],
  ['a sequence that ends in m but is not SGR', 'a\x1b[>4;2m\x1b[?5m\x1b[1 mb', 'ab'],
  ['an SGR with more parameters than any real one', `a\x1b[${'1;'.repeat(100)}mb`, 'ab'],
  ['OSC 52 (clipboard) ended by BEL', 'a\x1b]52;c;aGVsbG8=\x07b', 'ab'],
  ['OSC 8 (hyperlink) ended by ST', 'a\x1b]8;;http://x.test\x1b\\link\x1b]8;;\x1b\\b', 'alinkb'],
  ['8-bit CSI', 'a\x9b2147483647Tb', 'ab'],
  ['8-bit OSC and ST', 'a\x9d0;title\x9cb', 'ab'],
  ['DCS, APC, PM and SOS strings', 'a\x1bPq#0\x1b\\b\x1b_x\x1b\\c\x1b^y\x1b\\d\x1bXz\x1b\\e', 'abcde'],
  ['a two-character escape (RIS)', 'a\x1bcb', 'ab'],
  ['an escape with intermediates (charset)', 'a\x1b(0b', 'ab'],
  ['other C0 and C1 controls and DEL', 'a\x00\x07\x0b\x0c\x0e\x7f\x85\x8db', 'ab'],
]

for (const [name, input, kept] of HOSTILE) {
  test(`dropped: ${name}`, () => {
    expect(once(input)).toBe(kept)
    expect(byUnit(input)).toBe(kept)
  })
}

test('printable text passes untouched, Polish letters and astral characters included', () => {
  const s = 'Zażółć gęślą jaźń, 3 < 4 && "x" \u{1f600} ~  '
  expect(once(s)).toBe(s)
  expect(byUnit(s)).toBe(s)
})

test('newline, carriage return, tab and backspace pass', () => {
  expect(once('a\tb\bc\r\n')).toBe('a\tb\bc\r\n')
})

test('they also pass beside a colour sequence, where every character is judged alone', () => {
  const s = '\x1b[31ma\tb\bc\r\n\x1b[0m'
  expect(once(s)).toBe(s)
  expect(byUnit(s)).toBe(s)
})

test("clang's coloured diagnostics and the grey status lines pass as they are", () => {
  const s = DIAGNOSTIC + '\x1b[90m[błąd kompilacji]\x1b[0m\n' + '\x1b[m\x1b[38;2;1;2;3m\x1b[38:5:196mx'
  expect(once(s)).toBe(s)
  expect(byUnit(s)).toBe(s)
})

test('an 8-bit SGR comes out as the 7-bit one', () => {
  expect(once('\x9b31mred')).toBe('\x1b[31mred')
})

test('a sequence split across chunks is judged as a whole, and nothing of it is written early', () => {
  const f = termFilter()
  expect(f('a\x1b')).toBe('a')
  expect(f('[214748')).toBe('')
  expect(f('3647')).toBe('')
  expect(f('Tb\x1b[3')).toBe('b')
  expect(f('1mc')).toBe('\x1b[31mc')
})

test('a string sequence that never ends stops at the end of its line', () => {
  expect(once('a\x1b]0;title\nnext line\n')).toBe('a\nnext line\n')
  expect(byUnit('a\x1bP never closed\r\nb')).toBe('a\nb')
})

test('a control character inside a sequence ends it and is itself judged as text', () => {
  expect(once('a\x1b[12\nb\x1b[3\x1b[32mc')).toBe('a\nb\x1b[32mc')
})

test('filtered text passes a second filter unchanged', () => {
  const messy = HOSTILE.map(h => h[1]).join(DIAGNOSTIC)
  const clean = once(messy)
  expect(once(clean)).toBe(clean)
  expect(byUnit(clean)).toBe(clean)
})

test('every filter has its own state', () => {
  const a = termFilter()
  a('\x1b]0;never closed')
  expect(termFilter()('text')).toBe('text')
})
