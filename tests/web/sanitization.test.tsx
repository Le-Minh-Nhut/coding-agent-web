// @vitest-environment jsdom
import { describe, it, expect } from "vitest";
import { render } from "@testing-library/react";
import { renderMarkdown } from "../../apps/web/src/sanitize.js";

describe("Markdown & URL sanitization", () => {
  it("renders inert output for dangerous links, raw html img with onerror, and file:// links", () => {
    const maliciousInput = [
      "Here is a malicious link: [Exploit](javascript:alert(1))",
      "Here is a local file leak: [Passwd](file:///etc/passwd)",
      "Here is an injected tag: <img src=x onerror=alert(1)>",
      "Here is a safe link: [Safe](https://example.com)",
      "Here is an inline code: `const x = 1;`",
    ].join("\n\n");

    const { container } = render(renderMarkdown(maliciousInput));

    // 1. Assert DOM has no element with href containing javascript:
    const jsLinks = container.querySelectorAll('a[href*="javascript:"]');
    expect(jsLinks.length).toBe(0);

    // 2. Assert DOM has no element with href containing file:
    const fileLinks = container.querySelectorAll('a[href*="file:"]');
    expect(fileLinks.length).toBe(0);

    // 3. Assert DOM has no element with onerror attribute or executable attribute
    const allElements = container.querySelectorAll("*");
    for (const el of allElements) {
      expect(el.hasAttribute("onerror")).toBe(false);
      expect(el.hasAttribute("onload")).toBe(false);
      expect(el.hasAttribute("onclick")).toBe(false);
      expect(el.getAttribute("src") ?? "").not.toContain("javascript:");
    }

    // 4. Assert safe https:// link rendered properly
    const safeLink = container.querySelector('a[href="https://example.com"]');
    expect(safeLink).not.toBeNull();
    expect(safeLink?.textContent).toBe("Safe");

    // 5. Assert the dangerous link text is still rendered as inert text
    expect(container.textContent).toContain("Exploit");
    expect(container.textContent).toContain("Passwd");
  });
});
