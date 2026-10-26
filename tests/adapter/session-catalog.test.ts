import { chmod, mkdir, rm, symlink, writeFile } from "node:fs/promises";
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
    });
    it("bounds bytes read and reports byte truncation honestly", async () => {
      const cwd = path.join(testRoot, "history-large-project");
      const sessionsRoot = path.join(testRoot, "history-large-sessions");
      await mkdir(cwd, { recursive: true });
      const body = `${JSON.stringify({ type: "message", text: "x".repeat(SESSION_HISTORY_MAX_BYTES + 100) })}\n`;
      await createJournal(cwd, "large-history", body, sessionsRoot);
      await mkdir(sessionsRoot, { recursive: true });
      const history = await makeCatalog(sessionsRoot).readHistory("large-history", cwd);
      expect(history.truncated).toBe(true);
      expect(history.entries).toEqual([]);
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
  });
});
