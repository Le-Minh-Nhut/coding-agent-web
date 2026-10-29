import { constants } from "node:fs";
import { chmod, lstat, mkdir, open } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import type { Conversation, Project } from "@caw/contracts";
import { epochOf } from "@caw/contracts";

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
   * the project still has a conversation that is not in `verified` (the
   * conversations the caller observed as deletable, mapped to the lifecycle
   * epoch it observed them at): a conversation whose only reachable project is
   * gone becomes an orphan — running or not, it can be neither navigated nor
   * restarted.
   *
   * Two things make a row deletable, and both are checked here, inside this
   * queued operation:
   *
   *  - the stored row reads process-free (`stopped`/`error`, or a never-launched
   *    `starting` with no identity), or
   *  - the caller's observation is **current**: the row's lifecycle epoch still
   *    equals the epoch the caller observed, so the row is the same life the
   *    caller verified. This is what a `stopped` verdict from a *fresh*
   *    observation of a row whose cached label is stale `idle`/`running` rests
   *    on — the label is history, the observation is evidence, and the epoch
   *    binds the two.
   *
   * A launch that recorded its process after the caller's observation advances
   * the epoch, so neither branch holds and the delete refuses rather than
   * dropping the only pointer to a live process.
   *
   * A row whose launch is reserved but has not recorded its process yet reads
   * exactly like a never-launched row (`starting`, no identity), so the re-read
   * alone cannot tell them apart. The store owns that reservation
   * (`reserveLaunch`/`releaseLaunch` below) and consults its own set here, inside
   * this queued operation. Both this check and the launch's `reserveLaunch` run on
   * the store queue, so they cannot interleave: a reserve that commits first is
   * visible here and blocks, and a delete that commits first removes the row the
   * reserve reads, so the launch refuses before touching a process.
   */
  deleteProject(id: string, verified?: ReadonlyMap<string, number>): Promise<"deleted" | "not_found" | "has_conversations">;
  /**
   * Claim a launch for a conversation on the store queue. `true` means this call
   * took the claim; `false` means it did not — either the row is gone (a delete
   * queued first), or another launch already holds it. Runs inside `serialize()` so
   * it is ordered against every other queued op, in particular the delete above:
   * reserve-then-delete makes the delete refuse, delete-then-reserve fails here
   * because the row is gone. Either way the caller must not start a process, and on
   * `false` it holds nothing to release.
   */
  reserveLaunch(conversationId: string): Promise<boolean>;
  /**
   * Drop a launch reservation taken by `reserveLaunch`. Deliberately not queued:
   * it is a release, and the only thing ordering matters against is the reserve,
   * which already refuses a second claim for the same id.
   */
  releaseLaunch(conversationId: string): void;
  /**
   * Is a launch claimed for this conversation right now? A non-queued read of the
   * reservation set, for the UI and the delete route's own pre-checks. It does not
   * need the queue: the reservation is only ever added inside the queue, and the
   * authoritative decision — whether a delete may proceed — is made by
   * `deleteProject` inside that same queue, so a stale "false" here can only ever
   * make the caller ask a question the queued check then answers correctly.
   */
  isLaunchReserved(conversationId: string): boolean;
  /** Drop a conversation the app created but never managed to launch. */
  removeConversation(id: string): Promise<boolean>;
  listConversations(projectId: string): Promise<Conversation[]>;
  listAllConversations(): Promise<Conversation[]>;
  getConversation(id: string): Promise<Conversation | null>;
  createConversation(input: ConversationInput): Promise<Conversation>;
  registerExternalConversation(input: ExternalConversationInput): Promise<Conversation>;
  updateConversation(id: string, patch: Partial<Conversation>): Promise<Conversation | null>;
  /**
   * Write a lifecycle patch only while the row is still the life the caller
   * observed. See `ConversationRuntimeStore.updateConversationIfCurrent`: the
   * supervisor observes the machine, awaits probes, and then writes what it
   * learned, and a launch or stop can open a new life during that window. The
   * freshness check and the mutation are one section of this store's queue, so no
   * interleaving can slip between them.
   */
  updateConversationIfCurrent(
    id: string,
    expectedEpoch: number,
    patch: Partial<Conversation>,
  ): Promise<{ conversation: Conversation; applied: boolean } | null>;
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
  /**
   * Conversations with a launch in flight. The store owns this because only the
   * store can order it against the delete: both `reserveLaunch` and `deleteProject`
   * run on `queue`, so one of the two always commits first and sees the other.
   */
  const launchReservations = new Set<string>();
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
  async function append(rows: Row[]): Promise<void> {
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
      // What a caller's condition needs to hold stays a concern of the queue, not
      // of this write: the reservation and the delete are ordered by `serialize`, so
      // no re-check inside these awaits is needed (or possible) here.
      await handle.writeFile(rows.map((row) => `${JSON.stringify(row)}\n`).join(""));
      await handle.sync();
    } catch (error) {
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
  /**
   * Fields whose change means a different life owns the row: the process identity,
   * the room identity, and the `state`/`ownership` labels that describe them.
   *
   * The store, not the caller, advances `lifecycleEpoch` when one of these moves,
   * so the guarantee does not depend on every caller remembering to stamp it — and
   * the re-read inside a queued conditional write is decisive for a caller that
   * forgot. Bookkeeping fields (title, model preference, activity stamp) are
   * deliberately absent: changing a display label does not make an observation
   * about the running process wrong.
   */
  const LIFECYCLE_FIELDS: Array<keyof Conversation> = [
    "state", "ownership", "nativeSessionId", "nativeSessionPath", "tmuxSessionId",
    "tmuxServerIdentity", "tmuxPanePid", "hostInstanceId", "hostGeneration",
  ];
  const nextEpoch = (current: Conversation, patch: Partial<Conversation>): number | undefined =>
    changedKeys(current, patch).some((key) => LIFECYCLE_FIELDS.includes(key))
      ? epochOf(current) + 1
      : current.lifecycleEpoch;

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
    deleteProject(id, verified = new Map<string, number>()) {
      return serialize(async () => {
        await load();
        if (!projects.has(id)) return "not_found" as const;
        // The caller observes each conversation and marks the ones it verified as
        // deletable, but that observation happened before this queued op. So the
        // stored row is re-read here and accepted only while it is the *same life*
        // the caller verified:
        //
        //  - it reads process-free right now (`stopped`/`error`, or a never-launched
        //    `starting` with no identity), or
        //  - its lifecycle epoch still equals the one the caller observed, so the
        //    verdict the caller reached applies to the row standing here — this is
        //    how a cached `idle`/`running` label stops blocking a delete when the
        //    machine was freshly and positively observed dead.
        //
        // A launch that recorded its process since the observation advanced the
        // epoch, so neither branch holds and the delete refuses. `stop` keeps
        // `tmuxSessionId`, so a non-null id alone says nothing: what makes the
        // re-read decisive is the epoch and the state, both written through this
        // same queue.
        const processFree = (conversation: Conversation): boolean =>
          conversation.state === "stopped"
          || conversation.state === "error"
          || (conversation.state === "starting" && conversation.tmuxSessionId === null && conversation.tmuxPanePid === null);
        const below = [...conversations.values()].filter((conversation) => conversation.projectId === id);
        // The re-read decides on stored state and the observed epoch; the
        // reservation is the one thing a row cannot show, so the store's own set —
        // the same one `reserveLaunch` writes, on this same queue — is the
        // authority. One check is enough: a reserve either ran before this op (and
        // is visible here, blocking the whole delete with nothing written) or runs
        // after it (and finds the row gone, refusing the launch before a process
        // exists). There is no window in between, because both ops are sections of
        // this one queue.
        if (below.some((conversation) =>
          (!processFree(conversation) && verified.get(conversation.id) !== epochOf(conversation))
          || launchReservations.has(conversation.id))) {
          return "has_conversations" as const;
        }
        // Every row is verified deletable and still process-free: drop them with the
        // project in ONE journal record. Several rows in one `write` are not atomic
        // across a crash — a torn write could leave a conversation gone while the
        // project survived, and no retry can put the row back.
        const gone = below.map((conversation) => conversation.id);
        await append([{ op: "project-cascade-delete", id, conversationIds: gone }]);
        for (const conversationId of gone) dropConversation(conversationId);
        projects.delete(id); return "deleted" as const;
      });
    },
    async reserveLaunch(conversationId) {
      return serialize(async () => {
        await load();
        // Decided with the row read in the same queued section as the insert, so a
        // delete that got here first is already visible: its row is gone and no
        // reservation is taken for a conversation that no longer exists. `start()`
        // then refuses before any adapter call, so no process is created at all.
        if (!conversations.has(conversationId)) return false;
        // Already claimed by another in-flight launch: `false`, so that call's
        // `finally` never releases a claim it did not take. The supervisor tells
        // the two `false` cases apart by whether the row still reads.
        if (launchReservations.has(conversationId)) return false;
        launchReservations.add(conversationId);
        return true;
      });
    },
    releaseLaunch(conversationId) {
      launchReservations.delete(conversationId);
    },
    isLaunchReserved(conversationId) {
      return launchReservations.has(conversationId);
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
        // The store owns the lifecycle counter: a patch that changes any lifecycle
        // field opens a new life, so an observation taken before it can no longer be
        // committed over the row. A caller-supplied `lifecycleEpoch` is ignored — the
        // authority is the comparison of the stored row against this patch.
        const value: Conversation = {
          ...current,
          ...patch,
          id: current.id,
          projectId: current.projectId,
          lifecycleEpoch: nextEpoch(current, patch),
          updatedAt: stamp(),
        };
        await append([{ op: "conversation", value }]); conversations.set(id, value); return value;
      });
    },
    updateConversationIfCurrent(id, expectedEpoch, patch) {
      return serialize(async () => {
        await load();
        const current = conversations.get(id);
        if (!current) return null;
        // The freshness decision and the mutation are one queued section: a launch
        // that advanced the epoch is either already visible here (so this refuses)
        // or runs after this section (so its own identity is what the row ends up
        // holding). There is no interleaving in which a stale observation lands on
        // a newer life.
        if (epochOf(current) !== expectedEpoch) return { conversation: current, applied: false };
        if (changedKeys(current, patch).length === 0) return { conversation: current, applied: true };
        const value: Conversation = {
          ...current,
          ...patch,
          id: current.id,
          projectId: current.projectId,
          lifecycleEpoch: nextEpoch(current, patch),
          updatedAt: stamp(),
        };
        await append([{ op: "conversation", value }]); conversations.set(id, value); return { conversation: value, applied: true };
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
