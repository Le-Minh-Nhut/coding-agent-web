# Round 2 audit — security and adversarial cases

Scope: `apps/server/src/{app,auth,path-policy,store,config,logger,server}.ts`,
`packages/relay/src/{relay,static}.ts`, `packages/collab-protocol/src/**`,
`packages/guest/src/**`, `apps/web/src/**`, plus the built output of both browser clients.

Method: every finding below was reproduced on this machine against the checked-out
source. Probes were bundled with the repo's own `esbuild` into `/tmp/ppwork/*.bundle.mjs`
and executed with `node`; nothing in the repository was modified except this file.
Where a claim could not be exercised it is marked **UNVERIFIED**.

> **Caveat on a moving target.** The "single origin" work landed while this audit was
> running: `apps/server/src/app.ts` went from 310 → 320 lines and a new
> `apps/server/src/static-web.ts` appeared (commit-less working tree, `git status`
> shows `apps/` untracked). `apps/server/src/server.ts:247` now attaches the relay to
> the API server (`createRelay({ server: app.server, attachOnly: true, allowedOrigin: … })`)
> and `buildApp` serves the web build at `/`. **All app/relay probes below were re-run
> after that change**, and line numbers are against the current working tree.
> `apps/web/dist` was also rebuilt mid-audit (`index-CNYdvyZf.js` → `index-wNKR7WFh.js`);
> the asset checks were re-run after the rebuild.

---

## Verdict

**Attacker with nothing (has found the listener, no credential).** Cannot reach a single
piece of product functionality. All 16 API routes reject an unauthenticated request
(401, or 403 Origin-before-auth on mutations); `/`, `/guest`, `/assets/*` and the SPA
fallback return the *public* UI shell and nothing else — the shell contains no project
paths, no conversation ids, no capability data. The only reachable surface is the login
endpoint and the WebSocket relay, and the relay's `host` role requires no application
authentication at all. Worst realistic outcome: **resource exhaustion / denial of
service** by squatting rooms (no global room cap, no per-IP limit on upgrades — see
SEC-2), and slow offline grinding of the account password, which is capped at 250 ms of
cumulative delay per IP per restart (SEC-5). No data disclosure, no code execution.

**Attacker with a view-only link.** Already catastrophic in practice. `POST /api/conversations/:id/link`
is hard-wired to mint `"control"` (`apps/server/src/app.ts:257`) and there is no
`view` path in the product, but assuming a genuine 32-byte view secret: the holder
decrypts the whole replicated session — back-transcript, streaming text, every tool
card (including `bash` output), subagent transcripts — and, by the report's own threat
model, that transcript contains whatever the agent has read, which includes
`~/.ssh/id_*`, `~/.omp` provider credentials and any file the owner's agent touched.
**Reading is disclosure here, not a lesser privilege.** The write token only gates the
*steering* paths (`packages/…/host.ts:789-801`, read-only rejection `:946,998,1050,1169`).

**Attacker with a full link.** Equivalent to an unauthenticated SSH session on the
laptop, subject to OMP's approval tier: prompt the agent, answer host `select`/`editor`
requests, kill/revive agents. The agent runs as the owner with no OS sandbox, so a
single prompt ("print the contents of ~/.ssh/id_ed25519") completes the escalation.
Nothing in this web layer reduces that; the mitigations that matter are OMP's approval
mode and the fact that a link is only live for its room generation.

**Net:** the HTTP control plane is in good shape — real scrypt, constant-time compare,
hashed session keys, hashed-unless-adapted CSRF, `__Host-`, no CORS header anywhere, no
link in a generated URL, no off-origin asset in either build. The two structural gaps a
red team would actually use are **the relay's unauthenticated `host` role** (SEC-2),
which is now reachable on the *same port as the authenticated API* after the
single-origin change, and **"reading is the exploit"** for any link (SEC-1/SEC-3).

---

## Findings

### SEC-1 · P1 · room link is written into the browser URL and into history

**Component:** `packages/guest/src/app.tsx` (vendored client).

**Evidence.** `packages/guest/src/app.tsx:59`:

```ts
credsRef.current = { link, name };
window.location.hash = link;
```

Reproduction: load `/guest#<roomId>.<key>`-style input through the connect form; the
assignment pushes a history entry whose URL fragment **is the complete bearer secret**
(32-byte key, plus the 16-byte write token when the resolver returns a `control` link).
`leave()` at `:72-76` calls `history.replaceState` for the *current* entry only; earlier
entries created by connecting remain in session history, so back/forward, an iOS
"recently closed tabs" restore, or a screen-recorded address bar exposes it.

Aggravating: the connect screen accepts a pasted link and the *first* connect derives
`formatCollabLink(...)` in standard form, so the fragment is the uniform link grammar —
exactly the string an attacker wants. Mitigating (verified working): fragments are never
sent to the network, both clients serve `Referrer-Policy: no-referrer`, and all rendered
anchors carry `rel="noopener noreferrer"`, so this does not become a Referer leak.

**Root cause:** the vendored client treats the address bar as the credential store. The
repo's own hard rule 3 says the opposite, and `apps/web/src/components/SettingsView.tsx:90`
asserts to the user "Never rendered into the DOM, URLs, or browser history" — which is
true of `apps/web` (link held in `rawUrlRef`, `ConversationView.tsx:52,223`) and false
of `packages/guest`.

**Fix:** delete line 59 and the `hashLink()` deep-link entry point, or keep the fragment
read-only (accept a link in the fragment, never *write* one) and call
`history.replaceState` immediately on connect.

**Regression test:** render `<App/>` in jsdom, drive `connect(link, name)`, assert
`window.location.href` contains neither the room id nor the key and that
`history.length` did not grow.

---

### SEC-2 · P1 · the relay's `host` role needs no application authentication, and has no room cap

**Component:** `packages/relay/src/relay.ts`, `apps/server/src/server.ts:247`.

**Evidence (run against the *current* single-origin wiring, relay attached to the API
server):**

