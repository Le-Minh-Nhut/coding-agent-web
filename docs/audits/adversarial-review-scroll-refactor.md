# Adversarial Review: Scroll-Ownership Refactor

**Date**: 2026-11-07  
**Scope**: Scroll-ownership refactor (`c4b203b`, `428a92d`, `0c94ea6`, `9096455`, `3476601`), including `ScrollController`, `ConversationView`, `TranscriptList` (`MessageRow.tsx`), `transcript-window.ts`, unit and E2E test suites.  
**Review Status**: Read-only source analysis. Playwright harness not run (reserved by concurrent owner). No application code modified.  
**Standard**: `AGENTS.md` Rule 9 ("No unverified success claims. If you did not run it, say you did not.").

---

## Executive Summary

- **Total Attack Vectors Evaluated**: 10
- **CONFIRMED**: 1 (Minor)
- **REFUTED**: 9
- **Blocker**: 0
- **Major**: 0
- **Minor**: 1
- **Info**: 0

The core architecture of `ScrollController` is fundamentally sound:
1. `ScrollController` is the single owner and writer of the transcript's `scrollTop`. All former write sites in `ConversationView.tsx` and `MessageRow.tsx` have been migrated without leaving any unbracketed writes in `apps/web/src`.
2. Browser engine clamp tracking via synchronous readback (`clampValue`) reliably brackets writes at execution time across Chromium, WebKit, and Gecko, preventing clamps from being misclassified as reader travel.
3. The intent classification rule ("an offset that moved away from the tail and belongs to no write of ours is reader travel") correctly handles gestures, script offsets, and browser focus scrolling without requiring fragile trusted input listeners.
4. React subscription and publication deduplicate `{ mode, atTail, canReturnToTail }`, preventing cascading updates and completely mitigating React #185 during streaming.
5. Duplicate anchor re-capture removal in commit `9096455` was safe: the first call already re-reads post-correction geometry, and all exit branches end with metric logging and anchor capture.

**Confirmed Defect**:
- **MINOR (`SCROLL-ATTACK-03`)**: In `apps/web/src/scroll-controller.ts:259-260`, `returnToTail()` sets `this.mode = "RETURNING_TO_TAIL"` but immediately calls `this.write(this.max())` without passing the `intent` argument. `write()` defaults to `intent = "follow"`, unconditionally setting `this.mode = "FOLLOWING_TAIL"`. This renders `RETURNING_TO_TAIL` unreachable dead code and disables the intended state preservation when a return lands short. The defect was masked in `tests/web/scroll-controller.test.ts:137-146` by an incomplete test stub (`void original;`) asserting `FOLLOWING_TAIL`.

---

## Findings Table

