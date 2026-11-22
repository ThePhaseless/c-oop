// Boot sequence and wiring. The only file that uses __TOOLCHAIN_ID__.
import type { Collab, CompilerFiles, NetStatus, Notice, RunView, Session, Term, UiState } from '../shared/contracts'
import { DEFAULT_ICE } from '../shared/limits'
import { createCollab } from './collab'
import { createCpp } from './cpp/cpp'
import { createEditor } from './editor'
import { deriveRoom, newSecret, parseSecret } from './room'
import { createSession } from './session'
import { TEMPLATE } from './strings'
import { createTerminal } from './terminal'
import { mountUi } from './ui'

declare const __TOOLCHAIN_ID__: string
declare global {
  interface Window { __coop?: { screen(): string; collab: Collab } }
}

const OFFLINE_MS = 5000 // signaling down this long shows the 'offline' notice
const IDLE: RunView = { phase: 'idle', runnerName: '', mine: false, exit: null, progress: null, stdinWaiting: false }
const NO_NET: NetStatus = { signaling: false, connected: 0, stuck: 0 }

// The handlers exist before the objects they act on, so they read these at call time.
let collab: Collab | undefined, session: Session | undefined, term: Term | undefined

const ui = mountUi({
  run: () => session?.start(),
  stop: () => session?.stop(),
  rename: name => collab?.setName(name),
  newRoom: () => { location.hash = '' }, // the hashchange listener below reloads into a fresh room
  themeChanged: () => term?.setTheme(),
})
const blocked = (notice: Notice) => ui.render({ peers: [], net: NO_NET, run: IDLE, notice, canRun: false, compiler: 'on-run' })
let failed = false // boot threw: the blocking notice stays, whatever re-renders later

async function boot() {
  if (!isSecureContext || !crypto.subtle) return blocked('insecure')

  addEventListener('hashchange', () => location.reload())
  let secret: string | null, isNew = false
  if (location.hash.length <= 1) {
    secret = newSecret()
    history.replaceState(null, '', '#' + secret)
    isNew = true
  } else if (!(secret = parseSecret(location.hash))) return blocked('bad-link')

  const config = fetch('/config').then(r => (r.ok ? r.json() : null)).catch(() => null) as Promise<{ iceServers?: unknown } | null>
  const [keys, cfg] = await Promise.all([deriveRoom(secret), config])
  const offered = Array.isArray(cfg?.iceServers) ? (cfg.iceServers as RTCIceServer[]) : DEFAULT_ICE
  new RTCPeerConnection().close() // WebRTC missing or blocked: boot throws here and the page shows the 'failed' notice
  // Only the browser knows which entries it accepts. With a rejected one every connection would be destroyed
  // as it is created and y-webrtc would announce again without end, so each entry is tried alone and the
  // rejected ones are dropped. The defaults do not take their place: the operator may have replaced them.
  // (Only a /config that cannot be read at all falls back to the defaults, above.)
  const iceServers = offered.filter(s => {
    try {
      new RTCPeerConnection({ iceServers: [s] }).close()
      return true
    } catch (e) {
      console.warn('c-oop: this browser rejects an ICE server from /config, connecting without it:', e)
      return false
    }
  })
  const c = collab = createCollab({
    keys, iceServers, isNew, template: TEMPLATE,
    onCodeCut: () => ui.flash('code-limit'),
    signalUrl: `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/signal`,
  })

  const canRun = () => crossOriginIsolated
  let downSince: number | null = Date.now()
  let offlineTimer: ReturnType<typeof setTimeout> | undefined
  let queued = false
  let compiler: CompilerFiles = 'on-run'
  const render = () => {
    if (queued) return
    queued = true
    requestAnimationFrame(() => {
      queued = false
      if (failed) return
      const net = c.net()
      if (net.signaling) downSince = null
      else downSince ??= Date.now()
      const downFor = downSince === null ? 0 : Date.now() - downSince
      // Nothing else re-renders at the 5 s mark: the collab reports a status only when it changes.
      clearTimeout(offlineTimer)
      if (downSince !== null && downFor < OFFLINE_MS) offlineTimer = setTimeout(render, OFFLINE_MS - downFor)
      const run = session?.view() ?? IDLE
      const notice: Notice = !canRun() ? 'no-isolation' : downFor >= OFFLINE_MS ? 'offline' : net.stuck > 0 ? 'stuck' : null
      const state: UiState = { peers: c.peers(), net, run, notice, canRun: canRun() && (run.phase === 'idle' || run.phase === 'done'), compiler }
      ui.render(state)
    })
  }
  c.onChange(render)
  render() // the room shows at once; the terminal waits for its font (up to 2 s)

  // The only Ctrl/Cmd+Enter handler, installed before the editor exists so the key never inserts a blank line. Capture phase: CodeMirror's insertBlankLine and xterm never see the key.
  window.addEventListener('keydown', e => {
    if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
      e.preventDefault()
      e.stopPropagation()
      session?.start()
    }
  }, true)

  const editor = createEditor(ui.editorHost, { text: c.text, awareness: c.awareness })
  const t = term = await createTerminal(ui.terminalHost)
  const cpp = createCpp({
    toolchainBase: new URL('/toolchain/' + __TOOLCHAIN_ID__ + '/', location.href).href,
    compilerUrl: '/compiler.worker.js',
    runnerUrl: '/runner.worker.js',
  })
  const s = session = createSession({ collab: c, cpp, term: t, canRun, source: editor.text })
  s.onChange(render)
  render()

  // The compiler files are downloaded once the page is idle, so the first Run does not wait for them. Not where
  // the browser asks to save data, where Run is off anyway, or where there is no Cache Storage to keep them in:
  // there the first Run downloads them, as it does after a download that failed, which is why a failure says nothing.
  const saveData = (navigator as { connection?: { saveData?: boolean } }).connection?.saveData
  if (canRun() && 'caches' in window && !saveData) {
    const prefetch = () => {
      compiler = 'fetching'
      render()
      void cpp.prefetch().then(ok => {
        compiler = ok ? 'ready' : 'on-run'
        render()
      })
    }
    if ('requestIdleCallback' in window) requestIdleCallback(prefetch, { timeout: 5000 })
    else setTimeout(prefetch, 2000) // Safari
  }

  window.__coop = { screen: () => t.screen(), collab: c }
  editor.focus()
}

boot().catch(e => {
  failed = true
  console.error('c-oop: could not start:', e)
  blocked('failed')
  collab?.doc.destroy() // leaves the room: the collab closes its connections when the document is destroyed
})
