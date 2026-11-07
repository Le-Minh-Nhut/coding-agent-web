/**
 * The tail state machine, without a browser.
 *
 * The machine's whole job is to say WHO moved `scrollTop`, so every test here states a
 * movement the way the real system makes it and asserts the resulting mode. Geometry is a
 * plain object — no layout, no jsdom, no timers — because the defect being fixed is a
 * classification error, not a rendering one.
 */
import { describe, expect, it } from "vitest";
import { ScrollController, type ScrollState, type ScrollSurface } from "../../apps/web/src/scroll-controller.js";

/** A stand-in scroller: `scrollTop` clamps to the range, exactly as an engine's does. */
interface FakeSurface extends ScrollSurface {
  setHeight: (height: number) => void;
  setTop: (top: number) => void;
  clampTo?: number;
}
function surface(options: { height: number; viewport: number; top?: number }): FakeSurface {
  let scrollTop = options.top ?? 0;
  let scrollHeight = options.height;
  const clientHeight = options.viewport;
  let clampTo: number | undefined;
  return {
    get scrollTop() { return scrollTop; },
    /**
     * Assigning past the maximum clamps, exactly as an engine does. Exposed as a plain
     * object so a test can produce a clamp without a real layout pass.
     */
    set scrollTop(value: number) {
      const maxReachable = clampTo !== undefined
        ? Math.min(clampTo, Math.max(0, scrollHeight - clientHeight))
        : Math.max(0, scrollHeight - clientHeight);
      scrollTop = Math.min(Math.max(0, value), maxReachable);
    },
    get scrollHeight() { return scrollHeight; },
    get clientHeight() { return clientHeight; },
    setHeight: (height: number) => { scrollHeight = height; scrollTop = Math.min(scrollTop, Math.max(0, scrollHeight - clientHeight)); },
    setTop: (top: number) => { scrollTop = top; },
    get clampTo() { return clampTo; },
    set clampTo(value: number | undefined) { clampTo = value; },
  };
}

function mount(height = 5000, viewport = 800): { el: FakeSurface; controller: ScrollController; states: ScrollState[] } {
  const el = surface({ height, viewport, top: height - viewport });
  const controller = new ScrollController();
  const states: ScrollState[] = [];
  controller.subscribe((state) => states.push(state));
  controller.attach(el);
  return { el, controller, states };
}

describe("reader intent is an unexplained movement, not an input event", () => {
  it("classifies a scripted offset assignment with a dispatched scroll as reader travel", () => {
    // Exactly the gesture in `tests/e2e/mobile.spec.ts`: no wheel, no touch, no keydown —
    // assign `scrollTop = 120` and dispatch `scroll`, from a followed tail at the bottom.
    const { el, controller } = mount();
    el.scrollTop = 120;
    controller.sync();
    const state = controller.state();
    expect(state.mode).toBe("READING_HISTORY");
    expect(state.canReturnToTail).toBe(true);
  });

  it("classifies it in the same observation, even when a measurement lands at the same moment", () => {
    // The race that killed the sixth attempt: the shrink is observed, then the document
    // grows again before the scroll event is delivered. The reader's offset is not the
    // maximum in either observation, so it is never mistaken for a clamp.
    const { el, controller } = mount();
    el.scrollTop = 120;
    controller.sync();
    expect(controller.state().mode).toBe("READING_HISTORY");
    el.setHeight(7000);
    controller.sync();
    expect(controller.state().canReturnToTail).toBe(true);
  });

  it("does not treat a shrink clamp as the reader", () => {
    const { el, controller } = mount(5000, 800);
    // Our write is clamped: the document shrinks before the engine recomputes its maximum.
    el.setHeight(3000);
    el.scrollTop = 100_000;
    controller.sync();
    const state = controller.state();
    expect(state.mode).toBe("FOLLOWING_TAIL");
    expect(state.canReturnToTail).toBe(false);
  });

  it("keeps following when measurements shrink the document under a stationary reader", () => {
    const { el, controller } = mount(5000, 800);
    el.setHeight(4000); // the engine clamps the offset to 3200
    controller.sync();
    expect(el.scrollTop).toBe(3200);
    expect(controller.state().mode).toBe("FOLLOWING_TAIL");
  });
});

