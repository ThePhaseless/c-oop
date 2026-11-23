// End-to-end suite: the built app in real Chromium processes, one per peer.
// Every scenario has its own room and browsers and ends by checking that no peer recorded a page error,
// a console error, a dialog or a CSP violation.
import { afterAll, beforeAll, expect, test } from 'bun:test'
import type { Page } from 'playwright-core'
import * as Y from 'yjs'
import { sanitizeName } from '../src/client/presence.ts'
import { compilerNote, exitLine, noticeText, TEMPLATE } from '../src/client/strings.ts'
import { CODE_MAX, STUCK_MS } from '../src/shared/limits.ts'
import { aiRequests, booted, count, done, exit, Fatal, focusTerminal, net, openPeer, type Peer, type PeerOpts, phase, prompted, room, screen, setCode, start, startApp, status, storedRun, text, waitFor } from './harness.ts'
import { BUSY_LOOP, COMPILE_ERROR, ECHO, FLOOD, HELLO, OOP, STDIN, WARNING } from './programs.ts'

let app: Awaited<ReturnType<typeof startApp>>
beforeAll(async () => { app = await startApp() })
afterAll(() => app?.stop())

type Open = (name: string, room?: string, opts?: PeerOpts) => Promise<Peer>

function scenario(name: string, body: (open: Open) => Promise<void>, skip = false) {
  test.skipIf(skip)(name, async () => {
    const peers: Peer[] = []
    const open: Open = async (peerName, hash = '', opts = {}) => {
      const p = await openPeer(hash, { ...opts, name: peerName })
      peers.push(p)
      return p
    }
    try {
      await body(open)
    } finally {
      for (const p of peers) {
        if (p.errors.length) console.log(`[errors] ${name} ${p.name}:`, p.errors)
        await p.close()
      }
    }
    for (const p of peers) expect(p.errors).toEqual([])
  })
}

const HEADER = 'is running main.cpp]'
const peerCount = (p: Peer) => p.page.locator('#peers [data-client-id]').count()
const connected = (...peers: Peer[]) =>
  waitFor(`${peers.map(p => p.name).join(', ')}: one WebRTC connection each`, async () => (await Promise.all(peers.map(net))).every(n => n.connected === peers.length - 1), 30_000)
const sameText = (p: Peer, code: string) => waitFor(`${p.name}: has the document`, async () => (await text(p)) === code, 30_000)
const sameScreen = (p: Peer, want: string) => waitFor(`${p.name}: same screen`, async () => (await screen(p)) === want, 20_000)
const type = (p: Peer, s: string) => p.page.keyboard.type(s)
const press = (p: Peer, key: string) => p.page.keyboard.press(key)
// What a browser reports for a user who asked to save data: the page then leaves the compiler download to the first Run.
const saveData = () => { Object.defineProperty(Navigator.prototype, 'connection', { get: () => ({ saveData: true }) }) }
/** Whether this peer's Cache Storage holds every one of the toolchain `files`. */
const cached = (p: Peer, files: string[]) => p.page.evaluate(async want => {
  const stored: string[] = []
  for (const name of await caches.keys()) for (const r of await (await caches.open(name)).keys()) stored.push(r.url)
  return want.every(f => stored.some(u => u.endsWith('/' + f)))
}, files)
const noticeShown = (p: Peer) => p.page.evaluate(() => (document.getElementById('notice')!.hidden ? '' : document.getElementById('notice-text')!.textContent ?? ''))

