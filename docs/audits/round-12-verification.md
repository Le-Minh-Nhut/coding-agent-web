# Round 12: round-10/11 audit findings and verification

Baseline audited commit: `6aaf087df537063aa39112fe28e5765c0f52d0ff` (`origin/main`, clean tree). Audit archive: `coding-agent-web-audit-round11-6aaf087.zip`; `REPORT.md` contains R11-01, R11-02, and R11-03, and `prior-round10/REPORT.md` contains R10-01, R10-02, and R10-L1. Baseline probe results: round-11 probes had 3 PASS controls and 3 FAIL repros; round-10 probes had 4 FAIL.

## Round-10/11 findings

| Finding | Status | Change / files | Evidence and remaining ceiling |
|---|---|---|---|
| R10-02 — stale send callbacks could retain send locks or mutate newer conversation state | **Fixed** | `apps/web/src/components/ConversationView.tsx:133-134,568-575,632-640` | Locks are token-ownership Maps (`Map<key, token>`); each stale callback releases only its own token before the stale-generation guard, while UI mutations stay behind the guard. Double-submit guard, keep-draft-on-failure, no auto-resend, and no exactly-once claim remain. `tests/web/round10-auditor.test.tsx`: both cases pass. |
| R11-02 — transcript polling stopped after a transient transcript error | **Fixed** | `apps/web/src/components/SubagentPanel.tsx:45-47` | Interval stays alive but skips fetch while `transcriptErrors` is present, then resumes automatically when the error clears. Probe `tests/web/round11-subagent-auditor:subagent` (`tests/web/round11-subagent-auditor.test.tsx`): both cases pass. |
| R11-03 — expired setup session left app in loading state | **Fixed** | `apps/web/src/App.tsx:34-37` | Expired-setup-session branch exits loading into `LoginView` with a setup-unavailable notice. `tests/web/round11-auth-auditor.test.tsx`: all three cases pass. |
| R11-01 — orphaned conversations kept sessions marked tracked after project deletion | **Fixed** | `apps/server/src/server.ts:476-490` | `tracked` is computed only from conversations whose project still exists, joining through `store.listProjects()`. Orphaned conversations (deleted project, journal and metadata kept) no longer permanently mark a session tracked; no writer is created and no journal is deleted. `tests/server/project-session-readd.test.ts` covers stopped session resumability, live session attachability, unchanged normal project tracked status, and unchanged journal. `tests/web/session-badges.test.tsx` asserts an untracked session exposes `Resume in app` and a tracked session hides it, consuming `NativeSessionSummary.tracked`. |
| R10-01 — published external host identity was not matched during refresh | **Fixed** | `packages/runtime/src/supervisor.ts:287-300` | `observationsFor` unconditionally matches a published host by the conversation's recorded `nativeSessionId` before the managed-lineage branch. Lineage remains the managed-adoption proof; ownership remains external; no cwd/registry-order fallback. `tests/runtime/round10-auditor.test.ts` verbatim log: `AUDIT10 external refresh {"before":"running","after":"running","ownership":"external","host":"external-host"}`. 109/109 runtime tests pass. Audit-analysis correction: `observationsFor` had no `directHost` variable at HEAD; direct `nativeSessionId` matching existed only in `reconcile` (~line 792). |
| R10-L1 — oversized history record was silently omitted without a completeness signal | **Fixed** | `packages/omp-adapter/src/session-catalog.ts:408-466`, `packages/omp-adapter/src/types.ts:60-69`, `apps/web/src/api.ts:31`, `apps/web/src/components/ConversationView.tsx:428,880-885` | Every history page has `skippedOversized: boolean`, true only when that page's bounded scan (2 MiB window) skipped an oversized record. Adapter returns valid entries only, with no payload-sized placeholder. UI ORs the per-page flag, shows an explicit incomplete-history warning (record too large to display was skipped; journal intact on disk), keeps the generic truncation banner only while `hasOlder` or any page skipped, and shows “Beginning of history.” only when genuinely complete. `tests/adapter/oversized-history.test.ts` walks pages and asserts the marker and final page state. Banner wording decision: generic “omitted” wording no longer appears once every normal page is loaded and nothing was skipped. |

## Verification — merged tree

