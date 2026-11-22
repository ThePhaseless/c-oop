// Presence data from other peers and from storage is untrusted: names, colours and cursors are validated on read.
// localStorage is touched only inside loadIdentity and saveIdentity, each inside try/catch.
import type { Awareness } from 'y-protocols/awareness'
import type { User } from '../shared/contracts'
import { COLOR_RE, NAME_MAX, PEER_COLORS } from '../shared/limits'
import { ANIMALS, ANON_NAME } from './strings'

const FALLBACK_COLOR = '#0d7da2'
const IDENTITY_KEY = 'c-oop.user'

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)

// Control, format (bidi overrides, zero-width) and line or paragraph separator characters are removed.
const cleanName = (v: unknown) =>
  typeof v === 'string' ? [...v.replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu, '').replace(/\s+/g, ' ').trim()].slice(0, NAME_MAX).join('').trim() : ''

/** Plain text of at most NAME_MAX code points, never empty. Markup is kept as text; callers use textContent. */
export const sanitizeName = (v: unknown): string => cleanName(v) || ANON_NAME

/** Always a fresh `{ name, color }`: no colorLight, which y-codemirror would put into a style attribute. */
export function sanitizeUser(v: unknown): User {
  const u = isObject(v) ? v : {}
  return { name: sanitizeName(u.name), color: typeof u.color === 'string' && COLOR_RE.test(u.color) ? u.color : FALLBACK_COLOR }
}

export type RelPos = { type: null; tname: 'code'; item: { client: number; clock: number } | null; assoc: number }

const isId = (n: unknown): n is number => Number.isSafeInteger(n) && (n as number) >= 0

function sanitizePos(v: unknown): RelPos | null {
  if (!isObject(v) || !('item' in v)) return null
  const item = v.item
  if (item !== null && !(isObject(item) && isId(item.client) && isId(item.clock))) return null
  return { type: null, tname: 'code', item: item && { client: item.client as number, clock: item.clock as number }, assoc: Number.isInteger(v.assoc) ? (v.assoc as number) : 0 }
}

/** A pure shape rebuild that calls nothing from Yjs: a fractional clock passes Yjs and still breaks the editor. */
export function sanitizeCursor(v: unknown): { anchor: RelPos; head: RelPos } | null {
  if (!isObject(v)) return null
  const anchor = sanitizePos(v.anchor), head = sanitizePos(v.head)
  return anchor && head ? { anchor, head } : null
}

/**
 * Sanitises, in place, every awareness state that did not come from this client's own calls, before any
 * listener registered later (the editor) reads it. The own id is covered too: a peer can forge it (y-protocols applies
 * an awareness update for any client id with a higher clock).
 * Changes made locally (origin 'local') are left alone.
 */
export function guardAwareness(awareness: Awareness, self: () => User): void {
  const guard = ({ added, updated }: { added: number[]; updated: number[] }, origin: unknown) => {
    if (origin === 'local') return
    for (const id of [...added, ...updated]) {
      let state: unknown = awareness.states.get(id)
      if (state === undefined) continue
      if (!isObject(state)) awareness.states.set(id, state = {})
      const s = state as Record<string, unknown>
      s.user = id === awareness.clientID ? self() : sanitizeUser(s.user)
      const cursor = sanitizeCursor(s.cursor)
      if (cursor) s.cursor = cursor
      else delete s.cursor
    }
  }
  awareness.on('change', guard)
  awareness.on('update', guard)
}

const pick = <T>(list: readonly T[]): T => list[Math.floor(Math.random() * list.length)]!

/** The stored identity, sanitised; a random name and colour for whatever is missing, invalid or unreadable. */
export function loadIdentity(): User {
  let stored: unknown
  try { stored = JSON.parse(localStorage.getItem(IDENTITY_KEY) ?? 'null') } catch { /* no storage, or not JSON */ }
  const u = isObject(stored) ? stored : {}
  return { name: cleanName(u.name) || pick(ANIMALS), color: typeof u.color === 'string' && COLOR_RE.test(u.color) ? u.color : pick(PEER_COLORS) }
}

export function saveIdentity(u: User): void {
  try { localStorage.setItem(IDENTITY_KEY, JSON.stringify({ name: u.name, color: u.color })) } catch { /* storage is optional */ }
}

/**
 * Counts connected and stuck peers. An unconnected id keeps the time it was first seen while it is away for
 * less than forgetMs, so the reconnect cycles of the stale-connection retry do not reset it.
 */
export function createConnWatch(stuckMs: number, forgetMs: number): (now: number, conns: { id: string; connected: boolean }[]) => { connected: number; stuck: number } {
  const waiting = new Map<string, { since: number; lastSeen: number }>()
  return (now, conns) => {
    let connected = 0
    for (const c of conns) {
      if (c.connected) { connected++; waiting.delete(c.id) }
      else waiting.set(c.id, { since: waiting.get(c.id)?.since ?? now, lastSeen: now })
    }
    let stuck = 0
    for (const [id, w] of waiting) {
      if (now - w.lastSeen >= forgetMs) waiting.delete(id)
      else if (now - w.since >= stuckMs) stuck++
    }
    return { connected, stuck }
  }
}
