import { mkdtemp, readFile, rm } from "node:fs/promises";
import { constants } from "node:fs";
import type * as FsPromises from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { createMetadataStore } from "../../apps/server/src/store.js";

/**
 * The journal's append and rollback paths are only reachable through a real I/O
 * failure, so the faults are injected at the filesystem boundary. Every mode is
 * armed for exactly one `O_APPEND` open of `metadata.jsonl`; the store's own
 * `load()` open (no `O_APPEND`) is left alone so the fault lands on the write we
 * mean to test.
 */
const fault = vi.hoisted(() => ({
  armed: false,
  mode: "shortWrite" as "shortWrite" | "fullSyncFail" | "chmodFail" | "statFail",
  blockRollback: false,
}));
vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof FsPromises>();
  return { ...actual, open: async (...args: Parameters<typeof actual.open>) => {
    const handle = await actual.open(...args);
    const flags = typeof args[1] === "number" ? args[1] : 0;
    if (!String(args[0]).endsWith("metadata.jsonl") || !fault.armed || (flags & constants.O_APPEND) === 0) return handle;
    fault.armed = false;
    if (fault.mode === "chmodFail") {
      handle.chmod = async () => { throw Object.assign(new Error("simulated chmod failure"), { code: "EPERM" }); };
    }
    if (fault.mode === "statFail") {
      handle.stat = async () => { throw Object.assign(new Error("simulated stat failure"), { code: "EIO" }); };
    }
    const write = handle.writeFile.bind(handle);
    handle.writeFile = async (data, options) => {
      if (fault.mode === "fullSyncFail") { await write(data, options); return; }
      await write(String(data).slice(0, 25), options);
      throw Object.assign(new Error("simulated short write"), { code: "ENOSPC" });
    };
    if (fault.mode === "fullSyncFail") {
      handle.sync = async () => { throw Object.assign(new Error("simulated fsync failure"), { code: "EIO" }); };
    }
    if (fault.blockRollback) handle.truncate = async () => { throw Object.assign(new Error("simulated rollback failure"), { code: "EIO" }); };
    return handle;
  }};
});

const dirs: string[] = [];
afterEach(async () => { fault.armed = false; fault.blockRollback = false; fault.mode = "shortWrite"; await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true }))); });

it("rolls the journal back to the pre-append offset after a short write", async () => {
  const dir = await mkdtemp(join(tmpdir(), "caw-store-rollback-")); dirs.push(dir);
  const store = createMetadataStore(dir);
  const first = await store.createProject({ path: "/tmp/first" });
  const before = await readFile(join(dir, "metadata.jsonl"), "utf8");
  fault.armed = true;
  await expect(store.updateProject(first.id, { label: "torn" })).rejects.toMatchObject({ code: "ENOSPC" });
  expect(await readFile(join(dir, "metadata.jsonl"), "utf8")).toBe(before);
  // The next append must produce its own line, not a continuation of the fragment.
  const next = await store.createProject({ path: "/tmp/next" });
  const rows = (await readFile(join(dir, "metadata.jsonl"), "utf8")).trim().split("\n");
  expect(rows.map((row) => JSON.parse(row).op)).toEqual(["project", "project"]);
  expect((await createMetadataStore(dir).listProjects()).map((item) => item.id)).toEqual([first.id, next.id]);
});

it("rolls the journal back when the row was written but the sync failed", async () => {
  const dir = await mkdtemp(join(tmpdir(), "caw-store-sync-")); dirs.push(dir);
  const store = createMetadataStore(dir);
  const first = await store.createProject({ path: "/tmp/first" });
  const before = await readFile(join(dir, "metadata.jsonl"), "utf8");
  fault.armed = true;
  fault.mode = "fullSyncFail";
  await expect(store.createProject({ path: "/tmp/duplicate" })).rejects.toMatchObject({ code: "EIO" });
  // A rejected create must not leave the row behind: reporting failure and then
  // accepting a retry is how one path ends up recorded twice.
  expect(await readFile(join(dir, "metadata.jsonl"), "utf8")).toBe(before);
  const retried = await store.createProject({ path: "/tmp/duplicate" });
  const rows = (await readFile(join(dir, "metadata.jsonl"), "utf8")).trim().split("\n").map((row) => JSON.parse(row));
  expect(rows.map((row) => row.value.path)).toEqual(["/tmp/first", "/tmp/duplicate"]);
  expect((await createMetadataStore(dir).listProjects()).map((item) => item.id)).toEqual([first.id, retried.id]);
});

it("refuses every later write when the failed append could not be rolled back", async () => {
  const dir = await mkdtemp(join(tmpdir(), "caw-store-poison-")); dirs.push(dir);
  const store = createMetadataStore(dir);
  const first = await store.createProject({ path: "/tmp/first" });
  fault.armed = true;
  fault.blockRollback = true;
  await expect(store.updateProject(first.id, { label: "torn" })).rejects.toThrow(/could not be rolled back/i);
  // Success here would acknowledge a row the journal never received, and the next
  // real write would merge into the uncommitted fragment.
  await expect(store.createProject({ path: "/tmp/next" })).rejects.toThrow(/could not be rolled back/i);
  expect((await store.listProjects()).map((item) => item.id)).toEqual([first.id]);
});

it("does not touch the journal when the append fails after nothing was written", async () => {
  // The offset is only read once `stat` has succeeded. A failure before that (the
  // stat itself, or the chmod that follows it) must not roll back to a default of
  // zero: truncating there wipes the whole journal silently.
  for (const mode of ["statFail", "chmodFail"] as const) {
    const dir = await mkdtemp(join(tmpdir(), `caw-store-${mode}-`)); dirs.push(dir);
    const store = createMetadataStore(dir);
    const first = await store.createProject({ path: "/tmp/first" });
    const before = await readFile(join(dir, "metadata.jsonl"), "utf8");
    fault.armed = true;
    fault.mode = mode;
    await expect(store.createProject({ path: "/tmp/never" })).rejects.toThrow(/simulated/);
    expect((await readFile(join(dir, "metadata.jsonl"), "utf8")).length).toBe(before.length);
    expect((await readFile(join(dir, "metadata.jsonl"), "utf8"))).toBe(before);
    // The journal still holds the real record, and the store is not poisoned.
    expect((await store.listProjects()).map((item) => item.id)).toEqual([first.id]);
    await expect(store.createProject({ path: "/tmp/after" })).resolves.toBeTruthy();
  }
});

it("leaves every row in place when a project delete cannot be written", async () => {
  // The delete writes its conversation rows and the project row as one buffer. A
  // partial write that destroyed the conversations while the project survived
  // would be unrecoverable: the retry has nothing left to delete them with.
  const dir = await mkdtemp(join(tmpdir(), "caw-store-atomic-delete-")); dirs.push(dir);
  const store = createMetadataStore(dir);
  const project = await store.createProject({ path: "/tmp/project" });
  const conversation = await store.createConversation({ projectId: project.id });
  fault.armed = true;
  await expect(store.deleteProject(project.id, [conversation.id])).rejects.toMatchObject({ code: "ENOSPC" });
  expect((await store.listProjects()).map((item) => item.id)).toEqual([project.id]);
  expect((await store.listConversations(project.id)).map((item) => item.id)).toEqual([conversation.id]);
  // And the retry still works once the fault clears.
  expect(await store.deleteProject(project.id, [conversation.id])).toBe("deleted");
  expect(await store.listProjects()).toEqual([]);
  expect(await store.listConversations(project.id)).toEqual([]);
});
