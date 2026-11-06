# Final product quality report — round 56

Commits reported on: **6836d7d**, **420ffce**, **29b0b73** (parent `7385320`). Branch `main`,
pushed to `origin/main`. The three are one round: the feature, the report, and an
audit fix that landed after it. Every number below was produced by a command run in this round; a
claim that was not measured says so in §J.

## A. Executive summary

Three defect classes from the redesign audit were fixed, plus the configurable
agent limit that was moved into this round's scope.

1. **Duplicate tool execution.** An assistant turn that requested a tool was shown
   twice: a raw `[Tool call: …] {json}` card *and* the grouped activity card built
   from the result row. Fixed so exactly one representation appears, and — the
   part that matters — so the request still renders when it is the only record of
   the call (saved history, host-shared journals).
2. **Agent concurrency limit.** `maxActiveAgents` was a startup constant. It is now
   a persisted, authenticated, server-enforced setting read at each admission, so
   changing it needs no restart and lowering it never disturbs a running agent.
3. **Advisor issue lifecycle.** Advisor notes carry no status field upstream, so
   the lifecycle is derived from evidence and nothing else: a spoken claim of a fix
   reaches "claimed fixed, unverified" and stops; a passing test cannot resolve a
   note; the header chip counts only blockers that are still standing.

An adversarial audit of the first cut found four real holes in (3) and one major
one in (1); all five are fixed with regressions. Details in §B.

## B. Bug matrix

| ID | Severity | Reproduced | Root cause | Fix | Test | Verdict |
|---|---|---|---|---|---|---|
| R02 | P1 | yes — `MessageRow` rendered the request block *and* the group; live rows carried no `blocks` so the flattened call sat in the row text | `renderTranscriptBlock` always drew a `toolCall` block; `liveMessage` set `blocks` only for entries | Request renders `null` when a result row for its call id is in the same list; live rows now carry `blocks` | `round56-tool-presentation.test.tsx` (9) | fixed |
| AUD-1 | P1 | yes — `"cannot be fixed"` / `"is not fully fixed"` read as a claim of a fix | negation had to sit immediately before the verb | negation scanned across a 40-char window before the verb | `round56-advisor-lifecycle.test.ts` AUD-1 | fixed |
| AUD-2 | P2 | yes — `"I fixed the retry timeout…"` marked an unrelated note | one shared word was enough | match needs the majority of the note's identifying words, min 2 | AUD-2 | fixed |
| AUD-3 | P1 | yes — a spoken fix claim cleared the warn chip | chip keyed on any recorded blocker | chip keys on `standingBlockerCount` | AUD-3, `action-menu.spec.ts` | fixed |
| AUD-4 | P2 | yes — two notes collided on a 32-bit digest and shared one lifecycle | identity was a truncated hash | identity is the full normalized text | AUD-4 | fixed |
| D3 | P3 | yes — a request whose `arguments` were not a record could be hidden with its only copy | suppression ignored whether the paired card could carry the data | suppression also requires `isRecord(arguments)` | `round56-tool-presentation.test.tsx` (11) | fixed |
| D2 | P3 | yes — `block.intent` lost when not repeated as `arguments.i` | `pairToolArguments` copied only `arguments` | intent copied under the host's own `i` key | covered by presentation suite | fixed |
| D4 | P3 | yes — PUT could pair a fresh limit with a stale `overLimit` | occupancy read before the limit was stamped | read occupancy, then stamp the committed limit | `round56-agent-limit.test.ts` | fixed |
| D5 | P3 | n/a | dead contract fields I had added | removed `AgentLimitUpdateRequest`, `maxActiveSource`, `maxActiveBounds` | typecheck | fixed |
| — | P0 | yes (caught before commit) | adding `blocks` to live rows emptied an error-only row | append the failure reason as a block, as the entry path already did | `round56-tool-presentation.test.tsx` error cases | fixed |

## C. OMP control matrix

| Control | Native mechanism | Test evidence | Reliability verdict | Remaining limitations |
|---|---|---|---|---|
| Agent limit | persisted journal row + live read inside the serialized launch section | `round56-agent-limit.test.ts` (17), `supervisor.test.ts` (104), `scripts/verify-agent-limit.mjs` | enforced at admission, survives restart | occupancy is unknown during a rename race (pre-existing, `supervisor.ts:113`) |
| Advisor state | derived from transcript rows | `round56-advisor-lifecycle.test.ts` (32) | never overstates; `resolved` unreachable from transcript data | upstream carries no status field, so resolution needs a caller that knows the issue |
| Tool activity | grouped from result rows | `round56-tool-presentation.test.tsx` (9) | one representation per execution | `intent` only survives via `arguments.i` or the copied fallback |

## D. Advisor lifecycle

- **Source identity:** advisor name + full normalized note text. Re-wording creates
  a new issue (safe direction); identical text from two advisors stays distinct;
  a repeated note is one issue keeping the worse severity.
