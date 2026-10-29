import { constants } from "node:fs";
import { chmod, lstat, mkdir, open } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import type { Conversation, Project } from "@caw/contracts";

/*
 * Storage fallback: Node 20.19 smoke probe returned `Error: No such built-in
 * module: node:sqlite`. Async store contract allows a SQLite swap without route edits.
 */
export interface StoreEvent<T = unknown> { id: string; conversationId: string; seq: number; type: string; ts: string; payload: T }
export interface StoredCommand { idempotencyKey: string; conversationId: string; kind: string; payload: Record<string, unknown>; createdAt: string }
export interface ProjectInput { path: string; label?: string }
export interface ConversationInput { projectId: string; title?: string; nativeSessionId?: string }
export interface ExternalConversationInput { projectId: string; nativeSessionId: string; title: string; hostInstanceId: string; hostGeneration: number | null }
export interface MetadataStore {
  listProjects(): Promise<Project[]>;
  createProject(input: ProjectInput): Promise<Project>;
  updateProject(id: string, patch: Partial<Pick<Project, "label" | "favorite">>): Promise<Project | null>;
  /**
   * Delete a project the app records. Refuses, without writing anything, when
   * the project still has a conversation that is not in
   * `verifiedStoppedConversationIds` (the ones the caller observed as stopped,
   * or that never had a process launched): a conversation whose only reachable
   * project is gone becomes an orphan — running or not, it can be neither
   * navigated nor restarted.
   *
   * Every row is re-read here and dropped only while it still reads process-free,
   * so a launch that recorded a process after the caller's observation is refused
   * rather than dropped. The re-read, the row removal and the delete share one
   * queued write, so a racing launch writes through the same queue and is visible
   * to the re-read.
   *
   * A row whose launch is reserved but has not recorded its process yet reads
   * exactly like a never-launched row (`starting`, no identity), so the re-read
   * alone cannot tell them apart. `isProcessPending` is the caller's view of that
   * reservation, and it is consulted *inside this queued operation*, after every
   * await of the caller's request: `start()` registers the reservation eagerly and
   * synchronously (before its own first await), so any launch that has begun by the
   * time this predicate runs is visible and blocks the delete, instead of the
   * delete dropping the only pointer to a starting process.
   */
  deleteProject(id: string, verifiedStoppedConversationIds?: readonly string[], isProcessPending?: (conversationId: string) => boolean): Promise<"deleted" | "not_found" | "has_conversations">;
  /** Drop a conversation the app created but never managed to launch. */
  removeConversation(id: string): Promise<boolean>;
  listConversations(projectId: string): Promise<Conversation[]>;
  listAllConversations(): Promise<Conversation[]>;
  getConversation(id: string): Promise<Conversation | null>;
  createConversation(input: ConversationInput): Promise<Conversation>;
  registerExternalConversation(input: ExternalConversationInput): Promise<Conversation>;
  updateConversation(id: string, patch: Partial<Conversation>): Promise<Conversation | null>;
  recordEvent<T>(conversationId: string, type: string, payload: T, ts?: string): Promise<StoreEvent<T>>;
  listEvents<T = unknown>(conversationId: string, afterSeq?: number, limit?: number): Promise<Array<StoreEvent<T>>>;
  recordCommandOnce(idempotencyKey: string, conversationId: string, kind: string, payload: Record<string, unknown>): Promise<{ first: boolean; command: StoredCommand }>;
}

type Row =
  | { op: "project"; value: Project }
  | { op: "project-delete"; id: string }
  /**
   * The whole project delete as ONE record: the project row and every
   * conversation it drops, applied all-or-nothing on replay. Rows land one line
   * at a time, so a cascade written as several lines could be torn by a crash
   * into "some children gone, project still here" — the one state a retry cannot
   * repair. The older single-purpose rows below still replay, because journals
   * written before this record exists are still on disk.
   */
  | { op: "project-cascade-delete"; id: string; conversationIds: string[] }
  | { op: "conversation"; value: Conversation }
  | { op: "conversation-delete"; id: string }
  | { op: "event"; value: StoreEvent }
  | { op: "command"; value: StoredCommand };

/**
 * Raised by a guarded `append` that declined to write: the condition it was given
 * (a launch reservation) became true after the caller's own check, and nothing has
 * been written yet. So there is nothing to roll back — the caller decides the
 * outcome — and the journal must not be touched.
 */
class AppendDeclined extends Error {}