// On the server without AI snippets (harness.ts), the page every instance without a key serves.
scenario('01 smoke', async open => {
  let aiPosts = 0
  const A = await open('A', '', { noAi: true, before: page => void page.on('request', r => { if (new URL(r.url()).pathname === '/ai') aiPosts++ }) })
  expect(await A.page.evaluate(() => crossOriginIsolated)).toBe(true)
  expect(room(A)).toMatch(/^#[A-Za-z0-9_-]{22}$/)
  await waitFor('A: template in the editor', async () => (await A.page.locator('.cm-content').innerText()).includes('class Shape'), 10_000)
  expect(await text(A)).toBe(TEMPLATE)
  // A stored theme is applied by theme.js, a script of its own that the CSP has to let through.
  await A.page.evaluate(() => localStorage.setItem('c-oop.theme', 'dark'))
  await A.page.reload()
  expect(await A.page.evaluate(() => document.documentElement.dataset.theme)).toBe('dark')
  await booted(A)
  // AI snippets are off: no button, and Enter on a prompt line is a plain Enter that sends nothing.
  const upstreamBefore = aiRequests.length
  expect(await A.page.evaluate(async () => (await (await fetch('/config')).json()).ai)).toBe(false)
  await A.page.locator('#editor').click()
  await press(A, 'Control+End')
  await type(A, '??? x')
  await press(A, 'Enter')
  await type(A, 'y')
  await waitFor('A: the prompt line stayed and a new line follows it', async () => /\n\?\?\? x\n[ \t]*y$/.test(await text(A)), 10_000)
  await Bun.sleep(500) // a request would have left by now
  expect(await A.page.locator('#ai').isHidden()).toBe(true)
  expect(aiPosts).toBe(0)
  expect(aiRequests.length).toBe(upstreamBefore)
})

scenario('02 two peers', async open => {
  const A = await open('A')
  const B = await open('B', room(A))
  await connected(A, B)
  await sameText(B, TEMPLATE)
  await A.page.locator('#editor').click()
  await press(A, 'Control+Home')
  await type(A, '// pisze A')
  await waitFor('B: sees the text typed in A', async () => (await B.page.locator('.cm-content').innerText()).includes('// pisze A'), 10_000)
  const aName = await A.page.locator('#name').innerText()
  await waitFor(`B: shows A's caret named ${aName}`, async () => (await B.page.locator('.cm-ySelectionInfo').allInnerTexts()).includes(aName), 10_000)
  await waitFor('#peers shows both, on both', async () => (await peerCount(A)) === 2 && (await peerCount(B)) === 2, 10_000)
  expect((await net(A)).connected).toBe(1)
  expect((await net(B)).connected).toBe(1)
})

scenario('03 hostile presence', async open => {
  const A = await open('A')
  const B = await open('B', room(A))
  await connected(A, B)
  await sameText(B, TEMPLATE)
  await B.page.locator('#editor').click() // B has a caret, so A draws its label
  await waitFor("A: shows B's caret", () => A.page.locator('.cm-ySelectionCaret').count(), 10_000)

  // B starts on the colour an invalid one falls back to, so only the name changes on A: the caret label must follow.
  await B.page.evaluate(() => window.__coop!.collab.awareness.setLocalStateField('user', { name: 'Bartek', color: '#0d7da2' }))
  await waitFor("A: B's caret is labelled Bartek", async () => (await A.page.locator('.cm-ySelectionInfo').allInnerTexts()).includes('Bartek'), 10_000)
  const hostile = '<img src=x onerror=alert(1)>'
  await B.page.evaluate(name => window.__coop!.collab.awareness.setLocalStateField('user', { name, color: 'red;background:url(//x)', colorLight: 'red;background:url(//x)' }), hostile)
  const shown = sanitizeName(hostile) // cut to NAME_MAX, still markup-looking text
  await waitFor('A: hostile name as text in #peers', async () => (await A.page.locator('#peers').innerText()).includes(shown), 10_000)
  await waitFor('A: hostile name as text on the caret label', async () => (await A.page.locator('.cm-ySelectionInfo').allInnerTexts()).includes(shown), 10_000)
  expect(await A.page.evaluate(() => document.querySelectorAll('img[src="x"], [onerror]').length)).toBe(0)
  expect(await A.page.evaluate(() => [...document.querySelectorAll('[style]')].map(e => e.getAttribute('style')!).filter(s => /url\(|red;/.test(s)))).toEqual([])

  // Malformed cursors must not crash A's remote-selections plugin (CodeMirror logs a console error when one does).
  await B.page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur())
  const bId = await B.page.evaluate(() => window.__coop!.collab.doc.clientID)
  const cursorOnA = () => A.page.evaluate(id => JSON.stringify((window.__coop!.collab.awareness.getStates().get(id) as { cursor?: unknown } | undefined)?.cursor ?? null), bId)
  await B.page.evaluate(() => window.__coop!.collab.awareness.setLocalStateField('cursor', { anchor: {}, head: {} }))
  await B.page.evaluate(() => window.__coop!.collab.awareness.setLocalStateField('marker', 1))
  await waitFor('A: received the first hostile cursor state', () => A.page.evaluate(id => (window.__coop!.collab.awareness.getStates().get(id) as { marker?: number } | undefined)?.marker === 1, bId), 10_000)
  expect(await cursorOnA()).toBe('null')
  await B.page.evaluate(() => window.__coop!.collab.awareness.setLocalStateField('cursor', {
    anchor: { type: null, tname: 'code', item: { client: 1, clock: 1.5 }, assoc: 0 },
    head: { type: null, tname: 5, item: null, assoc: 0 },
  }))
  await B.page.evaluate(() => window.__coop!.collab.awareness.setLocalStateField('marker', 2))
  await waitFor('A: received the second hostile cursor state', () => A.page.evaluate(id => (window.__coop!.collab.awareness.getStates().get(id) as { marker?: number } | undefined)?.marker === 2, bId), 10_000)
  expect(await cursorOnA()).toBe('null')
  // An editor update on A makes the plugin read every remote state.
  await A.page.locator('#editor').click()
  await type(A, ' ')

  await B.page.locator('#editor').click()
  await press(B, 'Control+Home')
  await type(B, '@')
  await waitFor("A: receives B's character", async () => (await text(A)).startsWith('@'), 10_000)
  await waitFor("A: shows B's caret again", () => A.page.locator('.cm-ySelectionCaret').count(), 10_000)
  expect(A.errors).toEqual([])
})

scenario('04 class program', async open => {
  const A = await open('A')
  await setCode(A, OOP)
  await done(A, await start(A))
  const s = await screen(A)
  for (const line of ['jestem A', 'jestem B', '42 abab', 'zlapano: bum', exitLine('code:0')]) expect(s).toContain(line)
  expect(count(s, HEADER)).toBe(1)
  expect(await exit(A)).toBe('code:0')
  expect(await status(A)).toBe('Finished, exit code 0')
})

scenario('05 interactive stdin', async open => {
  const A = await open('A')
  await setCode(A, STDIN)
  let id = await start(A)
  await prompted(A, 'Imie? ') // on screen before any key is sent
  expect(await status(A)).toBe('Program is waiting for input')
  await focusTerminal(A)
  await type(A, 'Alx')
  await press(A, 'Backspace')
  await type(A, 'a')
  await waitFor('A: pending line echoed', async () => (await screen(A)).endsWith('Imie? Ala'), 10_000)
  await press(A, 'Enter')
  await prompted(A, 'Miasto? ', 10_000)
  await type(A, 'Gdynia')
  await press(A, 'Enter')
  await waitFor('A: both answers printed', async () => (await screen(A)).includes('[Ala|Gdynia]'), 10_000)
  await type(A, 'x')
  await press(A, 'Enter')
  await press(A, 'Control+d')
  await done(A, id, 20_000)
  let s = await screen(A)
  expect(count(s, 'Imie? Ala\n')).toBe(1)
  expect(count(s, 'Ala')).toBe(2) // the typed line and the program's answer
  expect(s).toContain('linii: 1')
  expect(await exit(A)).toBe('code:0')

  id = await start(A)
  await prompted(A, 'Imie? ')
  await focusTerminal(A)
  await type(A, 'polowa')
  await waitFor('A: half-typed line echoed', async () => (await screen(A)).endsWith('Imie? polowa'), 10_000)
  await press(A, 'Control+c')
  await done(A, id, 20_000)
  expect(await exit(A)).toBe('killed')
  expect(await screen(A)).toContain(exitLine('killed'))

  id = await start(A)
  await prompted(A, 'Imie? ')
  s = await screen(A)
  expect(s).not.toContain('polowa')
  expect(count(s, HEADER)).toBe(1)
  await A.page.locator('#stop').click()
  await done(A, id, 20_000)
})

scenario('06 diagnostics', async open => {
  const A = await open('A')
  const B = await open('B', room(A))
  await connected(A, B)
  await setCode(A, COMPILE_ERROR)
  let id = await start(A)
  await done(A, id)
  await done(B, id, 20_000)
  for (const p of [A, B]) {
    const s = await screen(p)
    expect(s).toMatch(/main\.cpp:3:\d+: error:/)
    expect(s).toContain('std::cout << "x" << std::endl') // the source line
    expect(s).toMatch(/^\s*\|\s*\^/m) // the caret line
    expect(s).toContain(exitLine('compile-error'))
    expect(await status(p)).toBe('Compile error')
  }
  await setCode(A, WARNING)
  id = await start(A)
  await done(A, id)
  await done(B, id, 20_000)
  for (const p of [A, B]) {
    const s = await screen(p)
    expect(s).toContain('warning:')
    expect(s.indexOf('warning:')).toBeLessThan(s.indexOf('wynik-ok\n'))
    expect(s.indexOf('wynik-ok\n')).toBeGreaterThan(-1)
    expect(await exit(p)).toBe('code:0')
  }
})

scenario('07 busy loop', async open => {
  const A = await open('A')
  await setCode(A, BUSY_LOOP)
  let id = await start(A)
  await waitFor('A: the print before the loop is visible', async () => (await phase(A)) === 'running' && (await screen(A)).includes('przed petla'), 120_000)
  await A.page.locator('#stop').click()
  await done(A, id, 5000)
  expect(await exit(A)).toBe('killed')
  await setCode(A, HELLO)
  id = await start(A)
  await done(A, id)
  const s = await screen(A)
  expect(s).not.toContain('przed petla')
  expect(s).toContain('raz dwa trzy')
  expect(count(s, HEADER)).toBe(1)
  expect(await exit(A)).toBe('code:0')
})

scenario('08 output limit', async open => {
  const A = await open('A')
  const B = await open('B', room(A))
  await connected(A, B)
  await setCode(A, FLOOD)
  const id = await start(A)
  // Round trips to both pages for as long as the run lasts: each must come back within 2 s.
  let slowest = 0, trips = 0
  const finished = done(A, id)
  let running = true
  void finished.finally(() => { running = false }).catch(() => {})
  while (running) {
    for (const p of [A, B]) {
      const t = Date.now()
      await p.page.evaluate(() => document.body.dataset.phase)
      slowest = Math.max(slowest, Date.now() - t)
      trips++
    }
  }
  await finished
  console.log(`[info] 08: ${trips} round trips during the run, slowest ${slowest} ms`)
  expect(slowest).toBeLessThan(2000)
  await done(B, id, 20_000)
  for (const p of [A, B]) {
    expect(await exit(p)).toBe('output-limit')
    expect(await screen(p)).toContain(exitLine('output-limit'))
    expect(await status(p)).toBe('Stopped: output limit')
  }
})

scenario('09 shared terminal', async open => {
  const A = await open('A')
  const B = await open('B', room(A))
  await connected(A, B)
  await setCode(A, STDIN)
  let id = await start(A)
  await prompted(A, 'Imie? ')
  await waitFor("B: sees A's prompt live", async () => (await phase(B)) === 'running' && (await screen(B)).endsWith('Imie? '), 10_000)
  expect(await status(B)).toBe(`${await A.page.locator('#name').innerText()} is running the program`)
  await focusTerminal(B)
  await type(B, 'Bartek')
  await press(B, 'Enter')
  await prompted(A, 'Miasto? ', 10_000)
  await focusTerminal(A)
  await type(A, 'Gdynia')
  await press(A, 'Enter')
  await waitFor('A: printed both answers', async () => (await screen(A)).includes('[Bartek|Gdynia]'), 10_000)
  await press(B, 'Control+d')
  await done(A, id, 20_000)
  await done(B, id, 20_000)
  const s = await screen(A)
  await sameScreen(B, s)
  expect(count(s, 'Imie? Bartek\n')).toBe(1)
  expect(count(s, 'Miasto? Gdynia\n')).toBe(1)
  expect(s).toContain('linii: 0')

  id = await start(A)
  await prompted(A, 'Imie? ')
  await waitFor('B: Stop is offered', async () => (await phase(B)) === 'running' && (await B.page.locator('#stop').isVisible()), 10_000)
  await B.page.locator('#stop').click()
  await done(A, id, 20_000)
  await done(B, id, 20_000)
  expect(await exit(A)).toBe('killed')
  expect(await exit(B)).toBe('killed')
})

scenario('10 simultaneous run', async open => {
  const A = await open('A')
  const B = await open('B', room(A))
  await connected(A, B)
  await setCode(A, HELLO)
  await sameText(B, HELLO)
  // Both pages press Run at the same wall-clock instant (same machine, same clock). start() is synchronous, so
  // right after the click each page knows whether it created a run of its own.
  const pressAt = (p: Peer, at: number) => p.page.evaluate(t => new Promise<boolean>(r => setTimeout(() => {
    document.getElementById('run')!.click()
    const { doc } = window.__coop!.collab
    r((doc.getMap('session').get('run') as { get(k: string): unknown } | undefined)?.get('runner') === doc.clientID)
  }, t - Date.now())), at)
  const settled = () => waitFor('one finished run on both', async () => {
    const [a, b] = await Promise.all([storedRun(A), storedRun(B)])
    return !!a && a.id === b?.id && a.phase === 'done' && b.phase === 'done' && (await phase(A)) === 'done' && (await phase(B)) === 'done'
  }, 180_000)
  // A press that lost the race by a few ms (the other run had already arrived) is no collision: press again.
  let both = false
  for (let attempt = 1; attempt <= 5 && !both; attempt++) {
    const at = Date.now() + 1500
    const started = await Promise.all([pressAt(A, at), pressAt(B, at)])
    both = started.every(Boolean)
    console.log(`[info] 10: attempt ${attempt}, own run created on A: ${started[0]}, on B: ${started[1]}`)
    await settled()
  }
  expect(both).toBe(true)
  const s = await screen(A)
  await sameScreen(B, s)
  expect(count(s, HEADER)).toBe(1)
  expect(count(s, 'raz dwa trzy')).toBe(1)
  expect(await exit(A)).toBe('code:0')
  expect(await exit(B)).toBe('code:0')
})

scenario('11 late joiner', async open => {
  const A = await open('A')
  await setCode(A, STDIN)
  const id = await start(A)
  await prompted(A, 'Imie? ')
  const C = await open('C', room(A))
  await sameText(C, STDIN)
  await waitFor('C: output so far of the blocked run', async () => (await phase(C)) === 'running' && (await screen(C)).endsWith('Imie? '), 20_000)
  expect(count(await screen(C), HEADER)).toBe(1)
  await focusTerminal(A)
  await type(A, 'Ala')
  await press(A, 'Enter')
  await prompted(A, 'Miasto? ', 10_000)
  await type(A, 'Gdynia')
  await press(A, 'Enter')
  await press(A, 'Control+d')
  await done(A, id, 20_000)
  await done(C, id, 20_000)
  expect(await exit(C)).toBe('code:0')
  await sameScreen(C, await screen(A))
})

scenario('12 large document', async open => {
  const A = await open('A')
  const big = ('// ' + 'x'.repeat(76) + '\n').repeat(5000) // 400 kB, far past the 256 kB a raw data channel message survives
  expect(big.length).toBe(400_000)
  await setCode(A, big)
  const D = await open('D', room(A))
  await waitFor('D: received the whole document', () => D.page.evaluate(n => window.__coop!.collab.text.length === n, big.length), 60_000)
  expect(await D.page.evaluate(want => window.__coop!.collab.text.toString() === want, big)).toBe(true)
})

scenario('13 runner leaves', async open => {
  const A = await open('A')
  const B = await open('B', room(A))
  await connected(A, B)
  await setCode(A, STDIN)
  await start(A)
  await prompted(A, 'Imie? ')
  await waitFor("B: sees A's prompt", async () => (await screen(B)).endsWith('Imie? '), 10_000)
  expect(A.errors).toEqual([])
  await A.page.goto('about:blank')
  await waitFor('B: runner-left line', async () => (await exit(B)) === 'runner-left' && (await screen(B)).includes(exitLine('runner-left')), 40_000)
  expect(await B.page.locator('#run').isVisible()).toBe(true)
  expect(await B.page.locator('#run').isEnabled()).toBe(true)
})

scenario('14 no turn', async open => {
  // Without a TURN server a relay-only peer connection can never connect.
  const relayOnly = () => {
    const Native = window.RTCPeerConnection
    window.RTCPeerConnection = class extends Native {
      constructor(config?: RTCConfiguration) { super({ ...config, iceTransportPolicy: 'relay' }) }
    }
  }
  const A = await open('A', '', { initScript: relayOnly })
  const B = await open('B', room(A), { initScript: relayOnly })
  const joined = Date.now()
  const stuck = noticeText('stuck', 1)
  // (a)
  await waitFor('A: stuck-peer notice', async () => (await noticeShown(A)) === stuck, 30_000)
  // (b) the forced retry at about 48 s must not make the notice blink
  await waitFor('A: notice stays until 65 s after joining', async () => {
    const shown = await noticeShown(A)
    if (shown !== stuck) throw new Fatal(`notice was "${shown}" ${((Date.now() - joined) / 1000).toFixed(1)} s after joining`)
    return Date.now() - joined >= 65_000
  }, 70_000)
  // (c)
  expect(B.errors).toEqual([])
  await B.close()
  await waitFor('A: notice cleared after B left', async () => (await noticeShown(A)) === '' && (await net(A)).stuck === 0, 75_000)
})

scenario('15 toolchain caching', async open => {
  const A = await open('A', '', { initScript: saveData }) // no background download: the first Run fetches the files
  const requests: string[] = []
  const encodings = new Map<string, string>()
  A.page.on('request', r => requests.push(new URL(r.url()).pathname))
  A.page.on('response', r => encodings.set(new URL(r.url()).pathname, r.headers()['content-encoding'] ?? ''))
  await setCode(A, HELLO)
  await done(A, await start(A))
  expect(await exit(A)).toBe('code:0')
  const wasm = requests.find(p => p.endsWith('/llvm.core.wasm'))
  expect(wasm).toBeDefined() // the listener does see toolchain requests, so their absence below means something
  expect(encodings.get(wasm!)).toBe('br')
  const dir = wasm!.slice(0, wasm!.lastIndexOf('/') + 1)
  const manifest = (await A.page.evaluate(u => fetch(u).then(r => r.json()), dir + 'manifest.json')) as { files: Record<string, number> }
  const files = Object.keys(manifest.files)
  expect(files).toContain('llvm.core.wasm')
  // The cache is written while the compiler streams the files; the reload goes on once it holds every manifest file.
  await waitFor('A: toolchain stored in Cache Storage', () => cached(A, files), 30_000)

  requests.length = 0
  await A.page.reload()
  await booted(A)
  await sameText(A, HELLO)
  await done(A, await start(A))
  expect(await exit(A)).toBe('code:0')
  expect(requests).toContain('/main.js') // still listening after the reload
  expect(requests.filter(p => files.some(f => p.endsWith('/' + f)))).toEqual([])
})

scenario('16 reload keeps the local copy', async open => {
  const A = await open('A', '', { persistent: true })
  await A.page.locator('#editor').click()
  await press(A, 'Control+Home')
  await type(A, '// moja zmiana\n')
  const edited = '// moja zmiana\n' + TEMPLATE
  await sameText(A, edited)
  // y-indexeddb stores one record per keystroke, a few ms behind the typing; this types 15 characters in a burst.
  // The reload goes on once the record count has stopped growing.
  await copySettled(A)
  await A.page.reload()
  await booted(A)
  await sameText(A, edited)
  await waitFor('A: editor shows the text', async () => (await A.page.locator('.cm-content').innerText()).includes('// moja zmiana'), 10_000)
})

scenario("17 reload during someone else's run", async open => {
  // Records every value body[data-exit] takes, from before <body> exists.
  const recordExits = () => {
    const w = window as unknown as { __exits: string[] }
    w.__exits = []
    new MutationObserver(ms => {
      for (const m of ms) if (m.target === document.body) w.__exits.push(m.oldValue ?? '', document.body.dataset.exit ?? '')
    }).observe(document, { subtree: true, attributes: true, attributeFilter: ['data-exit'], attributeOldValue: true })
  }
  const exits = (p: Peer) => p.page.evaluate(() => (window as unknown as { __exits: string[] }).__exits)
  const A = await open('A')
  const B = await open('B', room(A), { persistent: true, initScript: recordExits })
  await connected(A, B)
  await setCode(A, STDIN)
  const id = await start(A)
  await prompted(A, 'Imie? ')
  await waitFor("B: sees A's prompt", async () => (await screen(B)).endsWith('Imie? '), 10_000)
  const before = await exits(B)
  await B.page.reload()
  await booted(B)
  await waitFor('B: prompt and running after the reload', async () => (await phase(B)) === 'running' && (await screen(B)).endsWith('Imie? '), 20_000)
  expect(await B.page.locator('#run').isDisabled()).toBe(true)
  await connected(A, B)
  await focusTerminal(A)
  await type(A, 'Ala')
  await press(A, 'Enter')
  await prompted(A, 'Miasto? ', 10_000)
  await type(A, 'Gdynia')
  await press(A, 'Enter')
  await press(A, 'Control+d')
  await done(A, id, 20_000)
  await done(B, id, 20_000)
  expect(await exit(B)).toBe('code:0')
  expect(await B.page.locator('#run').isDisabled()).toBe(false)
  const seen = [...before, ...(await exits(B))]
  expect(seen).toContain('code:0') // the recorder works
  expect(seen).not.toContain('runner-left')
})

scenario('18 rejected ice config', async open => {
  // /config hands out a TURN entry without credentials, which Chromium refuses in `new RTCPeerConnection`.
  // The page must drop that entry and keep the operator's STUN server: with the bad entry every connection
  // would be destroyed as it starts, and the default servers are third parties the operator replaced.
  const badConfig = () => {
    const native = window.fetch
    window.fetch = ((input, init) =>
      input === '/config'
        ? Promise.resolve(Response.json({ iceServers: [{ urls: ['stun:stun.l.google.com:19302'] }, { urls: ['turn:turn.example.org:3478'] }] }))
        : native(input, init)) as typeof fetch
    // records the ICE URLs of every connection the browser accepted
    const used: string[][] = ((window as unknown as { __ice: string[][] }).__ice = [])
    const Native = window.RTCPeerConnection
    window.RTCPeerConnection = class extends Native {
      constructor(config?: RTCConfiguration) {
        super(config)
        used.push((config?.iceServers ?? []).flatMap(x => x.urls))
      }
    }
  }
  const A = await open('A', '', { initScript: badConfig })
  const B = await open('B', room(A), { initScript: badConfig })
  await connected(A, B)
  await type(A, 'x')
  await sameText(B, await text(A))
  for (const p of [A, B]) {
    const used = await p.page.evaluate(() => (window as unknown as { __ice: string[][] }).__ice)
    // the page's own check of each entry, then the connection to the other peer
    expect(used.filter(u => u.join() === 'stun:stun.l.google.com:19302').length).toBeGreaterThanOrEqual(2)
    expect(used.flat().filter(u => u !== 'stun:stun.l.google.com:19302')).toEqual([])
  }
})

scenario('19 a destroyed document leaves the room', async open => {
  // What a page does when it fails to start after it connected. It must close its signaling socket: left
  // open, y-webrtc announces the page again and the others count a peer they cannot reach.
  const recordSockets = () => {
    const sockets: WebSocket[] = ((window as unknown as { __ws: WebSocket[] }).__ws = [])
    const Native = window.WebSocket
    window.WebSocket = class extends Native {
      constructor(url: string | URL, protocols?: string | string[]) {
        super(url, protocols)
        sockets.push(this)
      }
    }
  }
  const A = await open('A')
  const B = await open('B', room(A), { initScript: recordSockets })
  await connected(A, B)
  await B.page.evaluate(() => window.__coop!.collab.doc.destroy())
  const left = Date.now()
  await waitFor('A: B left the list', async () => (await peerCount(A)) === 1, 10_000)
  await waitFor('B: signaling socket closed', () => B.page.evaluate(() => {
    const sockets = (window as unknown as { __ws: WebSocket[] }).__ws
    return sockets.length > 0 && sockets.every(s => s.readyState === WebSocket.CLOSED)
  }), 10_000)
  await waitFor('A: no unreachable peer until well past the stuck time', async () => {
    const shown = await noticeShown(A)
    const { stuck } = await net(A)
    if (shown !== '' || stuck !== 0) throw new Fatal(`notice "${shown}", stuck ${stuck}, ${((Date.now() - left) / 1000).toFixed(1)} s after B left`)
    return Date.now() - left >= STUCK_MS + 8000
  }, STUCK_MS + 15_000)
})

scenario('20 background compiler download', async open => {
  // Every request under /toolchain/, from before the page loads; the page's and its workers' alike.
  const record = (log: string[]) => (page: Page) => {
    page.on('request', r => {
      const path = new URL(r.url()).pathname
      if (path.startsWith('/toolchain/')) log.push(path)
    })
  }
  const note = (p: Peer) => p.page.locator('#terminal-empty .note').innerText()
  const sLog: string[] = [], aLog: string[] = [], bLog: string[] = []

  // S asks to save data. It is read at the end, long after a background download would have started.
  const S = await open('S', '', { initScript: saveData, before: record(sLog) })

  // A never presses Run until the files are stored: they arrive without a compiler.
  const A = await open('A', '', { before: record(aLog) })
  await waitFor('A: the note says the compiler is downloaded', async () => (await note(A)) === compilerNote('ready'), 60_000)
  const manifestPath = aLog.find(p => p.endsWith('/manifest.json'))!
  const manifest = (await A.page.evaluate(u => fetch(u).then(r => r.json()), manifestPath)) as { files: Record<string, number> }
  const files = Object.keys(manifest.files)
  expect(files).toContain('llvm.core.wasm')
  const requestsPerFile = (log: string[]) => files.map(f => log.filter(p => p.endsWith('/' + f)).length)
  const once = files.map(() => 1)
  expect(await cached(A, files)).toBe(true)
  expect(requestsPerFile(aLog)).toEqual(once)
  expect(A.page.workers()).toEqual([]) // no compiler worker
  expect(aLog.filter(p => p.endsWith('/bundle.js'))).toEqual([]) // and clang's code was not even requested
  // The Run that follows downloads none of them.
  await setCode(A, HELLO)
  await done(A, await start(A))
  expect(await exit(A)).toBe('code:0')
  expect(aLog.filter(p => p.endsWith('/bundle.js')).length).toBe(1) // the log does see the compiler worker's requests
  expect(requestsPerFile(aLog)).toEqual(once)

  // B presses Run while the background download is in flight: its first and biggest file is held back
  // until Run shows the download.
  let release!: () => void
  const held = new Promise<void>(resolve => { release = resolve })
  const B = await open('B', '', {
    before: async page => {
      record(bLog)(page)
      await page.route('**/llvm.core.wasm', async route => {
        await held
        await route.continue()
      })
    },
  })
  await waitFor('B: background download asked for llvm.core.wasm', () => bLog.some(p => p.endsWith('/llvm.core.wasm')), 20_000)
  await setCode(B, HELLO)
  const id = await start(B)
  await waitFor('B: Run shows the download', async () => (await phase(B)) === 'loading' && (await B.page.locator('#progress').isVisible()), 10_000)
  release()
  await done(B, id)
  expect(await exit(B)).toBe('code:0')
  expect(requestsPerFile(bLog)).toEqual(once)

  expect(sLog).toEqual([])
  expect(await note(S)).toBe(compilerNote('on-run'))
})

/** Number of update records in the page's local copy of the room, 0 before it exists. */
const storedUpdates = (p: Peer) => p.page.evaluate(async () => {
  const name = (await indexedDB.databases()).find(d => d.name?.startsWith('c-oop-'))?.name
  if (!name) return 0
  return new Promise<number>((resolve, reject) => {
    const open = indexedDB.open(name)
    open.onerror = () => reject(open.error)
    open.onsuccess = () => {
      const q = open.result.transaction('updates').objectStore('updates').count()
      q.onsuccess = () => { open.result.close(); resolve(q.result) }
      q.onerror = () => { open.result.close(); reject(q.error) }
    }
  })
})
/** Waits until the local copy has stopped growing (the same count on two polls). */
async function copySettled(p: Peer) {
  let stored = -1
  await waitFor(`${p.name}: local copy written`, async () => {
    const n = await storedUpdates(p)
    const settled = n > 0 && n === stored
    stored = n
    return settled
  }, 15_000)
}
/** The lines the editor shows, without the caret marks and names of other people that stand between the characters. */
const editorText = (p: Peer) => p.page.evaluate(() => [...document.querySelectorAll('.cm-line')].map(line => {
  const copy = line.cloneNode(true) as Element
  for (const caret of copy.querySelectorAll('.cm-ySelectionCaret')) caret.remove()
  return copy.textContent
}).join('\n'))

scenario('21 hostile terminal output', async open => {
  const A = await open('A', '', { persistent: true })
  const B = await open('B', room(A))
  await connected(A, B)
  // B stores a finished run it never ran. Unfiltered, the first sequence alone keeps xterm busy until the tab dies.
  await B.page.evaluate(() => {
    const { doc } = window.__coop!.collab
    const session = doc.getMap('session')
    const YMap = doc.getMap('e2e-map').constructor as new () => { set(k: string, v: unknown): void }
    const YArray = doc.getArray('e2e-array').constructor as new () => { push(v: unknown[]): void }
    const run = new YMap(), out = new YArray(), inp = new YArray()
    out.push(['przed\x1b[2147483647T\x9b2147483647b\x1b]52;c;eA==\x07\x1b[2J', '\x1b[214748', '3647Spo \x1b[31mczerwone\x1b[0m\n'])
    doc.transact(() => {
      run.set('id', 'atak0001')
      run.set('runner', doc.clientID)
      run.set('name', 'B')
      run.set('phase', 'done')
      run.set('exit', 'code:0')
      run.set('out', out)
      run.set('in', inp)
      session.set('run', run)
    })
  })
  const shown = `przedpo czerwone\n${exitLine('code:0')}\n`
  for (const p of [A, B]) await waitFor(`${p.name}: the run is on screen as plain text`, async () => (await screen(p)).endsWith(shown), 10_000)
  await copySettled(A)
  await A.page.reload()
  await booted(A)
  await waitFor('A: the stored run is replayed as plain text after the reload', async () => (await screen(A)).endsWith(shown), 10_000)
  await setCode(A, HELLO) // and the page still works
  await done(A, await start(A))
  expect(await screen(A)).toContain('raz dwa trzy')
})

scenario('22 hostile document content', async open => {
  const A = await open('A', '', { persistent: true })
  const B = await open('B', room(A))
  await connected(A, B)
  await sameText(B, TEMPLATE)
  await waitFor('A: template in the editor', async () => (await editorText(A)).includes('class Shape'), 10_000)
  const clean = (p: Peer, want: string) => waitFor(`${p.name}: the text is ${JSON.stringify(want.slice(0, 12))}... and holds nothing else`, () =>
    p.page.evaluate(w => {
      const { text } = window.__coop!.collab
      return text.toString() === w && text.length === w.length && text.toDelta().length === 1
    }, want), 10_000)

  // An embed alone, then one inside a transaction with text and formatting.
  await B.page.evaluate(() => window.__coop!.collab.text.insertEmbed(0, { evil: true }))
  await clean(A, TEMPLATE)
  await B.page.evaluate(() => {
    const { doc, text } = window.__coop!.collab
    doc.transact(() => {
      text.insert(0, '// B')
      text.insertEmbed(4, { evil: true })
      text.insert(5, '\n', { bold: true })
      text.format(0, 2, { italic: true })
    })
  })
  let want = '// B\n' + TEMPLATE
  await clean(A, want)
  await clean(B, want)
  await waitFor("A: the editor shows B's line first", async () => (await editorText(A)).startsWith('// B\n#include <iostream>'), 10_000)
  await A.page.locator('#editor').click()
  await press(A, 'Control+Home')
  await type(A, '// A\n')
  want = '// A\n' + want
  await clean(B, want)
  await clean(A, want)
  expect(await editorText(A)).toStartWith('// A\n// B\n#include <iostream>')

  // The same things arrive from the stored copy: an update from a client without the guard, put into A's IndexedDB.
  const hostile = new Y.Doc()
  hostile.getText('code').insertEmbed(0, { evil: true })
  const forged = new Y.Doc()
  forged.getArray('code').push([1, { two: 2 }])
  await copySettled(A)
  await A.page.evaluate(async updates => {
    const name = (await indexedDB.databases()).find(d => d.name?.startsWith('c-oop-'))!.name!
    await new Promise<void>((resolve, reject) => {
      const open = indexedDB.open(name)
      open.onerror = () => reject(open.error)
      open.onsuccess = () => {
        const tx = open.result.transaction('updates', 'readwrite')
        for (const u of updates) tx.objectStore('updates').add(new Uint8Array(u))
        tx.oncomplete = () => { open.result.close(); resolve() }
        tx.onerror = () => { open.result.close(); reject(tx.error) }
      }
    })
  }, [hostile, forged].map(d => [...Y.encodeStateAsUpdate(d)]))
  await A.page.reload()
  await booted(A)
  await clean(A, want)
  await waitFor('A: the editor shows the text after the reload', async () => (await editorText(A)).startsWith('// A\n// B\n#include <iostream>'), 10_000)
  await connected(A, B)
  await A.page.locator('#editor').click()
  await press(A, 'Control+Home')
  await type(A, '!')
  want = '!' + want
  await clean(B, want)
  await clean(A, want)
  expect(await editorText(A)).toStartWith('!// A\n// B\n')
})

scenario('23 code size limit', async open => {
  const A = await open('A')
  const B = await open('B', room(A))
  await connected(A, B)
  await sameText(B, TEMPLATE)
  await waitFor('A: template in the editor', async () => (await editorText(A)).includes('class Shape'), 10_000)
  const length = (p: Peer) => p.page.evaluate(() => window.__coop!.collab.text.length)
  // A paste through the editor itself, of as many characters as the whole file may have.
  const paste = () => A.page.evaluate(n => {
    const data = new DataTransfer()
    data.setData('text/plain', ('// ' + 'x'.repeat(76) + '\n').repeat(n / 80))
    document.querySelector('.cm-content')!.dispatchEvent(new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true }))
  }, CODE_MAX)
  await A.page.locator('#editor').click()

  // Above text that is already there: the paste is shortened where it lands, the text after it stays, and undo takes the paste back whole.
  const line7 = TEMPLATE.indexOf('class Shape')
  for (const [where, at] of [['at the top', 0], ['in the middle', line7]] as const) {
    // The undo manager joins edits less than 500 ms apart into one step; the paste has to be a step of its own.
    const since = Date.now()
    await waitFor(`A: a pause before the paste ${where}`, () => Date.now() - since > 600, 3000)
    await press(A, 'Control+Home')
    if (at) for (let i = 0; i < 6; i++) await press(A, 'ArrowDown')
    await paste()
    for (const p of [A, B]) {
      await waitFor(`${p.name}: the paste ${where} is shortened to fit and the rest of the file is still there`, () => p.page.evaluate(([head, tail, max]) => {
        const t = window.__coop!.collab.text.toString()
        return t.length === max && t.startsWith(head + '// xxx') && t.endsWith(tail)
      }, [TEMPLATE.slice(0, at), TEMPLATE.slice(at), CODE_MAX] as const), 60_000)
    }
    await waitFor('A: the notice says so', async () => (await noticeShown(A)) === noticeText('code-limit'), 5000)
    await press(A, 'Control+z')
    for (const p of [A, B]) await waitFor(`${p.name}: undo gave back exactly the text from before`, async () => (await text(p)) === TEMPLATE, 60_000)
    await waitFor('A: the editor shows it', async () => (await editorText(A)).startsWith(TEMPLATE.slice(0, line7 + 13)), 10_000)
  }

  await press(A, 'Control+End')
  await paste()
  for (const p of [A, B]) await waitFor(`${p.name}: the text is cut to the limit`, async () => (await length(p)) === CODE_MAX, 60_000)
  expect(await text(A)).toStartWith(TEMPLATE)
  await waitFor('A: the notice says so', async () => (await noticeShown(A)) === noticeText('code-limit'), 5000)
  // The editor still follows the document, on both sides: with the file full, a line typed at the top does not fit,
  // and after a line was deleted it does.
  await press(A, 'Control+Home')
  await type(A, 'x')
  expect(await text(A)).toStartWith(TEMPLATE)
  await press(A, 'Control+End')
  await press(A, 'Shift+ArrowUp')
  await press(A, 'Backspace')
  await press(A, 'Control+Home')
  await type(A, '// dalej\n')
  for (const p of [A, B]) {
    await waitFor(`${p.name}: has the new first line, within the limit`, async () => (await length(p)) <= CODE_MAX && (await text(p)).startsWith('// dalej\n#include'), 30_000)
    await waitFor(`${p.name}: the editor shows it`, async () => (await editorText(p)).startsWith('// dalej\n#include <iostream>'), 10_000)
  }
  // What does not come through the editor is still cut at the end, by every peer.
  await B.page.evaluate(n => window.__coop!.collab.text.insert(0, '/'.repeat(n)), 100)
  for (const p of [A, B]) await waitFor(`${p.name}: a write past the limit from outside the editor is cut`, async () => (await length(p)) === CODE_MAX && (await text(p)).startsWith('////'), 30_000)
  // What the editor adds to a keystroke counts as typed: with room for one character, a `}` that the editor indents
  // by four spaces is shortened where it stands, and the end of the file stays.
  const body = 'int main() {\n    if (1) {\n        int x = 0;\n\n    return 0;\n}\n'
  await setCode(A, body + '/'.repeat(CODE_MAX - 1 - body.length - 3) + 'END')
  await waitFor('A: the editor shows the new file', async () => (await editorText(A)).startsWith(body), 10_000)
  await press(A, 'Control+Home')
  for (let i = 0; i < 3; i++) await press(A, 'ArrowDown')
  await type(A, '}')
  await waitFor('A: the file is full', async () => (await length(A)) === CODE_MAX, 10_000)
  expect((await text(A)).slice(-10)).toBe('///////END')
})

