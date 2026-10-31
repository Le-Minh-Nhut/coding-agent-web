/**
 * Static web asset serving for Fastify.
 *
 * Serves the built product UI at `/` (with SPA fallback for unknown non-API routes)
 * and the fallback guest viewer at `/guest` (single-page, exact path only).
 */
import { constants as fsConstants, existsSync, realpathSync } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";

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

const BASE_HEADERS: Record<string, string> = {
  "Referrer-Policy": "no-referrer",
  "X-Content-Type-Options": "nosniff",
};
function cleanPathname(url: string): string {
  const query = url.indexOf("?");
  const withoutQuery = query === -1 ? url : url.slice(0, query);
  const hash = withoutQuery.indexOf("#");
  return hash === -1 ? withoutQuery : withoutQuery.slice(0, hash);
}

/**
 * Split a request target into safe path segments, or `null` when it attempts traversal
 * or contains forbidden characters (NUL, backslash, separator within segment, absolute segment).
 */
export function safeSegments(pathname: string): string[] | null {
  let decoded: string;
  try {
    decoded = decodeURIComponent(pathname);
  } catch {
    return null;
  }
  if (decoded.includes("\0") || decoded.includes("\\")) return null;
  if (decoded.startsWith("//") || pathname.startsWith("//")) return null;
  const segments: string[] = [];
  for (const segment of decoded.split("/")) {
    if (segment === "") continue;
    if (segment === "." || segment === "..") return null;
    if (segment.includes("/") || segment.includes("\\")) return null;
    if (path.isAbsolute(segment) || path.win32.isAbsolute(segment) || /^[a-zA-Z]:/.test(segment)) {
      return null;
    }
    segments.push(segment);
  }
  return segments;
}

/**
 * Confirm open file handle descriptor resolves inside real root.
 */
async function openedInsideRoot(
  handle: fs.FileHandle,
  filePath: string,
  rootReal: string,
): Promise<boolean> {
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
}

/**
 * Try to safely open and stream a file under rootReal.
 */
async function tryServeFile(
  filePath: string,
  rootReal: string,
  request: FastifyRequest,
  reply: FastifyReply,
  cacheControl: string,
): Promise<boolean> {
  let handle: fs.FileHandle | undefined;
  try {
    handle = await fs.open(filePath, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
    const stats = await handle.stat();
    if (!stats.isFile() || !(await openedInsideRoot(handle, filePath, rootReal))) {
      await handle.close();
      return false;
    }

    const ext = path.extname(filePath).toLowerCase();
    const contentType = MIME_BY_EXTENSION[ext] ?? DEFAULT_MIME;
    const etag = `"${stats.size.toString(16)}-${stats.mtimeMs.toString(16)}"`;

    reply.headers(BASE_HEADERS);
    reply.header("Cache-Control", cacheControl);
    reply.header("Content-Type", contentType);
    reply.header("Content-Length", stats.size);
    reply.header("ETag", etag);

    if (request.headers["if-none-match"] === etag) {
      await handle.close();
      reply.code(304).send();
      return true;
    }

    if (request.method === "HEAD") {
      await handle.close();
      reply.code(200).send();
      return true;
    }

    const stream = handle.createReadStream();
    reply.code(200).send(stream);
    return true;
  } catch (error) {
    await handle?.close();
    // ENOENT/ENOTDIR mean "not this file" and ELOOP a symlink we never serve: for
    // those the caller's 404 / SPA fallback is the honest answer. Every other
    // failure — EACCES, EIO, a bad descriptor — is a filesystem fault, and
    // reporting it as a missing file would disguise a real fault as a normal route
    // (AGENTS.md rule 6: unknown must not read as missing).
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "ENOTDIR" || code === "ELOOP") return false;
    throw error;
  }
}

