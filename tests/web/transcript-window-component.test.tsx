// @vitest-environment jsdom
/**
 * The window in the component, where the invariant that matters lives.
 *
 * jsdom has no layout: every element reports height 0, and `ResizeObserver` never
 * fires. So this file asserts the things that are true regardless of geometry —
 * that a mounted DOM is bounded by the window rather than by the conversation, that
 * nothing is dropped from `rows`, and that every message stays reachable by identity
 * through the list's own API. Pixel correctness is proven in the browser passes
 * (`tests/e2e/perf-scroll-gates.spec.ts`), never here.
 *
 * The zero-height environment is not a nuisance here, it is the interesting case: it
 * is exactly what a pre-layout render looks like, and a window that mounts nothing
 * when heights are unknown would blank the screen on the first frame.
 */
import { act, render } from "@testing-library/react";
import { createRef } from "react";
import { describe, expect, it } from "vitest";
import { TranscriptList, type DisplayMessage, type TranscriptListApi } from "../../apps/web/src/components/MessageRow.js";

function rows(count: number): DisplayMessage[] {
  return Array.from({ length: count }, (_, index) => ({
    id: `m-${index}`,
    role: index % 2 === 0 ? "user" : "assistant",
    text: `message ${index}`,
  }));
}

/** A stand-in scroller: jsdom's layout is all zeros, so the geometry is stubbed here. */
function scroller(): { element: HTMLDivElement; ref: { current: HTMLDivElement | null } } {
  const element = document.createElement("div");
  Object.defineProperty(element, "clientHeight", { value: 800, configurable: true });
  Object.defineProperty(element, "scrollHeight", { value: 100_000, configurable: true });
  element.scrollTop = 0;
  element.getBoundingClientRect = () => ({ top: 0, bottom: 800, left: 0, right: 390, width: 390, height: 800, x: 0, y: 0, toJSON: () => ({}) });
  const ref = createRef<HTMLDivElement>() as { current: HTMLDivElement | null };
  ref.current = element;
  return { element, ref };
}

describe("a long transcript is bounded in the document", () => {
  it("mounts a window instead of 8,000 rows, and still carries all 8,000", () => {
    const list = rows(8000);
    const { ref } = scroller();
    const { container } = render(<TranscriptList rows={list} scrollElement={ref} />);
    const mounted = container.querySelectorAll(".message-card").length;
    // Bounded by the viewport, not by the conversation: this is the whole point.
    expect(mounted).toBeGreaterThan(0);
    expect(mounted).toBeLessThan(200);
    // And the first row is present, because the first paint is scrolled to the top.
    expect(container.textContent).toContain("message 0");
  });

  it("tells a screen reader the real total and this row's real rank", () => {
    const list = rows(8000);
    const { ref } = scroller();
    const { container } = render(<TranscriptList rows={list} scrollElement={ref} />);
    const first = container.querySelector("[aria-posinset]");
    expect(first).not.toBeNull();
    // The honest answer, not "1 of 27 mounted".
    expect(first?.getAttribute("aria-setsize")).toBe("8000");
    expect(first?.getAttribute("aria-posinset")).toBe("1");
  });

  it("keeps the simple full-render path when no scroller is supplied", () => {
    // `AgentChat` and the component tests render without a scroller; that path must
    // not change behaviour, because a caller with its own windowing owns the DOM.
    const { container } = render(<TranscriptList rows={rows(300)} />);
    expect(container.querySelectorAll(".message-card").length).toBe(300);
  });

  it("keeps a short conversation on the simple path even with a scroller", () => {
    const { ref } = scroller();
    const { container } = render(<TranscriptList rows={rows(10)} scrollElement={ref} />);
    expect(container.querySelectorAll(".message-card").length).toBe(10);
  });
});

describe("nothing becomes unreachable", () => {
  it("exposes an imperative reveal that mounts an entry far outside the window", () => {
    const list = rows(8000);
    const { ref } = scroller();
    const api = createRef() as { current: TranscriptListApi | null };
    const { container } = render(<TranscriptList rows={list} scrollElement={ref} apiRef={api as never} />);
    // Before the jump, the last message is not mounted — that is the premise.
    expect(container.textContent).not.toContain("message 7999");
    act(() => { api.current?.scrollToIdentity("m-7999"); });
    // After it, it is: search jumps and deep links go through exactly this path.
    expect(container.textContent).toContain("message 7999");
  });

  it("keeps a pinned entry mounted when it is nowhere near the viewport", () => {
    const list = rows(8000);
    const { ref } = scroller();
    const pinned = new Set(["m-6000"]);
    const { container } = render(<TranscriptList rows={list} scrollElement={ref} pinnedIdentities={pinned} />);
    // A failed row or an action the user must take cannot be a scroll away from
    // existing; it is force-mounted by identity, not by position.
    expect(container.textContent).toContain("message 6000");
  });

  it("marks the list busy while mounted rows are still unmeasured", () => {
    const { ref } = scroller();
    const { container } = render(<TranscriptList rows={rows(8000)} scrollElement={ref} />);
    // jsdom never measures, so the honest state here is "still estimating".
    expect(container.querySelector('[role="list"]')?.getAttribute("aria-busy")).toBe("true");
  });
});

describe("the DOM it produces is the same document it always was", () => {
  it("wraps each entry around exactly one card, so the card stays the flex item", () => {
    const { ref } = scroller();
    const { container } = render(<TranscriptList rows={rows(8000)} scrollElement={ref} />);
    const entry = container.querySelector(".transcript-entry");
    expect(entry).not.toBeNull();
    // The wrapper must carry the card itself, one level down, and nothing else: the
    // transcript's flex gap and each card's `align-self` (the user bubble's right
    // alignment) both apply to that card, and an extra box here would break both.
    // The computed `display: contents` that makes this true lives in `styles.css`,
    // which jsdom does not load — the browser passes assert the rendered geometry.
    expect(entry?.children).toHaveLength(1);
    expect(entry?.firstElementChild?.classList.contains("message-card")).toBe(true);
  });
});
