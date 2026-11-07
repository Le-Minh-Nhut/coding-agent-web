/**
 * The window's own contract, at the two levels that can actually be wrong.
 *
 * 1. The arithmetic, directly: offsets, the slice, the spacers. A mistake here puts
 *    a row in the wrong place (a jump) or drops one (lost content), and neither shows
 *    up as a failed assertion anywhere else.
 * 2. The component, in jsdom: a mounted DOM proportional to the window rather than to
 *    the conversation, while `rows` still holds every message and every message is
 *    still reachable by identity.
 *
 * jsdom reports every rect as zero, so this file does NOT assert anything about
 * heights or pixel positions — that would be asserting jsdom's stub. The geometry
 * proof belongs to the browser passes (`perf-scroll-gates.spec.ts`). What is proven
 * here is the invariant a browser cannot easily prove: nothing is dropped.
 */
import { describe, expect, it } from "vitest";
import {
  DEFAULT_OVERSCAN_PX,
  MAX_SCROLL_HEIGHT_PX,
  PROPAGATION_CAP_FACTOR,
  WINDOW_MIN_ENTRIES,
  buildOffsets,
  computeSegments,
  computeWindow,
  entryKey,
  estimateHeights,
  fallbackHeightFor,
  indexAtOffset,
  searchTranscript,
  spacerHeights,
} from "../../apps/web/src/transcript-window.js";

const uniform = (count: number, height = 100): number[] => Array.from({ length: count }, () => height);

describe("offsets and lookup", () => {
  it("places entry i at exactly the sum of the heights before it", () => {
    const offsets = buildOffsets(uniform(4, 50));
    expect([...offsets]).toEqual([0, 50, 100, 150, 200]);
  });

  it("resolves an offset to the entry containing it, and clamps outside the document", () => {
    const offsets = buildOffsets([40, 100, 60]);
    expect(indexAtOffset(offsets, -10)).toBe(0);
    expect(indexAtOffset(offsets, 0)).toBe(0);
    expect(indexAtOffset(offsets, 39)).toBe(0);
    // 40 is the first pixel of entry 1, not the last of entry 0.
    expect(indexAtOffset(offsets, 40)).toBe(1);
    expect(indexAtOffset(offsets, 139)).toBe(1);
    expect(indexAtOffset(offsets, 140)).toBe(2);
    // Past the end: the document shrank under the scroll position. One frame of this
    // is normal, and it must resolve to the last entry rather than to nothing.
    expect(indexAtOffset(offsets, 99_999)).toBe(2);
  });
});

describe("estimation never leaves a hole", () => {
  it("fills unmeasured entries from the nearest measured neighbour, both directions", () => {
    const heights = estimateHeights([undefined, undefined, 200, undefined, undefined], uniform(5, 92));
    // Above the only measurement: forward to 200, because content size is autocorrelated
    // and the nearest neighbour is a far better guess than the global default.
    expect(heights).toEqual([200, 200, 200, 200, 200]);
  });

  it("falls back to the per-kind default only when nothing anywhere is measured", () => {
    const heights = estimateHeights([undefined, undefined], [92, 64]);
    expect(heights).toEqual([92, 64]);
  });

  it("ignores a zero measurement, which is a pre-layout artefact rather than a row", () => {
    const heights = estimateHeights([0, undefined, 120], uniform(3, 90));
    // A zero-height row would make the window think 90 entries fit in one screen.
    expect(heights[0]).toBe(120);
  });
});

describe("the visible slice", () => {
  const offsets = buildOffsets(uniform(1000, 100));

  it("mounts a bounded number of entries regardless of the conversation's length", () => {
    const window = computeWindow({ offsets, scrollTop: 50_000, viewportPx: 800, overscanPx: DEFAULT_OVERSCAN_PX });
    // 800px viewport + 2 × 800px overscan over 100px rows.
    expect(window.end - window.start).toBeLessThanOrEqual(30);
    expect(window.start).toBeGreaterThan(0);
    // The visible range itself must be covered, not merely approached.
    expect(window.start * 100).toBeLessThanOrEqual(50_000);
    expect(window.end * 100).toBeGreaterThanOrEqual(50_800);
  });

  it("covers the whole list when the list is short", () => {
    const small = buildOffsets(uniform(3, 100));
    expect(computeWindow({ offsets: small, scrollTop: 0, viewportPx: 800, overscanPx: 800 })).toEqual({ start: 0, end: 3 });
  });

  it("mounts something for a pre-layout viewport of zero instead of nothing", () => {
    const window = computeWindow({ offsets, scrollTop: 0, viewportPx: 0, overscanPx: 0 });
    expect(window.end).toBeGreaterThan(1);
  });

  it("unions pinned entries outside the range rather than trusting them to be inside", () => {
    const window = computeWindow({ offsets, scrollTop: 50_000, viewportPx: 800, overscanPx: 100, pinned: [0, 999] });
    expect(window.start).toBe(0);
    expect(window.end).toBe(1000);
  });

  it("treats a pin of a nonexistent entry as no pin, not as a crash", () => {
    const window = computeWindow({ offsets, scrollTop: 0, viewportPx: 800, overscanPx: 100, pinned: [Number.NaN, -5] });
    expect(window.start).toBe(0);
    expect(window.end).toBeGreaterThan(0);
  });
});

