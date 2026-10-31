// @vitest-environment jsdom
/**
 * RENDER-01/02/03 regressions.
 *
 * - RENDER-01: a search source URL must never become a clickable anchor with a
 *   non-http(s) scheme.
 * - RENDER-02: only raster MIME types may become an `<img>`/blob; SVG (scriptable)
 *   and text/html must degrade to a text note.
 * - RENDER-03: malformed `result.content` entries must not throw out of the
 *   shared extractors, and a renderer that throws must degrade that card.
 */
import { describe, expect, it } from "vitest";
import { render } from "@testing-library/react";
import { Transcript } from "../../packages/guest/src/components/transcript/Transcript";
import { ToolView } from "../../packages/guest/src/tool-render/ToolView";
import { ResultImages } from "../../packages/guest/src/tool-render/parts";
import { webSearchRenderer } from "../../packages/guest/src/tool-render/tools/web-search";
import {
  resultImagesOf,
  resultTextOf,
} from "../../packages/guest/src/tool-render/util";
import type { ToolResultLike } from "../../packages/guest/src/tool-render/types";

function searchResult(sources: unknown[]): ToolResultLike {
  return {
    content: [{ type: "text", text: "answer" }],
    details: { response: { sources } },
  } as unknown as ToolResultLike;
}

function renderSearch(sources: unknown[]): HTMLElement {
  const { container } = render(
    <webSearchRenderer.Body
      name="web_search"
      args={{ query: "q" }}
      result={searchResult(sources)}
    />,
  );
  return container;
}

describe("RENDER-01 web search source links", () => {
  it("renders an untrusted javascript: source as plain text, never an anchor", () => {
    const container = renderSearch([
      { url: "javascript:alert(document.cookie)", title: "Evil" },
    ]);
    expect(container.querySelectorAll("a").length).toBe(0);
    expect(container.textContent).toContain("Evil");
  });

  it("renders data: and vbscript: sources as plain text too", () => {
    const container = renderSearch([
      { url: "data:text/html,<script>alert(1)</script>", title: "Data" },
      { url: "vbscript:msgbox(1)", title: "Vbs" },
    ]);
    expect(container.querySelectorAll("a").length).toBe(0);
    expect(container.textContent).toContain("Data");
    expect(container.textContent).toContain("Vbs");
  });

  it("keeps a legitimate https source clickable and adds noopener", () => {
    const container = renderSearch([
      { url: "https://example.com/a?b=1", title: "Good" },
    ]);
    const a = container.querySelector("a");
    expect(a).not.toBeNull();
    expect(a!.getAttribute("href")).toBe("https://example.com/a?b=1");
    expect(a!.getAttribute("target")).toBe("_blank");
    expect(a!.getAttribute("rel")).toContain("noopener");
  });
});

describe("RENDER-02 image MIME allowlist", () => {
  const png = { type: "image", data: "AAAA", mimeType: "image/png" };
  const svg = { type: "image", data: "AAAA", mimeType: "image/svg+xml" };
  const html = { type: "image", data: "AAAA", mimeType: "text/html" };

  it("accepts raster MIME types and rejects SVG/HTML in resultImagesOf", () => {
    const result = { content: [png, svg, html] } as unknown as ToolResultLike;
    const images = resultImagesOf(result);
    expect(images.map((i) => i.mimeType)).toEqual(["image/png"]);
  });

  it("renders a non-raster block as a text note instead of an <img> blob", () => {
    const result = { content: [svg] } as unknown as ToolResultLike;
    const { container } = render(<ResultImages result={result} />);
    expect(container.querySelectorAll("img").length).toBe(0);
    expect(container.textContent).toMatch(/svg\+xml|not displayable|unsupported/i);
  });

  it("still renders raster thumbnails with a data: URL", () => {
    const result = { content: [png] } as unknown as ToolResultLike;
    const { container } = render(<ResultImages result={result} />);
    const img = container.querySelector("img");
    expect(img).not.toBeNull();
    expect(img!.getAttribute("src")).toBe("data:image/png;base64,AAAA");
  });

  function renderTranscriptImage(mimeType: string): HTMLElement {
    const entries = [
      {
        id: "e1",
        type: "message",
        timestamp: 0,
        message: { role: "user", content: [{ type: "image", data: "AAAA", mimeType }] },
      },
    ] as never;
    const { container } = render(
      <Transcript
        entries={entries}
        stream={null}
        streamDone
        activeTools={new Map()}
        working={false}
      />,
    );
    return container;
  }

  it("renders a raster message attachment as an <img> data URL", () => {
    const container = renderTranscriptImage("image/png");
    expect(container.querySelector("img")?.getAttribute("src")).toBe(
      "data:image/png;base64,AAAA",
    );
  });

  it("degrades a non-raster message attachment to a text note, never an <img>", () => {
    // SVG inside <img> does not execute — this is a consistency gap with the
    // tool-result policy in parts.tsx, not a script-execution hole.
    const svgContainer = renderTranscriptImage("image/svg+xml");
    expect(svgContainer.querySelectorAll("img").length).toBe(0);
    expect(svgContainer.textContent).toMatch(/svg\+xml|not displayed/i);

    const unknownContainer = renderTranscriptImage("application/octet-stream");
    expect(unknownContainer.querySelectorAll("img").length).toBe(0);
    expect(unknownContainer.textContent).toMatch(/not displayed/i);
  });
});

describe("RENDER-03 malformed result blocks and renderer failures", () => {
  it("resultTextOf tolerates null and primitive content entries", () => {
    const result = {
      content: [null, 42, "raw", undefined, { type: "text", text: "ok" }],
    } as unknown as ToolResultLike;
    expect(() => resultTextOf(result)).not.toThrow();
    expect(resultTextOf(result)).toBe("ok");
  });

  it("resultImagesOf tolerates null and primitive content entries", () => {
    const result = {
      content: [null, 7, "x", { type: "image", data: "AAAA", mimeType: "image/png" }],
    } as unknown as ToolResultLike;
    expect(() => resultImagesOf(result)).not.toThrow();
    expect(resultImagesOf(result).length).toBe(1);
  });

  it("renders a transcript row with a null content block instead of throwing", () => {
    const entries = [
      {
        id: "e1",
        type: "message",
        timestamp: 0,
        message: { role: "user", content: [null, { type: "text", text: "hello" }] },
      },
      {
        id: "e2",
        type: "message",
        timestamp: 1,
        message: { role: "assistant", content: [null, 5] },
      },
    ] as never;
    expect(() =>
      render(
        <Transcript
          entries={entries}
          stream={null}
          streamDone
          activeTools={new Map()}
          working={false}
        />,
      ),
    ).not.toThrow();
  });

  it("degrades a throwing renderer to an error line instead of blanking the card", () => {
    // `Object.keys` on this proxy throws; the generic summary calls it.
    const boomArgs = new Proxy({}, { ownKeys: () => { throw new Error("boom"); } });
    let container!: HTMLElement;
    expect(() => {
      container = render(<ToolView name="mystery_tool" args={boomArgs} />).container;
    }).not.toThrow();
    expect(container.textContent).toMatch(/failed|error/i);
  });
});