export interface StaticWebOptions {
  webDistDir: string;
  guestDistDir: string;
}
export function registerStaticWeb(
  app: FastifyInstance,
  options: StaticWebOptions,
): void {
  const webExists = existsSync(options.webDistDir);
  if (!webExists) {
    app.log.warn(
      `Web build directory not found at ${options.webDistDir}. Run "pnpm --filter @caw/web build" to build web assets.`,
    );
  }

  const guestExists = existsSync(options.guestDistDir);
  if (!guestExists) {
    app.log.warn(
      `Guest build directory not found at ${options.guestDistDir}. Run "node scripts/build-guest.mjs" to build guest viewer.`,
    );
  }

  let webRootReal = path.resolve(options.webDistDir);
  try {
    webRootReal = realpathSync(webRootReal);
  } catch {
    // Keep resolved path if not yet present on disk
  }

  let guestRootReal = path.resolve(options.guestDistDir);
  try {
    guestRootReal = realpathSync(guestRootReal);
  } catch {
    // Keep resolved path if not yet present on disk
  }

  const handleGuest = async (request: FastifyRequest, reply: FastifyReply) => {
    if (request.method !== "GET" && request.method !== "HEAD") {
      return reply.code(405).send("Method Not Allowed");
    }
    reply.header(
      "Content-Security-Policy",
      "default-src 'none'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data: https:; connect-src 'self' ws: wss:; font-src 'self' data:; manifest-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self';",
    );

    if (!existsSync(options.guestDistDir)) {
      return reply
        .code(404)
        .type("text/plain; charset=utf-8")
        .send("Guest build missing. Run node scripts/build-guest.mjs");
    }

    const pathname = cleanPathname(request.url ?? "/guest");
    if (pathname === "/guest") {
      reply.headers(BASE_HEADERS);
      return reply.code(308).header("Location", "/guest/").type("text/plain; charset=utf-8").send("Permanent Redirect");
    }
    const subpath = pathname === "/guest/" ? "/" : pathname.slice("/guest".length);

    const segments = safeSegments(subpath);
    if (segments === null) {
      return reply.code(400).type("text/plain; charset=utf-8").send("Bad Request");
    }

    const targetPath =
      segments.length === 0
        ? path.join(guestRootReal, "index.html")
        : path.join(guestRootReal, ...segments);

    const isHashedAsset = segments[0] === "assets";
    const cacheControl = isHashedAsset
      ? "public, max-age=31536000, immutable"
      : "no-cache";

    const served = await tryServeFile(
      targetPath,
      guestRootReal,
      request,
      reply,
      cacheControl,
    );
    if (!served) {
      return reply.code(404).type("text/plain; charset=utf-8").send("Not Found");
    }
    return reply;
  };

  const handleWeb = async (request: FastifyRequest, reply: FastifyReply) => {
    if (request.method !== "GET" && request.method !== "HEAD") {
      return reply.code(405).send("Method Not Allowed");
    }

    const pathname = cleanPathname(request.url ?? "/");

    const segments = safeSegments(pathname);
    if (segments === null) {
      return reply.code(400).type("text/plain; charset=utf-8").send("Bad Request");
    }

    if (!existsSync(options.webDistDir)) {
      return reply
        .code(404)
        .type("text/plain; charset=utf-8")
        .send("Web build missing. Run pnpm --filter @caw/web build");
    }

    const targetPath =
      segments.length === 0
        ? path.join(webRootReal, "index.html")
        : path.join(webRootReal, ...segments);

    const isHashedAsset = segments[0] === "assets";
    const cacheControl = isHashedAsset
      ? "public, max-age=31536000, immutable"
      : "no-cache";

    const served = await tryServeFile(
      targetPath,
      webRootReal,
      request,
      reply,
      cacheControl,
    );
    if (served) return reply;

    // SPA fallback: non-/api, non-/guest, non-/r, non-/healthz path returns index.html
    if (segments[0] === "assets") {
      return reply.code(404).type("text/plain; charset=utf-8").send("Not Found");
    }
    const indexPath = path.join(webRootReal, "index.html");
    const spaServed = await tryServeFile(
      indexPath,
      webRootReal,
      request,
      reply,
      "no-cache",
    );
    if (spaServed) return reply;

    return reply
      .code(404)
      .type("text/plain; charset=utf-8")
      .send("Web build missing. Run pnpm --filter @caw/web build");
  };

  // Explicit guest routes (Fastify automatically handles HEAD for GET routes)
  app.get("/guest", handleGuest);
  app.get("/guest/*", handleGuest);

  // Explicit root route
  app.get("/", handleWeb);
  // Catch-all for unmatched routes: API 404s, reserved paths, or SPA fallback
  app.setNotFoundHandler(async (request, reply) => {
    const pathname = cleanPathname(request.url ?? "/");

    if (pathname === "/api" || pathname.startsWith("/api/")) {
      return reply.code(404).send({
        message: `Route ${request.method}:${pathname} not found`,
        error: "Not Found",
        statusCode: 404,
      });
    }

    if (
      pathname === "/r" ||
      pathname.startsWith("/r/") ||
      pathname === "/healthz"
    ) {
      return reply.code(404).type("text/plain; charset=utf-8").send("Not Found");
    }

    if (pathname === "/guest" || pathname.startsWith("/guest/")) {
      return handleGuest(request, reply);
    }

    return handleWeb(request, reply);
  });
}

export default registerStaticWeb;