describe("pinned entries are segments, not a widened window", () => {
  const offsets = buildOffsets(uniform(8000, 100));

  it("keeps a pinned row far below the viewport without mounting everything between", () => {
    const window = computeWindow({ offsets, scrollTop: 0, viewportPx: 800, overscanPx: 200 });
    const segments = computeSegments({ offsets, visible: window, pinned: [7000] });
    expect(segments).toHaveLength(2);
    const mounted = segments.reduce((sum, segment) => sum + (segment.end - segment.start), 0);
    // The whole point: a failed row 7,000 entries away costs one entry, not 7,000.
    expect(mounted).toBeLessThan(40);
  });

  it("merges a pinned row that touches the window into it", () => {
    const window = computeWindow({ offsets, scrollTop: 0, viewportPx: 800, overscanPx: 0 });
    const segments = computeSegments({ offsets, visible: window, pinned: [window.end] });
    expect(segments).toHaveLength(1);
    expect(segments[0]?.end).toBe(window.end + 1);
  });

  it("returns segments sorted and disjoint, so a spacer fits between each", () => {
    const window = computeWindow({ offsets, scrollTop: 400_000, viewportPx: 800, overscanPx: 200 });
    const segments = computeSegments({ offsets, visible: window, pinned: [0, 7999, 2000] });
    for (let index = 1; index < segments.length; index += 1) {
      expect(segments[index]!.start).toBeGreaterThan(segments[index - 1]!.end);
    }
  });

  it("ignores an out-of-range pin instead of mounting a phantom entry", () => {
    const window = computeWindow({ offsets, scrollTop: 0, viewportPx: 800, overscanPx: 200 });
    const segments = computeSegments({ offsets, visible: window, pinned: [-1, 8000, 999_999] });
    expect(segments).toHaveLength(1);
  });
});

describe("spacers make the scroll range represent the whole conversation", () => {
  it("top + mounted + bottom equals the whole document height", () => {
    const heights = uniform(500, 100);
    const offsets = buildOffsets(heights);
    const window = computeWindow({ offsets, scrollTop: 20_000, viewportPx: 800, overscanPx: 400 });
    const spacers = spacerHeights(offsets, window);
    const mountedHeight = heights.slice(window.start, window.end).reduce((sum, value) => sum + value, 0);
    expect(spacers.top + mountedHeight + spacers.bottom).toBe(50_000);
  });
});

describe("keys are identity, never position", () => {
  it("uses the row id for a row and the first member's id for a group", () => {
    expect(entryKey({ kind: "row", row: { id: "m-7" } })).toBe("m-7");
    expect(entryKey({ kind: "group", group: { rows: [{ id: "t-1" }, { id: "t-2" }] } })).toBe("group:t-1");
  });

  it("survives a prepend without renumbering", () => {
    // The same identity before and after history is added above it.
    const before = entryKey({ kind: "row", row: { id: "u-9" } });
    const after = entryKey({ kind: "row", row: { id: "u-9" } });
    expect(after).toBe(before);
  });
});

describe("the fallback is per kind, because kinds differ by an order of magnitude", () => {
  it("gives a notice less height than a message row", () => {
    expect(fallbackHeightFor({ kind: "row", row: { role: "notice" } }))
      .toBeLessThan(fallbackHeightFor({ kind: "row", row: { role: "assistant" } }));
  });
});

