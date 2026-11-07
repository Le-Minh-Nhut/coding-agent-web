# Adversarial Review: Web Client Stabilization & Perf-Gate Architecture

**Date**: 2026-11-07  
**Scope**: Atomic deployment, perf-gate semantics, harness isolation, virtualization audits, snapshot cost benchmarks.  
**Review Status**: Read-only on source. No code modified.  
**OFF-LIMITS NOTE**: As mandated, `apps/web/src/components/{MessageRow,ConversationView}.tsx`, `apps/web/src/scroll-controller.ts`, and `apps/web/src/transcript-window.ts` are off-limits and were neither reviewed nor edited.

---

## Executive Summary

- **Blocker**: 0
- **Major**: 2
- **Minor**: 2
- **Info**: 0

The atomic deployment architecture (`apps/server/src/static-roots.ts`, `apps/server/src/static-web.ts`, `scripts/deploy-web.mjs`, systemd unit) is robust: all 10 attack vectors against deployment were **REFUTED**.
The harness isolation and locking mechanism (`scripts/e2e-lock.mjs`, `playwright.config.ts`) successfully prevents slot collisions, deadlocks, and artifact cross-contamination: attacks 15, 16, and 19 were **REFUTED**.
However, adversarial investigation confirmed 4 defects:
1. **MAJOR (Item 11)**: A correctness assertion is conditional-skipped with `test.skip(true, ...)` in `tests/e2e/mobile-performance.spec.ts:756` when the composer drops characters during streaming; 8 legacy `skipIfOverBudget` calls also remain in that file.
2. **MAJOR (Item 17)**: The ~19.9 ms "pure pipeline" claim in `tests/web/snapshot-pipeline-cost.test.ts` is misleading; it measures a synthetic ~400 KB plain-text fixture in Node.js without React, DOM, or CSS layout, whereas the realistic 12 MB payload takes up to 350 ms.
3. **MINOR (Item 13)**: Numeric budget tolerances were raised in `tests/e2e/perf-scroll-gates.spec.ts`: diff roundtrip from 200 ms to 500 ms (2.5x), and stream task from 200 ms to 300 ms (1.5x).
4. **MINOR (Item 18)**: The spacer reconstruction test in `tests/web/transcript-window-audit.test.ts:230-234` is an algebraic tautology asserting internal model arithmetic back at itself (`total === total`) rather than verifying actual rendered DOM dimensions.

---

## Summary Findings Table

