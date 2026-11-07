/**
 * The geometry of a windowed transcript: offsets, estimation, and the visible slice.
 *
 * Why this exists at all: the transcript used to render every row of every
 * conversation into the document. That is the owner's black screen. Measured on
 * this machine, an 8,000-entry conversation was **313,916 DOM elements**, and the
 * renderer went **793 ms at a time without producing a frame** while it was flicked
 * (Chromium), **2,112 ms** (WebKit). React was not the cost — the full page was
 * making exactly 2 commits across an 8-flick train while producing 24 frame gaps
 * over 100 ms — and neither was the app's script, style or layout (61 ms combined
 * across a 15.3 s gesture). The cost is the element count the browser must lay out,
 * restyle and raster on every scroll frame.
 *
 * The number of *mounted* rows is a rendering decision, so it may be bounded. The
 * transcript itself is not: `rows` stays the complete authoritative list, and
 * everything that reads it (search, copy, jump, tool expansion) reads the whole
 * thing. Nothing here is allowed to make a message unreachable — only unrendered
 * until the window reaches it.
 *
 * All of this is deliberately dependency-free. TanStack Virtual would bring its own
 * measurement contract, its own API and ~1/3 again on the bundle gzip size for
 * arithmetic this file does in 120 lines, and the bottleneck is behind the renderer
 * in the engine's per-frame node work anyway, not in the offset maths.
 */

/**
 * Below this many entries the whole list renders unchanged.
 *
 * Windowing a short conversation buys nothing and costs a measurement pass, so the
 * simple path stays the default one. 60 entries is roughly ten screens on a phone —
 * far past the point where a conversation is still being read top to bottom, and
 * still small enough that its DOM is not worth measuring.
 */
export const WINDOW_MIN_ENTRIES = 60;

/**
 * Extra content rendered above and below the viewport, in px.
 *
 * Chosen by measurement, not taste: `PERF-SCROLL-02` at 4× CPU throttle on both
 * engines, three configurations (see `docs/audits/SCROLL_PERFORMANCE_RESEARCH.md`
 * §13). The trade is the one the brief names — too little leaves a visible gap
 * during a flick, too much restores the DOM problem. The number below is the
 * smallest that never showed a gap in either engine.
 */
export const DEFAULT_OVERSCAN_PX = 800;

/** Nothing measured yet: a message card's typical rendered height on a 390px screen. */
const FALLBACK_ROW_PX = 92;
/** A collapsed activity group's head plus its padding. */
const FALLBACK_GROUP_PX = 64;
/** A notice paragraph. */
const FALLBACK_NOTICE_PX = 58;

/**
 * The height to use for an entry nothing has measured yet: its neighbour's.
 *
 * Content height is strongly autocorrelated — a conversation's turns look like each
 * other far more than they look like the global average — so the nearest measured
 * entry is a better guess than any constant. This matters only for entries outside
 * the window, and every guess is corrected the first time the entry is measured.
 */
/**
 * How many times its own per-kind fallback a propagated estimate may be.
 *
 * The propagation below is a guess borrowed from a neighbour, and a guess is only
 * useful while it stays in the same order of magnitude as the thing it describes. An
 * expanded diff or a single huge tool card is a genuine 5,000px row; letting that
 * measurement set the height of every unmeasured row above it turns 8,000 rows into
 * 40,000,000px of model document, which is past Chromium's 33,554,428px maximum
 * scroll height. At that size the browser clamps `scrollTop`, so the last entries
 * become unreachable by offset and the scrollbar saturates — the exact failure the
 * window exists to prevent. 8x is wide enough to track a genuinely tall conversation
 * (a page of Markdown is ~8x a one-line answer) and narrow enough that the total stays
 * addressable.
 */
export const PROPAGATION_CAP_FACTOR = 8;

/**
 * The engine's maximum scrollable height in Chromium (and the figure Blink has used
 * since 2017). Kept as a constant rather than imported, because the model must hold on
 * any engine: the value is a browser fact, not a build constant.
 */
export const MAX_SCROLL_HEIGHT_PX = 33_554_428;

/** Clamp a borrowed estimate to a bounded multiple of the entry's own fallback. */
function boundedEstimate(borrowed: number | undefined, fallback: number): number {
  const cap = Math.max(fallback, fallback * PROPAGATION_CAP_FACTOR);
  if (borrowed === undefined || !Number.isFinite(borrowed) || borrowed <= 0) return fallback;
  return Math.min(borrowed, cap);
}

