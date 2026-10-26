import type { Conversation } from "@caw/contracts";
import { evaluateState, hostState, launchVerdict } from "./state";
import type {
  ConversationRuntimeStore,
  ManagedTmuxRead,
  Observations,
  RuntimeAdapters,
  RuntimeClock,
  RuntimeHost,
  RuntimeLaunchSpec,
  RuntimeTmuxSession,
  StateVerdict,
  Tri,
} from "./types";
import { RuntimeError as RuntimeFailure, systemClock } from "./types";

/**
 * The only code allowed to start or stop a managed agent process.
 *
 * Two rules it exists to enforce, both from observed OMP behaviour:
 *
 *  1. Before launching, verify nothing already writes the session. OMP *forks* a
 *     session another process holds, quietly splitting the history, so the
 *     refusal has to happen before a process exists.
 *  2. Only ever kill tmux sessions by the id we recorded, never by name.
 */
export interface SupervisorOptions {
  store: ConversationRuntimeStore;
  adapters: RuntimeAdapters;
  clock?: RuntimeClock;
  /** How many agents may run at once. */
  maxActive: number;
  /** How long to wait for a launched agent to publish itself to the registry. */
  publishTimeoutMs?: number;
  /** Poll interval while waiting for a registry row. */
  publishPollMs?: number;
  /** How long a stop may take before we report that the process has not exited. */
  stopTimeoutMs?: number;
}

export interface ReconcileReport {
  /** Conversations with a live managed process we adopted. */
  adopted: number;
  /** Conversations whose room belongs to a process we do not manage. */
  external: number;
  /** Conversations with no process running and a readable history. */
  stopped: number;
  /** Conversations whose state could not be determined. */
  unknown: number;
  /** Adopted conversations that also have a live room. */
  registered: number;
}
export interface Supervisor {
  /** Recompute one conversation's state from live facts and persist it. */
  refresh(conversationId: string): Promise<Conversation | null>;
  /** Start a managed agent, refusing if anything already writes the session. */
  start(conversationId: string, spec: RuntimeLaunchSpec): Promise<Conversation>;
  /** Stop a managed agent by recorded tmux id. Refuses for external processes. */
  stop(conversationId: string, timeoutMs?: number): Promise<Conversation>;
  /** Rebuild our view from the machine after a restart. Observes, never infers. */
  reconcile(): Promise<ReconcileReport>;
  /** How many agents are confirmed running, and whether that could be determined. */
  activeCount(): Promise<{ count: number; known: boolean; reason: string | null }>;
  /** The observations behind a state verdict, for diagnostics and tests. */
  observe(conversationId: string): Promise<Observations | null>;
}

const DEFAULT_PUBLISH_TIMEOUT_MS = 45_000;
const DEFAULT_PUBLISH_POLL_MS = 1_000;
const DEFAULT_STOP_TIMEOUT_MS = 15_000;

/**
 * Serializes the check-and-launch critical section.
 *
 * This closes the check-then-act race the architecture audit reproduced: two
 * requests could each observe "no writer" and then each start one, and OMP forks
 * a session rather than refusing, so both would have written the conversation.
 *
 * Ceiling worth naming: this guards one backend process. A second backend on the
 * same machine would need a real cross-process lease; the tmux server identity
 * plus the native-session lease are what protect against a *foreign* writer, and
 * they are checked inside the section.
 */
let launchChain = Promise.resolve();
// A live managed session without a matching row blocks launches, including after restart; names cannot safely recover ownership.

const launchReservationsByStore = new WeakMap<ConversationRuntimeStore, Set<string>>();

/** `ESRCH` proves exit; PID reuse can mistake an unrelated process for a live pane and conservatively block launches. */
function processAlive(pid: number | null): boolean | "unknown" {
  if (pid === null || !Number.isSafeInteger(pid) || pid <= 0) return "unknown";
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ESRCH" ? false : "unknown";
  }
}

// ponytail: an untracked session on an unlinked socket has no recorded pane PID to probe; durable server inventory is needed to cover that cap gap.
function unobservableManagedProcesses(
  rows: Conversation[],
  sessions: RuntimeTmuxSession[],
): Array<{ row: Conversation; liveness: boolean | "unknown" }> {
  return rows.flatMap((row) => {
    if (row.ownership !== "managed" || !row.tmuxSessionId) return [];
    if (!row.tmuxServerIdentity) return [{ row, liveness: "unknown" as const }];
    if (sessions.some((session) =>
      session.id === row.tmuxSessionId && session.serverIdentity === row.tmuxServerIdentity,
    )) return [];
    return [{ row, liveness: processAlive(row.tmuxPanePid) }];
  });
}

