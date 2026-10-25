import { describe, expect, it } from "vitest";
import {
  safeSrc,
  renderMarkdown,
} from "../../packages/guest/src/components/transcript/Markdown";

describe("Markdown renderer security hardening", () => {
  describe("safeSrc image URL allowlist", () => {
    it("accepts valid https image URLs", () => {
      expect(safeSrc("https://example.com/photo.png")).toBe(
        "https://example.com/photo.png",
      );
      expect(safeSrc("https://cdn.example.org/images/avatar.jpg?w=100")).toBe(
        "https://cdn.example.org/images/avatar.jpg?w=100",
      );
    });

    it("accepts valid base64 data: image URLs", () => {
      const png =
        "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";
      expect(safeSrc(png)).toBe(png);

      const jpeg = "data:image/jpeg;base64,/9j/4AAQSkZJRg==";
      expect(safeSrc(jpeg)).toBe(jpeg);
    });

    it("accepts origin-relative image URLs", () => {
      expect(safeSrc("./icon.png")).toBe("./icon.png");
      expect(safeSrc("/assets/logo.svg")).toBe("/assets/logo.svg");
    });

    it("rejects unencrypted http URLs", () => {
      expect(safeSrc("http://attacker.example/pixel.png")).toBeNull();
      expect(safeSrc("http://example.com/logo.png")).toBeNull();
    });

    it("rejects javascript: and control character tricks", () => {
      expect(safeSrc("javascript:alert(1)")).toBeNull();
      expect(safeSrc("JAVASCRIPT:alert(1)")).toBeNull();
      expect(safeSrc("\u0001javascript:alert(1)")).toBeNull();
      expect(safeSrc("  javascript:alert(1)  ")).toBeNull();
    });

    it("rejects file: and blob: schemes", () => {
      expect(safeSrc("file:///etc/passwd")).toBeNull();
      expect(safeSrc("blob:https://example.com/1234-5678")).toBeNull();
    });

    it("rejects non-image data: schemes (HTML, JS, etc.)", () => {
      expect(
        safeSrc("data:text/html;base64,PHNjcmlwdD5hbGVydCgxKTwvc2NyaXB0Pg=="),
      ).toBeNull();
      expect(
        safeSrc("data:application/javascript;base64,YWxlcnQoMSk="),
      ).toBeNull();
      expect(safeSrc("data:text/plain;base64,aGVsbG8=")).toBeNull();
    });
  });

  describe("renderMarkdown output checks", () => {
    it("renders safe https and data image markdown", () => {
      const httpsResult = renderMarkdown(
        "![my photo](https://example.com/pic.png)",
      );
      expect(httpsResult).toContain(
        '<img src="https://example.com/pic.png" alt="my photo"',
      );

      const dataPng =
        "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";
      const dataResult = renderMarkdown(`![pixel](${dataPng})`);
      expect(dataResult).toContain(`<img src="${dataPng}" alt="pixel"`);
    });

    it("does not render unsafe images (http, javascript, file, blob, data:html)", () => {
      const httpResult = renderMarkdown(
        "![beacon](http://attacker.com/px.png)",
      );
      expect(httpResult).not.toContain("<img");
      expect(httpResult).toContain("beacon");

      const jsResult = renderMarkdown("![xss](javascript:alert(1))");
      expect(jsResult).not.toContain("<img");
      expect(jsResult).not.toContain("javascript:");

      const fileResult = renderMarkdown("![leak](file:///etc/passwd)");
      expect(fileResult).not.toContain("<img");
      expect(fileResult).toContain("leak");

      const blobResult = renderMarkdown(
        "![blob](blob:https://example.com/uuid)",
      );
      expect(blobResult).not.toContain("<img");

      const dataHtmlResult = renderMarkdown(
        "![xss](data:text/html;base64,PHNjcmlwdD5hbGVydCgxKTwvc2NyaXB0Pg==)",
      );
      expect(dataHtmlResult).not.toContain("<img");
    });

    it("adds rel=noopener noreferrer to external links", () => {
      const linkResult = renderMarkdown("[click here](https://example.com)");
      expect(linkResult).toContain('target="_blank"');
      expect(linkResult).toContain('rel="noopener noreferrer"');
    });

    it("escapes raw html tags", () => {
      const rawHtml = renderMarkdown(
        'hello <img src="x" onerror="alert(1)"> world',
      );
      expect(rawHtml).toContain(
        "&lt;img src=&quot;x&quot; onerror=&quot;alert(1)&quot;&gt;",
      );
      expect(rawHtml).not.toContain("<img src=");
    });
  });
});