| ID | Severity | File:line | Verdict | Reproduction/proof | Proposed fix | Regression risk |
|---|---|---|---|---|---|---|
| SCROLL-ATTACK-01 | info | `apps/web/src` | **REFUTED** | Full grep across `apps/web/src` confirms zero unaccounted writes to transcript scroller (`scrollTop =`, `scrollTo`, `scrollBy`, `scrollIntoView`, CSS `scroll-behavior: smooth`, `Element.animate`). Unbracketed engine/browser focus scrolls are treated as reader intent. | None. | None. |
| SCROLL-ATTACK-02 | info | `apps/web/src/scroll-controller.ts:250` | **REFUTED** | `pin()` guards against stale `lastTop` via `Math.abs(top - this.lastTop) > 0.5`. If reader movement is reflected in DOM `scrollTop`, `pin()` declines to write. Once delivered to DOM, `sync()` permanently enters `READING_HISTORY`. | None. | None. |
| SCROLL-ATTACK-03 | minor | `apps/web/src/scroll-controller.ts:259-260` | **CONFIRMED** | `returnToTail()` sets `this.mode = "RETURNING_TO_TAIL"` and calls `this.write(this.max())` without `"return"`. Default intent `"follow"` overwrites `this.mode` to `"FOLLOWING_TAIL"` synchronously, leaving `case "return"` unreachable dead code. | Change line 260 to `this.write(this.max(), "return");`. | Very low. Re-arms return state when writes clamp short. |
| SCROLL-ATTACK-04 | info | `apps/web/src/scroll-controller.ts:177-185` | **REFUTED** | `clampValue` is cleared (`null`) on any `sync()` call whether it matches or misses. Because `clampValue` equals the exact landing offset of our write, a reader movement away necessarily changes `scrollTop`, missing `clampValue` and immediately clearing it. | None. | None. |
| SCROLL-ATTACK-05 | info | `apps/web/src/scroll-controller.ts:311-315` | **REFUTED** | CSSOM View Module specification guarantees `element.scrollTop = target` clamps to layout overflow synchronously and flushes layout if dirty. Synchronous readback returns the clamped offset across Blink, WebKit, and Gecko. | None. | None. |
| SCROLL-ATTACK-06 | info | `apps/web/src/scroll-controller.ts:282-296` | **REFUTED** | All 7 former write sites (`pin`, `nudge`, `keepTarget`, `reveal`, `restoreAfterPrepend`, `reset`, `returnToTail`) correctly preserve semantics. The `mode !== "READING_HISTORY"` guard in `nudge`/`keepTarget` matches former tail-pin priority. | None. | None. |
| SCROLL-ATTACK-07 | info | `apps/web/src/components/MessageRow.tsx:894` | **REFUTED** | Commit `9096455` removed a redundant duplicate call running directly after the first. The first call already re-reads post-write geometry after `controller.nudge()`; removing the second does not alter anchor baselines. | None. | None. |
| SCROLL-ATTACK-08 | info | `apps/web/src/components/MessageRow.tsx:768-899` | **REFUTED** | `recordCorrectionMetrics()` is invoked on all 6 exit paths of `useLayoutEffect`. In production without `__trackAnchorCaptures` or `?debug=anchor`, `track` is false, performance timers are skipped, and zero global writes occur. | None. | None. |
| SCROLL-ATTACK-09 | info | `apps/web/src/scroll-controller.ts:336-345` | **REFUTED** | `publish()` compares `mode`, `atTail`, and `canReturnToTail`. During tail streaming, state is stable (`FOLLOWING_TAIL`, `true`, `false`), skipping listener execution entirely. State updates cannot trigger infinite React #185 cascading loops. | None. | None. |
| SCROLL-ATTACK-10 | info | `apps/web/src/scroll-controller.ts:99-136` | **REFUTED** | `detach()` clears DOM `surface` and `clampValue`. `subscribe()` returns an unsubscribe closure deleting the listener from `Set`. Private controller instances created when prop is omitted are garbage-collected with component ref. | None. | None. |

---

## Detailed Attack Vector Analysis

### 1. SCROLL-ATTACK-01: Outside writes to `scrollTop` outside the controller
- **Target**: `apps/web/src` codebase.
- **Verdict**: **REFUTED**.
- **Analysis**:
  - `grep -rn "scrollTop\s*=" apps/web/src` identifies only:
    1. `apps/web/src/scroll-controller.ts:311` (the controller itself).
    2. `apps/web/src/components/AgentChat.tsx:209, 224, 236` (an isolated scroller for subagent modal chat dialogs, unrelated to transcript).
    3. `apps/web/src/components/FileDiffView.tsx:92` (container scroller for file diffs).
    4. `apps/web/src/components/MessageRow.tsx:822` (comment text only).
  - Searches for `scrollTo`, `scrollBy`, `scrollIntoView`, `scroll-behavior: smooth`, and `Element.animate` reveal zero invocations on the transcript scroller (`messagesScrollRef` / `.messages-scroll`).
  - Browser focus scrolling (such as keyboard Tab navigation or Playwright `click()` element scrolling) does not invoke application JS setters. Instead, the browser adjusts `element.scrollTop` natively. When this occurs, `observe()` fires on the `scroll` event and calls `controller.sync()`. Because the movement was unbracketed by `write()`, rule (b) correctly classifies it as reader travel and transitions `mode` to `"READING_HISTORY"`. Claim (a) remains unviolated.

### 2. SCROLL-ATTACK-02: Can `pin()` re-pin a reader?
- **Target**: `apps/web/src/scroll-controller.ts:239-254`.
- **Verdict**: **REFUTED**.
- **Analysis**:
  - `pin()` explicitly inspects live DOM geometry before writing:
    ```ts
    const top = surface.scrollTop;
    if (Math.abs(top - this.lastTop) > SAME_PX) { this.publish(); return; }
    ```
  - If a reader flick or scroll has changed `surface.scrollTop` in the DOM, `Math.abs(top - this.lastTop) > 0.5` evaluates to true. `pin()` immediately returns without writing to `surface.scrollTop`.
  - In `TranscriptList` (`MessageRow.tsx:779-789`), child `useLayoutEffect` runs before parent `ConversationView.tsx` `useLayoutEffect`. If `controller.follows` is true, it calls `controller.sync()`. `sync()` detects `moved = true`, transitions `mode` to `"READING_HISTORY"`, and calls `publish()`. When `ConversationView` subsequently executes `pin()`, `this.mode === "READING_HISTORY"` causes an immediate exit.
  - If a physical gesture is queued in the OS/compositor input queue but has not yet been processed by the browser's main thread, no JavaScript API in any browser can perceive the queued event. Once the browser main thread updates `element.scrollTop`, the discrepancy is detected and `pin()` declines.

