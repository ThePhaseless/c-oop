// theme.js runs as a classic script before the stylesheet; here it runs against a fake document and storage.
import { expect, test } from 'bun:test'

const source = await Bun.file(new URL('./theme.js', import.meta.url)).text()
function run(getItem: (key: string) => string | null): string | undefined {
  const dataset: { theme?: string } = {}
  new Function('localStorage', 'document', source)({ getItem }, { documentElement: { dataset } })
  return dataset.theme
}

test('a stored theme is put on <html>, under the key the theme button writes', () => {
  const keys: string[] = []
  expect(run(k => (keys.push(k), 'dark'))).toBe('dark')
  expect(run(() => 'light')).toBe('light')
  expect(keys).toEqual(['c-oop.theme'])
})

test('nothing stored, or anything else stored, leaves the system theme', () => {
  expect(run(() => null)).toBeUndefined()
  expect(run(() => 'dark;x')).toBeUndefined()
})

test('blocked storage is not an error', () => {
  expect(run(() => { throw new Error('SecurityError') })).toBeUndefined()
})

test('index.html loads it as a file, ahead of the stylesheet, and carries no inline script', async () => {
  const html = await Bun.file(new URL('./index.html', import.meta.url)).text()
  expect(html.indexOf('<script src="/theme.js"></script>')).toBeGreaterThan(0)
  expect(html.indexOf('<script src="/theme.js"></script>')).toBeLessThan(html.indexOf('rel="stylesheet"'))
  expect(html.match(/<script(?![^>]*\ssrc=)/g)).toBeNull()
})
