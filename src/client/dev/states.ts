// States page (dev only, not part of the build): every state the interface can be in,
// rendered by the real mountUi and createEditor with fake data. The state and the theme come from
// the URL (?s=<state>&theme=light|dark), so a screenshot of any state is one address.
import { FitAddon } from '@xterm/addon-fit'
import { Terminal } from '@xterm/xterm'
import { applyAwarenessUpdate, Awareness, encodeAwarenessUpdate } from 'y-protocols/awareness'
import * as Y from 'yjs'
import type { CompilerFiles, Exit, Notice, Peer, RunView, UiState } from '../../shared/contracts'
import { PEER_COLORS } from '../../shared/limits'
import { createEditor } from '../editor'
import indexHtml from '../index.html' with { type: 'text' }
import { exitLine, runHeaderLine, TEMPLATE, TERMINAL_INPUT_LABEL, TERMINAL_TOO_MUCH_OUTPUT } from '../strings'
import { mountUi } from '../ui'

type State = {
  peers?: number
  signaling?: boolean
  stuck?: number
  notice?: Notice
  canRun?: boolean
  compiler?: CompilerFiles
  run?: Partial<RunView>
  out?: string // program output shown between the header line and the exit line
  emptyDoc?: boolean
  act?: 'copy' | 'copy-fail' | 'name' | 'code-limit' | 'more'
}

const PROMPT = 'What is your name? '
const OUTPUT = `${PROMPT}Ala\r\nHello, Ala! Here are the shapes:\r\n  Rectangle has area 12\r\n  Circle has area 3.14159\r\n`
const DIAGNOSTICS = '\x1b[1mmain.cpp:31:5: \x1b[0m\x1b[1;31merror: \x1b[0m\x1b[1muse of undeclared identifier \'shapess\'\x1b[0m\r\n   31 |     shapess.push_back(std::make_unique<Circle>(1));\r\n      | \x1b[1;32m    ^~~~~~~\x1b[0m\r\n'
  + '\x1b[1mmain.cpp:28:9: \x1b[0m\x1b[1;35mwarning: \x1b[0m\x1b[1munused variable \'x\' [-Wunused-variable]\x1b[0m\r\n1 warning and 1 error generated.\r\n'
const mine = (run: Partial<RunView>): Partial<RunView> => ({ runnerName: 'Ala', mine: true, ...run })
const theirs = (run: Partial<RunView>): Partial<RunView> => ({ runnerName: 'Bartek', mine: false, ...run })
const done = (exit: Exit | 'runner-left', out = OUTPUT): State => ({ peers: 3, run: mine({ phase: 'done', exit }), out })

const STATES: Record<string, State> = {
  'boot': { peers: 1, signaling: false },
  'alone': { peers: 1 },
  'peers-3': { peers: 3 },
  'peers-4': { peers: 4 },
  'peers-5': { peers: 5 },
  'peers-9': { peers: 9 },
  'offline': { peers: 1, signaling: false, notice: 'offline' },
  'relayed': { peers: 3, stuck: 1 },
  'insecure': { peers: 0, signaling: false, notice: 'insecure', canRun: false },
  'failed': { peers: 0, signaling: false, notice: 'failed', canRun: false },
  'no-isolation': { peers: 3, notice: 'no-isolation', canRun: false },
  'bad-link': { peers: 0, signaling: false, notice: 'bad-link', canRun: false, emptyDoc: true },
  'empty-document': { peers: 1, emptyDoc: true },
  'compiler-fetching': { peers: 1, compiler: 'fetching' },
  'compiler-ready': { peers: 1, compiler: 'ready' },
  'loading-mine': { peers: 3, run: mine({ phase: 'loading', progress: 0.43 }) },
  'loading-theirs': { peers: 3, run: theirs({ phase: 'loading' }) },
  'compiling-mine': { peers: 3, run: mine({ phase: 'compiling' }) },
  'compiling-theirs': { peers: 3, run: theirs({ phase: 'compiling' }) },
  'running-mine': { peers: 3, run: mine({ phase: 'running' }), out: OUTPUT },
  'running-waiting': { peers: 3, run: mine({ phase: 'running', stdinWaiting: true }), out: PROMPT },
  'running-theirs': { peers: 3, run: theirs({ phase: 'running' }), out: PROMPT },
  'done-code-0': done('code:0'),
  'done-code-1': done('code:1'),
  'done-compile-error': done('compile-error', DIAGNOSTICS),
  'done-killed': done('killed', PROMPT + '\r\n'),
  'done-output-limit': done('output-limit', 'a\r\n'.repeat(40)),
  'done-crash': done('crash:uncaught C++ exception'),
  'done-no-wasm-eh': done('no-wasm-eh', ''),
  'done-runner-left': { peers: 2, run: theirs({ phase: 'done', exit: 'runner-left' }), out: PROMPT + '\r\n' },
  'done-load-error': done('load-error', ''),
  'copy-done': { peers: 3, act: 'copy' },
  'copy-failed': { peers: 3, act: 'copy-fail' },
  'name-edit': { peers: 3, act: 'name' },
  'code-limit': { peers: 3, act: 'code-limit' },
  'peers-9-open': { peers: 9, act: 'more' },
}

const params = new URLSearchParams(location.search)
const stateName = params.get('s') ?? ''
const state = STATES[stateName] ?? STATES['peers-3']!
const go = (key: string, value: string) => { params.set(key, value); location.search = params.toString() }

// One copy of the markup: the body of index.html, parsed (no HTML sink) and moved into this page.
const parsed = new DOMParser().parseFromString(indexHtml as unknown as string, 'text/html')
document.body.replaceChildren(...parsed.body.childNodes)

