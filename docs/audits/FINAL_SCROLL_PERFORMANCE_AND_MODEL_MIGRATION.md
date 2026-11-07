# Final report — black-screen scroll, windowed transcript, tool activity, model migration

Round 58. Base at round start `b0114e3`; the round's three code/doc commits are
`b1ef86c` (windowed transcript), `ab2a7bb` (tool activity + premium chrome) and
`8d3d2cc` (docs), pushed as `b0114e3..8d3d2cc` and **deployed** — §I.1 carries the
observed deploy record, §H.1 the observed gate results. §I.0 is not deployment evidence
but an operational hazard the round hit three times; §I.3 proves the bundle the origin now
serves is `d29ffe6`'s output, and §I.4 records the approval-overlay defect that review
found *after* the release report was written and that `d29ffe6` fixes.

Every number below names the file it came from or the command that produced it. Where
a number is a *range*, the range is the spread of separate runs, not a rounded claim.
Verdict vocabulary is the brief's: PASS / FAIL / BLOCKED / UNVERIFIED. Whatever remains
genuinely unmeasured is listed once, at the end of the file, as **Open items** rather than
scattered through it.

---

## A. Current source baseline

### A.1 Revision state at round start

Source: `docs/audits/baseline-state-2026-11-06.md` §1–§2, captured 2026-11-06 21:47
+07 on the live machine.

| Item | Value |
| --- | --- |
| HEAD at round start | `b0114e3f8a5dc59b298cdd2253506001629ebb98` (`main` == `origin/main`) |
| Last code-bearing revision before this round | `018e607` — "fix(web): make the running header read as one control, and record what the pixels showed" |
| Preceding code revisions | `6c33db1` (streaming cost), `2d819d3` (header + gates), `18091ed` (notice identity), then docs-only `fdca89a`, `6513339`, `091e8f4`, `6b7eef1`, `b0114e3` |
| Worktree at capture | clean except three untracked instrument files (`tests/e2e/perf-scroll-harness.ts`, `perf-scroll.spec.ts`, `png.ts`) |
| `git diff --stat` at the time of writing this report | 19 files changed, 2115 insertions(+), 423 deletions(-); 26 untracked paths added by the round (`git status --porcelain`) |

### A.2 Deployment at round start (observed, not inferred)

Source: `baseline-state-2026-11-06.md` §3.

| Item | Value |
| --- | --- |
| Unit | `coding-agent-web.service` — a **user** unit (`--user`), enabled, `active (running)` since `Fri 2026-11-06 15:39:16 +07` |
| MainPID | `92072` — `node --import tsx …/apps/server/src/server.ts` |
| Loopback | `http://127.0.0.1:8791/` → HTTP **200** |
| Public origin | `https://heheboiz-legion-5-15arh7.tail8d8eff.ts.net` (Tailscale Serve → 127.0.0.1:8791, tailnet only) |
| Served JS | `assets/index-C2QexEsC.js`, sha256 `d3a9a9b50f09d231fa3764c09d57cd45ffb555cca0e72a91645fb89da726ba89` |
| Served CSS | `assets/index-C6e9qhob.css`, sha256 `1870cb75415f0954ffdfd958bda6c927db73ed5f26a99af0388a7716450d4a61` |
| Served `index.html` | sha256 `04971d1fa7721ddea10fe6c4559de2b77369700e4e09fb46ebcc432f1e59c90c` |
| dist ↔ loopback ↔ public | all six hashes identical: the origin serves exactly `apps/web/dist` |
| OMP panes (private tmux socket) | `$0` pid **1204278** (`caw-DOCKER…`), `$1` pid **2080435** (`caw-CTX…`), `$2` pid **2082046** (`caw-New-chat…`); `pane_dead=0`, `pane_current_command=omp` |
| tmux server identity | `…/tmux.sock:1793822846:1204277`, 3 sessions (agent limit 3/3 full) |

Tooling present at capture (§5): Node `v20.19.5`, pnpm `10.32.1`, Playwright
`1.64.1`, system Chrome `155.0.8059.84`, and **`webkit-2370` installed** (no Chromium
bundle — the config uses `channel: "chrome"`). `baseline-state-2026-11-06.md` §5 also
records the trap in reading `playwright install --dry-run`: it prints the *plan* and
does not report absence, so the cache listing is the evidence.

### A.3 What the previous round did, and what it left standing

Source: `docs/audits/CAW_PERFORMANCE_AND_MOBILE_UX_REPORT.md` (round 57).

**The memo comparator plus a per-message `WeakMap` cache (C1/C2)** cut the cost of
*appending* to a large transcript: script per appended row `7.68 ms → 1.33 ms` (−83 %),
longest frozen task during an append burst `323 ms → 95 ms` (−71 %), stream-update
script `0.32 → 0.16 ms`, streaming heap `70.6 → 58.5 MB`. The two halves were proven
inseparable by an isolation run: cache off, comparator on, put the append cost back at
`6.69 ms`/row (§C2).

**What it explicitly did not fix**, and said so in its own §D and §I: snapshot load
(`longest task 345 → 368 ms`, `main-thread 879 → 874 ms` — no improvement), document
size (`28,578 elements`, unchanged), and it introduced no virtualisation on purpose,
arguing that "the transcript is evidence" and every entry must stay in the document.

**That assumption is exactly what this round overturns.** The round-57 instrument
measured what a *React* fix could buy and concluded the DOM was untouchable. This
round measured what the DOM itself costs, with no React in the picture: a document of
**488,004 elements with no app code at all** stalled its own scroll at `p95 33 ms /
max 439 ms` under 4× CPU throttle (`SCROLL_PERFORMANCE_RESEARCH.md` §3), and the real
app's 8,000-entry scroll spent **61 ms of script+style+layout in a 15.3 s gesture**
with a single **763.9 ms** main-thread task. A React-level optimisation cannot fix a
cost that is not React's; bounding the mounted DOM can, and does (§D).

### A.4 The defects this round set out to fix

