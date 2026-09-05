# Third-party notices

CallTrack CRM is released under the [MIT License](LICENSE). The installers and
the running server include the open-source components listed here, each under
its own license. This file is **generated** by `scripts/third-party-notices.mjs`
from the installed production dependency trees — regenerate it after any
dependency change (`node scripts/third-party-notices.mjs`; CI runs `--check`).
Platform-specific optional binaries (per-OS builds of `sharp`/libvips, etc.)
are folded into their parent package.

## Read this first — copyleft components

- **libsignal@6.0.0** — GPL-3.0 (WhiskeySockets/libsignal-node)

- **libsignal (`libsignal` via `baileys`) is GPL-3.0.** It is the Signal-protocol
  implementation the bundled WhatsApp engine (`server/lib/whatsapp.js`) loads
  in-process, and it ships inside every desktop installer. CallTrack itself is
  open source, so the GPL's source-availability condition is met by this public
  repository: anyone who receives an installer can obtain the complete
  corresponding source at https://github.com/lapaasindia/calltrack-crm. **If you
  fork CallTrack into a closed-source product, you must either keep your
  distribution GPL-compatible or remove the WhatsApp engine** (`baileys` and its
  `libsignal` dependency). The engine is opt-in at runtime (an admin has to click
  *Connect*), but the code is distributed regardless. See
  [ADR 0004](docs/adr/0004-whatsapp-bundled.md).
- `libsignal` is installed from a git commit (no npm tarball / integrity hash);
  see the ADR for the reproducibility trade-off.

## Runtimes and platform components (not in the npm trees)

| Component | Where | License |
|---|---|---|
| Node.js | server runtime (`npm start`, LaunchAgent) | MIT (with third-party notices in the Node.js distribution) |
| Electron ^44.2.0 | desktop shell (Mac/Windows installers) | MIT; bundles Chromium (BSD-3-Clause and others) and Node.js |
| SQLite (via `better-sqlite3`) | database engine | Public domain |
| Capacitor Android runtime, `@capacitor/*` plugins | Android app | MIT |
| Google ML Kit barcode scanning (via `@capacitor-mlkit/barcode-scanning`) | Android app QR pairing | Google APIs Terms of Service (proprietary binaries downloaded by Gradle) |
| AndroidX, Kotlin stdlib, WorkManager | Android app | Apache-2.0 |
| whisper.cpp / Ollama models | optional local AI worker — installed separately by the operator, never bundled | MIT (whisper.cpp); model licenses vary |

## Server + desktop shell — production dependencies (`npm ls --omit=dev --all`)

188 packages.

| License | Packages |
|---|---|
| MIT | 157 |
| BSD-3-Clause | 14 |
| ISC | 11 |
| Apache-2.0 | 3 |
| 0BSD | 1 |
| Apache 2.0 | 1 |
| GPL-3.0 | 1 |