scenario('24 run and stop share one place', async open => {
  const A = await open('A')
  await setCode(A, STDIN)
  const focused = () => A.page.evaluate(() => document.activeElement?.id || document.activeElement?.className || '')
  const kill = () => A.page.evaluate(() => {
    const run = window.__coop!.collab.doc.getMap('session').get('run') as { get(k: string): { push(v: unknown[]): void } }
    run.get('in').push([{ t: 'kill' }])
  })
  // The second click of a double-click lands on the button that has just taken the other's place under the pointer.
  // The page sends that click itself, in the moment the button appears: no outside click can be timed that closely.
  const secondClickOn = (button: 'run' | 'stop') => A.page.evaluate(id => {
    const el = document.getElementById(id)!
    new MutationObserver((_, observer) => {
      if (el.hidden) return
      observer.disconnect()
      el.dispatchEvent(new MouseEvent('click', { detail: 2, bubbles: true }))
      document.body.dataset.secondClick = id
      document.body.dataset.swappedAt = String(performance.now())
    }).observe(el, { attributes: true, attributeFilter: ['hidden'] })
  }, button)
  const secondClickSent = (button: 'run' | 'stop') => waitFor(`A: the second click was sent to ${button}`, () => A.page.evaluate(id => document.body.dataset.secondClick === id, button), 5000)
  // A double-click on Run must not stop the run it started.
  const box = (await A.page.locator('#run').boundingBox())!
  const at = [box.x + box.width / 2, box.y + box.height / 2] as const
  await secondClickOn('stop')
  await A.page.mouse.click(...at)
  let id = (await waitFor('A: run started', () => storedRun(A), 5000)).id
  await secondClickSent('stop')
  await prompted(A, 'Imie? ')
  expect(await storedRun(A)).toEqual({ id, phase: 'running' })
  // Later every click on Stop counts, also one the browser numbers as the third of a row.
  await A.page.mouse.click(...at, { clickCount: 3 })
  await done(A, id, 20_000)
  expect(await exit(A)).toBe('killed')
  await waitFor('A: focus is back on Run', async () => (await focused()) === 'run', 5000)
  // By keyboard nothing is ignored, however soon: Stop has the focus Run had, and gives it back.
  await press(A, 'Enter')
  id = (await waitFor('A: second run started', async () => { const r = await storedRun(A); return r && r.id !== id ? r : null }, 5000)).id
  await prompted(A, 'Imie? ')
  expect(await focused()).toBe('stop')
  await press(A, 'Enter')
  await done(A, id, 20_000)
  expect(await exit(A)).toBe('killed')
  await waitFor('A: focus is on Run again', async () => (await focused()) === 'run', 5000)
  // A run that ends by itself while Stop has the focus.
  await press(A, 'Enter')
  id = (await waitFor('A: third run started', async () => { const r = await storedRun(A); return r && r.id !== id ? r : null }, 5000)).id
  await prompted(A, 'Imie? ')
  expect(await focused()).toBe('stop')
  await kill()
  await done(A, id, 20_000)
  await waitFor('A: focus returned to Run', async () => (await focused()) === 'run', 5000)
  // A double-click on Stop must not start the program again.
  id = await start(A)
  await prompted(A, 'Imie? ')
  await secondClickOn('run')
  await A.page.mouse.click(...at)
  // Not through waitFor: its steps of a second would pass the half second the next check is about.
  await A.page.waitForFunction(() => document.body.dataset.secondClick === 'run', undefined, { timeout: 5000 })
  const sinceSwap = await A.page.evaluate(() => performance.now() - Number(document.body.dataset.swappedAt))
  expect(await storedRun(A)).toEqual({ id, phase: 'done' })
  // Half a second after the buttons traded places a single click counts again.
  expect(sinceSwap).toBeLessThan(400)
  await Bun.sleep(500 - sinceSwap)
  await A.page.mouse.click(...at)
  const stopped = id
  id = (await waitFor('A: a click half a second after the swap started a run', async () => { const r = await storedRun(A); return r && r.id !== stopped ? r : null }, 5000)).id
  await prompted(A, 'Imie? ')
  await kill()
  await done(A, id, 20_000)
  // Focus elsewhere is left alone.
  id = await start(A)
  await prompted(A, 'Imie? ')
  await A.page.locator('#editor').click()
  await kill()
  await done(A, id, 20_000)
  expect(await focused()).toContain('cm-content')
})

