# Research: Self-Hosting the Collab Relay and Reusing `@oh-my-pi/collab-web`

## 1. License Analysis

### Upstream License Quotes

**`packages/collab-web/package.json`**:
```json
{
  "name": "@oh-my-pi/collab-web",
  "version": "16.3.6",
  "license": "MIT",
  "private": true
}
```

**Root `LICENSE`** (`https://github.com/can1357/oh-my-pi/blob/main/LICENSE`):
```text
MIT License

Copyright (c) 2025 Mario Zechner
Copyright (c) 2025-2026 Can Bölük
Copyright (c) 2026 Stencil Labs, Inc.

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

### Verdict on Reuse and Required Notices
- **Permissibility**: The code in `packages/collab-web` is licensed under MIT. We are fully permitted to reuse, adapt, bundle, fork, self-host, and modify it.
- **The `"private": true` field**: In npm/yarn/bun packaging, `"private": true` is an npm registry publishing guard to prevent accidental `npm publish`. It does not restrict legal rights granted by the MIT license.
- **Required notices**: The copyright notice (`Copyright (c) 2025 Mario Zechner`, `Copyright (c) 2025-2026 Can Bölük`, `Copyright (c) 2026 Stencil Labs, Inc.`) and the MIT permission notice must be retained in copies or substantial portions of the client software or its documentation.

---

## 2. Relay Wire Contract Specification

The relay acts as a content-blind hub between one host and zero or more guests. Payloads are end-to-end encrypted; the relay operates on opaque byte buffers and JSON control envelopes.

### HTTP & WebSocket Upgrade
- **Endpoint**: `GET /r/<roomId>?role=host|guest`
- **Room ID Format**: `/^[A-Za-z0-9_-]{10,64}$/` (`packages/collab-web/scripts/local-relay.ts:20`, `packages/coding-agent/src/collab/protocol.ts:179`).
- **Role Query Parameter**: Query string `role` must be either `"host"` or `"guest"` (`packages/collab-web/scripts/local-relay.ts:54-55`, `packages/coding-agent/src/collab/relay-client.ts:506`).
- **HTTP status codes**: Returns `404 Not Found` if path or role is malformed; `426 Upgrade Required` if standard HTTP request arrives without WebSocket upgrade headers (`packages/collab-web/scripts/local-relay.ts:55-60`).

### Connection Admission & WebSocket Close Codes
- **Host connection**:
  - Creates the room in the relay's memory (`packages/collab-web/scripts/local-relay.ts:70`).
  - If a host is already connected for that `roomId`, the second host socket MUST be immediately closed with code `4009` and reason `"a host is already connected for this room"` (`packages/collab-web/scripts/local-relay.ts:66-68`, `packages/coding-agent/src/collab/relay-client.ts:21`).
- **Guest connection**:
  - If the room does not exist (host has not connected or has terminated), guest socket MUST be closed with code `4004` and reason `"no such room"` (`packages/collab-web/scripts/local-relay.ts:74-76`, `packages/coding-agent/src/collab/relay-client.ts:20`).
  - If room is full (exceeds relay capacity limit), close code `4029` (`"room is full"`) (`packages/coding-agent/src/collab/relay-client.ts:22`).
  - On admission, the relay assigns a numeric `peerId` (uint32 > 0, monotonically incremented from 1) (`packages/collab-web/scripts/local-relay.ts:78-79`).

### 4-Byte Routing Prefix & Frame Forwarding
Binary frames travel in a 4-byte envelope (`packages/coding-agent/src/collab/protocol.ts:152-173`, `packages/collab-web/src/lib/link.ts:54-74`):
`[4B uint32 BE peerId][sealed AES-GCM payload]`

- **Host -> Relay (Binary)**:
  - Envelope peerId is read as a 32-bit big-endian unsigned integer.
  - If `peerId === 0`: Relay broadcasts the complete frame unmodified to all connected guests (`packages/collab-web/scripts/local-relay.ts:90-91`).
  - If `peerId !== 0`: Relay unicasts the frame unmodified to the specific guest whose assigned ID is `peerId` (`packages/collab-web/scripts/local-relay.ts:92-94`).
- **Guest -> Relay (Binary)**:
  - Envelope arrives with a 4-byte prefix (conventionally 0) followed by sealed payload (`packages/collab-web/scripts/local-relay.ts:97-99`).
  - Relay checks `byteLength >= 4`.
  - Relay MUST rewrite the first 4 bytes with the guest's assigned `peerId` in big-endian order (`packages/collab-web/scripts/local-relay.ts:98`, `packages/coding-agent/src/collab/protocol.ts:170-173`).
  - Relay forwards the rewritten frame directly to the host (`packages/collab-web/scripts/local-relay.ts:99`).
- **What relay MUST NOT alter**:
  - The relay MUST NEVER touch, parse, or re-encode the bytes following the first 4 bytes. Those bytes contain AES-256-GCM ciphertext + 12-byte IV + 16-byte auth tag (`packages/collab-web/src/lib/codec.ts:29-37`). Altering even a single bit corrupts decryption and aborts the connection (`packages/coding-agent/src/collab/relay-client.ts:648-656`).
  - The relay MUST NOT re-order frames between the same sender/receiver pair.

### Relay-Generated TEXT Control Messages
Clients never send TEXT frames (they are dropped if received: `packages/collab-web/scripts/local-relay.ts:84`). The relay generates TEXT JSON frames for topology changes:
- **To Host**:
  - On guest join: `{"t":"peer-joined","peer":peerId}` (`packages/collab-web/scripts/local-relay.ts:81`, `packages/coding-agent/src/collab/protocol.ts:37-40`).
  - On guest disconnect: `{"t":"peer-left","peer":peerId}` (`packages/collab-web/scripts/local-relay.ts:118`, `packages/coding-agent/src/collab/relay-client.ts:675-680`).
- **To Guests**:
  - On host disconnect: Relay broadcasts `{"t":"room-closed"}` as TEXT, then closes each guest with code `4001` and reason `"room closed"` (`packages/collab-web/scripts/local-relay.ts:109-113`, `packages/coding-agent/src/collab/relay-client.ts:19`).

### Liveness and Heartbeats
- **Ping/Pong**: OMP host socket sends ping frames every 15,000 ms (`RELAY_PING_INTERVAL_MS = 15_000`) and disconnects if silent for 40,000 ms (`RELAY_SILENCE_LIMIT_MS = 40_000`) (`packages/coding-agent/src/collab/relay-client.ts:57-59`). The relay must handle standard WebSocket ping frames and reply with pongs.
- **HTTP Health Probe**: The production relay contract exposes `GET /healthz` returning 200 OK (`/tmp/caw-research/collab.md:179`).

---

## 3. Analysis of `packages/collab-web/scripts/local-relay.ts`

### What It Implements (Verified in Source)
1. Runs a single `Bun.serve` instance with WebSocket capabilities (`lines 49-122`).
2. Implements `GET /r/<roomId>?role=host|guest` matching `ROOM_PATH_RE` (`lines 51-61`).
3. Rejects duplicate host with close code `4009` (`lines 66-68`).
4. Rejects guest joining nonexistent room with close code `4004` (`lines 74-76`).
5. Tracks guests in an in-memory `Map<number, RelaySocket>` with auto-incrementing `peerId` starting at 1 (`lines 70, 78-80`).
6. Sends `{"t":"peer-joined","peer":peerId}` to host when guest joins (`line 81`).
7. Forwards host binary messages (0 = broadcast, N = targeted) (`lines 88-95`).
8. Rewrites first 4 bytes of guest binary messages to `peerId` and forwards to host (`lines 97-99`).
9. On guest close, sends `{"t":"peer-left","peer":peerId}` to host (`lines 117-119`).
10. On host close, sends `{"t":"room-closed"}` and closes guests with `4001` (`lines 108-114`).
11. Clean shutdown on SIGINT/SIGTERM with code `1001` (`lines 126-137, 167-168`).

### What It Omits vs. Production Contract
1. **Static client serving**: Omits `GET /` and static asset hosting. Running `local-relay.ts` alone cannot serve the web client to a browser.
2. **Health check**: Omits `GET /healthz`.
3. **Share blob store**: Omits `POST /s`, `GET /s/<id>`, `GET /s/<id>/raw` (`collab.md:178`).
4. **Room capacity enforcement**: Omits close code `4029` ("room is full"); accepts unbounded guests until process OOM.
5. **Host drop resilience & reclaim window**:
   - In `relay-client.ts:28-50`, OMP host clients have a 150-second reclaim window (`HOST_RECLAIM_WINDOW_MS = 150_000`) because transient network drops (Wi-Fi reconnection, sleep) happen frequently.
   - `local-relay.ts` destroys the room and closes all guests immediately upon socket TCP drop (`lines 108-114`).
6. **TLS / HTTPS**: Operates purely over cleartext HTTP/WS (`Bun.serve` default).
7. **Backpressure management**: Omits buffering bounds on `guest.send()` / `host.send()`.

---

## 4. Build Story for `packages/collab-web`

### Toolchain Requirements
- **Upstream dependency**: `package.json` specifies `"engines": { "bun": ">=1.3.14" }`.
- **Upstream build command**:
  ```bash
  rm -rf dist && bun build ./index.html --outdir=dist --minify --define process.env.NODE_ENV='"production"' --entry-naming=[hash].[ext] --chunk-naming=[hash].[ext] --asset-naming=[hash].[ext] && mv dist/*.html dist/index.html && cp -R public/. dist/
  ```
- **Local environment check**: `bun` is NOT installed on the host Ubuntu workstation (`node` v20.19.5, `npm` 10.8.2, and `pnpm` 10.32.1 are present).

### Building Static `dist/` Without Bun
Can `packages/collab-web` build with standard Node / Vite / pnpm?
**Yes.**
1. **Source analysis**:
   - `src/` is standard React 19 + TypeScript (`.tsx`, `.ts`).
   - Monorepo dependency `@oh-my-pi/pi-utils` is declared in `package.json` but is **never imported** anywhere in `src/`.
   - Monorepo dependency `@oh-my-pi/pi-wire` is imported only for TypeScript types (`GuestFrame`, `HostFrame`, etc.) and six constants defined in `packages/wire/src/index.ts`:
     ```ts
     export const COLLAB_PROTO = 3;
     export const ENVELOPE_HEADER_LENGTH = 4;
     export const ROOM_ID_BYTES = 16;
     export const ROOM_KEY_BYTES = 32;
     export const WRITE_TOKEN_BYTES = 16;
     export const DEFAULT_RELAY_URL = "wss://my.omp.sh";
     ```
2. **Node/Vite build approach**:
   - Add a standard `vite.config.ts`:
     ```ts
     import { defineConfig } from "vite";
     import react from "@vitejs/plugin-react";
     export default defineConfig({
       plugins: [react()],
       resolve: {
         alias: {
           "@oh-my-pi/pi-wire": "/path/to/packages/wire/src/index.ts",
         },
       },
     });
     ```
   - Running `npx vite build` or `pnpm exec vite build` compiles `index.html` to `dist/` cleanly using standard Node.js without needing Bun.

### WebCrypto & HTTPS Constraints
- **Constraint**: `packages/collab-web/src/lib/codec.ts:22-48` relies directly on the browser's `crypto.subtle` API (`crypto.subtle.importKey`, `encrypt`, `decrypt`).
- **Secure Context rule**: Modern browsers (iOS WebKit / Safari, Chrome, Firefox) strictly restrict `crypto.subtle` to **Secure Contexts** (`window.isSecureContext === true`).
- **Consequence for Mobile / iPhone**:
  - `http://localhost` and `http://127.0.0.1` are treated as secure contexts by browsers.
  - When accessing the web client from an iPhone over a LAN IP or internal hostname (e.g., `http://192.168.1.50:7466` or `http://laptop.local:7466`), `window.crypto.subtle` is **`undefined`**. The client throws an uncaught TypeError on key import and fails completely.
  - **Self-hosting requirement**: To control OMP from an iPhone via mobile web, the static client and relay MUST be served over **HTTPS/WSS** with a valid/trusted TLS certificate (e.g. Tailscale HTTPS, Cloudflare Tunnel, or a local CA installed on iOS via profile).

### Fragment Parsing, CSP, and Referrer Risks
- **Fragment resolution**:
  - `app.tsx:32-37` extracts the fragment: `window.location.href.slice(i + 1)`.
  - `link.ts:145-190` parses the fragment:
    - If format is bare `<roomId>.<key>`, it falls back to `DEFAULT_RELAY_URL` (`wss://my.omp.sh`).
    - If format is `host[:port]/r/<roomId>.<key>`, it normalizes to `wss://host[:port]/r/<roomId>`.
    - If scheme is `ws://` and hostname is not in `LOCAL_HOSTNAMES` (`localhost`, `127.0.0.1`, `::1`), `link.ts:107-109` throws an error: `"relay link must be wss:// (plain ws:// is only allowed for localhost)"`.
- **Third-Party Script Leak Risk**:
  - `index.html:77` contains an external analytics script:
    ```html
    <script defer src="https://um.can.ac/script.js" data-website-id="28ab5a7d-3ca4-4c85-9da5-666fa731cb92" data-exclude-hash="true"></script>
    ```
  - While `data-exclude-hash="true"` instructs Umami not to log the fragment, any third-party script executing inside the guest client context has full programmatic access to `window.location.hash` (the AES decryption key + write token) and `localStorage`.
  - **Remediation**: For private self-hosting, strip this script from `index.html`.
- **CSP & Referrer Headers**:
  - Upstream `index.html` has no CSP meta tag.
  - Recommendations:
    - Header: `Referrer-Policy: no-referrer`
    - Header: `Content-Security-Policy: default-src 'self'; connect-src 'self' wss: ws://localhost:* ws://127.0.0.1:*; style-src 'self' 'unsafe-inline'; font-src 'self' data:; img-src 'self' data: blob:;`

---

## 5. Minimum Work to Ship a Private Self-Hosted Relay

### Architecture
To serve both the static web client at `/` and the relay WebSocket at `/r/<roomId>?role=host|guest`:
1. Use a lightweight Node.js server (using `node:http` + `ws` package) or Caddy/Nginx reverse proxying to a standalone WebSocket daemon.
2. In HTTP request handler:
   - If `req.url === "/healthz"`: return `200 OK`.
   - If `req.url` matches static file in `dist/`: stream file with appropriate MIME type.
   - For all non-asset GET requests: return `dist/index.html` (SPA fallback).
3. In WebSocket upgrade handler:
   - Handle upgrade on `/r/<roomId>?role=host|guest`.
   - Execute the 4-byte envelope routing, duplicate host prevention (4009), missing room rejection (4004), and peer joined/left notifications.
   - Add a 30-second reclaim grace period when host drops before destroying the room.

### OMP Configuration for Custom Relay
- **Accepts custom `collab.relayUrl`**:
  - **Yes.** Verified via command line:
    ```bash
    $ omp config get collab.relayUrl
    wss://my.omp.sh
    $ omp config list | grep collab
      collab.relayUrl = wss://my.omp.sh (string)
      collab.webUrl =  (string)
      collab.displayName =  (string)
      collab.autoStart = off (off|view|control)
    ```
  - Declared in `packages/coding-agent/src/collab/settings.ts:9-19`.
  - Can also be set per command: `/collab <relay-url>` (`packages/coding-agent/src/collab/controller.ts:207-216`).

- **Accepted Schemes & Localhost ws:// Restriction**:
  - Source: `packages/coding-agent/src/collab/protocol.ts:195-220`:
    ```ts
    switch (url.protocol) {
      case "wss:":
      case "https:":
        scheme = "wss:";
        break;
      case "ws:":
      case "http:":
        scheme = "ws:";
        break;
      default:
        return { error: `Unsupported relay URL scheme: ${url.protocol}` };
    }
    if (scheme === "ws:" && !isLocalHostname(url.hostname)) {
      return { error: "relay link must be wss:// (plain ws:// is only allowed for localhost)" };
    }
    ```
  - `LOCAL_HOSTNAMES` is strictly `{ localhost: true, "127.0.0.1": true, "::1": true, "[::1]": true }`.
  - Plain `ws://` is **strictly rejected** by OMP for any non-localhost host (such as `ws://192.168.1.50:7466` or `ws://relay.lan`). Non-localhost endpoints MUST use `wss://` (or `https://`).

- **TLS Certificate Validation & Pinning**:
  - Source: `packages/coding-agent/src/collab/relay-client.ts:506-510`:
    ```ts
    const url = `${this.#opts.wsUrl}?role=${this.#opts.role}`;
    const options = {
      proxy: getProxyForUrl("collab", new URL(url)),
    } satisfies Bun.WebSocketOptions;
    const ws: WebSocket = Reflect.construct(WebSocket, [url, options]);
    ```
  - **Certificate pinning**: None. There is no certificate pinning or custom CA fingerprint verification.
  - **TLS validation**: Uses standard runtime TLS verification against the OS system trust store. There is no option like `rejectUnauthorized: false`. Self-signed certificates will fail unless the custom CA certificate is added to the host's system trust store or passed via Node/Bun environment variables.

---

## 6. Security Considerations & Data Exposure

### Threat Model & Bearer Credentials
The collab URL fragment is a high-privilege bearer credential:
- **View Link**: Contains a 32-byte AES-256-GCM secret key. Anyone with this key can decrypt the entire conversation transcript and live streaming updates.
- **Control Link**: Contains the 32-byte key PLUS a 16-byte write token (48 bytes total). Anyone with this token can send prompt turns to the agent, interrupt execution, and execute subagent control commands.

### What a Private Relay Can and Cannot Learn
- **What the Relay CANNOT Learn**:
  - The relay **never learns the room key or write token**: RFC 3986 URL fragments (`#...`) are processed purely on the browser client and are never sent over HTTP/WebSocket requests.
  - The relay **never learns plaintext session data**: All frames (user prompts, tool execution inputs/outputs, model completions, file contents, environment paths) are sealed using AES-256-GCM before transmission.
- **What the Relay CAN Learn**:
  - Room IDs (passed in plaintext URL path `/r/<roomId>`).
  - IP addresses and connection timestamps of host and guests.
  - Number of concurrent participants in a room.
  - Message sizing, volume, and transmission timing patterns.
  - Which guest peer ID is receiving which frame (from the 4-byte plaintext prefix).

---

## 7. UNVERIFIED List

1. **Production Go Relay Disconnect Grace Period**: The exact server-side drop timer in upstream's unpublished Go relay (`wss://my.omp.sh`) is unverified from source code since the Go source is closed. OMP host clients assume up to a 150-second reclaim window (`HOST_RECLAIM_WINDOW_MS = 150_000`), but `local-relay.ts` omits this entirely.
2. **Mobile Safari Virtual Viewport Edge Cases**: While `packages/collab-web/src/app.tsx:80-98` registers a `visualViewport` resize listener to handle the iOS software keyboard, long assistant turns with rapid streaming markdown rendering on older iOS WebKit versions may experience layout jumping.
3. **Standalone Build Asset Paths**: Whether `@tailwindcss/vite` or KaTeX font asset paths require explicit `publicPath` overrides when hosted on subpaths (e.g. `https://host/caw/` vs root `https://host/`).
