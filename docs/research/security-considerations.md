# Security considerations — Coding Agent Web (M4 threat model input)

Scope: the Node/TypeScript server on the owner's Ubuntu laptop that (a) brokers Collab room links,
(b) launches/supervises OMP agents inside tmux, (c) exposes a folder browser over an allowed-roots
allowlist, (d) is reached from an iPhone over Tailscale.

Every claim below is either cited `file:line` under `/tmp/caw-poc/oh-my-pi` (upstream tarball), an
exact command + observed output, or a fetched URL. Anything else is marked `INFERENCE` or listed in
§7 UNVERIFIED. **No real room link, room key, write token, cookie value, or API key appears in this
document.**

Legend: `[U]` = upstream source, `[T]` = Tailscale KB/docs, `[W]` = Web platform reference,
`[S]` = local shell observation.

---

## 1. Asset inventory

What an attacker gains per compromise. "OMP runs bash as the user" is the multiplier on all rows:
upstream's `bash` tool executes a shell command line in the session working directory with no OS
sandbox — the only friction is the approval tier (`always-ask` / `write` / `yolo`,
`packages/coding-agent/src/cli/flag-tables`-documented flags `--approval-mode` and `--yolo` in
`/tmp/caw-research/cli-reference.md:145-146`). There is no seccomp/bubblewrap/firejail usage in
`packages/coding-agent/src` (`grep -rn "sandbox|seccomp|bwrap|firejail" src --include=*.ts` returns
only unrelated ReDoS-keyword hits such as `src/tools/read.ts:1181` and `src/tools/write.ts:802`).

| Asset | How obtained | What the attacker gets |
| --- | --- | --- |
| **Collab room link (full / control)** | Phishing, shoulder-surf, Referer/log leak, browser history, screen recording, paste into wrong chat | 32-byte AES-256-GCM room key + 16-byte write token. Reads the entire session (back-transcript, streaming text, tool cards, subagent transcripts) **and** steers it: prompt, interrupt, answer host `select`/`editor` requests, agent-hub chat/kill/revive. The write token is checked by the host at join and every write path is reachable (`packages/coding-agent/src/collab/host.ts:763-766` timing-safe compare; read-only rejection at `:946`, `:998`, `:1050`, `:1169`). The LLM sees guest prompt text verbatim (`/tmp/caw-research/collab.md`, guest permission model). |
| ↑ *compounded by prompt injection* | link holder prompts the host agent | The agent holds **full user privileges on the laptop**. A prompt of the form "read `~/.ssh/id_*` and print it" produces those bytes in the streamed transcript, back to the attacker. This is the top risk of the product, and the reason a control link is equivalent to an SSH session in practice. |
| ↑ *while the host is attached in tmux* | — | The owner is watching a live `tmux attach` pane while the attacker drives the same session; nothing in the protocol distinguishes owner keystrokes from guest traffic, so an attack can be assembled from legitimate-looking agent activity. |
| **Session cookie** | XSS, CSRF, stolen phone, shared Safari profile | Becomes the bearer credential for our HTTP API: room-link retrieval (→ control link → all of the above), agent spawn/kill, folder browsing, and (if the API offers it) file reads. Must be treated as equivalent to the room link, because one endpoint converts it into one. |
| **Tailnet device (phone/laptop of the owner, or any device an ACL admits)** | Device theft, unlock bypass, malware, over-broad ACL | Network reachability to our listener, plus the `Tailscale-User-*` identity headers Serve injects `[T]` (see §3). By itself it must NOT be sufficient: our auth must still require the session cookie. Reachability without auth is only dangerous if an endpoint is unauthenticated — hence §2b/§2c. |
| **Local filesystem read (same-uid or root on the laptop)** | Any other local user/process that can read the owner's files; backup/sync clients; a compromised editor | `~/.omp/**` (session JSONL transcripts, settings, secret placeholder key path at `packages/utils/src/dirs.ts:1104-1107`), the collab registry directory contents, editor/SSH keys, browser profiles. The upstream collab registry is explicitly owner-only: created/tightened to `0o700`, foreign-owned or symlinked directories rejected, metadata files opened `0o600` (`packages/coding-agent/src/collab/registry.ts:365`, `:370-376`, `:383-385`, `:461`), and it stores **no** link/key/token (`registry.ts:15-19`). Our server must meet or exceed that bar. |
| **SSH access to the laptop** | key theft from the above, weak password, exposed sshd | Full control: write files, read our in-memory-only link by attaching to the process, install a persistent backdoor. Any "in-memory only" claim is only as strong as the host: state that explicitly instead of pretending it defeats host compromise. |
| **Compromised upstream OMP or relay** | supply chain | The relay is content-blind by construction — it sees room ids, connection counts, opaque ciphertext, and a 4-byte peerId routing prefix (`packages/coding-agent/src/collab/protocol.ts:1-8`, `:155-175`; `/tmp/caw-research/collab.md` "End-to-end encryption"). A *malicious OMP build* is game over regardless of our layer, same as any local binary. |

---

## 2. Surfaces, failure modes, and controls

### (a) HTTP auth + session cookies on iOS PWA

