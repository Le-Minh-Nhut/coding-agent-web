/**
 * Wire contracts shared by the server, the web app and the tests.
 *
 * These types are the integration boundary: nothing crosses the HTTP/WebSocket
 * edge of this product without being shaped here first. Runtime validation
 * lives next to each request shape so a malformed body cannot reach the domain.
 */
import { z } from "zod";

/** Every API failure carries a stable code the UI can branch on without parsing prose. */
export const ERROR_CODES = [
  "unauthorized",
  "csrf",
  "bad_request",
  "not_found",
  "path_forbidden",
  "path_not_found",
  "not_a_directory",
  "conflict_owner",
  "conflict_limit",
  "capability_missing",
  "agent_launch_failed",
  "agent_not_running",
  "link_unavailable",
  "stale_generation",
  "already_exists",
  "internal",
] as const;
export type ErrorCode = (typeof ERROR_CODES)[number];

export interface ApiError {
  code: ErrorCode;
  message: string;
  /** Extra machine-readable context, e.g. which paths were rejected. */
  detail?: Record<string, unknown>;
}

export interface ApiFailure {
  ok: false;
  error: ApiError;
}

export interface ApiSuccess<T> {
  ok: true;
  data: T;
}

export type ApiResult<T> = ApiSuccess<T> | ApiFailure;

export function ok<T>(data: T): ApiSuccess<T> {
  return { ok: true, data };
}

export function fail(code: ErrorCode, message: string, detail?: Record<string, unknown>): ApiFailure {
  return detail ? { ok: false, error: { code, message, detail } } : { ok: false, error: { code, message } };
}

// ─────────────────────────────────────────────────────────────────────────────
// Runtime status vocabulary
//
// Reported states must be observable facts, never hopes. `busy=false` on a
// collab host means "no turn in flight right now"; OMP itself warns it does not
// mean the work is settled, so the vocabulary separates the two.
// ─────────────────────────────────────────────────────────────────────────────

export const RUNTIME_STATES = [
  /** Launched, registry entry not yet visible. */
  "starting",
  /** Registry entry visible and a turn is in flight. */
  "running",
  /** Registry entry visible, no turn in flight. */
  "idle",
  /** The agent is blocked on a host-side question. */
  "awaiting_input",
  /** A stop was requested and we are waiting for the process to go away. */
  "stopping",
  /** Was started by us, is not running now, and its native session still exists. */
  "stopped",
  /** Was started by us, the process is gone, and no native session file is readable. */
  "error",
  /** Registry unreachable or unreadable: we cannot tell. Never rendered as idle. */
  "unknown",
] as const;
export type RuntimeState = (typeof RUNTIME_STATES)[number];

/** Where a conversation's process came from, which decides what "restart" may do. */
export const OWNERSHIP = ["managed", "external"] as const;
export type Ownership = (typeof OWNERSHIP)[number];
// ─────────────────────────────────────────────────────────────────────────────
// Projects
// ─────────────────────────────────────────────────────────────────────────────

