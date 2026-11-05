// @vitest-environment jsdom
/**
 * A long user prompt auto-collapses to a bounded preview; a short one renders in
 * full with no controls. The threshold is the prompt's *rendered height*, not its
 * character count, so an 8-line paste collapses while a single wide line of the
 * same length does not.
 *
 * jsdom performs no layout, so this file supplies the answer the engine would
 * give: `scrollHeight`/`clientWidth`/`scrollWidth` are modelled from the element's
 * own text, and `scrollWidth` widens when the element does not carry
 * `overflow-wrap: anywhere` — which is exactly the rule that stops a single
 * 10,000-character token from forcing a horizontal scrollbar. The model is blunt
 * (fixed 40-character column, the same 21px line box the component falls back to);
 * the component's own logic is what these tests exercise.
 */
import React from "react";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi, type Mock } from "vitest";
import { cleanup, fireEvent, render } from "@testing-library/react";
import { CollapsibleMessage, FALLBACK_LINE_PX } from "../../apps/web/src/components/CollapsibleMessage.js";
import { renderMarkdown } from "../../apps/web/src/sanitize.js";

/** The modelled column: about what a 15px font fits across a 320px phone. */
const COLUMN_CHARS = 40;
/** Modelled glyph advance, used only when the wrap rule is absent (an overflow). */
const GLYPH_PX = 8;
const COLUMN_PX = 320;

function modelledLines(element: HTMLElement): number {
  const text = element.textContent ?? "";
  return text
    .split("\n")
    .reduce((lines, segment) => lines + Math.max(1, Math.ceil(segment.length / COLUMN_CHARS)), 0);
}

function widestToken(text: string): number {
  return text.split(/\s+/).reduce((widest, token) => Math.max(widest, token.length), 0);
}

const originals = new Map<string, PropertyDescriptor | undefined>();

function installLayoutModel(): void {
  for (const name of ["scrollHeight", "clientHeight", "clientWidth", "scrollWidth"]) {
    originals.set(name, Object.getOwnPropertyDescriptor(HTMLElement.prototype, name));
  }
  Object.defineProperty(HTMLElement.prototype, "scrollHeight", {
    configurable: true,
    get(this: HTMLElement) {
      return modelledLines(this) * FALLBACK_LINE_PX;
    },
  });
  Object.defineProperty(HTMLElement.prototype, "clientHeight", { configurable: true, get: () => 0 });
  Object.defineProperty(HTMLElement.prototype, "clientWidth", { configurable: true, get: () => COLUMN_PX });
  Object.defineProperty(HTMLElement.prototype, "scrollWidth", {
    configurable: true,
    get(this: HTMLElement) {
      // A browser only breaks mid-token when the text is allowed to wrap anywhere;
      // without that rule the widest token sets the content width and the column
      // overflows. Modelling that rule is what gives the overflow test its signal.
      if (getComputedStyle(this).overflowWrap === "anywhere") return COLUMN_PX;
      return COLUMN_PX + widestToken(this.textContent ?? "") * GLYPH_PX;
    },
  });
}

function restoreLayout(): void {
  for (const [name, descriptor] of originals) {
    if (descriptor) Object.defineProperty(HTMLElement.prototype, name, descriptor);
    else delete (HTMLElement.prototype as unknown as Record<string, unknown>)[name];
  }
}

beforeAll(installLayoutModel);
afterAll(restoreLayout);
afterEach(cleanup);

/** The full prompt body the component renders around; the clip is the bounded box. */
function clip(view: { container: HTMLElement }): HTMLElement {
  const element = view.container.querySelector<HTMLElement>(".collapsible-clip");
  if (element === null) throw new Error("collapsible clip not found");
  return element;
}

function toggle(view: { container: HTMLElement }): HTMLElement {
  const element = view.container.querySelector<HTMLElement>(".collapsible-toggle");
  if (element === null) throw new Error("collapsible toggle not found");
  return element;
}

function mockClipboard(writeText: Mock = vi.fn().mockResolvedValue(undefined)): Mock {
  Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText } });
  return writeText;
}

const prompt = (length: number, lines: number): string => {
  const per = Math.max(1, Math.floor(length / lines));
  return Array.from({ length: lines }, () => "x".repeat(per)).join("\n");
};