| ID | Severity | Area | File:line | Verdict | Reproduction | Proposed fix | Regression risk |
|---|---|---|---|---|---|---|---|
| 1 | info | Atomic Deployment | `apps/web/vite.config.ts:47`, `scripts/deploy-web.mjs:220` | **REFUTED** | Developer builds (`pnpm --filter @caw/web build`, `vite build`, `vite build --outDir apps/web/dist`) build to `.deploy/staging` or `apps/web/dist`, never touching live `.deploy/current`. Server resolves exclusively from `current`. | None required. | None. |
| 2 | info | Atomic Deployment | `scripts/deploy-web.mjs:225-272` | **REFUTED** | Staging writes to `.tmp-${pid}` before manifest verification. Pointer swaps use atomic `rename(2)` of symlinks. Interruption leaves production untouched. | None required. | None. |
| 3 | info | Atomic Deployment | `scripts/deploy-web.mjs:151-197` | **REFUTED** | `verifyRelease` validates full file walk, byte sizes, sha256 checksums, and cross-references all `index.html` `src`/`href` local assets before build or publish. | None required. | None. |
| 4 | info | Atomic Deployment | `scripts/deploy-web.mjs:361-406` | **REFUTED** | Releases are immutable. Pointer swaps are single atomic renames. Partial failure leaves both pointers at valid releases; `previousRoot !== webRoot` prevents self-reference loops. | None required. | None. |
| 5 | info | Atomic Deployment | `apps/server/src/static-web.ts:300-314` | **REFUTED** | Fallback to `previous` is bounded to 1 hop, applies strictly to `isHashedAsset` (`/assets/*`), and non-asset/HTML requests never query `previous`. | None required. | None. |
| 6 | info | Atomic Deployment | `apps/server/src/static-roots.ts:67-103` | **REFUTED** | Resolver evaluates `readlinkSync` per request without server restart. Deleted release cannot be served because `tryServeFile` fails `fs.open` with `ENOENT` and yields 404. | None required. | None. |
| 7 | info | Atomic Deployment | `scripts/deploy-web.mjs:432-452` | **REFUTED** | `pruneReleases` builds `referenced` Set from `current` and `previous` and refuses to prune active pointers. Disk growth is bounded via `deploy-web.mjs prune --keep N`. | None required. | None. |
| 8 | info | Atomic Deployment | `apps/server/src/static-web.ts:77-93` | **REFUTED** | `rootReal` is pre-canonicalized via `realpathSync` in `realDirectory`. Descriptors opened inside `/proc/self/fd/N` resolve to canonical paths; containment check is exact. | None required. | None. |
| 9 | info | Atomic Deployment | `apps/server/src/static-web.ts:300-362` | **REFUTED** | Missing `/assets/*` requests 404 immediately and never reach `index.html`. Unmatched SPA navigations fall through `setNotFoundHandler` to serve `index.html` with 200. | None required. | None. |
| 10 | info | Atomic Deployment | `deploy/systemd/coding-agent-web.service:16` | **REFUTED** | `UnsetEnvironment` strips `CAW_WEB_RELEASE_ROOT` from ambient environment. `install.sh` substitutes all template keys cleanly. | None required. | None. |
| 11 | major | Correctness Gates | `tests/e2e/mobile-performance.spec.ts:755-757` | **CONFIRMED** | Dropped characters in `PERF-03` execute `test.skip(true, ...)` instead of failing; 8 legacy `skipIfOverBudget` calls also remain. | Replace `test.skip` with `expect(human.value).toBe(TYPED_500)`, and migrate remaining `skipIfOverBudget` calls to `budget({ blocking: true })`. | Low. Fails until composer drop bug is resolved. |
| 12 | info | Gate Semantics | `tests/e2e/perf-scroll-harness.ts:991-1004` | **REFUTED** | `budget()` asserts `expect(measuredMs).toBeLessThanOrEqual(budgetMs)` when `verdict === "OVER_BUDGET"` and `blocking: true`. All 5 budgets set `blocking: true`. | None required. | None. |
| 13 | minor | Gate Semantics | `tests/e2e/perf-scroll-gates.spec.ts:80-97` | **CONFIRMED** | `PERF-DIFF-ROUNDTRIP` threshold raised from 200ms to 500ms; `PERF-STREAM-TASK` raised from 200ms to 300ms. | Keep blocking gates; document 500ms/300ms as temporary baselines and file optimization ticket to return to 200ms. | None. |
| 14 | info | Measurement Quality | `tests/e2e/perf-scroll-gates.spec.ts` (18 sites) | **REFUTED** | All 18 call sites explicitly supply `fixtureName`, `entryCount`, and `cpuThrottleRate`. Hardware and browser info are dynamically captured. | None required. | None. |
| 15 | info | Harness Isolation | `scripts/e2e-lock.mjs:28-61` | **REFUTED** | `openSync(..., "wx")` is atomic (`O_CREAT \| O_EXCL`). Dead PIDs probed via non-terminating signal 0 (`process.kill(pid, 0)`). `releaseLock` checks PID ownership. | None required. | None. |
| 16 | info | Harness Isolation | `playwright.config.ts:28-30, 143, 152` | **REFUTED** | `RUN_ID` combines timestamp and PID. Project output directories isolate chromium and webkit. `retain-on-failure` traces survive without collision. | None required. | None. |
| 17 | major | Measurement Quality | `tests/web/snapshot-pipeline-cost.test.ts:185-194` | **CONFIRMED** | ~19.9 ms claim measures a ~400 KB synthetic plain fixture in Node.js, omitting React, DOM, and CSS. Heavy 4,075-entry fixture takes up to 350 ms. | Update test labels and documentation to clarify that 19.9 ms is lightweight synthetic JS-only parsing, not realistic 12 MB UI render cost. | Low. Benchmark clarity only. |
| 18 | minor | Virtualization Audit | `tests/web/transcript-window-audit.test.ts:230-234` | **CONFIRMED** | Spacer reconstruction test computes `windowModelSpan = offsets[end] - offsets[start]` and adds top/bottom offsets, reducing algebraically to `total === total`. | Add DOM-level spacer verification in a browser component test to ensure actual rendered heights match model offsets. | Low. |
| 19 | info | Measurement Quality | `tests/e2e/perf-scroll-gates.spec.ts:912-972` | **REFUTED** | 200ms warm-up in `fixture.ts:518-521` is consumed during Stage 1 (`welcomeFor`). Stage 2 timer starts afterward; blocking budget applies to clean `firstContentMs`. | None required. | None. |

---

## Detailed Findings for Confirmed Items

### 1. Item 11 (MAJOR): Correctness assertion skipped in `tests/e2e/mobile-performance.spec.ts`

- **File:line**: `tests/e2e/mobile-performance.spec.ts:755-757`, `tests/e2e/mobile-performance.spec.ts:101-103`
- **Severity**: Major
- **Vulnerability**: A skipped correctness gate is a defect. In `tests/e2e/mobile-performance.spec.ts`:
  ```ts
  expect(human.samples.length, "every keystroke must have been observed in the page").toBe(500);
  const dropped = TYPED_500.length - human.value.length;
  if (human.value !== TYPED_500 || burst.value !== TYPED_500) {
    test.skip(true, `composer drops typed characters while a turn streams: ${human.value.length}/500 at 40ms per key, ${burst.value.length}/500 burst (dropped ${dropped}); measured value recorded in PERF_JSON`);
  }
  ```
  When the composer drops typed characters during streaming (a verified bug where 491-492 of 500 characters arrive), the test issues a `test.skip(true, ...)`. This hides the functional regression under a green/skipped test status.
  In addition, `skipIfOverBudget` remains defined at line 101 and is called at lines 626, 669, 797, 874, 970, 1020, 1070, and 1285.
