# Ubuntu setup

Everything here runs as your normal user. The only privileged step in the whole
product is the one-time Tailscale Serve grant, and it is optional — without it
the app still runs, reachable only from the laptop itself.

## 1. Prerequisites

```bash
# Node 20.19+ and pnpm
node -v            # expect v20.19 or newer
pnpm -v            # expect 10.x

# tmux — required; without it there is no process that outlives the browser
tmux -V

# OMP — the agent runtime
omp --version      # tested baseline: omp/18.12.2
```

If OMP is missing, install it per the upstream instructions
(`https://github.com/can1357/oh-my-pi`), then confirm `omp models` lists a model
you can actually use. Coding Agent Web never stores provider credentials: the
agent process inherits your existing OMP authentication.

Verify the machine against our expectations:

```bash
pnpm compat
```

This spawns no agents and costs nothing. It reports OMP/tmux versions, the
Collab CLI surface, the session store, and whether writer-lease visibility works
on this platform. `warn` is information; `FAIL` means the product cannot keep its
invariants here.

## 2. Install

```bash
git clone git@github.com:Le-Minh-Nhut/coding-agent-web.git
cd coding-agent-web
pnpm install
node scripts/build-guest.mjs       # browser guest client -> packages/guest/dist
pnpm --filter @caw/web build       # web app -> apps/web/dist
```

## 3. Configure

Create `caw.config.json` in the repository root (git-ignored):

```json
{
  "host": "127.0.0.1",
  "port": 8791,
  "relayPort": 8792,
  "publicOrigin": "https://my-workstation.tailnet-name.ts.net",
  "allowedRoots": ["/home/you/projects", "/home/you/data"],
  "maxActiveAgents": 3,
  "relayAllowedOrigins": ["https://my-workstation.tailnet-name.ts.net"],
  "logLevel": "info"
}
```

Rules that matter:

- **`allowedRoots` is an allowlist, not a suggestion.** Nothing outside these
  directories can be browsed, and paths are canonicalized (symlinks resolved)
  before the check. Start narrow; widen deliberately.
- **Keep `host` on `127.0.0.1`.** Use Tailscale Serve for remote access instead
  of binding to `0.0.0.0`.
- **`maxActiveAgents`** caps how many agents can run at once. Exceeding it
  returns `conflict_limit` instead of thinning your machine's resources.
- **`publicOrigin`** is the browser-facing origin the phone visits (e.g. your
  `https://my-workstation.tailnet-name.ts.net` Serve origin). Empty by default,
  which derives `http://127.0.0.1:<port>` for local development. In production
  over Tailscale Serve, set it to your tailnet HTTPS origin so live-session links
  point at an origin the phone can reach and the browser's CSP allows. Must be an
  absolute http(s) origin with no path, query, or fragment.
- **Two listeners, two privileges.** The table above shows `relayPort`, and it is
  real: the app serves the UI, the API **and guest** room joins on `8791`, while the
  relay opens a second listener on `127.0.0.1:8792` that is the **only** place a
  `role=host` upgrade is accepted. Our managed agents connect there.
  This separation is a security control, not tidiness. `tailscale serve` rewrites
  the peer address of every remote caller to loopback, so if the host endpoint were
  reachable through the proxy, anyone on your tailnet could claim the host role of a
  room. `relayPort` must therefore never be proxied (see
  `docs/operations/iphone-setup.md`).
  Residual risk, stated plainly: any process already running on this machine that can
  reach `127.0.0.1:8792` can also claim a host role. That is a topology control, not
  authentication of the managed agent — OMP builds its socket URL internally and
  cannot present a per-launch credential.

Environment variables override the file (`CAW_PORT`, `CAW_ALLOWED_ROOTS`
colon-separated, `CAW_MAX_ACTIVE_AGENTS`, …). Never commit secrets; there is
nothing secret in this file.

## 4. First run

```bash
pnpm start
```

The first start prints a random bootstrap token to server stdout. It expires
after 15 minutes and can authenticate once to open a setup-only session; choose
a password of at least 12 characters, different from the token, to finish
setup. Until set, that session may only call the set-password route or log out;
other API routes return `403` with error code `unauthorized`. The password is
stored as a scrypt hash in `auth-password.json` with `0600` permissions. The
session cookie remains the same after setup; login with new password returns an
authenticated session.

The setup-only restriction runs in a global `onRequest` guard for every `/api/*`
request except `POST /api/auth/set-password` and `POST /api/auth/logout`, so
routes added later remain blocked by default until the password is set.

Password API contract:

