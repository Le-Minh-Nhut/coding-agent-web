/**
 * Static handler for the built browser guest client, sharing the relay's origin.
 *
 * Deliberately dumb: exact-path resolution only. The guest client is one page loaded at `/` with the
 * collab link in the URL fragment, so there is nothing to route and nothing to fall back to — an
 * unknown path is a 404 and never an `index.html` masquerading as a missing asset.
 *
 * Path policy (docs/research/security-considerations.md §2d):
 * - decode once, reject a NUL or backslash, reject `""` / `"."` / `".."` segments and any segment
 *   containing a separator, then open with `O_NOFOLLOW` and confirm `isFile()` on the *handle*;
 * - no directory listing, no symlink following, no relative-path escape.
 */
import { constants as fsConstants, realpathSync } from "node:fs";
import fs from "node:fs/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import path from "node:path";

const MIME_BY_EXTENSION: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".webmanifest": "application/manifest+json; charset=utf-8",
  ".map": "application/json; charset=utf-8",
  ".txt": "text/plain; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".ico": "image/x-icon",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".ttf": "font/ttf",
  ".wasm": "application/wasm",
};

const DEFAULT_MIME = "application/octet-stream";

/** Headers every static response carries; the fragment holds the room key, so never leak a Referer. */
const BASE_HEADERS: Record<string, string> = {
  "referrer-policy": "no-referrer",
  "x-content-type-options": "nosniff",
  "cache-control": "no-cache",
};

export interface StaticStatus {
  rooms: number;
  guests: number;
  uptimeMs: number;
}

export interface StaticHandlerOptions {
  /** Directory holding the built client, or `null` for a relay-only listener. */
  dir: string | null;
  /** Reported by `/healthz`. */
  version: string;
  /** Live relay counters folded into `/healthz`. */
  status: () => { rooms: number; guests: number };
  /** Clock source for `/healthz` uptime, in ms. Defaults to `Date.now`. */
  now?: () => number;
}

export type StaticHandler = (
  req: IncomingMessage,
  res: ServerResponse,
) => Promise<void>;

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    ...BASE_HEADERS,
    "content-type": "application/json; charset=utf-8",
  });
  res.end(payload);
}

function sendStatus(
  res: ServerResponse,
  status: number,
  message: string,
): void {
  res.writeHead(status, {
    ...BASE_HEADERS,
    "content-type": "text/plain; charset=utf-8",
  });
  res.end(message);
}

/**
 * Split a request target into safe path segments, or `null` when it attempts to leave the root.
 * Percent-encoding is resolved exactly once: `%2e%2e%2f` decodes to `../`, which the segment check
 * then rejects, while double-encoded input stays an inert filename that simply 404s.
 */
export function safeSegments(pathname: string): string[] | null {
  let decoded: string;
  try {
    decoded = decodeURIComponent(pathname);
  } catch {
    return null;
  }
  if (decoded.includes("\0") || decoded.includes("\\")) return null;
  const segments: string[] = [];
  for (const segment of decoded.split("/")) {
    if (segment === "") continue;
    if (segment === "." || segment === "..") return null;
    if (segment.includes("/") || segment.includes("\\")) return null;
    segments.push(segment);
  }
  return segments;
}

export function createStaticHandler(
  options: StaticHandlerOptions,
): StaticHandler {
  const root = options.dir === null ? null : path.resolve(options.dir);
  const now = options.now ?? Date.now;
  const startedAt = now();
  // Resolved once: a symlinked root is the operator's own choice, but nothing below it is followed.
  let rootReal = root ?? "";
  if (root !== null) {
    try {
      rootReal = realpathSync(root);
    } catch {
      rootReal = root;
    }
  }

  /**
   * Confirm the file we actually opened lives under the root. `O_NOFOLLOW` only covers the final
   * component, so an intermediate symlink (`staticDir/escape -> /etc`) would otherwise be followed.
   * `/proc/self/fd/N` names the real path of the open descriptor, which also closes the
   * check-then-open race; the fallback is a plain realpath of the path string.
   */
  const openedInsideRoot = async (
    handle: fs.FileHandle,
    filePath: string,
  ): Promise<boolean> => {
    let real: string;
    try {
      real = await fs.readlink(`/proc/self/fd/${handle.fd}`);
    } catch {
      try {
        real = realpathSync(filePath);
      } catch {
        return false;
      }
    }
    return real === rootReal || real.startsWith(rootReal + path.sep);
  };

  return async (req, res) => {
    if (req.method !== "GET" && req.method !== "HEAD") {
      sendStatus(res, 405, "method not allowed");
      return;
    }
    const target = req.url ?? "/";
    // Origin-form target only; a URL parse keeps query bytes out of the path.
    const pathname = (() => {
      const query = target.indexOf("?");
      const withoutQuery = query === -1 ? target : target.slice(0, query);
      const fragment = withoutQuery.indexOf("#");
      return fragment === -1 ? withoutQuery : withoutQuery.slice(0, fragment);
    })();

    if (pathname === "/healthz") {
      const live = options.status();
      sendJson(res, 200, {
        ok: true,
        version: options.version,
        rooms: live.rooms,
        guests: live.guests,
        uptimeMs: now() - startedAt,
      });
      return;
    }
    if (root === null) {
      sendStatus(res, 404, "not found");
      return;
    }

    const segments = safeSegments(pathname);
    if (segments === null) {
      sendStatus(res, 400, "bad request");
      return;
    }
    if (segments.length === 0) segments.push("index.html");

    const filePath = path.join(rootReal, ...segments);
    // Belt and braces: `path.join` already cannot escape with vetted segments.
    if (filePath !== rootReal && !filePath.startsWith(rootReal + path.sep)) {
      sendStatus(res, 400, "bad request");
      return;
    }

    let handle: fs.FileHandle | undefined;
    try {
      handle = await fs.open(
        filePath,
        fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW,
      );
      // Metadata comes from the opened handle, never a second lookup.
      const stats = await handle.stat();
      if (!stats.isFile() || !(await openedInsideRoot(handle, filePath))) {
        sendStatus(res, 404, "not found");
        return;
      }
      const headers: Record<string, string> = {
        ...BASE_HEADERS,
        "content-type":
          MIME_BY_EXTENSION[path.extname(filePath).toLowerCase()] ??
          DEFAULT_MIME,
        "content-length": String(stats.size),
        etag: `"${stats.size.toString(16)}-${stats.mtimeMs.toString(16)}"`,
      };
      if (req.headers["if-none-match"] === headers.etag) {
        res.writeHead(304, { ...BASE_HEADERS, etag: headers.etag });
        res.end();
        return;
      }
      res.writeHead(200, headers);
      if (req.method === "HEAD") {
        res.end();
        return;
      }
      // Stream from the open handle so nothing can be swapped underneath the read.
      // `FileHandle.createReadStream` owns the descriptor and closes it exactly once, on stream
      // close, end, or error, so it is also the right primitive for an aborted response.
      const stream = handle.createReadStream();
      stream.on("error", () => {
        res.destroy();
      });
      stream.pipe(res);
      handle = undefined;
      return;
    } catch {
      // Missing, a directory, a symlink (`O_NOFOLLOW` → ELOOP), or unreadable: all 404, no listing.
      sendStatus(res, 404, "not found");
    } finally {
      await handle?.close();
    }
  };
}
