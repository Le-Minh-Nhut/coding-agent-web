# Coding Agent Web

Drive your own coding agents from your phone, while the real work stays on your laptop.

Coding Agent Web is a single-owner, self-hosted workspace for [OMP (Oh My Pi)](https://github.com/can1357/oh-my-pi)
sessions running on your Ubuntu machine. Browse projects, start a chat, send a
prompt, close Safari, come home, and attach a terminal to the *same* running
agent. Nothing is mirrored, nothing is delegated to a third party, and no
transcript is ever mistaken for a live process.

```
 iPhone (Safari / PWA)
        │  https://<machine>.<tailnet>.ts.net   ← Tailscale Serve terminates TLS
        ▼
 Coding Agent Web server (loopback)
        │  ── omp collab link ──► room link (bearer credential, handed to the browser once)
        │  ── tmux new-session ─► managed OMP process
        ▼
 Private Collab relay (loopback, content-blind)
        │  sealed frames only
        ▼
 OMP agent in tmux  ←── tmux -S <stateDir>/tmux.sock attach -t <session>   (terminal continuity: the same process)
```

## Why it is built this way

A coding agent is a long-running process with filesystem and shell access. The
browser must therefore be a **controller**, never the owner of the agent's
lifetime. This project commits to four invariants:

1. **One writer per session.** A native OMP session has at most one process
   writing it. Starting a second one is refused, not silently forked.
2. **Closing the browser detaches a viewer.** It never stops an agent.
3. **Status is reported from observed facts.** `unknown` is a valid answer and
   is shown as such; "not streaming" is never rendered as "finished".
4. **A room link is a bearer credential.** It is never logged, stored, or
   pushed anywhere.

Design and evidence: `docs/adr/0001-runtime-architecture.md`,
`docs/architecture/session-lifecycle.md`, `docs/research/`.

## Requirements

| Component | Source/docs baseline | Notes |
| --- | --- | --- |
| Ubuntu | 26.04 LTS (Linux 7.0) | any modern Linux with tmux will do |
| OMP | **18.15.0** | Installed on owner's machine; `pnpm compat` read-only: 17 ok / 1 warn / 0 fail. Full real-agent acceptance not run against 18.15.0. CI 18.12.2 is opt-in historical/manual (`workflow_dispatch`). |
| tmux | 3.6 | required — it is what keeps agents alive |
| Node.js | 20.19+ | server and tooling |
| pnpm | 10.x | workspace manager |
| Tailscale | 1.104.1 (unverified this session) | secure remote access from the phone |

## Quick start

```bash
git clone git@github.com:Le-Minh-Nhut/coding-agent-web.git
cd coding-agent-web
pnpm install
node scripts/build-guest.mjs          # builds the browser guest client
pnpm --filter @caw/web build          # builds the web app
pnpm test                              # unit, integration and web tests (free; no agent is spawned)

# Repo-root caw.config.json is auto-discovered by pnpm start.
cat > caw.config.json <<'JSON'
{
  "allowedRoots": ["/home/you/projects", "/home/you/data"],
  "maxActiveAgents": 3,
  "publicOrigin": "https://my-workstation.tailnet-name.ts.net"
}
JSON
pnpm start
# Config stored elsewhere: absolute path override
CAW_CONFIG=/absolute/path/to/caw.config.json pnpm start
```

First start writes a random bootstrap token to
`<stateDir>/setup-token` (mode 0600) and prints that **path** to server stdout,
never the token itself; read it with `cat <path>`. It expires after
15 minutes and can authenticate once to open a setup-only session; choose a
password of at least 12 characters, different from the token, to finish setup.
That session can only set the password or log out. A normal password login works as before.
Existing installs with the old token-derived password hash remain valid and are
marked as legacy in `auth-password.json`; change that credential after login
with `POST /api/auth/change-password` if you want to replace it.
If you forget the password, stop the service and run
`pnpm --filter @caw/server exec tsx src/auth.ts reset` locally. It writes a new
15-minute setup token to `<stateDir>/setup-token` and prints only that path, and
replaces only the auth record. Restart the
service, log in with that token, and set a new password. Password changes revoke
all sessions except the current one. The reset command auto-discovers repo-root
`caw.config.json` and honours `CAW_CONFIG`/`CAW_STATE_DIR`, so it uses the same
state directory as the service without extra flags; it runs locally, not over HTTP.
Then open `http://127.0.0.1:8791` locally, or follow
`docs/operations/iphone-setup.md` to reach it from your phone.

`publicOrigin` is the origin your phone visits. It matters because the live
session deep link handed to the browser is built from it — leave it out and the link
points at a loopback port your phone cannot reach. Setting `publicOrigin` alone is
sufficient for the phone's browser to open the relay WebSocket; loopback browser
origins (`http://localhost:<port>`, `http://127.0.0.1:<port>`, `http://[::1]:<port>`
and their `https:` variants) are always allowed for machine-local browser debugging.
`relayAllowedOrigins` remains available if you need additional, different browser
origins (e.g. a separate public web origin), but is not required for the standard
single-origin Tailscale setup.

It must be a bare origin — scheme and host only, no trailing slash, path, query,
or fragment: `https://my-workstation.tailnet-name.ts.net`, not
`https://my-workstation.tailnet-name.ts.net/`.
Verify the whole loop yourself:

```bash
pnpm compat                            # machine capability probe (spawns nothing)
TMPDIR=$HOME/.cache pnpm test:e2e       # mobile UI, 13 specs
CAW_COMPAT=1 pnpm vitest run tests/compat # real OMP; launches agents
node scripts/acceptance-ui-drives-agent.mjs --base <origin> --tmp <scratch-dir> --root <scratch-dir>/roots --password <secret>
```

The last one drives your real UI against a real agent and prints a PASS/FAIL line
per acceptance criterion. It is the check that proves the product works, so run it
after any change to the link path or the launch flow.

## Documentation

- 🇻🇳 [Hướng dẫn sử dụng (tiếng Việt)](docs/HUONG_DAN_SU_DUNG.md)
- `docs/operations/ubuntu-setup.md` — install, configure, run as a service
- `docs/operations/iphone-setup.md` — Tailscale Serve, PWA install, day-to-day use
- `docs/operations/recovery.md` — what to do when something breaks
- `docs/operations/troubleshooting.md` — symptom-driven fixes
- `docs/architecture/overview.md` — how the pieces fit
- `docs/architecture/session-lifecycle.md` — ownership, states, reconciliation
- `docs/architecture/security-model.md` — threat model and controls
- `docs/research/` — the evidence behind every integration decision
- `docs/audits/` — independent reviews

## Development

```bash
pnpm typecheck
pnpm test
CAW_COMPAT=1 pnpm vitest run tests/compat   # real OMP; opt-in, may spend credits
pnpm compat                                 # capability probe (spawns nothing)
```

Working rules for contributors and agents: `AGENTS.md`.

## Status

Honest status lives in `docs/operations/implementation-status.md`, including what
is verified, what is unverified, and what is known to be incomplete. Nothing in
this repository claims a capability that was not observed on a real machine.

## License

MIT. The vendored browser guest client in `packages/guest` is derived from
`can1357/oh-my-pi` (MIT, Copyright (c) 2025 Mario Zechner, 2025-2026 Can Bölük,
2026 Stencil Labs, Inc.) — see `packages/guest/NOTICE`.
