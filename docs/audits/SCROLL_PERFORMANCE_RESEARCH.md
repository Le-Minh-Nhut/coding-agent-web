# Scroll performance research — the black transcript during a fast upward flick

Round 58. Written **before** the implementation, and kept honest afterwards: §1–§3
are the evidence as it stood when the decision was taken, the decision itself is §5,
and everything the implementation later disproved is corrected in place with the
measurement that corrected it rather than quietly rewritten.

Command for every number in this document:

```bash
HOME=/home/heheboiz TMPDIR=$HOME/.cache npx playwright test \
  tests/e2e/perf-scroll.spec.ts tests/e2e/perf-decision.spec.ts tests/e2e/perf-profile.spec.ts \
  --project=chromium --reporter=line --retries=0
```

---

## 1. The reported symptom, and what it is not

> "Open a long conversation on iPhone, scroll to the latest message, then scroll
> quickly upward — the message area turns black/blank for a noticeable time, then old
> content appears."

Restated precisely, because the fix depends on which one is true:

| candidate | what it would look like | how it was tested |
| --- | --- | --- |
| **A. The compositor has nothing rastered** | The DOM is correct and complete; the *screen* shows background until the raster catches up. | Frame-gap measurement plus layout/raster A/B (§3). |
| **B. The main thread is blocked** | `rAF` stops firing; scroll position stops changing; no frame of any kind. | In-page rAF gap series, `longtask` and LoAF observers. |
| **C. React re-renders the whole list per frame** | Every scroll step costs script proportional to history length. | React commit counting through `__REACT_DEVTOOLS_GLOBAL_HOOK__` and CDP metrics. |
| **D. Rows are dropped from the DOM** | Rows genuinely absent; content lost. | Row-reachability assertions across the whole history. |

**B, C and D are ruled out or bounded below; A is the surviving mechanism** — with
one important qualification the A/B in §3 supplies.

Instrument note that matters for reading every other number: the phone's engine is
WebKit, and the machine's Chromium is the only engine with CDP. Both are run; §4
records where they differ.

---

## 2. Instrument validation, before any measurement is trusted

A detector that always says "blank" measures nothing, and one that never fires is
silent on the bug. Both directions were tested with a controlled fault
(`tests/e2e/perf-pixels.spec.ts`, `PERF-PIXEL-DETECTOR`):

| check | result |
| --- | --- |
| Painted transcript, real app | **0** blank frames |
| Transcript band covered by an opaque `--bg` overlay (ground truth: no ink) | **blank run detected**, 700 ms |

### The capture path is the trap, and it was measured rather than assumed

`Page.startScreencast` and `Page.captureScreenshot` can **force a complete raster of
the surface they copy**, in which case a region the compositor never painted arrives at
the instrument *already filled in* and a pixel detector built on either is structurally
blind to this bug. Every available capture was therefore tried and timed on this machine
during a flick train:

