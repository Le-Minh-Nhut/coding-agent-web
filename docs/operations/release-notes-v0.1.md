# Release notes — v0.1

First working version of Coding Agent Web. What it does, what was actually
verified, and what you should not expect from it.

## What it is

A single-owner, self-hosted workspace that lets you drive OMP coding agents on
your Ubuntu laptop from an iPhone while the agents keep running there. The phone
is a controller; execution, files and credentials stay on the machine.

The invariant everything is built around:

> **One native OMP session has at most one writer, and the app never creates a
> second one by accident.**

## What you can do with it

- Browse allowed folders, add a project, and start a chat in it from the phone.
- Discover existing OMP sessions for a project and resume one.
- Watch a turn stream — assistant text, tool cards, subagent panel — and send a
  prompt or an interrupt.
- **Install it to the Home Screen.** A same-origin manifest with `display:
  standalone`, Apple touch icons, and safe-area padding for the notch and home
  indicator, so it launches without browser chrome.
- **Choose the model per conversation.** The change applies when that
  conversation's agent next launches, and the UI says so rather than implying a
  live switch; the effective model always comes back from the registry, so you see
  what actually ran.
- Answer a host question (approval) when one arrives, and read the activity
  timeline for a conversation.
- Walk away. Close Safari, and the agent keeps working.

## How it works, in one picture

```
iPhone ── Tailscale Serve (TLS) ──► app origin:8791
                                        │  UI, API, guest room joins
                                        │
                              loopback:8792  (host role only)
                                        │
                                    OMP agent in tmux ── native session journal
```

Agents live in a tmux server the app owns, so they outlive your browser and are
attachable from a terminal. Conversations are the OMP session files themselves,
so a chat started on the phone is usable from the CLI afterwards.

## Verified, with the evidence

| Claim | Evidence |
| --- | --- |
| Our UI drives a real agent end to end | `node scripts/acceptance-ui-drives-agent.mjs` → 7/7 PASS: login, conversation created, real agent launched (`tmux $N`), native session published, live link minted, guest socket open, screen reports "Connected — no turn in flight" |
| Closing the browser does not stop the agent | M0 PoC: page closed mid-turn, agent finished with no viewer attached, a fresh page adopted the same room without resubmitting |
| Terminal continuity | `CAW_COMPAT=1 npx vitest run tests/compat` → managed launch, `capture-pane` shows the agent's own TUI, duplicate-writer refusal, stop by recorded id, six reconciliation scenarios |
| Mobile UI behaves at phone size | Playwright, Chromium 390×844 → 24 passed, incl. composer bottom-anchored, touch targets ≥40 px, no horizontal scroll, keyboard-shrink survival |
| Prompt and reconnect behavior | Mock-host E2E: one prompt reaches the host, then reconnect does not resubmit it; disconnected sends are refused. The Collab wire has no request ID, so a manual retry after ambiguous delivery can enqueue duplicate work. |
| Status never invents success | `busy === null` renders as unknown, not idle; a dropped socket is "reconnecting", never "stopped"; a failed observation is never a negative one |
| Path policy holds | sibling-prefix, symlink escape, traversal, NUL, NFC/NFD, non-directory all refused; live check: `/etc` → 403, traversal → 403 |
| Relay host role is not network-reachable | probe: app-port `role=host` → **401**, app-port `route=guest` → accepted, loopback relay-port host → accepted |
| Bearer link keeps its secret | decoded from a minted link: 48 bytes = 32-byte AES key + 16-byte write token; room id and secret byte-identical after the origin rewrite |
| Installs as an app on iOS | served manifest is `application/manifest+json` with `display: standalone` and `start_url`/`scope` at the root; `apple-touch-icon.png` (180×180) and 192/512 icons return 200; built HTML and manifest contain **zero** off-origin URLs |
| Model is choosable and honestly applied | `PATCH /api/conversations/:id/model` → 200 with the preference; empty/invalid → 400; stop → restart → effective model reflects the preference read back from the registry; the UI keeps *effective model* and *saved preference* distinct and says a change applies on the next launch |
| Restart works after a stop with no history yet | on a fresh server: create → stop → restart → 200 `idle`, while an explicit resume of an unknown session id is refused 404 instead of silently starting a different one |
| Whole suite | `npx vitest run` → 334 passed \| 8 skipped | `pnpm -r typecheck` → clean |