describe("invariant 1: a reader who left the tail is never forced back", () => {
  it("ignores arriving content", () => {
    const { el, controller } = mount();
    el.scrollTop = 1000;
    controller.sync();
    const detachedAt = el.scrollTop;
    el.setHeight(6000); // a new message lands below the reader
    controller.pin();
    controller.sync();
    expect(el.scrollTop).toBe(detachedAt);
    expect(controller.state().canReturnToTail).toBe(true);
  });
});

describe("invariant 2: following keeps the newest content visible through measurement", () => {
  it("re-pins when the document grows under a stationary reader", () => {
    const { el, controller } = mount(5000, 800);
    el.setHeight(7000);
    controller.pin();
    controller.sync();
    expect(el.scrollTop).toBe(el.scrollHeight - el.clientHeight);
    expect(controller.state().mode).toBe("FOLLOWING_TAIL");
  });

  it("re-pins when a height estimate is corrected", () => {
    const { el, controller } = mount(120_000, 800);
    el.setHeight(96_000);
    controller.sync();
    expect(el.scrollHeight - el.clientHeight - el.scrollTop).toBe(0);
  });
});

describe("invariant 5: Latest reaches the newest entry even after estimates change", () => {
  it("returns to the tail and keeps following late measurements", () => {
    const { el, controller } = mount();
    el.scrollTop = 500;
    controller.sync();
    controller.returnToTail();
    expect(controller.state().mode).toBe("FOLLOWING_TAIL");
    expect(el.scrollTop).toBe(el.scrollHeight - el.clientHeight);
    el.setHeight(9000);
    controller.pin();
    expect(el.scrollTop).toBe(9000 - 800);
  });

  it("stays armed while a return is short of the bottom", () => {
    const { el, controller } = mount(10_000, 800);
    el.scrollTop = 2000;
    controller.sync();
    expect(controller.state().mode).toBe("READING_HISTORY");

    // A viewport whose document is still growing: the engine accepts only part of the jump.
    el.clampTo = 9000;
    controller.returnToTail();
    expect(controller.currentMode).toBe("RETURNING_TO_TAIL");
    expect(controller.state().canReturnToTail).toBe(false);

    // and after the document settles, the next pin reaches the tail
    el.clampTo = undefined;
    controller.pin();
    expect(controller.currentMode).toBe("FOLLOWING_TAIL");
  });
});

describe("invariant 4: new messages never move a reader in history", () => {
  it("holds the offset across a prepend restore", () => {
    const { el, controller } = mount(5000, 800);
    el.scrollTop = 2000;
    controller.sync();
    // Older history is prepended above the reader: the document grows and the offset must
    // follow the content, not the top of the document.
    const anchor = { top: el.scrollTop, height: el.scrollHeight };
    el.setHeight(5800);
    controller.restoreAfterPrepend(anchor);
    expect(el.scrollTop).toBe(2800);
    expect(controller.state().mode).toBe("READING_HISTORY");
  });
});

describe("clamps are a fact of the write, not a reconstruction", () => {
  it("records a short landing as ours and does not read it as a flick", () => {
    const { el, controller } = mount(5000, 800);
    // Force a write whose landing is short: the document shrinks between the read and
    // the assignment.
    const write = controller as unknown as { write: (target: number) => number };
    el.setHeight(3000);
    el.scrollTop = 2200; // the engine's own clamp of the requested 4200
    const landed = write.write.call(controller, 4200);
    expect(landed).toBe(2200);
    controller.sync();
    expect(controller.state().mode).toBe("FOLLOWING_TAIL");
  });
});

describe("convergence", () => {
  it("publishes nothing when the state did not change", () => {
    const { el, controller, states } = mount();
    const before = states.length;
    for (let index = 0; index < 10; index += 1) controller.sync();
    expect(states.length).toBe(before);
    expect(el.scrollTop).toBe(el.scrollHeight - el.clientHeight);
  });

  it("does not oscillate between modes across repeated observations", () => {
    const { el, controller } = mount();
    el.scrollTop = 1000;
    controller.sync();
    const settled = controller.currentMode;
    el.setHeight(6000);
    for (let index = 0; index < 20; index += 1) controller.sync();
    expect(controller.currentMode).toBe(settled);
    expect(el.scrollTop).toBe(1000);
  });
});
