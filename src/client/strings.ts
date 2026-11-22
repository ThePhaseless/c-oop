// Every Polish UI string. Text only: callers add colours and escape codes.
import type { CompilerFiles, Exit, Notice, RunView } from '../shared/contracts'

export const APP_NAME = 'c-oop'
export const FILE_NAME = 'main.cpp'

// Polish plural: 1 osoba, 2-4 osoby (but 12-14 osób), otherwise osób.
export function plural(n: number, one: string, few: string, many: string): string {
  if (n === 1) return one
  const d = n % 10, h = n % 100
  return d >= 2 && d <= 4 && !(h >= 12 && h <= 14) ? few : many
}

export const NET_CONNECTING = 'Łączenie'
export const NET_ALONE = 'Jesteś tu sam(a). Wyślij link, żeby zaprosić innych.'
/** `count` includes the local user. */
export const netPeers = (count: number) => `W pokoju: ${count} ${plural(count, 'osoba', 'osoby', 'osób')}`

export const SELF_SUFFIX = '(ty)'
export const PEERS_LABEL = 'Osoby w pokoju'
/** Shown for a peer whose name is missing or empty after sanitising. */
export const ANON_NAME = 'Anonim'
/** The button after the fifth person; pressed, it lists everyone and reads PEERS_LESS. */
export const morePeers = (n: number) => `+${n}`
export const PEERS_LESS = 'mniej'
/** Tooltip of the own-name button; its accessible name is the name it shows. */
export const NAME_EDIT_HINT = 'Zmień swoje imię'
export const NAME_INPUT_LABEL = 'Twoje imię'
export const COPY_LINK = 'Kopiuj link'
export const COPY_DONE = 'Skopiowano'
export const THEME_TOGGLE = 'Przełącz motyw jasny i ciemny'
export const NEW_ROOM = 'Utwórz nowy pokój'

/** `stuck` is used only by the 'stuck' notice. Returns '' for null. */
export function noticeText(notice: Notice, stuck = 1): string {
  switch (notice) {
    case 'insecure': return 'Ta strona działa tylko przez HTTPS albo na localhost. Otwórz ją pod adresem zaczynającym się od https://'
    case 'bad-link': return 'Ten link do pokoju jest niepełny albo uszkodzony.'
    case 'failed': return 'Nie udało się uruchomić strony. Odśwież ją. Jeśli to nie pomoże, sprawdź, czy przeglądarka albo jej rozszerzenie nie blokuje WebRTC.'
    case 'no-isolation': return 'Uruchamianie programów jest wyłączone, bo serwer nie wysyła nagłówków COOP i COEP. Edycja działa normalnie.'
    case 'offline': return 'Brak połączenia z serwerem. Edytujesz lokalnie, zmiany wyślą się po powrocie połączenia.'
    case 'stuck': return `Nie udało się połączyć z ${stuck} ${stuck === 1 ? 'osobą' : 'osobami'} w tym pokoju. Zwykle przyczyną jest sieć, na przykład szkolna lub firmowa. Administrator strony może dodać serwer TURN.`
    // The two below are shown for a few seconds after the event (ui.ts), never as a standing state.
    case 'code-limit': return 'Plik main.cpp może mieć najwyżej milion znaków. Tekst, który się nie zmieścił, został odcięty.'
    case 'copy-failed': return 'Nie udało się skopiować linku. Skopiuj adres z paska przeglądarki.'
    case null: return ''
  }
}

export const EDITOR_LABEL = 'Edytor kodu main.cpp'
export const EDITOR_PLACEHOLDER = 'Pusty plik. Jeśli ktoś ma ten pokój otwarty, kod pojawi się po połączeniu. Możesz też zacząć pisać.'
/** Shown in the editor's header while focus is inside the pane, and the editor's description for assistive tech. */
export const EDITOR_TAB_HINT = 'Esc, potem Tab: wyjście z edytora'
/** CodeMirror's own interface text (search and go-to-line panels, fold gutter, announcements), keyed by its English phrase. */
export const EDITOR_PHRASES: Record<string, string> = {
  'Find': 'Szukaj',
  'Replace': 'Zamień na',
  'next': 'następny',
  'previous': 'poprzedni',
  'all': 'wszystkie',
  'match case': 'wielkość liter',
  'regexp': 'wyrażenie regularne',
  'by word': 'całe słowa',
  'replace': 'zamień',
  'replace all': 'zamień wszystkie',
  'close': 'zamknij',
  'current match': 'bieżące trafienie',
  'on line': 'w wierszu',
  'replaced $ matches': 'zamieniono trafień: $',
  'replaced match on line $': 'zamieniono trafienie w wierszu $',
  'Go to line': 'Idź do wiersza',
  'go': 'idź',
  'folded code': 'zwinięty kod',
  'unfold': 'rozwiń',
  'Fold line': 'Zwiń wiersz',
  'Unfold line': 'Rozwiń wiersz',
  'Folded lines': 'Zwinięto wiersze',
  'Unfolded lines': 'Rozwinięto wiersze',
  'to': 'do',
  'Completions': 'Podpowiedzi',
  'Diagnostics': 'Diagnostyka',
  'No diagnostics': 'Brak diagnostyki',
  'Control character': 'Znak sterujący',
  'Selection deleted': 'Usunięto zaznaczenie',
}

