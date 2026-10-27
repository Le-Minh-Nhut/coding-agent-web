import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { constants, realpathSync } from "node:fs";
import { open, readdir, realpath, stat } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import path from "node:path";
import type { NativeSessionSummary } from "@caw/contracts";
import { DefaultSessionLeaseProbe } from "./session-lease.js";
import type { NativeSessionCatalog, NativeSessionHeader, NativeSessionHistory, SessionLeaseProbe } from "./types.js";

export const SESSION_HEADER_PREFIX_BYTES = 64 * 1024;
export const SESSION_HISTORY_MAX_BYTES = 2 * 1024 * 1024;
export const SESSION_HISTORY_MAX_ENTRIES = 500;

export interface SessionCatalogOptions {
  sessionsRoot?: string;
  leaseProbe?: SessionLeaseProbe;
  isTracked?: (sessionId: string) => boolean;
  stat?: typeof stat;
  realpath?: typeof realpathSync;
}

function resolveCanonical(inputPath: string, realpath: typeof realpathSync): string {
  const resolved = path.resolve(inputPath);
  try {
    return realpath(resolved);
  } catch (err) {
    if (err && typeof err === "object" && "code" in err && err.code === "ENOENT") {
      // OMP may be asked to encode a not-yet-created cwd; lexical path is then the only available, non-authoritative identity.
      return resolved;
    }
    throw err;
  }
}

