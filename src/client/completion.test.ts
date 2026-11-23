import { CompletionContext, type CompletionResult } from '@codemirror/autocomplete'
import { cpp } from '@codemirror/lang-cpp'
import { EditorState } from '@codemirror/state'
import { expect, test } from 'bun:test'
import { cppCompletion } from './completion'

async function labels(doc: string): Promise<string[]> {
  const state = EditorState.create({ doc, extensions: [cpp(), cppCompletion] })
  const ctx = new CompletionContext(state, doc.length, false)
  const out: string[] = []
  for (const source of state.languageDataAt<(c: CompletionContext) => CompletionResult | null | Promise<CompletionResult | null>>('autocomplete', doc.length)) {
    for (const o of (await source(ctx))?.options ?? []) out.push(o.label)
  }
  return out
}

test('keywords, standard names and words of the file complete in code', async () => {
  const got = await labels('std::vector<int> v;\nint main() { std::vec')
  expect(got.filter(l => l === 'vector')).toEqual(['vector']) // once, though the file's own text holds `vec` words too
  expect(await labels('class Rectangle {};\nRect')).toContain('Rectangle')
  expect(await labels('vir')).toContain('virtual')
})

test('nothing completes inside a comment or a string', async () => {
  expect(await labels('// vir')).toEqual([])
  expect(await labels('auto s = "vec')).toEqual([])
})
