import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { constants, realpathSync } from "node:fs";
import { open, readdir, realpath, stat } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import path from "node:path";
import { resolveOmpDirs } from "./omp-dirs.js";
import type { NativeSessionSummary } from "@caw/contracts";
import { DefaultSessionLeaseProbe } from "./session-lease.js";
import type { NativeSessionCatalog, NativeHandoffCompaction, NativeSessionHeader, NativeSessionHistory, NativeVibeWorkers, SessionLeaseProbe } from "./types.js";

export const SESSION_HEADER_PREFIX_BYTES = 64 * 1024;
export const SESSION_HISTORY_MAX_BYTES = 2 * 1024 * 1024;
export const SESSION_HISTORY_MAX_ENTRIES = 500;
/**
 * How far back from the tip one handoff-evidence read looks.
 *
 * A handoff compaction is appended at the journal tip, so this window normally
 * contains it, and it is deliberately small because the check runs against a
 * *live* session. The known ceiling, stated rather than hidden: if more than
 * this is appended after the compaction before we look, `delivered` is reported
 * for a handoff that did commit. Reaching it needs a positive evidence budget
 * plus a lot of output inside it — the default budget is one immediate read, and
 * the largest handoff entry observed in the owner's journals is ~75 KB.
 * ponytail: upgrade path is a second bounded read over the same window from the
 * head, if a miss is ever observed on a journal larger than this.
 */
export const HANDOFF_EVIDENCE_MAX_BYTES = 1024 * 1024;

/**
 * Journal custom-entry type for Vibe worker lifecycle.
 *
 * Mirrors upstream `vibe/lifecycle.ts:14-16`. It is duplicated as a literal rather
 * than imported because this package must not depend on the OMP source tree; the
 * string is a wire contract of the journal, and a rename upstream would surface as
 * "no workers proven" (read-only UI), never as a wrong kill target.
 */
export const VIBE_LIFECYCLE_TYPE = "vibe-session-lifecycle";

export interface SessionCatalogOptions {
  sessionsRoot?: string;
  leaseProbe?: SessionLeaseProbe;
  isTracked?: (sessionId: string) => boolean;
  stat?: typeof stat;
  realpath?: typeof realpathSync;
  maxGlobalFiles?: number;
  globalCacheTtlMs?: number;
  disableGlobalCache?: boolean;
}

