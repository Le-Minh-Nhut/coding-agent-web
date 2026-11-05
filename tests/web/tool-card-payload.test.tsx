// @vitest-environment jsdom
/**
 * A collapsed tool card must not hold its full text in the DOM: the body is
 * mounted on expand and unmounted on collapse. Everything else about the card
 * (preview, Copy, the full output) must survive that deferral.
 */
import React from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render } from "@testing-library/react";
import { MessageRow } from "../../apps/web/src/components/ConversationView.js";

const bigOutput = Array.from({ length: 2000 }, (_, index) => `line ${index} ${"x".repeat(40)}`).join("\n");

describe("collapsed tool cards defer their body", () => {
  afterEach(cleanup);

  it("mounts no body text while collapsed, and the whole output on expand", () => {
    const view = render(<MessageRow message={{ id: "t-1", role: "tool", text: bigOutput, toolName: "Large output" }} />);
    const details = view.container.querySelector("details")!;

    // Collapsed: the preview is there, the 80k-character body is not.
    expect(view.container.querySelector(".tool-output-preview")).not.toBeNull();
    expect(details.open).toBe(false);
    expect(view.container.querySelector("pre")).toBeNull();
    expect(view.container.textContent!.length).toBeLessThan(600);

    fireEvent.click(view.getByRole("button", { name: "Expand output" }));
    const body = view.container.querySelector("pre")!;
    expect(body).not.toBeNull();
    // Complete output, not a truncation: every sentinel line is present.
    expect(body.textContent).toBe(bigOutput);
    expect(body.textContent).toContain("line 1999");

    fireEvent.click(view.getByRole("button", { name: "Collapse output" }));
    expect(view.container.querySelector("pre")).toBeNull();
    expect(view.container.textContent!.length).toBeLessThan(600);
  });

  it("opens the body when the summary itself is activated, as a thumb would", () => {
    const view = render(<MessageRow message={{ id: "t-2", role: "tool", text: "SMALL_BODY_SENTINEL", toolName: "Small output" }} />);
    const details = view.container.querySelector("details")!;
    expect(view.container.querySelector("pre")).toBeNull();
    // jsdom does not implement <summary> activation behaviour, so toggle it the
    // way the browser ends up doing: set `open` and let onToggle fire.
    details.open = true;
    fireEvent(details, new Event("toggle", { bubbles: false }));
    expect(view.container.querySelector("pre")?.textContent).toBe("SMALL_BODY_SENTINEL");
  });

  it("keeps Copy reading the full text while collapsed", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText } });
    const view = render(<MessageRow message={{ id: "t-3", role: "tool", text: bigOutput, toolName: "Large output" }} />);

    fireEvent.click(view.getByRole("button", { name: "Copy output" }));
    expect(writeText).toHaveBeenCalledWith(bigOutput);
  });
});