export const TERMINAL_LABEL = 'Terminal programu'
export const TERMINAL_TITLE = 'Terminal'
export const TERMINAL_EMPTY_HEADING = 'Tu pojawi się wynik programu'
export const TERMINAL_EMPTY_BODY = 'Przycisk Uruchom albo Ctrl+Enter kompiluje main.cpp w Twojej przeglądarce. Wyjście widzą wszyscy w pokoju i każdy może wpisywać dane.'
/** xterm's label of its input field and its screen-reader announcement when output arrives too fast to read out. */
export const TERMINAL_INPUT_LABEL = 'Wejście programu'
export const TERMINAL_TOO_MUCH_OUTPUT = 'Za dużo wyjścia do odczytania. Przejdź strzałkami do wierszy terminala.'
/** The note under the terminal's empty state. */
export function compilerNote(compiler: CompilerFiles): string {
  switch (compiler) {
    case 'on-run': return 'Pierwsze uruchomienie pobiera kompilator, około 30 MB.'
    case 'fetching': return 'Kompilator pobiera się w tle, około 30 MB.'
    case 'ready': return 'Kompilator jest już pobrany.'
  }
}

export const RUN = 'Uruchom'
export const RUN_HINT = 'Uruchom program (Ctrl+Enter)'
export const STOP = 'Zatrzymaj'
export const STATUS_IDLE = 'Gotowe'
export const PROGRESS_LABEL = 'Pobieranie kompilatora'

const UNCAUGHT = 'crash:uncaught C++ exception'
const exitCode = (exit: string) => exit.slice('code:'.length)

/** Text of `#percent` beside the progress bar; `#status` keeps the label alone, so the live region speaks once. */
export const percentText = (v: RunView) => (v.phase === 'loading' && v.mine ? `${Math.round((v.progress ?? 0) * 100)}%` : '')

/** Text of `#status` for a run view. */
export function statusText(v: RunView): string {
  switch (v.phase) {
    case 'idle': return STATUS_IDLE
    case 'loading': return v.mine ? PROGRESS_LABEL : `${v.runnerName} pobiera kompilator`
    case 'compiling': return v.mine ? 'Kompilacja' : `${v.runnerName} kompiluje`
    case 'running': return v.mine ? (v.stdinWaiting ? 'Program czeka na dane' : 'Program działa') : `${v.runnerName} uruchamia program`
    case 'done': break
  }
  const exit = v.exit
  if (exit === null) return STATUS_IDLE
  if (exit === 'compile-error') return 'Błąd kompilacji'
  if (exit === 'killed') return 'Zatrzymano'
  if (exit === 'output-limit') return 'Zatrzymano: limit wyjścia'
  if (exit === 'runner-left') return 'Przerwano: osoba uruchamiająca wyszła'
  if (exit === 'load-error') return 'Kompilator przestał działać'
  if (exit.startsWith('code:')) return `Zakończono, kod ${exitCode(exit)}`
  return 'Program przerwany' // crash:* and no-wasm-eh
}

/** First terminal line of a run. */
export const runHeaderLine = (runnerName: string) => `[${runnerName} uruchamia main.cpp]`

/** Last terminal line of a run. */
export function exitLine(exit: Exit | 'runner-left'): string {
  if (exit === 'compile-error') return '[błąd kompilacji]'
  if (exit === 'killed') return '[zatrzymano]'
  if (exit === 'output-limit') return '[limit wyjścia 256 kB, program zatrzymany]'
  if (exit === 'runner-left') return '[osoba uruchamiająca wyszła z pokoju]'
  if (exit === 'load-error') return '[kompilator przestał działać: błąd pobierania albo brak pamięci, uruchom ponownie]'
  if (exit === 'no-wasm-eh') return '[ta przeglądarka nie obsługuje wyjątków WebAssembly: potrzebny Chrome 137, Firefox 131 albo Safari 18.4]'
  if (exit === UNCAUGHT) return '[nieobsłużony wyjątek C++]'
  if (exit.startsWith('code:')) return `[program zakończył się kodem ${exitCode(exit)}]`
  return `[program przerwany: ${exit.slice('crash:'.length)}]`
}

// Random identities: 16 animals, each well under NAME_MAX.
export const ANIMALS = ['Ryś', 'Żubr', 'Bóbr', 'Sowa', 'Lis', 'Wilk', 'Jeż', 'Bocian', 'Sarna', 'Wydra', 'Borsuk', 'Kuna', 'Łoś', 'Zając', 'Czapla', 'Dzik'] as const

// Starter main.cpp for a new room (at most 40 lines).
export const TEMPLATE = `#include <iostream>
#include <memory>
#include <string>
#include <vector>

// Klasa abstrakcyjna: każda figura umie podać swoją nazwę i pole.
class Figura {
public:
    virtual ~Figura() = default;
    virtual std::string nazwa() const = 0;
    virtual double pole() const = 0;
};

class Prostokat : public Figura {
    double a, b;
public:
    Prostokat(double a, double b) : a(a), b(b) {}
    std::string nazwa() const override { return "Prostokąt"; }
    double pole() const override { return a * b; }
};

class Kolo : public Figura {
    double r;
public:
    explicit Kolo(double r) : r(r) {}
    std::string nazwa() const override { return "Koło"; }
    double pole() const override { return 3.14159265 * r * r; }
};

int main() {
    std::cout << "Jak masz na imię? ";
    std::string imie;
    std::getline(std::cin, imie);
    std::vector<std::unique_ptr<Figura>> figury;
    figury.push_back(std::make_unique<Prostokat>(3, 4));
    figury.push_back(std::make_unique<Kolo>(1));
    std::cout << "Cześć, " << imie << "! Oto figury:\\n";
    for (const auto& f : figury)
        std::cout << "  " << f->nazwa() << " ma pole " << f->pole() << "\\n";
}
`