- **Resolution states:** `unresolved` (default) → `verifying` (a claim of a fix) →
  `resolved` (only from a caller-supplied labelled verification) → `reopened`
  (later contradicting evidence). `unknown` for an unestablishable identity.
- **Evidence rules:** a spoken claim is the weakest evidence and never resolves.
  A failing tool run that mentions the issue's own words is authoritative against
  it. Exit status is never treated as evidence about a note.
- **Reopen:** a later failed reproduction reopens a resolved issue and re-raises
  the chip.
- **Historical retention:** every note stays readable in every state; the panel
  lists them regardless.
- **Unsupported rechecks:** exported as data (`UNSUPPORTED_RECHECK_REASONS`) and
  rendered in the panel, so the absence of a check is never read as a pass.

## E. Frontend

Not re-screenshotted this round. The deployment check below is a real Chromium load
of the deployed origin, not a screenshot review:

- `https://…ts.net` → HTTP 200, title `Coding Agent Web`, React mounted, no
  horizontal overflow at 390×844.
- The only console error is the expected `401` from the pre-login auth probe.
- The deployed bundle contains the new UI (`Maximum concurrent agents`,
  `Persisted setting`, `still open among`, `What this view cannot verify`).

## F. Automated tests

| Suite | Result |
|---|---|
| Unit + integration (`npx vitest run`) | **1685 passed, 8 skipped** (189 files; 2 files skipped) |
| `pnpm -r typecheck` | clean (0 errors, 8 packages) |
| Chromium E2E (`playwright test --project=chromium`) | **115 passed, 0 failed** |

Pre-existing skips: 8 tests that require a launched agent or a real `systemctl`
unit, unchanged by this round. They are reported as skipped, not as passing.

## G. Performance

Not measured this round. The changes add one module-scope map lookup per admission
and one set construction per transcript render; neither is in a hot path. The E2E
suite includes the round-50 render-cost measurements (2000-row transcript, 50 tool
calls) and they pass.

## H. Security

- The limit routes sit behind the same authenticated hook as every other route;
  an unauthenticated read is `401` (asserted in `round56-agent-limit.test.ts`).
- Values are validated server-side against the schema bounds; `0`, `101`, `3.5`,
  `"3"`, `null`, `true` are refused with `invalid_setting` rather than clamped.
- No new shell invocation: the value is a number in the journal.
- `Referrer-Policy: no-referrer`, bearer-credential handling and path policy are
  untouched by this diff.

## I. Deployment

| Item | Value |
|---|---|
| Final Git SHA | `29b0b73` (pushed to `origin/main`) |
| Deployed revision | backend restarted from `6836d7d` source (unchanged by later commits); frontend `dist` rebuilt from `29b0b73` |
| JS asset | `assets/index-rJMq0QkO.js`, sha256 `694b8970e516494f39313d8d3ac9fa26001a9bd96f3b105637012ed7f3aa90ea` |
| CSS asset | `assets/index-Cwr45H40.css`, sha256 `9040b1fdf54c0293f20dae907526b114f8d0a75036a41b99afd2165b141036ac` |
| Served vs disk hash | identical (HTTPS-served bundle byte-matches `apps/web/dist`) |
| systemd | `active`; `MainPID 3831506` after restart |
| Tailscale Serve | `https://…ts.net` → `http://127.0.0.1:8791` |
| OMP processes preserved | **yes** — pane pids `1204278`, `2080435`, `2082046` identical before and after the restart; all three still alive |
| New backend route live | `GET /api/agent-limit` → `401` (not `404`), proving the new process is serving |

Caching: `index.html` is `cache-control: no-cache`; hashed assets are
`max-age=31536000, immutable`. A phone cannot receive a stale UI — it re-reads
`index.html`, which names the new hashes.

Rollback: the previous revision `7385320` is in git and the frontend is a build
artifact of it. A rollback directory I created mid-round was **deleted** because it
was copied after the build and therefore contained the *new* bundle — leaving it
would have been a false rollback artifact.

## J. Blocked / unverified

- **CI status is reported from the API, not assumed.** Run `42161036708` (for
  `6836d7d`) was **cancelled** when a later push superseded it in the concurrency
  group — cancellation is not a pass. The run for the final SHA `29b0b73` is the
  one that counts; its conclusion is stated in the delivery message for this round
  rather than guessed here. The last fully completed run, `42114734744` for
  `7385320`, concluded `success`.
- **No physical iPhone test.** Keyboard behaviour, `safe-area` and iOS tab
  eviction are handled in code and exercised in Chromium at phone viewports, not
  on the device. Physical Safari is unavailable to this session.
- **No screenshot review this round.** The visual acceptance in §E is a DOM and
  console check of the deployed origin.
- **`resolved` is unreachable from transcript data alone.** This is a deliberate
  limit, documented rather than papered over: nothing on the wire ties a
  verification result to a specific note.
- **Performance was not re-measured.**
- **Not claimed:** that the system is bug-free. Two adversarial audits found five
  real defects in the first cut of these changes; the same class of defect may
  remain in code neither audit examined.