/** The names drawn on remote carets in this peer's editor right now. */
const caretNames = (p: Peer) => p.page.evaluate(() =>
  [...document.querySelectorAll('.cm-ySelectionInfo')].filter(e => getComputedStyle(e).display !== 'none').map(e => e.textContent))

scenario('25 caret names', async open => {
  const A = await open('A')
  const B = await open('B', room(A))
  const C = await open('C', room(A))
  await connected(A, B, C)
  for (const p of [B, C]) await sameText(p, TEMPLATE)
  await B.page.evaluate(() => window.__coop!.collab.setName('Bartek'))
  await C.page.evaluate(() => window.__coop!.collab.setName('Celina'))
  // Both carets on the comment line: C's at its end, B's three characters before, so that B's typing moves C's caret along.
  for (const p of [B, C]) {
    await p.page.locator('#editor').click()
    await press(p, 'Control+Home')
    for (let i = 0; i < 5; i++) await press(p, 'ArrowDown')
    await press(p, 'End')
  }
  for (let i = 0; i < 3; i++) await press(B, 'ArrowLeft')
  await waitFor('A: both carets are drawn', async () => (await A.page.locator('.cm-ySelectionCaret').count()) === 2, 10_000)
  await waitFor('A: the names from the carets arriving are gone', async () => (await caretNames(A)).length === 0, 10_000)

  let stoppedAt = 0
  const typed = type3s(B).finally(() => { stoppedAt = Date.now() })
  await waitFor("A: B's name shows once B types", async () => (await caretNames(A)).includes('Bartek'), 3000)
  await waitFor("A: B's name, and only B's, shows for as long as B types", async () => {
    const stillTyping = stoppedAt === 0
    const names = await caretNames(A)
    if (stillTyping && names.join() !== 'Bartek') throw new Fatal(`names shown while B types: [${names}]`)
    return !stillTyping
  }, 6000)
  await typed
  await waitFor("A: B's name goes away after B stopped", async () => {
    const names = await caretNames(A)
    if (names.includes('Celina')) throw new Fatal("C's name shown")
    return names.length === 0
  }, 5000)
  expect(Date.now() - stoppedAt).toBeGreaterThan(1000) // not at once: it stays for about two seconds after the last character
  expect(await text(A)).toContain('name and arabcdefghijklmnopqrstuvwxyzabcdea.\n')

  // Two carets in one place: the name shows on the caret of the one who types, not on both. C's window is in the
  // background here: a focused editor reports its caret again after an insertion at it, and its name shows then (README).
  await C.page.evaluate(() => { document.hasFocus = () => false })
  await press(B, 'End')
  await waitFor("A: the name from B's move is gone", async () => (await caretNames(A)).length === 0, 10_000)
  await type(B, 'q')
  await waitFor("A: B's name shows and C's does not", async () => {
    const names = await caretNames(A)
    if (names.includes('Celina')) throw new Fatal("C's name shown")
    return names.join() === 'Bartek'
  }, 3000)
})