function unseenProcessReason(check: { row: Conversation; liveness: boolean | "unknown" }): string {
  const { row, liveness } = check;
  const process = row.tmuxPanePid === null ? `pane process for tmux session ${row.tmuxSessionId}` : `pane process ${row.tmuxPanePid}`;
  return liveness === true
    ? `Recorded ${process} is still alive, but its tmux session is not visible on the current server.`
    : `Recorded ${process} cannot be verified because its tmux session is not visible on the current server.`;
}

function untrackedLiveSessions(rows: Conversation[], sessions: RuntimeTmuxSession[]): RuntimeTmuxSession[] {
  return sessions.filter((session) => session.alive && !rows.some((row) =>
    row.ownership === "managed" && row.tmuxSessionId === session.id && row.tmuxServerIdentity === session.serverIdentity,
  ));
}

function rowOwnsLiveSession(row: Conversation, sessions: RuntimeTmuxSession[]): boolean {
  return row.ownership === "managed" && Boolean(row.tmuxSessionId && sessions.some((session) =>
    session.alive && session.id === row.tmuxSessionId && session.serverIdentity === row.tmuxServerIdentity,
  ));
}







function reservationsFor(store: ConversationRuntimeStore): Set<string> {
  let reservations = launchReservationsByStore.get(store);
  if (!reservations) {
    reservations = new Set();
    launchReservationsByStore.set(store, reservations);
  }
  return reservations;
}

async function withLaunchLock<T>(operation: () => Promise<T>): Promise<T> {
  const previous = launchChain;
  let release!: () => void;
  launchChain = new Promise<void>((resolve) => { release = resolve; });
  await previous;
  try {
    return await operation();
  } finally {
    release();
  }
}

/**
 * The identities this launch will write, so a second request for the same
 * underlying session collides with it whatever IDs the two conversations happen
 * to store. Every key includes the conversation id: two rows can point at one
 * journal without agreeing on its id, and those two must not launch twice.
 */
function reserveKeys(conversation: Conversation, spec: RuntimeLaunchSpec): string[] {
  return [
    `conversation:${conversation.id}`,
    conversation.nativeSessionId ? `session:${conversation.nativeSessionId}` : null,
    spec.resumeSessionPath ? `journal:${spec.resumeSessionPath}` : null,
  ].filter((key): key is string => key !== null);
}