| # | Defect | Measured evidence that it was real |
| --- | --- | --- |
| 1 | **Black/blank transcript on a fast upward flick** (the owner's most important symptom) | 8,000 heavy entries, 4× throttle, Chromium: frame gap p50 **88.2 ms**, p95 **544.6 ms**, max **793.1 ms**; WebKit max **2,112 ms** (`SCROLL_PERFORMANCE_RESEARCH.md` §9) |
| 2 | **General lag even after round 57** | Same document: **313,916** DOM elements and a single main-thread task of **763.9 ms** (`PROFILE-04`, research §3) |
| 3 | **OMP tool-card noise** (`✓ Run 1 command` stacked) | Owner's real 4,806-row journal through `groupActivity`: **2,163** collapsed cards, of which `✓ Run 1 command` ×**1460**, `✓ Edit 1 operation` ×197, `✓ Run 2 commands` ×193, `✓ Run 1 tool` ×128, `✓ Read 1 file` ×107; **1,002** blank assistant echo rows split runs (`tool-activity` census, §F) |
| 4 | **Frontend visually inferior to the premium reference** | Round-57 captures read at pixel level: **56 px** uniform `rgb(27,27,27)` header plate against a `#050505` canvas, dashboard plate **~64–72 px**, first transcript row at **~128 css px** of a 568 px screen (`PREMIUM_DESIGN_SPEC.md` §0.1) |
| 5 | **Model to migrate** | Owner asked for `wdb/deepseek-ai/DeepSeek-V4.1-Flash-1017`; catalog verified present with 1M context / 128K output / thinking `low,high,max` (`model-migration-notes.md` §1; re-read this round with `omp models find`) |

The adversarial review of the working tree (`docs/audits/adversarial-review-round58.md`)
counted **30 findings — 0 blocker, 8 major, 20 minor, 2 info** against the uncommitted
change. Its own triage list, and what happened to each item, is in §J.

---

## B. Black-screen root cause

### B.1 Reproduction

| Field | Value |
| --- | --- |
| Scenario | `SCROLL-02` / `PERF-SCROLL-02`: 8,000-entry **heavy** fixture (long Markdown, wide tables, fenced code, 300-line gutter diffs, 300+ tool cards), scrolled to the bottom, then a train of upward touch flicks |
| Fixture | `buildTranscriptEntries({ count: 8000, seed: 42, ...HEAVY_TRANSCRIPT })`, `tests/e2e/perf-fixtures.ts` |
| Engine, Chromium | Chromium 390×844 @2× DPR, `isMobile`, `hasTouch`, real CDP touch input, **4× CPU throttle** (`tests/e2e/perf-scroll.spec.ts:197`) |
| Engine, WebKit | mobile WebKit 390×844 @2×, scroll driven by **offset assignment** at the same travel and per-step frame budget — a layout-path gesture, not a compositor flick (WebKit has no CDP and mobile WebKit rejects `mouse.wheel`) |

### B.2 Measurement evidence

`SCROLL_PERFORMANCE_RESEARCH.md` §9 (all numbers from the same instrument and the same
fixture):

| metric | Chromium | WebKit |
| --- | --- | --- |
| DOM elements | 313,916 | 313,916 |
| rows mounted | 6,769 | 6,769 |
| gesture duration | 67.0 s | 145.8 s |
| frame gap p50 | **88.2 ms** | **135 ms** |
| frame gap p95 | **544.6 ms** | **597 ms** |
| frame gap max | **793.1 ms** | **2,112 ms** |
| longest main-thread task | **151 ms** | — (`longtask` is Chromium-only) |
| blank frames observed | 0 / 11 samples | 0 / 29 samples |

Read the last row together with the fifth: a sampler that lives on the same main
thread produces 11 samples across a 67-second gesture precisely *because* the thread
is held for 544–793 ms at a time. A zero blank count there is not evidence of
continuity; the frame-gap series is the strong evidence, and it says the frame budget
is blown by an order of magnitude, repeatedly, for the whole gesture.

### B.3 Root cause, stated as a mechanism

`TranscriptList` rendered **every** entry of the transcript, and the entries carried
every row's full DOM (markdown, tables, diffs, tool bodies). The code did exactly what
it said; the cost was its unbounded output:

- Writer in the revision under test: `apps/web/src/components/MessageRow.tsx:244` at
  **`b0114e3`** — `{entries.map((entry) => …)}` inside `TranscriptList`, with no window
  (`git show b0114e3:apps/web/src/components/MessageRow.tsx`, 278 lines total; the file is
  named by revision rather than `HEAD` because `HEAD` has moved since). In the current
  tree the same render sits in the `!windowed` branch, `MessageRow.tsx:995-1000`, and the
  windowed path builds `items` instead (`:1021-1059`).
- Consequence: DOM size is **O(history)**. 4,075 heavy entries → **160,027** elements;
  8,000 heavy entries → **313,916** elements.

The engine's per-frame work over that node count is the stall. Nothing in the app's
JavaScript is responsible.

### B.4 What was ruled out, and how

| Alternative | Test | Result |
| --- | --- | --- |
| **React re-renders the list per frame** | Commit counter installed through `__REACT_DEVTOOLS_GLOBAL_HOOK__` **before any app script**; 8-flick train, 2,000 heavy entries, 78,617 elements, 4× throttle (`SCROLL-AB`, `tests/e2e/perf-decision.spec.ts`) | **2 commits** across the whole gesture, while the same page produced **24 frame gaps > 100 ms**. React is not the mechanism; round 57's memo work holds. |
| **Script, style or layout** | CDP `Performance.getMetrics` during an 8,000-entry heavy scroll at 4× (`PROFILE-04`) | ScriptDuration **0.011 s**, RecalcStyle **0.001 s**, LayoutDuration **0.028 s** = **61 ms total**, against TaskDuration **15.304 s** with one `RunTask` of **763.9 ms** |
| **The app code at all** | 4,000 synthetic heavy rows, **488,004 elements**, no React, no observers, no app handlers, plain CSS, 4× throttle | The document stalls its own scroll: `p95 33 ms / max 439 ms` |
| **Rows are dropped from the DOM** | Row-reachability assertions across the whole history, before and after (`PERF-LOAD-01` walks first/middle/last; `SCROLL-01..12`) | No row was missing. The defect was paint/materialisation latency, not lost content. |
| **A `content-visibility`-style deferred mount would fix it** | A/B probe arm with `contain-intrinsic-size: auto 120px` | **Invalid arm, discarded**: it collapsed `scrollHeight` 739,730 px → 36,708 px (20× wrong), so its 12.8 s gaps measure engine thrash on a wrong layout estimate. Recorded rather than deleted, and no conclusion rests on it. |

### B.5 WebKit is the owner's engine, and it is worse

WebKit is what the owner's iPhone runs. On the identical document and fixture it is
**at least as bad**, and its worst gap is **2.7× Chromium's** (2,112 ms vs 793.1 ms).
Round 57 recorded WebKit as BLOCKED; that verdict is stale and is corrected here. Two
prerequisites had to be solved to run it at all, both recorded in research §4:

1. `__Host-caw_session` is `Secure` by specification and **WebKit does not exempt
   loopback**, so login "succeeded" and every later request was 401. The scroll specs
   run WebKit against the app's own documented loopback-only dev flag
   (`CAW_INSECURE_COOKIES=1`, `apps/server/src/config.ts:26,151`,
   `apps/server/src/auth.ts:50`), set by `playwright.config.ts:117` **only when the
   WebKit project is in the run**.
2. One missing system library (`libmanette-0.2.so.0` and its transitive deps) had to be
   placed in the `webkit-2370` bundle; it now launches.

**Staleness of the numbers, not of the verdict.** The frame-gap figures in §B.2 were taken
on the windowed build **before** the three WebKit-only fixes in §B.7 and the two crash
fixes in §D.2.1–§D.2.2, and they were not re-reported individually afterwards. What did
happen after them is a full WebKit re-run in the release sweep: **26 expected, 0
unexpected, 1 skipped, 0 flaky in 190 s**, including `SCROLL-03` at **8 of 8 consecutive
runs** (§H.1). So the WebKit **verdict** is final-build evidence; the WebKit **millisecond
figures** quoted here are pre-fix figures and are labelled as such wherever they appear.

### B.6 The pixel detector: validated in both directions, and honest about its rate

`tests/e2e/perf-pixels.spec.ts` (`PIXEL-DETECTOR`) was run **before** any blank-frame
number was believed:

| injected condition | frames | blank frames | blank run |
| --- | --- | --- | --- |
| real app, painted transcript | 4 | **0** | 0 ms |
| transcript band covered by an opaque `--bg` overlay (ground truth: no ink) | 4 | **4** | **494.6 ms** |

Zero false positives on the real app; the controlled fault is detected with the correct
duration. The capture instrument itself had to be chosen by measurement: `Page.startScreencast`
produced **1 frame per 6 s**, trace `devtools.screenshot` produced **1 frame per 30-step
flick**, and only a parallel `page.screenshot` loop produced a usable series (and is
available on WebKit too, so a Chromium sample and a WebKit sample mean the same thing).

`PIXEL-COVERAGE` prints the honest ceiling: **6 samples over 917 ms of gesture = 11 %**
(A second run recorded 6/840 ms = 12 %.). Therefore every blank-duration figure in
this report is an **upper bound on continuity**, not a frame-exact count, and the
0-blank readings in §B.2 are corroboration that did not contradict the frame-gap
series — never a proof that the owner's screen never went black.

### B.7 The second mechanism: the anchor correction lost the reader's own movement

The DOM size in §B.3 is the primary cause and the window removes it (§C). But when the
windowed build was run on WebKit, a *second*, independent mechanism surfaced — and it is
the one that explains why every Chromium gate was green while the owner's phone was not.

The window's anchor correction has a **missing-anchor branch**: when the row it captured
is no longer mounted, it recomputes the target offset from the height model alone. That
arithmetic omitted the scroll movement since capture. The correct identity, stated at
`MessageRow.tsx:734-760`:

```
target = modelOffset - anchor.offset + (scrollTop - anchor.scrollTop)
```

`anchor.offset` is where the row sat in the viewport at capture, `anchor.scrollTop` the
offset then in force. Without the `(scrollTop - anchor.scrollTop)` term the branch
**undoes any movement that unmounted the anchor** — precisely the movement a fast upward
flick makes, and precisely the case that reaches the branch.

Measured on WebKit, 4,075 heavy entries, "return to bottom": the write landed correctly
at `scrollTop 458,385` with `atMax: true`, then the next frame reverted it to **44,578**
and the frame after to 44,558 — the capture-time position — because the anchor row
(~entry 460) had been unmounted by the jump. **Chromium rarely takes that branch in that
scenario; WebKit takes it on the jump.** That asymmetry is the reason a machine with
Chromium green was still showing the owner a black transcript.

Two supporting changes, each fixing a WebKit-only hole that no notification was going to
close:

| change | what it fixes | measured evidence |
| --- | --- | --- |
| the tail invariant is enforced **after every commit**, not on notification | WebKit can grow the document after the write with **no scroll event and no observer record** | `ConversationView.tsx:1245`: write at `scrollTop 404,873` vs `scrollHeight 420,637` — **15,764 px** short, permanently (identical at +50/150/400/1000 ms). `MessageRow.tsx:511-515`: `712,712` vs `732,974` — **19,580 px** short. Instrumenting it made the gap appear in **9 of 10 runs** |
| the view **adopts** the bottom when it is already within `TAIL_THRESHOLD_PX` | the lock is released when the reader leaves, but nothing re-acquired it after a programmatic write whose scroll event WebKit coalesced away | `ConversationView.tsx:1266-1273`: final `scrollTop = scrollHeight` landed at 713,347 against `scrollHeight 733,608` and stayed there. "Is the view at the bottom" needs no event to answer, and a reader who genuinely left is further than the threshold, so this cannot pull anyone back |
| the window **self-heals** when the mounted range does not contain the live offset | WebKit moves `scrollTop` *after* render — it clamps a write to a maximum it is still recomputing, then applies it after layout, with no further scroll event | `MessageRow.tsx:536-542`: write at `scrollTop 126,241` with `scrollHeight` already 937,795, window stuck at rows 104-118 — **`SCROLL-03` reported `posinset 17` with `setsize 4075`**, i.e. the scroller at the end and the window at the start. Chromium never reproduces it because its scroll event arrives with the write |

That last row is the blocker `SCROLL-03` names, and it now passes **8 of 8 consecutive
WebKit runs** with `posinset 4075` inside the band (§H.1). The self-heal is a convergence
guard, not a counter: it publishes a version bump only when the live offset falls outside
the mounted range, a state the next render cannot produce, so the condition is false
immediately afterwards. The tail enforcement likewise dispatches no state — writing the
position is the whole obligation, and the scroll event it raises re-enters
`updateTailLock`, finds the distance at zero, and keeps the lock.

---

## C. Rendering architecture

### C.1 Previous approach

Every row mounted, forever. `TranscriptList` mapped the whole entry array into the
document; a group's body was mounted when the group was expanded and stayed mounted.
Cost was therefore a function of conversation length, not of what the reader can see:
**160,027** elements at 4,075 heavy entries, **313,916** at 8,000.

### C.2 New approach

| Concern | Decision | Where |
| --- | --- | --- |
| What is bounded | the **mounted DOM**, never the data. `rows` and `groupActivity(rows)` stay whole | `apps/web/src/components/MessageRow.tsx` |
| Window unit | **entries** (a group is one entry, a row is one entry), not rows | `EntryWindow` (`transcript-window.ts:212`), `computeWindow` (`:226`) |
| Heights | **measured**, cached by identity; only never-measured entries borrow an estimate from the nearest measured neighbour | `estimateHeights` (`transcript-window.ts:92`) |
| Measurement | one `ResizeObserver`, re-armed on the mounted set, reading the `display: contents` wrapper's `firstElementChild` | observer at `MessageRow.tsx:845-852` |
| Offsets | prefix sums in a `Float64Array`, binary search — O(log n) per scroll event | `buildOffsets` (`transcript-window.ts:138`), `indexAtOffset` (`transcript-window.ts:197`) |
| Spacers | **exact sums of the same offsets array**, so `scrollTop = offsets[i]` lands entry `i` at the top even while distant heights are guesses | `computeWindow` (`transcript-window.ts:226`), `spacerHeights` (`transcript-window.ts:262`) |
| Flex `gap` | charged **inside the height model**, not corrected at render time: `buildOffsets(heights, gapPx)` adds one gap before every entry after the first — `count − 1` gaps, deliberately none after the last, because a trailing gap is space the DOM does not have (it showed as content ending **177 px** past the scrollport). That makes an entry's model offset its DOM position for every window, so a window move is not a geometry change. The review's W1. The previous render-time subtraction (`fitSpacersToGap`) is what caused the oscillation — see §D.2.2; the symbol no longer exists | `buildOffsets` signature + gap loop, `transcript-window.ts:138` / `:171`; rationale `MessageRow.tsx:358` |
| Anchor | identity + offset from the viewport top + **the `scrollTop` it was taken at**; the third field is what stops the correction from fighting the user | `captureAnchor` (`MessageRow.tsx:639`); correction effect `:697-817` |
| Tail-follow | unchanged `followTailRef` / `TAIL_THRESHOLD_PX`, plus re-pinning on **known** document growth and on viewport shrink (a subagent row appearing), plus the after-every-commit enforcement and bottom adoption of §B.7 | `updateTailLock` (`ConversationView.tsx:1135`), `TAIL_THRESHOLD_PX` (`:81`), enforcement effect `:1259-1315` |
| Native scroll anchoring | **disabled** — `overflow-anchor: none` on `.messages-scroll` | `apps/web/src/styles.css:724` |
| Pinned entries | force-mounted as **separate segments**, never by widening the window; `isError` rows pinned by identity; open disclosures and the focused row derived from the live DOM | `computeSegments` (`transcript-window.ts:441`) |
| Estimate propagation | capped at **8×** the entry's own fallback (`PROPAGATION_CAP_FACTOR`), and the total is scaled under the engine's `MAX_SCROLL_HEIGHT_PX = 33,554,428` — the review's W3 | `transcript-window.ts:76`, `:83`, `:169-179` |
| Small lists | `< 60` entries render everything — a short conversation must not pay for a measurement pass | `WINDOW_MIN_ENTRIES = 60` (`transcript-window.ts:34`) |
| Overscan | **800 px**, chosen by sweep (§C.3) | `DEFAULT_OVERSCAN_PX = 800` (`transcript-window.ts:45`) |
| Dependency | **none added** | `git diff package.json apps/web/package.json` → empty |

### C.3 Why 800 px, by measurement

`SCROLL-02` (8,000 heavy entries, 8 upward flicks), each configuration a **real rebuilt
production bundle** (`scripts/overscan-sweep.mjs`; no benchmark knob in shipped code):

| overscan | engine | DOM elements | rows mounted | gap p50 | gap p95 | gap max | blank |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 400 px | Chromium | 277 | **1** | 16.6 | 33.2 | 34.2 | 0 / 16 |
| **800 px** | **Chromium** | **315** | **6** | **16.6** | **33.2** | **34.6** | **0 / 16** |
| 1600 px | Chromium | 594 | 12 | 16.6 | 33.2 | 33.8 | 0 / 17 |
| 400 px | WebKit | 529 | 4 | 16.0 | 66 | 76 | 0 / 39 |
| **800 px** | **WebKit** | **529** | **4** | **16.0** | **65** | **76** | **0 / 37** |
| 1600 px | WebKit | 843 | 18 | 16.0 | 65 | 74 | 0 / 37 |

400 px collapses to a **single** mounted row on Chromium: one failed estimate or one
flick past it and the viewport is empty — the forbidden "small overscan that leaves
black gaps". 1600 px doubles the DOM (315 → 594 elements) to buy a frame-gap difference
the sweep prints as **max 34.6 → 33.8 ms** (p95 flat at 33.2 ms, p50 flat at 16.6 ms,
across all three Chromium arms) — `SCROLL_PERFORMANCE_RESEARCH.md` §13 describes that as
"0.4 ms"; the printed columns differ by 0.8 ms, and either way the gain is inside the
budget already met at 800 px while the DOM cost doubles. 800 px is the smallest
configuration that never left the viewport without content in either engine.

### C.4 Why it is better, in the numbers

Same fixture, same throttle, same engines (`SCROLL_PERFORMANCE_RESEARCH.md` §14):

| metric | Chromium before | **Chromium after** | WebKit before | **WebKit after** |
| --- | --- | --- | --- | --- |
| DOM elements (8,000 heavy) | 313,916 | **214** | 313,916 | **544** |
| rows mounted | 6,769 | **37** | 6,769 | **8** |
| frame gap p50 | 88.2 ms | **16.6 ms** | 135 ms | **16.0 ms** |
| frame gap p95 | 544.6 ms | **32.5 ms** | 597 ms | **65 ms** |
| frame gap max | 793.1 ms | **34.1 ms** | 2,112 ms | **76 ms** |
| gesture duration | 67.0 s | **3.2 s** | 145.8 s | **7.0 s** |

The gesture collapse is not a different gesture: it is the same flick train finishing
because the renderer is no longer three quarters of a second behind each frame.

### C.5 Data-fidelity guarantees

| Guarantee | Mechanism | Verified by |
| --- | --- | --- |
| Full transcript retained | `rows` is never truncated; only the DOM is bounded | `aria-setsize` equals the conversation size (8000, 4075, 1400, 900 asserted) |
| Reachable top, middle and end | window recomputed from any `scrollTop`; spacers cover the unmounted span | `PERF-LOAD-01` walks first/middle/last; `round50-measure.spec.ts` asserts top/middle/end **painted** |
| Search over the **complete** transcript | `searchTranscript` reads `messages`, never the DOM | `tests/web/transcript-window.test.ts` finds a hit in message 10,000 of 10,000; `PERF-SEARCH-01`: a hit at entry 4,000 was unmounted before search, found, then mounted and on screen |
| Search source matches the rendered document | `searchableRows = isShowingSavedHistory ? savedRows : messages` (W6) | comment + unit/E2E coverage of saved mode |
| Copy the full message | unchanged: `CollapsibleMessage` reads `text` verbatim | existing suite |
| Jump to a hit inside a collapsed group | `revealMemberId` opens the group, then the entry is scrolled to its top with a small inset | `PERF-SEARCH-01`, component tests |
| Group expansion is lossless | `flattenActivity(groupActivity(rows)) === rows` — echoes are carried, never dropped | `tests/web/tool-activity-evidence.test.ts` |
| Screen-reader position | `role="list"` / `listitem`, `aria-setsize` + `aria-posinset` **on the real box**, `aria-busy` while the mounted set is unmeasured | `tests/e2e/perf-a11y.spec.ts` (see §J.8) |
| Nothing focusable vanishes | sticky set: any entry containing `[aria-expanded="true"]` or the focused element, plus a `focusin` listener so focus is known before the commit that would drop it | `PERF-SCROLL-04`; unit test |
| Approvals and errors never deferred | approval surface is a sibling of the list; `isError` rows pinned by identity | pinned-entry component test |

### C.6 What a window does **not** preserve

**Native browser Find.** `Ctrl/⌘+F` searches the rendered DOM, and all but a few dozen
rows of a long conversation are legitimately not in it. This is a real loss of an OS affordance, not a detail, and
it is replaced by an in-app search: the header menu's **"Search transcript"**, which
searches the full array, shows a match count in a polite live region, lists the first
**50** matches (the rest reachable by stepping with Enter / Shift+Enter, wrapping at
both ends), highlights the matched substring, and mounts + reveals the hit. The
replacement is documented in the user guide (`docs/HUONG_DAN_SU_DUNG.md`) as well as in
the UI.

---

## D. Performance measurements

Every row names its fixture, throttle, engine and browser. **Throttled and unthrottled
runs are kept in separate tables and never mixed.** "Chromium" = system Chrome
155.0.8059.84 via `channel: "chrome"`, 390×844 @2×, `isMobile`, `hasTouch`. "WebKit" =
Playwright `webkit-2370`, same viewport/DPR, layout-path scroll.

### D.1 DOM element count

| fixture | before | after | engine | throttle | source |
| --- | --- | --- | --- | --- | --- |
| 8,000 heavy entries, flick train | 313,916 | **214** (Chromium) / **544** (WebKit) | both | 4× | research §14 |
| 8,000 heavy entries, gate re-runs | 313,916 | 214–315 (Chromium) / 525–544 (WebKit) | both | 4× | `PERF-SCROLL-02` PERF_JSON |
| 4,075 heavy entries, top→bottom | 160,027 | **5,833** (one run) / 525–533 (gate runs) | Chromium | 1× for the 160,027 baseline; gate runs unthrottled | research §14; `PERF-SCROLL-01` |
| 4,075 plain ("cheap") entries | 14,311 | 61 | Chromium | 1× / 4× | `PROFILE-01`; `PERF_THROTTLED_DOM` |

The spread inside a row is run-to-run variance in how many rows the viewport happened
to hold, not a different configuration.

### D.2 The regression the gate sweep caught, and its two root causes

The first full-rate Chromium sweep of the changed tree **failed**, and the failure is the
most useful thing the round produced: the fix's own gates were green on the very build
that crashed. The sweep's own tally, as reported to me, is **six failures: three from the
app, four from stale probe premises**. I record that as given rather than reconcile it —
the two halves sum past six, and I did not re-run the sweep to say which test was counted
twice. What is *measured* in the subsections below is each individual item, from the
instrument's printed `PERF_JSON`; the sweep's verdicts are quoted as verdicts. The app
defect was **React error #185, "maximum update depth exceeded"**: 4 of 6 runs, only on
the changed tree (**0 of 6** on pristine `b0114e3`). The in-source record says "4-6 of 6"
(`ConversationView.tsx:1880`); the gate's own comment says 4 of 6
(`perf-input.spec.ts:162`). I use **4 of 6**, the smaller figure, and note that the two
differ rather than picking the worse-looking one.

There were two independent causes. Each was measured separately, and each had to be fixed
for the page to stop crashing.

#### D.2.1 Composer: three writers for one value, per keystroke

One keystroke drove three writes:

1. `onInput` → `adoptElementValue(node.value)` — adopt the element's own value.
2. `onChange` → `updateDraft(...)` — publish the draft to the parent.
3. the `[draft]` effect → `setInputText(draft)` — take the parent mirror back as state,
   even though the parent's `draft` *is* the value this component just published.
   `ConversationView.tsx:1403-1418`.

React fires **both** `onInput` and `onChange` for a single edit, and `updateDraft`'s
`sendVersionRef++` invalidated `adoptElementValue`'s authorship guard, so the pair
alternated instead of converging. Measured on the crashing build: **783 renders of
`ConversationView`**, **170 of them inside one 400 ms window**, and **590–622
`setSendError` dispatches for a value that never changed**.

The fix is one writer:

| writer | before | after |
| --- | --- | --- |
| text input | `onInput`→`adoptElementValue`, `onChange`→`updateDraft`, `[draft]`→`setInputText` | **one**: `handleComposerChange` reads `event.currentTarget.value` |
| parent mirror | written back as state on every identity | the `[draft]` effect is a **no-op** when the parent merely mirrors our own published value; a genuine external change (restored draft, recovered refusal) still lands (`ConversationView.tsx:1415`) |
| IME / composition guards | in `adoptElementValue` | moved into the single writer |

Result: **0 page errors in 6 of 6 runs, across three separate sweeps**. The permanent gate
is **`PERF-STREAM-02`** (burst typing *and* scrolling while a turn streams ⇒ zero
`pageerror`, `tests/e2e/perf-input.spec.ts:169`); it **fails on the released bundle and
passes on the fix**. Input exactness (`PERF-INPUT-01`) never caught this — the characters
arrived correctly and the page died afterwards — which is why the new gate asserts the one
thing that would have.

#### D.2.2 Height model vs the CSS flex gap

**The function that caused this was `fitSpacersToGap`, and it no longer exists.** It
subtracted `(mounted − 1) × gap` from the spacers at **render time**, so every mounted row
sat `k × gap` below its model offset for a `k` that changed with the mounted range. The
anchor correction then measured a fresh delta after every window move and re-armed
itself. Measured on the crashing build, anchor 21,600 px from the top: the correction
fired **+40, −20, +10, −10, +10, −10 px** in succession — an oscillation, not a
convergence. (`grep -rn fitSpacersToGap apps/web/src` today returns **comments only**, and
each of those comments describes it in the past tense as the removed cause.)

**What ships instead:** the gap is charged **inside `buildOffsets(heights, gapPx)`**
(`transcript-window.ts:138`), which is why the function now takes a second parameter. The
loop adds one gap before every entry after the first — `if (index > 0) running += gap`
(`:171`), so `count − 1` gaps and deliberately none after the last entry. A window move is
therefore not a geometry change and the measured `delta` is **0**. The rationale — and the
177 px trailing-gap measurement that fixed the "no gap after the last entry" detail — is
in the `buildOffsets` comments (`transcript-window.ts:142-153` for the model rationale,
`:165-170` for the 177 px trailing gap); the mirror of it on the component side is
`MessageRow.tsx:358`. `spacerHeights` takes exactly one gap off each
**non-empty** spacer (`transcript-window.ts:262`), and that subtraction depends only on how
many spacers are rendered — 0, 1 or 2 — never on how many entries are mounted, which is
what keeps a window move from changing the document's height.

**Confirmed on the released build:** `PERF-STREAM-02` passes with **0 page errors in 6 of
6 runs across three separate sweeps**, `PERF-LOAD-01` measured **first content 302–320 ms
with DOM 214** (down from 28,578 elements at first content), `PERF-MEMORY-01` shows
**listener drift 0 / row drift 0** over four reconnect+stream cycles, and WebKit
`SCROLL-03` passes **8 of 8 consecutive runs** (§H.1). The oscillation and the alternating
writer are gone in the build that is deployed, not just in a workstream tree.

#### D.2.3 The failures that were the probes, not the app

These are the strongest evidence that the new contract is right: the old instruments
encoded the old assumption that everything is mounted. Three are itemised below; the
sweep's tally counts four stale probe premises, and the fourth was not itemised to me, so
I name only the three I can show.

| probe | what it assumed | what it actually measured | after fixing the probe |
| --- | --- | --- | --- |
| `PERF-01` reachability | indexed `.message-card` by **document position** — `querySelectorAll(".message-card")[2037]` — which only meant "the row at that index" while all rows were mounted | with ~37 cards mounted it read `undefined` and reported `{top:false, middle:false, end:false}` while the reveals were correct and fast | **`{top:true, middle:true, end:true}`**, revealMs **146.8 / 2148.4 / 4143.2**, cards **37**, domElements **214** |
| `PERF-05` scroll steps | compared a **pixel** fraction (`scrollTop = scrollHeight × step/15`) against a **row** fraction — different things once rows have different heights | 11–14 of 15 steps "missed" while frame times never left budget | now asserts the property that matters — a contiguous run of real rows paints at each offset: **`rowsNotFound 0`**, p50 **20.0 ms**, p95 **21.8 ms** |
| `HIST-14` | `transcriptTexts(page).length === 300` — a **mounted-card count** | with a window, "300 mounted" is the wrong invariant entirely | asserts the declared total via `aria-setsize` (**300**) plus readability of an early row |

Two further stale row waits were found and fixed on the way (`perf-cost.spec.ts`
`waitForRows` and `round50-measure`'s `mounted > 100`); both literally required the full
mount and now read `aria-setsize` while asserting the bounded mount explicitly (§H.3).

`HIST-14` also produced a finding worth carrying: **`scrollTop = 0` is no longer a valid
way to read the top of the transcript** — the tail pin correctly overrules it (measured:
the view still showed rows 267–299 after the write). A probe must go through the reveal
path.

One real latent bug was removed on the way: **`entriesRef` was declared but never attached
to the DOM** (`MessageRow.tsx:382`, now `ref={entriesRef}` at `:1064`), so every
gap/lead-in read that depended on it had silently never run.

### D.3 Frame gaps (the owner's symptom)

| fixture | engine | throttle | metric | before | after |
| --- | --- | --- | --- | --- | --- |
| 8,000 heavy, 8 upward flicks | Chromium | 4× | p50 / p95 / max | 88.2 / 544.6 / 793.1 ms | **16.6 / 32.5 / 34.1 ms** |
| 8,000 heavy, 8 upward flicks | WebKit | 4× | p50 / p95 / max | 135 / 597 / **2,112 ms** | **16.0 / 65 / 76 ms** *(workstream build, before the §B.7 fixes; the final-build WebKit run reported verdicts, not these figures — §B.5)* |
| 4,075 heavy, programmatic bottom→top | Chromium | 1× | p95 / max | 358.1 ms longest task | **21.2 / 52.9 ms**, longest task 0 ms |
| 4,075 heavy, flicks (gate) | Chromium | none | p95 / max | — | 33.3 / 34.0 ms, 0 blank / 11 samples |
| 4,075 heavy, flicks (gate) | Chromium | 4× | p95 / max | — | 33.3 / 33.7 ms, 0 blank / 10 samples |

### D.4 Longest main-thread task

| fixture | engine | throttle | before | after |
| --- | --- | --- | --- | --- |
| 8,000 heavy scroll | Chromium | 4× | **763.9 ms** single `RunTask` (TaskDuration 15.304 s total) | 0 ms |
| 8,000 heavy flick train | Chromium | 4× | 151 ms | 0 ms |
| 4,075 heavy | Chromium | 1× | 358.1 ms | 0 ms |
| 12 MB snapshot load | Chromium | 1× | 345 ms (round 57) | 57–62 ms, 1 long task |

### D.5 Snapshot load (the one metric round 57 could not move)

`PERF-LOAD-01`: fixture **12,641,997 bytes** (`SNAPSHOT_12MB_BYTES`), 1,400 entries,
sent as 40 chunks, Chromium, unthrottled.

| metric | round 57 | round 58 (workstream run) | round 58 (release sweep) |
| --- | --- | --- | --- |
| first content | 1257.8 ms (PERF-08, different fixture) / 345 ms longest task | 750 ms | **302–320 ms** |
| DOM elements at first content | 28,578 in document | **53** (research §14 run) | **214** |
| DOM elements once settled | 54,917 (PERF-08) | **308** | **214** |
| peak heap | 127.2 MB (PERF-08) / 54.3 MB baseline | **133.7–133.9 MB** | not reported |
| long tasks | 2, worst 505 ms (PERF-08) | **1**, worst **57–62 ms** | 0 for `PERF-TOOLS-01`'s 600 events |
| entries reported | 4,075 / 1,400 | 1,400 (equals the snapshot) | 1,400 |

Two runs of the same gate gave different first-content numbers: **750 ms** during the
workstream and **302–320 ms** in the release sweep. Both are recorded, and the difference
is **not explained by anything I can show** — the two runs differ in build, machine load
and test order at once, and I did not redesign the measurement to isolate which. What is
not ambiguous: the sweep ran the single authoritative build that was deployed, and that
build still exceeds 200 ms.

Read the sweep column carefully: **first content is 302–320 ms and the 200 ms budget is
still exceeded.** The DOM is what collapsed — 214 elements instead of 28,578 — while the
parse of a 12 MB snapshot and its reducer replay are untouched. The gate prints its number
and takes the pre-existing over-budget branch (§H.1, §J.2–§J.3); it is **not a green**.

### D.6 React commits

| measurement | value |
| --- | --- |
| commits across an 8-flick train, 2,000 heavy entries, 78,617 elements, 4× throttle | **2** |
| commits in the invalid probe arm | 0 (arm discarded — wrong layout model) |

The counter is installed through `__REACT_DEVTOOLS_GLOBAL_HOOK__` before any app
script, so this is React's own report, not an inference from source. **No post-windowing
commit count was taken**; the window changes how much a commit mounts, and its cost is
reported as task time (§D.7) instead. What *was* measured about render volume after the
window is the pathological case that mattered: **783 renders of `ConversationView` (170
inside one 400 ms window) after a 500-character burst while streaming**, which is what
`PERF-STREAM-02` now forbids by asserting zero page errors and what the single-writer fix
(§D.2.1) removed. That is a crash-loop measurement, not a steady-state commit count, and is
not offered as one.

### D.7 Append and stream cost, 4× throttle, 4,075-entry history

Instrument: `tests/e2e/perf-cost.spec.ts` (round 57's instrument, adapted to the new
contract).

| metric | round 57 | round 58 |
| --- | --- | --- |
| script per appended row | 1.33 ms | **0.79 ms** |
| style per appended row | — | 0 ms |
| layout per appended row | — | 0.04 ms |
| **task per appended row** | not reported per append (longest frozen task 95 ms) | **2.22–2.47 ms** |
| longest frozen task, append burst | 95 ms | **0 ms** |
| script / layout / task per *update* frame | 0.16 / 0.75 / 67 ms worst | **1.1 / 0.34 / 3.02 ms** (task per update) |
| DOM during the burst | 28,578 | **61** elements |
| declared entries during the burst | 4,075 | 4,075 |

The append burst length differs between rounds (60 appends in round 57, 40 in round 58),
so the per-append figures are compared and the burst totals are not.

### D.8 Input exactness

| gate | result | detail |
| --- | --- | --- |
| `PERF-INPUT-01` — 500 characters as one burst during a live stream | **PASS** | **500/500, exact: true**; the page saw **500** `input` events carrying 500 characters; `committedShrank: 0`, on 3 consecutive runs |
| the same gate before the fix | FAIL (the defect) | **493–497** committed (495 / 493 / 494 across runs); the in-page tally proved the page dispatched all 500, so the app ate them |
| `PERF-INPUT-02` — paste, selection replace, held Backspace, Vietnamese IME | **PASS** | paste 2000/2000; replace 1001/1001; Backspace removed exactly 1 with no addition; composition landed `xin chào thế giới` exactly once with 1 `compositionstart` / 1 `compositionend` |

The fix is at the root (`ConversationView.tsx` `onInput` adopts the textarea's own value
when it disagrees with state) and now carries the review's authorship guards: skip while
composing, skip untrusted events, skip a value older than the last send.

**Proven scope:** the burst is Playwright's fastest path (`pressSequentially`,
`delay: 0`). It proves that when the page receives N characters the committed value is
exactly N; it does **not** prove that no hardware-level or heavily throttled input
sequence could outrun a commit (§J).

### D.9 Blank duration, heap, streaming, bundle

| metric | value | condition |
| --- | --- | --- |
| blank runs, all `SCROLL-01..12` scenarios | **0 ms** in every scenario except one WebKit `SCROLL-01` sample of **283 ms**, measured on the workstream build (§J.1); no post-fix blank count was reported | see §J.1 |
| heap, 4 reconnect+stream cycles | listeners **2 → 2** (drift 0), rows **37** every cycle, heap **+7.8 MB** on the final run (earlier runs 6.6–13.2 MB); release sweep `PERF-MEMORY-01`: **listener drift 0, row drift 0, heap +6.6–6.9 MB** | Chromium, mock host |
| streaming responsiveness (12 Markdown sections into 4,075 entries) | stream wall **778 ms**, longest task **0 ms**, DOM **185** elements, 4,075 entries still reported | Chromium, unthrottled |
| bundle delta, windowing + search | **470.70 → 481.91 kB raw, 138.24 → 142.18 kB gzip = +3.94 kB gzip**, **no dependency added** | `pnpm --filter @caw/web build` |
| bundle delta, presentation layer | CSS **53.01 → 58.23 kB raw / 9.78 → 10.60 kB gzip = +5.22 / +0.82 kB**; JS byte-identical with and without the layer | same build, import commented out |
| deployed bundle, as served | `index-hVfEUPqx.js` **486,141 B raw / 143,295 B gzip**; `index-e2muy0ow.css` **58,345 B raw / 10,648 B gzip** | §I.1/§I.3, the `d29ffe6` build that the origin serves and that a scratch rebuild reproduced |

---

## E. Visual comparison

### E.1 The reference situation, honestly

**No owner-supplied premium reference image exists on this machine. That is a negative
result from a search, not an assumption.** `PREMIUM_DESIGN_SPEC.md` §0 records the
search: every `*.png|jpg|jpeg|webp` under `/home/heheboiz` at depth ≤ 4 and every image
under the repo, all four `~/Pictures/Screenshots/*`, all of `~/Downloads` (215 images),
`/tmp`, `/var/tmp`, the OMP blob store (`~/.omp/agent/blobs/`, 900+ files), and every
session journal under `~/.omp/agent/sessions/` checked for attached image content
blocks (`{"type":"image"}`, `data:image/`, `"image_url"`, `file://…png`). No such
artifact exists by name; the brief that started this line of work says the owner
supplied two screenshots, and **the bytes never reached disk** — the journals contain no
image content block at all.

The four `~/Pictures/Screenshots` candidates were read and are **terminal screenshots of
a markdown performance report**, not UI references. The blob-store phone-shaped images
are this app's own captures re-encoded by the harness (780×1688 / 750×1334 / 640×1136 /
860×1864 — exactly the four phone viewports at DPR 2).

