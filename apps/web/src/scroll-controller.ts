/**
 * The single writer of the transcript's `scrollTop`, and the single owner of tail state.
 *
 * Why this is one object instead of a predicate in the view: `ConversationView` used to
 * infer "is the reader at the tail" from geometry, and nothing in the geometry says WHO
 * moved the offset. Six attempts to make that inference work were each rejected by a
 * different real gate, because two facts break it structurally:
 *
 *  - the list's own anchoring write only exists *while* the tail pin is held, so a
 *    write-authorship signal cannot exist in the very state the fix must detect;
 *  - a browser clamp produces a `scrollTop` decrease identical to a reader's flick, and
 *    the cause is not recoverable afterwards — by the time the scroll event is delivered
 *    a measurement can have grown the document again, so the clamp no longer sits at the
 *    maximum (measured: a clamp that read as `dist 142` then `177`).
 *
 * So authorship is recorded when it happens, by the only code that knows: every write is
 * bracketed here (requested target, landing read back in the same task, a short landing
 * recorded as the engine's clamp), and a movement nobody recorded is the reader's. There
 * is exactly ONE intent rule, evaluated wherever geometry is observed:
 *
 *     an offset that moved away from the tail and belongs to no write of ours is reader
 *     travel.
 *
 * A decrease is therefore intent however it was produced — a flick, a wheel, a keyboard
 * scroll, a scrollbar drag, or a scripted offset assignment followed by a dispatched
 * `scroll` event. That last form is how `tests/e2e/mobile.spec.ts` produces the gesture,
 * which is why requiring a trusted `wheel`/`touch`/`keydown` cannot work. `isTrusted` is
 * not consulted for the same reason it cannot help: our own writes and the engine's
 * clamps raise trusted events too, and the distinction that matters is our ledger.
 *
 * State machine:
 *
 *     FOLLOWING_TAIL → READING_HISTORY → RETURNING_TO_TAIL → FOLLOWING_TAIL
 *
 * Only `READING_HISTORY` means "the reader is away from the newest content", so only it
 * publishes `canReturnToTail`, which is what mounts the `↓ Latest` control.
 *
 * The surface is narrowed to three numeric properties, so the machine is unit-testable
 * with a plain object (see `tests/web/scroll-controller.test.ts`); no layout is needed.
 */

export type ScrollMode = "FOLLOWING_TAIL" | "READING_HISTORY" | "RETURNING_TO_TAIL";

export interface ScrollState {
  mode: ScrollMode;
  /** The viewport's bottom edge is at (or within the threshold of) the document's. */
  atTail: boolean;
  /**
   * The reader is away from the newest content, so the jump-to-latest control is the way
   * back. False while following, and while a return is already under way.
   */
  canReturnToTail: boolean;
}

/** The only surface this controller needs from a scroll element. */
export interface ScrollSurface {
  scrollTop: number;
  readonly scrollHeight: number;
  readonly clientHeight: number;
}

/** How close to the bottom counts as "at the tail". Unchanged from the view's constant. */
export const TAIL_THRESHOLD_PX = 80;

/** Two offsets closer than this are the same position (sub-pixel layout rounding). */
const SAME_PX = 0.5;

/**
 * What a write was for. The purpose is known to the caller, so its consequence for the
 * mode is stated rather than re-derived from where the write landed:
 *
 *  - `follow`: our duty was to stay at the bottom. Keep following.
 *  - `return`: the reader asked for the newest content. Landing on it finishes the
 *    return; falling short (the engine can clamp a write while it recomputes the
 *    maximum) keeps the return armed so the next boundary keeps pinning.
 *  - `reading`: a deliberate move to a specific row — a search hit. The tail is left
 *    unless the row happened to be the newest one.
 *  - `stay`: a positional correction on the reader's behalf (anchor hold, history
 *    restore). It says nothing about the tail and must not change the mode.
 */
type WriteIntent = "follow" | "return" | "reading" | "stay";

export class ScrollController {
  private surface: ScrollSurface | null = null;
  private mode: ScrollMode = "FOLLOWING_TAIL";
  /** The offset our own last transaction left behind: the authorship baseline. */
  private lastTop = 0;
  /** The document's scrollable maximum as of the last observation. */
  private lastMax = 0;
  /**
   * An offset the ENGINE produced by clamping, recorded at the moment it happened. It is
   * matched by value so a clamp is never mistaken for a flick, even after a measurement
   * has grown the document again and the offset is no longer the maximum.
   */
  private clampValue: number | null = null;
  private listeners = new Set<(state: ScrollState) => void>();
  private published: ScrollState | null = null;

