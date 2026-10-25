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
  // Normalize newlines
  const text = markdown.replace(/\r\n/g, "\n");
  const lines = text.split("\n");
  const blocks: React.ReactNode[] = [];
  let inCodeBlock = false;
  let codeBlockLines: string[] = [];
  let blockIndex = 0;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;

    // Code block toggle ```
    if (line.trim().startsWith("```")) {
      if (inCodeBlock) {
        // End of code block
        const codeContent = codeBlockLines.join("\n");
        blocks.push(
          React.createElement(
            "pre",
            { key: blockIndex++ },
            React.createElement("code", null, codeContent)
          )
        );
        codeBlockLines = [];
        inCodeBlock = false;
      } else {
        inCodeBlock = true;
      }
      continue;
    }

    if (inCodeBlock) {
      codeBlockLines.push(line);
      continue;
    }

    // Blank line
    if (line.trim() === "") {
      continue;
    }

    // Heading: # H1, ## H2, ### H3
    if (line.startsWith("# ")) {
      blocks.push(React.createElement("h2", { key: blockIndex++ }, parseInline(line.slice(2))));
      continue;
    }
    if (line.startsWith("## ")) {
      blocks.push(React.createElement("h3", { key: blockIndex++ }, parseInline(line.slice(3))));
      continue;
    }
    if (line.startsWith("### ")) {
      blocks.push(React.createElement("h4", { key: blockIndex++ }, parseInline(line.slice(4))));
      continue;
    }

    // Unordered list item: - item or * item
    if (line.startsWith("- ") || line.startsWith("* ")) {
      blocks.push(
        React.createElement(
          "li",
          { key: blockIndex++, style: { marginLeft: "20px" } },
          parseInline(line.slice(2))
        )
      );
      continue;
    }

    // Default paragraph
    blocks.push(
      React.createElement(
        "p",
        { key: blockIndex++, style: { marginBottom: "8px" } },
        parseInline(line)
      )
    );
  }

  // Handle unclosed code block
  if (inCodeBlock && codeBlockLines.length > 0) {
    blocks.push(
      React.createElement(
        "pre",
        { key: blockIndex++ },
        React.createElement("code", null, codeBlockLines.join("\n"))
      )
    );
  }

  return React.createElement(React.Fragment, null, blocks);
}