```
single-origin relay (attached to API server):
  no Origin, role=host     : ACCEPTED (no auth needed)
  no Origin, role=guest    : closed 4004
  loopback Origin, host    : ACCEPTED (no auth needed)
  tailnet Origin, host     : ERR Unexpected server response: 403
  evil Origin, host        : ERR Unexpected server response: 403
  plain HTTP /r/ path      : 404
  /healthz on API server   : 404
  unauth GET /api/projects : 401
  unauthenticated rooms created (20 tries): 20
```

The upgrade gate is `packages/relay/src/relay.ts:396-409`, and the comment at `:394-395`
states the intent: *"Native OMP clients send no Origin and are allowed; browsers cannot
forge one."* That is correct as a CSWSH control and wrong as an authentication control.
The relay holds `rooms = new Map()` (`:206`) with **no cap on the number of rooms** and
**no per-connection rate limit** (`grep -n "rate\|limit" packages/relay/src/relay.ts`
returns only the guest-cap comment). A guest that connects with a session cookie is
served an SPA page without redirecting it to log in (`GET /guest … 200`), so the cookie
adds nothing.

**Concrete consequence.** Any client that can open a TCP connection to the origin — a
browser *page*, not just a native client, can do this with `fetch`/`WebSocket`, and a
browser cannot forge `Origin: null`-to-nothing, but a `curl`/`node`/native attacker, or
script in a *loopback*-origin page, can — squats rooms. 20/20 attempts created a room
each. Compare the authenticated API on the same port: every one of its 16 routes returns
401/403 without a session (verified, see WORKING §A).

Worst case today: relay memory/connection exhaustion, room-id denial (an attacker who
guesses a room id before the agent publishes blocks the real host with 4009), and
metadata from `/healthz` if a standalone relay is ever deployed. **Not** confidentiality:
squatting a room yields no key, so no transcript.

**Root cause:** loopback was doing double duty as "trusted" before the single-origin
change. It no longer is, because the API now shares that port and the surface is reached
through `tailscale serve`.

