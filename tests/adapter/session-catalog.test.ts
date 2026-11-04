import { chmod, mkdir, rm, stat, symlink, utimes, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  DefaultNativeSessionCatalog,
  encodeSessionDirName,
  SESSION_HISTORY_MAX_BYTES,
} from "../../packages/omp-adapter/src/session-catalog.js";

describe("session-catalog", () => {
  const testRoot = path.join(tmpdir(), `caw-cat-test-${Date.now()}`);

  beforeAll(async () => {
    await mkdir(testRoot, { recursive: true });
  });

  afterAll(async () => {
    await rm(testRoot, { recursive: true, force: true });
  });

  describe("bucket encoding", () => {
    it("encodes temp cwd with -tmp- prefix", () => {
      const tempCwd = path.join(tmpdir(), "caw-poc", "proj1");
      const bucket = encodeSessionDirName(tempCwd);
      expect(bucket).toBe("-tmp-caw-poc-proj1");
    });

    it("encodes home relative cwd with single leading -", () => {
      const homeCwd = path.join(homedir(), "data", "coding-agent-web");
      const bucket = encodeSessionDirName(homeCwd);
      expect(bucket).toBe("-data-coding-agent-web");

      const extCwd = path.join(homedir(), ".omp", "agent-extensions");
      expect(encodeSessionDirName(extCwd)).toBe("-.omp-agent-extensions");
    });

    it("encodes outside directory with legacy double-dash format", () => {
      const outsideCwd = "/var/log/my-project";
      const bucket = encodeSessionDirName(outsideCwd);
      expect(bucket).toBe("--var-log-my-project--");
    });
    it("throws when canonical path resolution fails with EACCES", () => {
      const permissionDenied = Object.assign(new Error("permission denied"), { code: "EACCES" });
      expect(() => encodeSessionDirName("/some/path", { realpath: (() => { throw permissionDenied; }) as never })).toThrow(permissionDenied);
    });
  });

  describe("header parsing and listing", () => {
    it("parses title slot and session header correctly", async () => {
      const projDir = path.join(testRoot, "my-proj");
      await mkdir(projDir, { recursive: true });

      const bucket = encodeSessionDirName(projDir);
      const bucketDir = path.join(testRoot, "sessions", bucket);
      await mkdir(bucketDir, { recursive: true });

      const sessionId = "01a16ed6-2ebb-7609-a2a2-e76d0d8dd06e";
      const timestamp = "2026-10-24T16:54:52.859Z";
      const filename = `${timestamp.replace(/[:.]/g, "-")}_${sessionId}.jsonl`;
      const sessionFile = path.join(bucketDir, filename);

      // Create physical line 0: 256-byte title slot
      const titleSlotObj = {
        type: "title",
        v: 1,
        title: "Test Session Title",
        updatedAt: timestamp,
        pad: " ".repeat(170),
      };
      const titleSlotLine = `${JSON.stringify(titleSlotObj)}\n`;
      expect(Buffer.byteLength(titleSlotLine, "utf8")).toBeGreaterThanOrEqual(200);

      // Line 1: session header
      const sessionHeaderObj = {
        type: "session",
        version: 3,
        id: sessionId,
        timestamp,
        cwd: projDir,
      };
      const sessionHeaderLine = `${JSON.stringify(sessionHeaderObj)}\n`;

      // Line 2: extra user message
      const messageLine = JSON.stringify({ type: "message", role: "user", content: "hello" }) + "\n";

      await writeFile(sessionFile, titleSlotLine + sessionHeaderLine + messageLine, "utf8");

      const catalog = new DefaultNativeSessionCatalog({
        sessionsRoot: path.join(testRoot, "sessions"),
        leaseProbe: {
          isLive: async () => "unknown",
          liveSet: async () => new Map(),
          leaseName: (id) => id,
        },
      });

      const header = await catalog.readHeader(sessionFile);
      expect(header).not.toBeNull();
      expect(header?.sessionId).toBe(sessionId);
      expect(header?.cwd).toBe(projDir);
      expect(header?.title).toBe("Test Session Title");
      expect(header?.version).toBe(3);

      const list = await catalog.listForCwd(projDir);
      expect(list[0]?.live).toBe("unknown");
      expect(list.length).toBe(1);
      expect(list[0]?.sessionId).toBe(sessionId);
      expect(list[0]?.title).toBe("Test Session Title");
      expect(list[0]?.path).toBe(sessionFile);

      const all = await catalog.listAll();
      expect(all.length).toBe(1);
      expect(all[0]?.sessionId).toBe(sessionId);

      const found = await catalog.findBySessionId(sessionId);
      expect(found).toBe(sessionFile);
    });
  });
  it("keeps lossy bucket collisions scoped by canonical journal cwd", async () => {
    const parent = path.join(testRoot, "cwd-collision");
    const cwdA = path.join(parent, "a-b");
    const cwdB = path.join(parent, "a", "b");
    const sessionsRoot = path.join(testRoot, "cwd-collision-sessions");
    const bucketDir = path.join(sessionsRoot, encodeSessionDirName(cwdA));
    await mkdir(bucketDir, { recursive: true });
    await mkdir(cwdA, { recursive: true });
    await mkdir(cwdB, { recursive: true });
    await writeFile(path.join(bucketDir, "a.jsonl"), `${JSON.stringify({ type: "session", id: "cwd-a", cwd: cwdA })}\n`);
    await writeFile(path.join(bucketDir, "b.jsonl"), `${JSON.stringify({ type: "session", id: "cwd-b", cwd: cwdB })}\n`);
    const catalog = new DefaultNativeSessionCatalog({ sessionsRoot, leaseProbe: { isLive: async () => false, liveSet: async () => new Map(), leaseName: (id) => id } });
    expect((await catalog.listForCwd(cwdA)).map((row) => row.sessionId)).toEqual(["cwd-a"]);
  });
  it("lists root and bucket journals once, ignores deeper transcripts, and orders by journal mtime", async () => {
    const sessionsRoot = path.join(testRoot, "depth-semantics-sessions");
    const cwd = path.join(testRoot, "depth-semantics-cwd");
    const bucket = path.join(sessionsRoot, encodeSessionDirName(cwd));
    const transcripts = path.join(bucket, "subagents");
    await mkdir(transcripts, { recursive: true });
    const journal = (id: string) => `${JSON.stringify({ type: "title", v: 1, title: null, updatedAt: "2020-01-01T00:00:00.000Z" })}\n${JSON.stringify({ type: "session", id, cwd, timestamp: "2020-01-01T00:00:00.000Z" })}\n${JSON.stringify({ type: "message", role: "user", content: "first prompt\nsecond line" })}\n`;
    const older = path.join(bucket, "2020-01-01_older.jsonl");
    const loose = path.join(sessionsRoot, "2020-01-02_loose.jsonl");
    await writeFile(older, journal("older"));
    await writeFile(loose, journal("loose"));
    await writeFile(path.join(transcripts, "2020-01-02_transcript.jsonl"), journal("transcript"));
    await utimes(older, new Date("2020-01-01"), new Date("2020-01-01"));
    await utimes(loose, new Date("2021-01-01"), new Date("2021-01-01"));
    const catalog = new DefaultNativeSessionCatalog({ sessionsRoot, leaseProbe: { isLive: async () => false, liveSet: async () => new Map(), leaseName: (id) => id } });
    const listed = await catalog.listAllDetailed();
    expect(listed.sessions.map((row) => row.sessionId)).toEqual(["loose", "older"]);
    expect(listed.sessions[0]?.title).toBe("first prompt second line");
    expect(await catalog.findBySessionId("older")).toBe(older);
    expect(await catalog.findBySessionId("loose")).toBe(loose);
    expect(await catalog.findBySessionId("transcript")).toBeNull();
    expect((await catalog.listAll()).map((row) => row.sessionId).sort()).toEqual(["loose", "older"]);
    expect((await catalog.listForCwd(cwd)).map((row) => row.sessionId).sort()).toEqual(["loose", "older"]);
  });
  it("globally scans bounded journals, counts bad files, and preserves deleted-cwd history checks", async () => {
    const sessionsRoot = path.join(testRoot, "global-detailed-sessions");
    const cwd = path.join(testRoot, "global-deleted-cwd");
    const bucket = path.join(sessionsRoot, "bucket");
    await mkdir(bucket, { recursive: true });
    const journal = path.join(bucket, "2026-01-04_session-global.jsonl");
    await writeFile(journal, `${JSON.stringify({ type: "session", id: "session-global", cwd, timestamp: "2026-01-01T00:00:00.000Z" })}\n${JSON.stringify({ type: "message", text: "saved" })}\n`);
    await writeFile(path.join(bucket, "2026-01-03_bad.jsonl"), "{invalid header\n");
    await writeFile(path.join(bucket, "2026-01-02_plain.jsonl"), "not a journal\n");
    const catalog = new DefaultNativeSessionCatalog({ sessionsRoot, maxGlobalFiles: 2, disableGlobalCache: true, leaseProbe: { isLive: async () => false, liveSet: async () => new Map(), leaseName: (id) => id } });
    const result = await catalog.listAllDetailed();
    expect(result.truncated).toBe(true);
    expect(result.filesScanned).toBe(2);
    expect(result.filesSkippedNonJournal).toBe(1);
    expect(result.sessions.map((session) => session.sessionId)).toEqual(["session-global"]);
    await expect(catalog.readHistory("session-global", cwd)).resolves.toMatchObject({ entries: [{ type: "message", text: "saved" }] });
    await expect(catalog.readHistory("session-global", path.join(testRoot, "other-missing-cwd"))).rejects.toMatchObject({ code: "path_forbidden" });
  });

  describe("failed discovery is not an empty result", () => {
    it("reports an absent bucket as no sessions, but an unreadable one as a failure", async () => {
      const catalog = new DefaultNativeSessionCatalog({ sessionsRoot: path.join(testRoot, "sessions") });

      // Never written to: an empty list is the honest, confirmed answer.
      await expect(catalog.listForCwd(path.join(testRoot, "nothing-here"))).resolves.toEqual([]);

      // Present but unreadable: "I could not look" must not become "no sessions",
      // because a caller uses this to decide whether a launch would fork history.
      const locked = path.join(testRoot, "locked");
      await mkdir(locked, { recursive: true });
      const bucket = encodeSessionDirName(locked);
      const bucketDir = path.join(testRoot, "sessions", bucket);
      await mkdir(bucketDir, { recursive: true });
      await chmod(bucketDir, 0o000);
      try {
        await expect(catalog.listForCwd(locked)).rejects.toThrow();
      } finally {
        await chmod(bucketDir, 0o755);
      }
    });

    it("reports an absent store as no sessions, but an unreadable store as a failure", async () => {
      const catalog = new DefaultNativeSessionCatalog({ sessionsRoot: path.join(testRoot, "no-store") });
      await expect(catalog.listAll()).resolves.toEqual([]);

      const lockedRoot = path.join(testRoot, "locked-root");
      await mkdir(lockedRoot, { recursive: true });
      await chmod(lockedRoot, 0o000);
      const lockedCatalog = new DefaultNativeSessionCatalog({ sessionsRoot: lockedRoot });
      try {
        await expect(lockedCatalog.listAll()).rejects.toThrow();
        await expect(lockedCatalog.findBySessionId("abc")).rejects.toThrow();
      } finally {
        await chmod(lockedRoot, 0o755);
      }
    });
    it("rejects a stat permission failure instead of returning null freshness metadata", async () => {
      const project = path.join(testRoot, "stat-failure-project");
      const sessionsRoot = path.join(testRoot, "stat-failure-sessions");
      const bucketDir = path.join(sessionsRoot, encodeSessionDirName(project));
      await mkdir(bucketDir, { recursive: true });
      await writeFile(path.join(bucketDir, "2026-01-01_session.jsonl"), `${JSON.stringify({ type: "session", id: "session-stat", cwd: project })}\n`);
      const permissionDenied = Object.assign(new Error("permission denied"), { code: "EACCES" });
      const catalog = new DefaultNativeSessionCatalog({ sessionsRoot, stat: (async () => { throw permissionDenied; }) as never });
      await expect(catalog.listForCwd(project)).rejects.toMatchObject({ code: "EACCES" });
    });
  });
  describe("adversarial review regressions", () => {
    const lease = { isLive: async () => false as const, liveSet: async () => new Map<string, boolean | "unknown">(), leaseName: (id: string) => id };
    const journalFor = (id: string, cwd: string) => `${JSON.stringify({ type: "session", id, cwd, timestamp: "2026-01-01T00:00:00.000Z" })}\n`;

    it("does not treat a directory named *.jsonl as a journal (F3)", async () => {
      const sessionsRoot = path.join(testRoot, "f3-sessions");
      const cwd = path.join(testRoot, "f3-cwd");
      await mkdir(cwd, { recursive: true });
      // `encodeSessionDirName` can legally end a bucket name in `.jsonl`; a bucket
      // named that way used to be opened as a file and threw EISDIR out of listing.
      const decoy = path.join(sessionsRoot, `${encodeSessionDirName(cwd)}.jsonl`);
      await mkdir(decoy, { recursive: true });
      await writeFile(path.join(decoy, "2026-01-01_inner.jsonl"), journalFor("inner", cwd));
      await writeFile(path.join(sessionsRoot, "2026-01-02_loose.jsonl"), journalFor("loose", cwd));
      const catalog = new DefaultNativeSessionCatalog({ sessionsRoot, leaseProbe: lease, disableGlobalCache: true });
      await expect(catalog.listForCwd(cwd)).resolves.toMatchObject([{ sessionId: "loose" }]);
      await expect(catalog.listAll()).resolves.toMatchObject([{ sessionId: "loose" }]);
      expect((await catalog.listAllDetailed()).sessions.map((row) => row.sessionId)).toEqual(["loose"]);
    });

    it("counts an unreadable journal so the page cannot look complete (F4)", async () => {
      const sessionsRoot = path.join(testRoot, "f4-sessions");
      const cwd = path.join(testRoot, "f4-cwd");
      const bucket = path.join(sessionsRoot, "bucket");
      await mkdir(bucket, { recursive: true });
      await writeFile(path.join(bucket, "2026-01-01_ok.jsonl"), journalFor("ok", cwd));
      const secret = path.join(bucket, "2026-01-02_secret.jsonl");
      await writeFile(secret, journalFor("secret", cwd));
      await chmod(secret, 0o000);
      try {
        const scan = await new DefaultNativeSessionCatalog({ sessionsRoot, leaseProbe: lease, disableGlobalCache: true }).listAllDetailed();
        expect(scan.sessions.map((row) => row.sessionId)).toEqual(["ok"]);
        // The row is gone, but the page says so instead of claiming a complete store.
        expect(scan.filesUnreadable).toBe(1);
        expect(scan.truncated).toBe(false);
      } finally {
        await chmod(secret, 0o644);
      }
    });

    it("orders listForCwd newest first, matching the global listing (F5)", async () => {
      const sessionsRoot = path.join(testRoot, "f5-sessions");
      const cwd = path.join(testRoot, "f5-cwd");
      await mkdir(cwd, { recursive: true });
      const bucket = path.join(sessionsRoot, encodeSessionDirName(cwd));
      await mkdir(bucket, { recursive: true });
      const older = path.join(bucket, "2026-01-01_older.jsonl");
      const newer = path.join(bucket, "2026-01-02_newer.jsonl");
      await writeFile(older, journalFor("older", cwd));
      await writeFile(newer, journalFor("newer", cwd));
      await utimes(older, new Date("2020-01-01"), new Date("2020-01-01"));
      await utimes(newer, new Date("2021-01-01"), new Date("2021-01-01"));
      const catalog = new DefaultNativeSessionCatalog({ sessionsRoot, leaseProbe: lease, disableGlobalCache: true });
      expect((await catalog.listForCwd(cwd)).map((row) => row.sessionId)).toEqual(["newer", "older"]);
      expect((await catalog.listAll()).map((row) => row.sessionId)).toEqual(["newer", "older"]);
    });

    it("does not re-read a bucket that vanished after enumeration (F6)", async () => {
      const sessionsRoot = path.join(testRoot, "f6-sessions");
      const cwd = path.join(testRoot, "f6-cwd");
      await mkdir(cwd, { recursive: true });
      // Two buckets, so whichever is enumerated first can be deleted by the stat
      // of the other — deterministically, whatever order readdir returns.
      const bucketA = path.join(sessionsRoot, "bucket-a");
      const bucketB = path.join(sessionsRoot, "bucket-b");
      await mkdir(bucketA, { recursive: true });
      await mkdir(bucketB, { recursive: true });
      await writeFile(path.join(bucketA, "2026-01-01_a.jsonl"), journalFor("a", cwd));
      await writeFile(path.join(bucketB, "2026-01-02_b.jsonl"), journalFor("b", cwd));
      const seen: string[] = [];
      const catalog = new DefaultNativeSessionCatalog({
        sessionsRoot,
        leaseProbe: lease,
        stat: (async (target: Parameters<typeof stat>[0], ...rest: never[]) => {
          const info = await stat(target, ...rest);
          const name = String(target);
          if (name === bucketA || name === bucketB) {
            // Every bucket enumerated strictly before this one has already had its
            // journals collected; remove them, so a signature that re-reads the
            // directory instead of reusing what it collected throws ENOENT.
            for (const earlier of seen.splice(0)) await rm(earlier, { recursive: true, force: true });
            seen.push(name);
          }
          return info;
        }) as typeof stat,
      });
      // The page must survive: every bucket was already enumerated, so one that
      // vanished afterwards must not turn a successful enumeration into a 500.
      const scan = await catalog.listAllDetailed();
      expect(Array.isArray(scan.sessions)).toBe(true);
    });

  });
  describe("bounded native history", () => {
    const makeCatalog = (sessionsRoot: string) => new DefaultNativeSessionCatalog({
      sessionsRoot,
      leaseProbe: { isLive: async () => false, liveSet: async () => new Map(), leaseName: (id) => id },
    });
    async function createJournal(cwd: string, sessionId: string, body: string, sessionsRoot: string): Promise<string> {
      const bucketDir = path.join(sessionsRoot, encodeSessionDirName(cwd));
      await mkdir(bucketDir, { recursive: true });
      const file = path.join(bucketDir, `2026-10-26_${sessionId}.jsonl`);
      await writeFile(file, `${JSON.stringify({ type: "session", id: sessionId, cwd, timestamp: "2026-10-26T00:00:00.000Z", version: 3 })}\n${body}`, "utf8");
      return file;
    }

    it("reads the requested journal by session identity and returns newest bounded entries", async () => {
      const cwd = path.join(testRoot, "history-project");
      const sessionsRoot = path.join(testRoot, "history-sessions");
      await mkdir(sessionsRoot, { recursive: true });
      await mkdir(cwd, { recursive: true });
      await createJournal(cwd, "history-session", Array.from({ length: 5 }, (_, i) => `${JSON.stringify({ type: "message", i })}\n`).join(""), sessionsRoot);
      const history = await makeCatalog(sessionsRoot).readHistory("history-session", cwd, 2);
      expect(history.header.sessionId).toBe("history-session");
      expect(history.entries).toEqual([{ type: "message", i: 3 }, { type: "message", i: 4 }]);
      expect(history.truncated).toBe(true);
      expect(history.truncatedByEntries).toBe(true);
      expect(history.truncatedByBytes).toBe(false);
      expect(history.hasOlder).toBe(true);
      expect(history.nextCursor).toBeTruthy();
      const otherCwd = path.join(testRoot, "history-foreign-project");
      await mkdir(otherCwd, { recursive: true });
      await expect(makeCatalog(sessionsRoot).readHistory("history-session", otherCwd)).rejects.toMatchObject({ code: "path_forbidden" });
    });

    it("reports missing journals and refuses a symlink escaping session roots", async () => {
      const sessionsRoot = path.join(testRoot, "history-security-sessions");
      const outsideRoot = path.join(testRoot, "history-outside");
      const cwd = path.join(testRoot, "history-security-project");
      await mkdir(sessionsRoot, { recursive: true });
      await mkdir(outsideRoot, { recursive: true });
      await mkdir(cwd, { recursive: true });
      const catalog = makeCatalog(sessionsRoot);
      await expect(catalog.readHistory("missing-history", cwd)).rejects.toMatchObject({ code: "not_found" });
      const outsideFile = await createJournal(cwd, "outside-session", `${JSON.stringify({ type: "message", text: "outside" })}\n`, outsideRoot);
      const bucketDir = path.join(sessionsRoot, encodeSessionDirName(cwd));
      await mkdir(bucketDir, { recursive: true });
      await symlink(outsideFile, path.join(bucketDir, `2026-10-26_outside-session.jsonl`));
      await expect(catalog.readHistory("outside-session", cwd)).rejects.toMatchObject({ code: "path_forbidden" });
    });

    it("caps the history entry count and marks omitted entries", async () => {
      const cwd = path.join(testRoot, "history-entry-cap-project");
      const sessionsRoot = path.join(testRoot, "history-entry-cap-sessions");
      await mkdir(cwd, { recursive: true });
      await mkdir(sessionsRoot, { recursive: true });
      await createJournal(cwd, "entry-cap-history", Array.from({ length: 501 }, (_, i) => `${JSON.stringify({ type: "message", i })}\n`).join(""), sessionsRoot);
      const history = await makeCatalog(sessionsRoot).readHistory("entry-cap-history", cwd, 900);
      expect(history.entries).toHaveLength(500);
      expect(history.entries.at(-1)).toEqual({ type: "message", i: 500 });
      expect(history.truncated).toBe(true);
      expect(history.truncatedByEntries).toBe(true);
      expect(history.truncatedByBytes).toBe(false);
    });
    it("bounds bytes read and reports byte truncation honestly", async () => {
      const cwd = path.join(testRoot, "history-large-project");
      const sessionsRoot = path.join(testRoot, "history-large-sessions");
      await mkdir(cwd, { recursive: true });
      const body = Array.from({ length: 140 }, (_, i) => `${JSON.stringify({ type: "message", i, text: "x".repeat(20_000) })}\n`).join("");
      await createJournal(cwd, "large-history", body, sessionsRoot);
      await mkdir(sessionsRoot, { recursive: true });
      const history = await makeCatalog(sessionsRoot).readHistory("large-history", cwd);
      expect(history.truncated).toBe(true);
      expect(history.truncatedByBytes).toBe(true);
      expect(history.truncatedByEntries).toBe(false);
      expect(history.entries.reduce((bytes, entry) => bytes + Buffer.byteLength(`${JSON.stringify(entry)}\n`), 0)).toBeLessThanOrEqual(SESSION_HISTORY_MAX_BYTES);
      const indices = [...history.entries.map((entry) => entry.i as number)];
      let before = history.nextCursor ?? undefined;
      while (before) {
        const older = await makeCatalog(sessionsRoot).readHistory("large-history", cwd, { before });
        indices.unshift(...older.entries.map((entry) => entry.i as number));
        before = older.nextCursor ?? undefined;
      }
      expect(indices).toEqual(Array.from({ length: 140 }, (_, i) => i));
    });
    it("refuses history when session liveness is active or unknown", async () => {
      const cwd = path.join(testRoot, "history-live-project");
      const sessionsRoot = path.join(testRoot, "history-live-sessions");
      await mkdir(cwd, { recursive: true });
      await mkdir(sessionsRoot, { recursive: true });
      await createJournal(cwd, "live-history", `${JSON.stringify({ type: "message" })}\n`, sessionsRoot);
      for (const live of [true, "unknown"] as const) {
        const catalog = new DefaultNativeSessionCatalog({ sessionsRoot, leaseProbe: { isLive: async () => live, liveSet: async () => new Map(), leaseName: (id) => id } });
        await expect(catalog.readHistory("live-history", cwd)).rejects.toMatchObject({ code: "conflict_owner" });
      }
    });

    it("walks a long journal backward without gaps or duplicates", async () => {
      const cwd = path.join(testRoot, "history-paging-project");
      const sessionsRoot = path.join(testRoot, "history-paging-sessions");
      await mkdir(cwd, { recursive: true });
      await mkdir(sessionsRoot, { recursive: true });
      const total = 3_200;
      await createJournal(cwd, "paging-session", Array.from({ length: total }, (_, i) => `${JSON.stringify({ i, marker: i === 0 || i === 1600 || i === total - 1 })}\n`).join(""), sessionsRoot);
      const catalog = makeCatalog(sessionsRoot);
      const pages: number[] = [];
      let before: string | undefined;
      do {
        const page = await catalog.readHistory("paging-session", cwd, { before });
        pages.unshift(...page.entries.map((entry) => entry.i as number));
        before = page.nextCursor ?? undefined;
        expect(page.hasOlder).toBe(Boolean(before));
      } while (before);
      expect(pages).toEqual(Array.from({ length: total }, (_, i) => i));
      expect(pages.filter((i) => i === 0 || i === 1600 || i === total - 1)).toEqual([0, 1600, total - 1]);
    });

    it("ignores an incomplete trailing JSONL record and rejects forged or cross-session cursors", async () => {
      const cwd = path.join(testRoot, "history-cursor-project");
      const sessionsRoot = path.join(testRoot, "history-cursor-sessions");
      await mkdir(cwd, { recursive: true });
      await mkdir(sessionsRoot, { recursive: true });
      await createJournal(cwd, "cursor-session", `${JSON.stringify({ i: 0 })}\n${JSON.stringify({ i: 1 })}\n{\"partial\":`, sessionsRoot);
      await createJournal(cwd, "other-cursor-session", `${JSON.stringify({ i: 0 })}\n`, sessionsRoot);
      const catalog = makeCatalog(sessionsRoot);
      const history = await catalog.readHistory("cursor-session", cwd);
      expect(history.entries).toEqual([{ i: 0 }, { i: 1 }]);
      await expect(catalog.readHistory("cursor-session", cwd, { before: "forged.cursor" })).rejects.toMatchObject({ code: "path_forbidden" });

      const pagingCwd = path.join(testRoot, "history-cross-cursor-project");
      const pagingRoot = path.join(testRoot, "history-cross-cursor-sessions");
      await mkdir(pagingCwd, { recursive: true });
      await mkdir(pagingRoot, { recursive: true });
      await createJournal(pagingCwd, "cursor-source", Array.from({ length: 501 }, (_, i) => `${JSON.stringify({ i })}\n`).join(""), pagingRoot);
      await createJournal(pagingCwd, "cursor-target", `${JSON.stringify({ i: 0 })}\n`, pagingRoot);
      const source = await makeCatalog(pagingRoot).readHistory("cursor-source", pagingCwd);
      expect(source.nextCursor).toBeTruthy();
      const otherCwd = path.join(testRoot, "some-other-project");
      await mkdir(otherCwd, { recursive: true });
      await expect(makeCatalog(pagingRoot).readHistory("cursor-source", otherCwd, { before: source.nextCursor! })).rejects.toMatchObject({ code: "path_forbidden" });
    });
  });
});
