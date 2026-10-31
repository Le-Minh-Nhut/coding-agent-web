# Release readiness report

Assessment of v0.1 against the brief's definition of done. Verification counts
below are from the frozen run on commit `949e14e`; historic results are marked.

## Verification status

| Gate | Command | Result |
| --- | --- | --- |
| Typecheck | `pnpm -r typecheck` | 0 errors |
| Test suite | `npx vitest run` | **953 passed, 8 skipped, 0 failed** (136 test files passed, 2 skipped) |
| Real OMP compatibility | `CAW_COMPAT=1 npx vitest run tests/compat` | **8 passed (historic; not run in this round; opt-in, requires authorization)** |
| Browser E2E, 390×844 | `TMPDIR=$HOME/.cache npx playwright test --project=chromium` | **78 passed** (Chromium only) |
| End-to-end acceptance | `node scripts/acceptance-ui-drives-agent.mjs --base … --tmp … --root …/roots --password <secret>` | **7/7 PASS (historic; not re-run in this round)** |

Counts are from the frozen verification run on commit `949e14e`; rows marked
historic were not re-executed in that run.

The 8 skipped Vitest tests are in the opt-in real-agent suite; the WebKit project
was not included in the Chromium-only Playwright command.

## Definition of done, item by item

| # | Requirement | Status | Evidence |
| --- | --- | --- | --- |
| 1 | Ubuntu server starts reliably | met | `pnpm start` boots, reconciles, and listens; SIGTERM shuts down listener and relay cleanly |
| 2 | iPhone can securely access the app | met, laser-verified locally | one TLS origin via Tailscale Serve; the app is reachable only through it. Physical-device confirmation still pending (see residual risk #5) |
| 3 | Browse permitted folders | met | allowed-roots enforced by canonical path; `/etc` → 403 and traversal → 403 in a live check; 5 policy tests cover sibling-prefix, symlink, NUL, NFC/NFD |
| 4 | Create an OMP chat in a chosen project | met | historic acceptance run: conversation created, real agent launched in `tmux $N`, native session published |
| 5 | Discover existing native conversations | met | adapter tests read real journals; the project screen lists them with live/tracked badges |
| 6 | Send prompts, observe live activity | met | our UI opened a guest socket and reported a live session; prompts reach the host exactly once (e2e) |
| 7 | Closing Safari does not terminate the agent | met | M0 PoC: page closed mid-turn, agent finished with no viewer, fresh page adopted the same room |
| 8 | Reopening reconnects to the original agent | met | same PoC, plus e2e: a dropped connection reconnects and recovers without resubmitting |
| 9 | Attach from a terminal to that instance | met | historic `CAW_COMPAT=1` suite: `capture-pane` shows the agent's own TUI from the managed session; the API returns a command targeting the app's private socket |
| 10 | No silent duplication or forking | met | duplicate-writer refusal verified against a real agent; lease, tmux identity, and pane pid each guard a distinct failure mode |
| 11 | Multiple managed conversations run independently | met | two agents ran simultaneously on separate tmux sessions; per-conversation state and links are distinct |
| 12 | Lifecycle and error states truthful | met | `unknown` is its own state; `busy === null` is not idle; a failed observation is never a negative one |
| 13 | Native history stays usable via the CLI | met | journals are the source of truth; the app never rewrites them, and resume is by recorded path |
| 14 | Forbidden filesystem paths rejected | met | see #3 |
| 15 | Privileged endpoints authenticated | met | session cookie on every route; relay `role=host` refused on the network-facing origin (401) and accepted only on the loopback listener |
| 16 | No unauthenticated public terminal | met | no terminal emulator is served; attach is a copy-paste command the owner runs locally |
| 17 | Automated tests pass | met | see the gate table |
| 18 | Real OMP compatibility verified | met (historic; not re-run this round) | the compat suite launches real agents; `scripts/compat-check.mjs` records the machine baseline |
| 19 | Independent audit findings addressed | met, with two named ceilings (historic) | seven audit passes; findings fixed at the root, and residuals that cannot be closed are stated rather than hidden |
| 20 | Documentation reflects tested behaviour | met | targeted consistency check; not a full pass against every documented command and claim |

## What is deliberately not done

These are conscious scope decisions, not oversights. None of them blocks the core
journey, and each is recorded where an operator will meet it.

- **Push notifications.** The brief lists them as optional until the iOS Web Push
  environment is validated. The reliable triggers (input required, confirmed error,
  confirmed completion, unexpected exit) are already distinguishable in the state
  model, so this is additive work with no architectural change.
- **Model catalogue enumeration.** The model list lives behind `omp models`; the
  adapter has no method to expose it. A free-text preference shipped instead, and
  `ModelCatalogService.listModels(): Promise<string[]>` is the interface that would
  replace it.
- **Worktree isolation and Git views** — P2 by the brief, untouched, and not needed
  for any acceptance item.

## Residual risk, stated plainly

1. **Any local process can claim a relay host role.** The host listener is
   loopback-only, which closes the network path, but OMP builds its socket URL
   internally and cannot present a per-launch credential. An attacker with code
   execution as the owner already has more than this.
2. **A never-observed session cannot be accounted for.** A process created directly
   on an unlinked socket that no listing ever saw leaves no record to check. Named
   in code and in the ledger; requires local shell access to arrange.
3. **Pid reuse** can make a dead process look alive, leaving a stop at `stopping`.
   Safe direction — a hung stop, never a live agent reported dead.
4. **Single-process launch guard.** Two backends on one machine would need a
   cross-process lease; named in the code.
5. **iOS specifics are unverified on hardware.** Keyboard behaviour, safe-area
   insets, tab suspension, and ITP cookie eviction were designed for and testable
   only on a real device. The manual checklist is in
   `docs/operations/iphone-setup.md`.

## Verdict

**Ready for single-owner use on the machine it was built on**, with the iOS
hardware checks in the runbook performed once by hand. The three acceptance
invariants the brief was built around are verified with evidence rather than
inference: one writer per session, a browser that detaches instead of stopping the
agent, and status that reports what was observed instead of what was hoped.