## Defects found by audit and fixed

Two independent audit rounds plus a post-fix verification and a final pass. The
ones that mattered:

- **P0 duplicate-writer race** — the launch guard was check-then-act; concurrent
  requests could both start a writer for one session. Now serialized with keyed
  reservations, lease re-checked inside the critical section, and a post-launch
  persistence failure undoes the process.
- **P0 tmux id reuse** — `$N` is unique only within one tmux server lifetime, so
  adopt/stop could hit a stranger's session. Every action on a recorded id now
  requires the recorded tmux server identity to match the live one.
- **P1 link crossing a session switch** — the link route now compares generation
  and instance with the row it selected, and fails closed when the registry omits
  that evidence rather than fabricating it.
- **P1 unknown rendered as idle / failed observation rendered as fact** — only
  `busy === false` may mean idle, and a failed probe stays unknown.
- **P1 relay host role unauthenticated** — anyone on the tailnet could claim a
  room's host role, because Serve rewrites remote callers to loopback. Host
  upgrades moved to a private loopback listener that Serve does not proxy.
- **P1 link origin** — discovered by our own acceptance script: the security fix
  above changed what OMP puts in the *browser* link, so the phone was handed a
  URL it could not reach. The link origin is now rewritten to the configured
  public origin with the room id and secret preserved byte-for-byte.
- **P1 web UI reopened its socket every render** — 44 sockets in 9 seconds, each
  dropped before a welcome. Fixed with a ref-stable frame handler.
- **P1 restart without journal** — model changes now restart into a fresh session when no native journal exists; explicit unknown-session resumes return `not_found` (404).

Full findings, reproductions and verdicts: `docs/audits/round-1-architecture.md`,
`round-2-security.md`, `round-3-post-fix-verification.md`,
`round-4-final-verification.md`.

## Known limitations, stated plainly

These are real and are not going to be fixed before anyone uses this:

1. **Any process on the laptop can claim a relay host role.** The host listener
   is loopback-only, which closes the network path, but it is not authentication
   of our managed agent: OMP builds its socket URL internally and cannot present
   a per-launch credential. An attacker who can already run code as you on this
   machine has your shell regardless.
2. **A second backend process on the same machine is not protected.** The launch
   serialization is in-process. The native-session lease and tmux identity guard
   against a foreign writer, but two copies of this app would need a
   cross-process lock.
3. **Only Linux lease detection is implemented.** On other platforms the lease
   probe returns `unknown`, which blocks launches rather than guessing.
4. **iOS specifics are unverified on a real device.** All browser evidence is
   Chromium at a phone viewport. The software keyboard, safe-area insets, tab
   suspension and ITP cookie eviction need a physical iPhone, and the checks are
   listed in `docs/operations/iphone-setup.md`.
5. **One reconciliation scenario is qualified.** OMP does not write a journal
   without a prompt, so "a real OMP-written journal survives a failure scenario"
   is seeded rather than organic. Recorded in
   `docs/audits/reconciliation-verification.md`.
6. **Approvals are handled but not exercised against a host that asks.** The
   queue and the single-response latch are tested against crafted frames; no real
   OMP host has raised a question to it yet.
7. **`tailscale serve` needs a one-time privileged grant.** Without it the app
   runs loopback-only and reports that browser features are unavailable instead
   of pretending.
8. **Never use `tailscale funnel`, and never proxy the relay port.** Both would
   publish a remote-control surface for a shell.

## Upgrading OMP

`collab.*` is not a stability guarantee. After any OMP upgrade:

```bash
pnpm compat                     # capability probe, spawns nothing
pnpm test                       # unit + integration
CAW_COMPAT=1 pnpm vitest run tests/compat
```

Re-record the baseline in `docs/research/omp-compatibility.md`. If the capability
probe fails, read that document before starting the app: the duplicate-writer
guard depends on details of OMP's session store.
