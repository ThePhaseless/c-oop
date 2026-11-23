// Completions for the editor: C++ keywords, the names of the standard library a first course uses, a few
// snippets, and every word already in the file (so the room's own classes and variables complete too).
// shortcut: no types or members; real ones would need clangd in the browser, tens of MB more to download.
import { completeAnyWord, completeFromList, ifNotIn, snippetCompletion, type Completion } from '@codemirror/autocomplete'
import { cppLanguage } from '@codemirror/lang-cpp'
import type { Extension } from '@codemirror/state'

const words = (type: string, list: string): Completion[] => list.split(' ').map(label => ({ label, type }))

export const COMPLETIONS: Completion[] = [
  ...words('keyword', 'alignas auto bool break case catch char class const constexpr continue default delete do double else enum explicit false float for friend if inline int long namespace new noexcept nullptr operator override private protected public return short signed sizeof static struct switch template this throw true try typedef typename union unsigned using virtual void while'),
  ...words('namespace', 'std'),
  ...words('class', 'string vector map set unordered_map unordered_set pair array deque list stack queue optional unique_ptr shared_ptr ostream istream stringstream exception runtime_error size_t'),
  ...words('function', 'cin cout cerr endl getline make_unique make_shared move swap sort find min max to_string stoi stod push_back emplace_back pop_back begin end size empty clear insert erase front back what'),
  snippetCompletion('#include <${iostream}>', { label: '#include', type: 'keyword', detail: '<header>' }),
  snippetCompletion('int main() {\n    ${}\n    return 0;\n}', { label: 'main', type: 'function', detail: 'function' }),
  snippetCompletion('for (${int i = 0}; ${i < n}; ${++i}) {\n    ${}\n}', { label: 'for', type: 'keyword', detail: 'loop' }),
  snippetCompletion('for (${const auto& x} : ${items}) {\n    ${}\n}', { label: 'for', type: 'keyword', detail: 'range loop' }),
  snippetCompletion('while (${condition}) {\n    ${}\n}', { label: 'while', type: 'keyword', detail: 'loop' }),
  snippetCompletion('if (${condition}) {\n    ${}\n}', { label: 'if', type: 'keyword', detail: 'block' }),
  snippetCompletion('class ${Name} {\npublic:\n    ${}\n};', { label: 'class', type: 'keyword', detail: 'definition' }),
  snippetCompletion('std::cout << ${} << std::endl;', { label: 'cout', type: 'function', detail: 'print line' }),
]

const LISTED = new Set(COMPLETIONS.map(c => c.label))
const outsideText = (source: Parameters<typeof ifNotIn>[1]) => ifNotIn(['LineComment', 'BlockComment', 'String', 'RawString', 'CharLiteral'], source)

export const cppCompletion: Extension = [
  cppLanguage.data.of({ autocomplete: outsideText(completeFromList(COMPLETIONS)) }),
  // Words of the file, without the ones the list above already offers.
  cppLanguage.data.of({
    autocomplete: outsideText(async ctx => {
      const found = await completeAnyWord(ctx)
      return found && { ...found, options: found.options.filter(o => !LISTED.has(o.label)) }
    }),
  }),
]
