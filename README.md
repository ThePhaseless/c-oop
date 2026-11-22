# c-oop

A shared C++ editor for a classroom. Everyone who opens the same link edits one `main.cpp` together and sees each other's cursors. Anyone can press Run: the program is compiled and run in that person's browser, and its terminal is shared, so the whole room sees the output and can type the input.

The editor syncs peer to peer over WebRTC (Yjs, y-webrtc). The compiler is clang built for WebAssembly, with C++20 and working exceptions. The server only hands out static files and relays the encrypted handshake between browsers. It never sees the code and never runs a program. The interface is in Polish.

## Quick start

You need Docker with Compose.

```sh
docker compose up -d --build
```

Open http://localhost:8080 to try it on this machine. That address works only there. Other people can join only through an HTTPS address, so set that up first (see [HTTPS](#https)) and then send them the address, including the part after `#`. To use another host port:

```sh
COOP_PORT=18080 docker compose up -d --build
```

Compose publishes the port on 127.0.0.1 only, which is all a TLS proxy on the same machine needs. When the proxy runs on another machine, set `COOP_BIND=0.0.0.0` to publish the port on every interface.

A prebuilt image for amd64 and arm64 is published at `ghcr.io/thephaseless/c-oop`, with a tag per release (`1.0.0`, `1.0`, `1`, `latest`):

```sh
docker run -d --read-only --cap-drop ALL -p 127.0.0.1:8080:8080 ghcr.io/thephaseless/c-oop
```

To build it yourself without Compose:

```sh
docker build -t c-oop .
docker run -d --read-only --cap-drop ALL -p 127.0.0.1:8080:8080 c-oop
```

The first build downloads the 124 MB WASI sysroot from GitHub (checksum pinned) and compresses the compiler with brotli. On a 4-core arm64 machine that took about 4 minutes, nearly all of it compression. Later builds reuse that layer unless the toolchain files change. The compression uses about 7 minutes of CPU time, so it takes longer with fewer cores.

The server runs as user 65532 and writes nothing to disk, so the container works with a read-only root file system. Compose sets that, and the `docker run` line above does it with `--read-only`. `/healthz` answers `ok`.

The image is `oven/bun:1.4.4-distroless` plus one 183 MB layer with the built app, nearly all of it the compiler in raw and brotli form. `docker images` reports 457 MB on disk and 137 MB compressed, which is what a pull transfers. It holds no `node_modules` and no test files.

## Configuration

| Variable | Default | Meaning |
|---|---|---|
| `PORT` | `8080` | Port the server listens on inside the container |
| `ICE_SERVERS` | Google and Twilio STUN | JSON array of `RTCIceServer` objects, sent to every browser through `/config`. The server refuses to start when the value is not valid JSON, when an entry has no `urls` starting with `stun:`, `stuns:`, `turn:` or `turns:`, when a `stun:` URL contains a `?`, or when a `turn:` entry has a missing or empty `username` or `credential`. A browser that still rejects an entry drops it, logs a console warning and connects with the entries that are left. It does not add the default servers back. A page that cannot read `/config` (the request fails, or a proxy answers with an error such as 429 or 502) uses the default servers until it is reloaded |
| `DIST_DIR` | `./dist` | Directory with the built app |
| `COOP_PORT` | `8080` | Compose only: the host port published for the container |
| `COOP_BIND` | `127.0.0.1` | Compose only: the host address the port is published on. `0.0.0.0` publishes it on every interface |

## HTTPS