export function estimateHeights(measured: readonly (number | undefined)[], fallback: readonly number[]): number[] {
  const heights = new Array<number>(measured.length);
  // `real[index]` means "this height came from a measurement or from one", as opposed
  // to the caller's per-kind default. Only a real height may be propagated to its
  // neighbours: smearing a default across the list is how every message row would end
  // up rendered at a notice's height, which is a wrong document, not an estimate.
  const real: boolean[] = new Array<boolean>(measured.length).fill(false);
  // Forward pass: the nearest measured entry above.
  let previous: { height: number } | undefined;
  for (let index = 0; index < measured.length; index += 1) {
    const value = measured[index];
    const own = fallback[index] ?? FALLBACK_ROW_PX;
    if (value !== undefined && value > 0) {
      // A measurement is not a guess: a row that really is 5,000px stays 5,000px. Only
      // what is BORROWED from it is bounded, which is the scope of the defect.
      previous = { height: value };
      heights[index] = value;
      real[index] = true;
    } else {
      heights[index] = previous === undefined ? Number.NaN : boundedEstimate(previous.height, own);
      real[index] = previous !== undefined;
    }
  }
  // Backward pass: entries above the first measured one take the nearest measured
  // entry below; anything with no measured entry anywhere keeps its own default.
  let next: { height: number } | undefined;
  for (let index = measured.length - 1; index >= 0; index -= 1) {
    const own = fallback[index] ?? FALLBACK_ROW_PX;
    if (Number.isNaN(heights[index])) {
      heights[index] = next === undefined ? own : boundedEstimate(next.height, own);
      real[index] = next !== undefined;
    }
    const resolved = heights[index];
    if (real[index] && resolved !== undefined) next = { height: resolved };
  }
  return heights;
}

/**
 * Cumulative offsets: `offsets[index]` is the top of entry `index`, and
 * `offsets[length]` is the whole document's height.
 *
 * `Float64Array` rather than `number[]` because this is read on every scroll event
 * through a binary search, and at 8,000 entries the total stays far inside the range
 * where a double is exact for pixel offsets.
 */
export function buildOffsets(heights: readonly number[], gapPx = 0): Float64Array {
  const offsets = new Float64Array(heights.length + 1);
  const count = heights.length;
  /**
   * The flex gap belongs to the MODEL, not to a correction applied afterwards.
   *
   * `.transcript-entries` is a flex column with a gap that no element's measured height
   * contains. It used to be subtracted from the spacers at render time
   * (`fitSpacersToGap`), which made every mounted entry sit `k * gap` below its model
   * offset for a `k` that changed with the mounted range — so the anchor correction
   * measured a non-zero delta every time the window moved, wrote `scrollTop`, moved the
   * window, and measured the delta again: `+40, -20, +10, -10, +10, -10 …` until React's
   * nested-update limit tripped (#185). Folding the gap in here makes an entry's model
   * offset its DOM position for EVERY window, so a window move is not a geometry change
   * and the correction computes zero.
   */
  const gap = Number.isFinite(gapPx) && gapPx > 0 ? gapPx : 0;
  // The document must stay addressable. Past `MAX_SCROLL_HEIGHT_PX` the engine clamps
  // `scrollTop` and the tail becomes unreachable by offset, so the accumulated model is
  // scaled down uniformly rather than allowed past the cap. Uniform scaling keeps every
  // entry's *relative* position — the last entry is still at the end — so
  // `indexAtOffset(offsets, offsets[count])` still resolves to the newest entry, which
  // is the property the tail depends on. `estimateHeights` already bounds each borrowed
  // estimate; this is the second line of defence for a transcript of genuinely huge
  // rows.
  let running = 0;
  for (let index = 0; index < count; index += 1) {
    // A gap sits BETWEEN entries, so entry `index` starts one gap below the previous
    // entry's end for every `index > 0` — `count - 1` gaps in the whole document, which
    // is exactly what flex lays out when the document is fully rendered. There is
    // deliberately no gap AFTER the last entry: a trailing gap would be space the DOM
    // does not have, and it showed up as the content ending 177px past the scrollport
    // once the model started carrying the gap at all.
    if (index > 0) running += gap;
    offsets[index] = running;
    const height = heights[index] ?? 0;
    running += Number.isFinite(height) && height > 0 ? height : 0;
  }
  if (running > MAX_SCROLL_HEIGHT_PX) {
    const scale = MAX_SCROLL_HEIGHT_PX / running;
    // `count` is assigned BEFORE scaling: it is still 0 at this point, and scaling a
    // zero leaves the document's end at the origin, which is how the first version of
    // this fix made the tail resolve to entry 7,999 of 8,000.
    offsets[count] = running;
    for (let index = 0; index <= count; index += 1) {
      offsets[index] = (offsets[index] ?? 0) * scale;
    }
    return offsets;
  }
  offsets[count] = running;
  return offsets;
}