| Gate step | Check | Result |
|---|---|---|
| 1 | `pnpm -r typecheck` | Pass, all packages. Verbatim tail available in the gate log. |
| 2 | `npx vitest run --maxWorkers=8 --reporter=dot` | 53 files passed, 2 skipped; 485 tests passed, 8 skipped. |
| 3 | `node scripts/build-guest.mjs` | Pass. |
| 4 | `pnpm --filter @caw/web build` | Pass. |
| 5 | `pnpm --filter @caw/server build` | Pass. |
| 6 | `TMPDIR=$HOME/.cache CAW_E2E_PORT=4489 CAW_RELAY_PORT=8819 npx playwright test --project=chromium --workers=1` | 43 passed (59.9s). |
| 7 | `node scripts/compat-check.mjs` | 17 ok, 1 warn, 0 fail. This followed `fix(scripts): accept tmux no-server connect error in compat probe`; tmux 3.6 wording `error connecting to /tmp/tmux-1000/default (No such file or directory)` was previously a false FAIL. |

## Real-OMP acceptance (round 12)

Full default run: top-level checks check1–check15. Wall time: 190043 ms (~3m10s). Harness: `node scripts/acceptance-ui-drives-agent.mjs --base http://127.0.0.1:8811 --tmp $HOME/.cache/caw-acc-r12 --root $HOME/.cache/caw-acc-r12/roots --password a-12-character-secret`; `TMPDIR=$HOME/.cache`.

`PASS 38 / FAIL 2 / SKIP 0 / NOT SELECTED 0 / NOT RUN 2 (42 records)`.

- NOT RUN (2): “same native journal survives model restart — no journal flushed yet; prompt first; restart not attempted” (pre-prompt restart probe skipped; later real restart coverage passed); “two concurrent chats have distinct writers — NOT POSSIBLE VIA UI: 1 create request(s), overlapping=false” (known check8 limitation, unchanged from prior rounds).
- FAIL (2), both evidence-verified harness artifacts per triage; product tests stayed green:
  - check9 — `locator.waitFor: Timeout 45000ms — textarea.composer-input` immediately after backend restart. `startServer` gates readiness on `fetch('/') < 500` only (`scripts/acceptance-ui-drives-agent.mjs:371-380`); `openConversationThroughUi` waits for composer visibility (`:632-636`) while server boot and relay/host reconnect were still settling. Identical navigation in immediately following check10 succeeded. Navigation abort meant check9a/check9b (backend-restart identity and no-second-writer) were NOT proven this run; this check passed in prior-round acceptance runs. Suggested hardening, not applied: gate restart readiness on collab readiness, not composer visibility alone.
  - check14 — `locator.waitFor: Timeout 60000ms — .modal-content pre code` resolved hidden 122×. Harness selects `.modal-content .card` first (`scripts/acceptance-ui-drives-agent.mjs:1663-1680`), the Main agent card; its transcript was unreadable (server OMP log records ENOENT reading transcript for agentId Main), leaving empty `<code>` hidden by Playwright (`apps/web/src/components/SubagentPanel.tsx:90-93`). Subagent launched: `PASS: subagent conversation launched — conversation=b0ac9e6f… native=01a17e8e-8275… tmux=$5`. Suggested hardening, not applied: select child-agent card, not Main.
- PASS highlights: prompt reached host exactly once (`guestPromptEntries=1`, matchedShapes `custom_message/collab-prompt`), fixing round-9 duplicate-resend FAIL; check6 approval Deny blocked shell tool; check10 agent restart completed with argv `--resume <journal path>`, journal grew 12175→12710 bytes, restart refused missing-journal 404, no silent `nativeSessionId` replacement; external host reported `ownership=external` and stop refused with 409 `agent_not_running`; read-only view-only guest could not prompt or answer approval; navigation through login after backend restart succeeded on second attempt (R11-03-relevant).
- Cleanup: owner's OMP-related process count unchanged (5 before/after, same PIDs); owner process count 93 before/after; harness-owned tmux servers on private sockets were gone (`no server running` on both scratch sockets); owner's default tmux server never contacted; server pid 229068 exited.
- Disclosure: `--help` probe had no help handler and briefly started bootstrap flow; scratch `caw-acc-225388` was removed. Recorded baseline is from after that interrupted probe. Scratch `caw-acc-r12` was retained on failure and is being deleted now (it contained scratch provider-database copy, mode 0600).
- Screenshot note: 28 modified `docs/assets/screens/*.png` committed in `249b9b5` are regenerated E2E renders with only byte-level churn; `docs/assets/screens/manifest.md` diff is `Generated:` timestamp only, geometry table unchanged. Refreshed deliberately, not reverted.

## Not run this round

- Physical-iPhone validation was **NOT RUN THIS ROUND**; physical iPhone remains UNVERIFIED.
- Hosted compat CI job was not dispatched; it remains manual `workflow_dispatch` only.