Browsers give the page what it needs (Web Crypto, shared memory for the program's input) only over HTTPS or on `localhost`. Opened over plain HTTP from another machine, the page shows a notice and does nothing else. Put a TLS proxy in front of the container. With Caddy the whole configuration is:

```
c-oop.example.org {
    reverse_proxy localhost:8080
}
```

This works with the default port binding when Caddy runs on the same machine as the container. With `docker run`, `-p 8080:8080` instead of `-p 127.0.0.1:8080:8080` publishes the port on every interface.

Caddy passes WebSocket connections through, which the `/signal` endpoint needs. Whatever proxy you use, it must leave the response headers alone: the app depends on `Cross-Origin-Opener-Policy` and `Cross-Origin-Embedder-Policy` to run programs.

The server has no per-address rate limit, because behind a proxy every client arrives from the same address. Limit requests and WebSocket connections per client at the proxy. The server itself caps each signaling connection at 30 messages per second, 16 kB per message and 4 rooms, and accepts 2000 connections in total.

Run exactly one instance behind each address. The server keeps rooms in memory and replicas do not share them, so two people in the same room who reach different replicas never find each other, and each sees an empty room with no error.

## TURN

Browsers connect to each other directly. The default STUN servers are enough on home networks. School and company networks often block direct connections, and then the page reports that it could not connect to someone in the room. Those networks need a TURN server (coturn, for example), added through `ICE_SERVERS`:

```yaml
environment:
  ICE_SERVERS: '[{"urls":["stun:stun.l.google.com:19302"]},{"urls":["turn:turn.example.org:3478"],"username":"c-oop","credential":"change-me"}]'
```

Every visitor receives these values, the TURN username and credential included. That comes with static TURN credentials, so use an account made for this app.

## Privacy

The room secret is the part of the link after `#`. Browsers never send that part to a server. From it the page derives a room id and an encryption key.

The server sees client IP addresses, the room id (a hash that reveals neither the secret nor the key), and the WebRTC handshake messages, which are encrypted with the room key. It logs one line at startup and one line for each internal error, with the error's name and message; for a file it could not read, that names the file. It logs nothing else about requests and nothing about rooms. It stores nothing.

Other people in the room see your IP address, as with any WebRTC connection, unless all traffic goes through TURN.

Anyone who has the link can read and edit the code, run it and stop it. There are no accounts and no roles. A program runs only in the browser of the person who pressed Run, inside the WebAssembly sandbox, with no access to files or the network.

Each browser keeps a copy of the room in IndexedDB: the code and the output of the last run. It stays in that browser profile until the site data is cleared, which matters on shared computers in a school lab.

The default STUN servers belong to Google and Twilio and see the IP address of every visitor. Set `ICE_SERVERS` to use your own. A page whose `/config` request fails still uses the default servers until it is reloaded.

## Limits

The program:

- One file, `main.cpp`, of at most 1,000,000 characters. The editor shortens text that is typed or pasted to what still fits. Text that passes the limit another way, from someone else's browser or from the stored copy, is cut off at the end of the file by every browser in the room. Either way the page shows a notice. C++20 with `-O1 -Wall`.
- No `std::thread` and no file or network I/O. The program has standard input and output and nothing else.
- Input is line based. A line reaches the program when someone presses Enter; there is no raw key input.
- A run may write 256 kB of terminal text, compiler messages and typed input included. At that point it is stopped.
- Fifteen standard headers are precompiled and always included: `iostream`, `string`, `vector`, `memory`, `stdexcept`, `map`, `algorithm`, `sstream`, `iomanip`, `cmath`, `functional`, `utility`, `array`, `set`, `unordered_map`. A program that forgets one of these `#include` lines still compiles here and may fail with another compiler.
- stdout and stderr share one stream.
- The terminal shows text and colours. Other terminal control sequences in the program's output (cursor movement, clearing the screen, window titles) are removed before the output is shared.
- A program can print a line that looks like the page's own grey status lines, for example `[program zakończył się kodem 0]`. It cannot change the status next to the Run button.

The browser:

- Tested in Chromium only. Chrome 137, Firefox 131 and Safari 18.4 or later have the WebAssembly exception support the programs need, and Firefox and Safari should work, but nobody has tried them.
- The compiler is 30.6 MB compressed (150 MB unpacked). The browser of everyone who opens the page downloads it in the background shortly after the page opens, whether or not that person ever presses Run, and keeps about 150 MB of unpacked files in the site's browser storage. The compiler starts, and takes its memory, only in the browser that presses Run. A Run pressed before the download has finished shows its progress and goes on when it is done. When a whole class opens the link at once on a shared connection, all the downloads run at the same time, so a Run pressed during that burst can wait longer. There is no background download when the browser asks to save data (`navigator.connection.saveData`), when Run is disabled, or when Cache Storage is unavailable. The first Run downloads the compiler then, and also after a background download that failed. The page itself is about 0.64 MB (0.29 MB of script and styles, the rest fonts).
- Compiling needs about 0.9 GB of RAM in the tab. Phones and small laptops may not have it. When the compiler fails, the terminal says so. When the browser closes the whole tab for lack of memory, the page cannot show anything.
- Measured against the container on the build machine (4-core arm64, headless Chromium, localhost): the first Run of a hello world took 4.3 s, of which 1.1 s went to loading the compiler and 3.1 s to the first compile, which is slower than later ones. After that the hello world took 1.4 to 1.5 s from Run to exit, and a small class hierarchy with a template and a caught exception took 2.0 to 2.2 s. After a page reload the compiler loaded from the browser cache in 0.5 s and the first Run of the class program took 4.6 s. Over a real network, a Run pressed before the background download has finished also waits for the rest of it.
- A reload within a few milliseconds of the last keystroke can lose that keystroke when nobody else is in the room. With others present it comes back from them.
- Polish letters reach the program when they are typed on a keyboard (AltGr or Option with a letter), entered through an input method, or pasted. Text that a tool inserts without key or composition events (an emoji picker, dictation, some on-screen keyboards) does not arrive: the terminal uses the screen reader mode of xterm.js, which ignores such input.

The room:

- Every browser connects to every other one, so a room works for about 20 people. The server refuses the 65th connection to a room without an error; that person sees an empty room.
- When the person who started a program closes the tab, the run ends for everyone. If their browser crashes instead, the others notice after up to 30 seconds, and a closed browser also stays in the list of people for that long.
- A hidden tab runs its timers slowly, so a program started from a tab that is now in the background shares its output about once per second.
- The name on a caret shows for about two seconds after its owner types or moves it. It can also show when someone else types or deletes exactly where that caret stands: a deletion does not say who made it, and after an insertion there the browser of the caret's owner reports the caret again when its editor has the focus.
- After the server is updated, tabs that were already open keep the old code until they are reloaded.
- The page checks what it reads from the shared document, but a hostile participant can still fill the room's stored data with junk that every browser then keeps. Share a room only with people you trust with the link.
- The server accepts 2000 signaling connections in total and has no limit per address, so one client could use them all up. A rate limit at the proxy is the defence against that (see [HTTPS](#https)).

## Development

Needs [Bun](https://bun.sh) 1.4.4. The browser tests also need a Chromium from Playwright under `~/.cache/ms-playwright`, or the `CHROME` variable pointing at a Chromium executable.

```sh
bun install --frozen-lockfile
bun run typecheck
bun run build        # builds dist/, including the toolchain on the first call
bun run start        # serves dist/ on http://localhost:8080
bun run test         # unit and integration tests
bun run e2e          # 27 browser scenarios against the built app, about 6 minutes
bun run e2e:docker   # the same scenarios against the Docker image
```

`bun run build` has to come before `test` and `e2e`. Arguments after `e2e` or `e2e:docker` go to the test runner, so `bun run e2e -t "01 smoke"` runs one scenario. `e2e:docker` builds the image, starts it under the Compose project `c-oop-e2e` on `COOP_PORT`, runs the suite and removes the container whatever the result. `BASE_URL=https://host bun run e2e` runs the suite against any running instance.

`bun src/client/dev/serve.ts` serves a page with every interface state, for working on the styles.