  attach(surface: ScrollSurface): void {
    this.surface = surface;
    this.mode = "FOLLOWING_TAIL";
    this.lastTop = surface.scrollTop;
    this.lastMax = this.max();
    this.clampValue = null;
    this.published = null;
    this.publish();
  }

  detach(): void {
    this.surface = null;
    this.clampValue = null;
  }

  /** Whether the newest content is (or is being returned to as) our anchor. */
  get follows(): boolean {
    return this.mode !== "READING_HISTORY";
  }

  get currentMode(): ScrollMode {
    return this.mode;
  }

  state(): ScrollState {
    const atTail = this.distance() <= TAIL_THRESHOLD_PX;
    return {
      mode: this.mode,
      atTail,
      canReturnToTail: this.mode === "READING_HISTORY" && !atTail,
    };
  }

  subscribe(listener: (state: ScrollState) => void): () => void {
    this.listeners.add(listener);
    listener(this.state());
    return () => { this.listeners.delete(listener); };
  }

  /** A new transcript (conversation switch): follow its newest content again. */
  reset(): void {
    this.mode = "FOLLOWING_TAIL";
    this.clampValue = null;
    if (this.surface !== null) {
      this.lastTop = this.surface.scrollTop;
      this.lastMax = this.max();
    }
    this.publish();
  }

  /**
   * Observe the scroller: the universal boundary, called from a scroll event, from a
   * ResizeObserver record, and after every commit of the list. It classifies movement,
   * accounts for the engine's clamps, and holds the tail while the tail is ours.
   */
  sync(): void {
    const surface = this.surface;
    if (surface === null) return;
    const top = surface.scrollTop;
    const max = this.max();
    const previous = this.lastTop;
    const moved = Math.abs(top - previous) > SAME_PX;
    /**
     * At the newest content. `distance` is stated as a comparison rather than an equality
     * because a detached reader can hold an offset only a few px from the bottom, and 80px
     * of slack (`TAIL_THRESHOLD_PX`) is the same definition the control uses: being that
     * close is being there.
     */
    const atTail = max - top <= TAIL_THRESHOLD_PX;

    /**
     * The engine clamped a write of ours. `write` recorded the landing the moment it
     * happened, so this is a match by value, not a reconstruction: a later measurement can
     * have grown the document and moved the maximum, and the same offset would otherwise
     * read as a reader's flick of exactly `distance`. Measured on attempt 5: the pin asked
     * for `331,206` against a maximum of `331,104`, the engine clamped to `331,104`, and by
     * event delivery the distance read `142` then `177` — a clamp that looked like travel.
     */
    if (this.clampValue !== null && Math.abs(top - this.clampValue) <= SAME_PX) {
      this.clampValue = null;
      this.lastTop = top;
      this.lastMax = max;
      if (atTail && this.mode !== "READING_HISTORY") this.mode = "FOLLOWING_TAIL";
      this.publish();
      return;
    }
    this.clampValue = null;

    if (atTail) {
      /**
       * At the newest content. Whoever put us there — a clamp of a shrinking document, a
       * drag to the bottom, a script, a gesture — following is the correct state, and a
       * write is owed only if the document has grown since the pin landed.
       */
      this.lastTop = top;
      this.lastMax = max;
      this.mode = "FOLLOWING_TAIL";
      this.publish();
      return;
    }

    if (!moved) {
      /**
       * A stationary reader. The document changed under them, or a write of ours landed
       * short of the bottom. While the tail is ours both are the same obligation: be at
       * the bottom, exactly.
       */
      this.lastMax = max;
      if (this.mode === "READING_HISTORY") { this.publish(); return; }
      this.write(max);
      return;
    }

    this.lastTop = top;
    this.lastMax = max;
    if (this.mode === "READING_HISTORY") {
      // The reader owns the position. Absorb the movement — including a shrink under a
      // detached reader — and wait for them to come back to the newest content.
      this.publish();
      return;
    }
    /**
     * A movement nobody recorded, away from the tail. Nothing else in this system can
     * produce it: scroll anchoring is off (`overflow-anchor: none`), content arriving below
     * a viewport does not move the offset, every write of ours is bracketed by `write`, and
     * a clamp of a shrinking document either lands at the maximum (handled above, as
     * `atTail`) or is the landing `write` already recorded. So this is the reader's,
     * whatever produced it: a flick, a wheel, a keyboard scroll, a scrollbar drag, or a
     * scripted offset assignment with a dispatched `scroll` event — exactly how
     * `tests/e2e/mobile.spec.ts` performs the gesture, which is why a trusted input event
     * cannot be required.
     */
    this.mode = "READING_HISTORY";
    this.publish();
  }

