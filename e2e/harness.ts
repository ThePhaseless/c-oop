// Browser harness for the end-to-end suite: one Chromium process per peer, every wait through waitFor.
import { mkdtemp, readdir, rm } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { type BrowserContext, chromium, type Page } from 'playwright-core'
import { createServer } from '../src/server/server.ts'
import { exitLine } from '../src/client/strings.ts'
import { DEFAULT_ICE } from '../src/shared/limits.ts'

/** Thrown by a waitFor check to end the wait at once instead of polling on. */
export class Fatal extends Error {}

export type Peer = { name: string; page: Page; errors: string[]; close(): Promise<void> }
/** `before` gets the page before it navigates: the place for routes and for listeners that must see every request. */
export type PeerOpts = { name?: string; persistent?: boolean; touch?: boolean; initScript?: () => void; before?: (page: Page) => void | Promise<void> }

const open = new Set<Peer>() // a recorded error or a closed page on any of these fails the running wait

/**
 * Polls `check` at once and then every 1 s until it returns something truthy. Prints why the wait ended:
 * `success`, `FAILURE: <error>` (a Fatal from the check, or a page error on an open peer) or `DEADLINE`.
 * Any other error from the check (a page that is reloading) counts as "not yet".
 */
export async function waitFor<T>(label: string, check: () => T | Promise<T>, deadlineMs: number): Promise<NonNullable<T>> {
  const start = Date.now()
  const took = () => `${((Date.now() - start) / 1000).toFixed(1)} s`
  let last = ''
  for (;;) {
    let failure: string | undefined
    try {
      const v = await check()
      if (v) {
        console.log(`[wait] ${label}: success after ${took()}`)
        return v as NonNullable<T>
      }
    } catch (e) {
      if (e instanceof Fatal) failure = e.message
      else last = e instanceof Error ? e.message : String(e)
    }
    for (const p of open) failure ??= p.errors.length ? `${p.name}: ${p.errors[0]}` : p.page.isClosed() ? `${p.name}: page closed` : undefined
    if (failure) {
      console.log(`[wait] ${label}: FAILURE: ${failure} after ${took()}`)
      throw new Error(`${label}: ${failure}`)
    }
    const left = deadlineMs - (Date.now() - start)
    if (left <= 0) {
      console.log(`[wait] ${label}: DEADLINE after ${took()}${last ? ` (last error: ${last})` : ''}`)
      throw new Error(`${label}: deadline of ${deadlineMs} ms passed${last ? `: ${last}` : ''}`)
    }
    await Bun.sleep(Math.min(1000, left))
  }
}

let base = ''

/** The app under test: `BASE_URL` when set (the container), otherwise an in-process server over `dist`. */
export async function startApp(): Promise<{ base: string; stop(): Promise<void> }> {
  if (process.env.BASE_URL) {
    base = process.env.BASE_URL.replace(/\/+$/, '')
    return { base, stop: async () => {} }
  }
  const server = await createServer({ port: 0, distDir: 'dist', iceServers: DEFAULT_ICE })
  base = `http://localhost:${server.port}`
  return { base, stop: () => server.stop(true) }
}

// playwright-core looks for one exact browser revision; use whatever this machine has (newest first).
async function chromePath(): Promise<string> {
  if (process.env.CHROME) return process.env.CHROME
  const root = join(homedir(), '.cache/ms-playwright')
  const dirs = (await readdir(root).catch(() => [] as string[]))
    .map(d => ({ d, m: /^chromium(_headless_shell)?-(\d+)$/.exec(d) }))
    .filter(x => x.m)
    .sort((a, b) => Number(b.m![2]) - Number(a.m![2]) || Number(!!b.m![1]) - Number(!!a.m![1]))
  for (const { d } of dirs) {
    for await (const f of new Bun.Glob('*/{chrome-headless-shell,chrome}').scan({ cwd: join(root, d), absolute: true })) return f
  }
  throw new Error(`no Chromium under ${root}; set CHROME to a Chromium executable`)
}