export interface Project {
  id: string;
  /** Absolute, canonical directory path. */
  path: string;
  /** Display label; renaming never touches the filesystem. */
  label: string;
  favorite: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface ProjectWithStats extends Project {
  /** Conversations known for this project path, newest activity first count. */
  conversationCount: number;
  lastActivityAt: string | null;
}

export interface DirectoryEntry {
  name: string;
  path: string;
  /** False for symlinks that do not resolve to a directory inside an allowed root. */
  isDirectory: boolean;
  /** False when the path escapes allowed roots after canonicalization. */
  allowed: boolean;
  hasProject: boolean;
}

export interface DirectoryListing {
  /** Canonical absolute path of the directory that was listed. */
  path: string;
  /** Present when the listing is a relative step; used to render breadcrumbs. */
  parent: string | null;
  roots: string[];
  entries: DirectoryEntry[];
  /** Whether more directory entries remain after this response. */
  hasMore: boolean;
  /** Opaque cursor for the next page; null when this response is final. */
  nextCursor: string | null;
}

// ─────────────────────────────────────────────────────────────────────────────
// Conversations
// ─────────────────────────────────────────────────────────────────────────────

export interface Conversation {
  id: string;
  projectId: string;
  /** Native OMP session id (UUIDv7) when known. */
  nativeSessionId: string | null;
  /** Absolute path of the native session journal when known. */
  nativeSessionPath: string | null;
  title: string;
  /** Model requested for next process launch; optional on older persisted records. */
  modelPreference?: string | null;
  /** Model actually reported by the runtime registry, when known. */
  model: string | null;
  ownership: Ownership;
  state: RuntimeState;
  /** tmux session id (never a name) when this app launched it. */
  tmuxSessionId: string | null;
  /** tmux session name, for display and manual attach only. */
  tmuxSessionName: string | null;
  /**
   * Identity of the tmux **server** that owns this conversation's process,
   * recorded at launch.
   *
   * A tmux session id (`$N`) is unique only within one server lifetime: kill the
   * server and the next session is `$0` again. Since we address processes by
   * recorded id, every adopt and stop decision must first confirm the owning
   * server is still the same one — otherwise a recorded id can point at a
   * stranger's session. Null means the provenance is unknown (never launched by
   * this app, or launched before this field existed), and such a conversation is
   * treated as unverifiable rather than trusted.
   */
  tmuxServerIdentity: string | null;
  /**
   * Process id of the pane that runs this conversation's agent, recorded at launch.
   *
   * Needed to answer one question the tmux session id cannot: "did *our* process
   * exit?" A session id is only unique within one server lifetime, and a server pid
   * proves nothing about a pane — a server can die while its pane's process survives,
   * and a session can vanish for reasons that say nothing about the process that
   * was in it. Liveness is therefore corroborated on this pid (existence + signal
   * semantics), and `null` means the provenance is unknown, so a stop is refused
   * rather than assumed.
   */
  tmuxPanePid: number | null;
  /** Registry instance id while a host is published. */
  hostInstanceId: string | null;
  /** Room generation observed when the last link was minted. */
  hostGeneration: number | null;
  /**
   * Counter of this conversation's lifecycles. It advances every time a launch
   * records its process and every time a stop or restart transitions the row.
   *
   * An observation of the machine (a refresh, a delete gate) is evidence only
   * about *the life it observed*, so it carries the epoch it read. The write it
   * produces commits only while the row is still at that epoch; otherwise it is
   * a stale result about a process that is already gone, and applying it would
   * overwrite the identity, host or state of a newer life — or let a delete drop
   * the only pointer to a process that is still running. Milliseconds cannot do
   * this: two transitions can land inside one tick.
   *
   * Optional for rows persisted before this field existed; absent reads as `0`.
   */
  lifecycleEpoch?: number;
  /**
   * Monotonic counter of the row's applied changes, bumped by the store on every
   * write that really changes the row.
   *
   * `lifecycleEpoch` answers "is this the same process generation?" — it moves
   * only when a lifecycle field does. An observation can also be stale while the
   * generation is unchanged: two routine refreshes of the same live process can
   * commit out of order, and the older one silently overwrites the newer one's
   * model or status. This counter gives such a commit an ordering fact to present
   * without conflating observation revision with process replacement: the store
   * bumps it on every applied change, an observer reads it before probing, and
   * `updateConversationIfCurrent` with `expectedObservationSeq` refuses a commit
   * whose revision is already behind. `lifecycleEpoch` stays the process-generation
   * authority.
   *
   * Optional for rows persisted before this field existed; absent reads as `0`.
   */
  observationSeq?: number;
  createdAt: string;
  updatedAt: string;
  lastActivityAt: string | null;
  /** Why the state is what it is, in the user's words. */
  statusDetail: string | null;
}

/**
 * The lifecycle counter of a row, defaulting to `0` for records persisted before
 * the field existed. Every comparison of an observed epoch against a stored one
 * goes through this: reading `lifecycleEpoch` directly would compare `undefined`
 * with `undefined` on a legacy row and miss that a launch's `1` is a change.
 */
export const epochOf = (conversation: Pick<Conversation, "lifecycleEpoch">): number => conversation.lifecycleEpoch ?? 0;

/**
 * The applied-change counter of a row, defaulting to `0` for records persisted
 * before the field existed. Mirrors `epochOf`: an observer captures this before
 * probing, and commits through `updateConversationIfCurrent` with
 * `expectedObservationSeq` so an out-of-order observation of the *same* life is
 * refused instead of overwriting a newer one.
 */
export const observationSeqOf = (conversation: Pick<Conversation, "observationSeq">): number => conversation.observationSeq ?? 0;

export interface NativeSessionSummary {
  sessionId: string;
  path: string;
  cwd: string;
  title: string | null;
  updatedAt: string | null;
  /**
   * Whether a process currently holds the session's writer lease.
   *
   * `true` = a writer exists; `false` = we confirmed nobody holds it; `"unknown"`
   * = the observation itself failed (the lease table could not be read, or the id
   * cannot be turned into a lease name safely). A failed observation is not a
   * negative one: collapsing `"unknown"` into `false` would let the UI offer to
   * start a second writer for a session that may already have one, which forks
   * the conversation's history.
   */
  live: boolean | "unknown";
  /** True only when a matching host row confirms relayConnected === true; failed registry reads fail the sessions listing. */
  hasCollabHost: boolean;
  /** True when a known conversation already owns it. */
  tracked: boolean;
}

// ─────────────────────────────────────────────────────────────────────────────
// Runtime facts as reported by the server
// ─────────────────────────────────────────────────────────────────────────────

export interface RuntimeSnapshot {
  /** False when tmux or the OMP binary could not be found. */
  capabilities: Capabilities;
  /**
   * How many agents are running, or `null` when that could not be determined.
   *
   * `null` is not zero. Enumerating running agents reads tmux; when that read
   * fails, reporting `0` would claim the machine is idle and invite the UI to
   * start another agent past the configured cap. Callers must render `null` as
   * unknown rather than as an empty machine.
   */
  activeCount: number | null;
  /** Why the count is unknown, in the user's words. Null when the count is known. */
  activeCountReason: string | null;
  maxActive: number;
  conversations: Array<Pick<Conversation, "id" | "state" | "ownership" | "updatedAt" | "statusDetail">>;
}

export interface Capabilities {
  omp: { available: boolean; version: string | null; path: string | null };
  tmux: { available: boolean; version: string | null };
  relay: { configured: boolean; origin: string | null; reachable: boolean | null };
}

// ─────────────────────────────────────────────────────────────────────────────
// Attach instructions
// ─────────────────────────────────────────────────────────────────────────────

export interface AttachInstructions {
  conversationId: string;
  /** False when the conversation has no managed runtime to attach to. */
  available: boolean;
  /** Copy-pasteable command, already quoted safely. */
  command: string | null;
  tmuxSessionName: string | null;
  reason: string | null;
}

// ─────────────────────────────────────────────────────────────────────────────
// Live session link
// ─────────────────────────────────────────────────────────────────────────────

/**
 * A room link, handed to the browser at most once.
 *
 * This is a bearer credential: possession of it grants the holder the ability to
 * read the session and, at `full` access, to prompt the agent. It is never
 * logged, never persisted, and served with `Cache-Control: no-store`. The
 * vocabulary here is the UI's (`full`), while OMP's registry calls the same
 * access level `control`; the server translates.
 */
export interface CollabLinkResponse {
  /** Full room URL including the secret fragment. Treat as a secret. */
  url: string;
  access: "full" | "view";
  instanceId: string;
  generation: number;
}

export interface ConversationEvent<T = unknown> {
  seq: number;
  type: string;
  ts: string;
  payload: T;
}

export interface ConversationEventsResponse {
  events: ConversationEvent[];
  nextAfter: number | null;
}

// ─────────────────────────────────────────────────────────────────────────────
// Request validation
// ─────────────────────────────────────────────────────────────────────────────

export const loginSchema = z.object({
  password: z.string().min(1).max(1024),
}).strict();

export const createProjectSchema = z.object({
  path: z.string().min(1).max(4096),
  label: z.string().min(1).max(120).optional(),
}).strict();

export const updateProjectSchema = z.object({
  label: z.string().min(1).max(120).optional(),
  favorite: z.boolean().optional(),
}).strict();

export const browseQuerySchema = z.object({
  path: z.string().min(1).max(4096).optional(),
  limit: z.coerce.number().int().min(1).max(500).optional(),
  cursor: z.string().min(1).max(2048).optional(),
}).strict();

export const createDirectorySchema = z.object({
  path: z.string().min(1).max(4096),
  name: z.string().trim()
    .min(1, "Directory name must not be empty")
    .max(64, "Directory name must be at most 64 characters")
    .refine((name) => name !== "." && name !== ".." && !/[\/\\\u0000-\u001f\u007f]/u.test(name), "Directory name must not contain separators or control characters"),
}).strict();

export type CreateDirectoryRequest = z.infer<typeof createDirectorySchema>;


export const createConversationSchema = z.object({
  projectId: z.string().min(1).max(64),
  title: z.string().min(1).max(200).optional(),
  /** Native session to resume instead of starting fresh. */
  resumeSessionId: z.string().min(1).max(128).optional(),
}).strict();

export const conversationModelSchema = z.object({
  model: z.string().trim().min(1).max(128),
}).strict();

/**
 * Actions a client may request on a conversation.
 *
 * `strict()` is deliberate: an unrecognised field is a caller that believes it is
 * saying something we are not listening to. Silently dropping `resumeSessionId`
 * here, for example, would look to the caller like a resume that had been accepted
 * while the agent actually launched fresh — so the request is refused instead.
 */
export const conversationActionSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("stop") }).strict(),
  z.object({ action: z.literal("restart") }).strict(),
]);

/** Idempotency key: retries of the same user intent must not queue twice. */
export const commandSchema = z.object({
  kind: z.enum(["prompt", "abort", "approval"]),
  idempotencyKey: z.string().min(8).max(128),
  payload: z.record(z.string(), z.unknown()),
}).strict();

export type LoginRequest = z.infer<typeof loginSchema>;
export type CreateProjectRequest = z.infer<typeof createProjectSchema>;
export type CreateConversationRequest = z.infer<typeof createConversationSchema>;
export type ConversationActionRequest = z.infer<typeof conversationActionSchema>;
export type CommandRequest = z.infer<typeof commandSchema>;

export const listEventsQuerySchema = z.object({
  after: z.coerce.number().int().nonnegative().optional(),
  limit: z.coerce
    .number()
    .int()
    .min(1)
    .default(100)
    .transform((n) => Math.min(n, 500)),
}).strict();
export type ListEventsQuery = z.infer<typeof listEventsQuerySchema>;
