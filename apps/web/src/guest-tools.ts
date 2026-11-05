/**
 * The single seam between `apps/web` and the vendored guest tool renderer
 * (`packages/guest/src/tool-render/`).
 *
 * Everything the web app borrows from the guest comes through here, so there is
 * exactly one module to reconcile if the vendored renderer moves. Three things
 * are deliberate:
 *
 *  - Renderers are imported **per file**, never through `tool-render/index.ts` or
 *    `tool-render/registry.ts`: both reach `tools/eval.tsx` and
 *    `tools/web-search.tsx` → `components/transcript/Markdown.tsx` → katex.
 *    Measured: one `ToolView` import via the barrel bundles 712 kB raw /
 *    156 kB gz, against 101 kB raw / 21 kB gz for the set below. `apps/web` does
 *    not depend on katex, so the guest's own `ToolView` chrome is not reused —
 *    the ~50-line shell in `components/ToolActivity.tsx` replaces it, and every
 *    substantive renderer (including the `edit` diff renderer and `DiffBlock`)
 *    is imported verbatim.
 *  - A tool with no registry entry falls back to the guest's `genericRenderer`,
 *    which prints the args digest and the raw result. That is the honest
 *    fallback; inventing a summary from a tool's name would not be.
 *  - The guest's `tool-render.css` ships with the seam, so the `tv-` design
 *    system cannot be forgotten by a call site.
 */
import {
  askRenderer,
  astEditRenderer,
  astGrepRenderer,
  bashRenderer,
  editRenderer,
  fetchRenderer,
  genericRenderer,
  globRenderer,
  goalRenderer,
  grepRenderer,
  ircRenderer,
  jobRenderer,
  lspRenderer,
  readRenderer,
  reportToolIssueRenderer,
  resolveRenderer,
  taskRenderer,
  todoRenderer,
  waitRenderer,
  writeRenderer,
  yieldRenderer,
  type GuestToolRenderer,
} from "./guest-tool-render.js";

export type { GuestToolRenderer as ToolRenderer, GuestToolRenderProps as ToolRenderProps, GuestToolResult as ToolResultLike } from "./guest-tool-render.js";

export {
  Badge,
  Badges,
  CodeBlock,
  DiffBlock,
  Kv,
  KvGrid,
  Note,
  Output,
  PathText,
  ResultImages,
  ResultText,
  Row,
  diffStats,
  display,
  isRecord,
  num,
  shortenPath,
  str,
  stripAnsi,
  truncate,
} from "./guest-tool-render.js";

/** Tool name → renderer, mirroring `packages/guest/src/tool-render/registry.ts:28` minus the markdown-heavy entries. */
export const GUEST_RENDERERS: Record<string, GuestToolRenderer> = {
  ask: askRenderer,
  ast_edit: astEditRenderer,
  ast_grep: astGrepRenderer,
  bash: bashRenderer,
  // The aliases the guest registry also carries (`registry.ts:41-63`), so a
  // legacy wire name renders identically instead of falling through to generic.
  shell: bashRenderer,
  edit: editRenderer,
  apply_patch: editRenderer,
  fetch: fetchRenderer,
  glob: globRenderer,
  find: globRenderer,
  goal: goalRenderer,
  grep: grepRenderer,
  search: grepRenderer,
  irc: ircRenderer,
  job: jobRenderer,
  lsp: lspRenderer,
  read: readRenderer,
  report_tool_issue: reportToolIssueRenderer,
  resolve: resolveRenderer,
  reject: resolveRenderer,
  propose: resolveRenderer,
  task: taskRenderer,
  todo: todoRenderer,
  wait: waitRenderer,
  write: writeRenderer,
  yield: yieldRenderer,
};

export function resolveGuestRenderer(toolName: string): GuestToolRenderer {
  return GUEST_RENDERERS[toolName] ?? genericRenderer;
}

/** True when a dedicated renderer exists; `false` means the generic fallback applies. */
export function hasGuestRenderer(toolName: string): boolean {
  return toolName in GUEST_RENDERERS;
}