interface DetailedSessionScan {
  sessions: Array<Omit<NativeSessionSummary, "hasCollabHost"> & { startedAt: string | null }>;
  filesScanned: number;
  filesSkippedNonJournal: number;
  /** Journals a scan could not read (not ENOENT). Non-zero means the page is incomplete. */
  filesUnreadable: number;
  truncated: boolean;
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
  readonly #maxGlobalFiles: number;
  readonly #globalCacheTtlMs: number;
  readonly #disableGlobalCache: boolean;
  #globalCache: { signature: string; expiresAt: number; result: DetailedSessionScan } | null = null;
  constructor(options: SessionCatalogOptions = {}) {
    this.#sessionsRoot = options.sessionsRoot ?? resolveOmpDirs({ agentDirOverride: process.env.PI_CODING_AGENT_DIR }).sessionsDir;
    this.#leaseProbe = options.leaseProbe ?? new DefaultSessionLeaseProbe();
    this.#isTracked = options.isTracked ?? (() => false);
    this.#stat = options.stat ?? stat;
    this.#maxGlobalFiles = options.maxGlobalFiles ?? 5000;
    this.#globalCacheTtlMs = options.globalCacheTtlMs ?? 30_000;
    this.#disableGlobalCache = options.disableGlobalCache ?? false;
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
      let slotUpdatedAt: string | null = null;
      let headerLineIndex = 0;

      const firstLine = lines[0]?.trim();
      if (firstLine) {
        try {
          const slot = JSON.parse(firstLine) as Record<string, unknown>;
          if (slot.type === "title" && slot.v === 1) {
            title = typeof slot.title === "string" && slot.title ? slot.title : null;
            slotUpdatedAt = typeof slot.updatedAt === "string" ? slot.updatedAt : null;
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
      if (!title && typeof headerObj.title === "string") title = headerObj.title;
      if (!title) {
        for (const line of lines.slice(headerLineIndex + 1)) {
          try {
            const entry = JSON.parse(line) as Record<string, unknown>;
            if (entry.type !== "message" || entry.role !== "user") continue;
            const content = entry.content;
            const text = typeof content === "string" ? content : Array.isArray(content)
              ? content.filter((part): part is { type: "text"; text: string } => Boolean(part && typeof part === "object" && (part as Record<string, unknown>).type === "text" && typeof (part as Record<string, unknown>).text === "string")).map((part) => part.text).join("")
              : "";
            const prompt = text.replace(/[\r\n]+/gu, " ").trim().slice(0, 120);
            if (prompt) { title = prompt; break; }
          } catch { /* A malformed journal entry is not a title. */ }
        }
      }

      const result = {
        header: {
          sessionId,
          cwd,
          timestamp,
          version,
          title,
        },
        // OMP uses file mtime for recency; its title-slot timestamp may lag while a journal is active.
        updatedAt: slotUpdatedAt,
      };

      return result;

    } finally {
      if (handle) {
        await handle.close().catch(() => {});
      }
    }
  }

  /** mtime matches OMP's picker; the slot timestamp only covers filesystems without usable mtime. */
  async #summaryFor(sessionPath: string, parsed: ParsedHeaderAndMeta): Promise<Omit<NativeSessionSummary, "hasCollabHost">> {
    let updatedAt: string | null = null;
    let cwdAvailable = true;
    try { updatedAt = (await this.#stat(sessionPath)).mtime.toISOString(); }
    catch (err) { if (!isMissingDirectory(err)) throw err; updatedAt = parsed.updatedAt; }
    try { await stat(parsed.header.cwd); }
    catch (err) { if ((err as NodeJS.ErrnoException).code === "ENOENT") cwdAvailable = false; else throw err; }
    return {
      sessionId: parsed.header.sessionId,
      path: sessionPath,
      cwd: parsed.header.cwd,
      title: parsed.header.title,
      updatedAt,
      cwdAvailable,
      conversationId: null,
      live: await this.#leaseProbe.isLive(parsed.header.sessionId),
      tracked: this.#isTracked(parsed.header.sessionId),
    };
  }

  async listForCwd(cwd: string): Promise<Array<Omit<NativeSessionSummary, "hasCollabHost">>> {
    const bucketDir = path.join(this.#sessionsRoot, encodeSessionDirName(cwd));
    let entries: string[];
    try { entries = await readdir(bucketDir); }
    catch (err) { if (isMissingDirectory(err)) entries = []; else throw err; }
    const canonicalCwd = resolveCanonical(cwd, realpathSync);
    const summaries: Array<Omit<NativeSessionSummary, "hasCollabHost">> = [];
    // A `.jsonl` *name* is not a journal: `encodeSessionDirName` can legally end a
    // bucket directory's name in `.jsonl`, and `open(dir,"r")` succeeds on Linux
    // before the read fails EISDIR. So every candidate is proved to be a regular
    // file first, and a vanished entry is skipped rather than fatal.
    const addMatching = async (base: string, files: string[]) => {
      for (const file of files.filter((name) => name.endsWith(".jsonl"))) {
        const fullPath = path.join(base, file);
        try {
          if (!(await this.#stat(fullPath)).isFile()) continue;
        } catch (err) {
          if (isMissingDirectory(err)) continue;
          throw err;
        }
        const parsed = await this.#readHeaderAndMeta(fullPath);
        if (!parsed) continue;
        if (resolveCanonical(parsed.header.cwd, realpathSync) === canonicalCwd) summaries.push(await this.#summaryFor(fullPath, parsed));
      }
    };
    await addMatching(bucketDir, entries);
    let rootEntries: string[];
    try { rootEntries = await readdir(this.#sessionsRoot); }
    catch (err) { if (isMissingDirectory(err)) return summaries; throw err; }
    await addMatching(this.#sessionsRoot, rootEntries);
    // Newest first, matching the global listing and what `types.ts` documents.
    summaries.sort((a, b) => (b.updatedAt ?? "").localeCompare(a.updatedAt ?? "") || a.sessionId.localeCompare(b.sessionId));
    return summaries;
  }

  async listAll(limit?: number): Promise<Array<Omit<NativeSessionSummary, "hasCollabHost">>> {
    let names: string[];
    try { names = await readdir(this.#sessionsRoot); }
    catch (err) { if (isMissingDirectory(err)) return []; throw err; }
    const allFiles: string[] = [];
    for (const name of names) {
      const fullPath = path.join(this.#sessionsRoot, name);
      if (name.endsWith(".jsonl")) {
        // A directory can legally carry a `.jsonl` name; only regular files are journals.
        try { if (!(await this.#stat(fullPath)).isFile()) continue; } catch (err) { if (!isMissingDirectory(err)) throw err; continue; }
        allFiles.push(fullPath);
        continue;
      }
      try {
        if ((await this.#stat(fullPath)).isDirectory()) for (const file of await readdir(fullPath)) if (file.endsWith(".jsonl")) allFiles.push(path.join(fullPath, file));
      } catch (err) { if (!isMissingDirectory(err)) throw err; }
    }
    allFiles.sort((a, b) => b.localeCompare(a));
    const summaries: Array<Omit<NativeSessionSummary, "hasCollabHost">> = [];
    for (const fullPath of limit !== undefined && limit >= 0 ? allFiles.slice(0, limit) : allFiles) {
      const parsed = await this.#readHeaderAndMeta(fullPath);
      if (parsed) summaries.push(await this.#summaryFor(fullPath, parsed));
    }
    return summaries;
  }
  async listAllDetailed(options: { limit?: number; cacheTtlMs?: number } = {}): Promise<DetailedSessionScan> {
    const limit = Math.max(0, Math.trunc(options.limit ?? this.#maxGlobalFiles));
    const ttl = options.cacheTtlMs ?? this.#globalCacheTtlMs;
    let names: string[];
    try { names = await readdir(this.#sessionsRoot); }
    catch (error) {
      if (isMissingDirectory(error)) return { sessions: [], filesScanned: 0, filesSkippedNonJournal: 0, filesUnreadable: 0, truncated: false };
      throw error;
    }
    const files: string[] = [];
    // Bucket names are collected here and reused for the cache signature: reading
    // the directory twice would let a bucket deleted in between throw ENOENT out
    // of a listing that had already succeeded in enumerating it.
    const buckets: Array<{ dir: string; journals: string[] }> = [];
    for (const name of names) {
      const filePath = path.join(this.#sessionsRoot, name);
      if (name.endsWith(".jsonl")) {
        // A directory can legally be named `*.jsonl`; a directory is not a journal.
        try { if (!(await this.#stat(filePath)).isFile()) continue; } catch (error) { if (!isMissingDirectory(error)) throw error; continue; }
        files.push(filePath);
        continue;
      }
      try {
        if ((await this.#stat(filePath)).isDirectory()) {
          const journals = (await readdir(filePath)).filter((file) => file.endsWith(".jsonl")).sort();
          buckets.push({ dir: filePath, journals });
          for (const file of journals) files.push(path.join(filePath, file));
        }
      } catch (error) { if (!isMissingDirectory(error)) throw error; }
    }
    // ponytail: process-local cache detects journal-name changes, not edits; TTL bounds content staleness, watcher only if observed stale.
    const signature = JSON.stringify([names.sort(), buckets.sort((a, b) => a.dir.localeCompare(b.dir))]);
    if (!this.#disableGlobalCache && ttl > 0 && this.#globalCache?.signature === signature && Date.now() < this.#globalCache.expiresAt) return this.#globalCache.result;

    files.sort((a, b) => b.localeCompare(a));
    const target = files.slice(0, limit);
    const sessions: DetailedSessionScan["sessions"] = [];
    let filesScanned = 0;
    let filesSkippedNonJournal = 0;
    let filesUnreadable = 0;
    let cursor = 0;
    const worker = async () => {
      while (true) {
        const index = cursor++;
        if (index >= target.length) return;
        try {
          const parsed = await this.#readHeaderAndMeta(target[index]!);
          filesScanned++;
          if (!parsed) { filesSkippedNonJournal++; continue; }
          sessions.push({ ...(await this.#summaryFor(target[index]!, parsed)), startedAt: parsed.header.timestamp });
        } catch (error) {
          // A journal that vanished mid-scan is a confirmed non-event; anything
          // else is a read we could not do. It is counted so the page can say it
          // is incomplete instead of looking like a short-but-complete list.
          if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
          filesUnreadable++;
        }
      }
    };
    await Promise.all(Array.from({ length: Math.min(16, target.length) }, worker));
    // Inserts newer than the cursor may shift mutable pages and skip rows; strict ordering never repeats a row.
    sessions.sort((a, b) => (b.updatedAt ?? "").localeCompare(a.updatedAt ?? "") || a.sessionId.localeCompare(b.sessionId));
    const result = { sessions, filesScanned, filesSkippedNonJournal, filesUnreadable, truncated: files.length > target.length };
    // ponytail: process-local TTL cache has no cross-process invalidation; use a filesystem watcher only if staleness is observed.
    if (!this.#disableGlobalCache && ttl > 0) this.#globalCache = { signature, expiresAt: Date.now() + ttl, result };
    return result;
  }

  async findBySessionId(sessionId: string): Promise<string | null> {
    let entries: string[];
    try { entries = await readdir(this.#sessionsRoot); }
    catch (err) { if (isMissingDirectory(err)) return null; throw err; }
    const suffix = `_${sessionId}.jsonl`;
    const exact = `${sessionId}.jsonl`;
    for (const file of entries) if (file.endsWith(suffix) || file === exact) return path.join(this.#sessionsRoot, file);
    for (const name of entries) {
      const bucketDir = path.join(this.#sessionsRoot, name);
      let files: string[];
      try { if (!(await this.#stat(bucketDir)).isDirectory()) continue; files = await readdir(bucketDir); }
      catch (err) { if (isMissingDirectory(err)) continue; throw err; }
      for (const file of files) if (file.endsWith(suffix) || file === exact) return path.join(bucketDir, file);
    }
    return null;
  }
  /**
   * Find the newest native handoff compaction newer than `sinceMs`.
   *
   * Deliberately a *tail* scan with no lease probe: the question "did the
   * handoff commit" is asked while the session is live, which is exactly when
   * `readHistory`'s liveness gate would refuse. The answer is bounded and
   * cancellable by the caller (a single read, no polling loop here), and a
   * missing/unreadable journal is `null` — no evidence — never a failure the
   * route would have to turn into a claim.
   */
  async readHandoffCompaction(sessionId: string, sinceMs: number): Promise<NativeHandoffCompaction | null> {
    if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/u.test(sessionId)) return null;
    const candidate = await this.findBySessionId(sessionId);
    if (!candidate) return null;
    // `findBySessionId` matches on the *file name*, which is not identity: two
    // roots can hold journals with the same stem, and a journal can be copied
    // under another session's name. The header `id` is the authority, and the
    // same corroboration `readGlobalHistory` performs (server.ts) is required
    // here — otherwise a foreign journal's compaction would be reported as this
    // session's commit, which is exactly the claim the state machine must not
    // make without evidence.
    let header: NativeSessionHeader | null;
    try {
      header = await this.readHeader(candidate);
    } catch {
      return null;
    }
    if (!header || header.sessionId !== sessionId) return null;
    let handle;
    try {
      handle = await open(candidate, constants.O_RDONLY | constants.O_NOFOLLOW);
    } catch {
      return null;
    }
    try {
      const metadata = await handle.stat();
      if (!metadata.isFile()) return null;
      const start = Math.max(0, metadata.size - HANDOFF_EVIDENCE_MAX_BYTES);
      const window = Buffer.alloc(metadata.size - start);
      const read = await handle.read(window, 0, window.length, start);
      const text = window.toString("utf8", 0, read.bytesRead);
      // When the window does not start at the file head, its first line may be a
      // torn suffix of a record; dropping it is what keeps a partial JSON line
      // from reading as evidence.
      const lines = text.split("\n");
      if (start > 0) lines.shift();
      let latest: NativeHandoffCompaction | null = null;
      for (const line of lines) {
        if (!line.includes('"compaction"') || !line.includes('"handoff"')) continue;
        let entry: Record<string, unknown>;
        try {
          const parsed: unknown = JSON.parse(line);
          if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) continue;
          entry = parsed as Record<string, unknown>;
        } catch { continue; }
        if (entry.type !== "compaction" || entry.method !== "handoff") continue;
        if (typeof entry.id !== "string" || typeof entry.timestamp !== "string") continue;
        const at = Date.parse(entry.timestamp);
        if (!Number.isFinite(at) || at < sinceMs) continue;
        if (!latest || at >= Date.parse(latest.timestamp)) latest = { entryId: entry.id, timestamp: entry.timestamp };
      }
      return latest;
    } catch {
      return null;
    } finally {
      await handle.close().catch(() => {});
    }
  }

  /**
   * Worker ids this session's director actually spawned, read from the journal.
   *
   * Why this lives beside `readHandoffCompaction` and copies its safety shape:
   *  - the session id is validated and the journal's own header must corroborate
   *    it, because a file name is not identity;
   *  - the file is opened `O_NOFOLLOW` and must be a regular file;
   *  - only a bounded **tail** is read, and a torn first line is dropped, so a
   *    partial JSON line can never be read as evidence;
   *  - every failure returns an empty list. "I could not read it" therefore
   *    degrades the UI to read-only, never to "everything is a worker".
   */
  async readVibeWorkers(sessionId: string): Promise<NativeVibeWorkers> {
    const empty: NativeVibeWorkers = { ids: [], timestamp: null };
    if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/u.test(sessionId)) return empty;
    const candidate = await this.findBySessionId(sessionId);
    if (!candidate) return empty;
    let header: NativeSessionHeader | null;
    try {
      header = await this.readHeader(candidate);
    } catch {
      return empty;
    }
    if (!header || header.sessionId !== sessionId) return empty;
    let handle;
    try {
      handle = await open(candidate, constants.O_RDONLY | constants.O_NOFOLLOW);
    } catch {
      return empty;
    }
    try {
      const metadata = await handle.stat();
      if (!metadata.isFile()) return empty;
      const windowBytes = 4 * 1024 * 1024;
      const start = Math.max(0, metadata.size - windowBytes);
      const window = Buffer.alloc(metadata.size - start);
      const read = await handle.read(window, 0, window.length, start);
      const text = window.toString("utf8", 0, read.bytesRead);
      const lines = text.split("\n");
      if (start > 0) lines.shift();

      /**
       * Replay in journal order, exactly as OMP does for its own in-memory
       * tombstone check (`vibe/runtime.ts:423-440`):
       *
       *   spawn             → the worker exists
       *   tombstone         → terminal, with the reason
       *   tombstone-revoked → clears a terminal reason **only when it was
       *                       `mode-exit`**; a kill is not revivable
       *
       * Only a worker whose replayed state is non-terminal is a worker the UI may
       * offer to kill. Without this, a worker killed an hour ago would still carry
       * a Kill button — the inverse of the false claim this whole path exists to
       * remove, and just as wrong.
       */
      const state = new Map<string, { terminal: boolean; reason: string | null }>();
      let newest: string | null = null;
      for (const line of lines) {
        if (!line.includes(VIBE_LIFECYCLE_TYPE)) continue;
        let entry: Record<string, unknown>;
        try {
          const parsed: unknown = JSON.parse(line);
          if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) continue;
          entry = parsed as Record<string, unknown>;
        } catch {
          continue;
        }
        if (entry.type !== "custom" || entry.customType !== VIBE_LIFECYCLE_TYPE) continue;
        const data = entry.data;
        if (!data || typeof data !== "object" || Array.isArray(data)) continue;
        const record = data as Record<string, unknown>;
        // A record without the owner/parent pair cannot be attributed to this
        // director, so it is not proof of ownership.
        if (typeof record.ownerId !== "string" || typeof record.parentSessionId !== "string") continue;
        if (typeof record.id !== "string" || record.id === "") continue;
        const action = record.action;
        if (action === "spawn") state.set(record.id, { terminal: false, reason: null });
        else if (action === "tombstone") {
          const previous = state.get(record.id);
          if (previous) previous.terminal = true;
          if (previous) previous.reason = typeof record.reason === "string" ? record.reason : "unknown";
        } else if (action === "tombstone-revoked") {
          const previous = state.get(record.id);
          // Only a mode-exit tombstone is revocable; an explicit kill is final.
          if (previous && previous.reason === "mode-exit") {
            previous.terminal = false;
            previous.reason = null;
          }
        }
        if (typeof entry.timestamp === "string" && (newest === null || entry.timestamp > newest)) newest = entry.timestamp;
      }
      const ids: string[] = [];
      for (const [id, value] of state) if (!value.terminal) ids.push(id);
      return { ids, timestamp: newest };
    } catch {
      return empty;
    } finally {
      await handle.close().catch(() => {});
    }
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
      let expectedReal: string | null = null;
      let actualReal: string | null = null;
      try { expectedReal = await realpath(expectedCwd); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
      try { actualReal = await realpath(header.cwd); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
      // A missing directory cannot be a symlink, so lexical equality is strongest evidence available only when either realpath is absent.
      const cwdMatches = expectedReal !== null && actualReal !== null ? expectedReal === actualReal : path.resolve(expectedCwd) === path.resolve(header.cwd);
      const cwdHash = createHash("sha256").update(actualReal ?? path.resolve(header.cwd)).digest("base64url");
      if (!cwdMatches || (cursor && cursor.cwdHash !== cwdHash)) throw Object.assign(new Error("Native session journal does not belong to this project"), { code: "path_forbidden" });
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
