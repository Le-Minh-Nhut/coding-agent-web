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

## Not run this round

- Real-OMP acceptance was **NOT RUN THIS ROUND**. Prior evidence from round-9/10/11 acceptance runs: round 9 had 15 PASS / 2 FAIL; check8 NOT POSSIBLE VIA UI; check12 SKIP precondition; check6 Deny and check14 subagent were fixed but not re-run in acceptance.
- Physical-iPhone validation was **NOT RUN THIS ROUND**; physical iPhone remains UNVERIFIED.
- Hosted compat CI job was not dispatched; it remains manual `workflow_dispatch` only.
