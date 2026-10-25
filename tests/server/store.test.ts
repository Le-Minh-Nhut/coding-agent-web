import { mkdtemp, readFile, rm } from "node:fs/promises";
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
});