describe("CollapsibleMessage", () => {
  it("renders a short one-line prompt in full with no controls", () => {
    const text = "Fix the login bug in auth.ts";
    const view = render(
      <CollapsibleMessage text={text} identity="m-1">{text}</CollapsibleMessage>,
    );
    expect(clip(view).textContent).toBe(text);
    expect(view.container.querySelector(".collapsible-toggle")).toBeNull();
    expect(view.container.querySelector(".collapsible-copy")).toBeNull();
    expect(clip(view).style.maxHeight).toBe("");
  });

  it("collapses a five-line prompt to a bounded preview, then expands to the whole thing", () => {
    const text = prompt(100, 5);
    const view = render(
      <CollapsibleMessage text={text} identity="m-2">{text}</CollapsibleMessage>,
    );
    const body = clip(view);
    const button = toggle(view);
    // Nothing is removed from the DOM while collapsed: only the box is bounded.
    expect(body.textContent).toBe(text);
    expect(body.className).toContain("collapsible-clip");
    expect(body.classList.contains("expanded")).toBe(false);
    expect(Number.parseFloat(body.style.maxHeight)).toBeGreaterThan(0);
    expect(button.textContent).toBe("Show more");
    expect(button.getAttribute("aria-expanded")).toBe("false");
    expect(button.getAttribute("aria-controls")).toBe(body.id);
    expect(view.container.querySelector(".collapsible-copy")).toBeNull();

    fireEvent.click(button);

    expect(body.classList.contains("expanded")).toBe(true);
    expect(body.style.maxHeight).toBe("");
    expect(body.textContent).toBe(text);
    expect(toggle(view).textContent).toBe("Show less");
    expect(toggle(view).getAttribute("aria-expanded")).toBe("true");
    expect(view.container.querySelector(".collapsible-copy")?.textContent).toBe("Copy");
  });

  it("decides on rendered height, not character count", () => {
    // Same 120 characters. The line-broken one is eight rendered lines; the wide
    // one is three once the column wraps it. A character-count threshold cannot
    // tell these apart; a height threshold must.
    const tall = Array.from({ length: 8 }, () => "fifteen chars").join("\n");
    const wide = "fifteen chars ".repeat(8).trim();
    expect(tall.length).toBe(wide.length);

    const tallView = render(<CollapsibleMessage text={tall} identity="tall">{tall}</CollapsibleMessage>);
    const wideView = render(<CollapsibleMessage text={wide} identity="wide">{wide}</CollapsibleMessage>);

    expect(tallView.container.querySelector(".collapsible-toggle")).not.toBeNull();
    expect(wideView.container.querySelector(".collapsible-toggle")).toBeNull();
    expect(clip(wideView).textContent).toBe(wide);
  });

  it("honours collapsedLines by raising the preview bound", () => {
    // Six modelled lines: each line is exactly the modelled column width.
    const text = prompt(240, 6);
    const four = render(<CollapsibleMessage text={text} identity="l-4" collapsedLines={4}>{text}</CollapsibleMessage>);
    const eight = render(<CollapsibleMessage text={text} identity="l-8" collapsedLines={8}>{text}</CollapsibleMessage>);
    expect(Number.parseFloat(clip(four).style.maxHeight)).toBeGreaterThan(0);
    // Eight lines of preview covers this six-line prompt outright: nothing to disclose.
    expect(eight.container.querySelector(".collapsible-toggle")).toBeNull();
    expect(clip(eight).style.maxHeight).toBe("");
    expect(four.container.querySelector(".collapsible-toggle")).not.toBeNull();
  });

  it("collapses a 4,000-word prompt and exposes every word when expanded", () => {
    const words = Array.from({ length: 4000 }, (_, index) => `w${index}`);
    const text = words.join(" ");
    const view = render(<CollapsibleMessage text={text} identity="m-4k">{text}</CollapsibleMessage>);
    expect(view.container.querySelector(".collapsible-toggle")).not.toBeNull();
    fireEvent.click(toggle(view));
    expect(clip(view).textContent).toBe(text);
    expect(clip(view).textContent).toContain("w3999");
  });

  it("collapses a 10,000-word prompt and keeps the tail reachable", () => {
    const words = Array.from({ length: 10_000 }, (_, index) => `w${index}`);
    const text = words.join(" ");
    const view = render(<CollapsibleMessage text={text} identity="m-10k">{text}</CollapsibleMessage>);
    expect(toggle(view).getAttribute("aria-expanded")).toBe("false");
    fireEvent.click(toggle(view));
    expect(clip(view).textContent).toContain("w9999");
    expect(clip(view).textContent).toBe(text);
  });

  it("collapses a prompt containing a long URL without breaking it", () => {
    const url = `https://example.test/${"segment-".repeat(60)}?q=${"a".repeat(200)}`;
    const text = `Please read ${url} and summarize the findings in three bullets.`;
    const view = render(<CollapsibleMessage text={text} identity="m-url">{text}</CollapsibleMessage>);
    expect(view.container.querySelector(".collapsible-toggle")).not.toBeNull();
    fireEvent.click(toggle(view));
    expect(clip(view).textContent).toContain(url);
  });

  it("keeps a single 10,000-character unbroken string inside the column", () => {
    const text = "A".repeat(10_000);
    const view = render(<CollapsibleMessage text={text} identity="m-blob">{text}</CollapsibleMessage>);
    const container = view.container.querySelector<HTMLElement>(".collapsible");
    if (container === null) throw new Error("collapsible container not found");
    const body = clip(view);
    expect(toggle(view)).not.toBeNull();
    expect(body.scrollWidth).toBeLessThanOrEqual(container.clientWidth);
    expect(container.scrollWidth).toBeLessThanOrEqual(container.clientWidth);
    expect(body.scrollWidth).toBeLessThanOrEqual(body.clientWidth);
    // The guard is the wrap rule itself, so it is asserted directly too.
    expect(getComputedStyle(body).overflowWrap).toBe("anywhere");
    // Untouched: the whole string is still there to expand into and to copy.
    expect(body.textContent).toBe(text);
  });

  it("collapses a markdown table", () => {
    const text = ["| col | value |", "| --- | --- |", ...Array.from({ length: 20 }, (_, index) => `| row${index} | value-${index} |`)].join("\n");
    const view = render(<CollapsibleMessage text={text} identity="m-table">{renderMarkdown(text)}</CollapsibleMessage>);
    expect(view.container.querySelector(".collapsible-toggle")).not.toBeNull();
    fireEvent.click(toggle(view));
    expect(clip(view).querySelector("table")).not.toBeNull();
    expect(clip(view).textContent).toContain("row19");
  });

  it("collapses a large code block and copies its full source", () => {
    const code = Array.from({ length: 300 }, (_, index) => `const value${index} = ${index};`).join("\n");
    const markdown = ["Here is the helper:", "", "```ts", code, "```"].join("\n");
    const text = markdown;
    const writeText = mockClipboard();
    const view = render(<CollapsibleMessage text={text} identity="m-code">{renderMarkdown(text)}</CollapsibleMessage>);
    expect(view.container.querySelector(".collapsible-toggle")).not.toBeNull();
    fireEvent.click(toggle(view));
    const rendered = clip(view).querySelector("pre code")?.textContent ?? "";
    expect(rendered).toContain("const value299 = 299;");
    fireEvent.click(view.container.querySelector<HTMLElement>(".collapsible-copy")!);
    expect(writeText).toHaveBeenCalledWith(text);
  });

  it("collapses a JSON payload and copies it verbatim", () => {
    const text = JSON.stringify({ rows: Array.from({ length: 60 }, (_, index) => ({ index, name: `row ${index}` })) }, null, 2);
    const writeText = mockClipboard();
    const view = render(<CollapsibleMessage text={text} identity="m-json">{renderMarkdown(["```json", text, "```"].join("\n"))}</CollapsibleMessage>);
    expect(view.container.querySelector(".collapsible-toggle")).not.toBeNull();
    fireEvent.click(toggle(view));
    fireEvent.click(view.container.querySelector<HTMLElement>(".collapsible-copy")!);
    expect(writeText).toHaveBeenCalledWith(text);
    expect(clip(view).textContent).toContain("row 59");
  });

  it("collapses unicode text without mangling it", () => {
    const text = [
      "Kính gửi đội ngũ 👋",
      "Đây là một yêu cầu dài bằng tiếng Việt có dấu.",
      "देवनागरी पाठ भी शामिल है।",
      "混合中文文本，用于验证全角字符的换行。",
      "😀".repeat(40),
      "Ω≈ç√∫˜µ≤≥÷ — math and symbols",
    ].join("\n");
    const view = render(<CollapsibleMessage text={text} identity="m-uni">{text}</CollapsibleMessage>);
    expect(view.container.querySelector(".collapsible-toggle")).not.toBeNull();
    fireEvent.click(toggle(view));
    expect(clip(view).textContent).toBe(text);
    expect(clip(view).textContent).toContain("देवनागरी");
    expect(clip(view).textContent).toContain("😀");
  });

  it("expands two identical texts under different identities independently", () => {
    const text = prompt(200, 6);
    const view = render(
      <>
        <CollapsibleMessage text={text} identity="first">{text}</CollapsibleMessage>
        <CollapsibleMessage text={text} identity="second">{text}</CollapsibleMessage>
      </>,
    );
    const toggles = Array.from(view.container.querySelectorAll<HTMLElement>(".collapsible-toggle"));
    expect(toggles).toHaveLength(2);

    fireEvent.click(toggles[0]!);

    expect(toggles[0]!.getAttribute("aria-expanded")).toBe("true");
    expect(toggles[0]!.textContent).toBe("Show less");
    expect(toggles[1]!.getAttribute("aria-expanded")).toBe("false");
    expect(toggles[1]!.textContent).toBe("Show more");

    fireEvent.click(toggles[1]!);
    expect(toggles[0]!.getAttribute("aria-expanded")).toBe("true");
    expect(toggles[1]!.getAttribute("aria-expanded")).toBe("true");

    fireEvent.click(toggles[0]!);
    expect(toggles[0]!.getAttribute("aria-expanded")).toBe("false");
    expect(toggles[1]!.getAttribute("aria-expanded")).toBe("true");
  });

  it("keys expansion on the identity prop, not the component instance", () => {
    const text = prompt(200, 6);
    const view = render(<CollapsibleMessage text={text} identity="id-a">{text}</CollapsibleMessage>);
    fireEvent.click(toggle(view));
    expect(toggle(view).getAttribute("aria-expanded")).toBe("true");

    // Same instance, same position, same text: a new identity is a new message,
    // and inheriting the previous message's expansion would show the wrong state.
    view.rerender(<CollapsibleMessage text={text} identity="id-b">{text}</CollapsibleMessage>);
    expect(toggle(view).getAttribute("aria-expanded")).toBe("false");
    expect(clip(view).classList.contains("expanded")).toBe(false);

    view.rerender(<CollapsibleMessage text={text} identity="id-a">{text}</CollapsibleMessage>);
    fireEvent.click(toggle(view));
    view.rerender(<CollapsibleMessage text={text} identity="id-a">{text}</CollapsibleMessage>);
    expect(toggle(view).getAttribute("aria-expanded")).toBe("true");
  });

  it("copies the full original text, never the preview", async () => {
    const writeText = mockClipboard();
    const text = ["line one", "line two", "line three", "line four", "line five", "line six"].join("\n");
    const view = render(<CollapsibleMessage text={text} identity="m-copy">{text}</CollapsibleMessage>);
    expect(view.container.querySelector(".collapsible-copy")).toBeNull();
    fireEvent.click(toggle(view));
    const copy = view.container.querySelector<HTMLElement>(".collapsible-copy")!;
    fireEvent.click(copy);
    await vi.waitFor(() => expect(copy.textContent).toBe("Copied"));
    expect(writeText).toHaveBeenCalledWith(text);
  });

  it("reports a missing clipboard instead of staying silent", async () => {
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: undefined });
    const text = prompt(200, 6);
    const view = render(<CollapsibleMessage text={text} identity="m-noclip">{text}</CollapsibleMessage>);
    fireEvent.click(toggle(view));
    fireEvent.click(view.container.querySelector<HTMLElement>(".collapsible-copy")!);
    await vi.waitFor(() => expect(view.container.querySelector<HTMLElement>(".collapsible-copy")!.textContent).toBe("Copy failed"));
  });
});
