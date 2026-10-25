/**
 * Allowlist-based Markdown renderer & URL sanitizer.
 * Enforces strict URL scheme gates:
 * - Links: https: ONLY
 * - Images: https: and data:image/ ONLY
 * - Raw HTML tags are escaped to prevent XSS (no script, no onerror, no event handlers).
 */

import React from "react";

export function sanitizeUrl(url: string, isImage = false): string | null {
  const trimmed = url.trim();
  if (isImage) {
    if (trimmed.startsWith("https://") || trimmed.startsWith("data:image/")) {
      return trimmed;
    }
    return null;
  }
  if (trimmed.startsWith("https://")) {
    return trimmed;
  }
  return null;
}

export function escapeHtml(text: string): string {
  return text
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

export interface MarkdownNode {
  type: "text" | "bold" | "italic" | "code" | "link" | "image";
  content?: string;
  url?: string;
  alt?: string;
  children?: MarkdownNode[];
}

export function parseInline(text: string): React.ReactNode[] {
  const elements: React.ReactNode[] = [];
  let remaining = text;
  let keyIndex = 0;

  while (remaining.length > 0) {
    // Inline code `code`
    const codeMatch = remaining.match(/^`([^`]+)`/);
    if (codeMatch && codeMatch[1]) {
      elements.push(React.createElement("code", { key: keyIndex++ }, codeMatch[1]));
      remaining = remaining.slice(codeMatch[0].length);
      continue;
    }

    // Image ![alt](url)
    const imgMatch = remaining.match(/^!\[([^\]]*)\]\(([^)]+)\)/);
    if (imgMatch && imgMatch[1] !== undefined && imgMatch[2]) {
      const safeSrc = sanitizeUrl(imgMatch[2], true);
      if (safeSrc) {
        elements.push(
          React.createElement("img", {
            key: keyIndex++,
            src: safeSrc,
            alt: imgMatch[1],
            loading: "lazy",
            style: { maxWidth: "100%", borderRadius: "4px" },
          })
        );
      } else {
        // Render inert placeholder text for rejected schemes
        elements.push(React.createElement("span", { key: keyIndex++ }, `[Image: ${imgMatch[1]}]`));
      }
      remaining = remaining.slice(imgMatch[0].length);
      continue;
    }

    // Link [label](url)
    const linkMatch = remaining.match(/^\[([^\]]+)\]\(([^)]+)\)/);
    if (linkMatch && linkMatch[1] && linkMatch[2]) {
      const safeHref = sanitizeUrl(linkMatch[2], false);
      if (safeHref) {
        elements.push(
          React.createElement(
            "a",
            {
              key: keyIndex++,
              href: safeHref,
              target: "_blank",
              rel: "noopener noreferrer",
              style: { color: "var(--primary)", textDecoration: "underline" },
            },
            linkMatch[1]
          )
        );
      } else {
        // Inert text for rejected schemes (never javascript:, file:, blob:)
        elements.push(React.createElement("span", { key: keyIndex++ }, linkMatch[1]));
      }
      remaining = remaining.slice(linkMatch[0].length);
      continue;
    }

    // Bold **text**
    const boldMatch = remaining.match(/^\*\*([^*]+)\*\*/);
    if (boldMatch && boldMatch[1]) {
      elements.push(React.createElement("strong", { key: keyIndex++ }, parseInline(boldMatch[1])));
      remaining = remaining.slice(boldMatch[0].length);
      continue;
    }

    // Italic *text*
    const italicMatch = remaining.match(/^\*([^*]+)\*/);
    if (italicMatch && italicMatch[1]) {
      elements.push(React.createElement("em", { key: keyIndex++ }, parseInline(italicMatch[1])));
      remaining = remaining.slice(italicMatch[0].length);
      continue;
    }

    // Plain text slice up to next formatting character or end
    const nextSpecial = remaining.search(/[`!\[*]/);
    if (nextSpecial === -1) {
      elements.push(remaining);
      break;
    }
    if (nextSpecial === 0) {
      // Unmatched special char, consume 1 char as plain text
      elements.push(remaining[0]);
      remaining = remaining.slice(1);
    } else {
      elements.push(remaining.slice(0, nextSpecial));
      remaining = remaining.slice(nextSpecial);
    }
  }

  return elements;
}

