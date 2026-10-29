import { execFile } from "node:child_process";
import { appendFile, chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import { createMetadataStore } from "../../apps/server/src/store.js";

const execFileAsync = promisify(execFile);

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

  it("preserves a second torn tail under its own name before truncating", async () => {
    const { dir, store } = await create();
    await store.createProject({ path: "/tmp/first-tail" });
    await appendFile(join(dir, "metadata.jsonl"), '{"first":');
    await createMetadataStore(dir).listProjects();
    await appendFile(join(dir, "metadata.jsonl"), '{"second":');
    await createMetadataStore(dir).listProjects();
    expect(await readFile(join(dir, "metadata.jsonl.corrupt-tail"), "utf8")).toBe('{"first":');
    expect(await readFile(join(dir, "metadata.jsonl.corrupt-tail.1"), "utf8")).toBe('{"second":');
  });

  it("does not truncate a second torn tail when its own evidence cannot be written", async () => {
    const { dir, store } = await create();
    await store.createProject({ path: "/tmp/second-evidence" });
    await appendFile(join(dir, "metadata.jsonl"), '{"first":');
    await createMetadataStore(dir).listProjects();
    await appendFile(join(dir, "metadata.jsonl"), '{"second":');
    await mkdir(join(dir, "metadata.jsonl.corrupt-tail.1"));
    await expect(createMetadataStore(dir).listProjects()).rejects.toThrow("metadata tail evidence is not a regular file");
    expect((await readFile(join(dir, "metadata.jsonl"), "utf8")).endsWith('{"second":')).toBe(true);
  });

  it("replays a complete final row that lost its newline, keeping the record", async () => {
    const { dir, store } = await create();
    const project = await store.createProject({ path: "/tmp/no-newline" });
    const text = await readFile(join(dir, "metadata.jsonl"), "utf8");
    await writeFile(join(dir, "metadata.jsonl"), text.slice(0, -1));
    const reopened = createMetadataStore(dir);
    expect(await reopened.listProjects()).toEqual([project]);
    // The delimiter is restored, so the next append is a new row rather than a
    // continuation of the previous one.
    await reopened.createProject({ path: "/tmp/after" });
    const rows = (await readFile(join(dir, "metadata.jsonl"), "utf8")).trim().split("\n");
    expect(rows.map((row) => JSON.parse(row).op)).toEqual(["project", "project"]);
  });

  it("leaves the journal untouched when the append cannot even open it", async () => {
    const { dir, store } = await create();
    const project = await store.createProject({ path: "/tmp/read-only" });
    const journal = join(dir, "metadata.jsonl");
    const before = await readFile(journal, "utf8");
    await chmod(journal, 0o400);
    await expect(store.createProject({ path: "/tmp/never" })).rejects.toMatchObject({ code: "EACCES" });
    expect(await readFile(journal, "utf8")).toBe(before);
    await chmod(journal, 0o600);
    expect((await store.listProjects()).map((item) => item.id)).toEqual([project.id]);
    await expect(store.createProject({ path: "/tmp/after-permission" })).resolves.toBeTruthy();
  });


  it("does not corrupt a row whose tail holds a byte the decoder had to repair", async () => {
    // A lone continuation byte is not valid UTF-8. Decoding the file as a string
    // and re-encoding it for offsets would place the "restored" newline past the
    // real end, writing NULs into the row; byte offsets keep them where they belong.
    const { dir } = await create();
    const journal = join(dir, "metadata.jsonl");
    const good = `${JSON.stringify({ op: "project", value: { id: "p1", path: "/tmp/Z", label: "Z", favorite: false, createdAt: "t", updatedAt: "t" } })}\n`;
    await writeFile(journal, Buffer.concat([Buffer.from(good, "utf8"), Buffer.from([0xe2])]));
    const reopened = createMetadataStore(dir);
    // The invalid tail is damage, not a row: preserved, then truncated away.
    expect((await reopened.listProjects()).map((project) => project.id)).toEqual(["p1"]);
    expect(await readFile(join(dir, "metadata.jsonl.corrupt-tail"))).toEqual(Buffer.from([0xe2]));
    expect((await readFile(journal, "utf8")).endsWith("}\n")).toBe(true);
    // Replaying the repaired file must parse, not fail on injected NUL bytes.
    await expect(reopened.createProject({ path: "/tmp/after" })).resolves.toBeTruthy();
    expect((await readFile(journal, "utf8")).trim().split("\n").every((row) => JSON.parse(row))).toBe(true);
  });

  it("retries a failed load instead of memoizing the failure forever", async () => {
    const { dir, store } = await create();
    await store.createProject({ path: "/tmp/first" });
    const journal = join(dir, "metadata.jsonl");
    await appendFile(journal, "{bad json}\n");
    const reopened = createMetadataStore(dir);
    await expect(reopened.listProjects()).rejects.toThrow(SyntaxError);
    // A human repairs the journal. The next call must read it, not replay the
    // rejection the first call memoized.
    await writeFile(journal, (await readFile(journal, "utf8")).replace("{bad json}\n", ""));
    expect((await reopened.listProjects()).map((project) => project.path)).toEqual(["/tmp/first"]);
  });

  it("refuses a FIFO standing where the tail evidence goes, instead of blocking", async () => {
    // Opening a FIFO for reading blocks until a writer appears, so the check must
    // be `lstat`, never an open. Otherwise one stray FIFO hangs every load forever.
    const { dir, store } = await create();
    await store.createProject({ path: "/tmp/fifo" });
    await appendFile(join(dir, "metadata.jsonl"), '{"half":');
    await execFileAsync("mkfifo", [join(dir, "metadata.jsonl.corrupt-tail")]);
    await expect(createMetadataStore(dir).listProjects()).rejects.toThrow("metadata tail evidence is not a regular file");
  });

  it("replays a repaired journal from scratch, without resurrecting removed rows or replaying events twice", async () => {
    // The V16-02 window: a failed load that had already replayed part of the
    // journal. The retry must land in the state the FILE describes, not the state
    // the failed attempt had half-built. A row the repair removed must stay gone
    // across repeated retries, and an event must not come back twice.
    const { dir } = await create();
    const journal = join(dir, "metadata.jsonl");
    const first = createMetadataStore(dir);
    const project = await first.createProject({ path: "/tmp/retry" });
    const conversation = await first.createConversation({ projectId: project.id });
    await first.recordEvent(conversation.id, "audit.event", { i: 1 });
    const valid = await readFile(journal, "utf8");
    // Break the journal, then repair it *and* drop the conversation's rows: the
    // reload must reflect the repair, not the prefix the failed attempt applied.
    await appendFile(journal, "{bad complete row}\n");
    const retrying = createMetadataStore(dir);
    await expect(retrying.listProjects()).rejects.toThrow(SyntaxError);
    const repaired = valid.split("\n")
      .filter((line) => line.length > 0 && !line.includes(conversation.id) && !line.includes(project.id))
      .join("\n");
    await writeFile(journal, repaired ? `${repaired}\n` : "");
    for (let attempt = 0; attempt < 3; attempt += 1) {
      expect(await retrying.listProjects()).toEqual([]);
      expect(await retrying.listConversations(project.id)).toEqual([]);
      expect(await retrying.listEvents(conversation.id)).toEqual([]);
    }
    // The retry state is not a ghost: a fresh append works and is the only row.
    const created = await retrying.createProject({ path: "/tmp/retry-after" });
    expect((await retrying.listProjects()).map((item) => item.id)).toEqual([created.id]);
    expect((await createMetadataStore(dir).listProjects()).map((item) => item.id)).toEqual([created.id]);
  });

  it("sends a real invalid byte to corrupt-tail while keeping a literal replacement character", async () => {
    // The two cases the old `tail.includes("\uFFFD")` check conflated: a literal
    // U+FFFD inside valid UTF-8 data is a record, while a lone lead byte is damage.
    // Only the latter may be preserved as evidence and truncated away.
    const { dir } = await create();
    const journal = join(dir, "metadata.jsonl");
    const label = "Pasted \uFFFD character";
    const good = `${JSON.stringify({ op: "project", value: { id: "p1", path: "/tmp/U", label, favorite: false, createdAt: "t", updatedAt: "t" } })}\n`;
    // Valid UTF-8 with a literal U+FFFD, missing only the final newline → a record.
    await writeFile(journal, Buffer.from(good.slice(0, -1), "utf8"));
    const restored = await createMetadataStore(dir).listProjects();
    expect(restored.map((project) => project.label)).toEqual([label]);
    // A lone 0xE2 (the first byte of a 3-byte sequence, no continuation) → damage.
    const damaged = Buffer.concat([Buffer.from(good, "utf8"), Buffer.from([0xe2])]);
    await writeFile(journal, damaged);
    const reopened = createMetadataStore(dir);
    expect((await reopened.listProjects()).map((project) => project.id)).toEqual(["p1"]);
    expect(await readFile(join(dir, "metadata.jsonl.corrupt-tail"))).toEqual(Buffer.from([0xe2]));
    expect((await readFile(journal, "utf8")).endsWith("}\n")).toBe(true);
  });

  it("refuses the delete when a launch reservation is registered before the queued delete runs", async () => {
    // The V16-01 window: a row whose launch is reserved but has not recorded its
    // process reads exactly like a never-launched row. The stored state cannot tell
    // them apart, so the reservation is consulted inside the queued delete, and
    // again inside the append after that append's own awaits. A reservation held
    // when either check runs must block even though nothing about the row changed.
    const { store } = await create();
    const project = await store.createProject({ path: "/tmp/pending-launch" });
    const conversation = await store.createConversation({ projectId: project.id });
    const reserved = new Set<string>();
    const pending = (id: string): boolean => reserved.has(id);
    // No reservation yet: the ordinary never-launched delete goes through.
    expect(await store.deleteProject(project.id, [conversation.id], pending)).toBe("deleted");
    // And with one held, the same call refuses and keeps every row.
    const second = await store.createConversation({ projectId: (await store.createProject({ path: "/tmp/pending-launch-2" })).id });
    reserved.add(second.id);
    expect(await store.deleteProject(second.projectId, [second.id], pending)).toBe("has_conversations");
    expect((await store.listConversations(second.projectId)).map((row) => row.id)).toEqual([second.id]);
    expect((await store.listProjects()).some((item) => item.id === second.projectId)).toBe(true);
    // Released: the retry succeeds.
    reserved.delete(second.id);
    expect(await store.deleteProject(second.projectId, [second.id], pending)).toBe("deleted");
    expect((await store.listProjects()).some((item) => item.id === second.projectId)).toBe(false);
  });

  it("refuses the delete when the reservation appears during the delete's own I/O", async () => {
    // The gap the first check alone leaves: the delete reads the journal, opens it,
    // stats it and chmods it, and a launch can claim the conversation in any of
    // those turns. Here the predicate answers "no reservation" to the pre-append
    // check and "reserved" to the one inside the append — a reservation registered
    // in exactly that window. Nothing may be written, and both rows must survive.
    const { dir, store } = await create();
    const project = await store.createProject({ path: "/tmp/mid-delete-launch" });
    const conversation = await store.createConversation({ projectId: project.id });
    const before = await readFile(join(dir, "metadata.jsonl"), "utf8");
    let asked = 0;
    const pending = (): boolean => (asked += 1) > 1;
    expect(await store.deleteProject(project.id, [conversation.id], pending)).toBe("has_conversations");
    expect(asked).toBe(2);
    // The declined append wrote nothing: the journal is byte-identical, so no
    // cascade row exists for a replay to act on.
    expect(await readFile(join(dir, "metadata.jsonl"), "utf8")).toBe(before);
    expect(await store.listProjects()).toEqual([project]);
    expect((await store.listConversations(project.id)).map((row) => row.id)).toEqual([conversation.id]);
  });

  it("treats a non-boolean reservation answer as no reservation", async () => {
    // A predicate that returns a Promise (or any truthy non-`true`) would block
    // every delete forever under loose coercion. Only a strict `true` blocks.
    const { store } = await create();
    const project = await store.createProject({ path: "/tmp/loose-pending" });
    const conversation = await store.createConversation({ projectId: project.id });
    const loose = (() => Promise.resolve(false)) as unknown as (id: string) => boolean;
    expect(await store.deleteProject(project.id, [conversation.id], loose)).toBe("deleted");
    expect(await store.listProjects()).toEqual([]);
  });

  it("drops a conversation's events with it, so a delete leaves no orphans", async () => {
    const { dir, store } = await create();
    const project = await store.createProject({ path: "/tmp/events" });
    const conversation = await store.createConversation({ projectId: project.id });
    await store.recordEvent(conversation.id, "audit.event", { i: 1 });
    expect(await store.listEvents(conversation.id)).toHaveLength(1);
    expect(await store.deleteProject(project.id, [conversation.id])).toBe("deleted");
    // Replay the journal: the conversation-delete row takes its events with it
    // rather than leaving rows in the log with no parent.
    expect(await createMetadataStore(dir).listEvents(conversation.id)).toEqual([]);
  });

  it("refuses the delete when a verified-stopped row was restarted before it ran", async () => {
    // The window the caller cannot see: it observed this row as stopped, but a
    // restart recorded a process before the queued delete ran. Deleting it would
    // drop the only pointer to that live writer, so the store re-reads the row and
    // refuses instead of trusting the caller's id list.
    const { store } = await create();
    const project = await store.createProject({ path: "/tmp/raced" });
    const conversation = await store.createConversation({ projectId: project.id });
    await store.updateConversation(conversation.id, { state: "stopped" });
    await store.updateConversation(conversation.id, { state: "starting", tmuxSessionId: "$9", tmuxSessionName: "caw-raced", tmuxServerIdentity: "private:1", tmuxPanePid: 4242, nativeSessionId: "raced-native" });
    expect(await store.deleteProject(project.id, [conversation.id])).toBe("has_conversations");
    expect((await store.listProjects()).map((item) => item.id)).toEqual([project.id]);
    expect((await store.listConversations(project.id)).map((item) => item.id)).toEqual([conversation.id]);
    // And once it is stopped again, the same call goes through.
    await store.updateConversation(conversation.id, { state: "stopped" });
    expect(await store.deleteProject(project.id, [conversation.id])).toBe("deleted");
  });

  it("refuses the delete when a verified-stopped row published a live host before it ran", async () => {
    // Same window, further along: the restart already got past `starting`, so the
    // row reads `running`. Only the state tells us a process may exist.
    const { store } = await create();
    const project = await store.createProject({ path: "/tmp/raced-live" });
    const conversation = await store.createConversation({ projectId: project.id });
    await store.updateConversation(conversation.id, { state: "stopped" });
    await store.updateConversation(conversation.id, { state: "running", tmuxSessionId: "$3", tmuxServerIdentity: "private:1", tmuxPanePid: 4321 });
    expect(await store.deleteProject(project.id, [conversation.id])).toBe("has_conversations");
    expect((await store.listConversations(project.id)).map((item) => item.id)).toEqual([conversation.id]);
  });

  it("still deletes a stopped row that keeps its recorded tmux id", async () => {
    // `stop` does not clear `tmuxSessionId`, so a non-null id must not by itself
    // block the ordinary delete-after-stop flow.
    const { store } = await create();
    const project = await store.createProject({ path: "/tmp/stopped-with-id" });
    const conversation = await store.createConversation({ projectId: project.id });
    await store.updateConversation(conversation.id, { state: "running", tmuxSessionId: "$4", tmuxServerIdentity: "private:1", tmuxPanePid: 4444 });
    await store.updateConversation(conversation.id, { state: "stopped" });
    expect((await store.getConversation(conversation.id))?.tmuxSessionId).toBe("$4");
    expect(await store.deleteProject(project.id, [conversation.id])).toBe("deleted");
    expect(await store.listProjects()).toEqual([]);
  });

  it("does not append a journal row when an update changes nothing", async () => {
    const { dir, store } = await create();
    const project = await store.createProject({ path: "/tmp/noop" });
    const conversation = await store.createConversation({ projectId: project.id });
    const before = (await readFile(join(dir, "metadata.jsonl"), "utf8")).length;
    for (let i = 0; i < 5; i += 1) {
      await store.updateProject(project.id, { label: project.label });
      await store.updateConversation(conversation.id, { state: conversation.state });
    }
    // The UI polls the model route; a no-op PATCH must not grow the append-only log.
    expect((await readFile(join(dir, "metadata.jsonl"), "utf8")).length).toBe(before);
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
