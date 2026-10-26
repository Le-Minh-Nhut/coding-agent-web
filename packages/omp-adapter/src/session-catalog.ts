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
  async #summaryFor(sessionPath: string, parsed: ParsedHeaderAndMeta): Promise<NativeSessionSummary> {
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

  async listForCwd(cwd: string): Promise<NativeSessionSummary[]> {
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

    const summaries: NativeSessionSummary[] = [];

    for (const file of jsonlFiles) {
      const fullPath = path.join(bucketDir, file);
      const parsed = await this.#readHeaderAndMeta(fullPath);
      if (!parsed) continue;
      summaries.push(await this.#summaryFor(fullPath, parsed));
    }

    return summaries;
  }

  async listAll(limit?: number): Promise<NativeSessionSummary[]> {
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

    const summaries: NativeSessionSummary[] = [];
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
  async readHistory(sessionId: string, expectedCwd: string, limit = SESSION_HISTORY_MAX_ENTRIES): Promise<NativeSessionHistory> {
    const entryLimit = Number.isFinite(limit) ? Math.min(Math.max(Math.trunc(limit), 1), SESSION_HISTORY_MAX_ENTRIES) : SESSION_HISTORY_MAX_ENTRIES;
    if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/u.test(sessionId)) {
      throw Object.assign(new Error("Invalid native session ID"), { code: "path_forbidden" });
    }
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
      const truncatedByBytes = metadata.size > SESSION_HISTORY_MAX_BYTES;
      let prefixText: string;
      let entriesText: string;
      if (truncatedByBytes) {
        const prefix = Buffer.alloc(SESSION_HEADER_PREFIX_BYTES);
        const prefixRead = await handle.read(prefix, 0, prefix.length, 0);
        prefixText = prefix.toString("utf8", 0, prefixRead.bytesRead);
        const tailLength = SESSION_HISTORY_MAX_BYTES - prefixRead.bytesRead;
        const tail = Buffer.alloc(tailLength);
        const tailRead = await handle.read(tail, 0, tailLength, metadata.size - tailLength);
        entriesText = tail.toString("utf8", 0, tailRead.bytesRead);
        const firstNewline = entriesText.indexOf("\n");
        entriesText = firstNewline < 0 ? "" : entriesText.slice(firstNewline + 1);
      } else {
        const all = Buffer.alloc(metadata.size);
        const read = await handle.read(all, 0, metadata.size, 0);
        prefixText = all.toString("utf8", 0, read.bytesRead);
        entriesText = prefixText;
      }
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
      const expected = await realpath(expectedCwd);
      let actual: string;
      try { actual = await realpath(header.cwd); }
      catch { throw Object.assign(new Error("Native session journal does not belong to this project"), { code: "path_forbidden" }); }
      if (expected !== actual) throw Object.assign(new Error("Native session journal does not belong to this project"), { code: "path_forbidden" });
      if (!truncatedByBytes) entriesText = prefixLines.slice(headerLine + 1).join("\n");
      const entries: Array<Record<string, unknown>> = [];
      let entryCount = 0;
      let offset = 0;
      while (offset < entriesText.length) {
        const newline = entriesText.indexOf("\n", offset);
        const end = newline < 0 ? entriesText.length : newline;
        const line = entriesText.slice(offset, end);
        offset = end + 1;
        if (!line) continue;
        let entry: unknown;
        try { entry = JSON.parse(line); }
        catch { throw Object.assign(new Error("Native session journal contains an invalid entry"), { code: "path_forbidden" }); }
        if (!entry || typeof entry !== "object" || Array.isArray(entry)) throw Object.assign(new Error("Native session journal contains an invalid entry"), { code: "path_forbidden" });
        if (entryCount < entryLimit) entries.push(entry as Record<string, unknown>);
        else entries[entryCount % entryLimit] = entry as Record<string, unknown>;
        entryCount++;
      }
      const rotation = entryCount > entryLimit ? entryCount % entryLimit : 0;
      const orderedEntries = rotation ? [...entries.slice(rotation), ...entries.slice(0, rotation)] : entries;
      return { header, entries: orderedEntries, truncated: truncatedByBytes || entryCount > entryLimit };
    } finally {
      await handle.close();
    }
  }
}