### 3. SCROLL-ATTACK-03: Can `sync()` misclassify?
- **Target**: `apps/web/src/scroll-controller.ts:154-233, 256-261`.
- **Verdict**: **CONFIRMED (Minor defect in `returnToTail()`)**; all other sub-cases **REFUTED**.
- **Analysis**:
  - **(i) Reader at tail but `↓ Latest` shows**: REFUTED. `canReturnToTail` is defined as `this.mode === "READING_HISTORY" && !atTail` (line 128). When `distance <= TAIL_THRESHOLD_PX` (80px), `atTail` is `true`, making `!atTail` false. Thus `canReturnToTail` is mathematically impossible when at the tail.
  - **(ii) Reader detached but `↓ Latest` never appears**: REFUTED. An upward movement away from the tail produces `moved = true` and `atTail = false`. If not clamped by our own write, line 231 unconditionally transitions `mode` to `"READING_HISTORY"`, publishing `canReturnToTail = true` which mounts `↓ Latest`.
  - **(iii) Mode oscillation**: REFUTED. `FOLLOWING_TAIL` to `READING_HISTORY` requires `distance > 80px`. `READING_HISTORY` to `FOLLOWING_TAIL` requires `distance <= 80px`. Stationary reader syncs (`!moved`) preserve existing mode.
  - **(iv) `RETURNING_TO_TAIL` clobbered**: **CONFIRMED**. In `returnToTail()`:
    ```ts
    this.mode = "RETURNING_TO_TAIL";
    this.write(this.max());
    ```
    `this.write` is invoked without the `intent` argument. Line 308 defaults `intent` to `"follow"`. In `switch(intent)` (line 329), `case "follow"` unconditionally sets `this.mode = "FOLLOWING_TAIL"`. `this.mode = "RETURNING_TO_TAIL"` is overwritten synchronously. `case "return"` in `write()` is completely unreachable dead code.

### 4. SCROLL-ATTACK-04: `clampValue` lifetime & WebKit coalescing
- **Target**: `apps/web/src/scroll-controller.ts:177-185, 315`.
- **Verdict**: **REFUTED**.
- **Analysis**:
  - `clampValue` is set at write time to the exact offset `landed = surface.scrollTop`.
  - In `sync()`:
    ```ts
    if (this.clampValue !== null && Math.abs(top - this.clampValue) <= SAME_PX) {
      this.clampValue = null;
      ...
      return;
    }
    this.clampValue = null;
    ```
  - If a scroll event is coalesced or dropped, `clampValue` remains equal to the current position of the scroller. If the reader does not move, the scroller remains at `clampValue`. If the reader moves, `scrollTop` moves to an offset differing from `clampValue` by more than `SAME_PX` (0.5px).
  - When `sync()` runs on the reader's scroll event, `Math.abs(top - this.clampValue) <= SAME_PX` evaluates to false. Line 185 unconditionally clears `this.clampValue = null`, and line 231 transitions `mode` to `"READING_HISTORY"`. A stale `clampValue` cannot swallow subsequent reader movement.

### 5. SCROLL-ATTACK-05: Synchronous readback of `surface.scrollTop`
- **Target**: `apps/web/src/scroll-controller.ts:311-315`.
- **Verdict**: **REFUTED**.
- **Analysis**:
  - Under W3C/WHATWG CSSOM View Module, `scrollTop` assignment calculates the element's scrollable overflow rectangle, clamps the requested target to `[0, maxScrollTop]`, and updates the scroll position. Reading `scrollTop` immediately afterward returns that clamped position.
  - Engine evidence:
    - **Chromium / Blink**: `Element::setScrollTop` invokes `ScrollableArea::setScrollOffset(..., kProgrammatic)`. `clampScrollOffset` executes synchronously. Subsequent `Element::scrollTop()` reads `ScrollableArea::getScrollOffset().y()`.
    - **WebKit**: `RenderLayerScrollableArea::setScrollOffset` clamps synchronously against `maximumScrollOffset()`. Reading `scrollTop` immediately accesses `scrollOffset().y()`. Both setter and getter force synchronous layout update if layout is dirty.
    - **Gecko**: `nsIScrollableFrame::ScrollToCSSPixels` clamps to scroll range synchronously.
  - The engine's clamped landing is guaranteed to be reflected within the same synchronous JS task.

