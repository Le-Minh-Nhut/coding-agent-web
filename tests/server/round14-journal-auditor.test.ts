import { mkdtemp, rm, readFile, writeFile, appendFile, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { createMetadataStore } from "../../apps/server/src/store.js";

const fault = vi.hoisted(() => ({ armed: false, mode: "write" }));
vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return { ...actual, open: async (...args: Parameters<typeof actual.open>) => {
    const handle = await actual.open(...args);
    if (String(args[0]).endsWith("metadata.jsonl") && fault.armed) {
      fault.armed = false;
      const write = handle.writeFile.bind(handle);
      if (fault.mode === "sync") handle.sync = async () => { throw Object.assign(new Error("simulated fsync failure"), {code:"EIO"}); };
      else handle.writeFile = async (data, options) => {
        await write(String(data).slice(0, 25), options);
        throw Object.assign(new Error("simulated short write followed by ENOSPC"), { code: "ENOSPC" });
      };
    }
    return handle;
  }};
});
const dirs: string[] = [];
async function fixture() { const dir = await mkdtemp(join(tmpdir(), "caw-audit14-")); dirs.push(dir); return { dir, file: join(dir, "metadata.jsonl"), store: createMetadataStore(dir) }; }
afterEach(async () => { fault.armed = false; fault.mode = "write"; await Promise.all(dirs.splice(0).map(dir => rm(dir, {recursive: true, force: true}))); });

it("V14 EOF: a complete final JSON row without a newline must retain its project", async () => {
  const {dir, file, store} = await fixture();
  const project = await store.createProject({path: "/work/complete", label: "Complete valid JSON"});
  const text = await readFile(file, "utf8");
  await writeFile(file, text.slice(0, -1));
  const restored = await createMetadataStore(dir).listProjects();
  console.log("AUDIT14 complete EOF", JSON.stringify({before: project.id, after: restored, bytes: (await readFile(file)).length}));
  expect(restored.map(item => item.id)).toContain(project.id);
});

it("V14 append: one short write must not poison the next successful operation and next startup", async () => {
  const {dir, file, store} = await fixture();
  const first = await store.createProject({path: "/work/first"});
  fault.armed = true;
  await expect(store.updateProject(first.id, {label: "will fail"})).rejects.toMatchObject({code: "ENOSPC"});
  const next = await store.createProject({path: "/work/next"});
  let restored: unknown; let failure: unknown;
  try { restored = await createMetadataStore(dir).listProjects(); } catch(error) { failure = String(error); }
  console.log("AUDIT14 short write", JSON.stringify({successfulNext: next.id, restored, failure, journal: await readFile(file, "utf8")}));
  expect(failure).toBeUndefined();
  expect(restored).toEqual(expect.arrayContaining([expect.objectContaining({id: first.id}), expect.objectContaining({id: next.id})]));
});

it("V14 recovery evidence: a second torn tail is also retained before truncation", async () => {
  const {dir, file, store} = await fixture();
  await store.createProject({path: "/work/first"});
  await appendFile(file, '{"first-torn-tail":');
  await createMetadataStore(dir).listProjects();
  await appendFile(file, '{"second-torn-tail":');
  await createMetadataStore(dir).listProjects();
  const files = await readdir(dir);
  const contents = await Promise.all(files.map(name => readFile(join(dir, name), "utf8")));
  console.log("AUDIT14 repeated recovery", JSON.stringify({files, preservedSecondTail: contents.some(text => text.includes("second-torn-tail"))}));
  expect(contents.some(text => text.includes("second-torn-tail"))).toBe(true);
});

it("V15 fsync failure: a rejected create followed by retry cannot persist duplicate project paths", async () => {
  const {dir, store} = await fixture();
  fault.mode = "sync"; fault.armed = true;
  await expect(store.createProject({path:"/work/retried"})).rejects.toMatchObject({code:"EIO"});
  const retried = await store.createProject({path:"/work/retried"});
  const restored = await createMetadataStore(dir).listProjects();
  console.log("AUDIT15 fsync duplicate", JSON.stringify({acknowledged:retried.id,recoveredProjects:restored.map(p=>({id:p.id,path:p.path}))}));
  expect(restored.filter(p=>p.path==="/work/retried")).toHaveLength(1);
});