/** Opens the app in a new browser process. `room` is '' for a new room or the '#secret' of an existing one. */
export async function openPeer(room: string, opts: PeerOpts = {}): Promise<Peer> {
  const launch = { executablePath: await chromePath() }
  const ctxOpts = { ignoreHTTPSErrors: base.startsWith('https:'), viewport: { width: 1280, height: 800 }, hasTouch: !!opts.touch }
  let context: BrowserContext, dispose: () => Promise<void>
  if (opts.persistent) {
    const dir = await mkdtemp(join(tmpdir(), 'c-oop-e2e-'))
    context = await chromium.launchPersistentContext(dir, { ...launch, ...ctxOpts })
    dispose = async () => {
      await context.close().catch(() => {})
      await rm(dir, { recursive: true, force: true })
    }
  } else {
    const browser = await chromium.launch(launch)
    context = await browser.newContext(ctxOpts)
    dispose = () => browser.close().catch(() => {})
  }
  context.setDefaultTimeout(10_000) // an action that cannot happen fails soon and says which one
  const page = context.pages()[0] ?? (await context.newPage())
  const errors: string[] = []
  page.on('pageerror', e => errors.push(`pageerror: ${e.message}`))
  page.on('console', m => { if (m.type() === 'error') errors.push(`console: ${m.text()}`) })
  page.on('dialog', d => { errors.push(`dialog: ${d.message()}`); void d.dismiss().catch(() => {}) })
  await page.addInitScript(() => document.addEventListener('securitypolicyviolation', e => console.error(`CSP ${e.violatedDirective} ${e.blockedURI}`)))
  if (opts.initScript) await page.addInitScript(opts.initScript)
  await opts.before?.(page)
  const peer: Peer = {
    name: opts.name ?? 'peer',
    page,
    errors,
    async close() {
      open.delete(peer)
      await dispose()
    },
  }
  open.add(peer)
  try {
    await page.goto(`${base}/${room}`)
    await booted(peer)
  } catch (e) {
    await peer.close()
    throw e
  }
  return peer
}

// ---- small readers and actions shared by the scenarios ----

export const booted = (p: Peer) => waitFor(`${p.name}: app booted`, () => p.page.evaluate(() => !!window.__coop), 20_000)
export const room = (p: Peer) => new URL(p.page.url()).hash
export const screen = (p: Peer) => p.page.evaluate(() => window.__coop!.screen())
export const text = (p: Peer) => p.page.evaluate(() => window.__coop!.collab.text.toString())
export const net = (p: Peer) => p.page.evaluate(() => window.__coop!.collab.net())
export const phase = (p: Peer) => p.page.evaluate(() => document.body.dataset.phase)
export const exit = (p: Peer) => p.page.evaluate(() => document.body.dataset.exit)
export const status = (p: Peer) => p.page.locator('#status').innerText()
export const count = (hay: string, needle: string) => hay.split(needle).length - 1

export const setCode = (p: Peer, code: string) =>
  p.page.evaluate(c => {
    const { doc, text } = window.__coop!.collab
    doc.transact(() => {
      text.delete(0, text.length)
      text.insert(0, c)
    })
  }, code)

/** The stored run of this peer's document: its id and phase, or null. */
export const storedRun = (p: Peer) =>
  p.page.evaluate(() => {
    const run = window.__coop!.collab.doc.getMap('session').get('run') as { get(k: string): unknown } | undefined
    return run ? { id: String(run.get('id')), phase: String(run.get('phase')) } : null
  })

/** Presses Run and returns the id of the run that started. */
export async function start(p: Peer): Promise<string> {
  const before = (await storedRun(p))?.id
  // Pressed until a run starts: Run ignores a pointer click in the first moments after it took Stop's place under the pointer.
  return (await waitFor(`${p.name}: run started`, async () => {
    await p.page.locator('#run').click()
    const run = await storedRun(p)
    return run && run.id !== before ? run : null
  }, 5000)).id
}

/** Waits until run `id` is stored as finished on this peer and the page shows it, its last line in the terminal included. */
export const done = (p: Peer, id: string, deadlineMs = 120_000) =>
  waitFor(`${p.name}: run ${id} done`, async () => {
    const run = await storedRun(p)
    if (run?.id !== id || run.phase !== 'done' || (await phase(p)) !== 'done') return false
    const how = await exit(p) // the terminal draws a moment after the state changes
    return !!how && (await screen(p)).includes(exitLine(how as Parameters<typeof exitLine>[0]))
  }, deadlineMs)

/** Waits until the program blocks on stdin on its runner with `prompt` as the last thing on screen. */
export const prompted = (p: Peer, prompt: string, deadlineMs = 120_000) =>
  waitFor(`${p.name}: waiting on stdin at "${prompt}"`, () =>
    p.page.evaluate(q => document.getElementById('terminal')!.dataset.stdin === 'waiting' && window.__coop!.screen().endsWith(q), prompt), deadlineMs)

/** Focuses the terminal (a click on Run leaves focus on the Run/Stop button). */
export const focusTerminal = (p: Peer) => p.page.locator('#terminal').click()