### 6. SCROLL-ATTACK-06: Translation of former write sites
- **Target**: `apps/web/src/scroll-controller.ts`, `ConversationView.tsx`, `MessageRow.tsx`.
- **Verdict**: **REFUTED**.
- **Analysis**:
  - **Tail pin**: `ConversationView.tsx:1119` calls `controller.pin()`. Writes `max` only when following tail and stationary.
  - **Anchor correction (`nudge`)**: `MessageRow.tsx:877` calls `controller.nudge(delta)`. Calls `write(before + delta, "stay")` and returns actual applied delta.
  - **`keepTarget`**: `MessageRow.tsx:839` calls `controller.keepTarget(target)`. Calls `write(target, "stay")`.
  - **Search reveal**: `MessageRow.tsx:991` calls `controller.reveal(target)`. Calls `write(target, "reading")`, transitioning to `READING_HISTORY` (or `FOLLOWING_TAIL` if near tail).
  - **Prepend restore**: `ConversationView.tsx:1128` calls `controller.restoreAfterPrepend(anchor)`. Calls `write(..., "stay")`.
  - **Reset**: `ConversationView.tsx:1170` calls `controller.reset()`. Resets mode to `FOLLOWING_TAIL` and clears clamps.
  - **Return to tail**: `ConversationView.tsx:1162` calls `controller.returnToTail()`. Writes `max`.
  - In `nudge` and `keepTarget`, the guard `if (this.mode !== "READING_HISTORY") return` correctly mirrors the former architecture where tail following pinned the bottom and bypassed anchor corrections.

### 7. SCROLL-ATTACK-07: The double `captureAnchorRef` removal
- **Target**: `apps/web/src/components/MessageRow.tsx:894-899` (Commit `9096455`).
- **Verdict**: **REFUTED**.
- **Analysis**:
  - In commit `9096455`, `captureAnchorRef.current?.(false)` was removed from line 898 because line 894 already called `captureAnchorRef.current?.(false)`.
  - Both calls were located *after* the `controller.nudge(delta)` write on line 877.
  - Line 894 re-reads the DOM geometry and element `scrollTop` after the write has already taken effect.
  - The second call on line 898 was executing in the same frame immediately following line 894 with zero intervening DOM modifications, layout changes, or scroll writes.
  - Removing the duplicate call eliminated a redundant DOM measurement without changing the baseline for subsequent commits.

### 8. SCROLL-ATTACK-08: `recordCorrectionMetrics()` coverage & production safety
- **Target**: `apps/web/src/components/MessageRow.tsx:768-900`.
- **Verdict**: **REFUTED**.
- **Analysis**:
  - In `useLayoutEffect`, all 6 termination branches call `recordCorrectionMetrics()`:
    1. Line 778: `element === null || !windowed` -> calls `recordCorrectionMetrics()`.
    2. Line 788: `controller.follows` -> calls `recordCorrectionMetrics()`.
    3. Line 794: `anchor === null` -> calls `recordCorrectionMetrics()`.
    4. Line 842: Missing anchor in model -> calls `recordCorrectionMetrics()`.
    5. Line 848: Truly unknown anchor -> calls `recordCorrectionMetrics()`.
    6. Line 899: Main path after correction -> calls `recordCorrectionMetrics()`.
  - Production safety: `track` evaluates to false unless `window.__trackAnchorCaptures` is set or `location.search` contains `debug=anchor`. When false, `recordCorrectionMetrics()` returns immediately (`if (!track || debugWin === undefined) return;`). No performance timers are queried, and no global variables are allocated or mutated.

