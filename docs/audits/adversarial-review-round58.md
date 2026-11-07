# Adversarial review — round 58 (windowed transcript, tool activity, premium layer)

Read-only inspection of the uncommitted round-58 working tree. No source file was
edited. Method: `git status`/`git diff` on all 18 modified + 24 untracked paths, full
reads of `transcript-window.ts`, `MessageRow.tsx`, the composer and window wiring in
`ConversationView.tsx`, `tool-activity.ts`, `ToolActivity.tsx`, `premium.css`,
`tool-activity.css`, the touched CSS hunks, and every changed test assertion. Numeric
claims were recomputed in `node` rather than trusted (see evidence columns).

**Not run:** no build, no Playwright, no vitest, no `tsc`. No long CPU job. Line
numbers below are from this tree; `scroll-core`'s later changes to
`updateTailLock` / `.messages-scroll` padding / `round50-measure.spec.ts` were read
after they landed and are reflected.

Trust boundary is unchanged: nothing under `apps/server`, `packages/omp-adapter`,
`packages/runtime`, `packages/relay` was touched (area G confirmed and then dropped
as instructed).

---

## Findings

Severity: **blocker** = loses/duplicates content, silently wrong claim, or corrupts
the draft; **major** = reaches users with a real but bounded defect; **minor** =
latent / cosmetic / documentation.