| Package | Version | License |
|---|---|---|
| [@borewit/text-codec](https://github.com/Borewit/text-codec) | 0.2.2 | MIT |
| [@cacheable/memory](https://github.com/jaredwray/cacheable) | 2.0.9 | MIT |
| [@cacheable/node-cache](https://github.com/jaredwray/cacheable) | 1.7.6 | MIT |
| [@cacheable/utils](https://github.com/jaredwray/cacheable) | 2.4.1 | MIT |
| [@hapi/boom](https://github.com/hapijs/boom) | 9.1.4 | BSD-3-Clause |
| [@hapi/hoek](https://github.com/hapijs/hoek) | 9.3.0 | BSD-3-Clause |
| [@img/colour](https://github.com/lovell/colour) | 1.1.0 | MIT |
| [@keyv/bigmap](https://github.com/jaredwray/keyv) | 1.3.1 | MIT |
| [@keyv/serialize](https://github.com/jaredwray/keyv) | 1.1.1 | MIT |
| [@pinojs/redact](https://github.com/pinojs/redact#readme) | 0.4.0 | MIT |
| [@protobufjs/aspromise](https://github.com/dcodeIO/protobuf.js) | 1.1.2 | BSD-3-Clause |
| [@protobufjs/base64](https://github.com/dcodeIO/protobuf.js) | 1.1.2 | BSD-3-Clause |
| [@protobufjs/codegen](https://github.com/dcodeIO/protobuf.js) | 2.0.5 | BSD-3-Clause |
| [@protobufjs/eventemitter](https://github.com/dcodeIO/protobuf.js) | 1.1.1 | BSD-3-Clause |
| [@protobufjs/fetch](https://github.com/dcodeIO/protobuf.js) | 1.1.1 | BSD-3-Clause |
| [@protobufjs/float](https://github.com/dcodeIO/protobuf.js) | 1.0.2 | BSD-3-Clause |
| [@protobufjs/path](https://github.com/dcodeIO/protobuf.js) | 1.1.2 | BSD-3-Clause |
| [@protobufjs/pool](https://github.com/dcodeIO/protobuf.js) | 1.1.0 | BSD-3-Clause |
| [@protobufjs/utf8](https://github.com/dcodeIO/protobuf.js) | 1.1.1 | BSD-3-Clause |
| [@tokenizer/inflate](https://github.com/Borewit/tokenizer-inflate) | 0.4.1 | MIT |
| [@tokenizer/token](https://github.com/Borewit/tokenizer-token) | 0.3.0 | MIT |
| [@types/node](https://github.com/DefinitelyTyped/DefinitelyTyped/tree/master/types/node) | 24.13.3 | MIT |
| [accepts](jshttp/accepts) | 1.3.8 | MIT |
| [agent-base](https://github.com/TooTallNate/node-agent-base) | 6.0.2 | MIT |
| [ansi-regex](chalk/ansi-regex) | 5.0.1 | MIT |
| [ansi-styles](chalk/ansi-styles) | 4.3.0 | MIT |
| [append-field](http://github.com/LinusU/node-append-field) | 1.0.0 | MIT |
| [array-flatten](https://github.com/blakeembrey/array-flatten) | 1.1.1 | MIT |
| [async-mutex](https://github.com/DirtyHairy/async-mutex) | 0.5.0 | MIT |
| [asynckit](https://github.com/alexindigo/asynckit#readme) | 0.4.0 | MIT |
| [atomic-sleep](https://github.com/davidmarkclements/atomic-sleep#readme) | 1.0.0 | MIT |
| [axios](https://axios-http.com) | 1.18.0 | MIT |
| [baileys](https://github.com/WhiskeySockets/Baileys/) | 6.7.24 | MIT |
| [bcryptjs](https://github.com/dcodeIO/bcrypt.js) | 2.4.3 | MIT |
| [better-sqlite3](http://github.com/WiseLibs/better-sqlite3) | 13.0.3 | MIT |
| [body-parser](expressjs/body-parser) | 1.20.6 | MIT |
| [buffer-from](LinusU/buffer-from) | 1.1.2 | MIT |
| [busboy](http://github.com/mscdex/busboy) | 1.6.0 | MIT |
| [bytes](visionmedia/bytes.js) | 3.1.2 | MIT |
| [cacheable](https://github.com/jaredwray/cacheable) | 2.3.5 | MIT |
| [call-bind-apply-helpers](https://github.com/ljharb/call-bind-apply-helpers#readme) | 1.0.2 | MIT |
| [call-bound](https://github.com/ljharb/call-bound#readme) | 1.0.4 | MIT |
| [camelcase](sindresorhus/camelcase) | 5.3.1 | MIT |
| [cliui](http://github.com/yargs/cliui) | 6.0.0 | ISC |
| [color-convert](Qix-/color-convert) | 2.0.1 | MIT |
| [color-name](https://github.com/colorjs/color-name) | 1.1.4 | MIT |
| [combined-stream](https://github.com/felixge/node-combined-stream) | 1.0.8 | MIT |
| [concat-stream](http://github.com/maxogden/concat-stream) | 2.0.0 | MIT |
| [content-disposition](jshttp/content-disposition) | 0.5.4 | MIT |
| [content-type](jshttp/content-type) | 1.0.5 | MIT |
| [content-type](jshttp/content-type) | 2.0.0 | MIT |
| [cookie](jshttp/cookie) | 0.7.2 | MIT |
| [cookie-signature](https://github.com/visionmedia/node-cookie-signature) | 1.0.7 | MIT |
| [curve25519-js](https://github.com/harveyconnor/curve25519-js#readme) | 0.0.4 | MIT |
| [debug](https://github.com/visionmedia/debug) | 2.6.9 | MIT |
| [debug](https://github.com/debug-js/debug) | 4.4.3 | MIT |
| [decamelize](sindresorhus/decamelize) | 1.2.0 | MIT |
| [delayed-stream](https://github.com/felixge/node-delayed-stream) | 1.0.0 | MIT |
| [depd](dougwilson/nodejs-depd) | 2.0.0 | MIT |
| [destroy](stream-utils/destroy) | 1.2.0 | MIT |
| [detect-libc](https://github.com/lovell/detect-libc) | 2.1.2 | Apache-2.0 |
| [dijkstrajs](https://github.com/tcort/dijkstrajs) | 1.0.3 | MIT |
| [dunder-proto](https://github.com/es-shims/dunder-proto#readme) | 1.0.1 | MIT |
| [ee-first](jonathanong/ee-first) | 1.1.1 | MIT |
| [emoji-regex](https://mths.be/emoji-regex) | 8.0.0 | MIT |
| [encodeurl](pillarjs/encodeurl) | 2.0.0 | MIT |
| [es-define-property](https://github.com/ljharb/es-define-property#readme) | 1.0.1 | MIT |
| [es-errors](https://github.com/ljharb/es-errors#readme) | 1.3.0 | MIT |
| [es-object-atoms](https://github.com/ljharb/es-object-atoms#readme) | 1.1.2 | MIT |
| [es-set-tostringtag](https://github.com/es-shims/es-set-tostringtag#readme) | 2.1.0 | MIT |
| [escape-html](component/escape-html) | 1.0.3 | MIT |
| [etag](jshttp/etag) | 1.8.1 | MIT |
| [express](http://expressjs.com/) | 4.22.2 | MIT |
| [express-session](expressjs/session) | 1.19.0 | MIT |
| [file-type](sindresorhus/file-type) | 21.3.4 | MIT |
| [finalhandler](pillarjs/finalhandler) | 1.3.2 | MIT |
| [find-up](sindresorhus/find-up) | 4.1.0 | MIT |
| [follow-redirects](https://github.com/follow-redirects/follow-redirects) | 1.16.0 | MIT |
| [form-data](https://github.com/form-data/form-data) | 4.0.6 | MIT |
| [forwarded](jshttp/forwarded) | 0.2.0 | MIT |
| [fresh](jshttp/fresh) | 0.5.2 | MIT |
| [function-bind](https://github.com/Raynos/function-bind) | 1.1.2 | MIT |
| [get-caller-file](https://github.com/stefanpenner/get-caller-file#readme) | 2.0.5 | ISC |
| [get-intrinsic](https://github.com/ljharb/get-intrinsic#readme) | 1.3.0 | MIT |
| [get-proto](https://github.com/ljharb/get-proto#readme) | 1.0.1 | MIT |
| [gopd](https://github.com/ljharb/gopd#readme) | 1.2.0 | MIT |
| [has-symbols](https://github.com/ljharb/has-symbols#readme) | 1.1.0 | MIT |
| [has-tostringtag](https://github.com/inspect-js/has-tostringtag#readme) | 1.0.2 | MIT |
| [hashery](https://github.com/jaredwray/hashery) | 1.5.1 | MIT |
| [hasown](https://github.com/inspect-js/hasOwn#readme) | 2.0.4 | MIT |
| [hookified](https://github.com/jaredwray/hookified#readme) | 1.15.1 | MIT |
| [hookified](https://github.com/jaredwray/hookified#readme) | 2.2.0 | MIT |
| [http-errors](jshttp/http-errors) | 2.0.1 | MIT |
| [https-proxy-agent](https://github.com/TooTallNate/node-https-proxy-agent) | 5.0.1 | MIT |
| [iconv-lite](https://github.com/ashtuchkin/iconv-lite) | 0.4.24 | MIT |
| [ieee754](https://github.com/feross/ieee754) | 1.2.1 | BSD-3-Clause |
| [inherits](https://github.com/isaacs/inherits) | 2.0.4 | ISC |
| [ipaddr.js](https://github.com/whitequark/ipaddr.js) | 1.9.1 | MIT |
| [is-fullwidth-code-point](sindresorhus/is-fullwidth-code-point) | 3.0.0 | MIT |
| [keyv](https://github.com/jaredwray/keyv) | 5.6.0 | MIT |
| [libsignal](WhiskeySockets/libsignal-node) | 6.0.0 | GPL-3.0 |
| [locate-path](sindresorhus/locate-path) | 5.0.0 | MIT |
| [long](https://github.com/dcodeIO/long.js) | 5.3.2 | Apache-2.0 |
| [math-intrinsics](https://github.com/es-shims/math-intrinsics#readme) | 1.1.0 | MIT |
| [media-typer](jshttp/media-typer) | 0.3.0 | MIT |
| [media-typer](jshttp/media-typer) | 2.0.0 | MIT |
| [merge-descriptors](sindresorhus/merge-descriptors) | 1.0.3 | MIT |
| [methods](jshttp/methods) | 1.1.2 | MIT |
| [mime](https://github.com/broofa/node-mime) | 1.6.0 | MIT |
| [mime-db](jshttp/mime-db) | 1.52.0 | MIT |
| [mime-types](jshttp/mime-types) | 2.1.35 | MIT |
| [ms](zeit/ms) | 2.0.0 | MIT |
| [ms](vercel/ms) | 2.1.3 | MIT |
| [multer](https://github.com/expressjs/multer) | 2.3.0 | MIT |
| [music-metadata](https://github.com/Borewit/music-metadata) | 11.13.0 | MIT |
| [negotiator](jshttp/negotiator) | 0.6.3 | MIT |
| [node-addon-api](https://github.com/nodejs/node-addon-api) | 8.9.2 | MIT |
| [object-inspect](https://github.com/inspect-js/object-inspect) | 1.13.4 | MIT |
| [on-exit-leak-free](https://github.com/mcollina/on-exit-or-gc#readme) | 2.1.2 | MIT |
| [on-finished](jshttp/on-finished) | 2.4.1 | MIT |
| [on-headers](jshttp/on-headers) | 1.1.0 | MIT |
| [p-limit](sindresorhus/p-limit) | 2.3.0 | MIT |
| [p-locate](sindresorhus/p-locate) | 4.1.0 | MIT |
| [p-try](sindresorhus/p-try) | 2.2.0 | MIT |
| [parseurl](pillarjs/parseurl) | 1.3.3 | MIT |
| [path-exists](sindresorhus/path-exists) | 4.0.0 | MIT |
| [path-to-regexp](https://github.com/pillarjs/path-to-regexp) | 0.1.13 | MIT |
| [pino](https://getpino.io) | 9.14.0 | MIT |
| [pino-abstract-transport](https://github.com/pinojs/pino-abstract-transport#readme) | 2.0.0 | MIT |
| [pino-std-serializers](https://github.com/pinojs/pino-std-serializers#readme) | 7.1.0 | MIT |
| [pngjs](https://github.com/lukeapage/pngjs) | 5.0.0 | MIT |
| [process-warning](https://github.com/fastify/fastify-warning#readme) | 5.0.0 | MIT |
| [protobufjs](https://protobufjs.github.io/protobuf.js/) | 7.6.6 | BSD-3-Clause |
| [proxy-addr](jshttp/proxy-addr) | 2.0.7 | MIT |
| [proxy-from-env](https://github.com/Rob--W/proxy-from-env#readme) | 2.1.0 | MIT |
| [qified](https://github.com/jaredwray/qified#readme) | 0.10.1 | MIT |
| [qrcode](http://github.com/soldair/node-qrcode) | 1.5.4 | MIT |
| [qrcode-terminal](https://github.com/gtanner/qrcode-terminal) | 0.12.0 | Apache 2.0 |
| [qs](https://github.com/ljharb/qs) | 6.16.0 | BSD-3-Clause |
| [quick-format-unescaped](https://github.com/davidmarkclements/quick-format#readme) | 4.0.4 | MIT |
| [random-bytes](crypto-utils/random-bytes) | 1.0.0 | MIT |
| [range-parser](jshttp/range-parser) | 1.2.1 | MIT |
| [raw-body](stream-utils/raw-body) | 2.5.3 | MIT |
| [readable-stream](https://github.com/nodejs/readable-stream) | 3.6.2 | MIT |
| [real-require](https://github.com/pinojs/real-require) | 0.2.0 | MIT |
| [require-directory](https://github.com/troygoode/node-require-directory/) | 2.1.1 | MIT |
| [require-main-filename](https://github.com/yargs/require-main-filename#readme) | 2.0.0 | ISC |
| [safe-buffer](https://github.com/feross/safe-buffer) | 5.2.1 | MIT |
| [safe-stable-stringify](https://github.com/BridgeAR/safe-stable-stringify#readme) | 2.5.0 | MIT |
| [safer-buffer](https://github.com/ChALkeR/safer-buffer) | 2.1.2 | MIT |
| [semver](https://github.com/npm/node-semver) | 7.8.4 | ISC |
| [send](pillarjs/send) | 0.19.2 | MIT |
| [serve-static](expressjs/serve-static) | 1.16.3 | MIT |
| [set-blocking](https://github.com/yargs/set-blocking#readme) | 2.0.0 | ISC |
| [setprototypeof](https://github.com/wesleytodd/setprototypeof) | 1.2.0 | ISC |
| [sharp](https://sharp.pixelplumbing.com) | 0.35.1 | Apache-2.0 |
| [side-channel](https://github.com/ljharb/side-channel#readme) | 1.1.1 | MIT |
| [side-channel-list](https://github.com/ljharb/side-channel-list#readme) | 1.0.1 | MIT |
| [side-channel-map](https://github.com/ljharb/side-channel-map#readme) | 1.0.1 | MIT |
| [side-channel-weakmap](https://github.com/ljharb/side-channel-weakmap#readme) | 1.0.2 | MIT |
| [sonic-boom](https://github.com/pinojs/sonic-boom#readme) | 4.2.1 | MIT |
| [split2](https://github.com/mcollina/split2) | 4.2.0 | ISC |
| [statuses](jshttp/statuses) | 2.0.2 | MIT |
| [streamsearch](http://github.com/mscdex/streamsearch) | 1.1.0 | MIT |
| [string_decoder](https://github.com/nodejs/string_decoder) | 1.3.0 | MIT |
| [string-width](sindresorhus/string-width) | 4.2.3 | MIT |
| [strip-ansi](chalk/strip-ansi) | 6.0.1 | MIT |
| [strtok3](https://github.com/Borewit/strtok3) | 10.3.5 | MIT |
| [thread-stream](https://github.com/mcollina/thread-stream#readme) | 3.2.0 | MIT |
| [toidentifier](component/toidentifier) | 1.0.1 | MIT |
| [token-types](https://github.com/Borewit/token-types) | 6.1.2 | MIT |
| [tslib](https://www.typescriptlang.org/) | 2.8.1 | 0BSD |
| [type-is](jshttp/type-is) | 1.6.18 | MIT |
| [typedarray](https://github.com/substack/typedarray) | 0.0.6 | MIT |
| [uid-safe](crypto-utils/uid-safe) | 2.1.5 | MIT |
| [uint8array-extras](sindresorhus/uint8array-extras) | 1.5.0 | MIT |
| [undici-types](https://undici.nodejs.org) | 7.18.2 | MIT |
| [unpipe](stream-utils/unpipe) | 1.0.0 | MIT |
| [util-deprecate](https://github.com/TooTallNate/util-deprecate) | 1.0.2 | MIT |
| [utils-merge](https://github.com/jaredhanson/utils-merge) | 1.0.1 | MIT |
| [vary](jshttp/vary) | 1.1.2 | MIT |
| [which-module](https://github.com/nexdrew/which-module#readme) | 2.0.1 | ISC |
| [win-guid](https://github.com/Borewit/win-guid) | 0.2.1 | MIT |
| [wrap-ansi](chalk/wrap-ansi) | 6.2.0 | MIT |
| [ws](https://github.com/websockets/ws) | 8.21.0 | MIT |
| [y18n](https://github.com/yargs/y18n) | 4.0.3 | ISC |
| [yargs](https://yargs.js.org/) | 15.4.1 | MIT |
| [yargs-parser](https://github.com/yargs/yargs-parser) | 18.1.3 | ISC |

## Web client bundle — production dependencies (`npm --prefix client ls --omit=dev --all`)

78 packages (bundled by Vite into `client/dist`; devDependencies such as Vite itself are not shipped).

| License | Packages |
|---|---|
| MIT | 56 |
| ISC | 18 |
| BSD-3-Clause | 2 |
| Apache-2.0 | 1 |
| MIT AND ISC | 1 |

| Package | Version | License |
|---|---|---|
| [@babel/runtime](https://babel.dev/docs/en/next/babel-runtime) | 7.29.7 | MIT |
| [@remix-run/router](https://github.com/remix-run/react-router) | 1.23.4 | MIT |
| [@types/d3-array](https://github.com/DefinitelyTyped/DefinitelyTyped/tree/master/types/d3-array) | 3.2.2 | MIT |
| [@types/d3-color](https://github.com/DefinitelyTyped/DefinitelyTyped/tree/master/types/d3-color) | 3.1.3 | MIT |
| [@types/d3-ease](https://github.com/DefinitelyTyped/DefinitelyTyped/tree/master/types/d3-ease) | 3.0.2 | MIT |
| [@types/d3-interpolate](https://github.com/DefinitelyTyped/DefinitelyTyped/tree/master/types/d3-interpolate) | 3.0.4 | MIT |
| [@types/d3-path](https://github.com/DefinitelyTyped/DefinitelyTyped/tree/master/types/d3-path) | 3.1.1 | MIT |
| [@types/d3-scale](https://github.com/DefinitelyTyped/DefinitelyTyped/tree/master/types/d3-scale) | 4.0.9 | MIT |
| [@types/d3-shape](https://github.com/DefinitelyTyped/DefinitelyTyped/tree/master/types/d3-shape) | 3.1.8 | MIT |
| [@types/d3-time](https://github.com/DefinitelyTyped/DefinitelyTyped/tree/master/types/d3-time) | 3.0.4 | MIT |
| [@types/d3-timer](https://github.com/DefinitelyTyped/DefinitelyTyped/tree/master/types/d3-timer) | 3.0.2 | MIT |
| [ansi-regex](chalk/ansi-regex) | 5.0.1 | MIT |
| [ansi-styles](chalk/ansi-styles) | 4.3.0 | MIT |
| [camelcase](sindresorhus/camelcase) | 5.3.1 | MIT |
| [cliui](http://github.com/yargs/cliui) | 6.0.0 | ISC |
| [clsx](lukeed/clsx) | 2.1.1 | MIT |
| [color-convert](Qix-/color-convert) | 2.0.1 | MIT |
| [color-name](https://github.com/colorjs/color-name) | 1.1.4 | MIT |
| [csstype](https://github.com/frenic/csstype) | 3.2.3 | MIT |
| [d3-array](https://d3js.org/d3-array/) | 3.2.4 | ISC |
| [d3-color](https://d3js.org/d3-color/) | 3.1.0 | ISC |
| [d3-ease](https://d3js.org/d3-ease/) | 3.0.1 | BSD-3-Clause |
| [d3-format](https://d3js.org/d3-format/) | 3.1.2 | ISC |
| [d3-interpolate](https://d3js.org/d3-interpolate/) | 3.0.1 | ISC |
| [d3-path](https://d3js.org/d3-path/) | 3.1.0 | ISC |
| [d3-scale](https://d3js.org/d3-scale/) | 4.0.2 | ISC |
| [d3-shape](https://d3js.org/d3-shape/) | 3.2.0 | ISC |
| [d3-time](https://d3js.org/d3-time/) | 3.1.0 | ISC |
| [d3-time-format](https://d3js.org/d3-time-format/) | 4.1.0 | ISC |
| [d3-timer](https://d3js.org/d3-timer/) | 3.0.1 | ISC |
| [decamelize](sindresorhus/decamelize) | 1.2.0 | MIT |
| [decimal.js-light](https://github.com/MikeMcl/decimal.js-light) | 2.5.1 | MIT |
| [dijkstrajs](https://github.com/tcort/dijkstrajs) | 1.0.3 | MIT |
| [dom-helpers](https://github.com/react-bootstrap/dom-helpers#readme) | 5.2.1 | MIT |
| [emoji-regex](https://mths.be/emoji-regex) | 8.0.0 | MIT |
| [eventemitter3](https://github.com/primus/eventemitter3) | 4.0.7 | MIT |
| [fast-equals](https://github.com/planttheidea/fast-equals#readme) | 5.4.0 | MIT |
| [find-up](sindresorhus/find-up) | 4.1.0 | MIT |
| [get-caller-file](https://github.com/stefanpenner/get-caller-file#readme) | 2.0.5 | ISC |
| [internmap](https://github.com/mbostock/internmap/) | 2.0.3 | ISC |
| [is-fullwidth-code-point](sindresorhus/is-fullwidth-code-point) | 3.0.0 | MIT |
| [js-tokens](lydell/js-tokens) | 4.0.0 | MIT |
| [locate-path](sindresorhus/locate-path) | 5.0.0 | MIT |
| [lodash](https://lodash.com/) | 4.18.1 | MIT |
| [loose-envify](https://github.com/zertosh/loose-envify) | 1.4.0 | MIT |
| [object-assign](sindresorhus/object-assign) | 4.1.1 | MIT |
| [p-limit](sindresorhus/p-limit) | 2.3.0 | MIT |
| [p-locate](sindresorhus/p-locate) | 4.1.0 | MIT |
| [p-try](sindresorhus/p-try) | 2.2.0 | MIT |
| [papaparse](https://www.papaparse.com/) | 5.5.3 | MIT |
| [path-exists](sindresorhus/path-exists) | 4.0.0 | MIT |
| [pngjs](https://github.com/lukeapage/pngjs) | 5.0.0 | MIT |
| [prop-types](https://facebook.github.io/react/) | 15.8.1 | MIT |
| [qrcode](http://github.com/soldair/node-qrcode) | 1.5.4 | MIT |
| [react](https://reactjs.org/) | 18.3.1 | MIT |
| [react-dom](https://reactjs.org/) | 18.3.1 | MIT |
| [react-is](https://reactjs.org/) | 16.13.1 | MIT |
| [react-is](https://reactjs.org/) | 18.3.1 | MIT |
| [react-router](https://github.com/remix-run/react-router) | 6.30.6 | MIT |
| [react-router-dom](https://github.com/remix-run/react-router) | 6.30.6 | MIT |
| [react-smooth](https://github.com/recharts/react-smooth#readme) | 4.0.4 | MIT |
| [react-transition-group](https://github.com/reactjs/react-transition-group#readme) | 4.4.5 | BSD-3-Clause |
| [recharts](https://github.com/recharts/recharts) | 2.15.4 | MIT |
| [recharts-scale](https://github.com/recharts/recharts-scale) | 0.4.5 | MIT |
| [require-directory](https://github.com/troygoode/node-require-directory/) | 2.1.1 | MIT |
| [require-main-filename](https://github.com/yargs/require-main-filename#readme) | 2.0.0 | ISC |
| [scheduler](https://reactjs.org/) | 0.23.2 | MIT |
| [set-blocking](https://github.com/yargs/set-blocking#readme) | 2.0.0 | ISC |
| [string-width](sindresorhus/string-width) | 4.2.3 | MIT |
| [strip-ansi](chalk/strip-ansi) | 6.0.1 | MIT |
| [tiny-invariant](https://github.com/alexreardon/tiny-invariant) | 1.3.3 | MIT |
| [victory-vendor](https://commerce.nearform.com/open-source/victory) | 36.9.2 | MIT AND ISC |
| [which-module](https://github.com/nexdrew/which-module#readme) | 2.0.1 | ISC |
| [wrap-ansi](chalk/wrap-ansi) | 6.2.0 | MIT |
| [xlsx](https://sheetjs.com/) | 0.20.3 | Apache-2.0 |
| [y18n](https://github.com/yargs/y18n) | 4.0.3 | ISC |
| [yargs](https://yargs.js.org/) | 15.4.1 | MIT |
| [yargs-parser](https://github.com/yargs/yargs-parser) | 18.1.3 | ISC |

