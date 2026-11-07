// @vitest-environment jsdom
import { render } from "@testing-library/react";
import React, { createRef } from "react";
import { describe, expect, it } from "vitest";
import { TranscriptList, type DisplayMessage } from "../../apps/web/src/components/MessageRow.js";
import { ScrollController } from "../../apps/web/src/scroll-controller.js";

interface AnchorDebugWindow {
  __trackAnchorCaptures?: boolean;
  __anchorCaptures?: number;
  __capturesPerCorrection?: number[];
  __anchorCorrectionDurations?: number[];
}

function makeScroller() {
  const element = document.createElement("div");
  Object.defineProperty(element, "clientHeight", { value: 800, configurable: true });
  Object.defineProperty(element, "scrollHeight", { value: 100_000, configurable: true });
  element.scrollTop = 5000;
  element.getBoundingClientRect = () => ({ top: 0, bottom: 800, left: 0, right: 390, width: 390, height: 800, x: 0, y: 0, toJSON: () => ({}) });
  const ref = createRef<HTMLDivElement>() as { current: HTMLDivElement | null };
  ref.current = element;
  return { element, ref };
}

describe("anchor capture counting", () => {
  it("counts exactly 1 captureAnchor call per committed correction in main branch", () => {
    const debugWin = window as unknown as AnchorDebugWindow;
    debugWin.__trackAnchorCaptures = true;
    debugWin.__anchorCaptures = 0;
    debugWin.__capturesPerCorrection = [];

    const { ref, element } = makeScroller();
    const rows1: DisplayMessage[] = Array.from({ length: 60 }, (_, i) => ({
      id: `m-${i}`,
      role: "user",
      text: `message content ${i}`,
    }));
    const controller = new ScrollController();
    const { rerender, container } = render(<TranscriptList rows={rows1} scrollElement={ref} controller={controller} />);

    // Mock getBoundingClientRect on all cards so they report stable non-zero heights and positions
    const mockCards = () => {
      container.querySelectorAll(".message-card").forEach((card, index) => {
        card.getBoundingClientRect = () => ({
          top: 50 + index * 40,
          bottom: 90 + index * 40,
          left: 0,
          right: 390,
          width: 390,
          height: 40,
          x: 0,
          y: 50 + index * 40,
          toJSON: () => ({}),
        });
      });
    };
    mockCards();

    // Enter READING_HISTORY mode
    controller.sync();
    element.scrollTop = 2000;
    controller.sync();

    // Capture anchor on current positions
    element.dispatchEvent(new Event("scroll"));

    debugWin.__capturesPerCorrection = [];
    // Trigger correction with cards still reporting positions
    rerender(<TranscriptList rows={[...rows1]} scrollElement={ref} controller={controller} />);
    mockCards();

    const perCorrection = debugWin.__capturesPerCorrection ?? [];
    expect(perCorrection.length).toBeGreaterThan(0);
    for (const count of perCorrection) {
      expect(count, "Each correction must invoke captureAnchor exactly once").toBe(1);
    }
  });

  it("does not yank scrollTop when assistant streams while reader is parked away from tail", async () => {
    const { ref, element } = makeScroller();
    Object.defineProperty(element, "scrollHeight", { value: 100_000, configurable: true });
    element.scrollTop = 70_000;

    const rows: DisplayMessage[] = Array.from({ length: 2000 }, (_, i) => ({
      id: `m-${i}`,
      role: i === 1999 ? "assistant" : "user",
      text: `message content ${i}`,
    }));
    const controller = new ScrollController();
    const { rerender } = render(<TranscriptList rows={rows} scrollElement={ref} controller={controller} />);

    // Follow tail at bottom (70,000)
    controller.sync();
    expect(controller.currentMode).toBe("FOLLOWING_TAIL");

    // Reader parks 3000px away from tail at 67,000
    element.scrollTop = 67_000;
    element.dispatchEvent(new Event("scroll"));

    // Allow rAF
    await new Promise((resolve) => setTimeout(resolve, 50));

    // A streaming update arrives for the tail message (row 1999)
    const updatedRows = [...rows];
    updatedRows[1999] = { id: "m-1999", role: "assistant", text: "streaming more text at tail..." };
    rerender(<TranscriptList rows={updatedRows} scrollElement={ref} controller={controller} />);

    // Position must be held, not yanked by missing-anchor correction
    expect(element.scrollTop).toBe(67_000);
  });

  it("does not drift when mounted rows are below the fold during capture and relayout occurs", () => {
    const { ref, element } = makeScroller();
    const rows: DisplayMessage[] = Array.from({ length: 60 }, (_, i) => ({
      id: `m-${i}`,
      role: "user",
      text: `message content ${i}`,
    }));
    const controller = new ScrollController();
    const { rerender, container } = render(
      <TranscriptList rows={rows} scrollElement={ref} controller={controller} />
    );

    // Position cards below fold (scroller top is 0; no row satisfies box.top <= 0 && box.bottom >= 0)
    let cardTop = 1200;
    const originalGBCR = HTMLElement.prototype.getBoundingClientRect;
    try {
      HTMLElement.prototype.getBoundingClientRect = function () {
        if (this === element) {
          return { top: 0, bottom: 800, left: 0, right: 390, width: 390, height: 800, x: 0, y: 0, toJSON: () => ({}) };
        }
        if (this.classList?.contains("message-card")) {
          return {
            top: cardTop,
            bottom: cardTop + 40,
            left: 0,
            right: 390,
            width: 390,
            height: 40,
            x: 0,
            y: cardTop,
            toJSON: () => ({}),
          };
        }
        return originalGBCR.call(this);
      };

      // Enter READING_HISTORY mode by moving away from tail
      controller.sync();
      element.scrollTop = 2000;
      controller.sync();
      expect(controller.follows).toBe(false);

      // Perform capture: all mounted cards report top >= 1200 (below fold, fold is 0)
      rerender(<TranscriptList rows={[...rows]} scrollElement={ref} controller={controller} />);

      const scrollBefore = element.scrollTop;

      // Simulate relayout between capture and correction: change mounted rows' getBoundingClientRect().top by ~1200px
      cardTop = 0;

      // Run correction effect
      rerender(<TranscriptList rows={[...rows]} scrollElement={ref} controller={controller} />);

      // Assert reader's scrollTop did not move
      expect(element.scrollTop).toBe(scrollBefore);
    } finally {
      HTMLElement.prototype.getBoundingClientRect = originalGBCR;
    }
  });
});
