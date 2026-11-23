// Every UI string. Text only: callers add colours and escape codes.
import type { AiView, CompilerFiles, Exit, Notice, RunView } from '../shared/contracts'
import { AI } from '../shared/limits'

export const APP_NAME = 'c-oop'
export const FILE_NAME = 'main.cpp'

const people = (n: number) => (n === 1 ? 'person' : 'people')

export const NET_CONNECTING = 'Connecting'
export const NET_ALONE = 'You are alone here. Send the link to invite others.'
export const NET_RELAYED = 'No direct connection to some people here. Their changes arrive through the server.'
/** `count` includes the local user. `relayed`: the short form of NET_RELAYED, which stays as the tooltip. */
export const netPeers = (count: number, relayed = false) => `In room: ${count} ${people(count)}${relayed ? ' (via the server)' : ''}`

export const SELF_SUFFIX = '(you)'
export const PEERS_LABEL = 'People in the room'
/** Shown for a peer whose name is missing or empty after sanitising. */
export const ANON_NAME = 'Anonymous'
/** The button after the fifth person; pressed, it lists everyone and reads PEERS_LESS. */
export const morePeers = (n: number) => `+${n}`
export const PEERS_LESS = 'less'
/** Tooltip of the own-name button; its accessible name is the name it shows. */
export const NAME_EDIT_HINT = 'Change your name'
export const NAME_INPUT_LABEL = 'Your name'
export const COPY_LINK = 'Copy link'
export const COPY_DONE = 'Copied'
export const THEME_TOGGLE = 'Switch between light and dark theme'
export const NEW_ROOM = 'Create a new room'

/** Returns '' for null. */
export function noticeText(notice: Notice): string {
  switch (notice) {
    case 'insecure': return 'This page works only over HTTPS or on localhost. Open it at an address that starts with https://'
    case 'bad-link': return 'This room link is incomplete or damaged.'
    case 'failed': return 'The page could not start. Reload it. If that does not help, check whether the browser or one of its extensions blocks WebRTC.'
    case 'no-isolation': return 'Running programs is turned off because the server does not send the COOP and COEP headers. Editing works as usual.'
    case 'offline': return 'No connection to the server. You are editing locally; changes will be sent when the connection is back.'
    // The two below are shown for a few seconds after the event (ui.ts), never as a standing state.
    case 'code-limit': return 'main.cpp can have at most a million characters. The text that did not fit was cut off.'
    case 'copy-failed': return 'Could not copy the link. Copy the address from the browser\'s address bar.'
    case null: return ''
  }
}

export const EDITOR_LABEL = 'Code editor, main.cpp'
export const EDITOR_PLACEHOLDER = 'Empty file. If someone has this room open, the code will appear once you connect. You can also start typing.'
/** Shown in the editor's header while focus is inside the pane, and the editor's description for assistive tech. */
export const EDITOR_TAB_HINT = 'Esc, then Tab: leave the editor'

// `??? <prompt>` snippets. The prompt line is gone by the time a request fails, hence AI_UNDO.
const AI_UNDO = ' Undo brings the prompt line back.'
/** Text and accessible name of the `#ai` button; '' while it is hidden. */
export function aiLabel(v: AiView): string {
  if (v.state === 'working') return 'Generating…'
  if (v.state === 'ready') return 'Insert code'
  if (v.state !== 'failed') return ''
  switch (v.why) {
    case 'limit': return 'Too many requests'
    case 'day-limit': return 'Daily limit reached'
    case 'busy': return 'Busy, try again'
    case 'refused': return 'No code for that'
    case 'too-long': return 'Answer too long'
    case 'prompt': return 'Prompt too long'
    case 'failed': return 'Generation failed'
  }
}
/** The sentence for the `#ai` button's tooltip and its live region. */
export function aiStatus(v: AiView): string {
  switch (v.state) {
    case 'off': return ''
    case 'idle': return v.last === 'inserted' ? 'Generated code inserted.' : v.last === 'discarded' ? 'Generated code discarded.' : ''
    case 'working': return 'Generating code for your prompt.' + (v.partial ? ' Only the part of main.cpp around that line was sent.' : '')
    case 'ready':
      if (v.noRoom) return 'The generated code does not fit: main.cpp can have at most a million characters. Delete some text and insert again.'
      return 'Generated code is ready. Press Ctrl twice or use this button to insert it. Esc on this button discards it.'
    case 'failed': break
  }
  switch (v.why) {
    case 'limit': return 'Too many prompts came from your network in the last minutes. Wait a few minutes and try again.' + AI_UNDO
    case 'day-limit': return 'Today\'s limit of generated snippets is used up. It starts over at midnight UTC.' + AI_UNDO
    case 'busy': return 'The code generator is busy or took too long. Try again in a moment.' + AI_UNDO
    case 'refused': return 'No code came back for that prompt. Ask for C++ code for this file.' + AI_UNDO
    case 'too-long': return 'The answer was too long and was not inserted. Ask for a smaller piece of code.' + AI_UNDO
    case 'prompt': return `The prompt is too long. Shorten it to at most ${AI.promptMax} characters and press Enter again.`
    case 'failed': return 'The code could not be generated. Try again.' + AI_UNDO
  }
}

