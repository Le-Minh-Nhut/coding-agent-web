/**
 * Types for `scripts/deploy-web.mjs`.
 *
 * The module is plain ESM JavaScript (it runs before any build step exists), so
 * the contract lives here: operations are exported and testable, and the CLI
 * entry is the only path that calls `process.exit`.
 */
export interface ReleaseFile {
  path: string;
  size: number;
  sha256: string;
}

export interface ReleaseManifest {
  release: string;
  commit: string | null;
  dirty: boolean | null;
  builtAt: string;
  builtFrom: string;
  files: ReleaseFile[];
}

export interface VerifyResult {
  ok: boolean;
  reason: string | null;
  manifest: ReleaseManifest | null;
}

export interface DeployLayout {
  root: string;
  releases: string;
  staging: string;
  current: string;
  previous: string;
}

export interface BuildResult {
  status: number | null;
  signal?: string | null;
}

export interface ReleaseStatus {
  current: string | null;
  previous: string | null;
  releases: Array<{ id: string; dir: string; builtAt: string; verified: boolean; reason: string | null; pointers: string[] }>;
  staging: string[];
}

export interface PublishOptions {
  healthUrl?: string;
  healthTimeoutMs?: number;
}

export function defaultReleaseRoot(): string;
export function layout(releaseRoot: string): DeployLayout;
export function releaseId(): string;
export function verifyRelease(releaseDir: string): VerifyResult;
export function runVite(outDir: string): BuildResult;
export function buildRelease(options: { releaseRoot: string; id?: string; runner?: (outDir: string) => BuildResult }): string;
export function readPointer(linkPath: string): string | null;
export function swapPointer(linkPath: string, target: string): void;
export function publishRelease(releaseRoot: string, requested: string | undefined, options?: PublishOptions): Promise<string>;
export function rollbackRelease(releaseRoot: string): string;
export function releaseStatus(releaseRoot: string): ReleaseStatus;
export function pruneReleases(releaseRoot: string, keep: number): string[];
export function parseOptions(argv: string[]): { positionals: string[]; flags: { keep?: number; healthUrl?: string; healthTimeoutMs?: number } };
export function main(argv: string[], releaseRoot?: string): Promise<unknown>;