export function createMetadataStore(stateDir: string, now: () => Date = () => new Date()): MetadataStore {
  const file = join(stateDir, "metadata.jsonl");
  /**
   * A successful replay REPLACES all four maps rather than filling them, so a
   * load that fails half way cannot leave live state holding rows the journal no
   * longer has. The retry that follows a human repair replays from scratch; if
   * the failed attempt had published the rows it had already applied, every one of
   * them would land twice (an event would read `seq [1,1]`).
   */
  let projects = new Map<string, Project>();
  let conversations = new Map<string, Conversation>();
  let events = new Map<string, StoreEvent[]>();
  let commands = new Map<string, StoredCommand>();
  let loaded: Promise<void> | undefined;
  let queue: Promise<unknown> = Promise.resolve();
  /** Set when a failed write could not be rolled back; every later write refuses. */
  let journalFailure: string | null = null;
  const stamp = () => now().toISOString();

  /**
   * Preserve a torn tail before truncating it.
   *
   * The first recovery keeps the historical `.corrupt-tail` name. A later one
   * writes its own suffix instead of silently dropping the new tail on the floor
   * (`O_EXCL` on the old name would only have found the previous evidence). A
   * candidate that exists but is not a regular file — a directory, a symlink, a
   * FIFO — is a preservation failure: we must not follow it, and we must not
   * truncate on the strength of a backup we did not make. It is checked with
   * `lstat`, never by opening: reading a FIFO would block the load forever.
   *
   * The tail is written as raw bytes, because a damaged tail is exactly the case
   * where re-encoding the decoded string would not reproduce the file.
   */
  async function preserveTail(tail: Buffer | string): Promise<void> {
    for (let index = 0; index < 1000; index += 1) {
      const target = index === 0 ? `${file}.corrupt-tail` : `${file}.corrupt-tail.${index}`;
      const existing = await lstat(target).catch(() => null);
      if (existing) {
        if (!existing.isFile()) throw new Error("metadata tail evidence is not a regular file");
        // A regular file from an earlier recovery: keep it and use the next name.
        continue;
      }
      let evidence;
      try {
        evidence = await open(target, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
      } catch (error) {
        // Something appeared between the check and the open; treat it like any other
        // existing candidate rather than overwriting evidence we did not make.
        if ((error as NodeJS.ErrnoException).code === "EEXIST") continue;
        throw error;
      }
      try { await evidence.writeFile(tail); await evidence.sync(); }
      finally { await evidence.close(); }
      return;
    }
    throw new Error("metadata tail evidence could not be written: too many preserved tails");
  }

  async function load(): Promise<void> {
    if (!loaded) loaded = (async () => {
      await mkdir(stateDir, { recursive: true, mode: 0o700 });
      await chmod(stateDir, 0o700);
      let handle;
      try { handle = await open(file, constants.O_RDWR | constants.O_NOFOLLOW); }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
        throw error;
      }
      let kept: Buffer;
      try {
        if (!(await handle.stat()).isFile()) throw new Error("metadata journal is not a regular file");
        await handle.chmod(0o600);
        // Byte offsets must come from the buffer: `readFile("utf8")` replaces invalid
        // bytes with U+FFFD, so re-encoding the string would not land on the real EOF
        // (a newline "restored" past the end writes NULs into the last row).
        const bytes = await handle.readFile();
        kept = bytes;
        const lastNewline = bytes.lastIndexOf(0x0a);
        if (lastNewline !== bytes.length - 1) {
          const tailBytes = bytes.subarray(lastNewline + 1);
          let finalRow: unknown = null;
          // A tail the UTF-8 decoder had to repair is damage, not a row: a byte
          // sequence Node replaced with U+FFFD is not what a writer put there. The
          // check must be on the BYTES, though — a literal U+FFFD inside a valid
          // label is perfectly good data and `tail.includes("\uFFFD")` would have
          // thrown it away. `fatal: true` throws exactly on a malformed sequence.
          let validUtf8 = true;
          try { new TextDecoder("utf-8", { fatal: true }).decode(tailBytes); }
          catch { validUtf8 = false; }
          if (validUtf8) {
            // A BOM-led tail passes the fatal decoder (a BOM is valid UTF-8) but
            // `JSON.parse` rejects it, so such a row is preserved as a corrupt tail
            // rather than replayed. Unreachable in practice — our own writer never
            // emits a BOM — and harmless: the bytes are kept as evidence.
            try { finalRow = JSON.parse(tailBytes.toString("utf8")); } catch { finalRow = null; }
          }
          if (finalRow !== null && typeof finalRow === "object" && typeof (finalRow as Row).op === "string") {
            // An older writer could drop the final newline without losing the record
            // itself. A tail that parses as one whole row is a record, not damage:
            // restore its delimiter at the true end of the file and keep it.
            await handle.write(Buffer.from("\n"), 0, 1, bytes.length);
            kept = Buffer.concat([bytes, Buffer.from("\n")]);
          } else {
            await preserveTail(tailBytes);
            await handle.truncate(lastNewline + 1);
            kept = bytes.subarray(0, lastNewline + 1);
          }
        }
      } finally { await handle.close(); }
      const text = kept.toString("utf8");
      // Replay into scratch maps and publish only when every row parsed. A
      // complete JSONL row that fails still fails loudly — only an unterminated EOF
      // tail is recoverable — but nothing it had already replayed reaches the live
      // maps, so the retry starts from the journal rather than from half of it.
      const nextProjects = new Map<string, Project>();
      const nextConversations = new Map<string, Conversation>();
      const nextEvents = new Map<string, StoreEvent[]>();
      const nextCommands = new Map<string, StoredCommand>();
      const dropFrom = (id: string): void => {
        nextConversations.delete(id);
        nextEvents.delete(id);
        for (const [key, command] of nextCommands) if (command.conversationId === id) nextCommands.delete(key);
      };
      for (const line of text.split("\n")) {
        if (!line) continue;
        const row = JSON.parse(line) as Row;
        if (row.op === "project") nextProjects.set(row.value.id, row.value);
        else if (row.op === "project-delete") nextProjects.delete(row.id);
        else if (row.op === "project-cascade-delete") {
          for (const conversationId of row.conversationIds) dropFrom(conversationId);
          nextProjects.delete(row.id);
        } else if (row.op === "conversation") nextConversations.set(row.value.id, row.value);
        // A conversation-delete row means the conversation is gone, so its events and
        // commands go with it rather than staying in the journal with no parent.
        else if (row.op === "conversation-delete") dropFrom(row.id);
        else if (row.op === "event") {
          const list = nextEvents.get(row.value.conversationId) ?? [];
          list.push(row.value);
          nextEvents.set(row.value.conversationId, list);
        } else if (row.op === "command") nextCommands.set(row.value.idempotencyKey, row.value);
      }
      projects = nextProjects;
      conversations = nextConversations;
      events = nextEvents;
      commands = nextCommands;
    })().catch((error: unknown) => {
      // A rejected load is not memoized: after a human repairs the journal the next
      // call must be able to read it again. A still-broken journal fails per call.
      loaded = undefined;
      throw error;
    });
    await loaded;
  }
  /** Forget a conversation and everything recorded beneath it. */
  function dropConversation(id: string): void {
    conversations.delete(id);
    events.delete(id);
    for (const [key, command] of commands) if (command.conversationId === id) commands.delete(key);
  }
  /**
   * Append rows and only report success once they are both written and durable.
   *
   * Several rows go out as ONE write, because a delete that lands half way leaves
   * rows destroyed with the thing they belonged to still present. The commit marker
   * is the trailing newline. A short write or a failed sync after a full write
   * leaves a fragment (or a whole unwritten-through row) that a later successful
   * append would concatenate into one malformed line, taking every earlier record
   * down with it on the next load. So the journal is restored to the byte offset it
   * had before this append and the failure is rethrown. If even that fails, the
   * store is poisoned: every later write refuses loudly rather than appending onto
   * a journal we cannot trust.
   */
  async function append(rows: Row[], mayWrite?: () => boolean): Promise<void> {
    await load();
    if (journalFailure) throw new Error(journalFailure);
    const handle = await open(file, constants.O_RDWR | constants.O_APPEND | constants.O_CREAT | constants.O_NOFOLLOW, 0o600);
    // Only ever roll back to an offset actually read from the file. Until then no
    // byte of ours was written, and truncating would destroy what was already there.
    let offset: number | null = null;
    try {
      const stat = await handle.stat();
      if (!stat.isFile()) throw new Error("metadata journal is not a regular file");
      offset = stat.size;
      await handle.chmod(0o600);
      // Last possible instant: `open`, `stat` and `chmod` all yielded, and a launch
      // may have claimed the conversation since the caller's own check. Asking again
      // here — before a byte is written — is what makes the guard cover those turns
      // rather than only the ones before them. Nothing is written, so nothing is
      // rolled back; the caller maps the refusal to its own outcome.
      // ponytail: in-process fifo, not a lock — a reservation taken *inside* the
      // write() call itself is still unobservable, which needs a real cross-process
      // lease. That window is one syscall wide and has no observable seam.
      if (mayWrite && !mayWrite()) throw new AppendDeclined();
      await handle.writeFile(rows.map((row) => `${JSON.stringify(row)}\n`).join(""));
      await handle.sync();
    } catch (error) {
      if (error instanceof AppendDeclined) throw error;
      if (offset === null) throw error;
      try { await handle.truncate(offset); }
      catch {
        journalFailure = `The metadata journal could not be rolled back after a failed write (${error instanceof Error ? error.message : String(error)}); refusing further writes until it is repaired.`;
        throw new Error(journalFailure);
      }
      throw error;
    } finally {
      await handle.close();
    }
  }
  function serialize<T>(operation: () => Promise<T>): Promise<T> {
    const result = queue.then(operation, operation);
    queue = result.then(() => undefined, () => undefined);
    return result;
  }
  const changedKeys = <T extends object>(current: T, patch: Partial<T>): Array<keyof T> =>
    (Object.keys(patch) as Array<keyof T>).filter((key) => current[key] !== patch[key]);

  return {
    async listProjects() { await load(); return [...projects.values()]; },
    createProject(input) {
      return serialize(async () => {
        await load();
        if ([...projects.values()].some((item) => item.path === input.path)) throw new Error("Project path already exists");
        const created = stamp();
        const value: Project = { id: randomUUID(), path: input.path, label: input.label ?? input.path.split(/[\\/]/).pop() ?? input.path, favorite: false, createdAt: created, updatedAt: created };
        await append([{ op: "project", value }]); projects.set(value.id, value); return value;
      });
    },
    updateProject(id, patch) {
      return serialize(async () => {
        await load();
        const current = projects.get(id);
        if (!current) return null;
        const value = { ...current, ...patch, updatedAt: stamp() };
        // Only a real change is worth a journal row: the log is append-only, and the
        // UI polls. Comparing here (not in the route) covers every caller.
        if (changedKeys(current, patch).length === 0) return current;
        await append([{ op: "project", value }]); projects.set(id, value); return value;
      });
    },
    deleteProject(id, verifiedStoppedConversationIds = [], isProcessPending) {
      return serialize(async () => {
        await load();
        if (!projects.has(id)) return "not_found" as const;
        // The caller observes each conversation and lists the ones it verified as
        // stopped, but that observation happened before this queued op. So every row
        // is re-read here and deleted only while it still reads process-free — a row
        // whose launch recorded a process since (or finished and published) blocks.
        // `stop` keeps `tmuxSessionId`, so a non-null id alone says nothing: what
        // makes the re-read decisive is that a restart writes `starting` (or a live
        // host state) plus its own identity through the same queue, so the row is
        // already changed by the time this runs. A row no longer under the project
        // is simply not a row to drop.
        const verified = new Set(verifiedStoppedConversationIds);
        const processFree = (conversation: Conversation): boolean =>
          conversation.state === "stopped"
          || conversation.state === "error"
          || (conversation.state === "starting" && conversation.tmuxSessionId === null && conversation.tmuxPanePid === null);
        const below = [...conversations.values()].filter((conversation) => conversation.projectId === id);
        // The re-read decides on stored state; the reservation is the one thing a
        // row cannot show, so it is asked here — and again inside the append, after
        // that append's own awaits. A start that registers its reservation after the
        // first check but before the write claims this project's conversation, and
        // only the second check is late enough to see it.
        const pending = isProcessPending ?? (() => false);
        // A row the caller never saw, one that no longer reads process-free, or one
        // whose launch is reserved but not yet recorded, blocks. The result is
        // compared strictly: an accidental Promise from a sloppy callback is truthy
        // and would block every delete forever, which is the failure mode this
        // guard must never introduce.
        const blocked = (): boolean =>
          below.some((conversation) => !verified.has(conversation.id) || !processFree(conversation) || pending(conversation.id) === true);
        if (blocked()) return "has_conversations" as const;
        // Every row is verified stopped and still process-free: drop them with the
        // project in ONE journal record. Several rows in one `write` are not atomic
        // across a crash — a torn write could leave a conversation gone while the
        // project survived, and no retry can put the row back.
        const gone = below.map((conversation) => conversation.id);
        try {
          await append([{ op: "project-cascade-delete", id, conversationIds: gone }], () => !blocked());
        } catch (error) {
          // A reservation appeared between the check above and the write itself, so
          // the append declined and wrote nothing. Report the same refusal the first
          // check would have: the caller sees one outcome for one condition.
          if (error instanceof AppendDeclined) return "has_conversations" as const;
          throw error;
        }
        for (const conversationId of gone) dropConversation(conversationId);
        projects.delete(id); return "deleted" as const;
      });
    },
    removeConversation(id) {
      return serialize(async () => {
        await load();
        if (!conversations.has(id)) return false;
        await append([{ op: "conversation-delete", id }]); dropConversation(id); return true;
      });
    },
    async listConversations(projectId) { await load(); return [...conversations.values()].filter((conversation) => conversation.projectId === projectId); },
    async listAllConversations() { await load(); return [...conversations.values()]; },
    async getConversation(id) { await load(); return conversations.get(id) ?? null; },
    createConversation(input) {
      return serialize(async () => {
        await load();
        if (!projects.has(input.projectId)) throw new Error("Project not found");
        const created = stamp();
        const value: Conversation = {
          id: randomUUID(), projectId: input.projectId, nativeSessionId: input.nativeSessionId ?? null,
          nativeSessionPath: null, title: input.title ?? "New conversation", modelPreference: null, model: null,
          ownership: "managed", state: "starting", tmuxSessionId: null, tmuxSessionName: null,
          tmuxServerIdentity: null, tmuxPanePid: null,
          hostInstanceId: null, hostGeneration: null, createdAt: created, updatedAt: created,
          lastActivityAt: null, statusDetail: null,
        };
        await append([{ op: "conversation", value }]); conversations.set(value.id, value); return value;
      });
    },
    registerExternalConversation(input) {
      return serialize(async () => {
        await load();
        if (!projects.has(input.projectId)) throw new Error("Project not found");
        const existing = [...conversations.values()].find((conversation) => conversation.projectId === input.projectId && conversation.nativeSessionId === input.nativeSessionId);
        if (existing) return existing;
        const created = stamp();
        const value: Conversation = {
          id: randomUUID(), projectId: input.projectId, nativeSessionId: input.nativeSessionId,
          nativeSessionPath: null, title: input.title, modelPreference: null, model: null,
          ownership: "external", state: "unknown", tmuxSessionId: null, tmuxSessionName: null,
          tmuxServerIdentity: null, tmuxPanePid: null, hostInstanceId: input.hostInstanceId,
          hostGeneration: input.hostGeneration, createdAt: created, updatedAt: created,
          lastActivityAt: null, statusDetail: "Observed live session; lifecycle is not managed here.",
        };
        await append([{ op: "conversation", value }]); conversations.set(value.id, value); return value;
      });
    },
    updateConversation(id, patch) {
      return serialize(async () => {
        await load();
        const current = conversations.get(id);
        if (!current) return null;
        // A patch that changes nothing must not add a row: refresh polls this path,
        // and the journal is append-only. Callers that want a touch pass a real change.
        if (changedKeys(current, patch).length === 0) return current;
        const value: Conversation = { ...current, ...patch, id: current.id, projectId: current.projectId, updatedAt: stamp() };
        await append([{ op: "conversation", value }]); conversations.set(id, value); return value;
      });
    },
    recordEvent(conversationId, type, payload, ts = stamp()) {
      return serialize(async () => {
        await load();
        if (!conversations.has(conversationId)) throw new Error("Conversation not found");
        const list = events.get(conversationId) ?? [];
        const value: StoreEvent = { id: randomUUID(), conversationId, seq: (list.at(-1)?.seq ?? 0) + 1, type, ts, payload };
        await append([{ op: "event", value }]); list.push(value); events.set(conversationId, list); return value as StoreEvent<typeof payload>;
      });
    },
    async listEvents<T = unknown>(conversationId: string, afterSeq = 0, limit = 100) {
      await load();
      return (events.get(conversationId) ?? []).filter((event) => event.seq > afterSeq).slice(0, Math.max(0, Math.min(1000, limit))) as Array<StoreEvent<T>>;
    },
    recordCommandOnce(idempotencyKey, conversationId, kind, payload) {
      return serialize(async () => {
        await load();
        const existing = commands.get(idempotencyKey);
        if (existing) return { first: false, command: existing };
        if (!conversations.has(conversationId)) throw new Error("Conversation not found");
        const command = { idempotencyKey, conversationId, kind, payload, createdAt: stamp() };
        await append([{ op: "command", value: command }]); commands.set(idempotencyKey, command);
        return { first: true, command };
      });
    },
  };
}