  /**
   * Hold the tail after a commit (new content, a streaming delta, a height estimate
   * turning into a measurement). A no-op unless the tail is ours.
   */
  pin(): void {
    const surface = this.surface;
    if (surface === null || this.mode === "READING_HISTORY") return;
    const top = surface.scrollTop;
    /**
     * The offset moved since our baseline, so somebody else moved it and their scroll
     * event has not been delivered yet. Writing here would overwrite the reader's
     * position and then read the write's own landing as "still at the tail" — measured on
     * the previous design as a walk that requested offset 0 holding 511,980 for ten
     * frames. The event decides; this commit does nothing.
     */
    if (Math.abs(top - this.lastTop) > SAME_PX) { this.publish(); return; }
    const max = this.max();
    if (Math.abs(max - top) <= SAME_PX) { this.publish(); return; }
    this.write(max);
  }

  /** The `↓ Latest` control: return to the newest content and keep following it. */
  returnToTail(): void {
    if (this.surface === null) return;
    this.mode = "RETURNING_TO_TAIL";
    this.write(this.max());
  }

  /** Reveal a specific row (search hit, jump to an identity). */
  reveal(target: number): void {
    this.write(target, "reading");
  }

  /** Put the view back where it was after older history was prepended above the reader. */
  restoreAfterPrepend(anchor: { top: number; height: number }): void {
    const surface = this.surface;
    if (surface === null) return;
    this.write(anchor.top + (surface.scrollHeight - anchor.height), "stay");
  }

  /**
   * Hold the reading position across a commit whose geometry changed, by moving the
   * viewport `delta` px. Returns the movement the engine actually made.
   *
   * Only while reading history: while the tail is held the pin owns the position, and two
   * writers for one obligation is what made the old corrections fight each other.
   */
  nudge(delta: number): number {
    const surface = this.surface;
    if (surface === null || this.mode !== "READING_HISTORY") return 0;
    if (Math.abs(delta) < SAME_PX) return 0;
    const before = surface.scrollTop;
    return this.write(before + delta, "stay") - before;
  }

  /** Same, as an absolute target (the anchored row left the mounted window). */
  keepTarget(target: number): void {
    const surface = this.surface;
    if (surface === null || this.mode !== "READING_HISTORY") return;
    if (Math.abs(target - surface.scrollTop) < SAME_PX) return;
    this.write(target, "stay");
  }

  private max(): number {
    const surface = this.surface;
    return surface === null ? 0 : Math.max(0, surface.scrollHeight - surface.clientHeight);
  }

  private distance(): number {
    const surface = this.surface;
    return surface === null ? 0 : this.max() - surface.scrollTop;
  }

  private write(target: number, intent: WriteIntent = "follow"): number {
    const surface = this.surface;
    if (surface === null) return 0;
    surface.scrollTop = target;
    const landed = surface.scrollTop;
    // The clamp is a fact of THIS write: the engine put the offset where it could reach,
    // and that landing is ours, not the reader's.
    if (Math.abs(landed - target) > SAME_PX) this.clampValue = landed;
    this.lastTop = landed;
    this.lastMax = this.max();
    switch (intent) {
      case "return":
        this.mode = this.lastMax - landed <= TAIL_THRESHOLD_PX ? "FOLLOWING_TAIL" : "RETURNING_TO_TAIL";
        break;
      case "reading":
        this.mode = this.lastMax - landed <= TAIL_THRESHOLD_PX ? "FOLLOWING_TAIL" : "READING_HISTORY";
        break;
      case "stay":
        break;
      case "follow":
      default:
        this.mode = "FOLLOWING_TAIL";
        break;
    }
    this.publish();
    return landed;
  }

  private publish(): void {
    const next = this.state();
    const previous = this.published;
    this.published = next;
    if (previous !== null
      && previous.mode === next.mode
      && previous.atTail === next.atTail
      && previous.canReturnToTail === next.canReturnToTail) return;
    for (const listener of this.listeners) listener(next);
  }
}
