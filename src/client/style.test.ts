import { expect, test } from 'bun:test'
import { PEER_COLORS } from '../shared/limits'

const css = await Bun.file(new URL('./style.css', import.meta.url)).text()

const COLOR_TOKENS = ['paper', 'paper-2', 'line', 'edge', 'ink', 'ink-2', 'accent', 'accent-ink', 'margin', 'ok', 'warn', 'select',
  'syn-kw', 'syn-type', 'syn-str', 'syn-num', 'syn-pre', 'syn-com']

/** Tokens of the rule that starts with `selector {`. */
function tokens(selector: string): Record<string, string> {
  const start = css.indexOf(selector + ' {')
  if (start < 0) throw new Error(`no rule "${selector}" in style.css`)
  const body = css.slice(start, css.indexOf('}', start))
  return Object.fromEntries([...body.matchAll(/--([\w-]+):\s*([^;]+);/g)].map(m => [m[1], m[2]!.trim()]))
}

const light = tokens(':root')
const dark = tokens(':root[data-theme="dark"]')
const darkAuto = tokens(':root:not([data-theme="light"])')

function luminance(hex: string): number {
  const [r, g, b] = [1, 3, 5].map(i => {
    const v = parseInt(hex.slice(i, i + 2), 16) / 255
    return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4
  }) as [number, number, number]
  return 0.2126 * r + 0.7152 * g + 0.0722 * b
}
function ratio(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [number, number]
  return (hi + 0.05) / (lo + 0.05)
}

test('contrast helper matches the known black-on-white ratio', () => {
  expect(ratio('#000000', '#ffffff')).toBeCloseTo(21, 5)
})

test('every colour token is a plain hex in both themes (the terminal reads them raw)', () => {
  for (const theme of [light, dark]) {
    for (const name of COLOR_TOKENS) expect([name, theme[name]]).toEqual([name, expect.stringMatching(/^#[0-9a-f]{6}$/)])
  }
  expect(light['font-ui']).toContain('Recursive UI')
  expect(light['font-code']).toContain('Recursive Code')
})

test('the dark theme chosen by the system equals the dark theme chosen by the button', () => {
  expect(darkAuto).toEqual(dark)
})

for (const [themeName, t] of [['light', light], ['dark', dark]] as const) {
  const on = (fg: string, bg: string) => ratio(t[fg]!, t[bg]!)

  test(`${themeName}: text tokens are 4.5:1 or better on --paper and --paper-2`, () => {
    for (const fg of ['ink', 'ink-2', 'accent', 'margin', 'ok', 'warn', 'syn-kw', 'syn-type', 'syn-str', 'syn-num', 'syn-pre', 'syn-com']) {
      for (const bg of ['paper', 'paper-2']) expect([fg, bg, on(fg, bg) >= 4.5]).toEqual([fg, bg, true])
    }
  })

  test(`${themeName}: --edge is 3:1 or better and --accent-ink reads on --accent`, () => {
    expect(on('edge', 'paper')).toBeGreaterThanOrEqual(3)
    expect(on('edge', 'paper-2')).toBeGreaterThanOrEqual(3)
    expect(on('accent', 'paper')).toBeGreaterThanOrEqual(3) // focus ring
    expect(on('accent', 'paper-2')).toBeGreaterThanOrEqual(3)
    expect(on('accent-ink', 'accent')).toBeGreaterThanOrEqual(4.5)
  })

  // Highlights sit under code: the own selection is --select, a peer's is the peer colour at alpha 33 on --paper (y-codemirror).
  test(`${themeName}: code is 4.5:1 or better on the own selection and under a peer's selection`, () => {
    const under = (c: string) => '#' + [1, 3, 5].map(i => Math.round(parseInt(c.slice(i, i + 2), 16) * 0.2 + parseInt(t.paper!.slice(i, i + 2), 16) * 0.8).toString(16).padStart(2, '0')).join('')
    for (const fg of ['ink', 'syn-kw', 'syn-type', 'syn-str', 'syn-num', 'syn-pre', 'syn-com']) {
      for (const bg of [t.select!, ...PEER_COLORS.map(under)]) expect([fg, bg, ratio(t[fg]!, bg) >= 4.5]).toEqual([fg, bg, true])
    }
  })

  // The current search match stands on the selection with no tint of its own (editor.ts), so the code on it is covered above.
  test(`${themeName}: the outline of the current search match shows on the selection`, () => {
    expect(on('accent', 'select')).toBeGreaterThanOrEqual(3)
  })

  // No rule for --paper-2: the header dot is decorative, the name stands beside it, and on the dark theme it reaches only about 2.9:1.
  test(`${themeName}: peer colours carry a white label and show on --paper`, () => {
    for (const c of PEER_COLORS) {
      expect([c, ratio(c, '#ffffff') >= 4.5]).toEqual([c, true])
      expect([c, ratio(c, t.paper!) >= 3]).toEqual([c, true])
    }
  })
}