- **Reproduction**:
  Inspect `tests/e2e/mobile-performance.spec.ts:755-757`. Run test `PERF-03` against a build where keystrokes drop: the test reports "skipped" rather than "failed".
- **Proposed fix**:
  Replace `if (human.value !== TYPED_500 || burst.value !== TYPED_500) test.skip(...)` with:
  ```ts
  expect(human.value, `composer lost characters during human typing: ${human.value.length}/500`).toBe(TYPED_500);
  expect(burst.value, `composer lost characters during burst typing: ${burst.value.length}/500`).toBe(TYPED_500);
  ```
  Migrate remaining `skipIfOverBudget` call sites to `budget({ blocking: true })`.
- **Regression risk**: Low. The test will accurately fail until the controlled composer character drop is fixed.

---

### 2. Item 17 (MAJOR): Misleading snapshot pipeline latency claim (~19.9 ms)

- **File:line**: `tests/web/snapshot-pipeline-cost.test.ts:185-194`
- **Severity**: Major
- **Vulnerability**: The benchmark claims that the "pure pipeline" for 4,075 entries is ~19.9 ms. This claim fails skeptical review on three grounds:
  1. **Fixture payload**: The 4,075 entries in test case 1 are generated with `buildTranscriptEntries({ count: 4075 })`, which produces plain 1-line text messages totaling ~0.4 MB. The owner's actual transcript contains complex Markdown, large diffs, wide tables, and tool cards (12 MB).
  2. **Worst-case latency**: In test case 2 (`4,075 heavy entries`), the test suite itself sets the budget ceiling to `350 ms`—17x higher than 19.9 ms.
  3. **Omission of DOM/React**: The benchmark runs in Node.js (vitest) and benchmarks V8 JSON parsing and array iterations. It completely excludes React component rendering (`MessageRow`, `ConversationView`), DOM node generation, CSS style recalculation, layout, and paint.
- **Reproduction**:
  Examine `tests/web/snapshot-pipeline-cost.test.ts:186-211`. Test 1 runs on bare 4,075 entries (~0.4 MB), while Test 2 on realistic heavy entries requires a `350 ms` budget ceiling.
- **Proposed fix**:
  Add explicit documentation in `tests/web/snapshot-pipeline-cost.test.ts` qualifying that the 19.9 ms figure represents minimal synthetic JSON parsing and reducer execution only, and that the realistic 12 MB UI render cost is measured by `PERF-LOAD-01` in the browser.
- **Regression risk**: None (documentation and test reporting clarification).

---

### 3. Item 13 (MINOR): Perf-gate budget tolerances raised

- **File:line**: `tests/e2e/perf-scroll-gates.spec.ts:80-97`
- **Severity**: Minor
- **Vulnerability**: In commit `0be42f0`, numeric budget thresholds were increased compared to the previous revision:
  - `PERF-DIFF-ROUNDTRIP`: Previously evaluated against `BUDGET_MS = 200` ms via `skipIfOverBudget`. The new budget is `500 ms` in `PERF_BUDGET_TABLE` (a 2.5x increase).
  - `PERF-STREAM-TASK`: Previously evaluated against `BUDGET_MS = 200` ms via `skipIfOverBudget`. The new budget is `300 ms` in `PERF_BUDGET_TABLE` (a 1.5x increase).
- **Verdict**: Justified as a step toward hardening CI (converting unasserted advisory skips into blocking gates), but the numeric tolerance was raised.
- **Proposed fix**: Maintain `blocking: true` on both gates. Create follow-up optimization issues to profile and optimize diff-to-transcript transitions and streaming task duration so budgets can be tightened back toward 200 ms.
- **Regression risk**: None.

---

### 4. Item 18 (MINOR): Tautological spacer reconstruction assertion

- **File:line**: `tests/web/transcript-window-audit.test.ts:230-234`
- **Severity**: Minor
- **Vulnerability**: The test intends to verify that spacers reconstruct the document height. However:
  ```ts
  const windowModelSpan = offsets[window.end]! - offsets[window.start]!;
  ...
  const reconstructed = spacers.top + gapPx + windowModelSpan + spacers.bottom + gapPx;
  expect(Math.abs(reconstructed - total)).toBeLessThan(1e-9);
  ```
  `spacers.top` is defined by implementation as `offsets[window.start] - gapPx`, and `spacers.bottom` as `offsets[count] - offsets[window.end] - gapPx`. Substituting these definitions:
  $$\text{reconstructed} = (\text{offsets}[\text{start}] - g + g) + (\text{offsets}[\text{end}] - \text{offsets}[\text{start}]) + (\text{total} - \text{offsets}[\text{end}] - g + g) = \text{total}$$
  The assertion proves only that $A + (B - A) + (C - B) = C$. It cannot catch a mismatch between model offsets and rendered DOM spacer heights.
- **Reproduction**:
  Inspect `tests/web/transcript-window-audit.test.ts:210-235`.
- **Proposed fix**:
  Complement this unit test with a component test asserting that rendered spacer DOM elements in `ConversationView` actually reflect the computed spacer heights in layout.
- **Regression risk**: Low.