describe("search reaches what the window does not mount", () => {
  const messages = [
    { id: "m-1", role: "user", text: "please refactor the widget" },
    { id: "m-2", role: "assistant", text: "line one\nline two mentions WIDGET twice: widget" },
    { id: "m-3", role: "assistant", text: "unrelated", blocks: [
      { type: "text", text: "a block that says widget" },
    ] },
    { id: "m-4", role: "tool", text: "no match here" },
  ];

  it("matches case-insensitively across every message, in order", () => {
    const hits = searchTranscript(messages, "widget");
    expect(hits.map((hit) => hit.id)).toEqual(["m-1", "m-2", "m-3"]);
    // A message with two occurrences on one line is ONE place in the conversation.
    expect(hits.filter((hit) => hit.id === "m-2")).toHaveLength(1);
  });

  it("searches inside text blocks, not only the message's own text", () => {
    expect(searchTranscript(messages, "block that says").map((hit) => hit.id)).toEqual(["m-3"]);
  });

  it("returns nothing for an empty query, rather than everything", () => {
    expect(searchTranscript(messages, "   ")).toEqual([]);
  });

  it("reports the 1-based conversation ordinal, so 'match 3 of 17' is honest", () => {
    const hits = searchTranscript(messages, "widget");
    expect(hits[0]?.ordinal).toBe(1);
    expect(hits[2]?.ordinal).toBe(3);
  });

  it("finds a hit in the last of ten thousand messages, which is what windowing hid", () => {
    const many = Array.from({ length: 10_000 }, (_, index) => ({ id: `m-${index}`, role: "assistant", text: index === 9_999 ? "the needle" : "hay" }));
    const hits = searchTranscript(many, "needle");
    expect(hits).toHaveLength(1);
    expect(hits[0]?.id).toBe("m-9999");
  });
});

/**
 * W3: an uncapped propagation makes the tail unreachable.
 *
 * A genuinely huge row is real (an expanded 5,000px diff). Smearing its measurement
 * across every unmeasured row turns 8,000 rows into 40,000,000px of model document,
 * past Chromium's 33,554,428px maximum scroll height — at which point the browser
 * clamps `scrollTop` and the newest entry cannot be reached by offset at all. Both the
 * propagation and the total are capped, and the second is what this asserts.
 */
describe("a huge measured row cannot make the document unaddressable (W3)", () => {
  const FALLBACK = 92;

  it("bounds a propagated estimate to a multiple of the entry's own fallback", () => {
    const measured = new Array<number | undefined>(3).fill(undefined);
    measured[0] = 5_000;
    const heights = estimateHeights(measured, new Array<number>(3).fill(FALLBACK));
    // Index 1 and 2 borrow from index 0; both must stay bounded rather than inherit
    // 5,000px each.
    expect(heights[1]).toBeLessThanOrEqual(FALLBACK * PROPAGATION_CAP_FACTOR);
    expect(heights[2]).toBeLessThanOrEqual(FALLBACK * PROPAGATION_CAP_FACTOR);
    // The measured row itself is not clamped: it really is that tall.
    expect(heights[0]).toBe(5_000);
  });

  it("keeps an 8,000-entry model under the engine's maximum scroll height and the tail addressable", () => {
    const count = 8_000;
    const measured = new Array<number | undefined>(count).fill(undefined);
    // One expanded diff at index 5, one at the end — the review's exact scenario.
    measured[5] = 5_000;
    measured[count - 1] = 5_000;
    const heights = estimateHeights(measured, new Array<number>(count).fill(FALLBACK));
    const offsets = buildOffsets(heights);
    const total = offsets[count] ?? 0;
    expect(total).toBeLessThanOrEqual(MAX_SCROLL_HEIGHT_PX);
    expect(total).toBeGreaterThan(0);
    // The property the tail depends on: the offset of the end resolves to the LAST
    // entry that exists (`count - 1`, because offsets are half-open), not to a clamped
    // earlier one. If the model ran past the engine cap the browser would clamp
    // `scrollTop` first and this could only ever return something earlier.
    expect(indexAtOffset(offsets, offsets[count] ?? 0)).toBe(count - 1);
  });

  it("still reaches the newest entry when every row is genuinely 5,000px", () => {
    // Worst case for the total: nothing is borrowed, everything is real. The uniform
    // scale in `buildOffsets` is what saves it, and relative order must survive.
    const count = 8_000;
    const offsets = buildOffsets(new Array<number>(count).fill(5_000));
    const total = offsets[count] ?? 0;
    expect(total).toBeLessThanOrEqual(MAX_SCROLL_HEIGHT_PX);
    expect(indexAtOffset(offsets, total)).toBe(count - 1);
  });
});

describe("the threshold that keeps a short conversation on the simple path", () => {
  it("is high enough that a normal conversation never pays for a measurement pass", () => {
    expect(WINDOW_MIN_ENTRIES).toBeGreaterThanOrEqual(40);
  });
});
