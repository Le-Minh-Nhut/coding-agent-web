import { chmod, mkdir, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  DefaultNativeSessionCatalog,
  encodeSessionDirName,
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
});
