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
    if (trimmed.startsWith("https://") || /^data:image\/(?:png|jpeg|gif|webp|avif);base64,/i.test(trimmed)) {
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
  const delimiterCache = new Map<string, { from: number; index: number }>();
  let position = 0;
  let textStart = 0;
  let keyIndex = 0;

  const next = (delimiter: string, from: number): number => {
    const cached = delimiterCache.get(delimiter);
    if (cached && from >= cached.from && (cached.index === -1 || cached.index >= from)) return cached.index;
    const index = text.indexOf(delimiter, from);
    delimiterCache.set(delimiter, { from, index });
    return index;
  };
  const flushText = (end: number) => {
    if (end > textStart) elements.push(text.slice(textStart, end));
  };

  while (position < text.length) {
    const char = text[position];
    if (char === "`") {
      const close = next("`", position + 1);
      if (close > position + 1) {
        flushText(position);
        elements.push(React.createElement("code", { key: keyIndex++ }, text.slice(position + 1, close)));
        position = close + 1;
        textStart = position;
        continue;
      }
    }

    const imageStart = char === "[" && position > 0 && text[position - 1] === "!" ? position - 1 : -1;
    const labelStart = char === "[" ? position + 1 : -1;
    if (labelStart >= 0) {
      const closeBracket = next("]", labelStart);
      const hasLabel = closeBracket > labelStart;
      const hasAlt = closeBracket >= labelStart;
      if ((imageStart >= 0 ? hasAlt : hasLabel) && text[closeBracket + 1] === "(") {
        const urlStart = closeBracket + 2;
        const closeParen = next(")", urlStart);
        if (closeParen > urlStart) {
          const label = text.slice(labelStart, closeBracket);
          const url = text.slice(urlStart, closeParen);
          flushText(imageStart >= 0 ? imageStart : position);
          if (imageStart >= 0) {
            const safeSrc = sanitizeUrl(url, true);
            if (safeSrc) {
              elements.push(React.createElement("img", {
                key: keyIndex++,
                src: safeSrc,
                alt: label,
                loading: "lazy",
                style: { maxWidth: "100%", borderRadius: "4px" },
              }));
            } else {
              elements.push(React.createElement("span", { key: keyIndex++ }, `[Image: ${label}]`));
            }
          } else {
            const safeHref = sanitizeUrl(url, false);
            if (safeHref) {
              elements.push(React.createElement(
                "a",
                {
                  key: keyIndex++,
                  href: safeHref,
                  target: "_blank",
                  rel: "noopener noreferrer",
                  style: { color: "var(--primary)", textDecoration: "underline" },
                },
                label,
              ));
            } else {
              elements.push(React.createElement("span", { key: keyIndex++ }, label));
            }
          }
          position = closeParen + 1;
          textStart = position;
          continue;
        }
      }
    }

    if (char === "*" && text[position + 1] === "*") {
      const close = next("*", position + 2);
      if (close > position + 2 && text[close + 1] === "*") {
        flushText(position);
        elements.push(React.createElement("strong", { key: keyIndex++ }, parseInline(text.slice(position + 2, close))));
        position = close + 2;
        textStart = position;
        continue;
      }
    }

    if (char === "*" && text[position + 1] !== "*") {
      const close = next("*", position + 1);
      if (close > position + 1) {
        flushText(position);
        elements.push(React.createElement("em", { key: keyIndex++ }, parseInline(text.slice(position + 1, close))));
        position = close + 1;
        textStart = position;
        continue;
      }
    }

    position++;
  }

  flushText(text.length);
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