/**
 * The index of the entry covering `offset`: the last one whose top is at or above it.
 *
 * Clamped, so a scroll position past the end (which happens for one frame when the
 * document is shrinking) resolves to the last entry rather than `-1`.
 */
export function indexAtOffset(offsets: Float64Array, offset: number): number {
  const count = offsets.length - 1;
  if (count <= 0) return 0;
  if (offset <= 0) return 0;
  let low = 0;
  let high = count - 1;
  while (low < high) {
    const middle = (low + high + 1) >> 1;
    if ((offsets[middle] ?? 0) <= offset) low = middle;
    else high = middle - 1;
  }
  return low;
}

/** The half-open range of entries to mount. */
export interface EntryWindow {
  start: number;
  end: number;
}

/**
 * The entries to mount for a scroll position, plus overscan, plus anything pinned.
 *
 * `pinned` is how a control that must not disappear survives the window: an approval
 * waiting on the user, a row whose expansion is open, a row holding the focus ring,
 * the entry a search jump just landed on. Those are unioned into the range rather
 * than being trusted to fall inside it — a pinned entry outside the viewport is
 * still mounted, and costs only the elements it already forced into the document.
 */
export function computeWindow(options: {
  offsets: Float64Array;
  scrollTop: number;
  viewportPx: number;
  overscanPx: number;
  pinned?: readonly number[];
}): EntryWindow {
  const count = options.offsets.length - 1;
  if (count <= 0) return { start: 0, end: 0 };
  // A zero viewport is what a pre-layout render reports (and what jsdom always
  // reports). Treating it as "nothing is visible" would mount nothing at all, so it
  // falls back to one documented phone screen.
  const viewport = options.viewportPx > 0 ? options.viewportPx : 844;
  const overscan = Math.max(0, options.overscanPx);
  const top = Math.max(0, options.scrollTop - overscan);
  const bottom = options.scrollTop + viewport + overscan;
  let start = indexAtOffset(options.offsets, top);
  // `+1` because `indexAtOffset` returns the entry the offset is *inside*, and the
  // entry starting exactly at `bottom` is not visible — but one starting a pixel
  // above it is.
  let end = Math.min(count, indexAtOffset(options.offsets, bottom) + 1);
  for (const index of options.pinned ?? []) {
    if (!Number.isFinite(index)) continue;
    if (index < start) start = Math.max(0, index);
    if (index + 1 > end) end = Math.min(count, index + 1);
  }
  return { start, end };
}

/**
 * How much taller the document is than what is mounted, split into the two spacers.
 *
 * The spacers are what keep the scrollbar honest: the browser's own scroll range has
 * to represent the whole conversation even though most of it is not in the document,
 * or dragging the thumb would only ever reach the mounted slice.
 */
export function spacerHeights(
  offsets: Float64Array,
  window: EntryWindow,
  gapPx = 0,
): { top: number; bottom: number } {
  const count = offsets.length - 1;
  const top = offsets[Math.min(window.start, count)] ?? 0;
  const endOffset = offsets[Math.min(window.end, count)] ?? 0;
  const total = offsets[count] ?? 0;
  const gap = Number.isFinite(gapPx) && gapPx > 0 ? gapPx : 0;
  /**
   * A rendered spacer costs one flex gap of its own — the gap between it and the entry
   * next to it — and the offsets model already charged a gap at that boundary. Taking
   * one gap off each NON-EMPTY spacer is therefore not a correction, it is the arithmetic
   * of the layout: the DOM's total equals `offsets[count]` exactly.
   *
   * The subtraction depends only on how many spacers are rendered (0, 1 or 2), never on
   * how many entries are mounted — which is what keeps a window move from changing the
   * document's height, and therefore keeps the anchor correction's delta at zero.
   */
  const topHeight = top > gap ? top - gap : top;
  const bottomHeight = total - endOffset > gap ? total - endOffset - gap : Math.max(0, total - endOffset);
  return { top: topHeight, bottom: bottomHeight };
}

