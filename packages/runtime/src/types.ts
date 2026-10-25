/**
 * Ports the runtime supervisor depends on.
 *
 * These are deliberately narrow, local, and structural: the supervisor does not
 * import the server's store or the adapter package, so it can be exercised
 * against fakes and so a change in either does not ripple through the lifecycle
 * logic. The server adapts its real store and services to these shapes at wiring
 * time.
 *
 * Three observations are tri-state (`true | false | "unknown"`), not boolean.
 * A failed observation is not a negative one: if we could not read the journal,
 * enumerate tmux, or ask the kernel for a lease, we do not know, and every rule
 * below that consumes them refuses to act on a guess. See `docs/architecture/session-lifecycle.md`.
 */
import type { Conversation, Ownership, RuntimeState } from "@caw/contracts";

/** The slice of the metadata store the supervisor writes through. */
export interface ConversationRuntimeStore {
  getConversation(id: string): Promise<Conversation | null>;
  listAllConversations(): Promise<Conversation[]>;
  updateConversation(id: string, patch: Partial<Conversation>): Promise<Conversation | null>;
  recordEvent(conversationId: string, type: string, payload: unknown): Promise<unknown>;
}

export type Tri = boolean | "unknown";

/** One published room, as the supervisor needs to see it. */
export interface RuntimeHost {
  instanceId: string;
  /**
   * Room generation as the host listing reported it; `null` means the listing did
   * not say. Never defaulted: the mint guard compares this against the link's
   * generation, so a fabricated value would make that comparison pass by
   * construction and hand out a link to a rotated room.
   */
  generation: number | null;
  /** Process id when the listing reported one; ordering hint only. */
  pid: number | null;
  sessionId: string;
  cwd: string;
  model: string | null;
  participants: number | null;
  /** `false` means confirmed not connected; `null` means the listing did not say. */
  relayConnected: boolean | null;
  /** `true` means confirmed awaiting an answer; `null` means the listing did not say. */
  inputRequired: boolean | null;
  busy?: boolean | null;
  access: "view" | "control";
}

/** A tmux session we own, keyed by id and qualified by server lifetime. */
export interface RuntimeTmuxSession {
  id: string;
  name: string;
  alive: boolean;
  panePid: number | null;
  serverIdentity: string;
}

/** Result of an enumeration or a by-id probe: "none" and "could not read" are different facts. */
export type ManagedTmuxRead =
  | { ok: true; sessions: RuntimeTmuxSession[] }
  | { ok: false; reason: string };

export type TmuxProbeRead =
  | { ok: true; session: RuntimeTmuxSession | null }
  | { ok: false; reason: string };

/** Everything observable about a conversation's runtime, gathered without changing anything. */
export interface Observations {
  /** The tmux session we launched, if we still have one recorded. */
  tmux: RuntimeTmuxSession | null;
  /** The host row matching this conversation's native session, if any. */
  host: RuntimeHost | null;
  /** Whether the native session's writer lease is currently held. */
  leaseLive: Tri;
  /** Whether the journal file we recorded still exists; unknown when it could not be read. */
  sessionPathExists: Tri;
  /** Why the journal probe failed, when it did. */
  sessionPathReason: string | null;
  /** A native session identity is known, so this conversation has history behind it. */
  hasNativeSession: boolean;
  /** We launched a process for this conversation at some point. */
  everLaunched: boolean;
  /** True while a stop has been requested and the process has not gone yet. */
  stopRequested: boolean;
  /** Set when the registry could not be read at all. */
  registryUnreadable: boolean;
  /** Recorded tmux identity is missing or not the current server lifetime. */
  tmuxOwnershipUnknown: boolean;
  /** Set when the managed tmux enumeration failed, so no ownership can be confirmed. */
  tmuxEnumerationFailed: boolean;
  /** Why the tmux enumeration failed, when it did. */
  tmuxEnumerationReason: string | null;
}

export interface RuntimeLaunchSpec {
  /**
   * The conversation this launch belongs to. Carried into the adapter so the
   * composition root can write a per-conversation agent config, and so logs and
   * tmux names stay traceable to exactly one conversation.
   */
  conversationId: string;
  /** tmux session display name; a label, never an identifier. */
  name: string;
  /** Working directory for the agent. */
  cwd: string;
  /** Overlay config file passed to the agent via --config. */
  configPath?: string;
  /** Model override, when the user picked one. */
  model?: string;
  /** Native session journal to resume instead of starting fresh. */
  resumeSessionPath?: string;
  /** Extra environment for the launched process. Never logged. */
  env?: Record<string, string>;
}

/** Everything the supervisor needs from the OMP/tmux adapter layer. */
export interface RuntimeAdapters {
  /** Live Collab hosts on this machine. Throws when the registry is unreadable. */
  listHosts(): Promise<RuntimeHost[]>;
  /**
   * Every session on the app's private tmux socket. Names are display labels,
   * so ownership and concurrency accounting must not filter by them.
   *
   * Throws when enumeration fails. An empty array confirms no sessions; catching
   * a failure into `[]` would let the concurrency cap read a wedged tmux as idle.
   */
  listManagedTmux(): Promise<RuntimeTmuxSession[]>;
  /**
   * One session by id. Wrapped so "the server answered and it is not there" and
   * "the probe could not run" stay distinct: only the former proves a stop, and
   * only the former means a reused `$N` is somebody else's process.
   */
  getTmux(id: string): Promise<TmuxProbeRead>;
  /** Current tmux socket path plus start time; null means unreachable, not process absence. */
  tmuxServerIdentity(): Promise<string | null>;
  launch(spec: RuntimeLaunchSpec): Promise<RuntimeTmuxSession>;
  /** Resolves only after the adapter proves this process is gone; rejects otherwise. */
  killTmux(id: string, expectedServerIdentity: string): Promise<void>;
  /** True when some process holds the native session's writer lease. */
  isSessionLive(sessionId: string): Promise<Tri>;
  /** Native session journal for a directory, newest first. */
  newestSessionFor(cwd: string): Promise<{ sessionId: string; path: string } | null>;
  /** Whether the file at this path still exists and looks like a session journal. */
  sessionPathExists(path: string): Promise<Tri>;
  /** Resolve a session id to its journal path anywhere on this machine. */
  findBySessionId(sessionId: string): Promise<string | null>;
}

/** A clock and a sleep, injected so timing logic is testable without real delays. */
export interface RuntimeClock {
  now(): number;
  sleep(ms: number): Promise<void>;
}

export const systemClock: RuntimeClock = {
  now: () => Date.now(),
  // `Promise.withResolvers` is a Node 22 builtin; this product targets Node 20.19
  // (the baseline recorded in docs/research/omp-compatibility.md), so the
  // executor form is required here. Verified: `typeof Promise.withResolvers`
  // is `undefined` on Node 20.19.5.
  sleep(ms) {
    return new Promise<void>((resolve) => {
      setTimeout(resolve, ms);
    });
  },
};

/** Why a transition happened, in the user's words. Persisted as `statusDetail`. */
export interface StateVerdict {
  state: RuntimeState;
  detail: string | null;
  ownership: Ownership;
}

/** Lifecycle errors carry a code the HTTP layer can map without string matching. */
export class RuntimeError extends Error {
  constructor(
    readonly code:
      | "conflict_owner"
      | "conflict_limit"
      | "agent_launch_failed"
      | "agent_not_running"
      | "capability_missing"
      | "registry_unreadable",
    message: string,
    readonly detail?: Record<string, unknown>,
  ) {
    super(message);
    this.name = "RuntimeError";
  }
}