function isRelativeWithin(relative: string): boolean {
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

export function encodeSessionDirName(
  cwd: string,
  options?: { homeDir?: string; tempDir?: string; realpath?: typeof realpathSync },
): string {
  const realpath = options?.realpath ?? realpathSync;
  const canonicalCwd = resolveCanonical(cwd, realpath);
  const canonicalHome = resolveCanonical(options?.homeDir ?? homedir(), realpath);
  const canonicalTemp = resolveCanonical(options?.tempDir ?? tmpdir(), realpath);

  const tempRelative = path.relative(canonicalTemp, canonicalCwd);
  if (isRelativeWithin(tempRelative)) {
    const encoded = tempRelative.replace(/[/\\:]/g, "-");
    return encoded ? `-tmp-${encoded}` : "-tmp";
  }

  const homeRelative = path.relative(canonicalHome, canonicalCwd);
  if (isRelativeWithin(homeRelative)) {
    const encoded = homeRelative.replace(/[/\\:]/g, "-");
    return encoded ? `-${encoded}` : "-";
  }

  return `--${canonicalCwd.replace(/^[/\\]/, "").replace(/[/\\:]/g, "-")}--`;
}

interface ParsedHeaderAndMeta {
  header: NativeSessionHeader;
  updatedAt: string | null;
}

/** True for a directory that simply is not there; every other failure is a read we could not do. */
function isMissingDirectory(err: unknown): boolean {
  return Boolean(err && typeof err === "object" && "code" in err && err.code === "ENOENT");
}

const historyCursorSecret = randomBytes(32);

interface HistoryCursor {
  sessionId: string;
  cwdHash: string;
  dev: number;
  ino: number;
  size: number;
  end: number;
}

function encodeHistoryCursor(cursor: HistoryCursor): string {
  const payload = Buffer.from(JSON.stringify(cursor)).toString("base64url");
  const signature = createHmac("sha256", historyCursorSecret).update(payload).digest("base64url");
  return `${payload}.${signature}`;
}

function decodeHistoryCursor(value: string): HistoryCursor {
  const [payload, signature, ...extra] = value.split(".");
  if (!payload || !signature || extra.length || Buffer.from(payload, "base64url").toString("base64url") !== payload || Buffer.from(signature, "base64url").toString("base64url") !== signature) {
    throw Object.assign(new Error("Invalid native session history cursor"), { code: "path_forbidden" });
  }
  const expected = createHmac("sha256", historyCursorSecret).update(payload).digest();
  const provided = Buffer.from(signature, "base64url");
  if (provided.length !== expected.length || !timingSafeEqual(provided, expected)) {
    throw Object.assign(new Error("Invalid native session history cursor"), { code: "path_forbidden" });
  }
  try {
    const parsed = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as Partial<HistoryCursor>;
    if (typeof parsed.sessionId !== "string" || typeof parsed.cwdHash !== "string" || !/^[A-Za-z0-9_-]{43}$/u.test(parsed.cwdHash) || !Number.isSafeInteger(parsed.dev) || !Number.isSafeInteger(parsed.ino) || !Number.isSafeInteger(parsed.size) || !Number.isSafeInteger(parsed.end)) throw new Error();
    return parsed as HistoryCursor;
  } catch {
    throw Object.assign(new Error("Invalid native session history cursor"), { code: "path_forbidden" });
  }
}

export class DefaultNativeSessionCatalog implements NativeSessionCatalog {
  readonly #sessionsRoot: string;
  readonly #leaseProbe: SessionLeaseProbe;
  readonly #isTracked: (sessionId: string) => boolean;
  readonly #stat: typeof stat;
  constructor(options: SessionCatalogOptions = {}) {
    this.#sessionsRoot =
      options.sessionsRoot ??
      (process.env.PI_CODING_AGENT_DIR
        ? path.join(process.env.PI_CODING_AGENT_DIR, "sessions")
        : path.join(homedir(), ".omp", "agent", "sessions"));
    this.#leaseProbe = options.leaseProbe ?? new DefaultSessionLeaseProbe();
    this.#isTracked = options.isTracked ?? (() => false);
    this.#stat = options.stat ?? stat;
  }

  async readHeader(sessionPath: string): Promise<NativeSessionHeader | null> {
    const parsed = await this.#readHeaderAndMeta(sessionPath);
    return parsed ? parsed.header : null;
  }

  /**
   * Read one journal's header and last-updated time.
   *
   * `null` is a *confirmed* negative: the bytes are there and are not a session
   * journal. Throwing means the read itself failed, which callers must keep
   * separate — "this file is not a session" and "I could not find out" are
   * different answers, and only the first may be reported as a fact.
   */
  async #readHeaderAndMeta(sessionPath: string): Promise<ParsedHeaderAndMeta | null> {
    let handle;
    try {
      handle = await open(sessionPath, "r");
      const buffer = Buffer.alloc(SESSION_HEADER_PREFIX_BYTES);
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
      if (bytesRead === 0) return null;

      const content = buffer.toString("utf8", 0, bytesRead);
      const lines = content.split("\n");
      if (lines.length === 0) return null;

      let title: string | null = null;
      let updatedAt: string | null = null;
      let headerLineIndex = 0;

      const firstLine = lines[0]?.trim();
      if (firstLine) {
        try {
          const slot = JSON.parse(firstLine) as Record<string, unknown>;
          if (slot.type === "title" && slot.v === 1) {
            title = typeof slot.title === "string" && slot.title ? slot.title : null;
            updatedAt = typeof slot.updatedAt === "string" ? slot.updatedAt : null;
            headerLineIndex = 1;
          }
        } catch {
          // not a valid title slot JSON, treat line 0 as candidate header
        }
      }

      const headerRaw = lines[headerLineIndex]?.trim();
      if (!headerRaw) return null;

      // A malformed header is a confirmed negative (the file is not a journal),
      // so it keeps the `null` answer rather than throwing.
      let headerObj: Record<string, unknown>;
      try {
        headerObj = JSON.parse(headerRaw) as Record<string, unknown>;
      } catch {
        return null;
      }
      if (
        !headerObj ||
        headerObj.type !== "session" ||
        typeof headerObj.id !== "string"
      ) {
        return null;
      }

      const sessionId = headerObj.id;
      const cwd = typeof headerObj.cwd === "string" ? headerObj.cwd : "";
      const timestamp = typeof headerObj.timestamp === "string" ? headerObj.timestamp : null;
      const version = typeof headerObj.version === "number" ? headerObj.version : null;
      if (!title && typeof headerObj.title === "string") {
        title = headerObj.title;
      }

      return {
        header: {
          sessionId,
          cwd,
          timestamp,
          version,
          title,
        },
        updatedAt: updatedAt ?? timestamp,
      };
    } finally {
      if (handle) {
        await handle.close().catch(() => {});
      }
    }
  }

  /** Last-updated is optional metadata; only ENOENT means its fallback is unavailable, other probe failures propagate. */
  async #summaryFor(sessionPath: string, parsed: ParsedHeaderAndMeta): Promise<Omit<NativeSessionSummary, "hasCollabHost">> {
    let updatedAt = parsed.updatedAt;
    if (!updatedAt) {
      try {
        updatedAt = (await this.#stat(sessionPath)).mtime.toISOString();
      } catch (err) {
        if (!isMissingDirectory(err)) throw err;
        // The journal bytes were already read; missing freshness metadata cannot change the existence result.
        updatedAt = null;
      }
    }
    return {
      sessionId: parsed.header.sessionId,
      path: sessionPath,
      cwd: parsed.header.cwd,
      title: parsed.header.title,
      updatedAt,
      live: await this.#leaseProbe.isLive(parsed.header.sessionId),
      tracked: this.#isTracked(parsed.header.sessionId),
    };
  }

  async listForCwd(cwd: string): Promise<Array<Omit<NativeSessionSummary, "hasCollabHost">>> {
    const bucket = encodeSessionDirName(cwd);
    const bucketDir = path.join(this.#sessionsRoot, bucket);

    let entries: string[];
    try {
      entries = await readdir(bucketDir);
    } catch (err) {
      // No bucket means this directory has never hosted a session: an empty list
      // is a confirmed answer. Anything else is an unreadable store, and callers
      // must be able to tell that apart from "no sessions".
      if (isMissingDirectory(err)) return [];
      throw err;
    }

    const jsonlFiles = entries
      .filter((name) => name.endsWith(".jsonl"))
      .sort((a, b) => b.localeCompare(a)); // ISO timestamps prefix sorts newest first

    const summaries: Array<Omit<NativeSessionSummary, "hasCollabHost">> = [];

    for (const file of jsonlFiles) {
      const fullPath = path.join(bucketDir, file);
      const parsed = await this.#readHeaderAndMeta(fullPath);
      if (!parsed) continue;
      summaries.push(await this.#summaryFor(fullPath, parsed));
    }

    return summaries;
  }

  async listAll(limit?: number): Promise<Array<Omit<NativeSessionSummary, "hasCollabHost">>> {
    let bucketDirs: string[];
    try {
      bucketDirs = await readdir(this.#sessionsRoot);
    } catch (err) {
      // No store at all means no sessions have ever been recorded.
      if (isMissingDirectory(err)) return [];
      throw err;
    }

    const allFiles: Array<{ bucketDir: string; file: string }> = [];

    for (const b of bucketDirs) {
      const fullBucketDir = path.join(this.#sessionsRoot, b);
      try {
        const files = await readdir(fullBucketDir);
        for (const file of files) {
          if (file.endsWith(".jsonl")) {
            allFiles.push({ bucketDir: fullBucketDir, file });
          }
        }
      } catch (err) {
        if (isMissingDirectory(err)) continue;
        throw err;
      }
    }

    allFiles.sort((a, b) => b.file.localeCompare(a.file));
    const targetFiles = limit !== undefined && limit >= 0 ? allFiles.slice(0, limit) : allFiles;

    const summaries: Array<Omit<NativeSessionSummary, "hasCollabHost">> = [];
    for (const { bucketDir, file } of targetFiles) {
      const fullPath = path.join(bucketDir, file);
      const parsed = await this.#readHeaderAndMeta(fullPath);
      if (!parsed) continue;
      summaries.push(await this.#summaryFor(fullPath, parsed));
    }

    return summaries;
  }

  async findBySessionId(sessionId: string): Promise<string | null> {
    let bucketDirs: string[];
    try {
      bucketDirs = await readdir(this.#sessionsRoot);
    } catch (err) {
      if (isMissingDirectory(err)) return null;
      throw err;
    }

    const suffix = `_${sessionId}.jsonl`;
    const exact = `${sessionId}.jsonl`;

    for (const b of bucketDirs) {
      const fullBucketDir = path.join(this.#sessionsRoot, b);
      let files: string[];
      try {
        files = await readdir(fullBucketDir);
      } catch (err) {
        if (isMissingDirectory(err)) continue;
        throw err;
      }
      for (const file of files) {
        if (file.endsWith(suffix) || file === exact) {
          return path.join(fullBucketDir, file);
        }
      }
    }

    return null;
  }
  async readHistory(sessionId: string, expectedCwd: string, options: number | { before?: string } = {}): Promise<NativeSessionHistory> {
    const limit = typeof options === "number" ? options : SESSION_HISTORY_MAX_ENTRIES;
    const entryLimit = Number.isFinite(limit) ? Math.min(Math.max(Math.trunc(limit), 1), SESSION_HISTORY_MAX_ENTRIES) : SESSION_HISTORY_MAX_ENTRIES;
    const cursor = typeof options === "object" && options.before !== undefined ? decodeHistoryCursor(options.before) : null;
    if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/u.test(sessionId)) {
      throw Object.assign(new Error("Invalid native session ID"), { code: "path_forbidden" });
    }
    if (cursor && cursor.sessionId !== sessionId) throw Object.assign(new Error("History cursor belongs to another session"), { code: "path_forbidden" });
    const live = await this.#leaseProbe.isLive(sessionId);
    if (live !== false) throw Object.assign(new Error(live === true ? "Native session is currently live" : "Native session liveness could not be verified"), { code: "conflict_owner" });
    const candidate = await this.findBySessionId(sessionId);
    if (!candidate) throw Object.assign(new Error("Native session journal was not found"), { code: "not_found" });
    let root: string;
    let file: string;
    try {
      root = await realpath(this.#sessionsRoot);
      file = await realpath(candidate);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") throw Object.assign(new Error("Native session journal was not found"), { code: "not_found" });
      throw error;
    }
    if (!isRelativeWithin(path.relative(root, file))) throw Object.assign(new Error("Native session journal is outside the OMP session store"), { code: "path_forbidden" });
    const handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const metadata = await handle.stat();
      if (!metadata.isFile()) throw Object.assign(new Error("Native session journal is not a regular file"), { code: "path_forbidden" });
      let openedPath: string;
      try { openedPath = await realpath(`/proc/self/fd/${handle.fd}`); }
      catch { throw Object.assign(new Error("Cannot verify native session journal location"), { code: "path_forbidden" }); }
      if (!isRelativeWithin(path.relative(root, openedPath))) throw Object.assign(new Error("Native session journal is outside the OMP session store"), { code: "path_forbidden" });
      const expected = await realpath(expectedCwd);
      const prefix = Buffer.alloc(SESSION_HEADER_PREFIX_BYTES);
      const prefixRead = await handle.read(prefix, 0, prefix.length, 0);
      const prefixText = prefix.toString("utf8", 0, prefixRead.bytesRead);
      const prefixLines = prefixText.split("\n");
      let headerLine = 0;
      let title: string | null = null;
      if (prefixLines[0]?.trim()) {
        try {
          const slot = JSON.parse(prefixLines[0]) as Record<string, unknown>;
          if (slot.type === "title" && slot.v === 1) {
            title = typeof slot.title === "string" ? slot.title : null;
            headerLine = 1;
          }
        } catch { /* The first line may itself be the session header. */ }
      }
      const headerEnd = Buffer.byteLength(prefixLines.slice(0, headerLine + 1).join("\n"), "utf8") + 1;
      let rawHeader: Record<string, unknown>;
      try { rawHeader = JSON.parse(prefixLines[headerLine] ?? "") as Record<string, unknown>; }
      catch { throw Object.assign(new Error("Native session journal header is invalid"), { code: "path_forbidden" }); }
      if (rawHeader.type !== "session" || rawHeader.id !== sessionId || typeof rawHeader.cwd !== "string") throw Object.assign(new Error("Native session journal does not match the requested session"), { code: "path_forbidden" });
      const header: NativeSessionHeader = {
        sessionId,
        cwd: rawHeader.cwd,
        timestamp: typeof rawHeader.timestamp === "string" ? rawHeader.timestamp : null,
        version: typeof rawHeader.version === "number" ? rawHeader.version : null,
        title: title ?? (typeof rawHeader.title === "string" ? rawHeader.title : null),
      };
      let actual: string;
      try { actual = await realpath(header.cwd); }
      catch { throw Object.assign(new Error("Native session journal does not belong to this project"), { code: "path_forbidden" }); }
      const cwdHash = createHash("sha256").update(expected).digest("base64url");
      if (expected !== actual || (cursor && cursor.cwdHash !== cwdHash)) throw Object.assign(new Error("Native session journal does not belong to this project"), { code: "path_forbidden" });
      if (cursor && (cursor.dev !== metadata.dev || cursor.ino !== metadata.ino || metadata.size < cursor.size || cursor.end < headerEnd || cursor.end > cursor.size)) {
        throw Object.assign(new Error("History cursor no longer matches this journal"), { code: "path_forbidden" });
      }

      const end = cursor?.end ?? metadata.size;
      const start = Math.max(headerEnd, end - SESSION_HISTORY_MAX_BYTES);
      const window = Buffer.alloc(end - start);
      const windowRead = await handle.read(window, 0, window.length, start);
      const firstNewline = start > headerEnd ? window.indexOf(10, 0) : -1;
      let contentStart = 0;
      let skippedOversized = false;
      if (start > headerEnd) {
        if (firstNewline < 0) {
          contentStart = windowRead.bytesRead;
          skippedOversized = windowRead.bytesRead === SESSION_HISTORY_MAX_BYTES;
        } else {
          const previousByte = Buffer.alloc(1);
          await handle.read(previousByte, 0, 1, start - 1);
          if (previousByte[0] !== 10) {
            contentStart = firstNewline + 1;
            if (windowRead.bytesRead === SESSION_HISTORY_MAX_BYTES) {
              const lookbackLength = Math.min(SESSION_HISTORY_MAX_BYTES, start - headerEnd);
              const lookbackStart = start - lookbackLength;
              const lookback = Buffer.alloc(lookbackLength);
              const lookbackRead = await handle.read(lookback, 0, lookbackLength, lookbackStart);
              const previousNewline = lookback.lastIndexOf(10, lookbackRead.bytesRead - 1);
              const lineStart = previousNewline >= 0
                ? lookbackStart + previousNewline + 1
                : lookbackStart === headerEnd ? headerEnd : null;
              skippedOversized = lineStart === null || start + firstNewline + 1 - lineStart > SESSION_HISTORY_MAX_BYTES;
            }
          }
        }
      }
      const completeEnd = window.lastIndexOf(10, windowRead.bytesRead - 1);
      const lineLimit = entryLimit + 1;
      const lines: Array<{ start: number; text: string }> = [];
      let lineCount = 0;
      let lineStart = contentStart;
      if (completeEnd >= contentStart) {
        for (let newline = window.indexOf(10, contentStart); newline >= 0 && newline <= completeEnd; newline = window.indexOf(10, newline + 1)) {
          if (newline > lineStart) {
            lines[lineCount % lineLimit] = { start: start + lineStart, text: window.toString("utf8", lineStart, newline) };
            lineCount++;
          }
          lineStart = newline + 1;
        }
      }
      const rotation = lineCount > lineLimit ? lineCount % lineLimit : 0;
      const orderedLines = rotation ? [...lines.slice(rotation), ...lines.slice(0, rotation)] : lines;
      const pageLines = orderedLines.slice(-entryLimit);
      const entries: Array<Record<string, unknown>> = [];
      for (const line of pageLines) {
        let entry: unknown;
        try { entry = JSON.parse(line.text); }
        catch { throw Object.assign(new Error("Native session journal contains an invalid entry"), { code: "path_forbidden" }); }
        if (!entry || typeof entry !== "object" || Array.isArray(entry)) throw Object.assign(new Error("Native session journal contains an invalid entry"), { code: "path_forbidden" });
        entries.push(entry as Record<string, unknown>);
      }
      const firstEntry = pageLines[0]?.start;
      const hasOlder = firstEntry !== undefined ? firstEntry > headerEnd : start > headerEnd;
      const truncatedByEntries = lines.length > entryLimit;
      const truncatedByBytes = start > headerEnd;
      const nextCursor = hasOlder
        ? encodeHistoryCursor({ sessionId, cwdHash, dev: metadata.dev, ino: metadata.ino, size: cursor?.size ?? metadata.size, end: firstEntry ?? start })
        : null;
      return { header, entries, truncated: truncatedByBytes || truncatedByEntries, truncatedByBytes, truncatedByEntries, skippedOversized, hasOlder, nextCursor };
    } finally {
      await handle.close();
    }
  }
}
