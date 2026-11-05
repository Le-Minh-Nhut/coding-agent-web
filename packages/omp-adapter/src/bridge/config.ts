/**
 * Bridge discovery: how CAW hands a live session its loopback port and token.
 *
 * The port cannot be fixed — two conversations run side by side — and it cannot
 * be guessed by the agent, so CAW allocates a free loopback port and mints a
 * token at launch, then writes both to a per-conversation file next to that
 * session's overlay. Only the file's *path* travels on the process command line
 * (`CAW_BRIDGE_CONFIG`); a token in `-e KEY=value` would be world-readable in
 * `/proc/<pid>/cmdline` for the lifetime of the tmux client call, which is the
 * one place a bearer secret must not land.
 *
 * The overlay is what makes OMP load the extension at all: the same file already
 * written for this session gains an `extensions:` entry pointing at
 * {@link bridgeExtensionPath}. Sessions launched before this existed have no
 * such entry and therefore no listener — the route reports that as
 * `bridge_unavailable`, which is the honest answer until they restart.
 */
import { createServer } from "node:net";
import type { AddressInfo } from "node:net";
import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

/** What the extension needs to bind. Also the shape of the on-disk config file. */
export interface BridgeConfig {
  port: number;
  token: string;
}

/**
 * Absolute path to the extension module OMP loads.
 *
 * Computed on demand rather than at module scope, and without `fileURLToPath`.
 * Module-scope evaluation of a `file:` URL throws `The URL must be of scheme
 * file` when the module is imported through a loader whose `import.meta.url` is
 * not a file URL — vitest transforms these sources that way, so a top-level
 * constant broke every test file that reached this module transitively. Resolving
 * from the compiled location with `import.meta.dirname` (Node 20.11+) keeps the
 * path correct under Node and never touches a URL scheme.
 */
export function bridgeExtensionPath(): string {
  return join(import.meta.dirname, "extension.mjs");
}
export const BRIDGE_CONFIG_ENV = "CAW_BRIDGE_CONFIG";

/** Per-conversation bridge config file. Lives in the overlay dir, which is 0700 and ours. */
export function bridgeConfigPath(overlayDir: string, conversationId: string): string {
  return join(overlayDir, `${conversationId.replace(/[^a-zA-Z0-9-]/g, "")}.bridge.json`);
}

/**
 * Ask the kernel for a free loopback port.
 *
 * `ponytail: bind-probe-then-close leaves a window where another process can take
 * the port before OMP binds it. Closing that would need a handshake the extension
 * has no channel for; instead a lost race surfaces as a written bind failure and
 * the route answers `bridge_unavailable` — wrong-but-honest beats silently wrong.
 */
export async function allocateLoopbackPort(): Promise<number> {
  const probe = createServer();
  await new Promise<void>((resolve, reject) => {
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", () => resolve());
  });
  const { port } = probe.address() as AddressInfo;
  await new Promise<void>((resolve) => probe.close(() => resolve()));
  return port;
}

export interface PrepareBridgeResult {
  config: BridgeConfig;
  /** Absolute path to the extension module, for the overlay's `extensions:` list. */
  extensionPath: string;
  /** Environment for the agent process: only the config *path*, never the token. */
  env: Record<string, string>;
}

/**
 * Allocate a bridge for one launched conversation and persist it where both the
 * extension (path passed in the environment) and a later route request (same
 * path, derived from the conversation id) will find it.
 *
 * A missing extension file is a hard failure: without it OMP loads nothing, and
 * a bridge that silently never comes up is indistinguishable from one that was
 * never asked for.
 */
export async function prepareBridge(overlayDir: string, conversationId: string): Promise<PrepareBridgeResult> {
  const extensionPath = bridgeExtensionPath();
  if (!existsSync(extensionPath)) {
    throw Object.assign(new Error(`Bridge extension is missing at ${extensionPath}`), { code: "ENOENT" });
  }
  const config: BridgeConfig = { port: await allocateLoopbackPort(), token: randomBytes(32).toString("hex") };
  const path = bridgeConfigPath(overlayDir, conversationId);
  await writeFile(path, `${JSON.stringify(config)}\n`, { mode: 0o600 });
  return { config, extensionPath, env: { [BRIDGE_CONFIG_ENV]: path } };
}

/**
 * The bridge a route should ask about, or `null` when none was ever configured
 * for this conversation. `null` is not a failure: it is the pre-bridge session,
 * and the caller must say "not available until this session restarts".
 */
export async function readBridgeConfig(overlayDir: string, conversationId: string): Promise<BridgeConfig | null> {
  let raw: string;
  try {
    raw = await readFile(bridgeConfigPath(overlayDir, conversationId), "utf8");
  } catch {
    return null;
  }
  try {
    const parsed: unknown = JSON.parse(raw);
    if (parsed === null || typeof parsed !== "object") return null;
    const { port, token } = parsed as { port?: unknown; token?: unknown };
    if (!Number.isInteger(port) || (port as number) < 1 || (port as number) > 65535) return null;
    if (typeof token !== "string" || token.length === 0) return null;
    return { port: port as number, token };
  } catch {
    return null;
  }
}