Therefore the target was derived from the two written sources that do exist —
`round54-premium-mobile-design.md` §1/§3 (near-black canvas, ONE compact header row,
small status dot/word, compact navigation summaries, rounded right-aligned user bubble,
minimal assistant chrome, compact fixed composer) — plus **objective divergences
measured in the round-57 captures**:

| divergence (round 57, measured at pixel level) | value |
| --- | --- |
| header plate | a single uniform `rgb(27,27,27)` (`--surface-primary` #1b1b1b) for the first **56.0 css px** at all four widths, against a `#050505` canvas |
| dashboard plate | three bordered `#242424` cards, **~64–72 css px** including gutter |
| first transcript row | starts **~128 css px** down a 568 px screen — ~23 % of a small phone is permanent chrome |

### E.2 After state, measured

`tests/e2e/premium-visual.spec.ts`, **4 passed**, 7 states × 4 widths, captured against
the built bundle.

| width | header | dashboard row | cards | document overflow | sub-44 px controls | overlaps |
| --- | --- | --- | --- | --- | --- | --- |
| 320×568 | **53** | 48 | 3 × 44 | 0 px | none | none |
| 375×667 | **53** | 48 | 3 × 44 | 0 px | none | none |
| 390×844 | **53** | 48 | 3 × 44 | 0 px | none | none |
| 430×932 | **53** | **52** | 3 × 44 | 0 px | none | none |

The gate asserts `≤ 54` so a regression fails instead of hiding inside the brief's 56 px
ceiling. 53 = 44 px control + 2×4 px padding + 1 px hairline.

Painted contrast, computed from laid-out elements with alpha composited against the real
stack, twice (token table and on-element):

| element | contrast |
| --- | --- |
| header title | 18.69:1 |
| status word (idle/running) | 7.52:1 |
| dashboard value | 14.24:1 |
| **dashboard sub-line** | **4.86:1 ← the lowest text contrast in the chrome** |
| warning notice | 8.19:1 |
| user bubble | 14.24:1 |
| assistant prose | 18.69:1 |
| composer value | 16.60:1 |

Two usages that were objectively wrong were fixed rather than restyled:
`.files-diff-gutter` painted the ornament-only `--text-faint` as text at **4.34:1** → now
`--text-muted` at **6.09:1**; and one **outstanding defect is recorded, not fixed**
because the file is not in this workstream's ownership: `.agent-chat-carry`
(`agent-chat.css:137`) still paints `--text-faint` as 0.8 rem italic text at **3.85:1**.

### E.3 Captures

`docs/audits/assets/round58/` — **28 files**, at 320×568, 375×667, 390×844, 430×932:

```
idle-*.png  streaming-*.png  tool-running-*.png  approval-*.png
connection-lost-*.png  search-*.png  subagents-*.png
```

The brief named 20; the extra 8 are the two surfaces the windowing change introduced
(search panel, subagent roll-up), which had no round-57 baseline.

**Who read them.** These PNGs were read by a **vision-permitted subagent** (the
`premium-design` lane, which is allowed to read pixels; `AGENTS.md` rule 11 forbids the
report's main lane from reading images). Its words, quoted verbatim:

> "Header reads as one row on the canvas, not a lighter plate: 53px, title + dot/word,
> ⋯ right, hairline below. Measured rgb(5,5,5) behind it at all widths."
>
> "Dashboard is now visibly subordinate: three 44px cards, one short line each, and the
> transcript's first line begins at y=101 instead of ~128 on a 568px screen (~27px /
> 4.7% of the viewport returned)."
>
> "User bubble is the only filled rounded block; assistant replies are chrome-free
> prose. That contrast is what makes it read as a conversation rather than a log."

It also reported what was **worse or notable**, and those reports are kept rather than
buried:

| finding | disposition |
| --- | --- |
| "A clipped row tops the transcript at 320 and 375 … a ~10px sliver of the previous `.activity-group-head`" | **real CSS defect, found and fixed**: `overflow: auto` clips to the *padding* box, so `.messages-scroll`'s own `padding-top: 10px` was a permanent 10 px window rows painted through. The inset moved into the scrolling content (`padding-top` on `.messages-content`, `scroll-padding-top: 10px` on the scroller), verified at 320 and 375, idle and streaming, in `~/.cache/clip-probe/{width}-{state}-{before,after}.png` |
| "Dashboard sub-line ellipsises to `0 running · all…` at 320" | **deliberate**; the informative half survives and the full string is on the card's `aria-label` |
| "`Latest` still overlaps the approval card's second option at 320" | **pre-existing round-54 geometry (`bottom: safe + 84px`), NOT fixed** — moving it is a transcript-control change, recorded in §J |
| "Search at 320 leaves only 150.4px of transcript" | **honest but cramped**; the 45 vh panel cap is what keeps it usable, recorded in §J |

No pixel claim in this report is the main lane's: geometry and contrast are DOM/computed
style assertions in the spec, and ink-based observations are the subagent's, quoted.

---

## F. Tool activity redesign

### F.1 The owner's complaint, verbatim

> "the transcript renders stacked repetitive cards —
> ```
> ✓ Run 1 command
> ...
> ✓ Run 1 tool
> ✓ Run 1 command
> ```

### F.2 Census: the owner's real journal, before

Evidence source, printed by a throwaway vitest simulation (since deleted) driving the
owner's own journal — `~/.omp/agent/sessions/-data-coding-agent-web/2026-11-05T04-51-15-268Z_…jsonl`,
15.9 MB — through `transcriptMessagesFromEntries` + `groupActivity`:

```
rows: 4806   entries: 7612   entries with toolResult: 2432
total groups: 2163   rows passed through: 2374
distinct labels: [ ['Run 1 command', 1460], ['Edit 1 operation', 197],
  ['Run 2 commands', 193], ['Run 1 tool', 128], ['Read 1 file', 107],
  ['Run 2 tools', 37], ['Edit 2 operations', 26], ['Read 2 files', 13],
  ['Search 1 pattern', 2] ]
```

and the reason they were split:

```
assistant: 2123   blank: 1002   prose: 1121
runs joined across blanks: 1136   max members: 118
```

**1,002** assistant rows were pure tool-call echoes that render nothing once the
result row is on screen — and each one cut a run in two, producing 2,163 cards for
2,432 operations.

### F.3 Census: after

Same journal, same pipeline, new fold:

```
cards now: 1557   tool members covered: 2432
state dist: [ ['completed', 1478], ['failed', 79] ]
top labels: [ ['Run 1 command', 589], ['Run 2 commands', 236], ['Edit 1 operation', 163],
  ['Run 1 tool', 94], ['Read 1 file', 93], ['Run 3 commands', 67],
  ['Edit 2 operations', 26], ['Run 4 commands', 22], ['Run 2 tools', 13],
  ['Read 2 files', 11], ['Run 5 commands', 9], ['Run 6 commands', 8], … ]
```

**1,557 cards (−606, −28 %), all 2,432 tool operations still covered, lossless**
(`flattenActivity(groupActivity(rows)) === rows`, asserted in
`tests/web/tool-activity-evidence.test.ts`).

### F.4 Evidence rule, per label type

| Label | Source of the number | Ceiling / refusal |
| --- | --- | --- |
| `Run N commands` / `Search N patterns` / `Edit N operations` / `Apply N patch operations` | `toolMembers(group).length` — **real tool rows only**, echoes excluded | A count is a count of rows. It never becomes "tests passed" or "files changed". |
| `Read N files` | distinct **paths** from the call's own arguments (`path` / `file_path` / `filePath`) or the result's `details.resolvedPath` / `path` / `filePath` (`provenPathOf`) | Same file twice → `Read 1 file · 2 calls`; no proven path → `Read N calls` + `N path unverified`, **never** "files" |
| `3 failed \| 15 passed` | the tool **result's own text**, whole-line anchored patterns only: vitest's `Tests …` line (explicitly not `Test Files`) and pytest's `=== … in 0.52s ===`; count words required | Parsed only for `command` / `test` / `other` categories — **never** for `read`, so a `cat` of an old log cannot mint a metric through the read path |
| `+42 −18` and `Changed N files` | `diffStats` over **real unified diffs** via `summarizeFileChanges` | No diff, no number. An `edit` call is not a changed file. |
| `N subagents working` | the host's `AgentSnapshot[]` (`kind === "sub" && status === "running"`) | The `task` tool's `details.progress` is deliberately unused: a census of 1,102 `task` results found `status` `"pending"` 1,458 times out of 1,458 and `results` always empty |

### F.5 How the fold is proved not to merge unrelated work

`isSuppressedCallEcho` (`apps/web/src/tool-activity.ts:108`) absorbs an assistant row
**only** when all three hold: it is an assistant row, every block is either a
`toolCall` whose id is already represented by a result row with record arguments, or
empty text — i.e. it mirrors the renderer's own three conditions, so the fold can only
ever absorb a row the renderer already draws as an empty element. Anything visible —
prose, an unrepresented call, a notice, an image — breaks the run. Echoes are **carried
inside the group** so nothing is dropped, and they are never counted (`toolMembers`
filters `role === "tool"`). Grouping is also by **category** and only over
**contiguous** runs, so activity never appears to belong to a turn across a user or
assistant boundary it did not belong to.

### F.6 Failure escalation

`groupState` (`tool-activity.ts:417`) escalates when the wire's `isError` flag is set,
**or** when the result's own runner summary reports failures. The metric and the verdict
read the *same* `evidence.test` value, so a `✓` head can never sit above a metric that
says `3 failed` — measured across all **1,557** groups of that session: **0
disagreements**. On the real session **79 groups escalated to `failed`, and 59 of them
come from result text the wire had flagged `isError: false`**. A group failed only by
runner output shows the runner's own line verbatim, labelled `Runner reported: …`, in
the collapsed preview (the review's W7).

### F.7 Accessibility contract

The collapsed head is a real `<button>` with `aria-expanded`; its accessible name is
`"<state word>: <label>[, note][, +N −M][, metric]"` — one `groupSummary` call, so what
is spoken and what is shown cannot drift; the state glyph and the chevron are
`aria-hidden`; the failure is announced **in words**, not only in colour; the expanded
body is exactly the member rows, in order. `SubagentActivityRow` renders **nothing** at
zero running, and with no navigation handler it states the count without offering a
dead button.

### F.8 Deliberately not claimed

- **No "tests passed" without a runner summary.** `metric` is `null` when no anchored
  summary was found; the label says only what the rows prove.
- **A `cat` of an old log still matches**, and that is documented as a ceiling in the
  module header rather than hidden: the parser cannot know whether a summary line came
  from a run that just happened or from a file that was read *by a command*. The
  mitigation is that only `command`/`test`/`other` outputs are parsed, and the metric is
  worded as a count of a runner's report, never as "the build is green".
- **No merge for merge's sake.** The 606 cards removed are echoes that drew nothing; no
  visible row was deleted to reduce a count.

---

## G. Model migration

### G.1 Requested and verified

Requested: `wdb/deepseek-ai/DeepSeek-V4.1-Flash-1017`.

Catalog row, verbatim from `omp models --json` (`model-migration-notes.md` §1; re-read
this round with `omp models find deepseek-ai/DeepSeek-V4.1-Flash-1017`):

```json
{
  "provider": "9router",
  "kind": "chat",
  "id": "wdb/deepseek-ai/DeepSeek-V4.1-Flash-1017",
  "selector": "9router/wdb/deepseek-ai/DeepSeek-V4.1-Flash-1017",
  "name": "wdb/deepseek-ai/DeepSeek-V4.1-Flash-1017",
  "contextWindow": 1000000,
  "maxTokens": 128000,
  "reasoning": true,
  "thinking": ["low", "high", "max"],
  "input": ["text", "image"],
  "cost": { "input": 0, "output": 0, "cacheRead": 0, "cacheWrite": 0 },
  "pricingStatus": "unknown"
}
```

| Field | Value |
| --- | --- |
| Effective selector | `9router/wdb/deepseek-ai/DeepSeek-V4.1-Flash-1017`; with a level, `…-1017:high` |
| Default lane | `9router/wdb/deepseek-ai/DeepSeek-V4.1-Flash-1017:max` |
| Worker lanes | `9router/wdb/deepseek-ai/DeepSeek-V4.1-Flash-1017:high` |
| Supported thinking levels | **`low`, `high`, `max`** |
| **Not supported** | **`medium` and `xhigh`** (and `minimal`) — the catalog lists only three levels; `omp models find …:max` correctly reports no row because the suffix is applied by the runner, not the catalog |
| Context / output | **1,000,000** / **128,000** tokens |
| Base id | `wdb/deepseek-ai/DeepSeek-V4.1-Flash` is **still served** (both rows exist), so a stale saved preference is not a dangling selector |
| Catalog size | 331 rows via `omp models --json`; 329 after the adapter's dedupe/validation; the target is present and a bogus id is not |

### G.2 Every config file changed

All four are the only files that named the old id as **active** config. Each has a
`.bak-model-migration-1017` backup beside it.

| File | Change (before → after) |
| --- | --- |
| `~/.omp/agent/config.yml` (global) | `modelRoles.default: …-V4.1-Flash:max` → `…-V4.1-Flash-1017:max`; fallback chains keyed on `…-V4.1-Flash:high` → `…-1017:high` (4 references) |
| `~/data/coding-agent-web/.omp/config.yml` (repo project) | `modelRoles.deepseek_v41_hi` and 3 chain references → `…-1017:high`. `modelRoles.default` was already `…-1017:max` |
| `~/data/cir/.omp/config.yml` (CIR project) | `modelRoles.default` → `…-1017:max`; 3 chain references → `…-1017:high` |
| `~/.omp/agent/agents/caw-deepseek.md` | `model:` and the description → `9router/wdb/deepseek-ai/DeepSeek-V4.1-Flash-1017:high` |

Policy docs updated (live policy, not history): `docs/operations/subagent-model-policy.md`
(headline, priority table, effort line, owner ruling, history tail) and
`docs/operations/deepseek-context-cap.md` (current-state banner only; the historical
200k-cap recipe and its transcript are untouched).

**Not touched, deliberately:** `apps/web/src` needs no change — the only reference is a
comment at `agent-model.ts:154` and a test that exercises `modelDisplayName` by taking
the last path segment (`"DeepSeek-V4.1-Flash-1017"`), which still holds. Historical
records (round reports, `acceptance-run-plan.md`, `docs/research/model-catalog.md`,
`tests/fixtures/omp-session/*.jsonl`, recorded journals) were left verbatim because they
record what was actually used at the time.

Config was validated through **OMP's own loader**, not by eye:
`omp config list --scope global|project --json` exited 0 and reported the migrated
values for all three scopes. There is no separate `omp config validate`.

### G.3 Next launch vs existing session

Three distinct things, and they are not the same:

1. **A running OMP process keeps the model it resolved at launch.** Journals of the three
   live sessions, read before and after the edit and identical:
   - `$0` `caw-DOCKER…` → `model_change => 9router/ag/gemini-3.8-flash-high`, thinking `high`.
   - `$1` `caw-CTX…` → `…-V4.1-Flash` (old id), thinking `max`. **Still on the old id until
     its next launch**, by design.
   - `$2` `caw-New-chat…` → `…-V4.1-Flash` (old id), thinking `high`; its saved CAW
     preference was already `…-1017`, which applies on next launch.
2. **Saved next-launch model is per conversation.** CAW stores `modelPreference` and
   passes `--model=<selector>` on the next launch (`apps/server/src/app.ts:1179`,
   `packages/omp-adapter/src/tmux.ts:280`). New chats inherit the migrated
   `modelRoles.default`; a preference saved as the old id still launches the old id,
   which the catalog still serves.
3. **New default for all future sessions** is `…-1017:max` in global, repo and CIR config.

### G.4 Proof no live session was touched

Read-only snapshot of the private tmux server, taken **before** and **after** the edits:

```
$ tmux -S $HOME/.local/state/coding-agent-web/tmux.sock list-panes -a \
    -F '#{session_id}|#{session_name}|#{pane_pid}|#{pane_dead}|#{session_created}|#{socket_path}:#{start_time}:#{pid}' | sort
```

`diff before after` → **identical**, and the SHA-256 of the two snapshots is the same:

```
9f51ff2c3180a10f9b1abc88c1b368410caf59f6a1c023f1f693b97d39dc9d85  before
9f51ff2c3180a10f9b1abc88c1b368410caf59f6a1c023f1f693b97d39dc9d85  after
```

Pane pids 1204278 / 2080435 / 2082046 alive with unchanged start times; the tmux
**server** identity `1793822846:1204277` unchanged, so no session was re-created. The
CAW server (pid 92072) was not restarted and still holds 8791/8792. No `omp` process was
signalled and no overlay config was modified. No agent was launched, stopped, attached
to or resumed.

### G.5 Tool calling

**UNVERIFIED from the catalog.** No row in the 331-row catalog carries a `tools` field
(keys are `contextWindow, cost, id, input, kind, maxTokens, name, pricingStatus,
provider, reasoning, selector, thinking`), so the catalog neither confirms nor denies
tool calling. `[INFERENCE]` The base `DeepSeek-V4.1-Flash` row has identical metadata and
is used as a tool-running worker today, so the `-1017` snapshot is expected to support
tools the same way. **No live inference call was made** to prove it — that would spend
provider credits and was out of scope. Recorded as an inference, not a result.

---

## H. Testing

Verdict vocabulary is PASS / FAIL / BLOCKED / UNVERIFIED only. Every number below is an
**observed release-sweep or CI value**; nothing is rounded into a different claim and nothing
unfilled is written as a pass. **The gate rows were re-measured on `744a954` against a scratch
build of the tree that is actually deployed**, not copied forward: the previous sweep ran on
`8d3d2cc`, two commits below the served bundle, so carrying those numbers forward would have
left the shipped code unswept. The scratch dist was built with
`npx vite build --outDir /tmp/caw-final-dist` and served through
`CAW_WEB_DIST_DIR=/tmp/caw-final-dist` — `apps/web/dist` was hashed before and after and did
not change (`index-hVfEUPqx.js` `02660079…8a035b`), so production was not touched. Local runs
used `CAW_E2E_CHANNEL=chrome` because this shell has `CI=1`, which would otherwise select
Playwright's bundled chromium (not installed here). One `--project`, `--workers=1`,
`--retries=0`, `--trace=off` per invocation; stats read from the JSON reporter. The remaining
negative verdicts are physical-device work — CI is read: run **121 on `99fae06` = `success`**,
a tree whose build inputs are identical to the deployed `d29ffe6`; run **120 on `d29ffe6`
itself** was `cancelled` 20 s in by a doc-only push, so no verdict exists for that exact SHA
and it is not called green (§I.2). Step detail is unavailable for every run.

### H.1 The gate table

| Gate | Verdict | Observed | Command |
| --- | --- | --- | --- |
| `pnpm -r typecheck` | **PASS** | exit 0, all 8 projects; **8.39 s** then **8.41 s** on the re-run after the attempted fix was reverted | `pnpm -r typecheck` |
| Full vitest (`tests/web`, `server`, `adapter`, `runtime`, `relay`, `protocol`, `guest`, `compat`, `deploy`, `scripts`) | **PASS** | **200 files passed / 2 skipped (202)**; **1852 tests passed / 8 skipped (1860)**; 29.82 s, and **29.88 s** on the re-run | `npx vitest run` |
| Chromium E2E, full suite, serial — sweep 1 | **FAIL** | expected **215**, unexpected **1**, skipped **3**, flaky **0**; **523 s**. The single failure is `mobile.spec.ts` :: *long conversation scrolls internally and detached reading stays put* — `expect(locator).toBeVisible()` on `getByRole('button', { name: /Latest/ })` received **element(s) not found** (7 s timeout). Triage: **pre-existing load-sensitive tail-lock defect, not `d29ffe6`** — and see the *Latest*-visibility row below, where the same failure then reproduced in **both** back-to-back re-runs (in a second spec) and the proposed fix failed `PERF-SCROLL-09` | `CAW_E2E_CHANNEL=chrome CAW_WEB_DIST_DIR=/tmp/caw-final-dist npx playwright test --project=chromium --workers=1 --retries=0 --trace=off --reporter=json` |
| Chromium E2E, full suite, serial — sweep 2 (back-to-back, clean) | **PASS** | expected **216**, unexpected **0**, skipped **3**, flaky **0**; **515 s** | same |
| Chromium E2E, full suite, serial — sweep 3 (back-to-back, clean) | **PASS** | expected **216**, unexpected **0**, skipped **3**, flaky **0**; **514 s** | same |
| Chromium E2E, full suite, serial — re-run A (**unmodified tree `3dc56e9`**, after the fix attempt was reverted) | **FAIL** | expected **215**, unexpected **1**, skipped **3**, flaky **0**; **522 s**. `mobile.spec.ts` :: *long conversation scrolls internally…* — the same *Latest* `toBeVisible()` `element(s) not found`. The flake **reproduced on the first re-run**, so it was not a one-off | same command |
| Chromium E2E, full suite, serial — re-run B (back-to-back) | **FAIL** | expected **215**, unexpected **1**, skipped **3**, flaky **0**; **525 s**. This time `regression.spec.ts` :: *long transcript stays inside viewport…* — same assertion, same received value, **a second spec** | same command |
| WebKit perf + a11y + scroll | **PASS** | expected **26**, unexpected **0**, skipped **1**, flaky **0**; **188 s**, and identical **26 / 0 / 1 / 0** in **191 s** on the re-run | `CAW_E2E_CHANNEL=chrome CAW_WEB_DIST_DIR=/tmp/caw-final-dist npx playwright test tests/e2e/perf-scroll.spec.ts tests/e2e/perf-scroll-gates.spec.ts tests/e2e/perf-a11y.spec.ts --project=webkit --workers=1 --retries=0 --trace=off` |
| `PERF-SCROLL-01..09` | **PASS** | Chromium **25** (12 scroll + 13 gates); WebKit **14** (gates + a11y); `PERF-06` (**Agent Detail round trip**) **0 px drift** on both engines | `perf-scroll-gates.spec.ts` + `perf-scroll.spec.ts`, per project |
| `SCROLL-03` WebKit — the blocker | **PASS** | **8 of 8 consecutive runs**; `posinset 4075`, inside the band | `npx playwright test tests/e2e/perf-scroll.spec.ts --project=webkit -g SCROLL-03` |
| `PERF-STREAM-01` | **PASS** | included in the 13-passing `perf-scroll-gates` set above; no separate figure was reported to me, so none is claimed | `perf-scroll-gates.spec.ts -g PERF-STREAM` |
| `PERF-STREAM-02` (new this round) | **PASS** | **0 page errors in 6 of 6 runs**, three separate sweeps; **fails on the released bundle**, passes on the fix | `perf-input.spec.ts -g PERF-STREAM-02` |
| `PERF-INPUT-01` / `PERF-INPUT-02` | **PASS** | **500/500** human, **500/500** burst; paste **2000/2000**; replace **1001/1001**; Backspace monotonic; Vietnamese IME exact once | `npx playwright test tests/e2e/perf-input.spec.ts` |
| `PERF-TOOLS-01` | **PASS** | 600 events / 30 ids → **1 group**, **0 extra rows**, **0 long tasks** | `perf-scroll-gates.spec.ts -g PERF-TOOLS` |
| `PERF-LOAD-01`, Chromium | **PASS** — *numbers only, not a green* | 12 MB snapshot measured: first content **302–320 ms against the unchanged 200 ms budget**, DOM **214**. `skipIfOverBudget` printed the number and skipped the timing assertion, so the budget claim is **unmet**; the surrounding assertions (snapshot arrived, entries counted, DOM bounded, heap recorded) did run and passed. Read this row as "measured and published", never as "within budget". **WebKit: BLOCKED** — needs CDP for heap and node count, which WebKit does not expose; that is the one legitimate skip in the WebKit run | `perf-scroll-gates.spec.ts -g PERF-LOAD` |
| `PERF-MEMORY-01` | **PASS** | 4 reconnect+stream cycles: **listener drift 0**, **row drift 0**, heap **+6.6–6.9 MB** | `perf-scroll-gates.spec.ts -g PERF-MEMORY` |
| `PERF-SEARCH-01` | **PASS** | hit at entry **4,000** was unmounted before search, **mounted and on screen** after; DOM **386** | `perf-scroll-gates.spec.ts -g PERF-SEARCH` |
| `SCROLL-01..12` (`perf-scroll.spec.ts`) | **PASS** on both engines | Chromium: **12** scroll scenarios, inside the 25 above, same 1 skip. WebKit: covered by the run reported as **26 expected / 0 unexpected / 1 skipped / 0 flaky**, and `SCROLL-03` — the scenario that was the blocker — was additionally run **8 of 8 consecutive** times with `posinset 4075` in band. I did not receive the per-file split of those 26, so no arithmetic is claimed about which file the 12 sit in | `perf-scroll.spec.ts`, per project |
| `PERF-A11Y-01` | **PASS** | list + listitems through Playwright's aria engine on **both engines**; `role` / `aria-setsize` / `aria-posinset` read on the entry's **real box**; calibration control (a native `<ul><li>` exposes the same absence of `posinset`/`setsize` through CDP) | `npx playwright test tests/e2e/perf-a11y.spec.ts` |
| `auth.spec.ts` | **PASS** | **4/4** in both cookie modes: `caw_session` + `secure:false` (loopback dev) and `__Host-caw_session` + `secure:true` (production) | `npx playwright test tests/e2e/auth.spec.ts` per project |
| `pnpm compat` | **PASS** | **18 ok, 0 warn, 0 fail** (omp 18.15.0, tmux 3.6, Node 20.19.5), twice | `pnpm compat` |
| the *Latest*-visibility flake (`mobile.spec.ts`, and `regression.spec.ts` on the re-run) | **LEFT AS A DOCUMENTED LIMITATION — not fixed, code reverted; the proposed fix fails its own gate** | **Frequency.** On the unmodified tree (`3dc56e9`) it fired in **2 of 2** consecutive full Chromium sweeps, in a different spec each time: sweep A `mobile.spec.ts` :: *long conversation scrolls internally and detached reading stays put*, sweep B `regression.spec.ts` :: *long transcript stays inside viewport, detached reading stays put, and Latest follows tail*. Both failed identically at `expect(locator).toBeVisible()` on `getByRole('button', { name: /Latest/ })`, **Received: element(s) not found** — i.e. `isDetached` was false, so `.latest-row` was never mounted. **Mechanism.** `updateTailLock` holds the lock while `geometryChanged`; a reader's scroll-up arriving in an event whose frame also changed the document's size is therefore attributed to the container and re-pinned, after which the `[messages, streamingText]` layout effect pins again. Both failing specs detach the view **immediately after a layout change** (`mobile.spec.ts` after 24 appends + `scrollTop = 120`; `regression.spec.ts` right after `setViewportSize`), which is exactly the same-frame case. **The requested fix was implemented and rejected by its own gate.** Replacing `geometryChanged` with a distance-residue test — release when `distance − last.distance − |Δ(scrollHeight − clientHeight)| > 0.5` — passed the unit race test and kept `SCROLL-03`/`05`/`06`/`09` reasoning intact in principle, but **`PERF-SCROLL-09` failed deterministically twice**: *the newest entry must be painted once the snapshot is loaded and the DOM is quiet* — the chunked load never re-acquired the tail. Instrumenting the real scroller during that load gave the numbers that matter: two scroll events reported a **distance residue of −203,306 and −127,900** while the load was still mounting, then **+40 and +35** on the settled tail. Those large negative residues are unauthored: no reader moved, yet `distance` shrank far more than the geometry change explains, so the discriminator does **not** hold on a measuring virtual list, where `scrollHeight` is an estimate that is replaced as rows measure. **Measurement that contradicted the premise of the fix** (recorded so it is not re-attempted blind): `overflow-anchor` is `none` (`styles.css:724`), and on the current build a stationary reader's `distance` moved by **exactly 0** across a 24-chunk load that moved `scrollTop` and `scrollHeight` together by **201,956px**, a 300px flick moved it by exactly **300**, and a synthetic grow+scroll in the same task moved it by **300** for an appended 600px. So `distance` is trustworthy on a settled list, but **not** on one that is still measuring — which is precisely the state every failing event occurs in. **Not tuned green.** The tolerance was left at the file's existing `0.5px` sub-pixel convention rather than raised until `PERF-SCROLL-09` passed; fitting it would have hidden the estimating-`scrollHeight` failure rather than fixed it. The change was reverted (`git checkout`), the temporary probe specs deleted, and nothing about the assertion was weakened. **What this means for release.** The defect is real and load-sensitive, it is **not** `d29ffe6`'s (`updateTailLock` predates it, `b1ef86c`), and it is visible to users as the jump-to-latest affordance not appearing after a fast flick — the yank itself is bounded because the re-pin puts the view at the tail, not somewhere random. Fixing it needs a discriminator that survives an estimating `scrollHeight` (e.g. judging authorship from the windowing model's own estimate-vs-measure transitions rather than from the DOM total); that is a design change, not a tolerance change | `npx playwright test --project=chromium --workers=1 --retries=0 --trace=off` |
| `d29ffe6` / `b6ace88` — coverage of the **deployed** tree | **PASS** | The full browser sweep now covers the deployed bundle's exact code. Proof: `HEAD` (`744a954`) differs from the deployed `d29ffe6` by **one file, `docs/`-only** (`git diff --name-only d29ffe6 HEAD` → no non-doc path), so the tree swept here is the tree that ships; the scratch bundle `npx vite build --outDir /tmp/caw-final-dist` came out **byte-identical to production** — `index-hVfEUPqx.js` `02660079…8a035b`, `index-e2muy0ow.css` `ca7c06d5…1fccc5`, matching `apps/web/dist/assets/*` before **and** after the whole sweep (production untouched). `tests/e2e/overlay-collision.spec.ts` (the 6 gates `d29ffe6` added) ran **6/6 in every Chromium sweep** — sweeps 1–3, plus **6/6 in both re-runs** A and B that were otherwise red on the *Latest* flake; the `activeUiRequest === null` gate is the shipped code path swept **219 specs** deep (216 expected + 3 skipped), and `b6ace88`'s deleted composer ref cannot fail without a typecheck/build error — `pnpm -r typecheck` exit 0 and the identical bundle hash cover it. `d29ffe6`'s other risk (a `.latest-row` regression) is what sweep 1's red measured; re-runs then showed it is **not** `d29ffe6`'s and **not** rare — it reproduced twice more, in two different specs, on a tree with `d29ffe6`'s change reverted (see the *Latest*-visibility row) | Chromium sweeps 1–3 and re-runs A/B above |
| CI (`.github/workflows/ci.yml`) | **PASS on run 121 (`99fae06`, `success`)** — the tree with the deployed build inputs; run **120 on the deployed `d29ffe6` itself is `cancelled`**, not green. Step logs **UNVERIFIED** for every run | Read without `gh` (absent; `GITHUB_TOKEN`/`GH_TOKEN` unset) from `https://api.github.com/repos/Le-Minh-Nhut/coding-agent-web/actions/runs`: 121 `99fae06` `success` (completed 02:59:40Z); 120 `d29ffe6` `cancelled` (superseded 20 s after start by the doc push); 119 `b6ace88` `success`; 118 `9e36a35` `cancelled`; 117 `f788ab8` `success`; 116 `d0e1bd5` `success`. Every `cancelled` row is the workflow's own `concurrency: ci-<ref>` with `cancel-in-progress: true` superseding an in-flight run — **not evidence about the code**. Per-step logs are not exposed without a token, so every step-level claim stays UNVERIFIED. The deployed SHA has no run of its own; the argument that run 121 covers its build inputs is in §I.2 | Actions index |
| Physical iPhone Safari | **BLOCKED** | no device (§J.6) | — |

**The skips are counted AND enumerated.** 3 per Chromium sweep, 1 in the WebKit run. The
WebKit skip is `PERF-LOAD-01`'s CDP gap (WebKit exposes no CDP for heap/node count), so the
26 expected less that one equals the 25 that ran. The three Chromium skips — now read off
the JSON reporter's annotations, not guessed — are all the declared 200 ms
`skipIfOverBudget` policy:

| Skipped test (Chromium) | Measured, and the annotation |
| --- | --- |
| `PERF-01` (4075-entry history) | first content **281.3 ms** against the 200 ms budget |
| `PERF-08` (12 MB snapshot) | load **749.8 ms** against the 200 ms budget |
| `PERF-LOAD-01` | first content **756 ms** against the 200 ms budget |

`skipIfOverBudget` printed the measurement and skipped the timing assertion; the
surrounding assertions ran and passed. No over-budget measurement was converted to a green
anywhere in this report.

**Not claimed:** `pnpm format:check` was not part of the release sweep, and no verdict is
recorded for it here rather than an unearned PASS.

### H.2 Secondary suites

These are covered by the three full sweeps and the full vitest run above — the Chromium
suite's clean sweeps ran 216 expected tests and the vitest run 202 files — so they passed
**inside** those totals. The two re-runs (A/B) each reported 215 expected / 1 unexpected, and
the single red in each was the *Latest* flake, never one of these suites. Recorded for traceability, with no separate figure invented for any of them:

| Suite | Verdict | Covered by |
| --- | --- | --- |
| `perf-cost` (`PERF-COST-*`) | **PASS** | Chromium sweep (216 expected) |
| Tool-activity hierarchy, 5 cases incl. the merged-card case | **PASS** | Chromium sweep |
| Premium geometry + contrast, 4 cases / 28 captures | **PASS** | Chromium sweep; captures committed under `docs/audits/assets/round58/` |
| Pre-existing visual suites (`round54-mobile-redesign`, `round50-measure`, `files-center`, `sync-states-visual`, `screens`) | **PASS** | Chromium sweep |
| `tests/web/touch-targets.test.ts`, `a11y-modals.test.tsx`, `mobile-reading-ux.test.tsx` | **PASS** | full vitest run (200 files) |
| Server auth / path-policy / relay-auth suites | **PASS** | full vitest run |
| Screen-reader walk on a physical device | **BLOCKED** | no device (§J.6) |

### H.3 Assertions: adapted vs weakened

Everything below was **adapted** because it encoded the pre-windowing contract. Each
adaptation is legitimate and the reason is stated; the strengthening is named where it
applies. **Nothing was weakened to turn a measurement green.**

| Test | Change | Verdict |
| --- | --- | --- |
| `tests/e2e/perf-cost.spec.ts` `waitForRows` | counted `.messages-content > *` ≥ 4,075 → reads `aria-setsize` | **Adaptation.** The old wait literally required the full mount this change removes; it still fails if the snapshot never arrives. |
| `tests/e2e/perf-cost.spec.ts:205-215` | `rows > LARGE/2` → `elements < 20_000` **and** `rows > 0` **and** `declaredEntries === LARGE` **and** `firstRowHeight > 20` | **Adaptation, strengthened.** Replaces an assumption the owner overruled with the new contract; `rows` now counts `.transcript-entry`, not spacers (the review's W22). |
| `tests/e2e/round50-measure.spec.ts` | `mounted > 100` → bounded mount `< 100`, `mountedEntries×10 < ROWS`, `aria-setsize` equals the full total, spacers cover the unmounted span to the scroller's measured height, mounted run contiguous, and top/middle/end reachable **and painted** | **Adaptation, substantially strengthened.** Not a `>`→`<` flip: the reachability half is kept and now checks painted pixels. |
| `tests/web/round57-performance.test.tsx:78` | `describe` renamed; `render` unchanged (no `scrollElement`), keeping the unwindowed contract it proves | **Adaptation.** |
| `tests/web/tool-activity-fidelity.test.tsx:389` | `.tv-note--err` → `.tv-diag-note--err` | **Adaptation**, matching a real class rename whose CSS moved alongside; the guest renderer still emits `.tv-note` and `tool-render.css` still styles it (verified by search). |
| `tests/e2e/auth.spec.ts` cookie assertion | `secure === (name === COOKIE_NAME)` → expects the named cookie **and** the `Secure` flag from the run's configured mode, both halves | **Adaptation, strengthened** (it previously derived the rule from the fact under test — the review's W11). |
| `tests/e2e/perf-scroll.spec.ts:203` | `expect(top).toBeGreaterThanOrEqual(0)` → `toBeGreaterThan(0)` with the reason stated | **Adaptation, strengthened** (the old form was near-vacuous — W14). |
| `tests/e2e/perf-scroll-harness.ts` row wait | `waitForRow` renamed to `revealRow` (documented as reachability-only, walks and may relocate) and a new `assertRowInView` added for position claims without scrolling | **Adaptation, split by claim** (W12). Scenarios that assert *position* use `assertRowInView`; scenarios that assert *reachability* use `revealRow`. |
| `playwright.config.ts:117` | adds `CAW_INSECURE_COOKIES=1` only when WebKit is in the run | **Legitimate and conditional**; the server refuses the flag unless the bind host is loopback (`config.ts:151`). |
| `tests/e2e/perf-a11y.spec.ts` (new) | asserts role+setsize+posinset **on the real box**, and prints the AX-tree channel's own limitation with a native `<li>` control | **Adaptation after measurement**, not a weakening: the document attribute is asserted directly, and the CDP omission is proven to affect native list items too. See §J.8. |
| `tests/e2e/mobile-performance.spec.ts` `PERF-01` | reachability indexed `.message-card` by **document position** → resolves the row and uses the reveal path | **Probe corrected, not the app** (§D.2.3). The old index only meant "that row" while everything was mounted; with ~37 cards it read `undefined` and reported all three positions false on a correct page. Verdict after correction: `{top:true, middle:true, end:true}`, revealMs 146.8 / 2148.4 / 4143.2. |
| `tests/e2e/mobile-performance.spec.ts` `PERF-05` | pixel fraction (`scrollTop = scrollHeight×step/15`) vs a **row** fraction → asserts a contiguous run of real rows paints at each offset | **Probe corrected, not the app** (§D.2.3). Proportional pixel↔row arithmetic is unsound with variable heights (§J.4); it reported 11–14/15 steps "missed" while frame times were inside budget. After: `rowsNotFound 0`, p50 20.0 ms, p95 21.8 ms. |
| `tests/e2e/history-loading.spec.ts` `HIST-14` | `transcriptTexts(page).length === 300` (a **mounted-card count**) → `aria-setsize === 300` plus readability of an early row | **Probe corrected, not the app.** "300 mounted" is the wrong invariant under a window. Carries the finding that `scrollTop = 0` no longer reads the top — the tail pin correctly overrules it (still showed rows 267–299), so probes must use the reveal path. |

**No over-budget measurement was converted to SKIP except the pre-existing 200 ms
first-load budget policy**, which prints its number and names it in the skip reason
(`skipIfOverBudget`, `perf-scroll-gates.spec.ts:63`, three call sites: the diff→transcript
round trip, the longest task during a Markdown stream, and the 12 MB snapshot's first
content). That policy predates this round and is declared in the spec header.

### H.4 OMP compatibility

| Area | Verdict | Evidence |
| --- | --- | --- |
| No server/adapter/runtime/relay change | **PASS** (by diff) | `git status --porcelain -- apps/server packages/` → empty |
| Catalog parse (`/api/models`) sees the migrated id | **PASS** | adapter parser: target present, base present, bogus id absent |
| Model selectability end-to-end at inference time | **UNVERIFIED** | the catalog parses it and the deploy carries the config, but no live launch was made (it would spend provider credits and risk the owner's sessions), so nothing here claims a real inference happened. `…-1017` answering with tool calls is the same gap (§G.5, stated as an inference) |
| Live sessions unaffected | **PASS** | tmux snapshot sha256 identical before/after (§G.4) |

---

## I. Deployment

### I.0 Operational hazard: a dev build is an instant production deploy

`apps/server/src/app.ts:286` serves `apps/web/dist` **from disk, with no release step**:

```ts
: resolve(repoRoot, "apps/web/dist");
```

There is no staging directory, no symlink swap, no versioned release. So
`pnpm --filter @caw/web build` is not a local build — it **publishes straight to the
owner's live origin** the moment it finishes writing `dist`. It happened **three** times
this round. An **unverified** build carrying React #185 (§D.2.1) was live at **05:27:41**
and had to be rolled back twice, each rollback hash-verified three ways (file, loopback,
public origin). The third was not a rollback candidate: it is the approval-overlay fix
(§I.4), it was verified after the fact (§I.3), and it stayed.

| time | event | served JS |
| --- | --- | --- |
| pre-flight | `dist` as it stood when the round began | `index-Cd03oBfZ.js` |
| 05:23 | restore of the known-good release | `index-C2QexEsC.js` |
| 05:27:41 | an **unverified** `pnpm build` of the changed tree published itself | `index-BKiHgkkz.js` |
| 05:29:03 | restore of the known-good release again | `index-C2QexEsC.js` |
| 2026-11-07 09:43:49 +07 | the **third involuntary deploy**: a worker ran `pnpm --filter @caw/web build` while fixing the approval overlay (§I.4), and the origin began serving the result with no release step and no restart | `index-5jbQdjjW.js` → `index-hVfEUPqx.js` |

The third occurrence is the one that matters for how the fix should be judged: it was not
an accident of carelessness so much as the shadow of a correct command. The worker needed a
bundle to run the gates against, ran the package's ordinary build script, and the serving
path *is* the build path — so "compile the client" and "ship the client" are the same
keystroke on this machine.

**Mitigation actually used this round, stated with its limit.** Every gate run was pointed
at a scratch output directory through `CAW_WEB_DIST_DIR`, so gates never needed the real
`dist` and never touched it. That worked — the gates ran against scratch builds — but it did
**not** stop a plain `pnpm --filter @caw/web build`, which still writes `apps/web/dist`
directly. It is a discipline that removes the *need* to publish, not the *ability*.

**`dist` mtime is not a trustworthy signal.** A build that fails partway can leave newer
mtimes on stale content, and a copy that preserves mtimes can look old while serving new
bytes. **Hash, don't stat** — `sha256sum apps/web/dist/assets/*.js` compared against the
artifact the served HTML actually references, on all three surfaces.

**Recommended fix, NOT IMPLEMENTED this round, out of scope:** build into a staging
directory (`dist-next`), verify the artifact, swap atomically, keep `dist-prev` for
rollback, and have the server resolve a **release directory** instead of a fixed path.
That turns a deploy into a rename and a rollback into the reverse rename, and it makes
"unverified build goes live" structurally impossible rather than a discipline problem.
Recorded here because the next round should do it before anyone rebuilds `apps/web` on
this machine again.

### I.1 Deployment record

**Observed after release.** The values below were read from the live system by the
director's release sweep and reported to me; they are not inferred from this report. Rows
marked with §I.3 were re-read on 2026-11-07 after the involuntary rebuild (§I.0, third row)
and now describe the `d29ffe6` bundle the origin actually serves.

| Field | Value |
| --- | --- |
| Final commit SHA | `d29ffe6aabd84b6fbca6b716bde0fa05a30b0b0a` (`fix(web): never float the jump-to-latest control over an approval`). The release itself was `8d3d2cc891c73237c0b787bb2338235c9a7c1333`; `d29ffe6` is what the origin now serves (§I.3) |
| Release commits | `b1ef86c` perf(web): window the transcript; `ab2a7bb` feat(web): group tool activity by evidence + premium chrome; `8d3d2cc` docs |
| Push to `origin/main` | **`b0114e3..8d3d2cc`, exit 0**; working tree clean; 75 files committed (28 round-58 PNGs, largest 193,325 B); sensitive-value scan empty |
| CI run and result | **Run 121 on `99fae06` = `success`** — its build inputs are identical to the deployed `d29ffe6` (the only delta is this report), so it is the run that covers the shipped code. **Run 120 on the deployed SHA itself is `cancelled`**, superseded 20 s in by that doc push; no verdict exists for the exact deployed SHA (§I.2). 117 `f788ab8` and 116 `d0e1bd5` are `success`; 114/115/118 are `cancelled` under `concurrency: ci-<ref>` + `cancel-in-progress: true` — **not** code evidence. Conclusions read from the Actions index without `gh`; **per-step logs UNVERIFIED** |
| Deployed SHA | **`d29ffe6`**, proven by rebuilding HEAD in a detached worktree (`git worktree add /tmp/caw-verify HEAD`, `npx vite build --outDir /tmp/caw-verify-dist`) and hashing the output — see §I.3. This supersedes the earlier entry that read `8d3d2cc` |
| Deployed revision | **`d29ffe6aabd84b6fbca6b716bde0fa05a30b0b0a` — VERIFIED.** The scratch build of HEAD reproduced all three served deliverables byte-for-byte (§I.3), so the live origin is serving a committed SHA's output, not an unrecorded tree |
| `apps/web/dist` JS | `assets/index-hVfEUPqx.js`, sha256 `02660079191e8615ea455b8e67b096023507c888b4539569f5b06fd5778a035b`, **486,141 B** (gzip **143,295 B**) |
| `apps/web/dist` CSS | `assets/index-e2muy0ow.css`, sha256 `ca7c06d554a6731ae852924c2aa8aba9060fb6fdd909839509eab27d131fccc5`, **58,345 B** (gzip **10,648 B**) |
| `apps/web/dist/index.html` | sha256 `79abb38cb2344d68be299c3d923cbd1d205cb7b1b14b079fb1dddc3083a4806c`, 973 B |
| Dist ↔ loopback ↔ public | **identical on all three files — 9 of 9 checks**, by sha256, not by mtime (§I.3) |
| `coding-agent-web.service` | enabled, `active`, **MainPID 92072 unchanged**, started 2026-11-06 15:39:16 +07, **never restarted this round** |
| HTTPS | **`HTTP/2 200`**; `referrer-policy: no-referrer`; `x-content-type-options: nosniff`; CSP carries `connect-src … wss://…`; `frame-ancestors 'none'` |
| WebSocket | **`HTTP/1.1 101 Switching Protocols`** through the public origin (`/r/<id>?role=guest`); **101** also on `127.0.0.1:8792` (relay) and `:8791` (host); over HTTP/2 the same request answers **404**, which is the expected behaviour, not a failure |
| OMP panes, before → after | `1204278`, `2080435`, `2082046` — **all `pane_dead=0`**, start times identical (Nov 5 03:07:26 / 11:48:26 / 11:51:15); tmux server `1204277` alive. **No process signalled, attached, or restarted.** |
| Was the service restarted? | **No** |
| What was not restarted, and why | The backend. `apps/server` and `packages/*` have **zero changes**, and the server reads `apps/web/dist` from disk (`apps/server/src/app.ts:286`), so new web assets went live with no restart — which is exactly why the pane pids are unchanged and no session was at risk |
| Authenticated populated-conversation walk in the deployed app | **BLOCKED** — no owner session cookie was available to the sweep |
| Commits after the release build, and what they did to `dist` | `a1cd120` (CI lane: `playwright.config.ts` + `.github/workflows/ci.yml`), then doc-only `d0e1bd5`, `f788ab8`, `9e36a35` — **artifact unchanged**. Then `b6ace88` (`apps/web/src/components/ConversationView.tsx`: dead composer ref) and `d29ffe6` (`ConversationView.tsx`, `styles.css`, `overlay-collision.spec.ts`) — **artifact changed**, and a plain `pnpm --filter @caw/web build` published the result (§I.0, third row). The current `dist` is that build, and it matches a scratch rebuild of `d29ffe6` exactly (§I.3) |
| `pnpm --filter @caw/web build` after the release | run once, by a worker fixing the approval overlay; `apps/web/dist` mtime moved to **2026-11-07 09:43:49 +07** and the origin served the new hashes immediately. Not a release step: no staging, no verification before serving (§I.0) |

**Independent re-read.** The three files were re-hashed from `apps/web/dist` on
2026-11-07 after the overlay build: `486,141 B` JS, `58,345 B` CSS, `973 B` HTML, and
`gzip -c` on them yields **143,295 B** and **10,648 B**. All three sha256 values equal the
scratch rebuild of `d29ffe6` (§I.3), not merely a re-read of the same directory.

**The one thing the owner must do himself.** Everything above is machine-verified except
the experience of a logged-in conversation. One line: open the origin, open a long
conversation, scroll to the top and back to the bottom. The newest row must be on screen
and the transcript must not go blank on the way up. That is the symptom this round
existed for, and it is the only claim nobody has checked in the deployed app.

### I.2 The shipped code now has a CI verdict, one commit removed

The deployed revision is `d29ffe6` (§I.3 proves it). CI ran on it and was **`cancelled`** —
run 120, superseded 20 s after start by the doc-only push that carried this section. But the
next run tested the very next commit, **121 on `99fae06` = `success`**, and `99fae06`'s only
delta from `d29ffe6` is *this report*. So CI's green run 121 executed the shipped
`ConversationView.tsx` and `styles.css`:

| run | SHA | status | conclusion | note |
| --- | --- | --- | --- | --- |
| 121 | `99fae06` (docs: reconcile the deployed bundle…) | `completed` | **`success`** | tests the shipped tree plus one doc file |
| 120 | `d29ffe6` (**the deployed commit**) | `completed` | `cancelled` | superseded 20 s in by the doc push; not a code verdict |
| 119 | `b6ace88` | `completed` | **`success`** | |
| 118 | `9e36a35` | `completed` | `cancelled` | superseded by 119 |
| 117 | `f788ab8` | `completed` | **`success`** | |
| 116 | `d0e1bd5` | `completed` | **`success`** | last run before the overlay fix |

**How to read this honestly.** "Run 121 green" is not "run 120 green": no CI verdict exists
for the exact SHA served, and `cancelled` is not a pass. What exists is a green run on a tree
whose build inputs are byte-identical to the served commit's — the difference is one
Markdown file, shown by `git diff-tree --name-only -r 99fae06`. That is a strong argument,
and it is an argument, not a verdict; stated as such.

The `cancelled` churn is the workflow's own `concurrency: ci-<ref>` + `cancel-in-progress:
true`, which cancels an in-flight run when a newer push arrives. Every doc-only commit on
`main` therefore invalidates the run for the code commit beneath it. That is why this table
is the shape it is, and it is worth noticing that a doc push "cancel" is not evidence about
code (the same reading as runs 114/115/118).

The origin does serve the `dist` bytes, which is a separate and verified claim: §I.3's
three-way hash table is 9/9.

### I.3 Provenance of the deployed bundle: rebuilt from HEAD, byte-for-byte

The bundle changed under everyone after the release report was written (§I.0, third row),
so "which commit is live?" had to be answered by rebuilding rather than by trusting the
directory's mtime (§J.18). Method, on 2026-11-07:

1. `git log --oneline -4` → `d29ffe6`, `b6ace88`, `9e36a35`, `f788ab8`.
2. `git rev-parse HEAD origin/main` → both `d29ffe6aabd84b6fbca6b716bde0fa05a30b0b0a`.
3. `git status --porcelain` → **empty**: the tree is clean, so no uncommitted edit could
   have contributed to the bundle.
4. `git worktree add /tmp/caw-verify HEAD` → detached at `d29ffe6`; `pnpm install
   --prefer-offline --frozen-lockfile` → done in 856 ms, lockfile frozen (no dependency
   drift).
5. `cd apps/web && npx vite build --outDir /tmp/caw-verify-dist` → `vite v6.4.5`, 101
   modules, built in 1.17 s.
6. `sha256sum` on both directories, compared.

| file | scratch build of `d29ffe6` | `apps/web/dist` | match |
| --- | --- | --- | --- |
| `assets/index-hVfEUPqx.js` | `02660079191e8615ea455b8e67b096023507c888b4539569f5b06fd5778a035b` | same | ✅ |
| `assets/index-e2muy0ow.css` | `ca7c06d554a6731ae852924c2aa8aba9060fb6fdd909839509eab27d131fccc5` | same | ✅ |
| `index.html` | `79abb38cb2344d68be299c3d923cbd1d205cb7b1b14b079fb1dddc3083a4806c` | same | ✅ |

That is outcome **(a)**: the deployed bundle is provably `d29ffe6`'s output. The content
hashes in the filenames match too, which is the independent confirmation — Vite derives
them from the bytes.

Then the three surfaces, each hashed by `curl | sha256sum` (`/` for the document, `/assets/<name>`
for the two assets):

| surface | `index-hVfEUPqx.js` | `index-e2muy0ow.css` | `index.html` |
| --- | --- | --- | --- |
| `apps/web/dist` (disk) | `0266007…035b` | `ca7c06d…ccc5` | `79abb38…806c` |
| loopback `http://127.0.0.1:8791` | `0266007…035b` | `ca7c06d…ccc5` | `79abb38…806c` |
| public `https://heheboiz-legion-5-15arh7.tail8d8eff.ts.net` | `0266007…035b` | `ca7c06d…ccc5` | `79abb38…806c` |
| **match** | **9 / 9 identical** | | |

The public document references exactly `assets/index-e2muy0ow.css` and
`assets/index-hVfEUPqx.js` (`curl -s <origin>/ | grep -o 'assets/[a-zA-Z0-9._-]*'`, two
hits, no stale third). So no surface serves a file the others do not, and no HTML points at
an artifact that is absent.

Cleanup: `git worktree remove --force /tmp/caw-verify` and `rm -rf /tmp/caw-verify-dist` —
both done; `git worktree list` shows three pre-existing unrelated worktrees under
`~/.cache/` and no `/tmp/caw-verify`.

**What this does and does not prove.** It proves the bytes on the origin are the bytes HEAD
compiles to, so the live origin is serving a committed revision. It does **not** prove that
revision is correct — that is the gates' job, and for `d29ffe6` CI has not finished
(§I.2). Nor does it make the involuntary deploy acceptable: reproducibility is why this
incident was recoverable, not a reason to keep doing it (§I.0).

**Nothing else moved.** `systemctl --user show` → `MainPID=92072`, `ActiveState=active`,
`SubState=running`, `ActiveEnterTimestamp=Fri 2026-11-06 15:39:16 +07`, `NRestarts=0` —
the same pid as §A.2, so the server was never restarted and picked up three new bundles
purely by reading the directory. The three OMP panes are alive and unchanged:
`1204278` (`$0`, started Nov 5 03:07:26), `2080435` (`$1`, Nov 5 11:48:26), `2082046`
(`$2`, Nov 5 11:51:15), all `pane_dead=0`. `curl -sI <origin>/` → **`HTTP/2 200`** with
`referrer-policy: no-referrer` present (rule 3 of `AGENTS.md`), plus the unchanged CSP and
`x-content-type-options: nosniff`.

### I.4 The approval-overlay defect, found by review after this report was written

The release report was already committed when a review of the deployed pixels found a
real defect, so it is recorded here rather than left to a footnote. It was **shipped in the
`8d3d2cc` bundle** — the one §I.1 previously certified — and fixed in `d29ffe6`.

**The defect.** At 320×568 the floating `↓ Latest` control (`.latest-row`, `bottom:
calc(var(--safe-bottom) + 84px)`, `z-index: 15`) is painted on top of the transcript band
where the active approval card's second option sits. In that geometry the row occupies
roughly y 440–484, x 230–308, and the card's second option falls under it. Hit-testing with
`elementFromPoint` at **6 sampled points inside the visible options returned
`button.latest-button` at 2 of them** instead of the `Approve for Session` button. The
consequence is not cosmetic: the owner's tap on "approve" was routed to a scroll control, so
the approval could be approved only by a route the tap did not intend — exactly the kind of
failure rule 6 ("unknown is acceptable, a guess is not") exists to prevent, applied to input
rather than to state.

**The fix.** One predicate: `activeUiRequest === null` added to the `.latest-row` render
gate at `apps/web/src/components/ConversationView.tsx:3694`. The row now cannot render while
a host approval is pending, so the affordance and the card are mutually exclusive by
construction rather than by geometry — it does not matter how tall the card is, what
viewport the phone has, or whether the safe-area insets shift. The transcript is still
reachable: the card is the last row, and nothing becomes unreachable when the jump control is
absent. The comment in `apps/web/src/styles.css:1167-1173` that claimed the button could
never cover an approval was **wrong** and was corrected to state the gate and cite the spec.

**The permanent gate.** `tests/e2e/overlay-collision.spec.ts`: **6 tests** across
**320×568, 375×667, 390×844, 430×932**, each placing a **3×2 `elementFromPoint` grid inside
every visible approval option** (3 points × 2 rows per option, every point must land on the
option) plus a scan for any element at `z-index >= 10` whose box overlaps an option's box,
plus the negative test that the control still works when no approval is pending and the
named 320 px regression case. It is a geometry gate, not a "the component rendered" gate:
the pre-fix build fails it at **all four widths** — 320/375 on the hit-test assertions,
390/430 on `latest-row` being present while an approval was pending (the card is tall enough
there to scroll under the band) — and the fixed build passes **6/6**. Failing-before and
passing-after is the evidence that the gate tests the defect and not itself.

**Why this belongs in the deployment section.** The defect and its fix are both *inside the
shipped artifact*, and neither was observed by CI or by the release sweep: the sweep's
viewport set did not hit 320 px with an approval pending. It was found by reading the
pixels of the live origin. That is the honest coverage statement for this round.

---

## J. Remaining limitations, ranked

1. **WebKit `SCROLL-01`'s intermittent single blank sample (283 ms) has no final-build
   figure — only a final-build verdict.** The sample reported `mounted: 24`, `visible: 6`,
   `posRange: [4070, 4075]` and `scrollTop: 196,847`: mounted entries four thousand ranks
   from the offset printed beside them, which is exactly the stale-window state §B.7's
   self-heal exists to correct. The WebKit run after those fixes reported **0 unexpected,
   1 skipped, 0 flaky**. But `SCROLL-01` does not assert on blank duration — it *measures*
   it — so "the suite passed" does **not** mean "no blank sample was recorded", and I have
   no post-fix blank count to quote. Two things are therefore still open: the blank-duration
   figure on the final build, and whether a real thumb on a real iPhone ever sees it (no
   device, §J.6). The instrument's own 11 % sampling rate (§B.6) bounds continuity loosely
   in both directions anyway.

2. **First content is 302–320 ms against an unchanged 200 ms budget — over budget, and
   reported as over budget.** The release sweep measured it on the deployed build, and the
   gate takes the pre-existing `skipIfOverBudget` branch (`mobile-performance.spec.ts:101`),
   which prints the number in the skip reason. It is **not green**. An earlier workstream
   run of the same gate printed **750 ms**; both numbers are in §D.5 and I could not
   isolate why they differ, so neither is presented as the other's correction. What the
   window did fix is the DOM: **214** elements at first content instead of 28,578.

3. **What the window did not fix about load.** It bounds what is committed; it does not
   remove the cost of parsing the snapshot and replaying it through the reducer before
   anything paints. That residual is the whole of the remaining over-budget figure, and it
   is the next round's problem, not a regression from this one.

4. **3,774 of 4,075 rows are unmeasured height estimates at initial load — by design.**
   Only the rows that have been mounted have a real height; the rest carry the estimate
   model, which is why far jumps depend on it, and why **proportional pixel↔row arithmetic
   is unsound in a probe**. That is exactly what made `PERF-05` and `HIST-14` fail on a
   correct app (§D.2.3): `scrollHeight × step/15` is not row `step×4075/15`. Any future
   probe must assert a property (a contiguous run of real rows paints; `aria-setsize`
   declares the total) rather than compute a rank from a pixel offset.

5. **WebKit was re-run, and the gap that mattered is closed — but only in the suites that
   were run.** The release sweep ran the WebKit perf + a11y + scroll suites: **26 expected,
   0 unexpected, 1 skipped, 0 flaky, 190 s**, with `SCROLL-03` at **8/8** and `PERF-06` at
   **0 px drift** (§H.1). The full WebKit E2E suite (every spec, as Chromium got twice) was
   **not** run, so WebKit coverage outside those three suites rests on the previous
   round's runs. The frame-gap millisecond figures in §B.2/D.3 remain pre-fix figures.

6. **Physical iPhone Safari is untested — BLOCKED.** No device. Playwright's WebKit is
   the same engine family and reproduces the defect (and its fix), but it cannot prove
   compositor behaviour under a real thumb, real safe-area insets, iOS tab eviction, or
   the virtual keyboard. The deployed app was also not walked while authenticated
   (**BLOCKED** — no owner session cookie; §I.1 gives the owner the one-line check).

7. **Search shows the first 50 matches and steps with Enter.** The count is honest
   ("`N` more matches — keep stepping with Enter"), and stepping wraps, but a 10,000-hit
   query was not measured on a device, and there is no scroll-through result list.

8. **`aria-setsize` / `aria-posinset` are unproven in a real screen reader.** Chromium's
   `Accessibility.getFullAXTree` **does not emit** those properties for *any* listitem —
   proven by injecting a native `<ul><li>` control into the same page: it exposed only
   `level` too. So the omission is the inspection channel, not the markup. The markup was
   moved from the `display: contents` wrapper to the **real box** anyway (the role did
   survive on the wrapper; the properties did not), the DOM attributes are asserted
   directly, and `getByRole("listitem")` sees the items on both engines. What remains
   unverified is what VoiceOver/NVDA actually announce. **BLOCKED** on a real AT run.

9. **The tail settle interval after a chunked snapshot is not budgeted.** The tail bug
   itself is fixed and gated: `PERF-SCROLL-09` loads a 2,000-entry snapshot in 40 chunks
   with the tall-row shape that reproduces, and asserts (with no user scroll) that the
   newest entry is painted, the window includes it, the view is within 120 px of the
   bottom and no "↓ Latest" is offered. It **passes on the fixed build and fails on the
   pre-fix build**. But the gate asks "did it open at the newest message", not "how
   fast", and the brief moment before the measurement settles is unbudgeted.

10. **The composer fix's proven scope is Playwright-paced bursts.** 500/500 exact on three
   consecutive runs (was 493–497), with composition / untrusted / send-version guards.
   That proves correctness when the page receives the events; it does not prove that no
   hardware-level or heavily throttled input sequence could outrun a commit.

11. **The DSML-leak text in the transcript is genuine assistant output and belongs
   upstream.** `packages/ai/src/utils/dsml-leak.ts:111` only strips pipe-wrapped tags, so
   a bare `<parameter name="i">…` tail survives into journals (113 and 115 such blocks in
   two live journals). No filter was added: classifying a host string by its text is
   forbidden by this repository's rules and would hide legitimate content.

12. **`Latest` overlapped the second approval option at 320 px — fixed after this report
   was first written, in `d29ffe6`.** Round-54 geometry (`bottom: safe + 84px`,
   `z-index: 15`) put the floating control on top of the approval card's second option; 2
   of 6 sampled `elementFromPoint` points returned `button.latest-button`. The fix is a
   render gate (`activeUiRequest === null` at `ConversationView.tsx:3694`), not a
   re-position, and the permanent gate is `tests/e2e/overlay-collision.spec.ts` (6 tests,
   320/375/390/430; fails before, passes after). §I.4. Recorded here because the first
   version of this entry said "not fixed" and that stopped being true.

13. **`.agent-chat-carry` still paints `--text-faint` as body text at 3.85:1**
    (`agent-chat.css:137`). Recorded by the visual lane, not owned by this workstream.

14. **The round's gates are committed (W29 closed), and CI has been read — green on the
    tree that ships.**
    `perf-scroll-harness.ts`, `perf-scroll.spec.ts`, `perf-scroll-gates.spec.ts`,
    `perf-a11y.spec.ts`, `premium-visual.spec.ts`, `perf-input.spec.ts`,
    `perf-pixels.spec.ts`, `perf-profile.spec.ts`, `perf-decision.spec.ts`, `perf-trace.ts`,
    `png.ts` and `scripts/overscan-sweep.mjs` are all tracked as of `8d3d2cc` — verified
    (`git ls-files` returns 12/12), so the "green by absence" risk is gone — and
    `tests/e2e/overlay-collision.spec.ts` is tracked as of `d29ffe6`. CI has been read
    rather than assumed: **117 `f788ab8` `success`, 119 `b6ace88` `success`**, with
    114/115/118 `cancelled` by the lane's own `cancel-in-progress: true` rather than
    failing (§H.1). **Run 120 on `d29ffe6` — the commit the origin serves — is
    `in_progress` when the release sweep read it and `cancelled` once a doc push superseded
    it, so no verdict exists for the exact deployed SHA — the verdict that covers it is run
    **121 on `99fae06` = `success`**, one doc-only commit above it (§I.2). Locally the same suites pass: 216 expected / 0
    unexpected twice on Chromium; the overlay gate 6/6 after the fix and failing at all four
    widths before it. What stays open is the **step-level** detail of every run — no `gh`,
    and the unauthenticated API exposes conclusions only — so "the run succeeded" is
    evidence and "this specific step ran" is not.

15. **Adversarial-review status, stated honestly.** 30 findings: **0 blocker, 8 major, 20
    minor, 2 info**. The eight majors were all addressed in the working tree:
    W1 (flex `gap` outside the model) → first `fitSpacersToGap`, then (after the crash
    fix) the gap folded into `buildOffsets` itself (`transcript-window.ts:171`); the
    function was deleted, and the "exact to the pixel" claim now includes the gap; W2/W20 (composer wrote IME half-composition and could
    resurrect a sent draft) → three authorship guards in `adoptElementValue`; W3
    (uncapped estimate propagation could pass the engine's maximum scroll height) → 8×
    cap + total scaling; W4 (sub-pixel correction left a stale anchor baseline) → the
    correction is written and re-based unconditionally; W5 (`revealRef` never cleared) →
    `clearReveal()` on close and on live/saved switch; W6 (saved mode searched the live
    array) → `searchableRows`; W7 (a summary-proven failure showed no failing text) →
    `Runner reported: …` preview; W8 (`.message-content` leaked into AgentChat/History
    views) → three explicitly scoped surfaces.
    Minors: W11 strengthened, W12 split into two helpers, W14 strengthened, W15 measured
    and structurally fixed (§J.8), W16 fixed with a `focusin` listener, W17 now uses the
    tested `buildOffsets(gapPx)`/`spacerHeights`, W18 fixed (150 ms debounce + per-identity
    line index, was 77 ms/keystroke on a 96 MB / 8,000-message transcript), W19 fixed
    (`htmlFor` + actions outside the `<label>`), W22 fixed, W25 fixed (viewport shrink is
    an excuse for the tail lock, like document growth), W26 fixed (a `0` height is not a
    measurement), W27 reworded, W13 is the declared pre-existing budget policy, W21 is
    tested-unreachable, W30 partial (the `.tool-output-preview` base rule's home).
    **W29 is closed**: the gates are committed as of `8d3d2cc` (verified, 12/12 tracked), and
    CI runs 117 and 119 completed successfully on the commits after it; only their step
    detail is unread (limitation 14 above).

16. **`--trace=off` is load-bearing for verdicts, and leaving it on makes the verdict
    wrong in both directions.** With `retain-on-failure`, the trace writer races the
    artifact directory: **6 of 8 WebKit runs** reported a failure whose **only** error was
    that race while every assertion passed. It hid the real `posinset 17` failures and
    manufactured phantom ones at the same time. **Partially implemented** in `a1cd120`
    (*ci: pick the browser the environment actually has, and stop the trace race*): the CI
    lane now runs `npx playwright test --project=chromium --trace=off`
    (`.github/workflows/ci.yml:78`) and resolves the browser channel from the environment
    (`CAW_E2E_CHANNEL`; CI installs the bundle, this machine has system Chrome).
    `playwright.config.ts:108` still defaults to `retain-on-failure`, so a **local** run
    that omits `--trace=off` is still racy. Remaining fix, NOT IMPLEMENTED: a per-test trace
    directory owned for the whole teardown, or a config-level default of `off` that an env
    var turns on.

17. **Two Playwright runs must never overlap — isolation has to be by TIME, not by port.**
    Both share one harness server on **port 4399**, and `pkill -f e2e-server.mjs` in one
    run kills the other's server mid-flight. Measured: **158 of 158 tests** became
    `ECONNREFUSED 127.0.0.1:4399`. Port juggling does not help (4398 and 4399 both
    collide with the launcher's own defaults), so the rule is *one invocation at a time*.
    The hard sequence, recorded so the next round cannot improvise it:
    `ss -ltnp | grep 4399` must be empty → `pkill -f e2e-server.mjs; sleep 2; rm -rf
    test-results` → run with `--workers=1 --retries=0 --trace=off` → **one `--project` per
    invocation** → build to `CAW_WEB_DIST_DIR` scratch → read verdicts from the JSON
    reporter's stats, never from a scrolled terminal.

18. **`apps/web/dist` mtime is not a deploy signal.** During the restore the contents were
    rewritten with **identical hashes**, so mtime moved while the served bytes did not —
    the same trap as §I.0, seen from the other side. **Hash, don't stat**, on all three
    surfaces.

19. **Lab, not field.** Every number here is a controlled, deterministic, CPU-throttled
    measurement of interaction cost on this machine. It is **not** field INP and is not
    labelled as such. Throttled and unthrottled runs are kept in separate tables
    throughout.

---

## Open items

Reconciled on 2026-11-07 against the live machine and the Actions index. Six entries: one
**PASS with a stated caveat** (CI covers the deployed build inputs, not the exact deployed
SHA), two **BLOCKED** (no device, no owner session cookie), one **UNVERIFIED** figure, one
**VERIFIED and closed** (bundle provenance), and one recorded gap in the release sweep's
coverage that the escaped defect proved.

| Item | Status | Why it cannot be closed here | Who closes it |
| --- | --- | --- | --- |
| **CI verdict for the deployed build** | **PASS on run 121 (`99fae06`, `success`), one doc-only commit above the deployed `d29ffe6`; the run on the deployed SHA itself (120) is `cancelled`, so no verdict exists for that exact SHA** | CI ran on `d29ffe6` (run 120) and was superseded 20 s in by the push that carried §I.2, so `cancelled` — which is not a pass. Run **121 on `99fae06` completed `success`** at 02:59:40Z; `git diff-tree --name-only -r 99fae06` shows its only delta from the deployed commit is this Markdown file, so the green run executed the shipped `ConversationView.tsx` and `styles.css`. That is an argument a reader can check, not a verdict on the exact SHA: stated as such in §I.2. Earlier runs: 119 `b6ace88` `success`, 117 `f788ab8` `success`, 116 `d0e1bd5` `success`; 114/115/118 `cancelled` by `cancel-in-progress`. Read from the Actions index (unauthenticated API, no `gh` on this machine); **step logs UNVERIFIED** | nothing for the conclusion; `gh run view 121 --log` for step detail, or a push that does not supersede the deploy commit |
| CI **step-level** detail for any run | **UNVERIFIED** | no `gh`; the API returns conclusions, not step logs, without a token | `gh run view 120 --log` once available |
| Physical iPhone Safari (compositor under a real thumb, safe-area insets, tab eviction, keyboard) | **BLOCKED** | no device on this machine. Playwright WebKit is the same engine family and the WebKit run reported **26 expected / 0 unexpected / 1 skipped / 0 flaky**, but it is not a thumb. The approval-overlay gate (§I.4) ran at four widths — a real iPhone is still a different compositor and a different thumb | owner, on the phone |
| Authenticated populated-conversation walk in the deployed app | **BLOCKED** | no owner session cookie. Everything else about the deploy is machine-verified (§I.1, §I.3) | owner: open the origin, open a long conversation with an approval pending, scroll top→bottom; newest row on screen, no blank, and every approval option tappable |
| Post-fix blank-frame **count** on the final WebKit build | **UNVERIFIED** | `SCROLL-01` measures blank duration rather than asserting on it, and the sweep reported verdicts, not the blank series; the 283 ms sample quoted throughout is a workstream-build number (§J.1) | a rerun that prints `PERF_JSON` for `SCROLL-01` |
| Was the sweep's viewport set sufficient? | **No — proven by the escaped defect** | The release sweep certified the `8d3d2cc` bundle, then a 320 px approval-pending state was found to send 2 of 6 taps to `button.latest-button` (§I.4). The gate set had no case at that combination, so the certification was true of what it measured and false of the product | closed for this defect by `overlay-collision.spec.ts`; the general lesson (approval × narrow × detached) is now gated at 320/375/390/430 |

**Closed since the first version of this section.** Bundle provenance: the deployed bundle
is now **provably `d29ffe6`'s output**, by rebuilding HEAD in a scratch worktree and
matching all three sha256 values, and by matching disk ↔ loopback ↔ public 9/9 (§I.3). The
earlier text here argued provenance from file lists; that argument is superseded by a
byte comparison and is no longer the basis for any claim.

Two items remain **measured and reported, not pending**: first content exceeds the 200 ms
budget and is published as such (§J.2, with the two runs' discrepancy stated rather than
resolved), and `pnpm format:check` was not part of the release sweep — no verdict is
recorded for it rather than an unearned PASS.

Fixes **recommended and deliberately NOT IMPLEMENTED** this round, each with its statement
in place: atomic `dist` release + `dist-prev` (§I.0) — now with a third involuntary deploy
behind it (§I.0 table) — trace-artifact isolation remaining for local runs (§J.16),
per-run harness isolation by time (§J.17).