export function createSupervisor(options: SupervisorOptions): Supervisor {
  const clock = options.clock ?? systemClock;
  const publishTimeoutMs = options.publishTimeoutMs ?? DEFAULT_PUBLISH_TIMEOUT_MS;
  const publishPollMs = options.publishPollMs ?? DEFAULT_PUBLISH_POLL_MS;
  const stopTimeoutMs = options.stopTimeoutMs ?? DEFAULT_STOP_TIMEOUT_MS;
  const launchReservations = reservationsFor(options.store);
  function untrackedReservationCount(
    conversations: Conversation[],
    managedIds: Set<string>,
    excludedConversationId?: string,
  ): number {
    return [...launchReservations].filter((key) => {
      if (!key.startsWith("conversation:")) return false;
      const conversationId = key.slice("conversation:".length);
      if (conversationId === excludedConversationId) return false;
      const row = conversations.find((candidate) => candidate.id === conversationId);
      return !row?.tmuxSessionId || !managedIds.has(row.tmuxSessionId);
    }).length;
  }


  async function readManagedTmux(): Promise<ManagedTmuxRead> {
    try {
      return { ok: true, sessions: await options.adapters.listManagedTmux() };
    } catch (error) {
      return { ok: false, reason: error instanceof Error ? error.message : String(error) };
    }
  }

  /** Read everything we can about a conversation without changing anything. */
  async function observationsFor(conversation: Conversation): Promise<Observations> {
    // A journal probe that throws is "we could not look", never "it is gone".
    let sessionPathReason: string | null = null;
    const sessionPathProbe: Promise<Tri> = conversation.nativeSessionPath
      ? options.adapters.sessionPathExists(conversation.nativeSessionPath).then(
          (value) => value,
          (error: unknown) => {
            sessionPathReason = error instanceof Error ? error.message : String(error);
            return "unknown" as const;
          },
        )
      : conversation.nativeSessionId
        ? options.adapters.findBySessionId(conversation.nativeSessionId).then(
            (found) => Boolean(found),
            (error: unknown) => {
              sessionPathReason = `the journal could not be located (${error instanceof Error ? error.message : String(error)})`;
              return "unknown" as const;
            },
          )
        : Promise.resolve(false as Tri);

    const [managedResult, hosts, leaseLive, sessionPathExists] = await Promise.all([
      readManagedTmux(),
      options.adapters.listHosts().then(
        (rows) => ({ ok: true as const, rows }),
        () => ({ ok: false as const, rows: [] as RuntimeHost[] }),
      ),
      conversation.nativeSessionId
        ? options.adapters.isSessionLive(conversation.nativeSessionId).catch(() => "unknown" as const)
        : Promise.resolve(false as Tri),
      sessionPathProbe,
    ]);

    const unseen = managedResult.ok
      ? unobservableManagedProcesses([conversation], managedResult.sessions)[0]
      : undefined;
    return {
      tmux: findManagedTmux(conversation, managedResult.ok ? managedResult.sessions : []),
      host: conversation.nativeSessionId ? hosts.rows.find((row) => row.sessionId === conversation.nativeSessionId) ?? null : null,
      leaseLive,
      sessionPathExists,
      sessionPathReason,
      tmuxEnumerationFailed: !managedResult.ok,
      tmuxEnumerationReason: managedResult.ok
        ? null
        : `The tmux session list could not be read (${managedResult.reason}), so the live state is unknown.`,
      hasNativeSession: Boolean(conversation.nativeSessionId ?? conversation.nativeSessionPath),
      everLaunched: Boolean(conversation.tmuxSessionId),
      stopRequested: conversation.state === "stopping",
      registryUnreadable: !hosts.ok,
      tmuxOwnershipUnknown: Boolean(unseen && unseen.liveness !== false),
    };
  }

  /**
   * `$N` plus server lifetime identifies a session; its mutable display name
   * cannot establish ownership, including for legacy records without an id.
   */
  function findManagedTmux(conversation: Conversation, managed: RuntimeTmuxSession[]): RuntimeTmuxSession | null {
    if (!conversation.tmuxSessionId || !conversation.tmuxServerIdentity) return null;
    return managed.find((session) => session.id === conversation.tmuxSessionId && session.serverIdentity === conversation.tmuxServerIdentity) ?? null;
  }

  async function observe(conversationId: string): Promise<Observations | null> {
    const conversation = await options.store.getConversation(conversationId);
    return conversation ? observationsFor(conversation) : null;
  }

  async function refresh(conversationId: string): Promise<Conversation | null> {
    const conversation = await options.store.getConversation(conversationId);
    if (!conversation) return null;
    const verdict: StateVerdict = evaluateState(await observationsFor(conversation));

    // Only write when something changed: the store is append-only, and a log that
    // grows on every poll is a log nobody can read.
    const unchanged =
      conversation.state === verdict.state &&
      conversation.ownership === verdict.ownership &&
      conversation.statusDetail === verdict.detail;
    if (unchanged) return conversation;

    return options.store.updateConversation(conversationId, {
      state: verdict.state,
      ownership: verdict.ownership,
      statusDetail: verdict.detail,
    });
  }

  /** Record the runtime facts we can only learn from the machine. */
  async function adopt(conversation: Conversation, managed: RuntimeTmuxSession[], hosts: RuntimeHost[]): Promise<Conversation> {
    const patch: Partial<Conversation> = {};

    if (conversation.nativeSessionPath && !conversation.nativeSessionId) {
      const header = await options.adapters.findBySessionId(conversation.nativeSessionPath);
      if (header) patch.nativeSessionId = header;
    }

    const tmux = findManagedTmux(conversation, managed);
    if (tmux && tmux.id !== conversation.tmuxSessionId) {
      patch.tmuxSessionId = tmux.id;
      patch.tmuxSessionName = tmux.name;
    }

    const host = conversation.nativeSessionId
      ? hosts.find((row) => row.sessionId === conversation.nativeSessionId)
      : undefined;
    if (host) {
      if (host.instanceId !== conversation.hostInstanceId) patch.hostInstanceId = host.instanceId;
      // A listing that omits the generation is not evidence of a rotation, so it
      // must not overwrite one we recorded; `null` here means "the CLI did not say".
      if (host.generation !== null && host.generation !== conversation.hostGeneration) {
        patch.hostGeneration = host.generation;
      }
      if (host.model && host.model !== conversation.model) patch.model = host.model;
      if (host.sessionId !== conversation.nativeSessionId) patch.nativeSessionId = host.sessionId;
    }

    if (Object.keys(patch).length === 0) return conversation;
    return (await options.store.updateConversation(conversation.id, patch)) ?? conversation;
  }

  /** Count visible sessions and recorded pane PIDs; state labels are not evidence. */
  async function activeCount(): Promise<{ count: number; known: boolean; reason: string | null }> {
    const all = await options.store.listAllConversations();
    const managedResult = await readManagedTmux();
    if (!managedResult.ok) {
      return { count: 0, known: false, reason: `The running agents could not be enumerated (${managedResult.reason}), so the count is unknown.` };
    }
    const sessions = managedResult.sessions;
    const unseen = unobservableManagedProcesses(all, sessions);
    const managedIds = new Set(sessions.filter((session) => session.alive).map((session) => session.id));
    const liveSessionCount = sessions.filter((session) => session.alive).length;
    const trackedLiveCount = all.filter((conversation) => rowOwnsLiveSession(conversation, sessions)).length;
    const hiddenLiveCount = unseen.filter((check) => check.liveness === true).length;
    const count = Math.max(
      liveSessionCount,
      trackedLiveCount + hiddenLiveCount + untrackedReservationCount(all, managedIds),
    );
    if (unseen.some((check) => check.liveness !== false)) {
      return {
        count,
        known: false,
        reason: `${unseen.filter((check) => check.liveness !== false).map(unseenProcessReason).join(" ")} Untracked sessions on that unreachable server cannot be enumerated.`,
      };
    }
    return { count, known: true, reason: null };
  }
  async function start(conversationId: string, spec: RuntimeLaunchSpec): Promise<Conversation> {
    const initial = await options.store.getConversation(conversationId);
    if (!initial) throw new RuntimeFailure("agent_not_running", `Unknown conversation ${conversationId}`);

    let heldKeys: string[] = [];
    let ownershipRetained = false;
    try {
      const { launched, preexistingInstances } = await withLaunchLock(async () => {
        const conversation = await options.store.getConversation(conversationId);
        if (!conversation) throw new RuntimeFailure("agent_not_running", `Unknown conversation ${conversationId}`);
        // Reserve by the identity of what will actually be written. A recorded
        // native id is one name for a journal, but a conversation can hold the
        // same journal without the id (resume by path, first launch of a fresh
        // conversation, a row whose id has not been resolved yet). Keying those
        // separately let two requests reserve one session twice and start two
        // writers, so the conversation id is added alongside every key, and the
        // resume path — the file OMP will open — is a key in its own right.
        const keys = reserveKeys(conversation, spec);
        const held = keys.find((candidate) => launchReservations.has(candidate));
        if (held !== undefined) {
          await options.store.recordEvent(conversationId, "launch.refused", { code: "conflict_owner", key: held });
          throw new RuntimeFailure("conflict_owner", "Another launch for this native session is already in progress.");
        }
        for (const candidate of keys) launchReservations.add(candidate);
        heldKeys = keys;
        try {
          const hosts = await options.adapters.listHosts().catch(() => {
            throw new RuntimeFailure("registry_unreadable", "The OMP Collab registry could not be read.");
          });
          const managedResult = await readManagedTmux();
          const preexistingInstances = new Set(hosts.map((host) => host.instanceId));
          // Count running agents from what the machine shows *now*, not from what
          // the store last recorded. A stored state goes stale the moment a process
          // exits (crash, manual kill, machine reboot), and since nothing polls in
          // the background, trusting it would leave slots permanently occupied and
          // refuse every later launch with `conflict_limit`. The stored state is
          // still used for conversations whose process is confirmed alive here.
          //
          // This probe belongs *inside* the critical section. Run before the lock
          // it can be answered by the previous holder and reused by the next.
          const leaseLive = conversation.nativeSessionId
            ? await options.adapters.isSessionLive(conversation.nativeSessionId).catch(() => "unknown" as const)
            : false;
          const managed = managedResult.ok ? managedResult.sessions : [];
          const conversations = await options.store.listAllConversations();
          const untracked = untrackedLiveSessions(conversations, managed);
          if (untracked.length) {
            await options.store.recordEvent(conversationId, "launch.refused", {
              code: "conflict_owner",
              untrackedTmuxSessionIds: untracked.map((session) => session.id),
            });
            throw new RuntimeFailure(
              "conflict_owner",
              "A live managed tmux session has no recorded owner, so new agents are blocked until it is accounted for.",
            );
          }
          const unseen = unobservableManagedProcesses(conversations, managed);
          const unsafeUnseen = unseen.filter((check) => check.liveness !== false);
          if (unsafeUnseen.length) {
            const reason = unsafeUnseen.map(unseenProcessReason).join(" ");
            await options.store.recordEvent(conversationId, "launch.refused", {
              code: "conflict_owner",
              unobservableTmuxSessionIds: unsafeUnseen.map((check) => check.row.tmuxSessionId),
              reason,
            });
            throw new RuntimeFailure("conflict_owner", reason);
          }
          const hiddenLiveRows = new Set(unseen.filter((check) => check.liveness === true).map((check) => check.row.id));
          const liveOwners = conversations.filter(
            (row) => row.id !== conversationId && (rowOwnsLiveSession(row, managed) || hiddenLiveRows.has(row.id)),
          );
          // native id, another by the journal path it will resume. Both are the
          // same writer, so either identity matching a live owner's is a refusal.
          const aliasesLiveOwner = liveOwners.some(
            (row) =>
              (Boolean(conversation.nativeSessionId) && row.nativeSessionId === conversation.nativeSessionId) ||
              (Boolean(conversation.nativeSessionPath) && row.nativeSessionPath === conversation.nativeSessionPath) ||
              (Boolean(spec.resumeSessionPath) && row.nativeSessionPath === spec.resumeSessionPath),
          );
          if (aliasesLiveOwner) {
            await options.store.recordEvent(conversationId, "launch.refused", { code: "conflict_owner" });
            throw new RuntimeFailure("conflict_owner", "Another conversation already owns an active writer for this native session.");
          }
          const managedIds = new Set(managed.filter((session) => session.alive).map((session) => session.id));
          const count = Math.max(
            managed.filter((session) => session.alive).length,
            liveOwners.length + untrackedReservationCount(conversations, managedIds, conversationId),
          );
          const liveTmux = findManagedTmux(conversation, managed);
          const host = conversation.nativeSessionId
            ? hosts.find((row) => row.sessionId === conversation.nativeSessionId) ?? null
            : null;
          const verdict = launchVerdict({
            liveTmux: liveTmux?.alive ? liveTmux : null,
            host,
            leaseLive,
            activeCount: count,
            activeCountUnknown: !managedResult.ok,
            activeCountReason: managedResult.ok
              ? null
              : `The running agents could not be enumerated (${managedResult.reason}), so the limit of ${options.maxActive} cannot be enforced.`,
            maxActive: options.maxActive,
          });
          if (!verdict.allowed) {
            await options.store.recordEvent(conversationId, "launch.refused", { code: verdict.code, message: verdict.message });
            throw new RuntimeFailure(verdict.code, verdict.message);
          }

          const launched = await options.adapters.launch({ ...spec, conversationId });
          try {
            const recorded = await options.store.updateConversation(conversationId, {
              tmuxSessionId: launched.id,
              tmuxSessionName: launched.name,
              tmuxServerIdentity: launched.serverIdentity,
              tmuxPanePid: launched.panePid,
              nativeSessionPath: spec.resumeSessionPath ?? conversation.nativeSessionPath,
              state: "starting",
              ownership: "managed",
              statusDetail: "Starting…",
            });
            if (!recorded) throw new RuntimeFailure("agent_not_running", "The conversation disappeared before its launched agent could be recorded.");
          } catch (error) {
            // We created a process we cannot record. Leaving it running would be
            // an untracked OMP writer: invisible here, holding a slot nobody can
            // name, and able to fork the session if the user retries. So we undo
            // the launch we just made — by the id and server identity we were
            // given, under the adapter's identity-guarded kill — and only then
            // release the reservation. If even that fails, the reservation stays
            // held and the failure is recorded, because a retry would otherwise
            // create a second writer for a session something is already writing.
            let undone = false;
            try {
              await options.adapters.killTmux(launched.id, launched.serverIdentity);
              if (processAlive(launched.panePid) !== false) throw new Error("The launched pane process is still alive or cannot be confirmed gone.");
              undone = true;
            } catch {
              undone = false;
            }
            await options.store
              .updateConversation(conversationId, {
                tmuxSessionId: launched.id,
                tmuxSessionName: launched.name,
                tmuxServerIdentity: launched.serverIdentity,
                tmuxPanePid: launched.panePid,
                nativeSessionPath: spec.resumeSessionPath ?? conversation.nativeSessionPath,
                state: undone ? "stopped" : "unknown",
                ownership: "managed",
                statusDetail: undone
                  ? "The agent could not be recorded, so the process that was started has been stopped."
                  : `The agent process was launched (tmux ${launched.id} on ${launched.serverIdentity}) but could not be recorded and could not be stopped. It may still be running, so this conversation will not be started again until it is dealt with.`,
              })
              .catch(() => null);
            await options.store
              .recordEvent(conversationId, undone ? "agent.launch_discarded" : "agent.launch_unrecorded", {
                tmuxSessionId: launched.id,
                tmuxSessionName: launched.name,
                tmuxServerIdentity: launched.serverIdentity,
                error: error instanceof Error ? error.message : String(error),
              })
              .catch(() => null);
            if (!undone) ownershipRetained = true;
            throw error;
          }
          await options.store.recordEvent(conversationId, "agent.launched", {
            tmuxSessionId: launched.id,
            tmuxSessionName: launched.name,
          });
          return { launched, preexistingInstances };
        } catch (error) {
          throw error;
        }
      });
      return await waitForPublish(conversationId, launched, spec, preexistingInstances);
    } finally {
      // Released unless ownership was deliberately retained for a process that
      // really exists: then the reservation is what stops a retry forking the
      // session that process is already writing.
      if (!ownershipRetained) {
        for (const candidate of heldKeys) launchReservations.delete(candidate);
      }
    }
  }

  /**
   * Wait for the agent we just launched to publish a room, then record it.
   *
   * Adoption is by process lineage: accept only a new host whose PID is a
   * descendant of the exact tmux pane launched for this conversation. Matching
   * by working directory or PID order could point the conversation at a stranger's
   * session when multiple agents share a project tree.
   *
   * A timeout is not a failure: the process may be alive but not hosting. We
   * report exactly that rather than pretending the launch failed.
   */
  async function waitForPublish(
    conversationId: string,
    launched: RuntimeTmuxSession,
    spec: RuntimeLaunchSpec,
    preexistingInstances: ReadonlySet<string>,
  ): Promise<Conversation> {
    const deadline = clock.now() + publishTimeoutMs;
    let registryReadable = true;
    let identityUnverified = false;

    while (clock.now() < deadline) {
      await clock.sleep(publishPollMs);

      const conversation = await options.store.getConversation(conversationId);
      if (!conversation) throw new RuntimeFailure("agent_not_running", `Conversation ${conversationId} disappeared`);

      const [managedResult, hostsResult] = await Promise.all([
        readManagedTmux(),
        options.adapters.listHosts().then((rows) => ({ ok: true as const, rows }), () => ({ ok: false as const, rows: [] as RuntimeHost[] })),
      ]);
      registryReadable = registryReadable && hostsResult.ok;
      // A failed enumeration is not proof our process exited: keep polling rather
      // than reporting a startup failure for an agent that may be running fine.
      if (!managedResult.ok) continue;
      const managed = managedResult.sessions;
      const hosts = hostsResult.rows;

      const still = managed.find((session) => session.id === launched.id && session.serverIdentity === launched.serverIdentity);
      if (!still || !still.alive) {
        await options.store.recordEvent(conversationId, "agent.exited", { duringStartup: true });
        return (
          (await options.store.updateConversation(conversationId, {
            state: "error",
            statusDetail: "The agent process exited during startup.",
          })) ?? conversation
        );
      }

      const published = hosts.filter((row) =>
        !preexistingInstances.has(row.instanceId) &&
        row.cwd === spec.cwd &&
        (!conversation.nativeSessionId || row.sessionId === conversation.nativeSessionId),
      );
      const matched: RuntimeHost[] = [];
      let lineageUnknown = false;
      if (still.panePid !== null) {
        for (const candidate of published) {
          if (candidate.pid === null) {
            lineageUnknown = true;
            continue;
          }
          let descendant: Tri;
          try {
            descendant = await options.adapters.isProcessDescendant(candidate.pid, still.panePid);
          } catch {
            descendant = "unknown";
          }
          if (descendant === true) matched.push(candidate);
          else if (descendant === "unknown") lineageUnknown = true;
        }
      } else if (published.length > 0) {
        lineageUnknown = true;
      }
      if (lineageUnknown || matched.length > 1) identityUnverified = true;
      // More than one matching room or any undecidable candidate is ambiguous; never choose by cwd or PID order.
      const host = !lineageUnknown && matched.length === 1 ? matched[0] : undefined;

      if (host) {
        await options.store.recordEvent(conversationId, "agent.hosted", {
          instanceId: host.instanceId,
          generation: host.generation,
          sessionId: host.sessionId,
        });
        const state = hostState(host);
        return (
          (await options.store.updateConversation(conversationId, {
            hostInstanceId: host.instanceId,
            // An omitted generation is not a rotation: keep what we had recorded
            // rather than erasing it with an unknown.
            hostGeneration: host.generation ?? conversation.hostGeneration,
            nativeSessionId: host.sessionId,
            model: host.model ?? conversation.model,
            state,
            statusDetail: state === "unknown"
              ? "The agent does not report turn state (older OMP); activity here is unconfirmed."
              : null,
            lastActivityAt: new Date(clock.now()).toISOString(),
          })) ?? conversation
        );
      }
    }

    await options.store.recordEvent(conversationId, "agent.publish_timeout", { timeoutMs: publishTimeoutMs });
    const latest = await options.store.getConversation(conversationId);
    if (!latest) throw new RuntimeFailure("agent_not_running", `Conversation ${conversationId} disappeared`);
    return (
      (await options.store.updateConversation(conversationId, {
        state: registryReadable && !identityUnverified ? "starting" : "unknown",
        statusDetail: !registryReadable
          ? "The OMP Collab registry could not be read during startup, so session publication is unknown."
          : identityUnverified
            ? "The agent is running, but the published host process could not be positively matched to its tmux process."
            : "The agent is running, but no Collab host was positively matched to its tmux process before startup timed out.",
      })) ?? latest
    );
  }

  async function stop(conversationId: string, timeoutMs = stopTimeoutMs): Promise<Conversation> {
    const conversation = await options.store.getConversation(conversationId);
    if (!conversation) throw new RuntimeFailure("agent_not_running", `Unknown conversation ${conversationId}`);

    if (conversation.ownership === "external") {
      throw new RuntimeFailure(
        "agent_not_running",
        "This agent was started outside the app, so it is not ours to stop. Attach to it from a terminal instead.",
      );
    }
    if (!conversation.tmuxSessionId) {
      throw new RuntimeFailure("agent_not_running", "This conversation has no managed agent process.");
    }
    if (!conversation.tmuxServerIdentity) {
      throw new RuntimeFailure("agent_not_running", "The tmux server identity was not recorded, so ownership cannot be verified.");
    }
    const serverIdentity = await options.adapters.tmuxServerIdentity().catch(() => "unknown" as const);
    if (serverIdentity === null && processAlive(conversation.tmuxPanePid) === false) {
      await options.store.recordEvent(conversationId, "agent.stopped", {
        tmuxSessionId: conversation.tmuxSessionId,
        alreadyGone: true,
      });
      return (
        (await options.store.updateConversation(conversationId, { state: "stopped", statusDetail: "Stopped." })) ?? conversation
      );
    }
    if (serverIdentity === "unknown") {
      throw new RuntimeFailure("agent_not_running", "The tmux server identity could not be verified, so this process cannot be safely stopped.");
    }

    if (serverIdentity !== null && serverIdentity !== conversation.tmuxServerIdentity) {
      throw new RuntimeFailure("agent_not_running", "The tmux server identity could not be verified, so this process cannot be safely stopped.");
    }

    // The adapter rechecks recorded identity immediately before killing by `$N`.
    // If the socket is unreachable, wait for pane-PID evidence rather than guess.
    if (serverIdentity !== null) {
      await options.adapters.killTmux(conversation.tmuxSessionId, conversation.tmuxServerIdentity);
    }
    await options.store.updateConversation(conversationId, { state: "stopping", statusDetail: "Stopping the agent…" });

    // A stop verdict needs a session lookup bracketed by matching server identity
    // reads. Separate tmux commands cannot provide an atomic snapshot: this detects
    // restarts between reads, but a restart after the final identity read and
    // before the store write remains unavoidable. Never treat a changed or missing
    // server, a dead stranger, or a failed probe as proof that our process stopped.
    const deadline = clock.now() + timeoutMs;
    while (clock.now() < deadline) {
      await clock.sleep(250);
      const currentServerIdentity = await options.adapters.tmuxServerIdentity().catch(() => "unknown" as const);
      if (currentServerIdentity === "unknown") continue;

      if (currentServerIdentity === null) {
        // `null` proves only that the socket path is unreachable. Only ESRCH for
        // this conversation's pane PID proves our process exited. PID reuse can
        // leave a valid stop stuck at `stopping`, but never reports a live agent stopped.
        if (processAlive(conversation.tmuxPanePid) !== false) continue;
        await options.store.recordEvent(conversationId, "agent.stopped", { tmuxSessionId: conversation.tmuxSessionId });
        return (
          (await options.store.updateConversation(conversationId, { state: "stopped", statusDetail: "Stopped." })) ?? conversation
        );
      }
      if (currentServerIdentity !== conversation.tmuxServerIdentity) continue;
      const probe = await options.adapters.getTmux(conversation.tmuxSessionId);
      if (!probe.ok) continue; // a failed lookup cannot confirm exit
      if (probe.session && probe.session.serverIdentity !== conversation.tmuxServerIdentity) continue;
      const identityAfterProbe = await options.adapters.tmuxServerIdentity().catch(() => "unknown" as const);
      if (identityAfterProbe !== conversation.tmuxServerIdentity) continue;
      if (!probe.session || !probe.session.alive) {
        await options.store.recordEvent(conversationId, "agent.stopped", { tmuxSessionId: conversation.tmuxSessionId });
        return (
          (await options.store.updateConversation(conversationId, { state: "stopped", statusDetail: "Stopped." })) ?? conversation
        );
      }
    }

    await options.store.recordEvent(conversationId, "agent.stop_timeout", { timeoutMs });
    return (
      (await options.store.updateConversation(conversationId, {
        state: "stopping",
        statusDetail: "The process has not exited yet.",
      })) ?? conversation
    );
  }

  /**
   * Rebuild our view from the machine after a restart.
   *
   * Reports what it finds and refuses to infer what it cannot observe. In
   * particular it never marks a conversation stopped merely because the backend
   * restarted, and never kills a process it did not record.
   */
  async function reconcile(): Promise<ReconcileReport> {
    const [all, managedResult, hostsResult] = await Promise.all([
      options.store.listAllConversations(),
      readManagedTmux(),
      options.adapters.listHosts().then(
        (rows) => ({ ok: true as const, rows }),
        () => ({ ok: false as const, rows: [] as RuntimeHost[] }),
      ),
    ]);

    const report: ReconcileReport = { adopted: 0, external: 0, stopped: 0, unknown: 0, registered: 0 };

    // A failed enumeration is not "nothing is running". Without the session list
    // no conversation's ownership can be confirmed, so every verdict here would
    // be a guess: report unknown and leave the stored states alone.
    if (!managedResult.ok) {
      for (const conversation of all) {
        await options.store.updateConversation(conversation.id, {
          state: "unknown",
          statusDetail: `The tmux session list could not be read (${managedResult.reason}), so the live state is unknown.`,
        });
        report.unknown += 1;
      }
      return report;
    }
    const managed = managedResult.sessions;
    for (const conversation of all) {
      // `$N` identifies a process only on its recorded server; absent sessions need PID evidence too.
      const unseen = unobservableManagedProcesses([conversation], managed)[0];
      if (unseen && unseen.liveness !== false) {
        await options.store.updateConversation(conversation.id, {
          state: "unknown",
          statusDetail: unseenProcessReason(unseen),
        });
        report.unknown += 1;
        continue;
      }
      const tmux = findManagedTmux(conversation, managed);
      const host = conversation.nativeSessionId
        ? (hostsResult.rows.find((row) => row.sessionId === conversation.nativeSessionId) ?? null)
        : null;
      if (!tmux && host) {
        const state = hostState(host);
        await options.store.updateConversation(conversation.id, {
          hostInstanceId: host.instanceId,
          // Same rule as the start path: an absent generation is not evidence of
          // a rotation, so the recorded value stands.
          hostGeneration: host.generation ?? conversation.hostGeneration,
          ownership: "external",
          state,
          statusDetail: host.busy === null || host.busy === undefined
            ? "The host does not report turn state (older OMP); activity here is unconfirmed."
            : "Started outside this app; it can be watched, and its lifecycle is not managed here.",
        });
        if (state === "unknown") report.unknown += 1;
        else report.external += 1;
        continue;
      }

      if (tmux) {
        const refreshed = await refresh(conversation.id);
        if (!refreshed) continue;
        if (refreshed.state === "unknown") report.unknown += 1;
        // Adoption is about the *process* we found, not the label the verdict
        // chose: a live managed session whose host cannot report turn state is
        // still running under us and still needs its room recorded.
        else if (tmux.alive) {
          report.adopted += 1;
          const withRoom = await adopt(refreshed, managed, hostsResult.rows);
          if (withRoom.hostInstanceId) report.registered += 1;
        }
        continue;
      }

      // No managed process. Only the registry plus the lease may speak for what is
      // running, and a lease held by a foreign process is not something to adopt.
      if (!hostsResult.ok) {
        await options.store.updateConversation(conversation.id, {
          state: "unknown",
          statusDetail: "The OMP Collab registry could not be read, so the live state is unknown.",
        });
        report.unknown += 1;
        continue;
      }

      if (conversation.nativeSessionId) {
        const leaseLive = await options.adapters.isSessionLive(conversation.nativeSessionId).catch(() => "unknown" as const);
        if (leaseLive !== false) {
          await options.store.updateConversation(conversation.id, {
            state: "unknown",
            statusDetail: leaseLive === true
              ? "Another process is writing this session, but it is not managed here."
              : "The session writer lease could not be checked, so the live state is unknown.",
          });
          report.unknown += 1;
          continue;
        }
      }

      const refreshed = await refresh(conversation.id);
      if (refreshed?.state === "stopped" || refreshed?.state === "error") report.stopped += 1;
      else if (refreshed?.state === "unknown") report.unknown += 1;
    }

    return report;
  }

  return { refresh, start, stop, reconcile, activeCount, observe };
}