const NAMES = ['Ala', 'Bartek', 'Celina', 'Dobromiła', 'Eryk', 'Żaneta', 'Grzegorz', 'Hania', 'Bożydar Szczęsny-Kowal']
const peers: Peer[] = NAMES.slice(0, state.peers ?? 3).map((name, i) => ({ clientId: i + 1, user: { name, color: PEER_COLORS[i]! }, self: i === 0 }))
const run: RunView = { phase: 'idle', runnerName: '', mine: false, exit: null, progress: null, stdinWaiting: false, ...state.run }
const uiState: UiState = {
  peers,
  net: { signaling: state.signaling ?? true, connected: peers.length - 1, stuck: state.stuck ?? 0 },
  run,
  notice: state.notice ?? null,
  canRun: state.canRun ?? true,
  compiler: state.compiler ?? 'on-run',
}

const ui = mountUi({
  run: () => console.log('run'),
  stop: () => console.log('stop'),
  rename: name => { if (peers[0]) peers[0].user.name = name; ui.render(uiState) },
  newRoom: () => console.log('newRoom'),
  themeChanged: () => { term.options.theme = termTheme() },
})
// The URL wins over the stored theme, so a screenshot does not depend on earlier visits.
const themeParam = params.get('theme')
if (themeParam === 'light' || themeParam === 'dark') document.documentElement.dataset.theme = themeParam

// Editor: the template with two remote carets, each from its own document and awareness.
const doc = new Y.Doc()
const text = doc.getText('code')
if (!state.emptyDoc) text.insert(0, TEMPLATE)
const awareness = new Awareness(doc)
if (peers[0]) awareness.setLocalStateField('user', peers[0].user)
peers.slice(1, 3).forEach((peer, i) => {
  if (state.emptyDoc) return
  const remote = new Y.Doc()
  Y.applyUpdate(remote, Y.encodeStateAsUpdate(doc))
  const remoteAwareness = new Awareness(remote)
  const at = (needle: string) => Y.createRelativePositionFromTypeIndex(remote.getText('code'), TEMPLATE.indexOf(needle))
  const [anchor, head] = i === 0 ? ['    double a, b;', '\npublic:\n    Rectangle'] : ['"Circle"', '"Circle"']
  // the renewals every 15 s are forwarded too, so the carets do not time out after 30 s
  remoteAwareness.on('update', () => applyAwarenessUpdate(awareness, encodeAwarenessUpdate(remoteAwareness, [remote.clientID]), 'remote'))
  remoteAwareness.setLocalState({ user: peer.user, cursor: { anchor: at(anchor!), head: at(head!) } })
})
createEditor(ui.editorHost, { text, awareness })

// Terminal: a local xterm with the same token mapping as the app's terminal.ts, which is not
// used here; this page only shows that the tokens and the font work in xterm.
const token = (name: string) => getComputedStyle(document.documentElement).getPropertyValue(name).trim()
function termTheme() {
  const c = { black: token('--ink-2'), red: token('--margin'), green: token('--ok'), yellow: token('--warn'), blue: token('--syn-kw'), magenta: token('--warn'), cyan: token('--syn-type'), white: token('--ink') }
  return {
    background: token('--paper'), foreground: token('--ink'), cursor: token('--ink'), selectionBackground: token('--select'), ...c,
    brightBlack: c.black, brightRed: c.red, brightGreen: c.green, brightYellow: c.yellow, brightBlue: c.blue, brightMagenta: c.magenta, brightCyan: c.cyan, brightWhite: c.white,
  }
}
await Promise.race([document.fonts.load('15px "Recursive Code"'), new Promise(r => setTimeout(r, 2000))])
Terminal.strings.promptLabel = TERMINAL_INPUT_LABEL
Terminal.strings.tooMuchOutput = TERMINAL_TOO_MUCH_OUTPUT
const term = new Terminal({
  convertEol: true,
  screenReaderMode: true,
  cursorBlink: !matchMedia('(prefers-reduced-motion: reduce)').matches,
  fontFamily: token('--font-code'),
  fontSize: 15,
  lineHeight: 1.3,
  theme: termTheme(),
})
const fit = new FitAddon()
term.loadAddon(fit)
term.open(ui.terminalHost)
fit.fit()
new ResizeObserver(() => fit.fit()).observe(ui.terminalHost)
const grey = (line: string) => `\x1b[0;90m${line}\x1b[0m\r\n`
if (run.phase !== 'idle') {
  let screen = grey(runHeaderLine(run.runnerName)) + (state.out ?? '')
  if (run.phase === 'done' && run.exit) screen += grey(exitLine(run.exit))
  term.write(screen)
}

ui.render(uiState)

if (state.act === 'copy' || state.act === 'copy-fail') {
  const ok = state.act === 'copy'
  Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: () => (ok ? Promise.resolve() : Promise.reject(new Error('blocked'))) } })
  document.getElementById('copy')!.click()
}
if (state.act === 'name') document.getElementById('name')!.click()
if (state.act === 'code-limit') ui.flash('code-limit')
if (state.act === 'more') document.getElementById('more')!.click()

// State picker, in the corner so that the page under it keeps its real layout.
const picker = document.createElement('select')
picker.setAttribute('aria-label', 'Interface state')
picker.style.cssText = 'position:fixed;right:0.5rem;bottom:0.5rem;z-index:1000;max-width:12rem;font:inherit'
for (const name of Object.keys(STATES)) picker.append(new Option(name, name, false, name === stateName || (!STATES[stateName] && name === 'peers-3')))
picker.onchange = () => go('s', picker.value)
document.body.append(picker)
// Test hook for the screenshot script.
Object.assign(window, { __states: Object.keys(STATES) })
