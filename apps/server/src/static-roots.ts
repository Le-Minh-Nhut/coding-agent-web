/**
 * Per-request resolution of the directory the static handlers serve from.
 *
 * A release publish swaps the `current` symlink under the deploy root. The
 * server used to `realpathSync` its assets directory once at registration and
 * close over it, so a swap was invisible until restart — and the served path
 * could even point at a release directory that pruning had removed. Resolving
 * per request costs one `readlink(2)` when the pointer is unchanged (the
 * resolved real path is cached keyed on the link target *string*), so the hot
 * path stays cheap while a publish takes effect on the next request.
 *
 * Without a published release the resolver serves the literal configured
 * directory, which is what a fresh checkout, the E2E harness and every existing
 * test use. A pointer that exists and is dead is a different state: it is
 * reported as a fault, never papered over by the legacy directory — otherwise a
 * broken publish would silently serve month-old assets.
 */
import { readlinkSync, realpathSync, statSync } from "node:fs";
import path from "node:path";

export type StaticRootFault = "missing_build" | "broken_release";

export interface StaticRoot {
  /** Real, symlink-free directory to serve from, or null. */
  root: string | null;
  /** Release id (the `current` link target) when serving a release. */
  release: string | null;
  /** Why `root` is null; null when a root was found or when there is simply no previous release. */
  fault: StaticRootFault | null;
  /** Human-readable fault detail, for the loud log line. */
  reason: string | null;
}

export interface StaticRootResolver {
  current(): StaticRoot;
  /** The release a publish replaced; assets may fall back to it, HTML never does. */
  previous(): StaticRoot;
}

/** Bounded: a pointer flip is rare, so a handful of targets covers ping-pong. */
const CACHE_LIMIT = 16;

function realDirectory(candidate: string): string | null {
  try {
    const real = realpathSync(candidate);
    return statSync(real).isDirectory() ? real : null;
  } catch {
    return null;
  }
}

export function createStaticRootResolver(options: {
  distDir: string;
  releaseRoot?: string | null;
}): StaticRootResolver {
  const releaseRoot = options.releaseRoot ? path.resolve(options.releaseRoot) : null;
  const distDir = path.resolve(options.distDir);
  const resolved = new Map<string, string>();

  const literal = (): StaticRoot => {
    const root = realDirectory(distDir);
    return root
      ? { root, release: null, fault: null, reason: null }
      : { root: null, release: null, fault: "missing_build", reason: `no static build at ${distDir}` };
  };

  const follow = (name: "current" | "previous"): StaticRoot => {
    if (releaseRoot === null) return literal();
    const linkPath = path.join(releaseRoot, name);
    let target: string;
    try {
      target = readlinkSync(linkPath);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      // No pointer at all: nothing has been published here yet, so the literal
      // build directory (a fresh checkout, the E2E harness) is the honest answer.
      if (code === "ENOENT") return name === "current" ? literal() : { root: null, release: null, fault: null, reason: null };
      // EINVAL: the pointer exists but is not a symlink, so it names no release.
      return {
        root: null,
        release: null,
        fault: "broken_release",
        reason: `cannot read release pointer ${linkPath}: ${code ?? "unknown error"}`,
      };
    }
    let root = resolved.get(target);
    if (root === undefined) {
      const fresh = realDirectory(path.resolve(releaseRoot, target));
      if (fresh === null) {
        if (name === "previous") return { root: null, release: null, fault: null, reason: null };
        return {
          root: null,
          release: null,
          fault: "broken_release",
          reason: `release pointer ${linkPath} -> ${target} resolves to no directory`,
        };
      }
      root = fresh;
      resolved.set(target, root);
      if (resolved.size > CACHE_LIMIT) resolved.delete(resolved.keys().next().value as string);
    }
    return { root, release: path.basename(target), fault: null, reason: null };
  };

  return { current: () => follow("current"), previous: () => follow("previous") };
}
