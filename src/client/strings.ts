// Every UI string. Text only: callers add colours and escape codes.
import type { CompilerFiles, Exit, Notice, RunView } from '../shared/contracts'

export const APP_NAME = 'c-oop'
export const FILE_NAME = 'main.cpp'

const people = (n: number) => (n === 1 ? 'person' : 'people')

export const NET_CONNECTING = 'Connecting'
export const NET_ALONE = 'You are alone here. Send the link to invite others.'
/** `count` includes the local user. */
export const netPeers = (count: number) => `In room: ${count} ${people(count)}`

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

/** `stuck` is used only by the 'stuck' notice. Returns '' for null. */
export function noticeText(notice: Notice, stuck = 1): string {
  switch (notice) {
    case 'insecure': return 'This page works only over HTTPS or on localhost. Open it at an address that starts with https://'
    case 'bad-link': return 'This room link is incomplete or damaged.'
    case 'failed': return 'The page could not start. Reload it. If that does not help, check whether the browser or one of its extensions blocks WebRTC.'
    case 'no-isolation': return 'Running programs is turned off because the server does not send the COOP and COEP headers. Editing works as usual.'
    case 'offline': return 'No connection to the server. You are editing locally; changes will be sent when the connection is back.'
    case 'stuck': return `Could not connect to ${stuck} ${people(stuck)} in this room. The usual cause is the network, for example a school or company one. The site administrator can add a TURN server.`
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