**Fix:** require an authenticated session (or the process's own host credential) on
`role=host`, and cap total rooms/connections. Smallest version: in
`server.on("upgrade")`, reject `role=host` unless the request carries a valid
`__Host-caw_session` cookie parsed with the same `cookies()` helper the API uses.

**Regression test:** upgrade `/r/<id>?role=host` with no cookie → expect 403; with a
valid cookie → expect 101. Plus: open `maxRooms + 1` host sockets and assert the last is
refused.

---

### SEC-3 · P1 · `POST /api/conversations/:id/link` always mints the write-capable link

**Component:** `apps/server/src/app.ts:249-271`.

**Evidence.** `apps/server/src/app.ts:257`: `const link = await deps.mintLink(conversation, "control");`.
`AppDependencies.mintLink` (`app.ts:31`) and the composition root
(`apps/server/src/server.ts`) both accept `"control" | "view"`, but no caller ever passes
`"view"`, and there is no request parameter, no query flag and no route that could:
`collab-registry.ts:142-147` shows `link(instanceId, accessType)` pushing `--view` for
`"view"`, i.e. the read-only capability exists and is unreachable from the API.

Consequences: (a) the product has no least-privilege sharing mode, so the "view-only
link" the threat model leans on cannot be issued; (b) `access: "full"` in the response
(`apps/server/src/server.ts`, mintLink) is a label the client cannot act on. The one
mitigating fact, verified upstream, is that OMP itself enforces read-only for links
without the write token (`host.ts:763-766` timing-safe compare, `:789-801` sets
`canWrite`), so this is a missing feature asymmetry, not a broken cryptosystem.

**Root cause:** the route was written for the "owner drives their own agent" case and
the `access` parameter was never surfaced.

**Fix:** accept `?access=view|control` (zod-validated), default to `view`, and have the
UI request `control` explicitly behind a confirmation. The plumbing already exists.

**Regression test:** `POST …/link?access=view` → response `acces === "view"` and
`mintLink` called with `"view"`; `?access=control` → `"full"`.

---

### SEC-4 · P2 · `Sec-Fetch-Site: cross-site` is rejected, but an absent header is trusted — and that is the *only* thing stopping a bodiless/`text/plain` cross-site POST

**Component:** `apps/server/src/app.ts:100-115`.

**Evidence.** The gate is

```ts
if (origin ? !origins.has(origin) && !trustedTailscale : !safe) return 403 …;
if (!safe && request.headers["sec-fetch-site"] && request.headers["sec-fetch-site"] !== "same-origin") return 403 …;
```

i.e. **an absent `Origin` is only fatal for non-SAFE methods**, and the
`sec-fetch-site` check is skipped entirely when the header is absent. On mobile Safari —
the target browser — `Origin` *is* sent on cross-origin POSTs, so in practice the gate
holds, but it is a "browser-please-tell-us" control with two ways past it: (a) any
non-browser client, (b) any request shape where the browser omits both headers.

Bodiless POST, measured in the current tree:

```
B bodiless POST no CT     : 404 {"ok":false,"error":{"code":"not_found","message":"Conversation not fo
```

The route was reached without a `Content-Type` (the `hasBody` logic at `:105-111`
correctly treats "no body" as "no type needed"), and the **CSRF header was required**
because `!safe && !isLogin && !verifyCsrf(...)` at `:115` is unconditional. So a
cross-site form POST that carries no body and no CSRF header still fails — but only at
the last of three gates. Measured:

```
C cross-site form POST   : 403 (Origin not in the allowlist)
F POST text/plain + csrf + origin (form-style): 415 Content-Type must be application/json
I POST cross-site sfs    : 403 Cross-site state-changing request rejected
```

Reproduce with `node` + `fetch` (bundled probe, source in `/tmp/ppwork/probe16.mjs`):
authenticate, then send `Origin: http://127.0.0.1:<port>`, `Content-Type: text/plain`,
body `{"path":…}` → **415**; the same without a `Cookie` → **403** (Origin-before-auth);
the same with a session cookie and no `X-Caw-Csrf` → **403 csrf**.

**Root cause:** the request is rejected by *content-type* and *CSRF*, not by an
identity-less origin check; the origin check's "no Origin ⇒ fine for safe methods" rule
was extended to mean "no Origin ⇒ fine unless the method is unsafe", which is the right
default but leaves header-absence as the discriminator.

**Fix:** none needed for browsers today. Harden by treating a missing `Origin` on *any*
`/api/*` request from a browser-ish client (i.e. presence of `Sec-Fetch-Mode`) as
hostile, and by requiring `Origin` or `Sec-Fetch-Site: same-origin` on every `/api/*`
call, not just mutations. Cheap, no client change.

**Regression test:** loopback `app.inject` with `Cookie` + valid CSRF + no `Origin` and
no `Sec-Fetch-*` → 403; with `Sec-Fetch-Site: same-origin` → 200.

---

### SEC-5 · P2 · login rate limiting is global, so one unauthenticated client locks the owner out

**Component:** `apps/server/src/auth.ts:80-100`.

**Evidence.** `verifyPassword` short-circuits on `time < ipState.blockedUntil || time < globalRate.blockedUntil`,
and every failure increments **both** the per-IP and the process-global counter with
`Math.min(15 * 60_000, 250 * 2 ** min(failures-1, 12))`. Measured:

```
attacker ip 10.0.0.9 failures: 401 401 401
owner (ip 127.0.0.1) correct password right after attacker failures: 401
wait 8s then owner correct: 200
```

Three failures from an unrelated address made the owner's *correct* password fail for
~1 second and would have held for up to 15 minutes at 13+ failures. `trustProxy` is not
set anywhere (`grep -rn "trustProxy" apps packages tests scripts` → no matches), so
`request.ip` is the socket peer — the address is the *only* discriminator, and behind
`tailscale serve` every tailnet device looks like `127.0.0.1`, which means an attacker
on any admitted device degrades the owner's counter directly.

Secondary and upstream-documented: the first-run setup token is the password (no
separate password change route), and the default `setupOutput` prints it to stdout
(`auth.ts:68`), so it lives in the journal.

**Root cause:** the global backoff is an anti-online-guessing measure that also functions
as a single-request DoS by design.

**Fix:** drop the global counter to a large ceiling (e.g. 50) whose only purpose is to
stop distributed guessing, keep the per-IP one, and stop counting throttled attempts
against the global counter. The password is 32 bytes of entropy; per-IP backoff is
already sufficient.

**Regression test:** N failures from a synthetic IP, then a correct login from a
different IP → 200 within the first second.

---

### SEC-6 · P2 · a duplicate conversation title makes coupling permanent for that project

**Component:** `packages/omp-adapter/src/tmux.ts:17-23,115`, `apps/server/src/server.ts` runtimeSpec.

**Evidence.** The session name is derived from the conversation title
(`sanitizeSessionName("Fix the bug") === "caw-Fix-the-bug"`). Two conversations whose
titles sanitize to the same string collide at tmux, and `launch` converts that into a
hard failure — so the second conversation can never start:

```
first launch  : {"id":"$0","name":"caw-Fix-the-bug",…}
second, same title: {"err":"…duplicate session: caw-Fix-the-bug"}
third, differing case: {"id":"$1","name":"caw-fix-the-bug",…}
```

Restart/stop/resume stay correct (they address `$N`, `tmux.ts:184,207,223`), and
`sanitizeSessionName` is applied to the display name only — so this is an availability
bug, not injection (see WORKING §F). It is also a name-reuse hazard for the legacy
name-based adoption path in the supervisor (already noted in `docs/architecture/security-model.md`).

**Root cause:** a display label is used as a namespace key.

**Fix:** the smallest correct change is to suffix the sanitized title with a short hash
of the conversation id, `caw-${title}-${hash8}`; the id is already in scope at
`server.ts` `runtimeSpec` and is already passed as `conversationId` into `launch`.

**Regression test:** launch two conversations titled `"Fix the bug"` → both succeed, two
distinct `$N`, distinct names.

---

### SEC-7 · P2 · `GET /api/conversations/:id` can be triggered by a cross-site top-level navigation

**Component:** `apps/server/src/app.ts:100-115` (safe-method exemption),
`packages/runtime/src/supervisor.ts:147-163` (`refresh`).

**Evidence.** Safe methods are exempt from the `Origin` check and from
`Sec-Fetch-Site`. `app.inject`-equivalent measurement with a real supervisor stub:

```
cross-site top-level navigation GET /api/conversations/:id -> 404 (conversation not found)
supervisor.refresh called with: ["some-id"]
cache-control on that response: null | CORS header: null
same GET with forged Origin -> 403
```

So the request *executes* when it has no `Origin`. `refresh` writes only when the
observed state changed (`supervisor.ts:154-161`), which limits the damage — but the
observation path calls the tmux and registry adapters, so each such GET is a `tmux
list-sessions` plus an `omp collab list --json` child process. A cross-site `<img>` tag
cannot read the 404 body (`nosniff` + JSON + no CORS header: verified no
`access-control-allow-origin` anywhere in the tree), so this is **not** a data leak — it
is an unauthenticated-ish write/exec amplification path plus a novelty: the only route
with an observable side effect reachable by a safe method.

**Root cause:** `SAFE_METHODS` is treated as "cannot mutate", which is false for a route
whose handler persists state.

**Fix:** make the exemption structural rather than optimistic — check `Origin` on
`/api/*` for all methods (browsers send it for cross-site requests), or move the write in
`refresh` behind the mutating path.

**Regression test:** cross-site GET with `Cookie` and no `Origin` → assert
`supervisor.refresh` was *not* called.

---

### SEC-8 · P2 · `redactLogValue` does not redact a link when it arrives as an `Error`

**Component:** `apps/server/src/logger.ts:11-19`.

**Evidence.** Measured with a real-shaped link (`formatCollabLink("ws://127.0.0.1:8792", …, key32, writeToken16)`):

```
{"plain":"ws://127.0.0.1:8792/r/[COLLAB_LINK]"}          ← redacted
{"url":"[REDACTED]"}                                      ← redacted
{"message":"failed to mint link for ws://…/r/[COLLAB_LINK]"}  ← redacted
{"err":{}}                                                ← NOT redacted (Error enumerates to nothing)
```

Instances of `Error` serialise to `{}` in Fastify's logger, so the link does not leak —
but the redaction is silently skipped, and any path that stringifies the error *before*
handing it to the logger (`error.message`, which is what `app.ts:127` and
`app.ts:290-300` already do) is covered only by the message regex, which is a pattern
match, not an invariant. The link route's catch block is the one place that gets this
right by construction (`app.ts:267-269` logs only `{ conversationId }`).

**Root cause:** `redactLogValue` handles strings, arrays and plain objects; `Error` is
`typeof "object"` but has no enumerable own properties.

**Fix:** one branch: `if (value instanceof Error) return redactLogValue(value.message)`.

**Regression test:** `expect(JSON.stringify(redactLogValue(new Error(link)))).not.toContain(keyFragment)`.

---

### SEC-9 · P2 · CSP allows neither inline styles nor inline scripts, and both clients need them

**Component:** `apps/server/src/app.ts:93` (CSP on everything it serves, including the
now-served web build), `packages/guest/dist/index.html:11` (the guest's own meta CSP).

**Evidence.** Server header on `GET /` (measured in the current tree):

```
Content-Security-Policy: default-src 'self'; script-src 'self'; style-src 'self';
  img-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'self'; frame-ancestors 'none'
```

- `apps/web` ships inline `style={{…}}` props — `grep -roh 'style={{' apps/web/src | wc -l`
  → **129**. React writes these through `element.style`, so they are *not* blocked by
  `style-src` (styles applied via CSSOM are not inline-style attributes) — **INFERENCE**,
  not reproduced in a browser here. A `style=` *attribute* in server-rendered markup
  would be blocked; React does not emit one.
- `packages/guest/dist/index.html` has an inline `<script>` (theme bootstrap) and its own
  meta CSP with `style-src 'self' 'unsafe-inline'`. Under the **server** header this
  inline script is blocked. Only reachable if the guest page is loaded from the API
  origin (`/guest`) rather than from the relay's own listener.
- Note the header omits `form-action` and `frame-src`; `default-src 'self'` covers
  `frame-src` but *not* `form-action` in CSP3, so a `form-action` injection surface
  exists where a `<form method=POST action=https://evil>` would be allowed. No such
  injection point was found (see WORKING §E) — reported as a defence-in-depth gap.

**Root cause:** CSP was written for the API's JSON responses and inherited by the static
handler in the single-origin change.

**Fix:** per-response CSP — `style-src 'self'` for the API and the web bundle
(drop the inline bootstrap or move it to a module with a nonce), and either don't serve
the guest client from the API origin or give that route its own header.

**Regression test:** an e2e assertion that `GET /guest` carries a CSP that does not block
the bootstrap script (currently it does), plus a Playwright console-error assertion on
`GET /`.

---

### SEC-10 · P2 · vendored guest permits SVG `data:` images in `img src`, including via Markdown

**Component:** `packages/guest/src/components/transcript/Markdown.tsx:84-92` (`safeSrc`).

**Evidence.** `safeSrc` matches `/^data:image\/(?:png|jpeg|jpg|gif|webp|svg\+xml);base64,[A-Za-z0-9+/=]+$/i`.
Rendered through the exact sink (`dangerouslySetInnerHTML`, parsed with jsdom):

```
guest "![i](data:image/svg+xml;base64,PHN2ZyBvbmxvYWQ9YWxlcnQoMSk+PC9zdmc+)"
      html= "<p><img src=\"data:image/svg+xml;base64,…\"></p>"
      DOM img attr= "data:image/svg+xml;base64,PHN2ZyBvbmxvYWQ9YWxlcnQoMSk+PC9zdmc+"
```

The payload is literally `<svg onload=alert(1)>`. Modern Safari/Chrome/Firefox do not
run scripts in `data:image/svg+xml` documents loaded as images (image documents are
static), so this is not demonstrated script execution — **defence in depth / P2**, not
P1. It is nevertheless the only surviving "script-capable type" in an allowlist whose
stated purpose is to permit *images*, and `apps/web/src/sanitize.ts:14` is looser still:
`trimmed.startsWith("data:image/")` accepts `data:image/svg+xml` **and** any future
`data:image/*` subtype with no regex at all.

**Root cause:** the allowlist enumerates types but includes the one type that is also a
document format.

**Fix:** drop `svg+xml` from `safeSrc`; widen the web sanitizer's `data:image/` prefix
test to the same strict regex so both clients agree.

**Regression test:** `expect(safeSrc("data:image/svg+xml;base64,…")).toBeNull()` and the
equivalent for `sanitizeUrl(…, true)`.

---

### SEC-11 · P3 · the room id is echoed in the HTTP 404 body on the `Set-Cookie`-less static path

**Component:** `packages/relay/src/static.ts:233-236`, mirrored in
`apps/server/src/static-web.ts:295`.

**Evidence.** `GET /r/<roomId>?role=guest` over plain HTTP against the standalone relay
returns `404 not found`; against the API server it returns the SPA shell (the
single-origin change made `/r/` a reserved path that 404s *without* echoing —
`static-web.ts:301-306` — verified: `plain HTTP /r/ path : 404`). No room id is echoed in
the current tree; this is a note that the *pattern* `Route ${method}:${request.url} not
found` exists for `/api/*` and would echo a query string if a link were ever placed in a
query parameter. Tracked as a latent path only.

**Fix:** if the reserved-path 404 ever gets a body, use the route template, not
`request.url`.

**Regression test:** `GET /api/nope?x=<link>` → body does not contain the key substring.

---

## Controls verified as WORKING (do not re-audit)

Everything below was executed, not read.

### A · Authentication and session

| Control | Evidence |
|---|---|
| Real KDF, per-password salt | `auth.ts:44` `scrypt(password, salt, 64)`; salt is `randomBytes(16)` per `persistPassword`; test asserts `record.hash !== setupToken`. |
| Timing-safe compare | `auth.ts:27-31` `safeEqual` (length pre-check + `timingSafeEqual`) for CSRF; `verifyPassword` compares scrypt output with `timingSafeEqual(derive(…), hash)`. |
| Session token hashed at rest | `auth.ts:104-106` — the map key is `createHash("sha256").update(token).digest("hex")`; the raw token exists only in the cookie. |
| Expiry enforced | `verifySession` deletes and returns `null` when `expiresAt <= now()`; TTL default 720 h (`config.ts` `authTokenTtlHours`). |
| Revocation real | `POST /api/auth/logout` → `revokeAll()`; measured `GET /api/projects` after logout → **401**. |
| Cookie flags for an iOS PWA | measured `Set-Cookie: __Host-caw_session=<token>; HttpOnly; SameSite=Lax; Path=/; Secure; Max-Age=2592000` — `__Host-` prefix, `Secure`, `HttpOnly`, `SameSite=Lax`, `Path=/`, no `Domain`. `insecureCookies` is refused unless host ∈ {localhost,127.0.0.1,::1} (`config.ts`). |
| No session fixation | two consecutive logins produced two distinct cookies (token is fresh `randomBytes(32)` per login). |
| Setup token is single-use in effect | second `initAuth()` on the same state dir returns `{setupRequired:false}` and the token is no longer a live credential **because `persistPassword` overwrote the hash with the salt+hash — the token never functioned as a password**; the on-disk record is `{"salt":"…32 hex…","hash":"…128 hex…"}`, neither of which equals the token. Measured. |
| Auth before routing | all 16 routes: unauth GET → 401, unauth mutation → 403 (Origin gate fires first). |
| `/api/auth/me` does not leak the token | returns `{csrfToken}` only, not the session token. |

### B · CSRF and origin

| Control | Evidence |
|---|---|
| Cookie-only mutation is refused | `POST /api/projects` with cookie, no `X-Caw-Csrf` → **403 csrf**. |
| CSRF is bound to the session | session-A CSRF + session-B cookie → **403 csrf**. |
| CSRF compare is constant-time | `auth.ts:113` → `safeEqual`. |
| Forged `Origin` refused | `GET /api/projects` with `Origin: https://evil.example` → **403**; `POST` with `Origin: https://myphone.tailnet.ts.net` while `trustTailscaleOrigin=false` → **403**. |
| `Origin` absent + unsafe method refused | `POST /api/projects` with cookie+CSRF, no `Origin` → **403** "Missing or disallowed Origin". |
| `Sec-Fetch-Site: cross-site` refused | `POST` with everything else valid → **403** "Cross-site state-changing request rejected". |
| `text/plain` form POST refused | → **415** "Content-Type must be application/json" (this is the anti-simple-request control that stops a preflight-free form post). |
| No CORS anywhere | `grep -rn "access-control-allow" apps packages --include=*.ts` → no matches; measured responses carry no `access-control-allow-origin`. This matters because the `host` behind `tailscale serve` injects its own permissive CORS on a **different origin** — the browser blocks that read, but the login endpoint is still a cross-origin write from the tailnet (documented in `docs/research/security-considerations.md` §3). |
| Body limit enforced | 70 KiB authed `POST /api/projects` → **413**; 70 KiB *unauthenticated* → **401** (size check does not precede auth in a way that leaks). |
| Bodiless POST is not a CSRF hole | measured: route reached without `Content-Type`, still blocked by the CSRF gate at `app.ts:115`. |

### C · WebSocket upgrade

| Control | Evidence |
|---|---|
| Foreign browser origin refused | `Origin: https://evil.example` → **403** at both the standalone relay and the attached relay. |
| Legacy loopback default is tight | with `allowedOrigins === null`, only `localhost`/`127.0.0.1`/`::1` (case-insensitive) pass: `http://foo.localhost:1234` → **403**, `http://LOCALHOST:1234` → accepted, `http://127.0.0.1:<any>` → accepted. |
| `Sec-Fetch-Site` cross-site refused | header present and ≠ `same-origin`/`none` → **403**, including with no `Origin`. |
| Malformed room targets refused | no `role`, `role=root`, `roomId` shorter than 10 chars → close **4000 bad request**. |
| Guest without a host refused | close **4004 no such room**. |
| Second host refused | `rooms.has(roomId)` → close **4009 host conflict** (`relay.ts:287-294`). |
| Guest cap enforced | 12 settles, refs held: `1,1,1,1,1,1,1,1,3,3,3,3`; closes carry **4029 "room is full"**; `/healthz` reports `guests: 8`. |
| Frame cap enforced | a 9 MiB binary frame from the host → host closed **1009** (`maxPayload: MAX_FRAME_BYTES`, `relay.ts:255`). |
| Heartbeat reaps dead peers | `HEARTBEAT_INTERVAL_MS = 30_000` with `state.alive` + `socket.ping()` (`relay.ts:427-441`). |
| Backpressure ceiling exists | `bufferedAmount > MAX_BUFFERED_BYTES (4 MiB)` → close **1013** (`relay.ts:240-244`). |
| Room ids are unguessable and unlisted | 16 bytes CSPRNG (`types.ts` `ROOM_ID_BYTES`, `link.ts:51-55`); `/rooms`, `/r`, `/api/rooms` → 404; `/healthz` reports only counts. |
| Relay is content-blind | guest frames get `frame.writeUInt32BE(peerId, 0)` and are delivered byte-for-byte (`relay.ts:354-363`); the router reads only the 4-byte prefix; no decrypt, no payload logging. |
| Relay does not log the target | upgrade rejections log fixed strings (`relay.ts:398,404`); room logs carry the room id only (`:288,297,329,343,351,368`). |

### D · Room link as a credential

| Control | Evidence |
|---|---|
| Never in a response we generate as a URL | `POST …/link` returns JSON only; no `Location`, no redirect. Measured headers: `Cache-Control: no-store`, `Referrer-Policy: no-referrer`, `X-Content-Type-Options: nosniff`, CSP. |
| `apps/web` keeps it in a ref, not storage | `ConversationView.tsx:52,223,272`; `grep -rn "localStorage\|sessionStorage\|indexedDB" apps/web/src` → only a *claim* in `SettingsView.tsx:89`, no write. |
| Never in the fragment for the main app | `apps/web` never touches `location.hash`; the guest client does — **SEC-1**. |
| Never sent to the network | the key is parsed client-side and imported into WebCrypto (`collab-protocol/src/codec.ts:34-48`); the socket URL is `${wsUrl}?role=…` (`socket.ts:112`), never the key. |
| Error paths do not surface it | `app.ts:267-269` logs `{conversationId}` and returns a fixed string; the global error handler returns `Internal server error`. |
| Log redaction works for the common shapes | measured: plain string, `{url}`, and message-embedded links → `[COLLAB_LINK]` / `[REDACTED]`; `apps/server/src/logger.ts:1` also redacts `req.url`, `url`, `*.cookie`, `*.authorization`. |
| `Referrer-Policy: no-referrer` everywhere | API hook `app.ts:91`; relay static `static.ts:43`; the web `index.html` also carries the meta tag. |

### E · XSS and content rendering

| Control | Evidence |
|---|---|
| No `dangerouslySetInnerHTML` in `apps/web` | `grep -rn dangerouslySetInnerHTML apps/web/src` → none; the web renderer builds React elements and passes text as children. |
| Web sanitizer escapes raw HTML | measured `renderToStaticMarkup(renderMarkdown("<img src=x onerror=alert(1)>"))` → `&lt;img src=x onerror=alert(1)&gt;`; `<script>`, `<svg/onload=…>`, `` `code` `` spans all escaped. |
| Web `javascript:` blocked, case and control-char variants too | `[x](javascript:alert(1))`, `[x](JaVaScRiPt:…)`, `[x](java&#115;cript:…)`, `[x](&#106;avascript:…)` → **no anchor emitted at all** (measured through a real DOM: `attr = (none)`). Note this is a *stricter* result than the code comment implies — the entity forms produce no anchor rather than a `https:`-resolved one, because the regex parser never matches them as links; explicit fragility risk is that the code's `startsWith("https://")` prefix test is not URL-parser-based like the guest's. |
| Guest renderer escapes raw HTML and gate-times schemes | measured: `<span onmouseover=alert(1)>hi</span>` → `<p>hi</p>` (tag dropped); `<script>`/`<div style=…>` escaped; `[x](javascript:alert(1))`, `[x](JaVaScRiPt:…)`, `[x](java\tscript:…)`, `[x](data:text/html,…)` → `<p>x</p>` with no anchor. |
| Entity-encoded `href` does not produce a live `javascript:` | `[x](java&#115;cript:alert(1))` → `href="java&amp;#115;cript:alert(1)"` → DOM `getAttribute` = `java&#115;cript:alert(1)`, `protocol = https:` (relative), `onclick = null`. Double-escaping by `escapeHtml` in the renderer plus the browser's entity rules mean the payload is inert. Measured through jsdom + the real `renderMarkdown`. |
| KaTeX is not a script vector | measured `$$\href{javascript:alert(1)}{x}$$` → KaTeX renders `\href` as an **error node** (`<mstyle mathcolor="#cc0000"><mtext>\href`); `\includegraphics` likewise; `math.ts` passes `trust: false`. |
| `target="_blank"` links carry `rel="noopener noreferrer"` | `Markdown.tsx:114`; measured in the output HTML. |
| React itself blocks `javascript:` hrefs | measured client render of `<a href="javascript:alert(1)">` → `href="javascript:throw new Error('React has blocked a javascript: URL as a security precaution.')"`. This is what makes SEC-? / `web-search.tsx:73` a low-severity finding: React 19 sanitises the scheme at the property level. Still worth fixing (it is not a documented contract), but **not** currently exploitable. |
| **No third-party asset, script or analytics in either build** | re-run after the rebuild: `grep -rIl 'my\.omp\.sh'`, `'um\.can\.ac'`, `'google-analytics'`, `'gtag('`, `'posthog'`, `'sentry'`, `'plausible'` over `apps/web/dist` + `packages/guest/dist` → **no matches**. The only absolute URLs in the bundles are W3C/XML namespaces, `react.dev`, `lucide.dev`, `github.com`, `tex.stackexchange.com`, `tug.org`, `w3schools.com` (doc strings/error links). No `<script src=http…>` or `<link href=http…>` in either `index.html`; no `url(http…)` or `@import` in either CSS. |
| Guest CSP is a real second layer | `packages/guest/dist/index.html:11`: `default-src 'none'; script-src 'self'; img-src 'self' data: https:; connect-src 'self' ws: wss:; frame-ancestors 'none'; base-uri 'none'; form-action 'self'`. |
| `images` are the only off-origin fetch the guest permits | `img-src … https:` in that CSP plus `safeSrc`'s `https:` branch — a *documented* exfiltration channel (an agent-authored `![x](https://attacker/…)` returns one bit); the API's CSP (`img-src 'self' data:`) closes it for `apps/web`, and the guest's own meta CSP re-opens it. Consider `img-src 'self' data:` for the guest too. |

### F · Injection

| Control | Evidence |
|---|---|
| Array-argv everywhere, `shell:false` | `packages/omp-adapter/src/{tmux,capabilities,collab-registry}.ts` — `execFile` with `shell:false` at `tmux.ts:44-46`, `collab-registry.ts:122-124,151`; the only three `child_process` importers in the tree. |
| tmux addressed by `$N` | `capture/sendKeys/kill` refuse anything not starting with `$` (`tmux.ts:184,207,223`); `new-session` uses `-P -F '#{session_id}'` (`:120-122`). |
| Session names are sanitized, and the sanitizer is a real allowlist | `sanitizeSessionName` (`:17-23`) `[^a-zA-Z0-9_-] → "-"`. Measured: `"'; touch /tmp/caw-pwn-t1; '"` → `caw-touch--tmp-caw-pwn-t1`, `"$(touch …)"` → `caw-touch--tmp-caw-pwn-t2`, backticks → dashes, `\n` → dash, leading dashes stripped (`"-rf"` → `caw-rf`). |
| A crafted title/path/model cannot change the meaning of the command | measured end-to-end through the real adapter with a dump script as the "binary": `argv seen by child: "--config=/tmp/ppwork/overlay.yml\n--model=m; touch /tmp/caw-pwn-t5\n--resume\n/tmp/x; touch /tmp/caw-pwn-t6\n"` — the semicolons stayed **inside** argv; `/tmp/caw-pwn-t{1..6}` all absent. Raw tmux control confirms tmux itself quotes the command word: `pane_start_command` = `["/tmp/ppwork/argv-dump.sh" "--resume=/tmp/a;touch /tmp/caw-pwn-8" --config=/tmp/b.yml]` and `-e "EVIL=x;touch …"` did not execute. |
| Overlay config content is fixed | `server.ts` `writeOverlay`: body is a literal `["collab:", "  autoStart: control", \`  relayUrl: ${relayOrigin}\`, ""]` with `relayOrigin = ws://${config.relayHost}:${config.relayPort}` — both operator-set; the filename is `${conversationId.replace(/[^a-zA-Z0-9-]/g,"")}.yml`, i.e. a UUID. No user-controlled byte reaches a config file. |
| `sendKeys` has no HTTP caller | `grep -rn sendKeys apps packages tests` → only the adapter, its interface, and a unit test. Any future prompt endpoint must not use it (already flagged in the security model). |
| Prompt text never reaches a child process | the composer sends sealed frames over the socket (`ConversationView.tsx:288-294`); the server has no prompt route. |

### G · Path policy

| Input | Result |
|---|---|
| root itself | **OK** → canonical path |
| parent `/tmp/ppwork` | DENY `path_forbidden` |
| sibling prefix `/tmp/ppwork/root-evil` | DENY `path_forbidden` |
| `…/root/../root-evil` | DENY `path_forbidden` (forbidden segment) |
| `…/root/sub/../..` | DENY `path_forbidden` |
| symlink → `/etc` | DENY `path_forbidden` (realpath then containment) |
| symlinked **dir** inside the root | **OK**, resolved to the real in-root path |
| NUL in a path segment | DENY `path_forbidden` "Path contains NUL" |
| C0 control char | DENY `path_forbidden` |
| relative path | DENY |
| NFD/NFC ambiguous, 300-char segment | DENY (`not_a_directory` / `path_not_found`) |
| FIFO, Unix socket | DENY `not_a_directory` when a directory is required |
| newline in a filename | DENY `path_forbidden` |

Reproduction: bundled `WorkspacePathPolicy` probe over `/tmp/ppwork/root` (fixtures:
symlinks to `/etc` and to an in-root dir, a FIFO, a Unix socket, NFD and newline names).
The **listDirectory side is not hardened the same way**: a directory containing a newline
in a name makes the whole listing throw,

```
LIST FAIL PathPolicyError: Invalid directory entry name
```

because `classifyChild` validates names *after* `readdir` returns them
(`path-policy.ts:92-96`), while `canonicalize` (`:59-72`) accepts a newline *inside* a
segment it is asked to match (only `\u0000-\u001f\u007f` of the trimmed segment are
rejected, and a newline in the middle of a name is only caught by `classifyChild`, not by
the segment filter when the name arrives as a path). Net effect: an attacker (i.e. any
process that can create a file, including the agent under audit) can make a configured
root's folder browser unusable by creating `root/evil\nname.txt`. That is a P3
availability nits — worth a one-line `continue` in `listDirectory` instead of a throw —
and is the only way I found to redirect or defeat the policy.

Defeating it: **not achieved**. The only accepted escapes are the intended ones
(symlink resolving inside the root).

### H · Local trust (file modes on this machine)

```
$ ls -ld /home/heheboiz/.local/state/coding-agent-web
drwx------  heheboiz  …   0700
$ ls -l  /home/heheboiz/.local/state/coding-agent-web
-rw-------  heheboiz  auth-password.json   (0600)
drwx------  heheboiz  overlays/            (0700)
$ umask
0002
```

`store.ts` opens the journal with `O_NOFOLLOW` and `chmod(0o600)`s it on every open
(`store.ts:52-58`, `append`), `auth.ts` writes the password file with `flag:"wx"` and
`mode:0o600` then `rename`s it, and `server.ts` creates the overlay dir with `mode:0o700`.
The state dir lives under `~/.local/state` (0700 home). The **repo** is
`drwxrwxr-x` — group-writable is not, but if that group is ever populated, the built
`apps/web/dist` and `packages/guest/dist` that are now *served* become group-writable
content. Not a finding today (`heheboiz:heheboiz`), worth a note.

No `CAW_CONFIG` file exists on this machine (`ls ~/.config/coding-agent-web* /etc/coding-agent-web*`
→ missing), so the config comes from defaults + env; the config file, if used, is read
with the process umask and is a link-bearing file only if the operator puts one there —
no secret is required to be in it.

### I · Denial and limits

| Limit | Value | Verified |
|---|---|---|
| HTTP body | 64 KiB (`app.ts:37`) | 70 KiB authed → **413**; oversized unauth → 401 first |
| login rate limit | per-IP + global, 250 ms → 15 min | measured (see SEC-5) |
| guests per room | 8 | 9th–12th → **4029** |
| frame size | 8 MiB | 9 MiB → **1009** |
| send backpressure | 4 MiB → 1013 | read in source, not separately exercised |
| heartbeat | 30 s | read in source |
| `maxActiveAgents` | 3 (config default) | `launchVerdict` refuses `conflict_limit` at `activeCount >= maxActive` (`state.ts:188-194`) — enforced **inside** the launch path, so it is real |
| **rooms total** | **absent** | 20/20 unauthenticated host sockets accepted (SEC-2) |
| **upgrade rate limit** | **absent** | same |
| **`setSkills`… message rate** | absent | no per-peer message rate limit; bounded only by `maxPayload` and backpressure |

---

## UNVERIFIED

1. **Real iOS Safari behaviour** for the cookie flags, the fragment history entry
   (SEC-1), and PWA cookie partitioning. Reason: no iOS device or WebKit build available
   here; the cookie flags were verified as *emitted*, not as *accepted*.
2. **Whether React's inline `style={{…}}` props survive the server CSP** in a real
   browser. Reason: jsdom/`renderToStaticMarkup` does not enforce CSP; reasoning is
   INFERENCE from CSSOM-vs-attribute semantics.
3. **`data:image/svg+xml` script execution** (SEC-10). Reason: needs a real browser; the
   modern expectation is "does not execute", but I did not run one.
4. **Upstream OMP's own relay** (`local-relay.ts`) treatment of absent `Origin`, for a
   comparison citation. Reason: upstream source is present read-only at
   `/tmp/caw-poc/oh-my-pi`, but only `host.ts`/`protocol.ts` were read for this audit;
   the relay comparison is out of scope of what I exercised.
5. **`tailscale serve` injected headers and its CORS on the Serve origin.** Reason: no
   `tailscale` CLI invocation and no tailnet origin from this sandbox; the claim in
   WORKING §B (permissive CORS on the Serve origin, device-token-gated) is quoted from
   the repo's own research document, not observed.
6. **The `/guest` page under the API-origin CSP** (SEC-9): I verified the header is
   present and that the page contains an inline script, but did not load it in a browser
   to observe the blocked-script console error.
7. **`PLAYWRIGHT` end-to-end confirmation** of any of the above: Playwright browsers are
   not installed (`ls ~/.cache/ms-playwright` → missing), so no e2e suite was run in this
   audit.

---

## Areas with nothing to report, and what was checked

- **`packages/collab-protocol` crypto.** `codec.ts:24-48` uses 32/48-byte secrets
  (AES-256-GCM key ‖ optional 16-byte write token) with `crypto.getRandomValues`; IV is
  12 bytes fresh per seal. `envelope.ts` packs the 4-byte BE peer id only. No padding,
  no nonce reuse path, no key export (`importKey(..., false, ...)`). Nothing found.
- **`packages/relay` content-blindness.** No decrypt, no payload inspection, no payload
  logging; only the routing prefix is rewritten. Nothing found.
- **`packages/relay/src/static.ts` traversal.** `safeSegments` (one decode, NUL +
  backslash + `.`/`..` + separator checks) plus `O_NOFOLLOW` + `fstat` + `/proc/self/fd`
  containment. Raw-socket probes (bypassing client normalisation, so the server's own
  parser is the only defence): `/../…`, `/sub/../../…`, `/sub/%2e%2e/%2e%2e/…`,
  `/%2e%2e/…`, `/sub/../a.txt`, `/./index.html` → all **400**; `/index.html` → 200.
  Double-encoded `/%252e%252e%252f…` → 404 (inert filename). Symlink inside the root →
  404. Directory → 404. Nothing found.
- **`apps/server/src/static-web.ts` (new).** Same segment policy plus `//` and
  Windows-absolute guards. Raw-socket probes: `/../etc/passwd`, `/..%2f..%2fetc/passwd`,
  `/assets/../../etc/passwd`, `/guest/../../etc/passwd`, `//etc/passwd`, `/%00index.html`,
  `/a%5cb`, `/C:/windows` → all **400**. `/etc/passwd` → **200 SPA shell** (512 bytes,
  `isIndexHtml=true`), i.e. the SPA fallback, *not* the file — deliberately re-checked
  because a bare `200` on `/etc/passwd` is exactly what a traversal success looks like.
  Nothing found.
- **`apps/server/src/store.ts`.** JSONL, `O_NOFOLLOW`, `0600`, serialised append queue,
  `fsync` per row, `O_APPEND`. Nothing found.
- **`apps/server/src/config.ts`.** zod-bounded, `insecureCookies` refuses a non-loopback
  host, `allowedRoots` must be absolute with `~` expansion. Nothing found.

---

## Reproduction appendix

Probes are bundled with the repo's own esbuild and run with node; they live in `/tmp`
and never write to the repository.

```bash
cd /home/heheboiz/data/coding-agent-web
# path policy (all 17 adversarial inputs + listing)
node_modules/.bin/esbuild /tmp/probe2.ts  --bundle --platform=node --format=esm \
  --outfile=/tmp/probe2.mjs && node /tmp/probe2.mjs

# API auth / CSRF / rate limit  (needs a resolver for fastify+zod)
node_modules/.bin/esbuild /tmp/probe4.ts --bundle --platform=node --format=esm \
  --outfile=/tmp/probe4.mjs \
  --banner:js="import { createRequire } from 'node:module'; const require = createRequire('$PWD/package.json');" \
  && node /tmp/probe4.mjs

# relay static traversal + WS upgrade policy            → /tmp/ppwork/probe5.mjs
# raw-socket traversal (no client normalisation)        → /tmp/ppwork/probe6.mjs
# WS role/room-id rejection                             → /tmp/ppwork/probe7.mjs
# single-origin relay: unauth host accepted             → /tmp/ppwork/probe19.mjs
# guest cap + frame cap                                 → /tmp/ppwork/probe22/23.mjs
# markdown XSS through jsdom (both clients)             → /tmp/ppwork/probe15.mjs
# tmux/argv injection end-to-end                        → /tmp/ppwork/probe9.mjs, probe26.mjs
# log redaction shapes                                  → /tmp/ppwork/probe20.mjs

# local trust
ls -ld  ~/.local/state/coding-agent-web ~/.local/state/coding-agent-web/overlays
ls -l   ~/.local/state/coding-agent-web; umask

# built output (run after any rebuild; asset names change)
grep -rIl 'my\.omp\.sh' apps/web/dist packages/guest/dist
grep -rIl 'um\.can\.ac' apps/web/dist packages/guest/dist
grep -rIoh 'https\?://[a-zA-Z0-9._-]*' apps/web/dist packages/guest/dist | sort | uniq -c | sort -rn
```

Raw tmux control for the injection section:

```bash
tmux -L cav1 new-session -d -s a 'echo' 'hi; touch /tmp/caw-f1'     # f1 NOT created
tmux -L cav1 new-session -d -s b 'touch /tmp/caw-f2; echo x'        # f2 created
tmux -L cav1 list-panes -a -F '#{session_name} | #{pane_start_command}'
# → a | "echo" "hi; touch /tmp/caw-f1"     b | "touch /tmp/caw-f2; echo x"
```

---

## Suggested triage order

1. **SEC-2** (relay `host` role unauthenticated on the now-shared API port) — one cookie
   check in the upgrade handler.
2. **SEC-1** (link in the guest's address bar/history) — delete one line.
3. **SEC-5** (global lockout locks the owner out) — ceiling the global counter.
4. **SEC-3** (no view-only link) — surface the existing `access` parameter.
5. **SEC-7, SEC-4, SEC-8, SEC-9, SEC-10, SEC-6** — hardening + one availability bug.
