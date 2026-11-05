/**
 * Types for the guest renderer bridge.
 *
 * `guest-tool-render.js` is the runtime half: it re-exports the vendored
 * renderers from `packages/guest/src/tool-render/`. TypeScript never reads that
 * `.js` (this package does not enable `allowJs`), so it is this file — resolved
 * by the identical base name — that types the seam. The split exists so the guest
 * sources are never part of `apps/web`'s typecheck program: they are gated by
 * their own package under upstream's compiler settings, and applying this app's
 * stricter flags to vendored code would produce errors in files this worker may
 * not edit.
 *
 * The declared surface mirrors the guest signatures. A rename upstream therefore
 * fails at `pnpm --filter @caw/web typecheck` instead of silently typing as `any`.
 */
import type { ComponentType, ReactNode } from "react";

export interface GuestToolResult {
  content: readonly { type: string; text?: string; mimeType?: string; data?: string }[];
  details?: unknown;
  isError?: boolean;
}

export interface GuestToolRenderHost {
  hasAgent?(id: string): boolean;
  openAgent?(id: string): void;
}

export interface GuestToolRenderProps {
  name: string;
  args: Record<string, unknown>;
  result?: GuestToolResult;
  running?: boolean;
  host?: GuestToolRenderHost;
}

export interface GuestToolRenderer {
  Summary: ComponentType<GuestToolRenderProps>;
  Body?: ComponentType<GuestToolRenderProps>;
}

export type Tone = "accent" | "ok" | "err" | "warn";

export declare const genericRenderer: GuestToolRenderer;
export declare const askRenderer: GuestToolRenderer;
export declare const astEditRenderer: GuestToolRenderer;
export declare const astGrepRenderer: GuestToolRenderer;
export declare const bashRenderer: GuestToolRenderer;
export declare const editRenderer: GuestToolRenderer;
export declare const fetchRenderer: GuestToolRenderer;
export declare const globRenderer: GuestToolRenderer;
export declare const goalRenderer: GuestToolRenderer;
export declare const grepRenderer: GuestToolRenderer;
export declare const ircRenderer: GuestToolRenderer;
export declare const jobRenderer: GuestToolRenderer;
export declare const lspRenderer: GuestToolRenderer;
export declare const readRenderer: GuestToolRenderer;
export declare const reportToolIssueRenderer: GuestToolRenderer;
export declare const resolveRenderer: GuestToolRenderer;
export declare const taskRenderer: GuestToolRenderer;
export declare const todoRenderer: GuestToolRenderer;
export declare const waitRenderer: GuestToolRenderer;
export declare const writeRenderer: GuestToolRenderer;
export declare const yieldRenderer: GuestToolRenderer;

export declare function Badge(props: { children: ReactNode; tone?: Tone }): ReactNode;
export declare function Badges(props: { items: ReadonlyArray<ReactNode> }): ReactNode;
export declare function PathText(props: { path: string; from?: number | null; to?: number | null; sel?: string | null }): ReactNode;
export declare function KvGrid(props: { children: ReactNode }): ReactNode;
export declare function Kv(props: { k: ReactNode; children: ReactNode }): ReactNode;
export declare function Output(props: {
  text: string;
  maxLines?: number;
  lang?: string | null;
  error?: boolean;
  variant?: "code" | "plain";
  title?: string;
  bare?: boolean;
}): ReactNode;
export declare function CodeBlock(props: { code: string; lang?: string | null; title?: string; maxLines?: number }): ReactNode;
export declare function ResultText(props: {
  result: GuestToolResult | undefined;
  maxLines?: number;
  lang?: string | null;
  variant?: "code" | "plain";
  title?: string;
}): ReactNode;
export declare function ResultImages(props: { result: GuestToolResult | undefined }): ReactNode;
export declare function Note(props: { tone?: Tone; children: ReactNode }): ReactNode;
export declare function Row(props: { k: ReactNode; children: ReactNode }): ReactNode;
export declare function DiffBlock(props: { diff: string; maxLines?: number }): ReactNode;

export declare function isRecord(value: unknown): value is Record<string, unknown>;
export declare function str(value: unknown): string | null;
export declare function num(value: unknown): number | null;
export declare function display(value: unknown): string;
export declare function shortenPath(path: string): string;
export declare function truncate(text: string, max: number): string;
export declare function stripAnsi(text: string): string;
/** Single owner of the +/− arithmetic; shared with the guest `edit` renderer. */
export declare function diffStats(diff: string): { additions: number; deletions: number };
