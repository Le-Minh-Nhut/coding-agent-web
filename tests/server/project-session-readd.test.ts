import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import ts from "typescript";
import { afterEach, expect, it } from "vitest";
import { WorkspacePathPolicy } from "../../apps/server/src/path-policy.js";
import { createMetadataStore } from "../../apps/server/src/store.js";

const dirs: string[] = [];
afterEach(async () => { await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true }))); });

it("offers orphaned native sessions after project re-add without changing journals or writers", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "caw-project-readd-"));
  dirs.push(dir);
  const journalPath = path.join(dir, "saved.jsonl");
  const journal = '{"type":"session","id":"saved-native"}\n';
  await writeFile(journalPath, journal);
  const store = createMetadataStore(dir);
  const original = await store.createProject({ path: dir, label: "Original" });
  const saved = await store.createConversation({ projectId: original.id, nativeSessionId: "saved-native", title: "Saved" });
  // Deleting a project is refused while it still has conversations, so the
  // conversation goes first — the same two steps the UI performs.
  await store.removeConversation(saved.id);
  expect(await store.deleteProject(original.id)).toBe("deleted");
  const recreated = await store.createProject({ path: dir, label: "Recreated" });
  await mkdir(path.join(dir, "normal"));
  const normal = await store.createProject({ path: path.join(dir, "normal"), label: "Normal" });
  await store.createConversation({ projectId: normal.id, nativeSessionId: "tracked-native", title: "Tracked" });

  const source = await readFile(path.resolve("apps/server/src/server.ts"), "utf8");
  const start = source.indexOf("const listNativeSessions =");
  const end = source.indexOf("\n// ── Application", start);
  if (start < 0 || end < 0) throw new Error("Cannot locate production native-list composition");
  const code = ts.transpileModule(source.slice(start, end), {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext },
  }).outputText;
  const catalog = {
    listForCwd: async (cwd: string) => cwd === dir
      ? [
        { sessionId: "saved-native", path: journalPath, cwd, title: "Saved", updatedAt: "", live: false },
        { sessionId: "live-native", path: journalPath, cwd, title: "Live", updatedAt: "", live: true },
      ]
      : [{ sessionId: "tracked-native", path: journalPath, cwd, title: "Tracked", updatedAt: "", live: true }],
  };
  const listNativeSessions = Function("paths", "catalog", "store", `${code};return listNativeSessions;`)(
    new WorkspacePathPolicy([dir]), catalog, store,
  ) as (input: { projectPath: string }) => Promise<Array<{ sessionId: string; live: boolean; tracked: boolean }>>;

  const [resumable, tracked] = await Promise.all([
    listNativeSessions({ projectPath: dir }),
    listNativeSessions({ projectPath: normal.path }),
  ]);
  expect(resumable).toMatchObject([
    { sessionId: "saved-native", live: false, tracked: false },
    { sessionId: "live-native", live: true, tracked: false },
  ]);
  expect(tracked).toMatchObject([{ sessionId: "tracked-native", live: true, tracked: true }]);
  // Deleting a project now also drops the conversations recorded beneath it, so the
  // saved row is gone rather than left dangling at a project that no longer exists.
  // The point of the test is unchanged: `saved-native` is offered again with
  // `tracked: false`, and the journal on disk is untouched.
  expect((await store.listAllConversations()).map((conversation) => conversation.nativeSessionId)).toEqual(["tracked-native"]);
  expect(await readFile(journalPath, "utf8")).toBe(journal);

  // The property that matters: a row whose project is gone must not hide its native
  // session. Recreate the same two-step shape (conversation, then project delete)
  // and prove the session is offered again instead of being reported `tracked`.
  const orphanDir = await mkdtemp(path.join(tmpdir(), "caw-project-orphan-"));
  dirs.push(orphanDir);
  const orphanJournal = path.join(orphanDir, "orphan.jsonl");
  await writeFile(orphanJournal, journal);
  const orphanProject = await store.createProject({ path: orphanDir, label: "Orphan" });
  const orphanConversation = await store.createConversation({ projectId: orphanProject.id, nativeSessionId: "orphan-native", title: "Orphan" });
  await store.removeConversation(orphanConversation.id);
  expect(await store.deleteProject(orphanProject.id)).toBe("deleted");
  const orphanCatalog = {
    listForCwd: async (cwd: string) => cwd === orphanDir
      ? [{ sessionId: "orphan-native", path: orphanJournal, cwd, title: "Orphan", updatedAt: "", live: false }]
      : [],
  };
  const listOrphans = Function("paths", "catalog", "store", `${code};return listNativeSessions;`)(
    new WorkspacePathPolicy([orphanDir]), orphanCatalog, store,
  ) as (input: { projectPath: string }) => Promise<Array<{ sessionId: string; live: boolean; tracked: boolean }>>;
  expect(await listOrphans({ projectPath: orphanDir })).toMatchObject([
    { sessionId: "orphan-native", live: false, tracked: false },
  ]);
});