/** Types 30 characters over 3 seconds. */
const type3s = (p: Peer) => p.page.keyboard.type('abcdefghijklmnopqrstuvwxyzabcd', { delay: 100 })

scenario('26 polish letters on stdin', async open => {
  const A = await open('A')
  const B = await open('B', room(A))
  const C = await open('C', room(A))
  await connected(A, B, C)
  await setCode(A, ECHO)
  const id = await start(A)
  await prompted(A, '> ')
  await waitFor('B: sees the prompt', async () => (await screen(B)).endsWith('> '), 10_000)
  await focusTerminal(B)
  const cdp = await B.page.context().newCDPSession(B.page)
  // What a Polish keyboard sends: for a letter with a diacritic the level-3 key (AltGr) goes down, then the letter key
  // arrives with the composed character. Not page.keyboard.type: for these letters Playwright inserts the text without
  // any key event, which is the one input path the terminal does not take (README, Limits).
  const BASE: Record<string, string> = { ą: 'A', ć: 'C', ę: 'E', ł: 'L', ń: 'N', ó: 'O', ś: 'S', ź: 'X', ż: 'Z' }
  const keyboard = async (line: string) => {
    for (const ch of line) {
      const base = BASE[ch.toLowerCase()]
      const letter = { key: ch, code: ch === ' ' ? 'Space' : `Key${base ?? ch.toUpperCase()}`, windowsVirtualKeyCode: (base ?? ch.toUpperCase()).charCodeAt(0), modifiers: ch === ch.toLowerCase() ? 0 : 8 }
      const altGr = { key: 'AltGraph', code: 'AltRight', windowsVirtualKeyCode: 225 }
      if (base) await cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', ...altGr })
      await cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', text: ch, ...letter })
      await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', ...letter })
      if (base) await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', ...altGr })
    }
  }
  // An input method: the word is composed in the terminal's input field, then committed.
  const ime = async (line: string) => {
    await cdp.send('Input.imeSetComposition', { text: line, selectionStart: line.length, selectionEnd: line.length })
    await cdp.send('Input.insertText', { text: line })
  }
  const pasted = (line: string) => B.page.evaluate(t => {
    const data = new DataTransfer()
    data.setData('text/plain', t)
    document.querySelector('#terminal textarea')!.dispatchEvent(new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true }))
  }, line)

  let want = await screen(A)
  for (const [how, enter, line] of [['keyboard', keyboard, 'zażółć gęślą jaźń ŻÓŁ'], ['input method', ime, 'ĄĆĘŃŚŹ ąćęłńóśźż'], ['paste', pasted, 'Żółw ściął źdźbło']] as const) {
    await enter(line)
    await waitFor(`B: the line entered by ${how} is echoed as typed`, async () => (await screen(B)).endsWith('> ' + line), 10_000)
    await press(B, 'Enter')
    want += `${line}\n[${line}]\n> `
    for (const p of [B, A, C]) await sameScreen(p, want) // the typist, the runner and a watcher
  }
  await press(B, 'Control+d')
  await done(A, id, 20_000)
  expect(await exit(A)).toBe('code:0')
})

