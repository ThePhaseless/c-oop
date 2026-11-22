import { expect, test } from 'bun:test'
import { LINE_MAX } from '../shared/limits'
import { lineDiscipline } from './line-discipline'

function setup() {
  const log: string[] = []
  const ld = lineDiscipline({
    echo: s => log.push('echo:' + s),
    // The pending line must already be empty when a handler runs: the runner redraws it around shared output.
    line: s => log.push(`line:${s}|pending:${ld.pending()}`),
    eof: () => log.push('eof'),
    interrupt: () => log.push(`interrupt|pending:${ld.pending()}`),
  })
  return { ld, log }
}
const ERASE = '\b \b'

test('printable characters are echoed and kept as the pending line', () => {
  const { ld, log } = setup()
  ld.feed('a')
  ld.feed('ż')
  expect(log).toEqual(['echo:a', 'echo:ż'])
  expect(ld.pending()).toBe('aż')
})

test('Enter erases the local echo and sends the line with a newline, without echoing one', () => {
  const { ld, log } = setup()
  ld.feed('hi')
  log.length = 0
  ld.feed('\r')
  expect(log).toEqual(['echo:' + ERASE.repeat(2), 'line:hi\n|pending:'])
  expect(ld.pending()).toBe('')
})

test('Enter on an empty line sends a bare newline', () => {
  const { ld, log } = setup()
  ld.feed('\r')
  expect(log).toEqual(['line:\n|pending:'])
})

test('Backspace removes one code point and does nothing on an empty line', () => {
  const { ld, log } = setup()
  ld.feed('\x7f')
  expect(log).toEqual([])
  ld.feed('a😀')
  log.length = 0
  ld.feed('\x7f')
  expect(log).toEqual(['echo:' + ERASE])
  expect(ld.pending()).toBe('a')
  ld.feed('\b')
  expect(ld.pending()).toBe('')
})

test('Ctrl+D with pending text erases it and sends it without a newline', () => {
  const { ld, log } = setup()
  ld.feed('abc')
  log.length = 0
  ld.feed('\x04')
  expect(log).toEqual(['echo:' + ERASE.repeat(3), 'line:abc|pending:'])
})

test('Ctrl+D on an empty line is end of file', () => {
  const { ld, log } = setup()
  ld.feed('\x04')
  expect(log).toEqual(['eof'])
})

test('Ctrl+C erases the pending line and interrupts', () => {
  const { ld, log } = setup()
  ld.feed('half')
  log.length = 0
  ld.feed('\x03')
  expect(log).toEqual(['echo:' + ERASE.repeat(4), 'interrupt|pending:'])
  expect(ld.pending()).toBe('')
})

test('a tab is stored as a tab and echoed as one space', () => {
  const { ld, log } = setup()
  ld.feed('a\tb')
  expect(log).toEqual(['echo:a', 'echo: ', 'echo:b'])
  expect(ld.pending()).toBe('a\tb')
  log.length = 0
  ld.feed('\r')
  expect(log).toEqual(['echo:' + ERASE.repeat(3), 'line:a\tb\n|pending:'])
})

test('input beyond LINE_MAX is ignored and the full line still fits LINE_MAX with its newline', () => {
  const { ld, log } = setup()
  ld.feed('x'.repeat(LINE_MAX + 10))
  expect(ld.pending().length).toBe(LINE_MAX - 1)
  expect(log.length).toBe(LINE_MAX - 1)
  ld.feed('😀') // two UTF-16 units do not fit either
  expect(ld.pending().length).toBe(LINE_MAX - 1)
  log.length = 0
  ld.feed('\r')
  expect(log[1]!.slice('line:'.length, -'|pending:'.length).length).toBe(LINE_MAX)
})

test('escape sequences (arrow keys, Home, End) are ignored, a lone ESC too', () => {
  const { ld, log } = setup()
  ld.feed('a')
  ld.feed('\x1b[A')
  ld.feed('\x1b[1;5D')
  ld.feed('\x1b')
  ld.feed('\x01')
  expect(log).toEqual(['echo:a'])
  expect(ld.pending()).toBe('a')
})

test('C1 control characters in a paste are ignored: the terminal would obey them when the line is echoed', () => {
  const { ld, log } = setup()
  ld.feed('a\x9b2147483647T\x9d0;x\x9cb')
  expect(ld.pending()).toBe('a2147483647T0;xb')
  expect(log.join('')).not.toMatch(/[\x80-\x9f]/)
})

test('a paste with newlines sends every complete line and keeps the rest pending', () => {
  const { ld, log } = setup()
  ld.feed('one\rtwo\nthr')
  expect(log.filter(l => l.startsWith('line:'))).toEqual(['line:one\n|pending:', 'line:two\n|pending:'])
  expect(ld.pending()).toBe('thr')
})

test('clear drops the pending line without echo', () => {
  const { ld, log } = setup()
  ld.feed('abc')
  log.length = 0
  ld.clear()
  expect(ld.pending()).toBe('')
  expect(log).toEqual([])
})