| id | sev | area | file:line | failure scenario | evidence | recommended fix |
| --- | --- | --- | --- | --- | --- | --- |
| **W1** | **major** (downgraded from blocker — see "correction" below) | A — window geometry | `apps/web/src/components/MessageRow.tsx:783-797`, `apps/web/src/styles.css:786-794` (`.transcript-entries{gap:inherit}`) | `.transcript-entries` is a flex column with `gap: inherit` (10 px in Conversation, 8 px in AgentChat), and the spacers are flex children of it. Flex `gap` is additive between *rendered* siblings and is not part of any element's measured height, so the model (`buildOffsets`) never counts it. Every gap between two rendered items therefore adds `gap` px of document height the model does not have. Because a spacer is one item regardless of how many entries it stands for, the error is **bounded by the mounted item count, not the conversation size**: ~310 px for a 30-row window with no pins, ~1,330 px with 50 pinned segments, ~1,430 px with 20 pins. Consequence: `scrollTop = offsets[i]` overshoots by up to ~1.4 k px on a pinned-heavy list (the DOM is *taller* than the model, so the same offset lands slightly *earlier* in the document), and the scrollbar total is short by that amount. On a 4,075-entry, multi-million-pixel document that is a sub-0.1 % error, so a reveal still lands the hit on screen — hence **major**, not blocker. It does falsify the code's own claim (`MessageRow.tsx:296-300`) that landing is "exact, to the pixel". | `styles.css:786` is `display:flex` + `gap: inherit`; `MessageRow.tsx:785/797` emit spacers as siblings of the entries; `gap` never appears in `getBoundingClientRect().height`, so `ResizeObserver` cannot see it and `buildOffsets` (`transcript-window.ts:104-113`) never adds it. Recomputed item counts: 30 mounted/no pins → 32 items → 310 px; 32 mounted/50 pins → 134 items → 1,330 px. `transcript-window.test.ts:145` passes because it sums *heights*, not the DOM. | Set `.transcript-entries { gap: 0 }` and move inter-entry spacing into the cards' own margin (so the model and the DOM agree by construction), **or** add `(itemsInSegment-1)*gap` to each spacer's height. Add one browser assertion: after `scrollTop = offsets[i]`, the entry's `offsetTop - scrollTop` is 0 ± 1 px. |
| **W2** | **major** | C — composer draft | `apps/web/src/components/ConversationView.tsx:1563-1568` (`adoptElementValue`), `:369`/`:3461` (`composingRef`, unused by it), `:1525-1529` (send clears), `:1570-1579` (`updateDraft` bumps `sendVersionRef`, adoption does not) | `adoptElementValue` runs on `onInput` with **no authorship test** and treats "the DOM value differs from `inputValueRef`" as "the user typed it". It therefore (a) writes half-composed text to `inputValueRef`/`setInputText`/`onDraftChange` during IME composition — `composingRef` exists and is checked only in `onKeyDown` — and the parent persists it into `conversationDrafts` (`App.tsx:185-187`); (b) bypasses the side effects `updateDraft` performs, so `sendVersionRef` is not bumped and `sendError`/`interceptedCommand`/`recoveryCapacityNote` are not cleared — a stale `interceptedCommand` or send-error banner survives a keystroke that came in through `onInput` rather than `onChange`; and (c) is the only writer that can adopt a *stale* DOM value with no regard for whether a send is in flight, since the send's clear (`:1525-1529`) rewrites the ref before React commits, so for the window between the clear and the commit the ref and the DOM disagree and either side can win depending on event ordering. | `:1564` compares only against `inputValueRef`; no `isTrusted`, no `composingRef`, no `sendVersionRef`/`draftVersion` check, while `sendPrompt` already captures `draftVersion` at `:1468` and re-checks it at `:1525`. `composingRef` at `:369` is read **only** at `:3464`. | `onInput={(e) => { if (e.nativeEvent instanceof InputEvent && e.nativeEvent.isTrusted && !composingRef.current) adoptElementValue(e.currentTarget); }}` — and have `adoptElementValue` perform the same bookkeeping as `updateDraft` (bump `sendVersionRef`, clear the send-error/intercept state) so the two writers cannot diverge. Regression tests: a composition burst leaves `onDraftChange` untouched until `compositionend`; a send followed by a stale-DOM `input` leaves the draft empty. |
| **W3** | **major** | A — height estimate | `apps/web/src/transcript-window.ts:62-94, 77-93` | The backward pass propagates a *real* measurement to **all** unmeasured entries on the other side with no cap. One 5,000 px row (an expanded diff, or a single huge tool card measured before it was collapsed) at index 5 of an 8,000-entry list sets the estimate for every row above it to 5,000 px: model total **40,000,000 px**, past Chromium's 33,554,428 px maximum scroll height. Similarly the forward pass smears the newest heavy row over everything below it. At that size the browser clamps `scrollTop`, so the tail becomes unreachable by offset and the scrollbar saturates — the "huge estimated height" scenario the ticket names. | Simulated the exact functions in `node`: a single measured 5,000 px at index 5 of 8,000 yields `offsets[8000] = 4.0e7`; `slice(6).every(v => v === 5000)` is `true`. Realistic case with 30 rows × 900 px measured, rest default 92: total 7.2 M px (vs the real ~4.6 M), i.e. +57 %. | Clamp the propagated value: use `min(nearestMeasured, MAX_PROPAGATED_PX)` (e.g. 2× the median measured height) for *propagated* entries, and keep the true value only for the measured one. Also clamp the document: `buildOffsets` should stop accumulating past ~30 M px, or `estimateHeights` should cap the total. Add a unit test with one outlier. |
| **W4** | **major** | A — reachability under knock-on | `apps/web/src/components/MessageRow.tsx:444-451, 572-638` | The anchor correction runs on every commit and writes `element.scrollTop`. `captureAnchor` stores `anchorRef` from the scroll path only (coalesced to rAF). Two commits in a row with no intervening `scroll` event (e.g. a `measureVersion` bump followed by the segment change it causes) leave the anchor's `scrollTop` equal to the *pre-correction* value; the second effect then computes `scrolledSinceCapture` against a `scrollTop` **this component already changed**, re-applies the delta and overshoots. The correction converges only because `Math.abs(delta) < 0.5` early-returns — with W1's sub-0.1 % gap error and W3's inflated estimates the deltas are non-zero and the effect re-runs on four dependencies. Not content loss, but a visible jitter on any list whose estimate error is significant. | `:615-623` uses `anchor.scrollTop` captured on the scroll path; the branch at `:629` rewrites it **only when `\|delta\| >= 1`**, so a sub-pixel correction leaves a stale baseline that the next commit re-measures. The two-commit scenario is reachable from `:657` (`setMeasureVersion`) followed by `:638`'s dependency list. | After any correction, always rewrite `anchorRef.current` with the post-write `scrollTop` (not only inside the `>= 1` branch), and re-read the anchor at the start of the effect instead of trusting the scroll-path capture. |
| **W5** | **major** | A — pinned/`revealRef` lifecycle | `apps/web/src/components/MessageRow.tsx:381, 672, 713-718` | `revealRef.current` is **never cleared** except by the next reveal. After a search hit inside a group, that group's `ActivityGroupRow` receives `revealMemberId` forever, so if the user collapses it, `revealedFor` (ToolActivity.tsx:474-478) still equals the id and the `setOpen(true)` block never runs again — fine — but any *remount* of that entry (scrolled out and back, or the W4 correction churn) creates a fresh `ActivityGroupRow`, which auto-opens again. Worse: closing search (`:3072`) clears the query and `matchIndex` but not `revealRef`, so the auto-open persists after search is closed — the ticket's "does closing search leave the reveal stuck" question, answered yes for remounts. | `revealRef.current = identity` at `:672`; no other write; the close button at `:3072` sets `showSearch`/`transcriptQuery`/`matchIndex` only. `ToolActivity.tsx:475` re-fires on every new component instance. | Clear `revealRef.current = null` in the jump effect after the scroll lands (`:706`), and add a list API `clearReveal()` that the search close/Escape path calls. |
| **W6** | **major** | B — search reveal completeness | `apps/web/src/components/MessageRow.tsx:684-702`, `apps/web/src/components/ConversationView.tsx:3171 (saved list)` | The saved-history `TranscriptList` at `:3171` gets `scrollElement` + `apiRef` but **no `pinnedIdentities`** — acceptable — however it also has **no `pin` for the jump identity across mounts**, and `revealRef` is shared with the live list. Since both lists mount the *same* `transcriptApiRef` (only one is rendered at a time, so no live conflict), but a jump issued while saved mode renders sets `revealRef` on the saved list; switching back to live leaves `revealRef` pointing at a saved-mode id that the live list will never contain, so `renderEntry`'s `some(row => row.id === reveal)` is permanently false — harmless — while W5's never-cleared state keeps a stale auto-open armed. Also `searchTranscript` is computed from `messages`, which in saved mode is **not** the rendered `savedRows` (`:763`): searching a saved transcript searches the live array, so in saved mode the result count and the hit list describe a different document than the one on screen. | `ConversationView.tsx:3169` renders `rows={savedRows}`; `:1052` `searchTranscript(messages, transcriptQuery)` — `messages` is the live memo at `:674`. The search input is rendered unconditionally (`:3017`), including in saved mode. | Search the *rendered* source: `searchTranscript(isShowingSavedHistory ? savedRows : messages, query)`, and reset `revealRef` on the same conversation/mode switch that already resets `showSearch`. |
| **W7** | **major** | D — grouping honesty (metric vs. green) | `apps/web/src/tool-activity.ts:391` | `groupEvidence` keeps the first *worst* test summary but `continue`s once `test.failed > 0`; combined with `groupSummary` (`:441-445`) the metric can print `3 failed \| 15 passed` while `groupState` escalates to `failed` — correct — **but** the reverse case is reachable: a group whose *last* member is a clean run after a failing one keeps `failed > 0` (the `continue` prevents overwrite), so metric and state agree. The real hole is `state` vs. the *wire* flag: `groupState` checks `evidence.running`, `evidence.failed`, `test.failed` — but `ActivityGroupRow` renders `failed` text only when `state === "failed"`, while a group that is `failed` purely from a **summary** finds no row with `isError === true` (`:485`), so `failed === undefined` and the failure text is never surfaced with the card collapsed. The metric still says `3 failed`, so it is honest, but the *evidence* (which test failed) is one tap away while the file header at `:443-446` claims "A failing member's own text is surfaced under the head without a tap". | `ToolActivity.tsx:485` `members.find(row => row.isError === true)`; `tool-activity.ts:420` escalates on `evidence.test.failed` with no `isError` row. | When `state === "failed"` and no `isError` row exists, fall back to the member whose `testSummaryOf` reported the failure (or the excerpt line) for the preview. |
| **W8** | **major** | E — premium CSS reach | `apps/web/src/premium.css:313` (`body .message-content:not(pre)`) | `.message-content` is used by `MessageRow` (transcript), `ConversationView`'s streaming card, **and** `AdvisorMessageCard` (`MessageRow.tsx:69`). The rule is unscoped by screen, so it also applies inside Files/Agent Detail surfaces that render transcript rows (`AgentChat` → `MessageRow`). Line-height change only — no control hidden, no tap target shrunk — but the file claims it owns only the conversation column, and this selector does not. | `grep -rl "message-content"` → `ConversationView.tsx`, `MessageRow.tsx` only, but `MessageRow` is rendered by `AgentChat` (`:303`) and `HistoryView`. | Scope it to `body .conversation-column .message-content:not(pre)`, matching the discipline the rest of the file states. |
| **W9** | minor | E — premium CSS specificity claim vs. reality | `apps/web/src/premium.css:196-237` vs `apps/web/src/styles.css:672-687` | The file states every winning rule carries `body` so order does not matter. The banner rules do carry `body` (0,3,1) and do beat `.banner.warning` (0,2,0) — verified. But `body .conversation-column .banner.idle` uses `--primary-action` for the tint and `--primary` for the ink; recomputed 10 %-tint contrast is **6.37:1** (claim: 6.35) — fine. However `body .conversation-column .banner` at `:196` sets `border-bottom: 0` for **every** banner, including `.notice-banner--info` which `NoticeRow` renders *without* `.banner` — no overlap. No defect; recorded because the contrast numbers in the file are otherwise exact (danger-tint claim 7.02 recomputed 7.00 with the real `--danger` tint token, 6.70 with the literal `--danger-text` tint — the comment names the wrong token but the number is the right one). | Recomputed all six pairs in `node`: 18.69 ✓, 6.38 ✓, 7.35 ✓, 5.67 ✓, 16.60 ✓, warning 8.18 vs 8.19, danger 7.00 vs 7.02, neutral 7.37, primary 6.19/6.37 vs 6.35, success 8.02 vs 8.03. All within rounding. | Fix the comment, not the CSS. |
| **W10** | minor | E — premium CSS miss | `apps/web/src/premium.css:374-379` | `body button.notice-toggle` is listed in the 44 px block *and* separately at `:297`; the duplicate is harmless. But `.conversation-column :focus-visible` (`:125`) is the only `:focus-visible` rule in the app for the conversation column and it **overrides nothing** — it sets `outline` on top of `input:focus { outline: none }` (styles.css:607). That is the intended fix, but it is written without `body`, so `styles.css`'s `input:focus, textarea:focus { outline: none }` (0,1,1 with pseudo-class counting as a class → 0,1,1) vs `.conversation-column :focus-visible` (0,2,1) — the premium rule wins on specificity, not order. OK, but it is the one place the file's own stated rule ("one extra class, usually `body`") is not followed. | `premium.css:125`; `styles.css:607-610`. | Add `body` for consistency. |
| **W11** | minor | F — test weakened | `tests/e2e/auth.spec.ts:61` | `expect(session!.secure).toBe(true)` became `expect(session!.secure).toBe(session!.name === COOKIE_NAME)`. In a Chromium-only run the name is always `__Host-caw_session`, so the assertion is *equivalent* — but in the WebKit run it accepts `secure === false` on `caw_session`, and nothing asserts that the app under test is actually in the intended mode. A regression that silently fell back to insecure cookies in a **Chromium** run would produce `caw_session` + `secure:false` and this spec would pass, because it derives the expectation from the observed name rather than from the run's configuration. | diff at `auth.spec.ts:48-61`; `playwright.config.ts:117` sets `CAW_INSECURE_COOKIES` only when WebKit is in the run, but the spec reads it from the cookie jar, not the config. | Assert against a run-mode fact the spec can read (`process.env.CAW_INSECURE_COOKIES` or a capability from `/api/capabilities`), not against the observed cookie name. Verdict: **adaptation, but under-gated.** |
| **W12** | minor | F — harness `waitForRow` walks instead of proving mount | `tests/e2e/perf-scroll-harness.ts:96-200` | The helper now scrolls the *entire* document to find a row, then `scrollIntoView`s it. Every caller therefore proves "the row exists somewhere reachable by a full walk", not "the row is where the scenario expects". It also **relocates the reader** — the doc comment at `:613-620` explicitly says measurement that moves what it measures is not measurement, and `waitForRow` does exactly that. Calls used as setup (`perf-scroll-gates.spec.ts:78`, `:783`) change the scroll position the test then measures from. Not a lie, but the gate is weaker than its name: a window that fails to mount the tail on open still passes because the walk finds it. | `:181-191` loops `scrollTop += 2*clientHeight` to `scrollHeight`; `:188` `hit.scrollIntoView`. | Keep the walk only for the reachability gates, and give the setup path a separate `waitForDeclared` (the `aria-setsize` check already in `perf-cost.spec.ts:89`) that does not move the viewport. |
| **W13** | minor | F — budget gates skip | `tests/e2e/perf-scroll-gates.spec.ts:57-61`, `:478`, `:556`, `:682` | `skipIfOverBudget` turns an over-budget measurement into `test.skip`, i.e. a green run. The header at `:12-14` states this policy deliberately and the number is printed — so it is declared, not hidden. Still: the only *timing* gates in the suite can never fail the build. | `:57-59`; three call sites. | Leave as-is if the policy is the owner's; otherwise assert instead of skip and let CI mark it flaky. Verdict: **declared policy, not a weakening introduced this round.** |
| **W14** | minor | F — `expect(x).toBeGreaterThanOrEqual(0)` | `tests/e2e/perf-scroll.spec.ts:203` | `finalState.top` is `-1` only when the scroller is missing, so `>= 0` is very nearly vacuous; the message says "the flick train must have moved the transcript" but does not assert movement. Preceded at `:204` by a real assertion on non-null samples, so the test is not vacuous overall. | as cited. | Assert `toBeGreaterThan(0)` or drop the line. |
| **W15** | minor | A — `aria-*` on a wrapper that is not a listitem box | `apps/web/src/components/MessageRow.tsx:723-748`, `apps/web/src/styles.css:796-798` | The wrapper is `role="listitem"` + `display: contents`. `display: contents` removes the element's box from the tree, and Chromium historically drops `role`/`aria-*` on such elements from the accessibility tree (the a11y tree matches the *unboxed* element out of the tree in some versions). jsdom cannot test this. If the role is dropped, the `aria-setsize`/`aria-posinset` are also dropped, and a screen reader sees a `role="list"` whose only children are *text/card nodes*, with spacers `aria-hidden` — so it announces no list items at all rather than "item 42 of 4075". Neither outcome was proven here (needs a browser a11y-tree read). | `styles.css:797` `display: contents`; the test at `tests/web/transcript-window-component.test.tsx:54-63` reads the *attribute*, not the computed a11y tree. | Move `role="listitem"`/`aria-posinset`/`aria-setsize` onto the card element itself (the first child) and keep the wrapper a bare `display: contents` div; or drop `role="list"`/`listitem` and expose the count in an `aria-label` on the region. Verify with a real a11y-tree dump. |
| **W16** | minor | A — focus pin discovered late | `apps/web/src/components/MessageRow.tsx:405-409, 512-533` | The pin set is derived during render from `elementsRef` + `document.activeElement`. Focus that arrives **programmatically in the same commit as a scroll** (a search jump, or `composerRef.focus()` after a recovery at `ConversationView.tsx:1599`) is not yet in `document.activeElement` when the render that drops the entry runs, and `captureAnchor(withDiscovery)` is only called from the scroll rAF and from the correction itself — never on a focus event. So a row can be unmounted while holding focus → focus falls to `body`. The window is commit-order dependent, so it is a latent rather than a reproduced defect. | No `focusin`/`focusout` listener anywhere in the file (`grep -n "onFocus\|focusin"` → none). | Add a `focusin` listener on the scroller that calls `captureAnchorRef.current?.(true)` (cheap, coalesced) so focus is discovered before the next window commit. |
| **W17** | minor | A — inert `spacerHeights` + unused `stickyKeysRef` residue | `apps/web/src/transcript-window.ts:186-192`, `apps/web/src/components/MessageRow.tsx:360, 522-528` | `spacerHeights` is exported and unit-tested but **never used by the component** (the component re-derives gap/trailing inline at `:784/:796`), so the tested function and the shipped arithmetic are two implementations — and the tested one is right about `top/end` while the shipped one differs in shape. `stickyKeysRef` is written and read only inside `captureAnchor`, and the "discovered" value is discarded (`void discovered` at `:532`), so it is dead state that costs a `Set` per frame. The `void 0;` at `:417` is a vestigial statement. | `grep -rn spacerHeights apps/web/src` → definition only; `stickyKeysRef` → `:360,523,525`; `:417` `void 0;`. | Delete `spacerHeights` or use it; delete `stickyKeysRef` and the `void 0`. |
| **W18** | minor | B — search cost per keystroke | `apps/web/src/components/ConversationView.tsx:1052`, `apps/web/src/transcript-window.ts:237-292` | `searchTranscript` runs synchronously in a `useMemo` on every keystroke, over the whole transcript, and `searchableLines` allocates a fresh `string[]` from `text.split("\n")` **plus** re-splits every text block for every message, every keystroke. Measured cost on a 96 MB / 8,000-message heavy transcript: **77 ms per keystroke** in plain `node` — on a throttled phone this is a visible input stall, and it is the same main thread the window exists to protect. | `node` benchmark replicating the function: 76.9 ms/keystroke at 96.2 M chars. | Debounce (~150 ms), and pre-split per message into a cached lowercase index (`WeakMap<message, string[]>`) so a keystroke is `indexOf` over cached strings. |
| **W19** | minor | B — search UI semantics | `apps/web/src/components/ConversationView.tsx:3019-3076` | The previous/next/close `<button>`s are **inside** the `<label className="transcript-search-field">` (`<label>` closes at `:3076`). A `<label>` wrapping buttons makes clicking a button also forward activation to the labelled control, and it is invalid content model (label may contain only phrasing content, no interactive descendants other than the labelled control). The accessible name of "Close transcript search" is at risk of being overwritten by the label's text in some AT. | `:3019` `<label …>` … `:3072` close button … `:3076` `</label>`. | Close the `<label>` immediately after the `<input>`; make the actions a sibling `div`. |
| **W20** | minor | C — draft contract: IME | `apps/web/src/components/ConversationView.tsx:1563-1568`, `:3461-3462` | `adoptElementValue` runs during composition (Safari/Chrome dispatch `input` with `isComposing: true`), writing half-composed text to `inputValueRef`, `setInputText` and — worst — `onDraftChange`, which the parent persists into `conversationDrafts`. React will then re-apply that half-composed value as `value`, which is exactly the known way to break an IME (candidate window resets). `composingRef` exists but is checked only in `onKeyDown`. | `:3461` sets `composingRef`; `:3453` `onInput` never reads it. | Same guard as W2: skip adoption while `composingRef.current`. |
| **W21** | minor | D — group label pluralisation on count 0 | `apps/web/src/tool-activity.ts:491-506` | `categoryLabel` with `count === 0` produces `Run 0 commands` etc. Reachable? `splitByCategory` never creates an empty group, and `toolMembers` excludes echoes, so a group of only echoes yields `toolCalls === 0` → `Run 0 tools`. An assistant echo run with no tool results at all cannot be a group (echoes can't open one, `:183`), so this needs an echo *joined to* a group whose only tool row was dropped — not reachable today. | `:491-506`, `:164-166`, `:183`. | No action; noted as tested-unreachable. |
| **W22** | minor | F — test weakening | `tests/e2e/perf-cost.spec.ts:207` | `expect(dom.declaredEntries).toBe(LARGE)` — `declaredEntries` is `Number(...aria-setsize ?? NaN) \|\| null` — `null` when the query misses. `toBe(LARGE)` then fails, which is correct. But `dom.rows` counts `.messages-content > *`, which after windowing includes **spacer divs**, so `rows > 0` is satisfied by a spacer alone. The meaningful claim (`elements < 20_000`) still holds, so this is a weak line, not a hole. | `:164-175`, `:205-208`. | Count `.transcript-entry` instead. |
| **W23** | minor | F — `round57-performance.test.tsx:78-99` | renamed describe only | The `TranscriptList` DOM-bound test was renamed and the `render` call left without a `scrollElement`, which keeps the old (unwindowed) contract — legitimate, and the window's own bounds are covered in the new file. Verdict: **adaptation.** | diff shows only the describe title + comment changed; body identical. | none |
| **W24** | minor | F — `tool-activity-fidelity.test.tsx:389` | class rename `tv-note--err` → `tv-diag-note--err` | Matches the component rename (`ToolActivity.tsx:143, 207`) and the new `tool-activity.css:280-288`. Verdict: **adaptation, correctly accompanied by the CSS move.** The old `.tv-note`/`.tv-note--err` rules in `styles.css` were deleted, but the guest renderer still emits `.tv-note` (`packages/guest/src/tool-render/parts.tsx:310`, `ToolErrorBoundary.tsx:39`) and `tool-render.css:514-536` styles it — so nothing is lost. Verified by search. | `git show HEAD:apps/web/src/styles.css \| grep tv-note` → present; now absent from web CSS, present in guest CSS. | none |
| **W25** | minor | D/E — `SubagentActivityRow` placement | `apps/web/src/components/ConversationView.tsx:2832-2835` | The row is rendered between the dashboard and the refusal summary, unconditionally in the column flow — so when a subagent starts, the transcript's height changes by ~45 px while the reader may be scrolled up. `.messages-scroll` is `flex: 1 1 0` above it, so its client height shrinks; combined with `followTailRef` logic this is one more growth/shrink source the tail heuristic must excuse. Not reproduced; flagged for the tail work. | `:2832`; `updateTailLock` at `:1071` excuses only *height growth*, not a **viewport shrink** from a sibling appearing. | Include the row *inside* the scroller's content, or let `updateTailLock` treat a clientHeight change as authorship-neutral. |
| **W26** | minor | A — `aria-busy` never clears in a stuck measurement | `apps/web/src/components/MessageRow.tsx:755-764` | `busy` is computed from `measuredRef` over the mounted segments. A mounted entry whose measured height is exactly `0` is **rejected** by `estimateHeights` (`value > 0`, `:73`) but **stored** by the ResizeObserver (`:654`, no `> 0` filter) — so `measuredRef.has(key)` becomes true, `busy` clears, and the entry keeps its neighbour's estimate forever while rendering at 0 px (a `display: contents` group head with no content, or an entry whose child is `aria-hidden`). That entry then occupies model height it does not have, and its row is invisible. This is the ticket's "measured height is 0" case, and the two sides disagree about whether 0 is a measurement. | `:73` rejects `<= 0`; `:654` accepts any value; `:760` tests `has()` only. | Use one predicate: skip storing `height <= 0.5`, or `delete` the key so `has()` is false and the entry stays "unmeasured". |
| **W27** | minor | E — `premium.css` load order claim | `apps/web/src/main.tsx:4-7` | The comment says the file is written so it "never depends on being last in the bundle"; the header says the same. Most rules do carry `body` and win on specificity. Exceptions found: `.conversation-column :focus-visible` (`:125`, discussed in W10), `.notice-banner .notice-text` (`:271`), `.notice-row .notice-banner` (`:279`) — the last two are additions with no competitor, so they are safe, but the *claim* is not uniformly true. | grep of `premium.css` for rules not prefixed by `body`: `:125`, `:271`, `:279`. | Reword the comment, or prefix them. |
| **W28** | minor | A — segments/spacers exactness (proved) | `apps/web/src/transcript-window.ts:309-347`, `MessageRow.tsx:781-797` | Tried to construct duplicate observable content: a pin that overlaps the visible range (guarded at `:320`), a pin adjacent to it (`:321-335` merge), two pins that merge (`:327-334`, `:339-345`), an out-of-range pin (`:318`), a `NaN` pin (`:318` `Number.isInteger`), and a pin at `end` (`:321` `index === range.end`). In every case the returned ranges are sorted, disjoint and half-open, and `cursor`/`offsets[cursor]` produce exactly complementary spacers — **no duplicate, no gap, no double-counted pin**. The `aria-posinset` is the entry index, so a duplicate would be visible; none exists. The only geometry defect is the flex `gap` (W1), which is not in the model at all. | `node`-replicated `computeSegments` for the pinned/adjacent/merged/out-of-range cases; the shipped unit test at `tests/web/transcript-window.test.ts:110-142` covers the same set. | none — this part is correct. |
| **W29** | info | F — `perf-scroll-harness.ts` is **not in HEAD** | `tests/e2e/perf-scroll-harness.ts`, `perf-scroll.spec.ts`, `perf-scroll-gates.spec.ts`, `premium-visual.spec.ts`, `perf-fixtures.ts` is tracked | The harness and the two main scroll specs are **new untracked files**. `perf-cost.spec.ts` (tracked) imports nothing from the harness, so nothing tracked breaks; but the round's headline gates (`PERF-SCROLL-01..09`) only exist in the working tree and will not run in CI until added. `perf-fixtures.ts` is tracked and unchanged. | `git cat-file -e HEAD:tests/e2e/perf-scroll-harness.ts` → missing; `perf-cost.spec.ts` tracked. | `git add` them with the change, or the gates are green by absence. |
| **W30** | info | E — dead CSS after the move | `apps/web/src/styles.css:1481` `.tool-output-preview`; `apps/web/src/tool-activity.css:375-376` | `.tool-output-preview`'s base rule stayed in `styles.css` while its contextual rules moved — a split the header of `tool-activity.css` says was consolidated. Harmless (both files ship), but the "styles moved out" claim is partial. `.tool-diff-block` was deleted with no remaining emitter — `grep -rn tool-diff-block` finds nothing in app or guest source. | `python` diff of every class in `HEAD:styles.css` against the four current CSS files: only `.tool-diff-block` and `.tv-note--err` disappear, and both are accounted for above. | Delete `.tool-diff-block`'s former rule (already gone) — nothing to do; optionally move `.tool-output-preview` too. |

---

## A — Windowed list correctness: what was proved, what was not

**Proved by construction (no browser needed):**

- `computeSegments` produces sorted, disjoint, half-open ranges for: a pin below the
  visible range, a pin touching `end`, a pin touching `start-1`, two pins that merge
  through a third, pins on both sides, out-of-range pins, `NaN`, negative and
  non-integer pins. No entry can be mounted twice (`.transcript-entry` keys are the
  entry keys, and `computeSegments` never returns overlapping ranges). No entry can
  be covered by two spacers: `cursor` is monotone and every spacer is
  `offsets[start] - offsets[cursor]`.
- `indexAtOffset` is a correct last-≤-binary-search with clamping at both ends.
- `estimateHeights` cannot produce `NaN` unless `fallback[index]` is missing *and*
  `FALLBACK_ROW_PX` were removed; with the shipped constants every element is a
  finite number (checked: `some(Number.isNaN) === false` for an all-unmeasured
  8,000-entry list, total 736,000 px).
- `spacerHeights` is arithmetically exact — but unused (W17).

**Not proved / defective:**

- **W1** (flex `gap` is invisible to the model) is the round's only geometry defect that
  the model cannot see: the rendered document is taller than `offsets[]` by
  `(renderedItems - 1) × gap`, a **bounded** ~310 px on a 30-row window and ~1.4 k px on
  a pinned-heavy one. It does **not** lose a message (segments still mount it) and it
  does not scale with the conversation, so a reveal still lands on screen; it falsifies
  the implementation's central claim — "`scrollTop = offsets[i]` places entry *i* at the
  top, exactly" (`MessageRow.tsx:297-300`) — and skews the scrollbar by that fixed
  amount. My first draft claimed ~40,000 px; that was wrong, because a spacer is one
  flex item no matter how many entries it stands for. Corrected above.
- **W3** (uncapped propagation) can push the document past the browser's maximum
  scroll height, at which point offsets stop being reachable by assignment.
- **W4** (anchor baseline rewritten only on large deltas) gives a two-commit
  overshoot; **W5/W6** (reveal state) leak across search-close and across
  live/saved mode.
- **W15** (`display: contents` + `role="listitem"`) needs an a11y-tree check in a
  real browser; it cannot be settled in jsdom.
- **W16** (focus discovered after the commit that drops the row) is latent.

**Re-render loops:** the fix is structural, not a patch. `captureAnchor(false)` skips
discovery, the correction effect publishes **no** state (`MessageRow.tsx:631-634` is
a comment explaining exactly this), and the `setViewport` in the jump effect is
guarded by an equality check that returns `previous`. I could not construct a cycle
through `measureVersion` → effects: `setMeasureVersion` only fires from inside a
`ResizeObserver` callback and only when a height actually changed by ≥ 0.5 px, and
the observer set is rebuilt from the mounted set, not from heights. So React #185 is
genuinely fixed by structure. The residual risk is W4's write-per-commit, which can
oscillate but converges (it must, since `scrollTop += delta` with `delta` measured
after the write is a contraction when the estimate is stable).

## B — In-app search: proved / not

- Searches `messages`, the complete array, never the DOM — so a row that is not
  mounted is still found. Unit-proved (`transcript-window.test.ts:176-212`,
  including the 10,000-message last-hit case).
- The hit is always mounted after the jump: `pinned` includes `jump.identity` in the
  same render that sets `jump`, and `computeSegments` unions it. Component-proved.
- **W6**: in **saved mode** the search input is rendered but searches the live array.
- **W5**: closing search does not clear `revealRef`, so a group auto-opens again on
  remount.
- `revealMemberId` does force the group open (`ToolActivity.tsx:475-478`) and does
  work for a hit that is a tool *result* inside a group, because `group.rows`
  includes tool rows and echoes alike. It does **not** open the *member* `ToolRow`
  itself, so a hit inside a collapsed tool result's own body still needs one more
  tap — the contract says "one tap", so this is consistent with it, but the row is
  not literally readable after the reveal, only mounted-and-expanded-to-one-level.
- A conversation switch resets `showSearch`/`transcriptQuery`/`matchIndex` in both
  switch paths (`:1136-1141`, `:1359-1364`). It does not reset `revealRef` (W5).

## C — Composer `adoptElementValue`

Draft contract: `onChange` → `updateDraft` bumps `sendVersionRef`, writes the ref,
state and `onDraftChange`; `onInput` → `adoptElementValue` does the same *without*
bumping `sendVersionRef` and without clearing `sendError`/`interceptedCommand`.
Three consequences, all real:

1. **W20** — it runs during IME composition, writing half-composed text into the
   parent's draft map and back into `value`. `composingRef` exists and is not used.
2. **W2** — it treats "the DOM holds something the ref does not" as "the user typed
   it", with no authorship discriminator. A queued or re-applied `input` event after
   `setInputText("")` re-fills the draft the send cleared, and `onDraftChange` then
   persists it in `App.tsx:186`.
3. It does **not** fight `updateDraft`: React dispatches `onInput` before `onChange`
   for the same native event, and both write the same value, so the double write is
   idempotent. It also does not fight the `draft`→state effect (`:1102-1105`), which
   only runs when the parent's `draft` identity changes.

Not reproduced: the exact ordering that resurrects text needs a real browser, so W2
is argued from the code (no `isTrusted`, no composition guard, no send-version
guard) rather than measured. The recommended guard is one condition and removes both
W2 and W20.

## D — Tool grouping honesty

- A group whose metric says `N failed` **cannot** render green: `groupState`
  (`:417-422`) reads the same `evidence.test` the metric does, and the CSS
  (`.activity-group--failed`) is keyed on that state. Proved by test
  (`tool-activity-hierarchy.spec.ts` new case) and by construction.
- `stateWord` is in the `aria-label` (`ToolActivity.tsx:495-502, 509`) and the glyph
  is `aria-hidden`. Interaction/label parity holds.
- No card can claim "tests passed" without a runner summary: `metric` is `null` when
  `evidence.test === null`, and the parser (`:281-296`) requires a whole-line anchor
  plus a structural total. Documented ceiling: a `cat` of an old log still matches —
  declared in the header, and the metric is worded as a count.
- Expansion is lossless vs. the ungrouped rows: `flattenActivity(groupActivity(rows))`
  is `rows` (echoes carried, never dropped). **W7** is the one honesty gap: a
  summary-proven failure with no `isError` row surfaces the metric but not the
  failing text under the collapsed head, contradicting the component's own comment.

## E — Premium CSS scope

Checked every selector in `premium.css` against the screens it does not own:

| selector | reaches | verdict |
| --- | --- | --- |
| `body .conversation-column > .app-header` | conversation only (header is a direct child, `ConversationView.tsx:2568-2571`) | safe |
| `body .conversation-header-copy h3`, `.header-status*` | conversation only | safe |
| `body .composer-container`, `.composer-input` | conversation only (`canWriteToHost` gate) | safe |
| `.conversation-column :focus-visible` | conversation column subtree | safe, but unprefixed (W10/W27) |
| `body .dashboard-row`, `body button.dashboard-card` | `DashboardCards.tsx` only, rendered only in the conversation column | safe |
| `body .conversation-column .banner*` | conversation column only; `.banner` also used by `linkFailure`/`sendError` banners **inside** the column, intended | safe |
| `body button.notice-toggle`, `.notice-banner`, `.notice-row` | `NoticeRow` is rendered only in the conversation column (`ConversationView.tsx:3168`) | safe |
| `body .message-content:not(pre)` | **transcript rows generally**, including `AgentChat`/`HistoryView` | **W8 — too broad** |
| `body .message-card.user`, `body button.recovery-summary`, `body .latest-button`, `body .header-menu`, `body .handoff-reason` | conversation only | safe |
| `body .modal-content` | every modal in the app (ActivityPanel, AdvisorPanel, FolderBrowser, ProjectsView, RecoverySheet) | shadow only — adds elevation to modals on other screens. Cosmetic; flagged, not a defect. |
| `body button.empty-state-action`, `body .sync-stall-strip button`, `body .advisor-card-head`, `body .advisor-note-head` | shared components; `min-height: 44px` only | safe (raises below-floor targets) |

No `!important` anywhere in `premium.css` or `tool-activity.css` (verified by `grep -c`:
0). No rule sets `display:none`, `visibility`, or `opacity` (verified). No rule reduces
a control below 44 px; the file only raises. The load-order claim is *mostly* true
(W27 lists the three unprefixed rules).

## F — Tests that lie: before/after verdicts

| test | change | verdict |
| --- | --- | --- |
| `perf-cost.spec.ts` `waitForRows` | counted `.messages-content > *` ≥ 4075 → reads `aria-setsize` | **Adaptation.** The old wait literally required the full mount the change removes; the new one still fails if the snapshot never arrives (`declared === 0` falls back to the old count). Not weakened. |
| `perf-cost.spec.ts:205-208` | `rows > LARGE/2` → `elements < 20_000` + `rows > 0` + `declaredEntries === LARGE` | **Adaptation.** Replaces an assumption the owner overruled with the new contract, and the new assertions are strictly harder to satisfy accidentally than `rows > 0` alone (W22 notes `rows` counts spacers). |
| `perf-cost.spec.ts` removed `expect.poll(...card, .activity-group).count() > 100` | deleted | **Neutral.** That poll asserted the old mount model; nothing replaces it, but `declaredEntries` covers arrival. |
| `round57-performance.test.tsx:78` | describe renamed, `render` unchanged | **Adaptation** (renamed to say what it now proves). |
| `tool-activity-fidelity.test.tsx:389` | `.tv-note--err` → `.tv-diag-note--err` | **Adaptation**, matching a real rename with the CSS moved alongside. |
| `auth.spec.ts:61` | `secure === true` → `secure === (name === COOKIE_NAME)` | **Adaptation, under-gated** (W11): derives the rule from the observed fact. |
| `playwright.config.ts:117` | adds `CAW_INSECURE_COOKIES` when WebKit is in the run | **Legitimate**, and correctly conditional; server refuses the flag unless host is loopback (`config.ts:151`). But `scripts/e2e-server.mjs:238` builds its own `env` object and **does not forward `CAW_INSECURE_COOKIES`** — it spreads `cleanParentEnv`, which does contain it, so it is forwarded by accident of construction. Worth a comment/test rather than a change. |
| `perf-scroll-harness.ts` `waitForRow` | mount check → full-document walk + `scrollIntoView` | **Weakened in one dimension, strengthened in another** (W12): proves reachability, stops proving position, and moves the viewport. |
| `perf-scroll-gates.spec.ts` budgets | `skipIfOverBudget` at three sites | **Declared policy** (`:12-14`), not introduced to go green this round. |
| `perf-scroll.spec.ts:203` | `expect(top).toBeGreaterThanOrEqual(0)` | **Weak** (W14), nearly vacuous, but the adjacent line carries the real assertion. |
| `round50-measure.spec.ts` | rewritten by `scroll-core` while this review ran | Read after rewrite: asserts bounded DOM, declared total and first/last reachability via `aria-posinset` (`:380`, `:386`), which is a stronger gate than the old mount count. **Adaptation.** |

## G — Session/lifecycle safety

Confirmed untouched (then dropped per instruction): `git status --porcelain -- apps/server packages/`
returns empty. Nothing under `apps/server`, `packages/omp-adapter`, `packages/runtime`
or `packages/relay` changed.

---

## Blockers and majors (triage list)

*Correction, stated plainly:* my first pass called **W1** a blocker on the theory that
each *unmounted* entry contributed a 10 px gap (~40,000 px on the fixture). That was
wrong — flex `gap` only spans **rendered** items, and one spacer stands for an arbitrary
number of unmounted entries, so the discrepancy is bounded at ~310–1,430 px. It is real
and it falsifies the "exact to the pixel" claim, but it does not lose or duplicate a
message and does not scale with history. Downgraded to **major**. Likewise my first
mechanism for **W2** (a programmatic `value` write dispatching an `input` event) was
wrong: browsers do not fire `input` for scripted value assignment. The defect is real
via a different route (no `isTrusted`/composition/`sendVersion` guard, and it bypasses
`updateDraft`'s state clears), so it stays **major**, not blocker. **No blocker survived
re-derivation.** Both errors are recorded rather than quietly edited out.

**Majors**

1. **W2** — `adoptElementValue` has no authorship test: it writes IME half-composition
   into `inputValueRef`/`inputText`/`onDraftChange` (so the parent's `conversationDrafts`
   stores it), and it skips `updateDraft`'s bookkeeping (no `sendVersionRef` bump, no
   `sendError`/`interceptedCommand` clear). `ConversationView.tsx:1563-1568`;
   `composingRef` unused there (`:369` vs `:3464`).
2. **W3** — one large measurement smears over every unmeasured neighbour with no cap;
   a single 5,000 px row at index 5 of 8,000 yields a **40 M px** model, past Chromium's
   33.55 M px maximum scroll height, at which point offsets are no longer addressable.
   `transcript-window.ts:77-93`. Reproduce-only cost: a unit test pins it.
3. **W1** — flex `gap` absent from the model (bounded ~310–1,430 px). `MessageRow.tsx:783-797`
   + `styles.css:786-794`.
4. **W4** — anchor baseline rewritten only when `\|delta\| ≥ 1`, so a sub-pixel correction
   leaves a stale baseline that the next commit re-applies (jitter, not loss).
5. **W5** — `revealRef` is never cleared: a searched group re-opens by itself after
   remount, and stays armed after search is closed.
6. **W6** — in saved-history mode the search box searches the **live** array while the
   list renders `savedRows`; the hit list describes a different document.
7. **W7** — a group failed only by runner output shows `3 failed` in the metric but no
   failing text under the collapsed head, contradicting `ToolActivity.tsx:443-446`.
8. **W8** — `body .message-content:not(pre)` leaks into AgentChat/HistoryView transcripts;
   the file claims the conversation column is its only surface.

Minors, in brief: **W10/W27** premium specificity/comment drift; **W11** cookie assertion
derives its expectation from the observed cookie; **W12** `waitForRow` relocates the
reader; **W13** three timing gates can only skip; **W14** a near-vacuous position
assertion; **W15** `role="listitem"` on a `display: contents` wrapper (needs a real
a11y-tree check); **W16** no `focusin` discovery; **W17** unused `spacerHeights` + dead
`stickyKeysRef`/`void 0`; **W18** 77 ms of search work per keystroke on a heavy
transcript; **W19** buttons nested inside a `<label>`; **W20** composer writes during IME
composition; **W22** `rows` counts spacer divs; **W25** the subagent row appears/disappears
above a `flex:1` scroller, a shrink the tail heuristic does not excuse; **W26** a 0-height
measurement is accepted by the observer but rejected by the estimator, so `aria-busy`
clears on an entry that is invisible; **W29** the harness and the two headline scroll
specs are untracked, so CI cannot run them.
