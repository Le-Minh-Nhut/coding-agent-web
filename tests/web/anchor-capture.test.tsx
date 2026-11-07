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
});
