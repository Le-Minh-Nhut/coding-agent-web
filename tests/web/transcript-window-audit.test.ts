import { describe, expect, it } from "vitest";
import {
  DEFAULT_OVERSCAN_PX,
  MAX_SCROLL_HEIGHT_PX,
  PROPAGATION_CAP_FACTOR,
  WINDOW_MIN_ENTRIES,
  buildOffsets,
  buildSearchIndex,
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

describe("buildOffsets contract", () => {
  it("builds exact offsets for 1, 2, and 1000 entries with gap arithmetic", () => {
    const gap = 10;

    // 1 entry: 0 gaps
    const single = buildOffsets([120], gap);
    expect(single.length).toBe(2);
    expect(single[0]).toBe(0);
    expect(single[1]).toBe(120);

    // 2 entries: exactly 1 gap between entry 0 and entry 1
    const double = buildOffsets([100, 150], gap);
    expect(double.length).toBe(3);
    expect(double[0]).toBe(0);
    expect(double[1]).toBe(100 + gap); // 110
    expect(double[2]).toBe(100 + gap + 150); // 260

    // 1000 entries: count - 1 gaps
    const count = 1000;
    const heights = uniform(count, 80);
    const many = buildOffsets(heights, gap);
    expect(many.length).toBe(count + 1);
    expect(many[0]).toBe(0);

    for (let index = 1; index < count; index += 1) {
      // index starts after index - 1 heights plus index gaps
      const expected = index * 80 + index * gap;
      expect(many[index]).toBe(expected);
    }
    const expectedTotal = count * 80 + (count - 1) * gap;
    expect(many[count]).toBe(expectedTotal);
  });

  it("handles a 0-height entry and maintains monotonicity (non-strict if 0-height, strict if gap > 0)", () => {
    // With 0 gap, a 0-height entry makes offsets[i] == offsets[i+1]
    const flatWithZero = buildOffsets([50, 0, 50], 0);
    expect(flatWithZero[0]).toBe(0);
    expect(flatWithZero[1]).toBe(50);
    expect(flatWithZero[2]).toBe(50); // entry 1 had 0 height
    expect(flatWithZero[3]).toBe(100);

    // With gap > 0, gap separates entries even when height is 0, ensuring strict monotonicity
    const withGap = buildOffsets([50, 0, 50], 8);
    expect(withGap[0]).toBe(0);
    expect(withGap[1]).toBe(58); // 50 + 8
    expect(withGap[2]).toBe(66); // 50 + 8 + 0 + 8
    expect(withGap[3]).toBe(116); // 66 + 50
    for (let i = 1; i < withGap.length; i += 1) {
      expect(withGap[i]).toBeGreaterThan(withGap[i - 1]!);
    }
  });

  it("treats negative or non-finite heights as 0 height", () => {
    const offsets = buildOffsets([100, -50, Number.NaN, 200], 10);
    expect(offsets[0]).toBe(0);
    expect(offsets[1]).toBe(110); // 100 + 10
    expect(offsets[2]).toBe(120); // 110 + 0 + 10
    expect(offsets[3]).toBe(130); // 120 + 0 + 10
    expect(offsets[4]).toBe(330); // 130 + 200
  });
});

describe("indexAtOffset boundaries", () => {
  const heights = [100, 200, 300];
  const gap = 10;
  // offsets: [0, 110, 320, 620]
  const offsets = buildOffsets(heights, gap);

  it("evaluates at 0 and negative offsets", () => {
    expect(indexAtOffset(offsets, -50)).toBe(0);
    expect(indexAtOffset(offsets, 0)).toBe(0);
  });

  it("evaluates boundaries ±1px around each offset", () => {
    // entry 0: [0, 110)
    expect(indexAtOffset(offsets, 0)).toBe(0);
    expect(indexAtOffset(offsets, 109)).toBe(0);

    // boundary 110
    expect(indexAtOffset(offsets, 110)).toBe(1);
    expect(indexAtOffset(offsets, 111)).toBe(1);

    // boundary 320
    expect(indexAtOffset(offsets, 319)).toBe(1);
    expect(indexAtOffset(offsets, 320)).toBe(2);
    expect(indexAtOffset(offsets, 321)).toBe(2);
  });

  it("evaluates at offsets[count] and beyond the end", () => {
    const total = offsets[3]!; // 620
    expect(indexAtOffset(offsets, total - 1)).toBe(2);
    expect(indexAtOffset(offsets, total)).toBe(2);
    expect(indexAtOffset(offsets, total + 10_000)).toBe(2);
  });
});

describe("computeWindow and computeSegments invariants", () => {
  it("handles empty document (0 entries)", () => {
    const offsets = new Float64Array([0]);
    const window = computeWindow({ offsets, scrollTop: 0, viewportPx: 800, overscanPx: 800 });
    expect(window).toEqual({ start: 0, end: 0 });
    const segments = computeSegments({ offsets, visible: window });
    expect(segments).toEqual([]);
  });

  it("covers document shorter than the viewport", () => {
    const offsets = buildOffsets([100, 100, 100]);
    const window = computeWindow({ offsets, scrollTop: 0, viewportPx: 800, overscanPx: 800 });
    expect(window).toEqual({ start: 0, end: 3 });
  });

  it("correctly partitions window and pinned entries into disjoint segments", () => {
    const count = 1000;
    const offsets = buildOffsets(uniform(count, 100)); // total = 100,000

    // visible window in middle: scrollTop 50,000, viewport 800, overscan 200 -> covers roughly [498, 511]
    const visible = computeWindow({ offsets, scrollTop: 50_000, viewportPx: 800, overscanPx: 200 });
    expect(visible.start).toBeGreaterThan(400);
    expect(visible.end).toBeLessThan(600);

    // Case 1: Pinned entry at index 0 and last index (999)
    const pinned = [0, count - 1];
    const segments = computeSegments({ offsets, visible, pinned });
    expect(segments.length).toBe(3);
    expect(segments[0]).toEqual({ start: 0, end: 1 });
    expect(segments[1]).toEqual(visible);
    expect(segments[2]).toEqual({ start: 999, end: 1000 });

    // Assert disjointness
    for (let i = 1; i < segments.length; i += 1) {
      expect(segments[i]!.start).toBeGreaterThan(segments[i - 1]!.end);
    }

    // Case 2: Two adjacent pinned entries outside visible window
    const adjPinned = [10, 11];
    const adjSegments = computeSegments({ offsets, visible, pinned: adjPinned });
    // Should merge adjacent pins [10, 12)
    const foundMergedPin = adjSegments.find((s) => s.start === 10);
    expect(foundMergedPin).toEqual({ start: 10, end: 12 });

    // Case 3: A pinned entry spanning/touching visible window edge
    const touchingPinned = [visible.start - 1, visible.end];
    const touchingSegments = computeSegments({ offsets, visible, pinned: touchingPinned });
    // Touching entries merge into visible window segment!
    expect(touchingSegments.length).toBe(1);
    expect(touchingSegments[0]).toEqual({ start: visible.start - 1, end: visible.end + 1 });
  });

  it("guarantees no index is mounted more than once and union covers visible viewport", () => {
    const count = 500;
    const offsets = buildOffsets(uniform(count, 100));
    const scrollTop = 10_000;
    const viewportPx = 800;
    const visible = computeWindow({ offsets, scrollTop, viewportPx, overscanPx: 0 });
    const pinned = [0, 99, 100, 101, 499];
    const segments = computeSegments({ offsets, visible, pinned });

    const mountedIndices = new Set<number>();
    for (const seg of segments) {
      for (let idx = seg.start; idx < seg.end; idx += 1) {
        expect(mountedIndices.has(idx), `Index ${idx} mounted multiple times`).toBe(false);
        mountedIndices.add(idx);
      }
    }

    // Ensure all viewport indices are covered
    const firstViewportIdx = indexAtOffset(offsets, scrollTop);
    const lastViewportIdx = indexAtOffset(offsets, scrollTop + viewportPx);
    for (let idx = firstViewportIdx; idx <= lastViewportIdx; idx += 1) {
      expect(mountedIndices.has(idx), `Viewport index ${idx} not mounted`).toBe(true);
    }
  });
});

describe("spacerHeights and total document reconstruction", () => {
  it("reconstructs exact total offset with and without gap on 4,075 entries", () => {
    const count = 4075;
    // Varying heights to test float accumulation
    const heights = Array.from({ length: count }, (_, i) => 80 + (i % 37) * 3.5);
    const gapPx = 10;
    const offsets = buildOffsets(heights, gapPx);
    const total = offsets[count]!;

    // Test across various window positions
    const testTops = [0, 50_000, 150_000, total - 1000];
    for (const scrollTop of testTops) {
      const window = computeWindow({ offsets, scrollTop, viewportPx: 844, overscanPx: DEFAULT_OVERSCAN_PX });
      const spacers = spacerHeights(offsets, window, gapPx);

      // Model height of the mounted window range including internal gaps
      // Start of window is offsets[start], end of window is offsets[end]
      const windowModelSpan = offsets[window.end]! - offsets[window.start]!;

      // Check spacer reconstruction:
      // If window spans entire document, spacers are 0, windowModelSpan = total
      if (window.start === 0 && window.end === count) {
        expect(spacers.top).toBe(0);
        expect(spacers.bottom).toBe(0);
        expect(windowModelSpan).toBe(total);
      } else if (window.start === 0) {
        // Only bottom spacer rendered: bottom spacer subtracted 1 gap for spacer-entry boundary
        // total = windowModelSpan + (spacers.bottom + gap)
        expect(spacers.top).toBe(0);
        expect(Math.abs(windowModelSpan + spacers.bottom + gapPx - total)).toBeLessThan(1e-9);
      } else if (window.end === count) {
        // Only top spacer rendered: top spacer subtracted 1 gap
        expect(spacers.bottom).toBe(0);
        expect(Math.abs(spacers.top + gapPx + windowModelSpan - total)).toBeLessThan(1e-9);
      } else {
        // Both top and bottom spacers rendered: each subtracted 1 gap
        // total = (spacers.top + gap) + windowModelSpan + (spacers.bottom + gap)
        const reconstructed = spacers.top + gapPx + windowModelSpan + spacers.bottom + gapPx;
        expect(Math.abs(reconstructed - total)).toBeLessThan(1e-9);
      }
    }
  });
});

describe("estimateHeights propagation cap and scaling", () => {
  it("bounds borrowed estimates to PROPAGATION_CAP_FACTOR * fallback", () => {
    const count = 100;
    const measured: (number | undefined)[] = new Array(count).fill(undefined);
    measured[50] = 50_000; // Giant measured row
    const fallbacks = new Array(count).fill(92);

    const heights = estimateHeights(measured, fallbacks);

    expect(heights[50]).toBe(50_000);
    // Propagated to neighbors 49 and 51
    expect(heights[49]).toBe(92 * PROPAGATION_CAP_FACTOR);
    expect(heights[51]).toBe(92 * PROPAGATION_CAP_FACTOR);
  });

  it("scales down when total exceeds MAX_SCROLL_HEIGHT_PX while preserving relative monotonicity", () => {
    const count = 10_000;
    // Each row 5000px -> 50,000,000px total > 33,554,428px
    const heights = new Array(count).fill(5_000);
    const offsets = buildOffsets(heights, 10);

    const total = offsets[count]!;
    expect(total).toBeLessThanOrEqual(MAX_SCROLL_HEIGHT_PX);
    expect(total).toBeGreaterThan(MAX_SCROLL_HEIGHT_PX - 100);

    // Check strict monotonicity
    for (let i = 1; i <= count; i += 1) {
      expect(offsets[i]!).toBeGreaterThan(offsets[i - 1]!);
    }

    // Relative ordering matches input order
    expect(indexAtOffset(offsets, 0)).toBe(0);
    expect(indexAtOffset(offsets, total)).toBe(count - 1);
  });
});

describe("searchTranscript benchmark on ~10,000 synthetic entries", () => {
  it("indexes and finds a hit near the end of 10,000 entries and measures wall-clock", () => {
    const count = 10_000;
    const messages = Array.from({ length: count }, (_, i) => ({
      id: `msg-${i}`,
      role: i % 2 === 0 ? "user" : "assistant",
      text: `This is synthetic message content line 1 for item ${i}\nAdditional details with general text line 2.`,
    }));

    // Inject unique target near end
    messages[9995]!.text += "\nTargetUniqueKeywordXYZ found here";

    const t0 = performance.now();
    const index = buildSearchIndex(messages);
    const tIndex = performance.now();

    const t1 = performance.now();
    const results = searchTranscript(messages, "TargetUniqueKeywordXYZ", index);
    const tSearch = performance.now();

    const indexMs = (tIndex - t0).toFixed(2);
    const searchMs = (tSearch - t1).toFixed(2);

    // Print timing per task requirement
    console.log(`[searchTranscript benchmark] 10,000 messages: indexing = ${indexMs}ms, search = ${searchMs}ms`);

    expect(results.length).toBe(1);
    expect(results[0]?.id).toBe("msg-9995");
    expect(results[0]?.ordinal).toBe(9996);
    // When using pre-lowered search index, originalLines is null so excerpt uses cached lowered lines
    expect(results[0]?.excerpt).toContain("targetuniquekeywordxyz");
  });
});
