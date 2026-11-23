// The page shell: fills the static markup of index.html (its ids are the contract with main.ts and the e2e suite) from a UiState.
// Peer names, statuses and notices are untrusted or translated text: textContent only, no HTML sink.
import type { Notice, Peer, Ui, UiHandlers, UiState } from '../shared/contracts'
import { COLOR_RE, NAME_MAX } from '../shared/limits'
import * as S from './strings'

const THEME_KEY = 'c-oop.theme' // theme.js reads it before the first paint
const MAX_PEERS = 5 // shown by name, self included; the rest sit behind the "+N" button
const FLASH_MS = 8000 // long enough to read a two-sentence notice
const SWAP_GUARD_MS = 400 // about a double-click: a pointer click this soon after Run and Stop traded places under it was meant for the other
const FALLBACK_COLOR = '#0d7da2'

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T
const set = (el: Element, text: string) => { if (el.textContent !== text) el.textContent = text }
const el = (tag: string, className: string, text = '') => {
  const e = document.createElement(tag)
  e.className = className
  e.textContent = text
  return e
}
const color = (c: string) => (COLOR_RE.test(c) ? c : FALLBACK_COLOR)

export function mountUi(h: UiHandlers): Ui {
  const root = document.documentElement
  const peers = $('peers'), nameBtn = $<HTMLButtonElement>('name'), nameInput = $<HTMLInputElement>('name-input')
  const me = nameBtn.parentElement!, meDot = me.querySelector<HTMLElement>('.dot')!
  const net = $('net'), copy = $<HTMLButtonElement>('copy'), theme = $<HTMLButtonElement>('theme')
  const notice = $('notice'), noticeText = $('notice-text'), newRoom = $<HTMLButtonElement>('new-room')
  const main = document.querySelector('main')!
  const run = $<HTMLButtonElement>('run'), stop = $<HTMLButtonElement>('stop')
  const status = $('status'), percent = $('percent'), progress = $<HTMLProgressElement>('progress')
  const terminal = $('terminal'), terminalEmpty = $('terminal-empty')
  const ai = $<HTMLButtonElement>('ai'), aiLabel = $('ai-label'), aiLive = $('ai-live')

  // Static copy: strings.ts is the source, index.html only shows it before this runs.
  set(document.querySelector('.wordmark')!, S.APP_NAME)
  peers.setAttribute('aria-label', S.PEERS_LABEL)
  nameBtn.title = S.NAME_EDIT_HINT // no aria-label: the accessible name is the name the button shows
  nameInput.setAttribute('aria-label', S.NAME_INPUT_LABEL)
  nameInput.maxLength = NAME_MAX
  set(me.querySelector('.you')!, S.SELF_SUFFIX)
  set(copy, S.COPY_LINK)
  theme.setAttribute('aria-label', S.THEME_TOGGLE)
  theme.title = S.THEME_TOGGLE
  set(newRoom, S.NEW_ROOM)
  const [editorPane, terminalPane] = document.querySelectorAll('main > section')
  editorPane!.setAttribute('aria-label', S.EDITOR_LABEL)
  terminalPane!.setAttribute('aria-label', S.TERMINAL_LABEL)
  set(editorPane!.querySelector('h2')!, S.FILE_NAME)
  set(terminalPane!.querySelector('h2')!, S.TERMINAL_TITLE)
  set($('editor-hint'), S.EDITOR_TAB_HINT)
  set(run, S.RUN)
  run.title = S.RUN_HINT
  set(stop, S.STOP)
  progress.setAttribute('aria-label', S.PROGRESS_LABEL)
  const [emptyHeading, emptyBody, emptyNote] = terminalEmpty.children
  set(emptyHeading!, S.TERMINAL_EMPTY_HEADING)
  set(emptyBody!, S.TERMINAL_EMPTY_BODY)

  // Theme: the system's until the button is pressed, then the stored choice (theme.js applies it on load). Storage may be blocked.
  const systemDark = matchMedia('(prefers-color-scheme: dark)')
  theme.onclick = () => {
    const next = (root.dataset.theme ?? (systemDark.matches ? 'dark' : 'light')) === 'dark' ? 'light' : 'dark'
    root.dataset.theme = next
    try { localStorage.setItem(THEME_KEY, next) } catch {}
    h.themeChanged()
  }
  systemDark.addEventListener('change', () => h.themeChanged())

  // A notice about something that just happened. For FLASH_MS it stands in for a standing notice, never for a blocking one.
  let last: UiState | undefined
  let flashed: Notice = null, flashTimer: ReturnType<typeof setTimeout> | undefined
  function flash(kind: Notice) {
    flashed = kind
    clearTimeout(flashTimer)
    flashTimer = kind === null ? undefined : setTimeout(() => flash(null), FLASH_MS)
    if (last) render(last)
  }

  let copyTimer: ReturnType<typeof setTimeout> | undefined
  copy.onclick = async () => {
    // The button keeps its label on failure: the instruction is a sentence and belongs in the notice bar.
    try { await navigator.clipboard.writeText(location.href) } catch { return flash('copy-failed') }
    set(copy, S.COPY_DONE)
    clearTimeout(copyTimer)
    copyTimer = setTimeout(() => set(copy, S.COPY_LINK), 2000)
  }

  // Name edit: Enter or leaving the field saves, Esc cancels, empty input keeps the old name.
  let selfName = '', editing = false
  const endEdit = (save: boolean) => {
    if (!editing) return
    editing = false
    const name = nameInput.value.trim()
    const refocus = document.activeElement === nameInput
    nameInput.hidden = true
    nameBtn.hidden = false
    if (refocus) nameBtn.focus()
    if (save && name && name !== selfName) {
      set(nameBtn, selfName = name)
      h.rename(name)
    }
  }
  nameBtn.onclick = () => {
    editing = true
    nameInput.value = selfName
    nameBtn.hidden = true
    nameInput.hidden = false
    nameInput.focus()
    nameInput.select()
  }
  nameInput.onkeydown = e => {
    if (e.isComposing) return
    if (e.key === 'Enter') { e.preventDefault(); endEdit(true) }
    if (e.key === 'Escape') endEdit(false)
  }
  nameInput.onblur = () => endEdit(true)

  // Run and Stop share one place, so a click can land on the one that has just appeared under the pointer: the second
  // click of a double-click, or a click on Stop that was on its way when the program ended, which would start it again.
  // A keyboard press has detail 0 and always counts. A touch leaves no pointer resting on the button, so the last
  // press on either one counts as a pointer there for as long as the guard lasts.
  let swappedUnderPointer = -Infinity, pressed = -Infinity
  run.onpointerdown = run.onpointerup = stop.onpointerdown = stop.onpointerup = () => { pressed = performance.now() }
  const meant = (e: MouseEvent) => e.detail === 0 || performance.now() - swappedUnderPointer >= SWAP_GUARD_MS
  run.onclick = e => { if (meant(e)) h.run() }
  stop.onclick = e => { if (meant(e)) h.stop() }
  stop.onpointerleave = () => stop.classList.remove('fresh')
  newRoom.onclick = () => h.newRoom()
  ai.onclick = () => h.ai()
  ai.onkeydown = e => { if (e.key === 'Escape') h.aiEscape() }

  // The "+N" button stays in the list as its last item, so it keeps keyboard focus when it opens the rest.
  const moreItem = el('li', 'more'), more = el('button', '') as HTMLButtonElement
  more.id = 'more'
  more.type = 'button'
  moreItem.append(more)
  moreItem.hidden = true // until the first render knows whether anyone is behind it
  peers.append(moreItem)
  let othersKey = '', expanded = false
  more.onclick = () => {
    expanded = !expanded
    if (last) renderPeers(last.peers)
  }
  function renderPeers(list: Peer[]) {
    const self = list.find(p => p.self)
    me.hidden = !self // no room yet (insecure page, bad link): no name to show or edit
    if (self) {
      me.dataset.clientId = String(self.clientId)
      meDot.style.backgroundColor = color(self.user.color)
      if (!editing) set(nameBtn, selfName = self.user.name)
    }
    const others = list.filter(p => !p.self)
    const key = JSON.stringify([expanded, ...others.map(p => [p.clientId, p.user.name, p.user.color])])
    if (key === othersKey) return
    othersKey = key
    while (me.nextSibling !== moreItem) me.nextSibling!.remove()
    const rest = others.slice(MAX_PEERS - 1)
    for (const p of expanded ? others : others.slice(0, MAX_PEERS - 1)) {
      const li = el('li', 'peer')
      li.dataset.clientId = String(p.clientId)
      const dot = el('span', 'dot')
      dot.setAttribute('aria-hidden', 'true')
      dot.style.backgroundColor = color(p.user.color)
      li.append(dot, el('span', '', p.user.name))
      moreItem.before(li)
    }
    moreItem.hidden = !rest.length
    if (!rest.length) return void (expanded = false)
    const names = rest.map(p => p.user.name).join(', ')
    set(more, expanded ? S.PEERS_LESS : S.morePeers(rest.length))
    more.setAttribute('aria-expanded', String(expanded))
    more.title = expanded ? '' : names
    if (expanded) more.removeAttribute('aria-label')
    else more.setAttribute('aria-label', `${S.morePeers(rest.length)}: ${names}`)
  }

  let noticeWanted = ''
  let aiSaid = '', aiWanted = ''
  function render(s: UiState) {
    last = s
    const { phase } = s.run
    const blocking = s.notice === 'insecure' || s.notice === 'bad-link' || s.notice === 'failed'
    const busy = phase === 'loading' || phase === 'compiling' || phase === 'running'

    document.body.dataset.phase = phase
    document.body.dataset.exit = phase === 'done' ? s.run.exit ?? '' : ''
    terminal.dataset.stdin = phase === 'running' && s.run.stdinWaiting ? 'waiting' : 'idle'

    renderPeers(s.peers)
    net.hidden = blocking
    copy.hidden = blocking // no room to invite anyone to
    set(net, s.peers.length > 1 ? S.netPeers(s.peers.length) : s.net.signaling ? S.NET_ALONE : S.NET_CONNECTING)

    const shown = blocking ? s.notice : flashed ?? s.notice
    noticeWanted = S.noticeText(shown, s.net.stuck)
    notice.setAttribute('role', blocking ? 'alert' : 'status')
    notice.dataset.kind = shown ?? ''
    notice.hidden = shown === null
    // A status region speaks text that changes while it is on the page, so its text follows one frame after the bar.
    if (blocking || !noticeWanted) set(noticeText, noticeWanted)
    else if (noticeText.textContent !== noticeWanted) requestAnimationFrame(() => set(noticeText, noticeWanted))
    newRoom.hidden = s.notice !== 'bad-link'
    main.inert = blocking

    // Run and Stop share one place: keep keyboard focus there when they swap.
    const swap = run.hidden !== busy
    const hadFocus = swap && document.activeElement === (busy ? run : stop)
    run.disabled = !s.canRun || blocking // before the swap: a disabled button cannot take the focus
    if (swap) {
      const underPointer = (busy ? run : stop).matches(':hover')
      if (underPointer || performance.now() - pressed < SWAP_GUARD_MS) swappedUnderPointer = performance.now()
      // A pointer resting on Run is now on Stop: no hover fill until it has left once.
      stop.classList.toggle('fresh', busy && underPointer)
      run.hidden = busy
      stop.hidden = !busy
      if (hadFocus) (busy ? stop : run).focus()
    }
    set(status, S.statusText(s.run))
    set(percent, S.percentText(s.run))
    percent.hidden = !percent.textContent
    progress.hidden = !(phase === 'loading' && s.run.mine)
    progress.value = s.run.progress ?? 0
    const idle = phase === 'idle'
    terminalEmpty.hidden = !idle || blocking
    terminal.inert = idle // under the empty state: no tab stop, no rows of nothing for a screen reader
    set(emptyNote!, S.compilerNote(s.compiler))

    // The snippet button shows a request that is working, ready or failed. While working it is aria-disabled and
    // not disabled, so it keeps the focus it has.
    const aiShown = s.ai.state !== 'off' && s.ai.state !== 'idle'
    const aiFocused = document.activeElement === ai
    ai.hidden = !aiShown
    if (aiShown) {
      ai.dataset.state = s.ai.state
      set(aiLabel, S.aiLabel(s.ai))
      ai.title = S.aiStatus(s.ai)
      if (s.ai.state === 'working') ai.setAttribute('aria-disabled', 'true')
      else ai.removeAttribute('aria-disabled')
    } else if (aiFocused) $('editor').querySelector<HTMLElement>('.cm-content')?.focus()
    // Spoken when the state changes, and again when another prompt was turned away (nudge): emptied first, so the
    // same sentence counts as a change, and set one frame later, like the notice above.
    const aiKey = JSON.stringify(s.ai)
    if (aiKey !== aiSaid) {
      aiSaid = aiKey
      aiWanted = S.aiStatus(s.ai)
      set(aiLive, '')
      requestAnimationFrame(() => set(aiLive, aiWanted))
    }
  }

  return { editorHost: $('editor'), terminalHost: terminal, render, flash }
}