/** The per-entry default used only when nothing near an entry has been measured. */
export function fallbackHeightFor(entry: { kind: "group" } | { kind: "row"; row: { role: string } }): number {
  if (entry.kind === "group") return FALLBACK_GROUP_PX;
  return entry.row.role === "notice" ? FALLBACK_NOTICE_PX : FALLBACK_ROW_PX;
}

/** A stable key for an entry: the row's id, or the group's first member's id. */
export function entryKey(entry: { kind: "group"; group: { rows: { id: string }[] } } | { kind: "row"; row: { id: string } }): string {
  // The group key has always been its first member's id, and `groupActivity` never
  // produces a group without one. Using the same key as before means an entry keeps
  // its measured height across a re-group, and a folded echo cannot mint a second key
  // because the fold only ever *joins* rows to an existing group.
  return entry.kind === "group" ? `group:${entry.group.rows[0]?.id ?? ""}` : entry.row.id;
}

/* ------------------------------------------------------------------ */
/* In-app search over the COMPLETE transcript                          */
/* ------------------------------------------------------------------ */

/**
 * One search hit: which message, where in the conversation, and what it says.
 *
 * Search exists because the window broke the browser's own Find. Native Find can
 * only reach what is in the document, and after windowing most of a long
 * conversation is not — so "find in page" would silently miss the very message the
 * user is looking for, which is a worse failure than having no Find at all. This
 * searches `messages` (the complete, authoritative array) and never the DOM, so its
 * results are exactly as complete as the transcript is.
 */
export interface TranscriptMatch {
  /** The message id — the same identity the list keys its entries on. */
  id: string;
  /** 1-based position in the conversation, so "match 4 of 17" is honest. */
  ordinal: number;
  /** The matching line's text, with the line around the hit for context. */
  excerpt: string;
  /** The match's offset inside `excerpt`, for the highlight. */
  offset: number;
  length: number;
  role: string;
}

/** Every line of a message: prose, plus each text/code block's own text. */
function searchableLines(message: { text: string; blocks?: readonly { type: string; text?: string }[] }): string[] {
  const lines = message.text.split("\n");
  for (const block of message.blocks ?? []) {
    if (block.type === "text" && typeof block.text === "string") lines.push(...block.text.split("\n"));
    if (block.type === "toolCall") continue;
  }
  return lines;
}

/**
 * Find `query` (case-insensitively) across the whole transcript, in order.
 *
 * One hit per line rather than per occurrence: a 200-character line with the word
 * eight times is one place in the conversation, and eight identical jumps would make
 * "next match" look broken. A hit is returned per *message* when the message is a
 * long single line, so a very long prompt still yields navigable stops.
 *
 * An empty query is zero matches, not everything: the caller's affordance says
 * "search", and a control that reports every row as a match before a key is pressed
 * is noise.
 */
/**
 * Precached, lowercased lines per message, indexed by message position.
 *
 * `searchTranscript` used to `split("\n")` every text block of every message on every
 * keystroke — 77 ms per keystroke on a 96 MB / 8,000-message transcript, on the same
 * main thread the window exists to keep free. The lines do not change between
 * keystrokes; only the needle does. `buildSearchIndex` pays that cost once per
 * `messages` identity, and `searchIndexed` reuses it.
 */
export interface SearchIndex {
  readonly lines: readonly (readonly string[])[] | null;
  readonly messages: readonly { id: string; text: string; role: string; blocks?: readonly { type: string; text?: string }[] }[];
}

/** Build the line cache once per transcript identity. `null` means "index not used". */
export function buildSearchIndex(messages: SearchIndex["messages"]): SearchIndex {
  const lines: string[][] = [];
  for (const message of messages) {
    // Lowercased here, once: case-insensitive search then costs an `indexOf` per line
    // instead of a `toLowerCase()` allocation per line per keystroke.
    lines.push(searchableLines(message).map((line) => line.toLowerCase()));
  }
  return { lines, messages };
}

