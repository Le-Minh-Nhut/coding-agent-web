/**
 * `readVibeWorkers` — the evidence behind the Kill gate (round 53, B01).
 *
 * This is a security boundary, so it is tested against a real journal file on a
 * real temp dir, not a mock: the reader's whole job is to interpret what OMP
 * actually wrote, and a stubbed reader would only prove the stub.
 *
 * The dangerous failure in both directions:
 *  - a **live** worker missing from the list ⇒ the user cannot cancel work;
 *  - a **dead** worker present in the list ⇒ the UI offers a Kill that the agent
 *    no longer has, which is the inverse false claim this path exists to remove.
 */
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { DefaultNativeSessionCatalog, encodeSessionDirName } from "../../packages/omp-adapter/src/index.js";

const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

const SESSION_ID = "01a1aa0b-fec4-7629-8043-6993c82d793f";
const CWD = "/tmp/caw-r53-workers";

/** A journal with a faithful header plus the supplied lifecycle records. */
async function journalWith(records: readonly unknown[]): Promise<{ catalog: DefaultNativeSessionCatalog; sessionsRoot: string }> {
  const root = await mkdtemp(join(tmpdir(), "caw-r53-vibe-"));
  dirs.push(root);
  const bucket = join(root, encodeSessionDirName(CWD));
  await mkdir(bucket, { recursive: true });
  const lines = [
    JSON.stringify({ type: "session", version: 3, id: SESSION_ID, cwd: CWD, timestamp: new Date().toISOString() }),
    ...records.map((record) => JSON.stringify(record)),
  ];
  await writeFile(join(bucket, `2026-01-01T00-00-00-000Z_${SESSION_ID}.jsonl`), `${lines.join("\n")}\n`, "utf8");
  return { catalog: new DefaultNativeSessionCatalog({ sessionsRoot: root }), sessionsRoot: root };
}

function lifecycle(id: string, action: string, extra: Record<string, unknown> = {}) {
  return {
    type: "custom",
    customType: "vibe-session-lifecycle",
    timestamp: new Date().toISOString(),
    data: { version: 1, id, ownerId: "main-agent", parentSessionId: SESSION_ID, action, ...extra },
  };
}

describe("readVibeWorkers", () => {
  it("reports a spawned worker as killable", async () => {
    const { catalog } = await journalWith([lifecycle("w1", "spawn", { cli: "fast", agent: "sonic" })]);
    expect((await catalog.readVibeWorkers(SESSION_ID)).ids).toEqual(["w1"]);
  });

  it("does NOT report a worker tombstoned by an explicit kill", async () => {
    // The regression this guards: a killed worker must never keep a Kill control.
    const { catalog } = await journalWith([
      lifecycle("w1", "spawn"),
      lifecycle("w1", "tombstone", { reason: "explicit-kill" }),
    ]);
    expect((await catalog.readVibeWorkers(SESSION_ID)).ids).toEqual([]);
  });

  it("does NOT report a worker left tombstoned by a spawn failure", async () => {
    const { catalog } = await journalWith([
      lifecycle("w1", "spawn"),
      lifecycle("w1", "tombstone", { reason: "spawn-failed" }),
    ]);
    expect((await catalog.readVibeWorkers(SESSION_ID)).ids).toEqual([]);
  });

  it("revives a mode-exit tombstone, because that reason is revocable", async () => {
    // Mirrors upstream `vibe/runtime.ts:434-435`: a mode-exit can be revoked, so a
    // rehydrated worker is alive again.
    const { catalog } = await journalWith([
      lifecycle("w1", "spawn"),
      lifecycle("w1", "tombstone", { reason: "mode-exit" }),
      lifecycle("w1", "tombstone-revoked", { reason: "mode-exit" }),
    ]);
    expect((await catalog.readVibeWorkers(SESSION_ID)).ids).toEqual(["w1"]);
  });

  it("does NOT revive an explicitly killed worker when a revoke arrives", async () => {
    // A kill is final: upstream only clears a `mode-exit` reason.
    const { catalog } = await journalWith([
      lifecycle("w1", "spawn"),
      lifecycle("w1", "tombstone", { reason: "explicit-kill" }),
      lifecycle("w1", "tombstone-revoked", { reason: "mode-exit" }),
    ]);
    expect((await catalog.readVibeWorkers(SESSION_ID)).ids).toEqual([]);
  });

  it("ignores turn events, which carry no liveness meaning", async () => {
    const { catalog } = await journalWith([
      lifecycle("w1", "spawn"),
      lifecycle("w1", "turn-started", { turn: 1 }),
      lifecycle("w1", "turn-settled", { turn: 1 }),
    ]);
    expect((await catalog.readVibeWorkers(SESSION_ID)).ids).toEqual(["w1"]);
  });

  it("keeps two workers independent", async () => {
    const { catalog } = await journalWith([
      lifecycle("w1", "spawn"),
      lifecycle("w2", "spawn"),
      lifecycle("w1", "tombstone", { reason: "explicit-kill" }),
    ]);
    expect((await catalog.readVibeWorkers(SESSION_ID)).ids).toEqual(["w2"]);
  });

  it("ignores records with no owner/parent, which cannot be attributed", async () => {
    const { catalog } = await journalWith([
      { type: "custom", customType: "vibe-session-lifecycle", timestamp: new Date().toISOString(), data: { id: "orphan", action: "spawn" } },
    ]);
    expect((await catalog.readVibeWorkers(SESSION_ID)).ids).toEqual([]);
  });

  it("returns an empty list for an unknown session rather than throwing", async () => {
    const { catalog } = await journalWith([lifecycle("w1", "spawn")]);
    expect(await catalog.readVibeWorkers("does-not-exist")).toEqual({ ids: [], timestamp: null });
  });

  it("returns an empty list for an invalid session id", async () => {
    const { catalog } = await journalWith([]);
    expect(await catalog.readVibeWorkers("../../etc/passwd")).toEqual({ ids: [], timestamp: null });
  });

  it("fails closed on a journal whose header names a different session", async () => {
    // A copied/renamed journal is not identity: the header must corroborate.
    const root = await mkdtemp(join(tmpdir(), "caw-r53-mismatch-"));
    dirs.push(root);
    const bucket = join(root, encodeSessionDirName(CWD));
    await mkdir(bucket, { recursive: true });
    await writeFile(
      join(bucket, `2026-01-01T00-00-00-000Z_${SESSION_ID}.jsonl`),
      `${JSON.stringify({ type: "session", version: 3, id: "someone-else", cwd: CWD, timestamp: new Date().toISOString() })}\n${JSON.stringify(lifecycle("w1", "spawn"))}\n`,
      "utf8",
    );
    const catalog = new DefaultNativeSessionCatalog({ sessionsRoot: root });
    expect(await catalog.readVibeWorkers(SESSION_ID)).toEqual({ ids: [], timestamp: null });
  });
});
