import { appendFile, mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createMetadataStore } from "../../apps/server/src/store.js";

const dirs: string[] = [];
afterEach(async () => { await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true }))); });
async function create() { const dir = await mkdtemp(join(tmpdir(), "caw-store-")); dirs.push(dir); let time = 0; return { dir, store: createMetadataStore(dir, () => new Date(1_700_000_000_000 + time++)) }; }

describe("JSONL MetadataStore fallback", () => {
  it("stores commands idempotently, appends monotonic events and replays after cursor", async () => {
    const { dir, store } = await create();
    const project = await store.createProject({ path: "/tmp/project" });
    const conversation = await store.createConversation({ projectId: project.id });
    const first = await store.recordCommandOnce("same-key-123", conversation.id, "prompt", { text: "hello" });
    const duplicate = await store.recordCommandOnce("same-key-123", conversation.id, "prompt", { text: "changed" });
    expect(first.first).toBe(true); expect(duplicate.first).toBe(false); expect(duplicate.command).toEqual(first.command);
    const events = await Promise.all([store.recordEvent(conversation.id, "one", { n: 1 }), store.recordEvent(conversation.id, "two", { n: 2 })]);
    expect(events.map((event) => event.seq)).toEqual([1, 2]);
    expect((await store.listEvents(conversation.id, 1)).map((event) => event.seq)).toEqual([2]);
    const rows = (await readFile(join(dir, "metadata.jsonl"), "utf8")).trim().split("\n").map((line) => JSON.parse(line));
    expect(rows.filter((row) => row.op === "command")).toHaveLength(1);
  });

  it("replays persisted records after store recreation", async () => {
    const { dir, store } = await create();
    const project = await store.createProject({ path: "/tmp/replay" });
    const conversation = await store.createConversation({ projectId: project.id });
    await store.recordEvent(conversation.id, "saved", { ok: true });
    const recovered = createMetadataStore(dir);
    expect((await recovered.listEvents(conversation.id))[0]?.seq).toBe(1);
    expect(await recovered.getConversation(conversation.id)).toEqual(conversation);
  });
  it("recovers only an incomplete EOF tail and preserves it before future appends", async () => {
    const { dir, store } = await create();
    const project = await store.createProject({ path: "/tmp/torn" });
    const tail = '{"op":"conversation","value":';
    await appendFile(join(dir, "metadata.jsonl"), tail);
    const recovered = createMetadataStore(dir);
    expect(await recovered.listProjects()).toEqual([project]);
    expect(await readFile(join(dir, "metadata.jsonl.corrupt-tail"), "utf8")).toBe(tail);
    await recovered.createProject({ path: "/tmp/after-recovery" });
    const rows = (await readFile(join(dir, "metadata.jsonl"), "utf8")).trim().split("\n");
    expect(rows).toHaveLength(2);
    expect(rows.map((row) => JSON.parse(row).op)).toEqual(["project", "project"]);
  });

  it("fails on malformed complete records", async () => {
    const { dir, store } = await create();
    await store.createProject({ path: "/tmp/corrupt" });
    await appendFile(join(dir, "metadata.jsonl"), "{bad json}\n");
    await expect(createMetadataStore(dir).listProjects()).rejects.toThrow(SyntaxError);
  });

  it("does not truncate a torn tail when evidence preservation fails", async () => {
    const { dir, store } = await create();
    await store.createProject({ path: "/tmp/evidence-failure" });
    const tail = '{"op":"conversation","value":';
    await appendFile(join(dir, "metadata.jsonl"), tail);
    await mkdir(join(dir, "metadata.jsonl.corrupt-tail"));
    await expect(createMetadataStore(dir).listProjects()).rejects.toThrow("metadata tail evidence is not a regular file");
    expect((await readFile(join(dir, "metadata.jsonl"), "utf8")).endsWith(tail)).toBe(true);
  });


  it("registers one external conversation per project and native session", async () => {
    const { store } = await create();
    const project = await store.createProject({ path: "/tmp/live" });
    const input = { projectId: project.id, nativeSessionId: "native-live", title: "Live", hostInstanceId: "host-1", hostGeneration: 2 };
    const [first, second] = await Promise.all([store.registerExternalConversation(input), store.registerExternalConversation(input)]);
    expect(second).toEqual(first);
    expect(first).toMatchObject({ ownership: "external", state: "unknown", nativeSessionId: input.nativeSessionId, tmuxSessionId: null, tmuxServerIdentity: null, hostInstanceId: "host-1", hostGeneration: 2 });
    expect(await store.listConversations(project.id)).toEqual([first]);
  });
});
