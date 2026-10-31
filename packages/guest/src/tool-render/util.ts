/**
 * Pure helpers shared by tool renderers. Host-agnostic; no DOM beyond
 * `globalThis` feature probes, no host package imports.
 */
import type { ToolResultImage, ToolResultLike } from "./types";

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** String passthrough; anything else (including null/undefined) → null. */
export function str(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

export function num(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/** Coerce unknown to a display string ("" for null/undefined). */
export function display(value: unknown): string {
  if (value == null) return "";
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean")
    return String(value);
  try {
    return JSON.stringify(value) ?? "";
  } catch {
    return String(value);
  }
}

/** Replace `/Users/<x>` / `/home/<x>` prefix with `~` for display. */
export function shortenPath(p: string): string {
  for (const prefix of ["/Users/", "/home/"]) {
    if (p.startsWith(prefix)) {
      const rest = p.slice(prefix.length);
      const slash = rest.indexOf("/");
      return slash < 0 ? "~" : `~${rest.slice(slash)}`;
    }
  }
  return p;
}

/**
 * Search scope for display: the current `path` argument (else the legacy
 * `paths`), normalized from a single string, a JSON-encoded string array
 * (`'["a.ts","b.ts"]'`), or an actual array into a flat `string[]`. Mirrors the
 * coding-agent `toPathList` so web cards render the same scope the tool searched.
 */
export function scopePaths(args: Record<string, unknown>): string[] {
  const raw = args.path ?? args.paths;
  if (typeof raw === "string") {
    const trimmed = raw.trim();
    if (trimmed.startsWith("[") && trimmed.endsWith("]")) {
      try {
        const parsed: unknown = JSON.parse(trimmed);
        if (
          Array.isArray(parsed) &&
          parsed.every((p): p is string => typeof p === "string")
        ) {
          return parsed;
        }
      } catch {
        // Not valid JSON — treat the whole string as one path.
      }
    }
    return [raw];
  }
  if (Array.isArray(raw))
    return raw.filter((p): p is string => typeof p === "string");
  return [];
}

export function truncate(s: string, maxLen = 100): string {
  return s.length <= maxLen ? s : `${s.slice(0, maxLen)}…`;
}

/** Collapse all whitespace runs to single spaces (for one-line summaries). */
export function normalizeWs(s: string): string {
  return s.replace(/\s+/g, " ").trim();
}

export function replaceTabs(s: string): string {
  return s.replace(/\t/g, "   ");
}

// Control Sequence Introducer + OSC escapes.
const ANSI_RE = /\x1b(?:\[[0-9;?]*[ -/]*[@-~]|\][^\x07\x1b]*(?:\x07|\x1b\\))/g;

export function stripAnsi(s: string): string {
  return s.replace(ANSI_RE, "");
}

const EXT_TO_LANG: Record<string, string> = {
  ts: "typescript",
  tsx: "typescript",
  mts: "typescript",
  cts: "typescript",
  js: "javascript",
  jsx: "javascript",
  mjs: "javascript",
  cjs: "javascript",
  py: "python",
  rb: "ruby",
  rs: "rust",
  go: "go",
  java: "java",
  kt: "kotlin",
  swift: "swift",
  c: "c",
  h: "c",
  cpp: "cpp",
  cc: "cpp",
  hpp: "cpp",
  cs: "csharp",
  php: "php",
  sh: "bash",
  bash: "bash",
  zsh: "bash",
  fish: "bash",
  sql: "sql",
  html: "html",
  css: "css",
  scss: "scss",
  less: "less",
  json: "json",
  jsonc: "json",
  json5: "json",
  yaml: "yaml",
  yml: "yaml",
  toml: "ini",
  ini: "ini",
  xml: "xml",
  svg: "xml",
  md: "markdown",
  mdx: "markdown",
  dockerfile: "dockerfile",
  lua: "lua",
  zig: "zig",
  diff: "diff",
  patch: "diff",
};

export function languageFromPath(filePath: string): string | null {
  const base = filePath.split("/").pop() ?? "";
  if (/^dockerfile$/i.test(base)) return "dockerfile";
  const ext = base.split(".").pop()?.toLowerCase() ?? "";
  return EXT_TO_LANG[ext] ?? null;
}

/** Joined text blocks of a tool result ("" when absent). */
export function resultTextOf(result: ToolResultLike | undefined): string {
  if (!result || !Array.isArray(result.content)) return "";
  const parts: string[] = [];
  for (const block of result.content) {
    // Wire JSON is only partially trusted: a null/primitive entry must not
    // throw out of the renderer (contract in ./types.ts).
    if (!isRecord(block)) continue;
    if (block.type === "text" && typeof block.text === "string") {
      parts.push(block.text);
    }
  }
  return parts.join("\n");
}

/**
 * RASTER image types only. SVG and text/html are scriptable when navigated to
 * as a top-level document, so they must never become a blob/data URL target.
 */
const RASTER_IMAGE_MIME_TYPES: Record<string, true> = {
  "image/png": true,
  "image/jpeg": true,
  "image/gif": true,
  "image/webp": true,
};

export function isRasterImageMime(mimeType: unknown): boolean {
  return (
    typeof mimeType === "string" &&
    RASTER_IMAGE_MIME_TYPES[mimeType.trim().toLowerCase()] === true
  );
}

export function resultImagesOf(
  result: ToolResultLike | undefined,
): ToolResultImage[] {
  if (!result || !Array.isArray(result.content)) return [];
  const images: ToolResultImage[] = [];
  for (const block of result.content) {
    if (!isRecord(block)) continue;
    const img = block as unknown as Partial<ToolResultImage>;
    if (
      block.type === "image" &&
      isRasterImageMime(img.mimeType) &&
      typeof img.data === "string"
    ) {
      images.push(img as ToolResultImage);
    }
  }
  return images;
}

/** Image blocks whose MIME is not renderable raster: shown as a note, never an <img>. */
export function skippedImagesOf(
  result: ToolResultLike | undefined,
): ToolResultImage[] {
  if (!result || !Array.isArray(result.content)) return [];
  const skipped: ToolResultImage[] = [];
  for (const block of result.content) {
    if (!isRecord(block) || block.type !== "image") continue;
    const mimeType = typeof block.mimeType === "string" ? block.mimeType : "";
    if (!isRasterImageMime(mimeType)) {
      skipped.push({ type: "image", data: "", mimeType });
    }
  }
  return skipped;
}

/** `result.details` when it is a plain object; renderers narrow field-by-field. */
export function detailsRecord(
  result: ToolResultLike | undefined,
): Record<string, unknown> | null {
  return result && isRecord(result.details) ? result.details : null;
}

/** Compact one-line JSON digest of arbitrary args (generic summary fallback). */
export function argsDigest(args: unknown, maxLen = 96): string {
  if (args == null) return "";
  if (isRecord(args) && Object.keys(args).length === 0) return "";
  return truncate(normalizeWs(display(args)), maxLen);
}

interface HljsLike {
  getLanguage(name: string): unknown;
  highlight(
    code: string,
    options: { language: string; ignoreIllegals?: boolean },
  ): { value: string };
}

/**
 * Optional syntax highlighter seam. The HTML export page ships highlight.js as
 * a global; the collab-web app does not bundle it. Renderers degrade to plain
 * text when absent.
 */
export function getHljs(): HljsLike | null {
  const candidate = (globalThis as { hljs?: HljsLike }).hljs;
  return candidate && typeof candidate.highlight === "function"
    ? candidate
    : null;
}
