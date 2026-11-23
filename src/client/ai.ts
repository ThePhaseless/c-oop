// `??? <prompt>` AI snippets: the parts with no editor and no DOM in them.
import type * as Y from 'yjs'
import type { AiReply, AiRequest, AiView } from '../shared/contracts'
import { AI } from '../shared/limits'

export const TRIGGER_LINE = /^[ \t]*\?\?\?/

export function parseTrigger(line: string): { indent: string; prompt: string } | null {
  const m = /^([ \t]*)\?\?\? +(.*\S)\s*$/.exec(line)
  return m ? { indent: m[1]!, prompt: m[2]! } : null
}

// `from` and `to` are the trigger line's bounds without its line break. `del` takes the line break along.
export function aiWindow(doc: string, from: number, to: number): { before: string; after: string; cut: [boolean, boolean]; del: { from: number; to: number } } {
  const del = { from, to: Math.min(to + 1, doc.length) }
  return {
    before: doc.slice(Math.max(0, from - AI.beforeMax), from),
    after: doc.slice(del.to, del.to + AI.afterMax),
    cut: [from > AI.beforeMax, doc.length - del.to > AI.afterMax],
    del,
  }
}

export function indentCode(code: string, indent: string): string {
  return code.split('\n').map(line => (line ? indent + line : line)).join('\n')
}

// Two clean taps of Control: each pressed and released within `windowMs` with nothing between, the second released
// within `windowMs` of the first. Feed it every keydown, keyup, pointerdown and blur; true means the second tap ended.
export function doubleControl(windowMs: number): (e: { type: string; key?: string; repeat?: boolean }, now: number) => boolean {
  let downAt: number | null = null // a clean Control press in progress
  let last: number | null = null   // keyup time of the previous clean tap
  return (e, now) => {
    if (e.type === 'keydown' && e.key === 'Control') {
      if (!e.repeat) downAt = now
    } else if (e.type === 'keydown' || e.type === 'pointerdown' || e.type === 'blur') {
      downAt = last = null
    } else if (e.type === 'keyup' && e.key === 'Control') {
      if (downAt === null || now - downAt > windowMs) downAt = last = null
      else if (last !== null && now - last <= windowMs) {
        downAt = last = null
        return true
      } else {
        last = now
        downAt = null
      }
    }
    return false
  }
}

// `at` is where the deleted prompt line stood; `indent` is that line's indentation, given to every line of the answer.
export type AiJob = { request: AiRequest; indent: string; at: Y.RelativePosition }

// One request at a time: idle -> working -> ready -> idle, with failed as a side state that clears itself.
export function createAi(o: { post(r: AiRequest): Promise<AiReply>; insert(at: Y.RelativePosition, code: string): boolean; onChange(): void }): {
  view(): AiView
  accepts(prompt: string): boolean // false: the line stays
  submit(job: AiJob): void
  insert(): void                   // the double Control: acts only when ready
  press(): void                    // the button: ready inserts, failed dismisses, working does nothing
  escape(): boolean                // true when it discarded a ready result
} {
  let view: AiView = { state: 'idle' }
  let result: { at: Y.RelativePosition; code: string } | undefined
  let timer: ReturnType<typeof setTimeout> | undefined
  // Every change goes through here, so the timer of an old failure never fires into a later request.
  function go(next: AiView) {
    clearTimeout(timer)
    timer = next.state === 'failed' ? setTimeout(() => go({ state: 'idle' }), AI.failedMs) : undefined
    view = next
    o.onChange()
  }
  function insert() {
    if (view.state !== 'ready' || !result) return
    if (!o.insert(result.at, result.code)) return go({ state: 'ready', nudge: view.nudge + 1, noRoom: true }) // kept: it can go in once there is room
    result = undefined
    go({ state: 'idle', last: 'inserted' })
  }
  return {
    view: () => view,
    accepts(prompt) {
      if (view.state === 'working' || view.state === 'ready') return go({ ...view, nudge: view.nudge + 1 }), false
      if (prompt.length > AI.promptMax) return go({ state: 'failed', why: 'prompt' }), false
      return true
    },
    submit(job) {
      go({ state: 'working', partial: job.request.cut[0] || job.request.cut[1], nudge: 0 })
      o.post(job.request).then(reply => {
        if ('error' in reply) return go({ state: 'failed', why: reply.error })
        result = { at: job.at, code: indentCode(reply.code, job.indent) }
        go({ state: 'ready', nudge: 0 })
      }, () => go({ state: 'failed', why: 'failed' }))
    },
    insert,
    press() {
      if (view.state === 'failed') go({ state: 'idle' })
      else insert()
    },
    escape() {
      if (view.state !== 'ready') return false
      result = undefined
      go({ state: 'idle', last: 'discarded' })
      return true
    },
  }
}