export const TERMINAL_LABEL = 'Program terminal'
export const TERMINAL_TITLE = 'Terminal'
export const TERMINAL_EMPTY_HEADING = 'Program output will appear here'
export const TERMINAL_EMPTY_BODY = 'The Run button or Ctrl+Enter compiles main.cpp in your browser. Everyone in the room sees the output and anyone can type input.'
/** xterm's label of its input field and its screen-reader announcement when output arrives too fast to read out. */
export const TERMINAL_INPUT_LABEL = 'Program input'
export const TERMINAL_TOO_MUCH_OUTPUT = 'Too much output to read out. Use the arrow keys to go to the terminal lines.'
/** The note under the terminal's empty state. */
export function compilerNote(compiler: CompilerFiles): string {
  switch (compiler) {
    case 'on-run': return 'The first run downloads the compiler, about 30 MB.'
    case 'fetching': return 'The compiler is downloading in the background, about 30 MB.'
    case 'ready': return 'The compiler is already downloaded.'
  }
}

export const RUN = 'Run'
export const RUN_HINT = 'Run the program (Ctrl+Enter)'
export const STOP = 'Stop'
export const STATUS_IDLE = 'Ready'
export const PROGRESS_LABEL = 'Downloading compiler'

const UNCAUGHT = 'crash:uncaught C++ exception'
const exitCode = (exit: string) => exit.slice('code:'.length)

/** Text of `#percent` beside the progress bar; `#status` keeps the label alone, so the live region speaks once. */
export const percentText = (v: RunView) => (v.phase === 'loading' && v.mine ? `${Math.round((v.progress ?? 0) * 100)}%` : '')

/** Text of `#status` for a run view. */
export function statusText(v: RunView): string {
  switch (v.phase) {
    case 'idle': return STATUS_IDLE
    case 'loading': return v.mine ? PROGRESS_LABEL : `${v.runnerName} is downloading the compiler`
    case 'compiling': return v.mine ? 'Compiling…' : `${v.runnerName} is compiling`
    case 'running': return v.mine ? (v.stdinWaiting ? 'Program is waiting for input' : 'Program is running') : `${v.runnerName} is running the program`
    case 'done': break
  }
  const exit = v.exit
  if (exit === null) return STATUS_IDLE
  if (exit === 'compile-error') return 'Compile error'
  if (exit === 'killed') return 'Stopped'
  if (exit === 'output-limit') return 'Stopped: output limit'
  if (exit === 'runner-left') return 'Aborted: the person running it left'
  if (exit === 'load-error') return 'Compiler stopped working'
  if (exit.startsWith('code:')) return `Finished, exit code ${exitCode(exit)}`
  return 'Program aborted' // crash:* and no-wasm-eh
}

/** First terminal line of a run. */
export const runHeaderLine = (runnerName: string) => `[${runnerName} is running main.cpp]`

/** Last terminal line of a run. */
export function exitLine(exit: Exit | 'runner-left'): string {
  if (exit === 'compile-error') return '[compile error]'
  if (exit === 'killed') return '[stopped]'
  if (exit === 'output-limit') return '[output limit 256 kB, program stopped]'
  if (exit === 'runner-left') return '[the person running it left the room]'
  if (exit === 'load-error') return '[compiler stopped working: download error or out of memory, run again]'
  if (exit === 'no-wasm-eh') return '[this browser does not support WebAssembly exceptions: Chrome 137, Firefox 131 or Safari 18.4 needed]'
  if (exit === UNCAUGHT) return '[uncaught C++ exception]'
  if (exit.startsWith('code:')) return `[program exited with code ${exitCode(exit)}]`
  return `[program aborted: ${exit.slice('crash:'.length)}]`
}

// Random identities: 16 animals, each well under NAME_MAX.
export const ANIMALS = ['Lynx', 'Bison', 'Beaver', 'Owl', 'Fox', 'Wolf', 'Hedgehog', 'Stork', 'Deer', 'Otter', 'Badger', 'Marten', 'Moose', 'Hare', 'Heron', 'Boar'] as const

// Starter main.cpp for a new room (at most 40 lines).
export const TEMPLATE = `#include <iostream>
#include <memory>
#include <string>
#include <vector>

// Abstract class: every shape can give its name and area.
class Shape {
public:
    virtual ~Shape() = default;
    virtual std::string name() const = 0;
    virtual double area() const = 0;
};

class Rectangle : public Shape {
    double a, b;
public:
    Rectangle(double a, double b) : a(a), b(b) {}
    std::string name() const override { return "Rectangle"; }
    double area() const override { return a * b; }
};

class Circle : public Shape {
    double r;
public:
    explicit Circle(double r) : r(r) {}
    std::string name() const override { return "Circle"; }
    double area() const override { return 3.14159265 * r * r; }
};

int main() {
    std::cout << "What is your name? ";
    std::string name;
    std::getline(std::cin, name);
    std::vector<std::unique_ptr<Shape>> shapes;
    shapes.push_back(std::make_unique<Rectangle>(3, 4));
    shapes.push_back(std::make_unique<Circle>(1));
    std::cout << "Hello, " << name << "! Here are the shapes:\\n";
    for (const auto& s : shapes)
        std::cout << "  " << s->name() << " has area " << s->area() << "\\n";
}
`
