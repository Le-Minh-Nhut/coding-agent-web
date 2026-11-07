# Final report — black-screen scroll, windowed transcript, tool activity, model migration

Round 58. Working tree based on `b0114e3` (docs-only); the last code-bearing revision
before this round is `018e607`. Nothing in this round is committed, pushed or deployed
by the workstreams that produced it — §I.1 is the director's and is empty by design;
§I.0 is not deployment evidence but an operational hazard the round hit twice.

Every number below names the file it came from or the command that produced it. Where
a number is a *range*, the range is the spread of separate runs, not a rounded claim.
Verdict vocabulary is the brief's: PASS / FAIL / BLOCKED / UNVERIFIED. Anything not
measured is written **PENDING** and is listed again at the end of the file.

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

- Writer in the revision under test: `apps/web/src/components/MessageRow.tsx:244` —
  `{entries.map((entry) => …)}` inside `TranscriptList`, with no window. (Line 244 of
  `git show HEAD:apps/web/src/components/MessageRow.tsx`; in the current tree the same
  render site is `MessageRow.tsx:846`.)
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

**Staleness warning, and it matters.** Every WebKit number in this report was taken
before the two crash fixes in §D.2.1 and §D.2.2, and WebKit was **not re-run afterwards**
unless the release sweep did it — that row is PENDING in §H.1 (see §J.5). The mechanism
those numbers describe (the window's scroll behaviour) is untouched by both fixes, so the
diagnosis stands; the exact figures are pre-fix-build figures and are labelled as such.

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
| Window unit | **entries** (a group is one entry, a row is one entry), not rows | `transcript-window.ts` `EntryWindow` |
| Heights | **measured**, cached by identity; only never-measured entries borrow an estimate from the nearest measured neighbour | `estimateHeights` (`transcript-window.ts:92`) |
| Measurement | one `ResizeObserver`, re-armed on the mounted set, reading the `display: contents` wrapper's `firstElementChild` | `MessageRow.tsx` observer effect |
| Offsets | prefix sums in a `Float64Array`, binary search — O(log n) per scroll event | `buildOffsets:138`, `indexAtOffset:176` |
| Spacers | **exact sums of the same offsets array**, so `scrollTop = offsets[i]` lands entry `i` at the top even while distant heights are guesses | `computeWindow:205`, `spacerHeights:241`, `fitSpacersToGap:271` |
| Flex `gap` | subtracted from the spacers, because `gap` is additive between *rendered* items and belongs to no element's measured height — the adversarial review's W1 | `fitSpacersToGap:271`, `MessageRow.tsx:885` |
| Anchor | identity + offset from the viewport top + **the `scrollTop` it was taken at**; the third field is what stops the correction from fighting the user | `captureAnchor` / correction effect |
| Tail-follow | unchanged `followTailRef` / `TAIL_THRESHOLD_PX`, plus re-pinning on **known** document growth and on viewport shrink (a subagent row appearing) | `ConversationView.tsx` `updateTailLock` |
| Native scroll anchoring | **disabled** — `overflow-anchor: none` on `.messages-scroll` | `apps/web/src/styles.css:724` |
| Pinned entries | force-mounted as **separate segments**, never by widening the window; `isError` rows pinned by identity; open disclosures and the focused row derived from the live DOM | `computeSegments:400` |
| Estimate propagation | capped at **8×** the entry's own fallback (`PROPAGATION_CAP_FACTOR`), and the total is scaled under the engine's `MAX_SCROLL_HEIGHT_PX = 33,554,428` — the review's W3 | `transcript-window.ts:76,83,141` |
| Small lists | `< 60` entries render everything — a short conversation must not pay for a measurement pass | `WINDOW_MIN_ENTRIES = 60` |
| Overscan | **800 px**, chosen by sweep (§C.3) | `DEFAULT_OVERSCAN_PX = 800` |
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
(`ConversationView.tsx:1802`); the gate's own comment says 4 of 6
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
   `ConversationView.tsx:1325`.

React fires **both** `onInput` and `onChange` for a single edit, and `updateDraft`'s
`sendVersionRef++` invalidated `adoptElementValue`'s authorship guard, so the pair
alternated instead of converging. Measured on the crashing build: **783 renders of
`ConversationView`**, **170 of them inside one 400 ms window**, and **590–622
`setSendError` dispatches for a value that never changed**.

The fix is one writer:

| writer | before | after |
| --- | --- | --- |
| text input | `onInput`→`adoptElementValue`, `onChange`→`updateDraft`, `[draft]`→`setInputText` | **one**: `handleComposerChange` reads `event.currentTarget.value` |
| parent mirror | written back as state on every identity | the `[draft]` effect is a **no-op** when the parent merely mirrors our own published value; a genuine external change (restored draft, recovered refusal) still lands (`ConversationView.tsx:1337`) |
| IME / composition guards | in `adoptElementValue` | moved into the single writer |

Result: **0 page errors in 6 of 6 runs, across three separate sweeps**. The permanent gate
is **`PERF-STREAM-02`** (burst typing *and* scrolling while a turn streams ⇒ zero
`pageerror`, `tests/e2e/perf-input.spec.ts:160`); it **fails on the released bundle and
passes on the fix**. Input exactness (`PERF-INPUT-01`) never caught this — the characters
arrived correctly and the page died afterwards — which is why the new gate asserts the one
thing that would have.

#### D.2.2 Height model vs the CSS flex gap

`fitSpacersToGap` subtracted `(mounted − 1) × gap` at **render time**, so every mounted row
sat `k × gap` below its model offset for a `k` that changed with the mounted range. The
anchor correction then measured a fresh delta after every window move and re-armed
itself. Measured on the crashing build, anchor 21,600 px from the top: the correction
fired **+40, −20, +10, −10, +10, −10 px** in succession — an oscillation, not a
convergence.

Fix: the gap is charged **inside `buildOffsets`** (`transcript-window.ts:138`) — `count−1`
gaps, none after the last entry — so a window move is no longer a geometry change and the
measured `delta` is **0**. The comment that explains why the correction belongs to the
model and not to render time is at `MessageRow.tsx:359`.

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
to the DOM** (`MessageRow.tsx:382`, now `ref={entriesRef}` at `:985`), so every
gap/lead-in read that depended on it had silently never run.

### D.3 Frame gaps (the owner's symptom)

| fixture | engine | throttle | metric | before | after |
| --- | --- | --- | --- | --- | --- |
| 8,000 heavy, 8 upward flicks | Chromium | 4× | p50 / p95 / max | 88.2 / 544.6 / 793.1 ms | **16.6 / 32.5 / 34.1 ms** |
| 8,000 heavy, 8 upward flicks | WebKit | 4× | p50 / p95 / max | 135 / 597 / **2,112 ms** | **16.0 / 65 / 76 ms** *(pre-crash-fix build — §B.5, §J.5)* |
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

| metric | round 57 | round 58 |
| --- | --- | --- |
| first content | 1257.8 ms (PERF-08, different fixture) / 345 ms longest task | **750 ms** |
| DOM elements at first content | 28,578 in document | **53** (research §14 run) |
| DOM elements once settled | 54,917 (PERF-08) | **308** (latest gate run) |
| peak heap | 127.2 MB (PERF-08) / 54.3 MB baseline | **133.7–133.9 MB** |
| long tasks | 2, worst 505 ms (PERF-08) | **1**, worst **57–62 ms** |
| entries reported | 4,075 / 1,400 | 1,400 (equals the snapshot) |

Read this table carefully: **first content is still 750 ms and the 200 ms budget is
still exceeded.** The DOM is what collapsed; the parse of a 12 MB snapshot and its
reducer replay are untouched. The gate prints the number and takes the pre-existing
over-budget branch (§H.1, §J.2–§J.3).

The same is true at the 4,075-entry fixture: **`PERF-01` first content is 302–320 ms**
against the same 200 ms budget (release-sweep figures, not re-measured here; its verdict
row is PENDING in §H.1, and the limitation is §J.3). So the windowed build fixed the
*interaction* cost the gate exists for and did **not** fix initial paint at either
fixture size — reported, never rounded into a pass.

### D.6 React commits

| measurement | value |
| --- | --- |
| commits across an 8-flick train, 2,000 heavy entries, 78,617 elements, 4× throttle | **2** |
| commits in the invalid probe arm | 0 (arm discarded — wrong layout model) |

The counter is installed through `__REACT_DEVTOOLS_GLOBAL_HOOK__` before any app
script, so this is React's own report, not an inference from source. **No post-windowing
commit count was taken**; the window changes how much a commit mounts, and its cost is
reported as task time (§D.7) instead. Recorded as a gap, not as a result.

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
| blank runs, all `SCROLL-01..12` scenarios | **0 ms** in every scenario except one WebKit `SCROLL-01` sample of **283 ms** (pre-crash-fix build, §J.5) | see §J.1 |
| heap, 4 reconnect+stream cycles | listeners **2 → 2** (drift 0), rows **37** every cycle, heap **+7.8 MB** on the final run (earlier runs 6.6–13.2 MB) | Chromium, mock host |
| streaming responsiveness (12 Markdown sections into 4,075 entries) | stream wall **778 ms**, longest task **0 ms**, DOM **185** elements, 4,075 entries still reported | Chromium, unthrottled |
| bundle delta, windowing + search | **470.70 → 481.91 kB raw, 138.24 → 142.18 kB gzip = +3.94 kB gzip**, **no dependency added** | `pnpm --filter @caw/web build` |
| bundle delta, presentation layer | CSS **53.01 → 58.23 kB raw / 9.78 → 10.60 kB gzip = +5.22 / +0.82 kB**; JS byte-identical with and without the layer | same build, import commented out |

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

Verdict vocabulary is PASS / FAIL / BLOCKED / UNVERIFIED only. Counts are **PENDING**
wherever the final sweep has not reported; the director runs the gates and sends the
numbers, and **no count below is filled with a number I did not see**. Each row names the
exact command that produces its count.

### H.1 The gate table

| Gate | Verdict | Count | Command |
| --- | --- | --- | --- |
| `pnpm -r typecheck` | **PENDING** | — | `pnpm -r typecheck` |
| Full vitest (`tests/web`, `server`, `adapter`, `runtime`, `relay`, `protocol`, `guest`, `compat`, `deploy`, `scripts`, `e2e/unit`) | **PENDING** | — | `HOME=/home/heheboiz npx vitest run` (repo script `pnpm test`) |
| Chromium E2E, full suite, **serial** | **PENDING** | — | `HOME=/home/heheboiz TMPDIR=$HOME/.cache npx playwright test --project=chromium --workers=1 --reporter=line` |
| WebKit E2E: perf + a11y + scroll suites | **PENDING** | — | `… npx playwright test tests/e2e/perf-scroll-gates.spec.ts tests/e2e/perf-scroll.spec.ts tests/e2e/perf-a11y.spec.ts --project=webkit --workers=1` (WebKit 2370; `CAW_INSECURE_COOKIES=1` supplied by the config) |
| `PERF-SCROLL-01..09` | **PENDING** | — | `npx playwright test tests/e2e/perf-scroll-gates.spec.ts --project=chromium` (and `--project=webkit`) |
| `PERF-STREAM-01` / `PERF-STREAM-02` | **PENDING** | — | `-g PERF-STREAM` in `perf-scroll-gates.spec.ts` / `perf-input.spec.ts` |
| `PERF-INPUT-01/02` | **PENDING** | — | `npx playwright test tests/e2e/perf-input.spec.ts` |
| `PERF-TOOLS-01` | **PENDING** | — | `npx playwright test tests/e2e/perf-scroll-gates.spec.ts -g PERF-TOOLS` |
| `PERF-LOAD-01` | **PENDING** | — | same, `-g PERF-LOAD` (Chromium only; WebKit skips on a stated CDP capability gap) |
| `PERF-MEMORY-01` | **PENDING** | — | same, `-g PERF-MEMORY` |
| `PERF-SEARCH-01` | **PENDING** | — | same, `-g PERF-SEARCH` |
| `PERF-A11Y-01` | **PENDING** | — | `npx playwright test tests/e2e/perf-a11y.spec.ts` (both projects) |
| `SCROLL-01..12`, Chromium **and** WebKit | **PENDING** | — | `npx playwright test tests/e2e/perf-scroll.spec.ts` per project |
| `auth.spec.ts`, both cookie modes | **PENDING** | — | `HOME=/home/heheboiz npx playwright test tests/e2e/auth.spec.ts --project=chromium` (production cookies) and `--project=webkit` (loopback dev cookies). Last observed per-workstream: **4 passed in each mode**; the assertion now derives the rule from the run's configuration, not from the cookie it observes (§H.3) |
| `pnpm compat` (OMP surface present) | **PENDING** | — | `node scripts/compat-check.mjs` |

`PERF-STREAM-02` is new this round (`tests/e2e/perf-input.spec.ts:160`, §D.2.1) and is the
gate that would have caught the crash the release sweep found; it **fails on the released
bundle and passes on the fix**.

### H.2 Secondary suites (counts also PENDING)

| Suite | Verdict | Command |
| --- | --- | --- |
| `perf-cost` (`PERF-COST-*`, load/stream/append at 4,075) | **PENDING** | `npx playwright test tests/e2e/perf-cost.spec.ts` |
| Tool-activity hierarchy, 5 cases incl. the merged-card case | **PENDING** | `npx playwright test tests/e2e/tool-activity-hierarchy.spec.ts` |
| Premium geometry + contrast, 4 cases / 28 captures | **PENDING** | `CAW_SCREENS_DIR=$PWD/docs/audits/assets/round58 npx playwright test tests/e2e/premium-visual.spec.ts` |
| Pre-existing visual suites (`round54-mobile-redesign`, `round50-measure`, `files-center`, `sync-states-visual`, `screens`) | **PENDING** | `npx playwright test <those five paths> --workers=1` |
| `tests/web/touch-targets.test.ts` (44 px floor, safe-area inset) | **PENDING** | `npx vitest run tests/web/touch-targets.test.ts` |
| `tests/web/a11y-modals.test.tsx` (dialog semantics, focus return) | **PENDING** | `npx vitest run tests/web/a11y-modals.test.tsx` |
| `tests/web/mobile-reading-ux.test.tsx` (notice roles, rendered text) | **PENDING** | `npx vitest run tests/web/mobile-reading-ux.test.tsx` |
| Server auth / path-policy / relay-auth suites | **PENDING** | `npx vitest run tests/server/auth.test.ts tests/server/auth-routes.test.ts tests/server/path-policy.test.ts tests/server/relay-auth.test.ts` |
| Screen-reader walk on a physical device | **BLOCKED** | no device; see §J.8 |
| Format check | **PENDING** | `pnpm format:check` |

Workstream-local snapshots seen during the round, **not** the final suite and therefore not
entered above: `tests/web` **107 files / 921 passed** after the windowing change, **929/929**
after the estimate-cap fix; `perf-scroll-gates` Chromium **1 skipped / 13 passed**, WebKit
**1 skipped / 13 passed**; `perf-scroll` Chromium **1 skipped / 24 passed**; `round50-measure`
**5 passed**; `premium-visual` **4 passed**; `perf-a11y` passing after the calibration in
§J.8.

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
| Model selectability end-to-end at inference time | **PENDING** | needs a real launch; deliberately not done to protect live sessions |
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
owner's live origin** the moment it finishes writing `dist`. It happened twice this round.
An **unverified** build carrying React #185 (§D.2.1) was live at **05:27:41** and had to
be rolled back twice, each rollback hash-verified three ways (file, loopback, public
origin).

| time | event | served JS |
| --- | --- | --- |
| pre-flight | `dist` as it stood when the round began | `index-Cd03oBfZ.js` |
| 05:23 | restore of the known-good release | `index-C2QexEsC.js` |
| 05:27:41 | an **unverified** `pnpm build` of the changed tree published itself | `index-BKiHgkkz.js` |
| 05:29:03 | restore of the known-good release again | `index-C2QexEsC.js` |

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

**Nothing in this subsection is observed yet.** The round's work is uncommitted; the
director commits, pushes, watches CI and deploys. Every field is **PENDING** and must be
filled from the live system, not from this report.

| Field | Value |
| --- | --- |
| Final commit SHA | **PENDING** |
| CI run number and result | **PENDING** |
| CI run for the last code-bearing commit | **PENDING** |
| Deployed SHA (the revision actually served) | **PENDING** |
| `apps/web/dist` JS filename + sha256 | **PENDING** |
| `apps/web/dist` CSS filename + sha256 | **PENDING** |
| `apps/web/dist/index.html` sha256 | **PENDING** |
| Loopback-served asset hashes (`http://127.0.0.1:8791`) | **PENDING** |
| Public-origin asset hashes (`https://…tail8d8eff.ts.net`) | **PENDING** |
| Dist ↔ loopback ↔ public hash equality | **PENDING** |
| `coding-agent-web.service` state + MainPID | **PENDING** (round start: `active`, pid 92072) |
| HTTPS reachable | **PENDING** |
| WebSocket upgrade reachable | **PENDING** |
| OMP pane pids **before** deploy | **PENDING** (round start: 1204278 / 2080435 / 2082046) |
| OMP pane pids **after** deploy | **PENDING** |
| Was the service restarted? | **PENDING** |
| What was **not** restarted, and why | **PENDING** (expected: no backend restart is needed for web-asset changes, because the server reads `apps/web/dist` from disk — `apps/server/src/app.ts:286`; the director must confirm this for the actual deploy) |

If a deploy restarts the service, the pane pids **will** change; the OMP sessions live in
a tmux server inside the unit's control group (`Found left-over process 1204277 (tmux:
server) …` is the journal's own note on prior restarts), so a restart is a session-safety
event, not a cosmetic one. Record it either way.

---

## J. Remaining limitations, ranked

1. **WebKit `SCROLL-01` intermittently reports one blank sample (283 ms).** Reported, not
   suppressed, and **UNVERIFIED** whether a user can see it. The sample's own diagnostics
   say `mounted: 24`, `visible: 6`, `posRange: [4070, 4075]` and `scrollTop: 196,847` —
   the mounted entries were four thousand ranks from the offset printed beside them; a
   manual `page.screenshot()` at the same point is fully painted; the recorder reads its
   diagnostics **before** the screenshot while the 120-step programmatic gesture is still
   running, so offset and pixels are not the same instant. `SCROLL-01` is the only
   scenario driven by a programmatic scroll; every real-touch-flick scenario
   (`SCROLL-02/04/08/11/12`) reports zero blanks on both engines, repeatedly. What that
   supports: the window is correct at every settled position. What it does **not**
   support: any claim that a real thumb on a real iPhone never blanks.

2. **`PERF-LOAD-01` first content is still 750 ms, over the 200 ms budget.** The DOM
   collapse took the long task from 345 ms to 57–62 ms and stopped the whole history
   from mounting, but a 12 MB snapshot still costs its parse and reducer replay before
   anything paints. The gate prints 750 ms and takes the declared over-budget branch.

3. **`PERF-01` first content is 302–320 ms, still over the same 200 ms budget.** The
   windowed build fixed the *interaction* cost that `PERF-01` was written to catch and did
   not fix the **initial paint** of a 4,075-entry history: the reducer replay happens
   before anything is on screen, and the window only bounds what is committed afterwards.
   Reported through the pre-existing `skipIfOverBudget` policy
   (`mobile-performance.spec.ts:101`), which prints the number in the skip reason — the
   gate is **not green**, it is over budget with its measurement published. Both this and
   limitation 2 are budget failures, not regressions.

4. **3,774 of 4,075 rows are unmeasured height estimates at initial load — by design.**
   Only the rows that have been mounted have a real height; the rest carry the estimate
   model, which is why far jumps depend on it, and why **proportional pixel↔row arithmetic
   is unsound in a probe**. That is exactly what made `PERF-05` and `HIST-14` fail on a
   correct app (§D.2.3): `scrollHeight × step/15` is not row `step×4075/15`. Any future
   probe must assert a property (a contiguous run of real rows paints; `aria-setsize`
   declares the total) rather than compute a rank from a pixel offset.

5. **WebKit was not re-run after the composer and gap fixes.** The WebKit numbers quoted
   throughout this report (frame gaps, `SCROLL-01..12`, the 283 ms blank sample) predate
   **both** fixes in §D.2.1 and §D.2.2, so they describe the windowed build before the
   crash fix, not the final one. Whether the release sweep re-ran WebKit is **PENDING** —
   it is a row in §H.1, and until those counts arrive no reader should treat any WebKit
   figure here as final-build evidence. What WebKit evidence does exist is not invalidated:
   it shows the scroll mechanism and its fix, which the two later fixes do not touch.

6. **Physical iPhone Safari is untested — BLOCKED.** No device. Playwright's WebKit is
   the same engine family and reproduces the defect (and its fix), but it cannot prove
   compositor behaviour under a real thumb, real safe-area insets, iOS tab eviction, or
   the virtual keyboard.

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

12. **`Latest` can overlap the second approval option at 320 px.** Pre-existing round-54
   geometry (`bottom: safe + 84px`), visible in the round-58 approval capture at 320. Not
   fixed: moving it is a transcript-control change with its own geometry contract.

13. **`.agent-chat-carry` still paints `--text-faint` as body text at 3.85:1**
    (`agent-chat.css:137`). Recorded by the visual lane, not owned by this workstream.

14. **The round's gates are untracked, so CI cannot run them until they are committed.**
    `tests/e2e/perf-scroll-harness.ts`, `perf-scroll.spec.ts`, `perf-scroll-gates.spec.ts`,
    `perf-a11y.spec.ts`, `premium-visual.spec.ts`, `perf-input.spec.ts`,
    `perf-pixels.spec.ts`, `perf-profile.spec.ts`, `perf-decision.spec.ts`,
    `perf-trace.ts`, `png.ts`, `scripts/overscan-sweep.mjs` are all `git status: ??`.
    (`adversarial-review-round58.md` W29.) A green CI on a commit that does not include
    them is green by absence.

15. **Adversarial-review status, stated honestly.** 30 findings: **0 blocker, 8 major, 20
    minor, 2 info**. The eight majors were all addressed in the working tree:
    W1 (flex `gap` outside the model) → `fitSpacersToGap`, and the "exact to the pixel"
    claim now includes it; W2/W20 (composer wrote IME half-composition and could
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
    tested `fitSpacersToGap`/`spacerHeights`, W18 fixed (150 ms debounce + per-identity
    line index, was 77 ms/keystroke on a 96 MB / 8,000-message transcript), W19 fixed
    (`htmlFor` + actions outside the `<label>`), W22 fixed, W25 fixed (viewport shrink is
    an excuse for the tail lock, like document growth), W26 fixed (a `0` height is not a
    measurement), W27 reworded, W13 is the declared pre-existing budget policy, W21 is
    tested-unreachable, W30 partial (the `.tool-output-preview` base rule's home).
    **W29 is open** and is limitation 14 above.

16. **Lab, not field.** Every number here is a controlled, deterministic, CPU-throttled
    measurement of interaction cost on this machine. It is **not** field INP and is not
    labelled as such. Throttled and unthrottled runs are kept in separate tables
    throughout.

---

## PENDING fields awaiting the director

**Section H (§H.1 gate table, in this order):**
1. `pnpm -r typecheck` — clean or errors.
2. Full `vitest run` — files / tests / failures.
3. Chromium E2E full suite, serial — passed / skipped / flaky, any failure.
4. WebKit E2E — perf + a11y + scroll — passed / skipped, any failure. **This is also what
   closes §J.5**: whether WebKit was re-run after the composer and gap fixes.
5. `PERF-SCROLL-01..09` — verdict + printed `PERF_JSON`, per gate, per engine.
6. `PERF-STREAM-01` / `PERF-STREAM-02` — verdict per engine (STREAM-02 must be 0
   `pageerror`).
7. `PERF-INPUT-01/02` — verdict + counts per engine.
8. `PERF-TOOLS-01` — verdict + printed numbers.
9. `PERF-LOAD-01` — verdict + first content / heap / DOM (and the printed over-budget
   value if it takes the skip branch).
10. `PERF-MEMORY-01` — verdict + heap/listener numbers.
11. `PERF-SEARCH-01` — verdict + reveal numbers.
12. `PERF-A11Y-01` — verdict on both engines, and the printed `A11Y ax` line.
13. `SCROLL-01..12` on Chromium **and** WebKit — verdict + blank/frame-gap numbers.
14. `auth.spec.ts` in production cookie mode (Chromium) **and** loopback dev-cookie mode
    (WebKit) — counts.
15. `pnpm compat` — result; and, if a launch is sanctioned, the end-to-end proof that
    `…-1017` answers with tool calls.

Secondary (§H.2), if the sweep covers them: `perf-cost`, tool-activity hierarchy,
premium geometry, the five pre-existing visual suites, the three a11y unit suites, the
server auth/path/relay suites, `format:check`.

**Section I.1 (deployment):** final SHA, CI run result, deployed SHA, the three `dist`
asset names + sha256, loopback and public hashes and their equality, service state +
MainPID, HTTPS and WebSocket reachability, OMP pane pids before and after, whether the
service was restarted, and what was not restarted and why.

**Also PENDING, and outside both tables:** the dist-churn timeline in §I.0 is recorded
from the round's own incidents (05:23 / 05:27:41 / 05:29:03, three filenames) and does not
need filling; the **recommended staging-dir fix in §I.0 is NOT IMPLEMENTED** and is
deliberately not scheduled by this report.