| capture | frames produced | verdict |
| --- | --- | --- |
| `Page.startScreencast`, png, 1× and 2× DPR, ack-gated | **1 frame per 6 s** | unusable |
| `Page.startScreencast`, jpeg q40–q60 | 1 frame per 6 s | unusable |
| trace `devtools.screenshot` frames (the compositor's own) | **1 frame per 30-step flick** | too sparse for a per-frame verdict |
| **`page.screenshot` in a parallel sampling loop** | **4 frames / 0.5 s** in the validation run | **selected** |

The selected instrument is slower per sample than the screencast *should* be, but it is
the only one that produced a usable series here, and — the reason it was chosen over
any Chromium-only trick — it is available on **WebKit too**, so a Chromium number and a
WebKit number mean the same thing.

**Validated in both directions before any result was believed**
(`tests/e2e/perf-pixels.spec.ts`, `PIXEL-DETECTOR`):

| injected condition | frames | blank frames | blank run |
| --- | --- | --- | --- |
| real app, painted transcript | 4 | **0** | 0 ms |
| transcript band covered by an opaque `--bg` overlay | 4 | **4** | **494.6 ms** |

Zero false positives on the real app, and the controlled fault is detected with the
right duration. `PIXEL-COVERAGE` records the sampling rate honestly: **6 samples over
917 ms of gesture (11 % of frames)** — so the blank durations this instrument reports
are **upper bounds on continuity**, not exact counts, and every blank figure in this
document is read that way.

## 3. The decision experiment: is the mounted history the cost?

`tests/e2e/perf-decision.spec.ts` (`SCROLL-AB`) is one page, one fixture, one gesture,
one variable. 4,075 entries, the heavy preset (long Markdown, wide tables, fenced
code, 300-line gutter diffs, 300+ tool cards), 4× CPU throttle during the gesture.

Measured, after two attempts that did not fit the budget (2,000 heavy entries, 4× CPU
throttle during the gesture only):

| arm | DOM elements | gap p50 | gap p95 | gap max | gaps > 100 ms | gaps > 250 ms | **React commits** |
| --- | --- | --- | --- | --- | --- | --- | --- |
| **mounted** (shipping) | 78,617 | **16.7 ms** | **137.9 ms** | **152.2 ms** | **24** | **0** | **2** |
| **cheap-dom** (probe) | 78,619 | 16.6 ms | *12,672 ms* | *12,804 ms* | 23 | 23 | 0 |

**The probe arm is invalid and its numbers are not evidence.** It is recorded rather
than deleted because the reason matters: `contain-intrinsic-size: auto 120px` collapsed
the scroll height from **739,730 px to 36,708 px** — a 20× error — so the "cheap-dom"
run scrolled through a transcript whose rows had been replaced by 120 px placeholders,
and its 12.8 s gaps are the engine thrashing on a wrong layout estimate, not a
measurement of anything real. A valid probe needs the rows' real heights supplied
(measured, not guessed). That is the outstanding experiment, and the verdict below does
not rest on it.

What the **mounted** arm does establish, and it is worth more than the bisect would
have been:

- **React is not the mechanism.** Exactly **2 commits** occurred across the entire
  eight-flick train. The commit counter is installed before any app script through
  `__REACT_DEVTOOLS_GLOBAL_HOOK__`, so this is React's own report, not an inference
  from reading the code. The previous round's memo work holds: the list is not being
  reconciled per frame.
- **The stall is sub-250 ms at this size.** 24 frame gaps exceeded 100 ms, none
  exceeded 250 ms, at 4× throttle with 78,617 elements. At **8,000** heavy entries the
  same instrument recorded a **553.6 ms p95 / 689.7 ms max** gap over 313,916 elements.
  The growth is super-linear in node count, which is the shape a rendering-bound fix
  is meant to flatten.

**Status: this arm was not completed.** The full 4,075-entry heavy fixture takes ~7
minutes to mount on this machine, and the two-arm run exceeded the spec's 600 s
ceiling with the browser torn down mid-measurement (the failure is recorded, not
retried into a green). The decision below therefore does **not** rest on it. It rests
on §3's control, which does not need the app: a 488,004-element document with no React,
no observers and no app handlers stalled its own scroll at `p95 33 ms / max 439 ms` at
4× throttle, and the app's own 8,000-entry scroll reported a **763.9 ms** single
main-thread task with script+style+layout totalling 61 ms. Both point the same way —
the cost is the document's node count — but the probe that would have quantified the
app's own share is outstanding and is named as such in §I of the audit report.

The second arm is the **probe**, not a candidate fix: `content-visibility: auto` keeps
every element in the document (so nothing becomes unreachable) while letting the
engine skip the layout and paint of anything far from the viewport. If the gaps do not
collapse under it, the history's own layout/raster is not the mechanism and bounding
what is rendered would be an unearned rewrite.

### The main thread is not blocked, and React is not re-rendering the list

Measured in the same condition (`perf-profile.spec.ts`, `PROFILE-01..04`):

| entries | throttle | DOM elements | layout | style | script | **main-thread task total** |
| --- | --- | --- | --- | --- | --- | --- |
| 4,075 (plain) | 1× | 14,311 | 0.01 s | 0.000 s | 0.021 s | 0.457 s |
| 4,075 (heavy) | 1× | 160,027 | 0.019 s | 0.002 s | 0.022 s | 2.226 s |
| 8,000 (heavy) | 4× | **313,916** | 0.028 s | 0.001 s | 0.011 s | **15.304 s** |

The split is the finding. Script, style recalc and layout — everything React and the
CSS engine do — total **61 ms** across an 8,000-entry scroll at 4× throttle, while
*main-thread task time* is **15.3 s** and a single `RunTask` reached **763.9 ms**. So
the stall is not React reconciling rows (script ≈ 0), and it is not style or layout
(single-digit milliseconds). It is the browser's own per-frame work inside a document
with 313,916 nodes.

Consistently, a **control** with no app code at all:
4,000 synthetic heavy rows (488,004 elements) scrolled with `content-visibility`-free
plain CSS at 4× throttle produced `p95 33 ms / max 439 ms` — i.e. a document in the
hundreds of thousands of elements stalls this engine **on its own**, with no React,
no observers and no app event handlers in the picture. That is what "the cost is the
document, not the framework" looks like as a measurement.

---

## 4. Chromium and WebKit

*(Findings from both engines; the WebKit column is filled from the runs recorded in the
audit report, not restated here.)*

Two harness facts had to be established first, both measured:

- **WebKit will not accept the app's session cookie over plain HTTP.**
  `__Host-caw_session` is `Secure` by specification, and unlike Chrome, WebKit does
  not exempt loopback. Login therefore *appears* to succeed and every later request is
  401 (`tests/e2e/auth.spec.ts` asserts the real cookie, so the shared server config
  must not be weakened for this). The scroll specs run WebKit against
  `CAW_INSECURE_COOKIES=1`, which is the app's own documented loopback-only dev flag
  (`apps/server/src/config.ts:26,151`, `apps/server/src/auth.ts:50`).
- **WebKit cannot be pixel-sampled the way Chromium is**, and it cannot be *gestured*
  the way Chromium is either: there is no CDP, `mouse.wheel` is unsupported in mobile
  WebKit, and Playwright's touchscreen offers no drag. A WebKit run therefore drives
  the scroll by direct offset assignment with the same travel and per-step frame budget,
  which measures the layout path but **not** the compositor path a thumb drives.
  Chromium's touch-flick train measures the compositor path. The two are not
  interchangeable and the report keeps them in separate columns, with the `sampler` and
  `gesture` fields on every JSON line naming which was used.
- The one thing WebKit *does* give that Chromium cannot is the honest answer to "does
  this reproduce in the owner's engine at all".

WebKit also needed one local dependency (`libmanette-0.2.so.0`, and its own transitive
deps) placed in the browser bundle; it is present in `~/.cache/ms-playwright/webkit-2370`
and now launches.

---

## 5. Candidates considered

| candidate | verdict | reason |
| --- | --- | --- |
| **Incremental / deferred mount** (`content-visibility`, idle chunking) | **rejected** | The probe in §3 measures exactly this. It defers work to the moment a row enters the viewport, which during a fast flick is the moment it is needed — the previous round measured a 4,075-row load going 935 ms → timeout with it. It cannot bound the *node count*, which §3 shows is the cost. |
| **Anchored pagination** ("Load older" on scroll-up) | **rejected** | Changes what the user can do rather than how fast it is: reaching message 100 requires 20 interactions. It also breaks in-app search across the full transcript unless a second store is added. |
| **Chunked rendering keeping all history mounted** | **rejected** | Same node count as today once the user has scrolled through; the stall returns after a minute of use. |
| **Pure `contain: layout paint` on every row** | **rejected as sufficient** | The previous round measured ~26 % layout reduction and did not commit it; §3 shows layout is 0.028 s of a 15.3 s task total, so a 26 % layout cut cannot close a 764 ms gap. |
| **TanStack Virtual** (`@tanstack/react-virtual`) | **rejected** — see §6 | Adds a dependency and a measuring contract to solve a problem this app can solve with `content-visibility`… or with its own windowing, measured first. |
| **Incremental windowing over the authoritative model** | **selected, implementation outstanding** | Keeps the full transcript in the data model (so search, copy and jump stay exact), mounts only a bounded window, and adds no dependency. The measured node counts in §3 justify it; §8 records what was and was not shipped this round. |

---

## 6. Why not TanStack Virtual

The brief pre-approved it, so the rejection needs numbers, not taste.

- Its value is dynamic measurement of variable-height rows with an offset table. This
  app's rows are *already* variable-height and *already* measured by something: the
  scroll container itself. The measured cost that matters (§3) is behind the renderer,
  in the engine's per-frame work over 313,916 nodes.
- Adopting it means owning a measurement contract for markdown, tables, diffs,
  streaming rows, expansion, and mobile keyboard resize — the exact surfaces §7 has to
  keep correct anyway.
- Bundle: the app's own bundle is 136.96 kB gzip. The library is roughly a third of
  that again, for an offset table this app can compute from the same identity keys it
  already has.

**Decision: incremental windowing, implemented in-tree, no new dependency.** If the
window table proves wrong at some size, the fallback is `content-visibility: auto` on
the mounted window only, which §3 shows is free to keep on top.

---

## 7. What the implementation must not break

(Holds for the shipped change; each line is an assertion in `PERF-SCROLL-*` or a unit
test.)

1. **Full transcript retained.** The authoritative `TranscriptMessage[]` is untouched;
   the reducer, replay and compaction are unchanged.
2. **Reachability.** Top, middle and end rows must be reachable — the assertion the
   current build satisfies by mounting everything, and the one a naive window breaks.
3. **Identity.** Keys come from the message identity the reducer already guarantees
   (`transcript.ts` preserves object identity for untouched messages), never an array
   index.
4. **Tail-follow semantics preserved.** `followTailRef` / `TAIL_THRESHOLD_PX` keep
   their meaning: a streaming update must not yank a user who has scrolled up.
5. **Anchoring.** Prepended history preserves the visible row and its offset.
6. **Approvals and errors are never deferred.** A pending approval or an error notice
   is not windowing material.
7. **Expansion measures.** Expanding a prompt, a tool card or a diff must not jump the
   viewport.


---

## 8. Status of the implementation, stated plainly

This document was written before the implementation, as required. It must therefore
record what the implementation actually did, including where the round ran out of
road:

| item | status |
| --- | --- |
| Instruments (`perf-scroll.spec.ts`, `perf-decision.spec.ts`, `perf-profile.spec.ts`, `perf-scroll-gates.spec.ts`, `perf-trace.ts`, `png.ts`, `perf-scroll-harness.ts`) | **shipped** and runnable |
| Instrument validation (`perf-pixels.spec.ts`) | **shipped**; the detector was validated in both directions with a controlled overlay |
| Black-screen mechanism | **measured**: a 313,916-element document produced a single **763.9 ms** main-thread task while script+style+layout totalled **61 ms**; a 488,004-element document with no app code stalled its own scroll at p95 33 ms / max 439 ms at 4× throttle; at 2,000 heavy entries (78,617 elements) gaps reached only 152 ms with **2 React commits** in the whole gesture |
| Root cause of the black screen | **attributed to the rendering cost of the mounted history, not to React**: the commit counter reports **2 commits** across an eight-flick train while the same page produced 24 gaps over 100 ms, and at 8,000 entries a single main-thread task reached 763.9 ms with script+style+layout at 61 ms. The node-count writer is `TranscriptList` (`apps/web/src/components/MessageRow.tsx:244`) rendering every row of `transcript.messages` — the list has no window, so its DOM is O(history). **No single `file:line` "bug" exists to point at**: the code does what it says; it is the unbounded output that costs. |
| Windowing implementation | **NOT SHIPPED this round** — the round ended with the evidence complete and the change unstarted. Shipping an unmeasured rewrite of `TranscriptList` would be exactly the unverified success claim `AGENTS.md` rule 9 forbids, so the finding is delivered instead of a guess. `PERF-SCROLL-01/02` and `SCROLL-AB` are the pre/post instruments it needs. |
| Input integrity | **measured and PASSING** — see below |
| WebKit | **runs**; both engine prerequisites solved (cookie flag, bundle dependency) |

### Input integrity: measured, and it does not reproduce

`tests/e2e/perf-input.spec.ts`, both gates **PASS** against the current build:

| gate | result |
| --- | --- |
| `PERF-INPUT-01` — 500 characters as one burst during an active stream | **500/500, `exact: true`**, page saw 500 `input` events, `committedShrank: 0` |
| `PERF-INPUT-02` — 2,000-char paste, selection replace, held Backspace, Vietnamese IME | paste 2000/2000 exact; replace 1001/1001 exact; Backspace removed characters and never added; composition landed `xin chào thế giới` exactly once, 1 `compositionstart` / 1 `compositionend` |

The prior round's 491-492 was therefore **not reproducible on this build**, and the
in-page counter is what distinguishes the two stories: the page received **500** `input`
events carrying 500 characters, so on this build neither the app nor the browser
dropped anything. The old number is recorded rather than deleted, because the round
that measured it is the reason this instrument exists.

**Honest limit:** the burst was driven by `pressSequentially(text, { delay: 0 })`. That
is the fastest path Playwright has, but it is still Playwright dispatching keys at
Node's pace; it is not proof that no hardware/throttled input sequence could outrun a
commit. What is proven is that when the page's own `input` events carry N characters,
the composer's committed value is exactly N, in order, with no shrink anywhere in the
series.


---

## 9. The measured stall, in the form the fix will be judged against

`PERF-SCROLL-02` — 8,000 heavy entries, real CDP touch flicks, 4× CPU throttle,
Chromium 390×844@2×:

| metric | value |
| --- | --- |
| entries | 8,000 |
| **DOM elements** | **313,916** |
| rows mounted | 6,769 |
| **frame gap p50** | **88.2 ms** |
| **frame gap p95** | **544.6 ms** |
| **frame gap max** | **793.1 ms** |
| longest main-thread task | 151 ms |
| blank frames observed | 0 of 11 samples |

### The same gesture in WebKit — the owner's engine, and it is worse

`SCROLL-02` on `--project=webkit`, mobile WebKit (390×844, `isMobile`, `hasTouch`), same
8,000-entry heavy fixture. WebKit has no CDP and mobile WebKit rejects `mouse.wheel`, so
the scroll is driven by offset assignment at the same travel and per-step frame budget —
a layout-path gesture, not a compositor-path flick, and reported as such:

| metric | Chromium (touch flicks) | **WebKit (layout-path scroll)** |
| --- | --- | --- |
| DOM elements | 313,916 | 313,916 |
| rows mounted | 6,769 | 6,769 |
| gesture duration | 67.0 s | 145.8 s |
| **frame gap p50** | **88.2 ms** | **135 ms** |
| **frame gap p95** | 544.6 ms | **597 ms** |
| **frame gap max** | 793.1 ms | **2112 ms** |
| longest main-thread task | 151 ms | 0 ms (`longtask` is Chromium-only) |
| blank frames | 0 / 11 samples | 0 / 29 samples |

**WebKit is at least as bad and its worst gap is 2.7× Chromium's.** This is the
engine-correct answer to "does the owner's iPhone reproduce it": yes, on the same
document, with the same stall structure — a frame budget blown by an order of
magnitude, repeatedly, for the whole gesture. The earlier round's "WebKit BLOCKED" is
now stale and is corrected here: WebKit runs, both blockers were solved (the
`__Host-`-over-HTTP cookie rule, and one missing system library in the browser bundle),
and it reproduces.

Read that table in order, because the last row is the one that must not be
misread. The main thread went **793 ms** without producing a frame, at a p50 of
88 ms — i.e. *more than five frame budgets per frame, continuously*. The blank-frame
count is 0 only because the sampler is itself a main-thread-ish operation: when the
thread is held for 544-793 ms, the sampler produces 11 samples across a 67-second
gesture, and a blank frame is simply not observed rather than not occurring. An
11-sample series is **not evidence of absence**, and it is reported as a rate rather
than as a pass.

This is the answer to the owner's report, in one line: **the browser is not painting
for up to 793 ms at a time while a 313,916-element transcript is flicked, and at the
reported 4,075-entry size the same document is ~160,000 elements.** Nothing in the
app's own JavaScript is responsible — script, style recalc and layout total 61 ms over
the whole gesture (table in §3) and React committed twice.


---

## 10. Gate results measured this round

Chromium, mock host, no agent launched. Only runs that actually completed are listed;
everything else is named as unrun.

| gate | verdict | measured |
| --- | --- | --- |
| `PIXEL-DETECTOR` | **PASS** | 0 false positives on the painted app; crash over an opaque overlay detected at 494.6 ms |
| `PIXEL-COVERAGE` | **PASS** | 6 samples / 917 ms gesture = 11 % coverage, stated as a bound |
| `PERF-INPUT-01` | **PASS** | 500/500 exact during a live stream; page saw 500 `input` events; 0 committed-value shrinks |
| `PERF-INPUT-02` | **PASS** | paste 2000/2000, replace 1001/1001, Backspace monotonic, IME `xin chào thế giới` exact once |
| `PERF-TOOLS-01` | **PASS** | 600 tool events over 30 ids → **1** group, **0** rows added, 5 DOM elements, 0 long tasks |
| `PERF-MEMORY-01` | **PASS** | 4 reconnect+stream cycles: listeners **2 → 2 (drift 0)**, rows **501 every cycle**, heap +13.2 MB total |
| `PERF-SCROLL-03` | **PASS** | streaming + upward flick: drift during stream **0 px**, stream proven live throughout |
| `PERF-SCROLL-05` | **PASS** | Agent Detail round trip: scroll drift **0 px** |
| `PERF-SCROLL-06` | **PASS** | prepend/replace of 600 → 900 rows: visible row top delta **0 px** |
| `SCROLL-02` | **PASS** (numbers recorded) | 8,000 heavy entries: 313,916 elements, gap p50 88 ms / p95 544.6 ms / max 793.1 ms, 67 s gesture |
| `SCROLL-AB` (mounted arm) | **PASS** (numbers recorded) | 2,000 heavy entries: 78,617 elements, gap p95 137.9 ms, max 152.2 ms, **2 React commits** in 8 flicks |
| `SCROLL-AB` (probe arm) | **INVALID** | `contain-intrinsic-size` collapsed 739,730 px → 36,708 px; result discarded, reason recorded in §3 |
| `PROFILE-01..04` | **PASS** (numbers recorded) | CDP metrics + trace; V8 self-time polluted by the harness's own injected script and reported as such |
| `PERF-SCROLL-01..08`, `PERF-STREAM-01`, `PERF-TOOLS-01`, `PERF-MEMORY-01` | **PASS on both engines** | 24 passed + 1 skipped on Chromium and on WebKit; the skip is `PERF-LOAD-01`'s CDP heap metric on WebKit (§16) |
| `SCROLL-01..12` | **PASS on Chromium and on WebKit** | 12/12 each; zero blank frames in every scenario |
| `PERF-SEARCH-01` | **PASS** | a hit at entry 4,000 is not mounted before searching, is found, and is mounted and on screen afterwards, DOM 386 elements |
| `auth.spec.ts` | **PASS in both cookie modes** | 4 passed / Chromium+WebKit mode (dev cookie), 4 passed / Chromium-only mode (`__Host-` cookie) |

Verdict vocabulary is the brief's: PASS / FAIL / BLOCKED / UNVERIFIED. No over-budget
measurement was converted into a SKIP, and no assertion was weakened to keep a suite
green.


---

## 11. What was not delivered in that round, and why it was the honest answer then

Deliverable 4 of the brief (bounded transcript rendering) was **not implemented in the
evidence round**. The brief gates it on profiling showing the whole history's
DOM/layout/raster is material, and the profiling was done and does show that; what was
missing was the *bisect* that would have attributed the cost between "the history's
layout" and "the history's node count", because the probe produced a 20× wrong layout
estimate (§3) and the round's budget ended before a valid one could be built and run.

Shipping `TranscriptList` windowing from the evidence in hand would have meant writing
a new measurement contract, an anchor policy and a scroll-restoration path, and landing
them **without a before/after number** — the exact failure mode this repository's rule 9
forbids. So the instruments were delivered, and the change was named outstanding.

**That change is now shipped.** Sections 12-16 record it: the design, the five defects
the tests found in it, the overscan benchmark that chose the configuration, and the
measured before/after on both engines.

## 12. The windowing change as shipped

`TranscriptList` (`apps/web/src/components/MessageRow.tsx`) keeps the complete
conversation in `entries` and mounts only the entries near the viewport plus whatever
is pinned. The arithmetic is a dependency-free module,
`apps/web/src/transcript-window.ts`.

| concern | decision | why |
| --- | --- | --- |
| What is bounded | the **mounted DOM**, never the data | `rows` and `groupActivity(rows)` stay whole; search, copy, expansion and counts all read the full arrays |
| Window unit | **entries** (group or row), not rows | a group is one DOM unit holding many rows; windowing rows would mount a group's body without its head |
| Height model | **measured**, cached by identity, estimated from the nearest measured neighbour | the previous round's 120px constant was what invalidated its bisect; a constant is also wrong by 10× between a notice and a diff |
| Measurement | one `ResizeObserver`, re-armed on the mounted set, reading `firstElementChild` | the wrapper is `display: contents`, so it has no box of its own |
| Offsets | prefix sums in a `Float64Array`, binary search | scroll↔index is O(log n) |
| Spacers | exact sums of the same `offsets` array | `scrollTop = offset[i]` lands entry `i` at the top **exactly**, even while distant heights are guesses |
| Anchor | identity + offset from the viewport top + the `scrollTop` it was taken at | the third field is the guard that stops the correction from fighting the user |
| Tail-follow | unchanged `followTailRef` / `TAIL_THRESHOLD_PX`, plus re-pinning on measurement | the document grows as estimates become measurements; without re-pinning the newest row drifted 7,529px out of view |
| Native scroll anchoring | **disabled** (`overflow-anchor: none`) | two invisible authorities over one `scrollTop` disagree exactly when it matters; measured 1,296px jump with it on |
| Pinned entries | force-mounted as **separate segments** | see the defect table below — a widened window mounted 6,759 rows |
| Small lists | `< 60` entries render everything | a short conversation should not pay for a measurement pass |
| Dependency | **none added** | bundle 470.70 → 481.31 kB raw, 138.24 → 142.09 kB gzip (**+3.85 kB gzip**) |

### The five defects the tests found in the first implementation

Every one of these was a real, measured fault in my own change, and each is now
covered by a test:

| defect | measurement | fix |
| --- | --- | --- |
| Pinned entries widened the window | 6,759 of 7,988 entries mounted, 321,402 elements | pins became separate segments with a spacer between |
| Pinning every notice | 616 pinned segments in the 8,000-entry fixture | pin only `isError` rows; routine notices are cheap to re-mount |
| Correction fought programmatic scrolls | a 120-step scroll never progressed | correction skipped when `scrollTop` moved since capture |
| Correction re-triggered itself | React #185 (maximum update depth) after 2 touch flicks | no state write from the correction; the scroll event carries it |
| Anchor force-mounted | estimated height compounded to 7.8M px for 4,075 entries | the anchor is not pinned; the correction alone holds the position |

## 13. Overscan, chosen by measurement

`SCROLL-02` (8,000 heavy entries, 8 upward touch flicks, 4× CPU throttle on Chromium)
and the WebKit layout-path equivalent, each configuration a **real production bundle**:
the constant was patched, `pnpm --filter @caw/web build` was re-run, and the spec was
executed (`scripts/overscan-sweep.mjs`). No benchmark knob exists in shipped code.

| overscan | engine | DOM elements | rows mounted | gap p50 | gap p95 | gap max | blank frames |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 400 px | Chromium | 277 | **1** | 16.6 | 33.2 | 34.2 | 0 / 16 |
| **800 px** | **Chromium** | **315** | **6** | **16.6** | **33.2** | **34.6** | **0 / 16** |
| 1600 px | Chromium | 594 | 12 | 16.6 | 33.2 | 33.8 | 0 / 17 |
| 400 px | WebKit | 529 | 4 | 16.0 | 66 | 76 | 0 / 39 |
| **800 px** | **WebKit** | **529** | **4** | **16.0** | **65** | **76** | **0 / 37** |
| 1600 px | WebKit | 843 | 18 | 16.0 | 65 | 74 | 0 / 37 |

**800 px chosen.** 400 px collapses to a **single** mounted row on Chromium — one
failed estimate or one flick past it and the viewport is empty, which is exactly the
forbidden "small overscan that leaves black gaps". 1600 px doubles the DOM (315 → 594)
for 0.4 ms of frame-gap improvement (34.6 → 33.8), i.e. it restores half the old DOM
problem to buy a number already inside budget. 800 px is the smallest configuration
that never left the viewport with no content in either engine.

## 14. Before / after, same fixtures, same throttle, same engines

`SCROLL-02` — 8,000 heavy entries, real touch flicks (WebKit: layout-path scroll, since
mobile WebKit supports neither CDP nor `mouse.wheel`), Chromium at 4× CPU throttle.

| metric | Chromium before | **Chromium after** | WebKit before | **WebKit after** |
| --- | --- | --- | --- | --- |
| DOM elements | 313,916 | **214** | 313,916 | **544** |
| rows mounted | 6,769 | **37** | 6,769 | **8** |
| frame gap p50 | 88.2 ms | **16.6 ms** | 135 ms | **16.0 ms** |
| frame gap p95 | 544.6 ms | **32.5 ms** | 597 ms | **65 ms** |
| frame gap max | 793.1 ms | **34.1 ms** | **2,112 ms** | **76 ms** |
| longest main-thread task | 151 ms | **0 ms** | — (no `longtask` API) | — |
| blank frames observed | 0 / 11 | 0 / 18 | 0 / 29 | 0 / 37 |
| gesture duration | 67.0 s | **3.2 s** | 145.8 s | **7.0 s** |

The gesture-duration collapse is not a different gesture: it is the same flick train
finishing because the renderer is no longer 793 ms behind each frame.

`SCROLL-01` — 4,075 entries, top → bottom, Chromium:

| metric | before | **after** |
| --- | --- | --- |
| DOM elements | 160,027 (measured, §2) | **5,833** |
| frame gap p95 / max | 358.1 ms longest task | **21.2 / 52.9 ms**, longest task 0 ms |

`PERF-LOAD-01` — the ~12 MB snapshot (1,400 entries):

| metric | value |
| --- | --- |
| fixture | 12,641,997 bytes |
| first content | **750-763 ms** |
| DOM elements at that moment | **53** |
| peak heap | **133.7 MB** |
| long tasks | 1 (62 ms) |
| full history available | first, middle and last entries walked and found |
| entries reported | 1,400 (equals the snapshot) |

`PERF-STREAM-01` — 12 Markdown sections streaming into a 4,075-entry history:
stream wall **788 ms**, longest task **0 ms**, DOM **185 elements**, 4,075 entries
still reported.

Correctness under the same conditions (all measured, all passing):
prepend anchor delta **0 px**; expansion jump **-1 px**; Agent Detail round-trip drift
**0 px**; streaming while scrolled up **0 px**; tool grouping 600 events → **1** group,
**0** new rows; reconnect cycles 4× with listener drift **0** and +6.9 MB heap.

## 15. Information fidelity, verified rather than asserted

| requirement | how it is met | how it is verified |
| --- | --- | --- |
| full transcript retained | `rows` is never truncated; only the DOM is bounded | `aria-setsize` equals the conversation size (8000, 4075, 1400, 900 asserted) |
| reachable top/middle/end | window recomputed from any `scrollTop` | `PERF-LOAD-01` walks first, middle and last and finds all three |
| in-app search over the COMPLETE transcript | `searchTranscript` reads `messages`, never the DOM | unit tests find a hit in message 10,000 of 10,000; Enter/Shift+Enter step and wrap |
| native Find no longer sufficient | documented in-app search, menu → "Search transcript" | result count in a polite live region; 50 matches listed, the rest reachable by stepping |
| a hit inside a collapsed group | the reveal opens the group (`revealMemberId`) | `waitForRow` opens folded groups and then finds the text |
| copy of the full message | unchanged: `CollapsibleMessage` reads `text` verbatim | existing suite |
| message identity | keys are the row id / `group:<first member id>`, never an index | `entryKey` tests, including "survives a prepend without renumbering" |
| screen-reader position | `role="list"`/`listitem`, `aria-setsize` + `aria-posinset`, `aria-busy` while unmeasured | component test asserts setsize=8000, posinset=1 |
| nothing focusable vanishes | sticky set: any entry containing `[aria-expanded="true"]` or `document.activeElement` | `PERF-SCROLL-04` expands and collapses while asserting the reader does not move |
| approvals/errors never deferred | the approval surface is a sibling of the list; `isError` rows are pinned by identity | pinned-entry component test |

## 16. The defects the gates caught in the window (and the input bug behind them)

These are recorded because a change this size is judged by what it broke before it was
fixed, not by the shape of its final diff.

| # | defect | how it showed | fix |
| --- | --- | --- | --- |
| 1 | Pinned entries widened the single window | 6,759 of 7,988 entries mounted, 321,402 elements | pins became separate segments |
| 2 | Every notice was pinned | 616 pinned segments in the fixture | pin `isError` only |
| 3 | Correction fought programmatic scroll | a 120-step scroll never progressed | the correction now accounts for the movement instead of bailing |
| 4 | Correction re-triggered itself | React #185 after 2 touch flicks | no state write from the effect |
| 5 | Anchor force-mounted | document estimate compounded to 7.8 M px for 4,075 entries | the anchor is not pinned; the correction holds the position |
| 6 | Native scroll anchoring fought ours | 1,296 px jump when a disclosure expanded | `overflow-anchor: none` on the scroller |
| 7 | Fast-typing clobber | 500-character burst committed **493-497** | the textarea's own value is adopted when it disagrees with state |
| 8 | Estimate drift left the band empty | WebKit: mounted rows entirely above the viewport (-715 px against band top 102), blank paints up to 199 ms | the correction combines scroll delta *and* geometry delta |
| 9 | Reveal landed under the fold | search mounted the hit but placed it off-screen | reveal targets the entry top minus a small inset |

Defect 7 is worth stating plainly because it is the one the brief flagged: the composer
did **not** need a new data path — `updateDraft` already read `event.target.value`. What
it needed was for the element to win when React's held value was older than the
element's. It is now fixed at the root, and the gate reads 500/500 on three consecutive
runs where it read 493/497 before.

## 17. One blank sample on WebKit SCROLL-01, and what it is

`SCROLL-01` on WebKit reports **1 blank frame (283 ms)** while every other scenario
reports zero. It is reported, not suppressed, and it is **UNVERIFIED** whether a user
can see it. The evidence, in order:

- The sample's own diagnostics say `mounted: 24`, `visible: 6`, `posRange: [4070, 4075]`
  and `scrollTop: 196,847` — i.e. the entries the DOM held were four thousand ranks away
  from the offset reported beside them.
- A manual `page.screenshot()` at the same point in the same gesture is **fully
  painted**: the transcript fills the band with readable rows. The blank exists only in
  the recorder's own capture.
- The recorder reads its diagnostics *before* `page.screenshot()`, and the gesture is
  still running while the screenshot is taken — so the sample's offset and its pixels
  are not necessarily the same instant.
- `SCROLL-01` is the only scenario driven by a 120-step programmatic scroll. Every
  scenario driven by real touch flicks — `SCROLL-02` (8,000 entries), `SCROLL-04`,
  `SCROLL-08`, `SCROLL-11`, `SCROLL-12` — reports **zero blank frames** on both engines,
  repeatedly.

What that supports: the mounted window is correct at every settled position (verified
directly: entries 1-3 at the top after settling), and the blank is an artefact of
screenshotting WebKit mid-programmatic-scroll rather than evidence of an unpainted
transcript. What it does **not** support: claiming the WebKit compositor never blanks on
a real device under a real thumb. That would need a real device, and this round cannot
make that claim.

The gate therefore prints the number and does not convert it into either a pass it
cannot justify or a skip that hides it.

## 18. The top-edge sliver: `overflow` clips to the padding box

Reported symptom: at 320 and 375 a ~10px sliver of a previous `.activity-group-head`
(radius 10, `#242424`) was visible directly under the dashboard. It read as a stray pill.

The mechanism is not the transcript and not the cards. `overflow: auto` clips to the
**padding box**, so `.messages-scroll`'s own `padding-top: 10px` is a permanent 10px
window through the scrollport rather than a leading inset in the content: anything
scrolled out above the content box still painted there, sliced mid-rounding. Measured at
320x568 idle before the change: `.activity-group-head` at band-relative y −12.7..31.3
against a content top of y 10 — its rounded bottom 10.7px on screen with the rest clipped.

The fix moves the inset from the scrollport to the scrolling content: vertical padding 0
on `.messages-scroll` plus `padding-top: 10px` on `.messages-content`, and
`scroll-padding-top: 10px` on the scroller so a revealed row still lands below the edge
rather than under it. A partially scrolled row is now clipped flush by the scrollport
edge, which is the correct behaviour for a scrolling list, and the 10px of breathing room
still exists at rest. No mask, no gradient, no decoration; nothing is hidden that was not
already outside the content box.

Verified in the built bundle at 320x568 and 375x667, idle and streaming, before and after
(`~/.cache/clip-probe/<viewport>-<state>-<before|after>.png`). After: `.activity-group-head`
at −12.7..31.3 with the content top at 101 — clipped flush, and both probe rows report no
element crossing the edge un-clipped. The 44px tap target is untouched: the head is 44px
tall and is cut only when it is already partially scrolled out, which is what a scrolling
list does. No content is hidden at rest.

## 19. The tail lock lost the tail when the document grew

Found after the windowing round, from a report that a chunked 2,000-entry load opened on
`minPosition` 1168 of 2000 — the middle of the history, with "↓ Latest" needed to reach
what the agent had just said. Reproduced and explained; the cause is not chunking.

**Reproduction (built bundle, chromium, 390x844, round-50 fixture shape: tall user rows
plus a tool call every 40th):**

| sample | scrollTop | scrollHeight | clientHeight | distanceFromBottom | mounted range | last entry painted |
|---|---|---|---|---|---|---|
| after load, settled 3s | 182,973 | 312,180 | 682 | **128,525** | 1168-1183 | **no** |

The offset never moved: 183,566 - 682 = 182,884, which is where the list had correctly
pinned itself. The document then grew to 312,180 — it is the *same* 128,525px the view
was drifting from. A windowed list estimates the height of rows it has not measured, and
this transcript's unmeasured estimate is ~92px/row while the real rows measure ~156px/row,
so 2,000 rows estimated at 183,566px measure 312,180px. That growth happens below the
fold, while the reader is sitting still.

**Cause** — `ConversationView.updateTailLock`, which runs on every scroll event:

```ts
const nearTail = element.scrollHeight - element.clientHeight - element.scrollTop <= TAIL_THRESHOLD_PX;
followTailRef.current = nearTail;
```

`distance` alone cannot distinguish the two reasons the measurement can change: the reader
moved, or the document grew underneath a reader who did not. Growth makes `nearTail` read
false, the lock clears, and the list stops following — permanently, because the layout
effect that would have re-pinned now sees `followTailRef === false`. Probed trace of the
exact sequence (`tail-effect` / `scroll-event` are the two authoritative effects):

```
tail-effect   follow=true   top=182884  sh=183566   <- pinned correctly
scroll-event  nearTail=false top=182884  sh=183868   <- doc grew 302px -> detached
scroll-event  nearTail=false top=182973  sh=312170   <- doc grew 128k more
row-stick     follow=false                            <- tail-follow lost for good
```

Chunking was **not** the cause: one 2,000-entry chunk reproduced it identically
(`chunk=2000` gave the same `distanceFromBottom: 128525`, range 1168-1183). Nor was it
arbitrary: a transcript of uniform short rows does not reproduce, because there the
estimate is accurate and the document never grows. Real transcripts are the reproducing
case.

**Fix** — `apps/web/src/components/ConversationView.tsx`. The lock now remembers the last
observed `{ scrollTop, scrollHeight }` and treats *known* growth as its own explanation:

```ts
const notMovedUp = top >= last.top - 2;
const grew = last.height > 0 && height > last.height + 0.5;
const explainedByGrowth = followTailRef.current && grew && notMovedUp;
const nearTail = distance <= TAIL_THRESHOLD_PX || explainedByGrowth;
```

Three details were each required, and each was found by a failing test rather than guessed:

- `grew` requires a baseline (`last.height > 0`). The first event of a load otherwise
  compares against `{ top: 0, height: 0 }` and reads a document that had grown from the
  pin to the event as an unexplained jump. The tail-pin layout effect therefore records
  the baseline it just created, so the next event is judged against the pin.
- `notMovedUp`, not `!movedUp`-of-any-kind: a reader who drags slowly downward inside a
  long history is also leaving the tail, and a direction test that only looks upward
  would re-pin them. Growth is allowed to excuse the distance only when the reader did
  not move up.
- The `offsetUnchanged` variant was tried first and is wrong: during a multi-chunk load
  the offset legitimately changes between events (the re-pin, then the browser clamping),
  so growth with a moved-but-not-upward offset must still count.

When the lock holds, the scroll event re-pins in the same event rather than waiting for
the next measurement commit, so the newest row does not go out of view at all.

After the fix, same probe: `distanceFromBottom 0`, mounted range 1991-2000, last entry
painted, "↓ Latest" not shown — chunks of 50 and a single chunk of 2,000 both.

**Gate** — `PERF-SCROLL-09` in `tests/e2e/perf-scroll-gates.spec.ts`: loads a 2,000-entry
snapshot in 40 chunks using the tall-row shape that reproduces, then asserts, with no user
scroll, that the newest entry is painted, the mounted window includes it, the view is
within 120px of the bottom, and no "↓ Latest" affordance is offered. A/B verified: it
**passes** on the fixed build and **fails** on the pre-fix build with
`the newest entry must be painted once the snapshot is loaded and the DOM is quiet`.
It is a behaviour gate, not a timing budget. Uniform-short-row fixtures are unsuitable for
it, because the estimate happens to be right and the defect cannot occur — the gate uses
the reproducing shape and says so in a comment.

## 19b. The release sweep: four blockers, what they were, what fixed them

The full-rate gate sweep found a React #185 crash and three failing gates in a build whose
own gates were green. Each is recorded here with its mechanism, the measured before/after,
and the test that would have caught it.

### BLOCKER 1 — React #185 (maximum update depth), 4 of 6 runs

**Mechanism.** Not the transcript's geometry. A dev-mode stack from the built bundle named
`adoptElementValue` ← `onInput` (`dispatchSetState`), and counting the writers confirmed it:
the composer had **three** writers for one value on one keystroke — `onInput` → `adoptElementValue`,
`onChange` → `updateDraft`, and the `[draft]` effect writing `setInputText(draft)` from the
very prop this component had just published through `onDraftChange`. React fires both
`onInput` and `onChange` for a single edit, and `updateDraft`'s `sendVersionRef++`
invalidated `adoptElementValue`'s own authorship guard, so the pair alternated instead of
agreeing. Measured during a 500-character burst while a turn streamed: **783 renders of
`ConversationView`, 170 of them inside one 400 ms window**, and `setSendError` dispatched
590-622 times for a value that never changed.

**A second, independent half.** The flex `gap` was subtracted from the spacer heights at
render time (`fitSpacersToGap`), which made every mounted entry sit `k × gap` below its
model offset for a `k` that changed with the mounted range. The anchor correction therefore
measured a fresh ~10 px delta after every window move, wrote `scrollTop`, moved the window,
and measured the delta again — the delta train `+40, −20, +10, −10, +10, −10 …` on an anchor
21,600 px from the top. The gap is now part of the model (`buildOffsets(heights, gap)`,
`count − 1` gaps, none after the last entry), so an entry's model offset is its DOM position
for every window and a window move is not a geometry change.

Also removed: a no-dependency `useLayoutEffect` that published `viewport` on every commit —
a dispatch chain by construction during a stream.

**Fix.** One writer (`onChange` → `handleComposerChange` → `updateDraft`, value read from
`event.currentTarget.value`, authorship guards moved into it); the `[draft]` effect is a
no-op when the parent merely mirrors what we sent; gap in the model.

**Gate.** `PERF-STREAM-02` (new, `tests/e2e/perf-input.spec.ts`): burst typing **and**
scrolling while streaming, asserting `pageerror` is empty — input exactness alone did not
catch this, because the characters still arrived.

**Measured.** 6/6 clean (0 page errors), three separate six-run sweeps. SCROLL-04 and
SCROLL-09 stay green with the window bounds restored as dependencies, which is the proof
that the gap fix — not a dependency removal — is what ends the loop.

### BLOCKER 2 — a detached reader moved 1,046 px

Not reproduced on this build: `SCROLL-05` measures `detachedPx 2,756`, `driftPx 0`, three
runs. The tail lock is now stated once in terms of authorship — while the DOCUMENT CHANGES
SIZE no scroll event can be attributed to the reader (scroll anchoring moves `scrollTop` as
it grows and clamps it as it shrinks), and on a static document a move away from the bottom
is the reader's. The W25 viewport-shrink excuse is subsumed: a reader 3,402 px away is not
at the bottom, so any quiet-document event releases the lock.

### BLOCKER 3 — reachability reported false while reveals were fast

The probe indexed `.message-card` by position in the document (`querySelectorAll(...)[at]`),
which only ever meant "the row at that index" while every row was mounted. With ~37-49 cards
mounted, `[2037]` was `undefined`. Measured: `messageCards 37`, `reachable {top:false,
middle:false, end:false}`, `revealMs {top:98.9, middle:46.7, end:26.8}`. Two further
implementations of the same probe (a 40-step bisection, a 90-step walk) also failed, for a
reason worth recording: at 4,075 rows only ~300 are measured, so an unmeasured row's offset
is an estimate that is re-estimated as the reader moves — at 50% of the scroll range the
mounted run was rows 3,022-3,087, and `scrollHeight` read 216,469 at the instant the load
reported complete against a settled 145,154. No offset arithmetic survives that. The probe
now uses the harness's own `revealRow` — one implementation of "is this reachable" instead
of three. Measured after: `reachable {top:true, middle:true, end:true}`, `revealMs
{146.8, 2148.4, 4143.2}`.

### BLOCKER 4 — PERF-05 `missed: 14`

The step check compared a PIXEL fraction (`scrollTop = scrollHeight × step/15`) against a
ROW fraction (`sentinel((count-1)/15 × step)`). With variable row heights those are different
values, so 11-14 steps "missed" while the frame times never left the budget. Replaced with
the property that actually matters at a pixel offset: the document paints a **contiguous run
of real rows** there (at least one row in the viewport, `aria-posinset` consecutive).
Measured: `rowsNotFound 0`, `p50 20.0 ms`, `p95 21.8 ms`, `longTaskCount 0`.

### Two stale premises, rewritten

- `HIST-14` counted mounted cards (`transcriptTexts(page).length === 300`). It now asserts
  the DECLARED total from `aria-setsize` (300) and that an early row is readable via
  `revealRow`. Writing `scrollTop = 0` is not a valid way to read the top any more: the view
  holds the tail, and the pin correctly overrules the write (measured: the transcript still
  showed rows 267-299).
- `PERF-01` tolerates a windowed DOM (`cards > 10`, `cards < LARGE/10`) and adds the
  declared-total assertion, so it cannot pass by mounting everything and dropping the rest.

### Operational hazard discovered this round (do not fix here)

`apps/web/dist` is served from disk with no release step, so `pnpm --filter @caw/web build`
is an instant unverified deploy to the owner's live origin — which is how the #185 build
reached production while it was still being worked on. This round's builds went to
`/tmp/caw-build` (with `CAW_WEB_DIST_DIR` pointing the e2e server at it), and `dist` was
verified byte-identical to a pristine `b0114e3` build before and after every run.
**Recommended fix, not implemented:** stage to a temp directory and swap atomically
(`build → dist.new → rename`), and have the server resolve a release directory rather than
`apps/web/dist` directly.

## 19c. The WebKit tail defect — root cause, and why it was WebKit-first

`SCROLL-03` failed on WebKit (the owner's engine) intermittently, then 5 of 6 runs once the
probe stopped perturbing it: after a programmatic "return to bottom" the mounted window was
at the TOP of the document (`posinset 17` with the scroller at `scrollTop = max`). The
symptom is the owner's original complaint — "scroll to the latest message shows the wrong
part of the transcript".

### What it was not

Measured at three instants on both engines, same 4,075-entry heavy scenario
(`sync` after the write, `+1 rAF`, `+2 rAF`):

- **Not a short write.** `sync-after-write` reported `atMax: true` on both engines — WebKit
  applied `scrollHeight - clientHeight` exactly, and `scrollHeight` was accurate at that
  moment.
- **Not a stale `viewport` publish** (the ≥0.5px gate). The window is computed from
  `liveTop`, read LIVE from `scrollTop` during render, so a missing publication could not
  by itself pin the window elsewhere.

### What it was

WebKit, run 2 of the probe, is unambiguous:

```
before:  scrollTop 44,598    scrollHeight 459,067   mounted 458..466
sync:    scrollTop 458,385   atMax: true            <-- the write is correct
raf1:    scrollTop 44,578    scrollHeight 459,077   mounted 4070..4075   <-- reverted 413,807px
raf2:    scrollTop 44,558                           mounted 458..466    <-- and back again
```

Something wrote the position BACK to where it was before the jump. That is `MessageRow`'s
anchor correction. The reader had left the tail (so `stickToBottomRef` is false), an anchor
was captured around entry 460, the jump unmounted that entry, and the "anchor left the
window" branch corrected from the model — **without the scroll movement since capture**:

```
target = modelOffset - anchor.offset          // wrong
target = modelOffset - anchor.offset + (scrollTop - anchor.scrollTop)   // right
```

At capture the anchor sat at document offset `D0` with `scrollTop = S0`, so `D0 - S0 = O0`
(its viewport offset). Holding `O0` now needs `target = D1 - O0 = (D1 - D0) + S0`. Any
scroll since capture moves the required target by exactly that movement. Leaving the term
out makes the branch undo **any** movement that unmounts the anchor — a programmatic jump, a
flick across the document, a restored position.

Chromium reaches that branch less often, which is why the gates were green there and the
owner's phone was not.

### The fix

One term, in `apps/web/src/components/MessageRow.tsx`, with the derivation in the comment.
The `Show more` case the branch was written for has `ΔS = 0` (the document grew, the reader
did not scroll), so that behaviour is unchanged — verified by `PERF-SCROLL-04`
(`jumpExpandedPx: 0`, `jumpCollapsedPx: 0`, both engines).

Two supporting changes, each with a measured reason:

- **The tail invariant is enforced after every commit** in `ConversationView`, not only when
  a `scroll`/`ResizeObserver` notification arrives. Measured: WebKit left the view 19,579px
  short of the bottom because content landed after the write with **no** event and **no**
  observer record. It also ADOPTS the bottom when the view is already within
  `TAIL_THRESHOLD_PX`, because the lock is released by the middle/top legs and WebKit can
  coalesce away the final write's scroll event. A reader who genuinely left the bottom is
  further away than the threshold, so this cannot pull anyone back.
- **The window self-heals** when the mounted range does not contain the live offset, since
  WebKit can clamp a write against a maximum it is still recomputing.

### Verdicts after the fix

`SCROLL-03` WebKit **8/8 passed** (`posinset 4075`, `boxTop 758-759`, in-band).
WebKit `SCROLL-01/02/03/04/05/08/11/12` **8/8**. WebKit `perf-scroll-gates` + `perf-a11y`
**14/14**. Chromium `perf-scroll` + `perf-scroll-gates` **25/25**. `PERF-06` on both engines:
`scrollDriftPx 0`. Units **929/929**. Typecheck: 0 errors.

**Instrumentation note for the write-up:** `--trace=off` matters. With Playwright's
`trace: retain-on-failure` on, 6 of 8 runs reported a failure whose only error was
`browserContext.close: ENOENT ... recording1.trace` — the trace writer raced the artifact
directory. Every assertion had passed. A verdict read from those logs would have been wrong
in both directions: it hid the real `posinset 17` failures and reported phantom ones.

## 20. The adversarial review, finding by finding

Every number below was measured in the built bundle; every fix has a test that fails
without it. Findings owned by other workstreams (W7 `ToolActivity.tsx` group head text,
W8/W27 `premium.css`) were not touched.

| Finding | Verdict | What was wrong, and the fix |
|---|---|---|
| **W3** uncapped propagation | FIXED | One 5,000px measurement was copied to every unmeasured row on the other side: 8,000 rows x 5,000px = 40,000,000px, past Chromium's 33,554,428px cap, so `scrollTop` clamps and the tail is unreachable. `estimateHeights` now bounds each BORROWED estimate to `8x` that entry's own per-kind fallback (`PROPAGATION_CAP_FACTOR`); a real measurement is never clamped, because it is not a guess. `buildOffsets` additionally scales the whole model down if the total would exceed `MAX_SCROLL_HEIGHT_PX`, which preserves relative positions and therefore keeps `indexAtOffset(offsets, end)` at the last entry. Tests: 3 in `transcript-window.test.ts` (borrowed bound; 8,000 rows with 5,000px at index 5 and at the end; every row genuinely 5,000px). |
| **W1** flex `gap` invisible to the model | FIXED | `.transcript-entries` is a flex column with a 10px gap; a gap belongs to no element's measured height, so the document was taller than the model by `(renderedItems - 1) * 10px` and the "exact to the pixel" claim in the code was false. New `fitSpacersToGap` takes exactly that difference out of the spacers (starting from the last one), and the component reads the gap from `getComputedStyle` so the 8px Agent Detail column is also correct. The option of putting `padding-bottom` on the entries was rejected: the wrapper is `display: contents` (load-bearing for bubble alignment) so padding on it would not lay out, and padding on the cards would extend every bubble's background — a visual change this workstream may not make. Measured after: round50's landing probe lands entry 1 at the top, entry 997-999 at the middle, entry 2000 at the end, with spacers covering the unmounted span to the pixel. |
| **W4** stale anchor baseline | FIXED | The correction wrote `scrollTop` itself but only re-based the anchor when `\|delta\| >= 1`, so a sub-pixel correction left a baseline the next commit re-applied. It now re-bases after every correction (using the movement the browser ACTUALLY made, since a fractional `scrollTop` snaps to a layout unit) and re-captures unconditionally. A second, larger defect surfaced while fixing it: when the anchor row left the window — which is what a 4,460px expansion does — the effect gave up, leaving the reader inside the expanded block with 13 entries mounted somewhere above. It now corrects from the model (`offsets[anchorIndex] - anchor.offset`), which is arithmetic rather than a guess. Gate: `PERF-SCROLL-04` reports `jumpExpandedPx: 0`, `jumpCollapsedPx: 0`. |
| **W5** `revealRef` never cleared | FIXED | `clearReveal()` added to `TranscriptListApi`; called from `closeTranscriptSearch` (Escape and the close button both route through it) and on a live/saved mode flip. A reveal is now an instruction, not a property of the row. |
| **W6** saved-mode search | FIXED | Search now runs over `isShowingSavedHistory ? savedRows : messages` — the array actually rendered — and the reveal is cleared when the mode flips, so a hit cannot be revealed in a document the reader is not looking at. |
| **W20 / W2** composer adoption | FIXED | `adoptElementValue` ran on every `input` with no authorship test: during IME composition (writing half-composed text into `onDraftChange`, which the parent persists) and after a send had already cleared the draft. Three guards, each for a distinct case: composition in progress (`composingRef` or `nativeEvent.isComposing`), an untrusted event, and a send generation newer than the keystroke's. A genuine fast burst still adopts: `PERF-INPUT-01` is 500/500 exact, and the draft is no longer resurrected by a late `input`. |
| **W16** focus pin discovered late | FIXED | `focusin` on the scroller records the containing entry in the sticky set and bumps a version the window depends on, so a programmatically focused row cannot unmount under the ring. |
| **W26** zero measured height | FIXED | The observer stored `0` while `estimateHeights` rejects `0`, so `aria-busy` cleared for an entry that still rendered at its estimate. `<= 0` measurements are now ignored on the observer side too. |
| **W19** search panel semantics | FIXED | `<label>` closes immediately after the `<input>`; the actions are a sibling `div`. The accessible names ("Previous match", "Next match", "Close transcript search") are asserted by role in the existing search gates. |
| **W18** search cost per keystroke | FIXED | 77 ms/keystroke on a heavy 8,000-message transcript, dominated by `split("\n")` plus `toLowerCase()` per line per keystroke. `buildSearchIndex` now caches lowercased lines once per `messages` identity, and the query is debounced 150 ms. The cache is keyed on the array identity, so a new transcript rebuilds once, not per keystroke. |
| **W17** dead state | FIXED | `spacerHeights` is now USED for the trailing span (the second inline implementation is gone); the discarded `discovered` flag and the `void 0;` vestige are deleted. |
| **W15** `role="listitem"` + `display: contents` | INVESTIGATED, FIXED STRUCTURALLY | Measured in Chromium's own tree (`Accessibility.getFullAXTree`, new `PERF-A11Y-01`): **37 `listitem` nodes, and every one exposed only `level`** — no `posinset`, no `setsize`. A native `<ul><li>` control list injected into the same page **also** exposed only `level`, so this Chromium does not emit those properties for ANY listitem through that API; the omission is the inspection channel, not this markup. The markup was still moved: role, `aria-setsize` and `aria-posinset` now live on the entry's real box (the card), not on the unboxed wrapper, which is the cheaper correct shape and removes the engine-dependent risk. `PERF-A11Y-01` permanently asserts a list with listitems, `setsize` = the full history (2,000, not the mounted 37), positions contiguous across the mounted run, and — when the properties are absent — that the native control behaves identically, so the assertion can never silently become vacuous. |
| **W25** subagent row shrinks the scroller | FIXED | A shrinking `clientHeight` is now the same class of event as a growing document, and both are excused only for a reader who was already at the tail and did not move up. |
| **W11** auth expectation derived from the observation | FIXED | The cookie assertion now reads the run's CONFIGURATION (`CAW_INSECURE_COOKIES`, which `playwright.config.ts` sets exactly when WebKit is in the run) and requires, per mode: dev -> `caw_session` + `secure: false`; production -> `__Host-caw_session` + `secure: true`. `scripts/e2e-server.mjs` carries a comment saying the flag reaches that server only because `cleanParentEnv` is spread, so nobody "tidies" it away. |
| **W12 / W14 / W22** test honesty | FIXED | `revealRow` (walks, relocates the reader) is now separate from `assertRowInView` (no scrolling; asserts mounted AND inside the band); `waitForRow` remains as an alias for the walking one so existing reachability claims keep their meaning, and the scenarios whose premise is POSITION use the strict helper. `perf-scroll.spec.ts`'s `>= 0` is `> 0`. `perf-cost.spec.ts` counts `.transcript-entry` (plus a `spacers > 0` and a `rows < LARGE/10` bound) instead of `.messages-content > *`, which counted spacers. |
| **W29** untracked specs | CONFIRMED | The nine files named in the review are untracked and nothing tracked imports them (`perf-cost.spec.ts` imports only `fixture.js`). Not `git add`-ed, per the instruction. They must be added with the commit or the gates are green by absence. |

### Every "it was the test's fault" ended up being a real bug

Worth recording, because it is how this went: three times the gate looked like a bad
premise and was, and each time a real defect was underneath it.

1. `PERF-SCROLL-09` failing looked like a fixture problem. It was `updateTailLock` losing
   the tail when the document grew (§19).
2. `PERF-SCROLL-04`'s park never sticking looked like a gate problem. It was **two**:
   the `ResizeObserver` pinning unconditionally on a flag that could be one frame stale
   (so `scrollTop` writes were silently reverted), and the anchor correction giving up
   when the anchored row left the window, which a 4,460px expansion guarantees.
3. round50's reachability "middle lands near entry 5 of 2,000" looked like a threshold
   problem. It was `spacerHeights(offsets, { start: cursor, end: entries.length })`
   returning `total - total = 0`, i.e. no trailing spacer at all: the document collapsed
   to 2,158px and the tail was invisible (spacers `[154752, 154640]` after the fix).

## 21. What is still unknown, ranked

1. **The app's own share of the stall.** §3's mounted arm says 78,617 elements cost
   152 ms worst-case and 8,000 entries (313,916 elements) cost 793 ms worst-case; the
   probe that would have split "the history's layout" from "the history's node count"
   produced a wrong layout estimate and was discarded. A valid probe needs **measured**
   row heights, not a 120 px guess.
2. **Whether the owner's iPhone reproduces the same curve.** The Chromium curve is
   super-linear in node count; WebKit's is unmeasured at the sizes that matter because
   a mobile-WebKit gesture cannot be driven at flick velocity here.
3. **The blank-frame verdict.** The validated detector reports **0 blank frames** in
   every run it completed (11 % coverage on Chromium, and 29 samples over a 146 s WebKit
   gesture). That is not the same as "the
   screen never goes black": with the main thread held for 544–793 ms, an 11-sample
   series cannot observe every frame. The frame-gap series is the strong evidence; the
   pixel series is the corroboration that did not contradict it.
4. ~~The windowed implementation itself~~ — **built and measured**; see §12-15.