### 9. SCROLL-ATTACK-09: React correctness & cascading update prevention
- **Target**: `apps/web/src/scroll-controller.ts:336-345`, `ConversationView.tsx:1112-1113`.
- **Verdict**: **REFUTED**.
- **Analysis**:
  - `ConversationView` subscribes to the controller via `useState` (`setTailState`).
  - `publish()` deduplicates identical state transitions:
    ```ts
    if (previous !== null
      && previous.mode === next.mode
      && previous.atTail === next.atTail
      && previous.canReturnToTail === next.canReturnToTail) return;
    for (const listener of this.listeners) listener(next);
    ```
  - `canReturnToTail` is a deterministic boolean function `f(mode, atTail)`. Comparing `mode`, `atTail`, and `canReturnToTail` covers the entire state tuple.
  - During tail following (such as streaming new tokens), state remains `{ mode: "FOLLOWING_TAIL", atTail: true, canReturnToTail: false }`. `publish()` exits early on line 343 without scheduling any React state update. This prevents cascading re-render loops (React #185).

### 10. SCROLL-ATTACK-10: Memory/lifecycle leaks
- **Target**: `apps/web/src/scroll-controller.ts:99-136`, `MessageRow.tsx:637-665`.
- **Verdict**: **REFUTED**.
- **Analysis**:
  - `TranscriptList` effect cleanup executes `controller.detach()`, setting `this.surface = null` and `this.clampValue = null`, releasing DOM node references.
  - `subscribe` returns a function that deletes the listener from `this.listeners` Set on unmount.
  - When `controllerProp` is omitted, the private `ScrollController` in `ownControllerRef` has an empty listener Set and is cleanly garbage collected when the ref unmounts.
  - Conversation switches reuse the controller via `controller.reset()`, resetting state without creating orphan subscriptions.

---

## Detailed Findings for Confirmed Items

### Item SCROLL-ATTACK-03 (MINOR): `RETURNING_TO_TAIL` clobbered in `returnToTail()` due to omitted `intent`

- **File:line**: `apps/web/src/scroll-controller.ts:259-260`
- **Severity**: Minor
- **Vulnerability**:
  In `apps/web/src/scroll-controller.ts`:
  ```ts
  returnToTail(): void {
    if (this.surface === null) return;
    this.mode = "RETURNING_TO_TAIL";
    this.write(this.max());
  }
  ```
  `returnToTail()` sets `this.mode = "RETURNING_TO_TAIL"` on line 259, and then calls `this.write(this.max())` on line 260.
  However, `write()` is declared as:
  ```ts
  private write(target: number, intent: WriteIntent = "follow"): number {
    ...
    switch (intent) {
      case "return":
        this.mode = this.lastMax - landed <= TAIL_THRESHOLD_PX ? "FOLLOWING_TAIL" : "RETURNING_TO_TAIL";
        break;
      ...
      case "follow":
      default:
        this.mode = "FOLLOWING_TAIL";
        break;
    }
  ```
  Because `returnToTail()` omits the second argument, `intent` defaults to `"follow"`. Inside `write()`, line 329 unconditionally overwrites `this.mode` to `"FOLLOWING_TAIL"`.
  
  **Consequences**:
  1. `this.mode = "RETURNING_TO_TAIL"` is overwritten within 0 nanoseconds; `RETURNING_TO_TAIL` is never observable by any consumer.
  2. `case "return"` in `write()` is completely unreachable dead code.
  3. The intended design documented in lines 73-75 ("landing on it finishes the return; falling short ... keeps the return armed so the next boundary keeps pinning") is bypassed.
  4. This defect was not caught by `tests/web/scroll-controller.test.ts:137-146` because the test was committed as an unfinished stub:
     ```ts
     it("stays armed while a return is short of the bottom", () => {
       const { el, controller } = mount();
       el.scrollTop = 0;
       controller.sync();
       // A return whose write the engine clamps: the document grew before the maximum did.
       const original = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(el), "scrollTop");
       void original;
       controller.returnToTail();
       expect(controller.state().mode).toBe("FOLLOWING_TAIL");
     });
     ```
     The test author left `void original;`, failed to mock clamping on `el`, and asserted `FOLLOWING_TAIL` instead of testing a clamped return.

- **Reproduction**:
  Call `returnToTail()` on a surface where `scrollTop` clamps short of `max - 80`:
  ```ts
  const el = surface({ height: 10000, viewport: 800, top: 0 });
  const controller = new ScrollController();
  controller.attach(el);
  controller.reveal(0); // enter READING_HISTORY
  // Force clamping to 2000 (max is 9200)
  Object.defineProperty(el, "scrollTop", {
    get: () => 2000,
    set: () => {},
  });
  controller.returnToTail();
  // Expected according to spec: "RETURNING_TO_TAIL"
  // Actual observed: "FOLLOWING_TAIL"
  expect(controller.currentMode).toBe("FOLLOWING_TAIL");
  ```

- **Proposed Fix**:
  In `apps/web/src/scroll-controller.ts:260`:
  ```ts
  returnToTail(): void {
    if (this.surface === null) return;
    this.write(this.max(), "return");
  }
  ```
  And in `tests/web/scroll-controller.test.ts:137-146`, properly mock a clamped return landing and assert `"RETURNING_TO_TAIL"`.

- **Regression Risk**:
  Extremely low. `RETURNING_TO_TAIL` preserves `follows === true` and `canReturnToTail === false`, matching `FOLLOWING_TAIL`, but correctly prevents premature classification as fully followed until `atTail` is achieved.