export function renderMarkdown(markdown: string): React.ReactNode {
  const lines = markdown.replace(/\r\n/g, "\n").split("\n");
  const blocks: React.ReactNode[] = [];
  let blockIndex = 0;

  const isUnorderedItem = (line: string): boolean => /^\s*[-*+]\s+/.test(line);
  const isOrderedItem = (line: string): boolean => /^\s*\d+[.)]\s+/.test(line);
  const isTableSeparator = (line: string): boolean =>
    line.split("|").some((cell) => cell.trim() !== "") &&
    line.split("|").filter((cell) => cell.trim() !== "").every((cell) => /^:?-{3,}:?$/.test(cell.trim()));
  const tableCells = (line: string): string[] => {
    const trimmed = line.trim().replace(/^\|/, "").replace(/\|$/, "");
    return trimmed.split("|").map((cell) => cell.trim());
  };
  const isTable = (index: number): boolean =>
    index + 1 < lines.length && lines[index]!.includes("|") && isTableSeparator(lines[index + 1]!);
  const isBlockStart = (index: number): boolean => {
    const line = lines[index]!;
    return line.trim() === "" || /^\s{0,3}#{1,6}\s+/.test(line) ||
      /^\s*```/.test(line) || isUnorderedItem(line) || isOrderedItem(line) || isTable(index);
  };

  for (let i = 0; i < lines.length;) {
    const line = lines[i]!;
    if (line.trim() === "") {
      i++;
      continue;
    }

    const fence = line.match(/^\s{0,3}```\s*([^\s`]*)?.*$/);
    if (fence) {
      const language = fence[1] ?? "";
      const codeLines: string[] = [];
      i++;
      while (i < lines.length && !/^\s{0,3}```/.test(lines[i]!)) codeLines.push(lines[i++]!);
      if (i < lines.length) i++;
      blocks.push(React.createElement(MarkdownCodeBlock, {
        key: blockIndex++, code: codeLines.join("\n"), language,
      }));
      continue;
    }

    const heading = line.match(/^\s{0,3}(#{1,6})\s+(.*)$/);
    if (heading) {
      const level = heading[1]!.length;
      blocks.push(React.createElement(`h${level}`, { key: blockIndex++ }, parseInline(heading[2]!)));
      i++;
      continue;
    }

    if (isTable(i)) {
      const headers = tableCells(line);
      i += 2;
      const rows: string[][] = [];
      while (i < lines.length && lines[i]!.includes("|") && lines[i]!.trim() !== "") {
        rows.push(tableCells(lines[i]!));
        i++;
      }
      const table = React.createElement(
        "table",
        null,
        React.createElement("thead", null,
          React.createElement("tr", null, headers.map((cell, cellIndex) =>
            React.createElement("th", { key: cellIndex }, parseInline(cell))))),
        React.createElement("tbody", null, rows.map((row, rowIndex) =>
          React.createElement("tr", { key: rowIndex }, headers.map((_, cellIndex) =>
            React.createElement("td", { key: cellIndex }, parseInline(row[cellIndex] ?? "")))))));
      blocks.push(React.createElement("div", { key: blockIndex++, className: "markdown-table-scroll" }, table));
      continue;
    }

    if (isUnorderedItem(line) || isOrderedItem(line)) {
      const ordered = isOrderedItem(line);
      const tag = ordered ? "ol" : "ul";
      const itemPattern = ordered ? /^\s*\d+[.)]\s+/ : /^\s*[-*+]\s+/;
      const items: React.ReactNode[] = [];
      while (i < lines.length && (ordered ? isOrderedItem(lines[i]!) : isUnorderedItem(lines[i]!))) {
        items.push(React.createElement("li", { key: items.length }, parseInline(lines[i]!.replace(itemPattern, ""))));
        i++;
      }
      blocks.push(React.createElement(tag, { key: blockIndex++ }, items));
      continue;
    }

    const paragraph: string[] = [];
    while (i < lines.length && !isBlockStart(i)) paragraph.push(lines[i++]!);
    if (paragraph.length === 0) paragraph.push(lines[i++]!);
    blocks.push(React.createElement("p", { key: blockIndex++ }, parseInline(paragraph.join(" "))));
  }

  return React.createElement(React.Fragment, null, blocks);
}

export function MarkdownCodeBlock({ code, language }: { code: string; language: string }): React.ReactElement {
  const [copyState, setCopyState] = React.useState<"idle" | "copied" | "failed">("idle");

  const copyCode = async (): Promise<void> => {
    try {
      if (!navigator.clipboard?.writeText) throw new Error("Clipboard unavailable");
      await navigator.clipboard.writeText(code);
      setCopyState("copied");
    } catch {
      setCopyState("failed");
    }
  };

  return React.createElement(
    "div",
    { className: "markdown-code-block" },
    React.createElement("div", { className: "markdown-code-toolbar" },
      React.createElement("span", null, language || "Code"),
      React.createElement("button", {
        type: "button",
        className: "markdown-code-copy",
        onClick: copyCode,
        "aria-label": "Copy code",
      }, copyState === "copied" ? "Copied" : copyState === "failed" ? "Copy failed" : "Copy")),
    React.createElement("pre", null, React.createElement("code", null, code)),
  );
}