// A tap leaves no pointer resting on the button, so the second tap of a double tap is told by the press before it.
scenario('27 double tap on run', async open => {
  for (const gap of [0, 150]) {
    const A = await open(gap ? `A (taps ${gap} ms apart)` : 'A (held tap, then a tap)', '', { touch: true })
    await setCode(A, STDIN)
    const box = (await A.page.locator('#run').boundingBox())!
    const at = [box.x + box.width / 2, box.y + box.height / 2] as const
    if (gap) await A.page.touchscreen.tap(...at)
    else { // a slow first tap: the finger rests longer than the guard lasts before it lifts
      const cdp = await A.page.context().newCDPSession(A.page)
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: at[0], y: at[1] }] })
      await Bun.sleep(450)
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] })
    }
    await Bun.sleep(gap || 100)
    await A.page.touchscreen.tap(...at)
    const id = (await waitFor(`${A.name}: run started`, () => storedRun(A), 5000)).id
    await waitFor(`${A.name}: the run goes on to its prompt`, async () => {
      if ((await storedRun(A))?.phase === 'done') throw new Fatal('the second tap stopped the run')
      return A.page.evaluate(() => document.getElementById('terminal')!.dataset.stdin === 'waiting')
    }, 120_000)
    // A tap on Stop after that counts.
    await A.page.touchscreen.tap(...at)
    await done(A, id, 20_000)
    expect(await exit(A)).toBe('killed')
  }
})