export function searchTranscript(
  messages: readonly { id: string; text: string; role: string; blocks?: readonly { type: string; text?: string }[] }[],
  query: string,
  index?: SearchIndex | null,
): TranscriptMatch[] {
  const needle = query.trim().toLowerCase();
  if (needle === "") return [];
  const matches: TranscriptMatch[] = [];
  for (let position = 0; position < messages.length; position += 1) {
    const message = messages[position];
    if (message === undefined) continue;
    // Without a cache the lines are split and lowered here, once per message per
    // keystroke — correct, just slower. With a cache (`buildSearchIndex`) they were
    // split and lowered once per transcript identity, and this loop only searches.
    const cachedLines = index?.lines?.[position];
    const originalLines = cachedLines === undefined ? searchableLines(message) : null;
    const lines = cachedLines ?? (originalLines ?? []).map((line) => line.toLowerCase());
    const seen = new Set<string>();
    for (let lineNumber = 0; lineNumber < lines.length; lineNumber += 1) {
      const line = lines[lineNumber] ?? "";
      const offset = line.indexOf(needle);
      if (offset === -1) continue;
      // The same line twice (prose and a block rendering it) is one hit.
      const dedupe = `${String(offset)}:${line}`;
      if (seen.has(dedupe)) continue;
      seen.add(dedupe);
      // 60 characters of lead-in so the hit is not presented as a bare word with no
      // idea which message it came from.
      const from = Math.max(0, offset - 40);
      const to = Math.min(line.length, offset + needle.length + 40);
      // The excerpt is cut from the ORIGINAL case where the two agree on length. Some
      // scripts change length when lowercased (Turkish `İ`, ligatures), and slicing the
      // original at an offset measured in the lowered string would cut the wrong span —
      // so the lowered line is used there rather than a wrong excerpt.
      const original = originalLines?.[lineNumber] ?? line;
      const excerptSource = original.length === line.length ? original : line;
      matches.push({
        id: message.id,
        ordinal: position + 1,
        excerpt: `${from > 0 ? "…" : ""}${excerptSource.slice(from, to)}${to < excerptSource.length ? "…" : ""}`,
        offset: offset - from + (from > 0 ? 1 : 0),
        length: needle.length,
        role: message.role,
      });
      break;
    }
  }
  return matches;
}

/**
 * The mounted ranges: the visible window, plus each pinned entry as its own segment.
 *
 * A pinned entry that falls inside the window needs nothing. One outside it is a
 * *separate* range rather than a widened single range — and that distinction is not
 * cosmetic. A failed row at the bottom of an 8,000-entry conversation and the row the
 * user is reading at the top would otherwise force every entry between them to mount,
 * which is precisely the unbounded document this change exists to remove (measured:
 * 6,759 of 7,988 entries mounted, 321,402 elements — the old problem, one indirection
 * deeper). As segments, the pinned rows are mounted where they belong and the space
 * between them stays a spacer.
 *
 * Ranges come back sorted and disjoint, in document order, so the caller can render
 * them in sequence and place one spacer before each.
 */
export function computeSegments(options: {
  offsets: Float64Array;
  visible: EntryWindow;
  pinned?: readonly number[];
}): EntryWindow[] {
  const count = options.offsets.length - 1;
  const ranges: EntryWindow[] = [];
  if (options.visible.end > options.visible.start) ranges.push({ start: options.visible.start, end: options.visible.end });
  for (const index of options.pinned ?? []) {
    if (!Number.isInteger(index) || index < 0 || index >= count) continue;
    // Inside the visible range already, or adjacent to it: nothing to add.
    if (ranges.some((range) => index >= range.start && index < range.end)) continue;
    const touching = ranges.find((range) => index === range.start - 1 || index === range.end);
    if (touching !== undefined) {
      if (index === touching.start - 1) touching.start = index;
      else touching.end = index + 1;
      ranges.sort((left, right) => left.start - right.start);
      // Two ranges may now overlap after an extension; merge them.
      for (let position = ranges.length - 1; position > 0; position -= 1) {
        const previous = ranges[position - 1];
        const current = ranges[position];
        if (previous !== undefined && current !== undefined && current.start <= previous.end) {
          previous.end = Math.max(previous.end, current.end);
          ranges.splice(position, 1);
        }
      }
      continue;
    }
    ranges.push({ start: index, end: index + 1 });
  }
  ranges.sort((left, right) => left.start - right.start);
  const merged: EntryWindow[] = [];
  for (const range of ranges) {
    const last = merged[merged.length - 1];
    if (last !== undefined && range.start <= last.end) last.end = Math.max(last.end, range.end);
    else merged.push({ ...range });
  }
  return merged;
}