Failure mode: the listener is reachable from the whole tailnet (and any shared device/user an ACL
admits), and the app is an installable PWA (`display: standalone` is what we will ship), so "it's
only my phone" is not an auth model. Additional iOS-specific trap: after "Add to Home Screen", the
web app has **separate cookies and storage from the browser** `[W]`
(https://developer.apple.com/videos/play/wwdc2023/10120/, transcript: "Home Screen web apps have a
standalone, app-like experience on iOS, with separate cookies and storage from the browser"), and on
macOS Safari copies cookies at install time while localStorage is not copied. Consequences:
signing in through a Safari tab does **not** sign you into the installed PWA; a login flow that
special-cases "in-app browser" will strand users; and session cookies must be server-side
state, not `document.cookie`.

Controls:
- Single-user allowlist. Login = a long random device secret/token compared with
  `crypto.timingSafeEqual` on equal-length buffers (same primitive upstream uses for the write token,
  `packages/coding-agent/src/collab/host.ts:12`, `:763-766`). No username/password to brute force.
- Server-side session records: `{ id: 32B random (base64url), issuedAt, deviceLabel, csrf }` in a
  `Map` (or an owner-only file). Cookie carries only the opaque id.
- Cookie flags, final answer:
  `Set-Cookie: __Host-omp_sess=<id>; Secure; HttpOnly; SameSite=Lax; Path=/; Max-Age=2592000`
  - `Secure` + `HttpOnly` + `Path=/` + **no `Domain`** are the `__Host-` prefix requirements
    `[W]` (https://developer.mozilla.org/en-US/docs/Web/HTTP/Reference/Headers/Set-Cookie, cookie
    prefixes section).
  - `SameSite=Lax` not `Strict`, because an installed iOS PWA is a separate storage container and
    `Strict` breaks the "tap a link from Notes/Messages → land logged in" entry path. This choice is
    only safe **because** every state-changing route is `POST` with an explicit CSRF check (§2c) and
    cross-site subresource/`fetch` requests do not carry `Lax` cookies at all (`[W]`, SameSite=Lax
    semantics: excluded for `fetch()`, `<img>`, `<script>`, and iframed navigations).
  - **NEVER** `SameSite=None`. No cross-site embed exists in this product.
  - Do not use `Partitioned` (CHIPS), it exists for third-party embeds `[W]`.
- Server-enforced absolute + idle lifetimes (e.g. 30 d absolute, 12 h idle) and immediate session
  invalidation on logout/device-revoke; re-validate on every WebSocket upgrade.
- Do not rely on client IP for anything: behind `tailscale serve` the backend sees loopback (`[T]`,
  §3).
- **Infeasible-on-iOS note:** Safari caps *persistent client-side* cookies (`document.cookie`) at 7
  days and deletes all script-writable storage (IndexedDB, LocalStorage, SessionStorage, service
  worker registrations/caches) after 7 days without user interaction `[W]`
  (https://webkit.org/blog/10218/full-third-party-cookie-blocking-and-more/; also
  https://webkit.org/blog/8613/intelligent-tracking-prevention-2-1/: "Cookies available in
  document.cookie can be stolen by cross-site scripting attacks"). HTTP-set `HttpOnly` cookies are
  **not** affected `[W]`. So: never keep session state in localStorage; a long-lived login on iOS is
  only achievable via the `HttpOnly` cookie and only as long as the user keeps using the app.

### (b) WebSocket upgrade authentication and Origin validation

Failure mode: Cross-Site WebSocket Hijacking. Browsers attach cookies to WebSocket handshakes, and
`Origin` is attacker-controlled only in the sense that a malicious page cannot forge it —
so a server that skips the check accepts connections from any page the phone visits
(`[S]` https://cheatsheetseries.owasp.org/cheatsheets/WebSocket_Security_Cheat_Sheet.html:
"Validate the Origin header on every handshake. Always use an explicit allowlist of trusted
origins… Use an allowlist, not a denylist."; CWE-1385).

Controls, all three required:
1. **Authentication before payload.** Upstream's own local relay stand-in is a warning, not a
   model: `packages/collab-web/scripts/local-relay.ts:46-61` upgrades on path + `?role=` alone and
   performs no Origin/auth check. Our WS endpoint must require a valid session cookie **and**
   per-link identity presented in the first frame; until that frame validates, send nothing and
   accept only that frame (OWASP: "Until token validation succeeds, accept only the authentication
   message and do not send protected data").
2. **Origin allowlist** of exact origins: `https://<device>.<tailnet>.ts.net` plus the explicit dev
   loopback origin. Reject absent/other origins. Also require `Sec-Fetch-Site: same-origin` when
   present (OWASP recommends `Sec-Fetch-Site` as the primary CSRF signal with an Origin fallback).
3. **Identity binding.** A cookie issued *after* link possession must not be able to attach to that
   link; store `issuedAt` on the link record and reject a socket whose session `issuedAt` precedes it.
   This is the specific control against "CSRF obtained a session cookie, then rode the JSON lease".

Plus upgrade hygiene: reject non-`GET`, non-`Upgrade` requests; per-connection inbound frame cap
(≤64 KiB, OWASP's recommended order), `permessage-deflate` disabled (CRIME/BREACH class,
OWASP WebSocket cheat sheet), 4 concurrent sockets per session / 32 total, idle timeout, and re-check
the session every 30 min, closing with 1008 on expiry.

### (c) CSRF for state-changing routes

Failure mode: every route we own is state-changing or secret-bearing — retrieve link, spawn/kill
agent, list/read folders. With a `Lax` cookie, a cross-site `POST` from a form is the classic
vector; OWASP notes that top-frame navigations still need explicit protection even when third-party
cookies are blocked `[S]` (CSRF cheat sheet, "Additional Benefits" / SameSite sections).

Controls:
- No `GET` performs any state change, ever (OWASP: "Do not use GET requests for state changing
  operations").
- Require **both** a synchronous check and a token:
  1. Reject non-safe methods whose `Origin` is not the allowlist, and require
     `Sec-Fetch-Site ∈ {same-origin}` when the header is present. This alone blocks the naive
     form-POST vector.
  2. Per-session CSRF token (32B random, server-side, *not* in a cookie) delivered in the JSON
     bootstrap response and required in an `X-CSRF-Token` header. OWASP explicitly recommends the
     custom-header variant for token-less APIs *and* tokens as defense in depth; a custom header also
     guarantees the request was preflighted.
  3. Reject simple content types: require `Content-Type: application/json` on JSON routes (OWASP
     "Disallowing simple content types").
- No CORS: never emit `Access-Control-Allow-Origin`, so no cross-origin preflight can ever succeed.

### (d) Folder browser

Failure mode: the browsing endpoint is an arbitrary-file-read primitive expressed as a *path
string*. Four distinct bugs:

1. **Traversal / canonicalization.** `..`, `%2e%2e`, double-encoding, absolute paths, `~` expansion,
   `//`, and Windows-style separators all reach `open()` if the check is string-based.
2. **Symlinks.** A path fully inside the root can still be a symlink to `/etc` or to
   `~/.ssh/id_ed25519`. Upstream already treats this as an attack: the collab registry refuses a
   symlinked registry directory (`packages/coding-agent/src/collab/registry.ts:365`, message
   `collab registry directory is a symlink: …`).
3. **TOCTOU.** Verify-then-open is a race: the agent itself is running concurrently and can replace a
   component with a symlink between the check and the `open()`. This is not theoretical here — the
   very process we supervise executes shell commands.
4. **Unicode / whitespace in names.** `pay\u0301pal` (NFD) vs `pay\u00e1l` (NFC) compare unequal
   with `===` and have different `length` `[W]`
   (https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/String/normalize);
   zero-width/BiDi characters and trailing spaces/tabs/dots produce different displayed names for
   different byte strings. Consequence: allowlist checks that compare raw strings can be bypassed
   *and* the owner can be shown a directory entry that is not the one they think they are opening.

Controls (implement as one module, used by every endpoint — no second path convention):
- Parse once into a `URL`-decoded, NUL-rejected, NFC-normalized array of segments; reject any segment
  `""`, `"."`, `".."`, containing `/` or `\`, or starting with a control character. Reject paths with
  a literal NUL (`\0` truncation) and reject `\u2215`/`\u2044` as separator look-alikes at render
  time, not at open time.
- Resolve with `fs.promises.realpath` (Node: "Determines the actual location of `path` using the same
  semantics as `fs.realpath.native()`" `[W]` https://nodejs.org/api/fs.html — realpath/`O_NOFOLLOW`
  flag table under `File system`) and compare against the **realpath'd** allowlist root with a
  separator-aware prefix test (upstream dependency-free pattern: `meta.endpoint.startsWith(dir +
  path.sep) || meta.endpoint === …`, `registry.ts:590`).
- Re-canonicalize on every request; never cache a "trusted" path string across requests.
- **Open, don't check-then-open:** open with `fs.promises.open(p, fs.constants.O_RDONLY |
  O_NOFOLLOW)` — "Flag indicating that the open should fail if the path is a symbolic link"
  (`[W]`, same Node page) — then `fstat` the **handle** and verify `dev`+`ino` are still inside the
  allowlist root before reading. This closes the symlink swap (c).
- Response metadata (name, size, mtime, inode) always comes from the `fstat` of the opened handle,
  never from a separate `lstat` call.
- Never serve file contents with a MIME type derived from content sniffing: `Content-Type:
  application/octet-stream` + `Content-Disposition: attachment` + `X-Content-Type-Options: nosniff`
  for anything not on a small allowlist (images/text), so browsing cannot become stored XSS.

### (e) Shell / argument construction for tmux and omp

Failure mode: identifier interpolation into a shell string. `tmux -c`, `new-session`, `new-window`,
`if-shell`, and `split-window` treat their command argument as an `sh(1)` command line `[S]`
(observed: `zcat /usr/share/man/man1/tmux.1.gz | grep -n -A6 shell-command` →
`.Ar shell-command arguments are .Xr sh 1 commands.`; the man page then shows the alternative:
`new-window vi ~/.tmux.conf` uses "multiple arguments and executed directly (without `sh -c`). This
can avoid issues with shell quoting."). Session/target names we derive from user input are not
commands, but they are interpolated into command-*bearing* arguments all over tmux's CLI, and
`send-keys` takes "the name of the key" arguments (`man tmux`, `send-keys` section) — a client-supplied
string there is keystroke injection into a shell the agent already owns.

Controls:
- **Every** process invocation uses array argv with no shell: Node
  `child_process.spawn(file, args, { shell: false })` (the default) / `Bun.spawn([cmd, ...args])`.
  Upstream sets the example we follow everywhere: `packages/coding-agent/src/utils/open.ts:90`
  (`Bun.spawn(cmd, …)`), `src/tools/browser/registry.ts:347` (`Bun.spawn([exe, ...launchArgs], …)`),
  `src/utils/video.ts:310` (`Bun.spawn([ffmpeg, "-hide_banner", "-loglevel", "error", "-y", …args])`).
  The single upstream place that does go through a shell uses a **fixed** script
  (`src/utils/shell-snapshot.ts:350`, `Bun.spawn([shell, "-c", script])`) — acceptable because the
  string is a constant, never client data.
- tmux is invoked as `tmux [-L <socket>] <subcommand> …` with each argument a separate argv element;
  for commands that create windows/panes we pass the upstream-style **multiple-argument** form
  (executed directly, no `sh -c`), not a joined string.
- **Explicit target identity.** Never address an agent by session name, cwd, or PID alone. Create with
  `tmux new-session -d -s <sessionName> -P -F '#{session_id}'` and persist the returned `$N` session
  id; address it afterwards with `-t $N`. `send-keys` is addressed to `-t <sessionId>` and its
  payload comes from a strict validator (printable text + an explicit newline flag), never an
  arbitrary string assembled by the client.
- Reaping uses `tmux kill-session -t $N` on the exact id. **NEVER** `pkill -f`, never a name glob.
  (This is the difference between stopping one agent and killing the owner's session — see §5.1.)
- The OMP launch line is built from a fixed argv template plus validated values, not a string:
  `omp --cwd <allowedRoot> <flags…>` (`--cwd <dir>` exists: `/tmp/caw-research/cli-reference.md:73`;
  `--add-dir` at `:74` stays empty unless the owner adds a root). Validate `<allowedRoot>` with the
  same canonicalizer as §2d before it is ever passed.
- Never accept a model name, relay URL, or extension path from the phone as a raw string; validate
  against a fixed enumeration (`--model`/`--provider`/`--extension` are all argv flags that reach a
  spawned process, `/tmp/caw-research/cli-reference.md:104`, `:110`, `:154`).

### (f) Room-link leak paths

The room link is the product's crown jewel; it must be treated as a credential in every path.
Citations for the pure web leaks: `Referer` "may not contain URL fragments" and is governed by the
referrer policy `[W]` (https://developer.mozilla.org/en-US/docs/Web/HTTP/Reference/Headers/Referer).

| Leak path | Concrete failure | Control |
| --- | --- | --- |
| **Referer** | Only if the link is ever put in path/query. The fragment is not sent `[W]`, and upstream deliberately keeps it in the fragment: "the fragment always carries the relay-specific collab link, so room secrets stay out of HTTP path and query bytes" (`packages/coding-agent/src/collab/protocol.ts:278-287`). | Link never appears in a URL we control: the phone fetches it via authenticated `POST` and keeps it in memory. Send `Referrer-Policy: no-referrer` site-wide as belt-and-braces; agent-rendered external links get `rel="noreferrer"` in our UI (upstream uses `target="_blank" rel="noopener"`, `packages/collab-web/src/components/transcript/Markdown.tsx:74`, which is **not** enough — add `noreferrer`). |
| **Logs** | Our HTTP access log records `req.url`; if the link ever rode a query string, every log line is a credential. Tailscale Serve also logs the request path `[T]`. | Log the route pattern, never the URL; allowlist of loggable fields; run every log line through a redactor that matches the link grammar (`[A-Za-z0-9_-]{10,64}` + `.` + base64url, exactly the shapes in `protocol.ts:179-181`, `:294-338`) and replaces it with `<COLLAB_LINK>`; a unit test asserts a sample link never survives the redactor. |
| **Crash reports / error messages** | `return { error: \`Invalid collab link: ${link}\` }` is upstream's own pattern (`protocol.ts:307`) — fine in a TUI, unacceptable in our HTTP responses and stack traces, which get logged and may be shown in the iPhone UI. | Never echo the submitted credential; error strings are fixed codes (`invalid_link`, `link_expired`). If an upstream error carries a secret, redact before logging (§2g) and never return upstream messages verbatim. |
| **Push notifications** | A push payload is relayed through APNs and rendered on the lock screen; it is also retained by the OS/app and handled by a service worker. Web Push on iOS requires an installed Home Screen web app and the payload is delivered to the service worker `[W]` (https://webkit.org/blog/13878/web-push-for-web-apps-on-ios-and-ipados/). | Push payload contains only e.g. `{"type":"agent_idle","instance":"<uuid>"}`; a test asserts no payload contains a room id, key, or token. Push is a *notification*, never a link-delivery channel. |
| **Browser history** | Upstream writes the link into the hash: `window.location.hash = link` (`packages/collab-web/src/app.tsx:59`). That puts a credential in the URL and thus in the back/forward list; iOS restores the back-forward list across app relaunches `INFERENCE`. | Our UI never puts the link in the URL. Paste field → in-memory state only. Where a deep link is genuinely required (QR handoff), use a one-time, short-TTL, server-scored token in the fragment and consume it on first use. |
| **URL fragments** | Fragments are not sent to the server `[W]`, but they *are* readable by any script on the page, survive "share URL" actions, are visible in screenshots, and can be captured by analytics that mishandle them. Upstream's own index.html needs a special opt-out for exactly that: `<script … src="https://um.can.ac/script.js" … data-exclude-hash="true">` with the comment "keeps the E2E room key (URL fragment) out of analytics" (`packages/collab-web/index.html:76-77`). | Ship **no** third-party script, font, or analytics in our UI (CSP `script-src 'self'`), and never construct a URL containing the link. |
| **Clipboard / share sheet** | "Copy link" puts it in the system clipboard, which iOS shares across apps and may sync `INFERENCE`. | If we offer copy, show a warning; also offer a view-only link (`omp collab link <id> --view`, `/tmp/caw-research/collab.md` Commands) generated on demand, never stored. |
| **Screen** | Notifications, app switcher snapshots. | Mark the link display as sensitive so screenshots/recordings are the owner's own risk; do not render the link at all unless the owner taps "reveal". |

### (g) Log redaction rules

Failure modes: (1) relaying upstream `logger` output through our process; (2) writing our own access
log with the raw URL; (3) exception objects that embed a link (upstream throws
`Invalid collab link: ${link}`, `protocol.ts:301`); (4) printing the link for QR/CLI handoff into a
file or a shell history.

Rules:
1. One `redact(text)` chokepoint; every log write, HTTP access-log line, error response, and crash
   reporter call goes through it. It redacts: the collab-link grammar (roomId + 24- or 64-char
   base64url secret), `Authorization`/`Cookie`/`Set-Cookie` values, anything matching the upstream
   registry bearer token shape (32 random bytes hex, `registry.ts:431`), and `tskey-*`.
2. Structured logging with an explicit field allowlist; never `console.log(obj)` on a request/response
   object. Upstream logs metadata only and never a link on the link path (`registry.ts:15-19`,
   `:735`), which is the bar we hold.
3. Room-id-free by default: log `instanceId` (random per process, `registry.ts` header comment) and
   `generation`, never `roomId`. A `roomId` is a low-entropy handle (`ROOM_ID_BYTES`) whose
   disclosure narrows a brute-force search of the secret.
4. Access log records `method`, route pattern, status, duration, `Sec-Fetch-Site`, and a hashed
   session id — no query, no fragment.
5. Strip ANSI/OSC from anything logged from agent output before it hits the log file too (same
   primitive the client uses, `packages/collab-web/src/tool-render/util.ts:84-87`), so log-reading
   tools cannot be tricked by control sequences.
6. A test greps the log file after a full session (login → link fetch → prompt → logout) and asserts
   zero matches for the link grammar and for the session cookie value.

### (h) Rate limiting + body size limits

Failure modes: (1) the secret is short-ish and machine-guessable if the relay ever answers without
auth (roomId is `ROOM_ID_BYTES` random, secret is 32/48 bytes — `/tmp/caw-research/collab.md`
"Link format", `protocol.ts:238-249`, `:333-334`), so an unbounded endpoint is a brute-force oracle;
(2) a 1 GiB POST body exhausts a laptop; (3) many WebSocket connections exhaust file descriptors and
memory.

Controls:
- `maxBody = 256 KiB` for JSON routes (`413` on exceed, checked against `Content-Length` **and** the
  streamed byte count — never trust the header alone); directory listings are produced server-side
  and paginated (e.g. 500 entries/page) instead of accepting a "read everything" parameter.
- Login and link-fetch: 5 failures / 15 min per session-less identity (hashed device fingerprint) then
  a 15-min lockout with a fixed 250 ms response floor; successes reset. Return the same error for
  unknown/invalid → no oracle.
- Folder-browse and agent-control routes: token bucket, e.g. 30 req/min and 1 concurrent spawn per
  instance, 5 total.
- WebSocket: inbound frame ≤ 64 KiB, ≤ 4 sockets/session, ≤ 32 total, 30 s handshake timeout, idle
  close (OWASP WebSocket cheat sheet: message size limits ~64 KiB, connection limits, idle timeouts,
  backpressure).
- Node-level: `server.maxHeadersCount`, `requestTimeout`, and an explicit `maxPayload` on the WS
  library.

### (i) Defense against another local user on the laptop

Failure modes: (1) our API is reachable from the LAN/tailnet and, if it ever binds `0.0.0.0`, from
co-located processes; (2) 0700/0600 discipline missing on our own state; (3) another unprivileged
user reads our link from a world-readable file, a core dump, `/tmp`, or a tmux socket.

Controls:
- Bind **`127.0.0.1` only**; never publish the port on the LAN. Remote access is exclusively through
  `tailscale serve` (`[T]`: only `http://127.0.0.1` is supported for proxies, so this is also the
  supported configuration) or `tailscale serve --tcp` tunnelling to loopback.
- No secrets on disk. Link/key/token live in a `Map` in the server process, exactly as upstream keeps
  them in host memory (`registry.ts:15-19`). If a restart-survival requirement ever appears, write
  `~/.omp/libexec/<instanceId>.json` with `mode: 0o600` — the upstream pattern is
  `mkdir(dir, { recursive: true, mode: 0o700 })`, explicit `chmod 0o700` when the mode is loose,
  `fs.promises.open(tmpPath, "wx", 0o600)`, plus refuse symlinked or foreign-owned directories
  (`registry.ts:365`, `:370-376`, `:383-385`, `:461`).
- Our tmux socket must not be the default shared `/tmp/tmux-<uid>/default` with world-readable
  semantics: use a **dedicated socket path** (`tmux -L omp-web` or `-S`), in a directory we create
  `0700`, so unrelated local tmux users cannot attach to an agent session.
- Never pass a secret as a command-line argument (visible in `ps`/`/proc/*/cmdline` to the whole
  machine): tokens go in the environment of the spawned child or in a `0600` file the child reads;
  env is visible to same-uid only. `INFERENCE`: `/proc/<pid>/environ` requires the same uid or root.
- No world-writable temp files; `mkdtemp` with 0700 rather than a fixed `/tmp` name (symlink attack).
- Document the residual: any same-uid process (or root) can read our memory; only separate users are
  defended here.
- Do not disable Tailscale key expiry on the phone (default 180-day expiry, extendable/revocable per
  device `[T]` https://tailscale.com/kb/1028/key-expiry); keep expiry enabled so a lost phone is
  revocable from the admin console.

### (j) XSS from agent-produced content

The agent's output — tool results, file contents, command output with ANSI, model markdown — is
attacker-influencable by design (the model reads a hostile README, or a prompt-injected guest asks
it to reproduce a payload). On a phone with a session cookie for a server that can spawn shells,
XSS is a full compromise of the asset graph in §1.

What upstream does (verified in `packages/collab-web/src`, worth citing because it establishes the
patterns we should not have to rediscover):

- **Markdown**: parsed by a vendored `Marked` with a custom renderer. Raw HTML tokens (block and
  inline) are escaped, never emitted — `Markdown.tsx:63-68`, with entity unescaping so text that was
  escaped survives as text; a comment states "Raw HTML tokens (block + inline both arrive here) are
  escaped, never emitted." Output goes through `dangerouslySetInnerHTML` (`:91`, `:203`) — i.e. the
  safety rests entirely on that renderer override plus the base renderer's escaping.
- **Links**: a `safeHref` gate parses with `new URL(...)` (matching how the browser resolves the
  scheme, "the URL parser strips leading C0 controls and embedded tab/newline that a text check would
  carry through") and allows only `https:`, `http:`, `mailto:` — `javascript:`/`data:` are dropped and
  the inner text is returned unwrapped (`Markdown.tsx:47-58`, `:69-75`). Rendered links get
  `target="_blank" rel="noopener"` (`:74`).
- **Images are the gap.** The collab-web renderer overrides only `html` and `link`
  (`Markdown.tsx:60-78`); the vendored base renderer's `image()` emits `<img src="…">` with only
  `encodeURI` + `escapeHtml` for attribute safety (`packages/utils/src/marked/core.ts:1386-1389`).
  `escapeHtml` escapes `& < > " '` (`packages/collab-web/src/lib/format.ts:4-10`), which blocks
  attribute-breakout, but **there is no `safeSrc` gate on the image URL**, so an agent-written
  `![x](http://attacker.example/px)` beacon is plausible. `INFERENCE` on the beacon (I did not
  exercise it); the missing gate is source-verified. Their tests cover the HTML and href paths
  (`packages/collab-web/test/markdown.test.tsx:29-33` asserts
  `&lt;img src=x onerror=alert(1)&gt;`, `:63-66` asserts `javascript:alert(1)` is absent) but **no
  test asserts anything about image sources** — so this is untested upstream behavior, not a
  sanctioned exemption.
- **ANSI**: stripped before rendering with a CSI+OSC regex
  (`src/tool-render/util.ts:84-87`, used at `src/tool-render/parts.tsx:108`, `:242`). The OSC branch
  `\][^\x07\x1b]*(?:\x07|\x1b\\)` is the one that matters — OSC 8 hyperlinks are exactly how terminals
  get click-to-open links, and leaving them in a browser would be a clickable-link injection into the
  transcript.
- **Syntax highlighting**: highlight.js is an *optional global*; the app does not bundle it and
  degrades to plain text (`util.ts:193-196`, used at `parts.tsx:72-79`, `:112-121`). If we ever
  bundle it, its HTML output is fed to `dangerouslySetInnerHTML` (`parts.tsx:121`) — pin the version
  and treat highlight.js output as trusted-but-version-sensitive.
- **Attachments**: images are inlined as `src={`data:${block.mimeType};base64,${block.data}`}` with
  escaping of nothing else (`src/components/transcript/Transcript.tsx:84-97`) but `block.mimeType`
  is model-influenced — a crafted MIME type is an injection point into the `data:` URL.
- The app ships **no CSP** (`grep -rn "Content-Security-Policy" index.html src scripts` → no match)
  and loads a third-party analytics script (`index.html:76-77`).

Controls for our UI (implementation-ready):
1. Same renderer discipline, minus the gaps: raw HTML escaped; `safeHref` **and** a new `safeSrc`
   allowing only `https:`/`http:` (plus `data:image/{png,jpeg,gif,webp};base64,` with a validated
   MIME allowlist for attachments); `target="_blank" rel="noopener noreferrer"`; drop OSC/CSI with
   the same regex family before rendering; never ship third-party scripts.
2. CSP on every response (this is the real backstop, because renderer bugs are inevitable):
   `default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'
   wss://<device>.<tailnet>.ts.net; frame-ancestors 'none'; base-uri 'none'; form-action 'self';
   object-src 'none'; require-trusted-types-for 'script'`.
   `img-src 'self' data:` blocks the beacon class outright. Add `X-Content-Type-Options: nosniff`,
   `Cross-Origin-Opener-Policy: same-origin`, `Cross-Origin-Resource-Policy: same-origin`.
3. Render agent text through React text nodes by default; `dangerouslySetInnerHTML` only behind the
   renderer override above, in one component, with tests.
4. Test that proves it: a fixture file written by the agent under an allowed root containing
   `<img src=x onerror=…>`, `[x](javascript:alert(1))`, `![x](http://127.0.0.1:9/px.png)`, an OSC-8
   sequence, and a `data:text/html` URL; the test renders the transcript and asserts (i) no script
   executes, (ii) no request leaves the origin (CSP `securitypolicyviolation` fired), (iii) the
   literal text is visible.

---

## 3. Tailscale specifics

Sources: https://tailscale.com/kb/1018/acls (ACLs), https://tailscale.com/kb/1312/serve (Serve),
https://tailscale.com/kb/1223/funnel (Funnel), https://tailscale.com/kb/1081/magicdns (MagicDNS),
https://tailscale.com/kb/1028/key-expiry (Key expiry), https://tailscale.com/kb/1084/sharing
(Sharing). Each is marked `[T]`.

**What the tailnet boundary gives us**
- Network-layer reachability control: ACLs are "deny-by-default, directional, locally enforced, and
  don't affect local network traffic", and are enforced on each device without the coordination
  server `[T]`. So a default policy of "phone → laptop on the one port" is the *right* place to
  remove bulk reachability, and it costs no application code.
- Device identity: Serve injects `Tailscale-User-Login`, `Tailscale-User-Name`,
  `Tailscale-User-Profile-Pic` when proxying tailnet traffic to a loopback backend, and *removes*
  spoofed incoming copies of those headers `[T]`. This is a genuine second factor to bind the login
  flow to (devices, not just "anyone on the tailnet"), and it is unavailable on Funnel `[T]`.
- Transport: Serve terminates TLS with a valid tailnet certificate, so we never manage a cert `[T]`.
- Revocability: key expiry defaults to 180 days and per-device disable/extend is an admin-console
  action; expired keys stop working `[T]`. Sharing a node is quarantined by default (can receive, not
  initiate) and revocable `[T]`.

**What it does NOT protect against** (these are the reasons a network boundary cannot be the auth
model):
1. **A compromised or lost tailnet device.** Anything with tailnet reachability is inside the
   perimeter; the ACL is not a per-request authorization. The phone that is unlocked in a pocket has
   our session cookie.
2. **ACL misconfiguration — including the default.** "In the absence of an `acls` section in the
   tailnet policy file, Tailscale applies the default allow all policy" `[T]`: a fresh tailnet is
   *fully* open device-to-device. Also `"src": ["*"]` rules "apply to everyone who has access to your
   tailnet, including invited users" `[T]`. So the honest statement is "we must not assume the tailnet
   is narrow"; each endpoint enforces its own auth.
3. **MagicDNS names are discoverable/guessable.** Every device gets a machine-name-based FQDN under
   the tailnet DNS name (`monitoring.yak-bebop.ts.net`) `[T]`. Our hostname is therefore not a
   secret; bind to it, don't rely on it.
4. **External users invited to the tailnet.** Sharing exposes a machine to a specific external user,
   governed by the *owner's* ACLs, with `autogroup:shared` available to restrict them `[T]`. If we
   ever use sharing, `autogroup:shared` gets the port only, and the app still requires a session.
5. **Anything that bypasses Tailscale on the same laptop.** Serve proxies to loopback; a local
   process can call our listener directly (and can therefore forge `Tailscale-User-*` headers). Hence
   the Serve docs' own advice: bind the backend to localhost **and** never trust those headers from a
   non-loopback peer `[T]`. Our control: verify the TCP peer is `127.0.0.1` before honoring identity
   headers, and never treat them as the primary authentication.
6. **Compromise of the Tailscale account** — admin console access can rewrite ACLs and unshare/reshare
   nodes. Out of our hands; belongs in the model's assumptions.

**Serve vs Funnel — and why Funnel MUST NEVER be used here**
- Serve: tailnet-only, requires HTTPS certificates, supports the identity headers above, only
  `http://127.0.0.1` backends, and "The same port number cannot be used for Serve … and Funnel … at
  the same time. If the most recent command to configure the port was `funnel`, then the port will be
  completely public." `[T]`
- Funnel: "route traffic from the broader internet to a local service running on a device in your
  tailnet … for anyone to access—even if they don't use Tailscale" `[T]`. Ports limited to 443/8443/
  10000, MagicDNS + HTTPS + a `funnel` node attribute required, and "Funnel traffic, which is
  publicly available, does not include identity headers" `[T]`.
- Why Funnel is disqualifying for this product:
  1. It removes the only compensating control the deployment has. Our server can spawn shells as the
     user; the tailnet boundary is what keeps that reachable only from the owner's devices. Publishing
     it invites automated internet-wide scanning against a single-user app with no WAF, no CDN, and a
     laptop as the host.
  2. It silently converts *every* unauthenticated-gap bug from "tailnet-internal" to "internet-
     exposed" — including the room-link retrieval endpoint, which is the credential for the agent's
     whole session.
  3. It disables the `Tailscale-User-*` identity signal `[T]`, so an authorization layer built on it
     degrades without any code change.
  4. The same port cannot be both `serve` (private) and `funnel` (public) — a single mistaken
     `tailscale funnel 443 …` command makes the port public with no additional step and no visible
     change in the URL `[T]`. There is no "private by default" defense to fall back on.
- Concrete control: never run `tailscale funnel` on this host; if a Funnel config exists,
  `tailscale funnel <port> off` / `tailscale serve reset`. Add a startup check that queries
  `tailscale serve status --json` for a funnel listener and **refuses to start** (or loudly warns) if
  any port is public; test by asserting the parse of `--json` output flags a Funnel-enabled port.

---

## 4. Concrete crypto / storage decisions

**Cookie flags (final).**
```
Set-Cookie: __Host-omp_sess=<32B base64url>; Secure; HttpOnly; SameSite=Lax; Path=/; Max-Age=2592000
```
- `__Host-` requires `Secure`, `HttpOnly` is separate, no `Domain`, `Path=/` `[W]` (MDN Set-Cookie,
  cookie prefixes). This makes the origin the security boundary and blocks subdomain/`Domain`-level
  cookie injection.
- `SameSite=Lax`, justified in §2a: `Strict` breaks the PWA entry flow (separate storage container),
  while `Lax` already withholds the cookie from cross-site `fetch`, subresources, and iframed
  navigations `[W]`, and every state-changing route additionally requires the CSRF header.
- Do **not** use `SameSite=None`, `Partitioned`, or a `Domain` attribute. Do not put the CSRF token in
  a cookie (OWASP: "A CSRF token should not be transmitted in a cookie for synchronized patterns").
- Long-lived iOS login is bounded by ITP for *script-writable* storage only; the `HttpOnly` cookie is
  exempt `[W]`, which is the whole reason the session must live server-side.

**Token generation.**
- Session id: 32 random bytes, `crypto.randomBytes` → base64url. Link-bearing API responses never
  carry reusable tokens in URLs.
- CSRF token: 32 random bytes per session, server-side, compared with `timingSafeEqual` on
  equal-length buffers. Upstream precedent for the shape: 32 random bytes hex
  (`packages/coding-agent/src/collab/registry.ts:431`), and timing-safe compare of a base64url-decoded
  buffer with a length check first (`packages/coding-agent/src/collab/host.ts:763-766`).
- Link retrieval lease: if we ever mint a pull token (for QR handoff), 32 random bytes, single use,
  ≤60 s TTL, bound to the session id and consumed atomically before the response is written.
- **We do not generate room keys or write tokens.** OMP does: `generateRoomKey()` /
  `generateWriteToken()` (`packages/coding-agent/src/collab/crypto.ts:15-25`), sealed frames are
  `[12B IV][ciphertext+tag]` AES-256-GCM (`crypto.ts:11`, `:34-57`), and the link is
  `<roomId>.<base64url(key‖writeToken)>` (`protocol.ts:238-249`, `:333-337`). Reimplementing anything
  here is a bug factory; parse and normalize only.

**Where the room link may exist server-side.**
1. **In the OMP host process's memory** — authoritative, upstream behavior (`registry.ts:15-19`).
2. **In our server's memory**, keyed by `instanceId` + `generation` + `access` (`view`/`control`), with
   a TTL and an explicit wipe when the instance exits. Mirror upstream's stale-generation rule: a
   link request bound to a generation that has moved must fail rather than hand out the successor
   room's link (`registry.ts:330-336` fails `stale_generation`; comment at `:678`: "answers
   `stale_generation` instead of leaking its successor's capability").
3. **Never on disk**, never in the shell history of any command we run, never in an environment
   variable that is exported into a child we don't control (`INFERENCE`: `/proc/<pid>/environ` is
   same-uid-or-root readable), never in a tmux `send-keys` payload if a file descriptor or env var
   will do, never in a log, never in a push payload.
4. If persistence ever becomes a hard requirement: `~/.omp/libexec/caw/` created `0o700`, file
   `0o600` written via `open(tmpPath, "wx", 0o600)` + rename, symlink/foreign-owner refusal, and the
   value encrypted under a key held in the OS keyring rather than beside the file — that last part is
   the only version that meaningfully improves on "in memory".

**Should the browser ever persist the link? NO — in memory only.**
Rationale, in order of weight: (i) `HttpOnly` gives no protection to a value JS already holds, and
ITP's own rationale for capping script-writable cookies is that `document.cookie` content can be
stolen by XSS and speculative-execution attacks `[W]`
(https://webkit.org/blog/8613/intelligent-tracking-prevention-2-1/); (ii) iOS deletes script-writable
storage (LocalStorage, IndexedDB, SessionStorage, SW caches) after 7 days of non-use, so persistence
is unreliable *as well as* unsafe `[W]`
(https://webkit.org/blog/10218/full-third-party-cookie-blocking-and-more/); (iii) a persisted link
outlives the room — upstream rooms rotate on `/new`, `/resume`, `/fork`, and branch, and a stale link
is either useless or, if it survived a rotation, wrong; (iv) the upstream web client already stores
only the display name in `localStorage` (`packages/collab-web/src/app.tsx:54`, `NAME_KEY`) and keeps
`link` in a `useRef`/React state (`credentialRef` shape at `:26-58`), which is the pattern to copy.
So: link in a `Map` in the server, in a React state/ref in the client, gone on refresh — and the
server re-issues it on demand after a cookie-authenticated request. Test: after a full session,
`localStorage`, `sessionStorage`, `indexedDB.databases()`, `caches.keys()`, and `document.cookie` all
contain no substring of the link.

---

## 5. Top 8 controls, ranked, each with its proving test

1. **Per-instance identity + explicit tmux targeting + exact-match reaping.**
   `tmux new-session -d -s <name> -P -F '#{session_id}'` → persist `$N`; address only `-t $N`; reap only
   `kill-session -t $N`; never `pkill -f`, never a name glob. Kills the class of bugs where stopping
   one agent destroys the owner's unrelated tmux sessions.
   *Test:* unit — assert the recorded argv equals `["tmux","-L","omp-web","kill-session","-t","$3"]`
   for a mocked instance and that no code path builds a shell string; integration — start instance A
   (name `A`), start instance B (name `B; touch /tmp/pwned`), reap B, assert `A`'s `has-session`
   returns 0 and `/tmp/pwned` does not exist.
2. **WebSocket upgrade: session auth + Origin allowlist + session-issued-after-link binding.**
   *Test:* handshake with (i) no cookie → 401; (ii) valid cookie but `Origin:
   https://evil.example` → 403; (iii) valid cookie, valid Origin, no authenticated first frame → no
   frame is delivered and the socket is closed after 30 s; (iv) cookie minted before the link was
   created, valid everything else → 403.
3. **Folder browser: realpath containment + `O_NOFOLLOW` + fstat identity re-check.**
   *Test:* (i) root contains `link -> /etc`; request `link/passwd` → 403; (ii) inject a hook that
   swaps a checked directory for a symlink between check and open → still 403 (the open fails because
   of `O_NOFOLLOW`); (iii) `%2e%2e%2fetc%2fpasswd`, `..\\..\\etc`, `\0`, NFC/NFD twin names → all
   rejected or normalized to the in-root file; (iv) served bytes for an in-root file match `sha256sum`
   of that file.
4. **Body-size limits + rate limits + constant-time auth.**
   *Test:* `POST /api/link` with a 2 MiB body → 413; 6 bad logins inside the window → the 6th is 429
   with a fixed shape; a 5-min run of 10k link guesses produces no success and no distinguishable
   timing (`< 5%` difference over 1k samples, marked INFERENCE-grade if flaky).
5. **Link secrecy end-to-end (in-memory only, no URL, no log, no push).**
   *Test:* drive login → link fetch → prompt → logout; then assert (i) the log file has zero matches
   of the link grammar; (ii) the HTTP access log's path fields contain no link; (iii) the client's
   LocalStorage/SessionStorage/IndexedDB/CacheStorage/`document.cookie` contain no link substring;
   (iv) `window.location.href` after fetch contains no link; (v) no constructed push payload contains
   one.
6. **CSRF: no GET state changes + Origin/Sec-Fetch-Site + `X-CSRF-Token` + JSON-only bodies.**
   *Test:* from a second origin, `fetch` with `credentials: 'include'` and no CSRF header → 403 and no
   state change; form-style POST with `Content-Type: application/x-www-form-urlencoded` → 415; same
   request with the correct header → 200; a `GET /api/agents/kill?id=…` route does not exist (404).
7. **Content hardening: CSP + renderer gates (`safeHref` *and* `safeSrc`) + ANSI/OSC stripping.**
   *Test:* §2j fixture — no script execution, no off-origin request, `securitypolicyviolation` fired
   for the beacon image, literal payload text rendered; unit assertions mirroring upstream's
   `Markdown.tsx` tests (`packages/collab-web/test/markdown.test.tsx:29-33`, `:63-66`) plus the
   missing image-source case.
8. **Local-host containment: loopback bind, `0700` dedicated tmux socket, no secret in argv,
   `0600`-on-demand state, key-expiry left enabled.**
   *Test:* `ss -ltnp` shows the listener on `127.0.0.1:<port>` only; `stat -c %a` of the tmux socket
   dir is `700`; `tr '\0' ' ' < /proc/<childpid>/cmdline` contains no token; `tailscale funnel
   status`/`serve status --json` shows no public port and the startup check refuses to start when one
   is present.

---

## 6. Explicit non-goals / what we deliberately do not build

- No CORS support, no cross-origin embed, no third-party script, no analytics (`index.html:76-77`
  upstream shows why: it needed `data-exclude-hash` precisely because a third-party script would
  otherwise see the room key).
- No browser-side link persistence (§4).
- No `pkill`/name-glob process management, no shell strings for tmux/omp (§2e).
- No Funnel (§3).
- No re-implementation of collab crypto or link parsing — consume `parseCollabLink`/
  `formatCollabLink` semantics (`protocol.ts:238-338`), including their exact validity rules
  (32 or 48 base64url bytes, `:333-334`).

---

## 7. UNVERIFIED / INFERENCE list

1. `INFERENCE` — The iOS back/forward list survives app relaunch, so a link once written into
   `location.hash` could reappear after a restart. Not exercised on a device.
2. `INFERENCE` — The missing image-source gate in upstream's markdown path enables an off-origin
   pixel beacon. The gate's absence is source-verified (`packages/utils/src/marked/core.ts:1386-1389`
   vs `packages/collab-web/src/components/transcript/Markdown.tsx:60-78`); the beacon was not
   demonstrated at runtime, and no upstream test asserts on image sources.
3. `INFERENCE` — `/proc/<pid>/environ` and `/proc/<pid>/cmdline` are readable by the same uid (and
   root) and not by other unprivileged users on this kernel. Standard Linux behavior, not measured
   here.
4. `INFERENCE` — `SameSite=Lax` is sufficient for a good installed-PWA entry experience on current
   iOS while keeping cross-site `fetch` cookie-free. The `Lax` semantics are cited `[W]`; the UX claim
   is not device-tested.
5. `UNVERIFIED` — Whether iOS persists a service-worker-registered PWA's `Cache Storage` across the
   7-day ITP window when the app is not opened. WebKit's post says Home Screen web apps keep their own
   day counter and "We do not expect the first-party in such a web application to have its website
   data deleted" `[W]`, but this does not tell us what happens after prolonged non-use. Our design
   does not depend on it (we persist nothing).
6. `UNVERIFIED` — Exact behavior of `tailscale serve` when both a funnel and a serve config have
   existed on the same port over time; the docs state the last command wins `[T]`, but I did not
   exercise a `serve`-after-`funnel` sequence on this host. The startup check in §5.8 is written to
   detect the outcome rather than assume it.
7. `UNVERIFIED` — Whether upstream `omp join`/`omp collab link` ever writes a link to any file. Source
   grep shows registry metadata deliberately excludes links (`registry.ts:15-19`) and the link path
   returns it over the private IPC socket (`:353`), but I did not audit every CLI write path.
8. `UNVERIFIED` — Any HTTP-surface behavior of the *production* relay (`my.omp.sh`), including its
   rate limiting and whether it serves `GET /` with a CSP. Its Go source is not published
   (`/tmp/caw-research/collab.md`, "Self-hosting the relay"); only the local development stand-in
   exists (`packages/collab-web/scripts/local-relay.ts`, which does no Origin or auth check at `:46-61`).
9. `INFERENCE` — A prompt-injected guest can exfiltrate `~/.ssh/*` through the streamed transcript.
   Derived from the documented guest powers (`/tmp/caw-research/collab.md`: "the LLM sees the prompt
   text verbatim") plus the absence of an OS sandbox in the coding-agent package; not executed during
   this investigation, and deliberately not performed (it would require running the scenario).
10. `UNVERIFIED` — `timingSafeEqual`-based login comparisons in Node are constant-time for
    equal-length buffers under our deployment (no JIT/GC side channel measured); we follow upstream's
    length-check-then-compare pattern (`host.ts:763-766`) as the best available primitive.