// Against a stub of the Anthropic API (harness.ts). Skipped for BASE_URL: the image under test has no key and cannot reach the stub.
scenario('28 ai snippet', async open => {
  const A = await open('A')
  const B = await open('B', room(A))
  await connected(A, B)
  const both = async (what: string, code: string) => {
    await waitFor(`A and B: ${what}`, async () => (await text(A)) === code && (await text(B)) === code, 30_000)
  }
  const aiState = (p: Peer) => p.page.evaluate(() => { const b = document.getElementById('ai')!; return b.hidden ? 'hidden' : b.dataset.state })
  await setCode(A, 'int main() {\n    ??? declare answer\n    return 0;\n}\n')
  await sameText(B, 'int main() {\n    ??? declare answer\n    return 0;\n}\n')
  await A.page.locator('#editor').click()
  await press(A, 'Control+Home')
  await press(A, 'ArrowDown')
  await press(A, 'End')
  await type(A, ' please')
  await press(A, 'Enter') // straight away: the typing and the removal of the line must still be two undo steps

  const gone = 'int main() {\n    return 0;\n}\n'
  await sameText(B, gone) // the prompt line went for everyone
  await waitFor('A: generated code is ready', async () => (await aiState(A)) === 'ready', 30_000)
  expect(await text(A)).toBe(gone)
  expect(await aiState(B)).toBe('hidden')
  const sent = aiRequests.at(-1)!
  expect(sent.model).toBe('claude-sonnet-5-5')
  expect(sent.output_config.effort).toBe('low')
  const asked = JSON.stringify(sent.messages)
  for (const part of ['declare answer please', '<insert_here/>', 'int main() {']) expect(asked).toContain(part)

  // A peer's edit above the place moves it; the code still lands where the line was.
  await B.page.evaluate(() => window.__coop!.collab.text.insert(0, '#include <vector>\n'))
  await sameText(A, '#include <vector>\n' + gone)
  await press(A, 'Control')
  await Bun.sleep(700) // one tap of Control inserts nothing, however long one waits
  expect(await aiState(A)).toBe('ready')
  expect(await text(A)).toBe('#include <vector>\n' + gone)
  await press(A, 'Control')
  await press(A, 'Control')
  await both('the code is inserted', '#include <vector>\nint main() {\n    int answer = 42;\n    int twice = answer * 2;\n    return 0;\n}\n')
  await waitFor('A: the button is gone', async () => (await aiState(A)) === 'hidden', 10_000)

  await A.page.locator('#editor').click()
  await press(A, 'Control+z')
  await both('the first undo removed the code', '#include <vector>\n' + gone)
  await press(A, 'Control+z')
  await both('the second undo brought the prompt line back whole', '#include <vector>\nint main() {\n    ??? declare answer please\n    return 0;\n}\n')
}, !!process.env.BASE_URL)
