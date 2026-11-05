// @vitest-environment jsdom
/**
 * A collapsed tool card must not hold its full text in the DOM: the body is
 * mounted on expand and unmounted on collapse. Everything else about the card
 * (preview, Copy, the full output) must survive that deferral.
 *
 * The card moved from an inline `<details>` card to the grouped activity row
 * (`apps/web/src/components/ToolActivity.tsx`), so the assertions drive the new
 * control — but each one still tests the same behaviour: no body while
 * collapsed, the whole output once expanded, and Copy reading the full text
 * regardless of what is mounted.
 */
import React from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render } from "@testing-library/react";
import { ToolRow } from "../../apps/web/src/components/ToolActivity.js";
import { MessageRow } from "../../apps/web/src/components/ConversationView.js";

const bigOutput = Array.from({ length: 2000 }, (_, index) => `line ${index} ${"x".repeat(40)}`).join("\n");
const pairedArgs = new Map<string, Record<string, unknown>>();

/** The row's own disclosure control, by accessible role rather than class. */
function head(view: { container: HTMLElement }): HTMLElement {
  const element = view.container.querySelector(".tool-row-head");
  if (element === null) throw new Error("tool row head not found");
  return element as HTMLElement;
}

describe("collapsed tool cards defer their body", () => {
  afterEach(cleanup);

  it("mounts no body text while collapsed, and the whole output on expand", () => {
    const view = render(<ToolRow row={{ id: "t-1", role: "tool", text: bigOutput, toolName: "Large output" }} pairedArgs={pairedArgs} />);

    // Collapsed: the preview is there, the 80k-character body is not.
    expect(view.container.querySelector(".tool-output-preview")).not.toBeNull();
    expect(view.container.querySelector(".tool-body")).toBeNull();
    expect(view.container.textContent!.length).toBeLessThan(600);

    fireEvent.click(head(view));
    const body = view.container.querySelector(".tool-raw-output");
    expect(body).not.toBeNull();
    // Complete output, not a truncation: every sentinel line is present.
    expect(body!.textContent).toBe(bigOutput);
    expect(body!.textContent).toContain("line 1999");

    fireEvent.click(head(view));
    expect(view.container.querySelector(".tool-raw-output")).toBeNull();
    expect(view.container.textContent!.length).toBeLessThan(600);
  });

  it("opens the body when the row's own control is activated, as a thumb would", () => {
    const view = render(<ToolRow row={{ id: "t-2", role: "tool", text: "SMALL_BODY_SENTINEL", toolName: "Small output" }} pairedArgs={pairedArgs} />);
    expect(view.container.querySelector(".tool-raw-output")).toBeNull();
    expect(head(view).getAttribute("aria-expanded")).toBe("false");
    fireEvent.click(head(view));
    expect(head(view).getAttribute("aria-expanded")).toBe("true");
    expect(view.container.querySelector(".tool-raw-output")?.textContent).toBe("SMALL_BODY_SENTINEL");
  });

  it("keeps Copy reading the full text while collapsed", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText } });
    // A row with no structured result renders the raw text in full, which is what
    // Copy reads; the collapsed preview must not be what reaches the clipboard.
    const view = render(<ToolRow row={{ id: "t-3", role: "tool", text: bigOutput, toolName: "Large output" }} pairedArgs={pairedArgs} />);
    fireEvent.click(head(view));
    fireEvent.click(view.getByRole("button", { name: "Copy output" }));
    expect(writeText).toHaveBeenCalledWith(bigOutput);
  });

  it("keeps the message-card preview and Copy for an ungrouped tool row", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText } });
    const view = render(<MessageRow message={{ id: "t-4", role: "tool", text: bigOutput, toolName: "Large output" }} />);
    expect(view.container.querySelector(".tool-output-preview")).not.toBeNull();
    fireEvent.click(view.getByRole("button", { name: "Copy output" }));
    expect(writeText).toHaveBeenCalledWith(bigOutput);
  });
});