| Route | Request | Success | Errors | Session/cookie effect |
| --- | --- | --- | --- | --- |
| `POST /api/auth/login` | `{ "password": string }` | `200 { "ok": true, "data": { "status": "authenticated" | "password_setup_required", "csrfToken": string, "expiresAt": ISO-8601 } }` | `400 bad_request` malformed body; `401 unauthorized` invalid/expired credential | Mints `__Host-caw_session`; pending token gets setup-only session, existing password gets normal session. |
| `POST /api/auth/set-password` | Pending session cookie, `X-CAW-CSRF`, `{ "password": string }` (12–1024 chars; must differ from setup token) | `200 { "ok": true, "data": { "status": "authenticated", "csrfToken": string, "expiresAt": ISO-8601 } }` | `400 bad_request` invalid/equal-to-token password; `401 unauthorized` no session; `403 unauthorized` setup not pending; `409 conflict_owner` expired/consumed pending record | Keeps setup session cookie, CSRF token, expiry and session ID; promotes current session; invalidates pending token. |
| `POST /api/auth/change-password` | Normal session cookie, `X-CAW-CSRF`, `{ "currentPassword": string, "newPassword": string }` (new password 12–1024 chars) | `200 { "ok": true, "data": { "changed": true } }` | `400 bad_request` malformed body; `401 unauthorized` missing session or wrong current password; `403 csrf` missing/invalid CSRF | Keeps current cookie/session; revokes every other live session so sessions authenticated with old credential cannot remain active. |
| `POST /api/auth/logout` | Session cookie, `X-CAW-CSRF` | `200 { "ok": true, "data": { "loggedOut": true } }` | `401 unauthorized` no session; `403 csrf` invalid CSRF | Revokes all sessions and clears current cookie. |

Responses use the common `{ok,data}` / `{ok:false,error:{code,message}}` envelope.
The login client distinguishes setup from normal access using `data.status`;
the cookie itself never exposes the bootstrap token.

Older installations have `auth-password.json` in the original `{salt,hash}`
shape, where the hash was made from the first-run token. Upgrade marks this
record `kind: "password", legacy: true` without changing its salt or hash, so
the current credential keeps working; change it via the authenticated password
route. No forced migration is required.

Forgotten password recovery is local-only: stop the server, then from the repo
root run `pnpm --filter @caw/server exec tsx src/auth.ts reset` (set the same
`CAW_STATE_DIR` or `CAW_CONFIG` as the service if non-default). The command
replaces only `auth-password.json`, leaves other state files untouched, and
prints a fresh 15-minute bootstrap token to stdout. Restart the server, then
log in with that token and set a new password. Sessions live only in server
memory, so stopping the server discards all sessions.

State lives in `~/.local/state/coding-agent-web/` (metadata, password hash `auth-password.json`, and the private tmux socket `tmux.sock`); override with `CAW_STATE_DIR`.

- **Private tmux socket:** The app manages agents through its own private tmux
  server on `<stateDir>/tmux.sock` (`~/.local/state/coding-agent-web/tmux.sock` by
  default). This provides two safety invariants:
  1. The owner's personal tmux sessions remain completely isolated — the app never
     lists, modifies, or kills sessions it did not launch, and names cannot collide.
  2. A session's recorded `$N` ID is unique only within a single tmux server
     lifetime. By owning the server and recording its `#{start_time}` server
     identity alongside `$N`, the app can safely verify identity across restarts.
- **Attaching manually:** To attach to an agent from a laptop terminal, point
  tmux at the private socket:
  ```bash
  tmux -S ~/.local/state/coding-agent-web/tmux.sock attach -t <tmuxSessionId>
  ```
  (The web UI's "How to attach" card and `GET /api/conversations/:id/attach` return
  this exact command with the session's recorded `$N`).

## 5. Run as a user service

`~/.config/systemd/user/coding-agent-web.service`:

```ini
[Unit]
Description=Coding Agent Web
After=default.target

[Service]
Type=simple
WorkingDirectory=%h/data/coding-agent-web
ExecStart=/usr/bin/env pnpm start
Restart=on-failure
RestartSec=3

[Install]
WantedBy=default.target
```

```bash
systemctl --user daemon-reload
systemctl --user enable --now coding-agent-web
systemctl --user status coding-agent-web
journalctl --user -u coding-agent-web -f
```

Run it as a user unit, never as root: the agents it supervises must run with
your filesystem permissions, not the system's.

## 6. Upgrade procedure

```bash
cd coding-agent-web
git pull
pnpm install
node scripts/build-guest.mjs
pnpm --filter @caw/web build
pnpm compat                      # confirm the OMP surface is unchanged
pnpm test
systemctl --user restart coding-agent-web
```

If `pnpm compat` reports `FAIL` after an OMP upgrade, stop and read
`docs/research/omp-compatibility.md` before restarting: the product's duplicate
-writer guard depends on details of OMP's session store.
