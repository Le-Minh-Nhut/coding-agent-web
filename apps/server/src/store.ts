import { constants } from "node:fs";
import { chmod, mkdir, open } from "node:fs/promises";
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
  deleteProject(id: string): Promise<boolean>;
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
  | { op: "conversation"; value: Conversation }
  | { op: "event"; value: StoreEvent }
  | { op: "command"; value: StoredCommand };

export function createMetadataStore(stateDir: string, now: () => Date = () => new Date()): MetadataStore {
  const file = join(stateDir, "metadata.jsonl");
  const projects = new Map<string, Project>();
  const conversations = new Map<string, Conversation>();
  const events = new Map<string, StoreEvent[]>();
  const commands = new Map<string, StoredCommand>();
  let loaded: Promise<void> | undefined;
  let queue: Promise<unknown> = Promise.resolve();
  const stamp = () => now().toISOString();

  async function load(): Promise<void> {
    if (!loaded) loaded = (async () => {
      await mkdir(stateDir, { recursive: true, mode: 0o700 });
      await chmod(stateDir, 0o700);
      let handle;
      try { handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW); }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
        throw error;
      }
      let text: string;
      try {
        if (!(await handle.stat()).isFile()) throw new Error("metadata journal is not a regular file");
        await handle.chmod(0o600);
        text = await handle.readFile("utf8");
      } finally { await handle.close(); }
      for (const line of text.split("\n")) {
        if (!line) continue;
        const row = JSON.parse(line) as Row;
        if (row.op === "project") projects.set(row.value.id, row.value);
        else if (row.op === "project-delete") projects.delete(row.id);
        else if (row.op === "conversation") conversations.set(row.value.id, row.value);
        else if (row.op === "event") {
          const list = events.get(row.value.conversationId) ?? [];
          list.push(row.value);
          events.set(row.value.conversationId, list);
        } else if (row.op === "command") commands.set(row.value.idempotencyKey, row.value);
      }
    })();
    await loaded;
  }
  async function append(row: Row): Promise<void> {
    await load();
    const handle = await open(file, constants.O_WRONLY | constants.O_APPEND | constants.O_CREAT | constants.O_NOFOLLOW, 0o600);
    try {
      if (!(await handle.stat()).isFile()) throw new Error("metadata journal is not a regular file");
      await handle.chmod(0o600);
      await handle.writeFile(`${JSON.stringify(row)}\n`);
      await handle.sync();
    } finally { await handle.close(); }
  }
  function serialize<T>(operation: () => Promise<T>): Promise<T> {
    const result = queue.then(operation, operation);
    queue = result.then(() => undefined, () => undefined);
    return result;
  }

  return {
    async listProjects() { await load(); return [...projects.values()]; },
    createProject(input) {
      return serialize(async () => {
        await load();
        if ([...projects.values()].some((item) => item.path === input.path)) throw new Error("Project path already exists");
        const created = stamp();
        const value: Project = { id: randomUUID(), path: input.path, label: input.label ?? input.path.split(/[\\/]/).pop() ?? input.path, favorite: false, createdAt: created, updatedAt: created };
        await append({ op: "project", value }); projects.set(value.id, value); return value;
      });
    },
    updateProject(id, patch) {
      return serialize(async () => {
        await load();
        const current = projects.get(id);
        if (!current) return null;
        const value = { ...current, ...patch, updatedAt: stamp() };
        await append({ op: "project", value }); projects.set(id, value); return value;
      });
    },
    deleteProject(id) {
      return serialize(async () => {
        await load();
        if (!projects.has(id)) return false;
        await append({ op: "project-delete", id }); projects.delete(id); return true;
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
        await append({ op: "conversation", value }); conversations.set(value.id, value); return value;
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
        await append({ op: "conversation", value }); conversations.set(value.id, value); return value;
      });
    },
    updateConversation(id, patch) {
      return serialize(async () => {
        await load();
        const current = conversations.get(id);
        if (!current) return null;
        const value: Conversation = { ...current, ...patch, id: current.id, projectId: current.projectId, updatedAt: stamp() };
        await append({ op: "conversation", value }); conversations.set(id, value); return value;
      });
    },
    recordEvent(conversationId, type, payload, ts = stamp()) {
      return serialize(async () => {
        await load();
        if (!conversations.has(conversationId)) throw new Error("Conversation not found");
        const list = events.get(conversationId) ?? [];
        const value: StoreEvent = { id: randomUUID(), conversationId, seq: (list.at(-1)?.seq ?? 0) + 1, type, ts, payload };
        await append({ op: "event", value }); list.push(value); events.set(conversationId, list); return value as StoreEvent<typeof payload>;
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
        await append({ op: "command", value: command }); commands.set(idempotencyKey, command);
        return { first: true, command };
      });
    },
  };
}
