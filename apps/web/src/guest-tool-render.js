/**
 * Runtime bridge to the vendored guest tool renderer, paired with
 * `guest-tool-render.d.ts` for types.
 *
 * Why a `.js` file at all: the guest sources must not be typechecked by
 * `apps/web`. They are gated by their own package (`pnpm --filter @caw/guest
 * typecheck`) under upstream's `noUncheckedIndexedAccess: false`, and this app's
 * stricter flags surface ~11 errors in `packages/guest/**`, which this worker may
 * not edit — and editing vendored upstream code is exactly what the vendored-
 * renderer rule forbids. TypeScript prefers the sibling `.d.ts` for the import
 * specifier, so the boundary is declared once (`guest-tool-render.d.ts`) while
 * Vite and Vitest, which do no such preference, bundle the real renderers.
 *
 * Neither `tool-render/index.ts` nor `tool-render/registry.ts` is re-exported:
 * both reach `tools/eval.tsx` and `tools/web-search.tsx` →
 * `components/transcript/Markdown.tsx` → katex, measured at 712 kB raw /
 * 156 kB gz for one `ToolView` import versus 101 kB raw / 21 kB gz for this set.
 */
import "../../../packages/guest/src/tool-render/tool-render.css";

export { genericRenderer } from "../../../packages/guest/src/tool-render/generic.js";
export { askRenderer } from "../../../packages/guest/src/tool-render/tools/ask.js";
export { astEditRenderer } from "../../../packages/guest/src/tool-render/tools/ast-edit.js";
export { astGrepRenderer } from "../../../packages/guest/src/tool-render/tools/ast-grep.js";
export { bashRenderer } from "../../../packages/guest/src/tool-render/tools/bash.js";
export { editRenderer } from "../../../packages/guest/src/tool-render/tools/edit.js";
export { fetchRenderer } from "../../../packages/guest/src/tool-render/tools/fetch.js";
export { globRenderer } from "../../../packages/guest/src/tool-render/tools/glob.js";
export { goalRenderer } from "../../../packages/guest/src/tool-render/tools/goal.js";
export { grepRenderer } from "../../../packages/guest/src/tool-render/tools/grep.js";
export { ircRenderer } from "../../../packages/guest/src/tool-render/tools/irc.js";
export { jobRenderer } from "../../../packages/guest/src/tool-render/tools/job.js";
export { lspRenderer } from "../../../packages/guest/src/tool-render/tools/lsp.js";
export { readRenderer } from "../../../packages/guest/src/tool-render/tools/read.js";
export { reportToolIssueRenderer } from "../../../packages/guest/src/tool-render/tools/report-tool-issue.js";
export { resolveRenderer } from "../../../packages/guest/src/tool-render/tools/resolve.js";
export { taskRenderer } from "../../../packages/guest/src/tool-render/tools/task.js";
export { todoRenderer } from "../../../packages/guest/src/tool-render/tools/todo.js";
export { waitRenderer } from "../../../packages/guest/src/tool-render/tools/wait.js";
export { writeRenderer } from "../../../packages/guest/src/tool-render/tools/write.js";
export { yieldRenderer } from "../../../packages/guest/src/tool-render/tools/yield.js";

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
} from "../../../packages/guest/src/tool-render/parts.js";

export { diffStats, display, isRecord, num, shortenPath, str, stripAnsi, truncate } from "../../../packages/guest/src/tool-render/util.js";
