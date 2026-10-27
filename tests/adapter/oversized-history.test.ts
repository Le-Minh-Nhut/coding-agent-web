import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, expect, it } from "vitest";
import { DefaultNativeSessionCatalog, encodeSessionDirName, SESSION_HISTORY_MAX_BYTES } from "../../packages/omp-adapter/src/session-catalog.js";

const dirs: string[] = [];
afterEach(async () => { await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true }))); });

it("signals oversized records skipped by each bounded history scan", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "caw-oversized-history-"));
  dirs.push(dir);
  const cwd = path.join(dir, "project");
  const sessionsRoot = path.join(dir, "sessions");
  await mkdir(cwd);
  const bucket = path.join(sessionsRoot, encodeSessionDirName(cwd));
  await mkdir(bucket, { recursive: true });
  const sessionId = "audit-history";
  const file = path.join(bucket, `2026-10-27_${sessionId}.jsonl`);
  const header = { type: "session", id: sessionId, cwd, timestamp: "2026-10-27T00:00:00Z", version: 3 };
  const entry = (id: string, text: string) => ({ type: "message", id, parentId: null, timestamp: "", message: { role: "user", content: text, timestamp: 0 } });
  const entries = [entry("before", "before"), entry("large", "L".repeat(SESSION_HISTORY_MAX_BYTES + 100)), entry("after", "after")];
  await writeFile(file, `${[header, ...entries].map((value) => JSON.stringify(value)).join("\n")}\n`);
  const catalog = new DefaultNativeSessionCatalog({ sessionsRoot, leaseProbe: { isLive: async () => false, liveSet: async () => new Map(), leaseName: (id) => id } });

  let cursor: string | undefined;
  const found: unknown[] = [];
  const skipped: boolean[] = [];
  let hasOlder = true;
  do {
    const page = await catalog.readHistory(sessionId, cwd, { before: cursor });
    found.push(...page.entries.map((value) => value.id));
    skipped.push(page.skippedOversized);
    cursor = page.nextCursor ?? undefined;
    hasOlder = page.hasOlder;
  } while (hasOlder && cursor && skipped.length < 10);
  expect(found).toEqual(["after", "before"]);
  expect(skipped).toContain(true);
  expect(skipped.at(-1)).toBe(false);
  expect(hasOlder).toBe(false);
});
