import { epochOf, observationSeqOf, type Conversation } from "@caw/contracts";
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
  /**
   * True while a launch for this conversation is inside the critical section —
   * including the window after the process exists but before its tmux identity is
   * recorded. Callers that would otherwise delete or overwrite the row must wait
   * or refuse rather than drop the only pointer to a process that may be starting.
   */
  isLaunching(conversationId: string): boolean;
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


export function createSupervisor(options: SupervisorOptions): Supervisor {
  const clock = options.clock ?? systemClock;
  const publishTimeoutMs = options.publishTimeoutMs ?? DEFAULT_PUBLISH_TIMEOUT_MS;
  const publishPollMs = options.publishPollMs ?? DEFAULT_PUBLISH_POLL_MS;
  const stopTimeoutMs = options.stopTimeoutMs ?? DEFAULT_STOP_TIMEOUT_MS;
  /**
   * Conversations whose launch is claimed but whose reservation is not yet visible
   * in the rows: they occupy a slot none of the live-owner counts can see. Read from
   * the store, which owns the claims.
   */
  function untrackedReservationCount(
    conversations: Conversation[],
    managedIds: Set<string>,
    excludedConversationId?: string,
  ): number {
    return conversations.filter((row) =>
      row.id !== excludedConversationId
      && options.store.isLaunchReserved(row.id)
      && (!row.tmuxSessionId || !managedIds.has(row.tmuxSessionId)),
    ).length;
  }


  async function readManagedTmux(): Promise<ManagedTmuxRead> {
    try {
      return { ok: true, sessions: await options.adapters.listManagedTmux() };
    } catch (error) {
      return { ok: false, reason: error instanceof Error ? error.message : String(error) };
    }
  }
  async function matchPublishedHost(
    hosts: RuntimeHost[],
    panePid: number | null,
    expectedSessionId: string | null,
  ): Promise<{ host: RuntimeHost | null; detail: string | null; uncertain: boolean }> {
    if (panePid === null) return { host: null, detail: "The published host could not be positively matched because the managed tmux pane PID was not recorded.", uncertain: true };
    const matched: RuntimeHost[] = [];
    let lineageUnknown = false;
    for (const candidate of hosts) {
      // A row with no PID cannot prove anything, positively or negatively, so it is
      // simply not a participant in lineage matching. Treating it as blanket
      // uncertainty let one unrelated PID-less row blank ownership for every
      // conversation, including panes with a perfectly good match.
      if (candidate.pid === null) continue;
      let descendant: Tri;
      try {
        descendant = await options.adapters.isProcessDescendant(candidate.pid, panePid);
      } catch {
        descendant = "unknown";
      }
      if (descendant === true) matched.push(candidate);
      else if (descendant === "unknown") lineageUnknown = true;
    }
    if (lineageUnknown) {
      return {
        host: null,
        detail: "Host process lineage could not be determined from the managed tmux pane.",
        uncertain: true,
      };
    }
    if (matched.length > 1) return { host: null, detail: "More than one host could be positively matched to the managed tmux pane; identity is ambiguous.", uncertain: true };
    if (matched.length === 0) return { host: null, detail: "No published host could be positively matched to the managed tmux pane.", uncertain: false };
    const host = matched[0]!;
    if (expectedSessionId && host.sessionId !== expectedSessionId) {
      return {
        host: null,
        detail: `The host could not be positively matched: it belongs to native session ${host.sessionId}, not recorded session ${expectedSessionId}.`,
        uncertain: true,
      };
    }
    return { host, detail: null, uncertain: false };
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

    const managed = managedResult.ok ? managedResult.sessions : [];
    const unseen = managedResult.ok ? unobservableManagedProcesses([conversation], managed)[0] : undefined;
    const tmux = findManagedTmux(conversation, managed);
    let host: RuntimeHost | null = null;
    let hostMatchReason: string | null = null;
    let recoveredHost = false;
    if (hosts.ok && tmux?.alive) {
      // A live pane of ours is the only thing that may confer `managed`. A registry
      // row that merely shares the recorded native session id proves nothing about
      // which process is behind *our* pane: the owner may have switched that pane to
      // another session and resumed this id in an external TUI. So when we hold a
      // live pane, ownership goes through the same lineage check the stop gate uses,
      // and an unverifiable pairing stays unknown instead of being labelled managed.
      // The recorded pane PID, or the enumerated one when the launch's follow-up
      // listing failed and never recorded it. `findManagedTmux` already qualified the
      // session by id *and* server lifetime, so this is the same pane, not a guess.
      const panePid = conversation.tmuxPanePid === null
        ? tmux.panePid
        : conversation.tmuxPanePid === tmux.panePid ? conversation.tmuxPanePid : null;
      const match = await matchPublishedHost(hosts.rows, panePid, conversation.nativeSessionId);
      host = match.host;
      hostMatchReason = match.detail;
      recoveredHost = Boolean(match.host);
    } else if (hosts.ok && conversation.nativeSessionId) {
      // No live pane of ours: the row can only describe a process we do not
      // manage, which `evaluateState` reports as external.
      host = hosts.rows.find((candidate) => candidate.sessionId === conversation.nativeSessionId) ?? null;
      recoveredHost = Boolean(host);
    }
    return {
      observedEpoch: epochOf(conversation),
      tmux,
      host,
      hostMatchReason,
      recoveredHost,
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

  /**
   * Refreshes of one conversation run one at a time, in arrival order.
   *
   * `observationSeq` orders *commits*, but a routine observation is not atomic:
   * the row read happens first and the machine probes second, and the probes'
   * latencies are independent of each other. So two overlapping refreshes of one
   * life can sample the machine in either order, and an ordering fact captured at
   * the row read (a ticket) then names the wrong snapshot "newer" — a refresh that
   * entered last can carry the oldest content and repaint it over a newer sample
   * (V20-08 inversion), and it can equally claim *not* to need a write while an
   * earlier capture's real observation is still in flight, dropping that
   * observation. Ticket ordering cannot fix this: sampling order is not observable.
   *
   * Serializing at entry is the fix that makes capture order real: the second
   * refresh joins the first, then runs the whole cycle — row read, probes, commit —
   * on a row that already includes the first's result. Its `observationSeq` is
   * therefore read *after* the first committed, so the plain revision gate (which
   * `updateConversationIfCurrent` already applies) refuses the older of the two
   * in either completion order, and no capture can be stale-news of its sibling.
   *
   * In-process and per conversation; a launch is not a refresh, so it is not
   * serialized here — the store's reservation gate still drops a refresh that runs
   * during a launch, and `lifecycleEpoch` stays the process-generation authority.
   */
  const refreshChains = new Map<string, Promise<unknown>>();

  function serializeRefresh<T>(conversationId: string, operation: () => Promise<T>): Promise<T> {
    const previous = refreshChains.get(conversationId) ?? Promise.resolve();
    const result = previous.then(operation, operation);
    // Entries are keyed by conversation and overwritten by the next refresh; the
    // settled chain is dropped once it is no longer the tail, so the map does not
    // hold every conversation ever polled.
    const tail = result.then(() => undefined, () => undefined);
    refreshChains.set(conversationId, tail);
    void tail.then(() => { if (refreshChains.get(conversationId) === tail) refreshChains.delete(conversationId); });
    return result;
  }

  const refresh = (conversationId: string): Promise<Conversation | null> =>
    serializeRefresh(conversationId, async () => {
    const conversation = await options.store.getConversation(conversationId);
    if (!conversation) return null;
    // The epoch this refresh will speak for. It is read before the probes and
    // presented at commit: an observation is evidence about one life, and a
    // launch or stop that opened a new one while we probed makes this result
    // stale rather than authoritative.
    const observedEpoch = epochOf(conversation);
    // The revision this refresh will speak for, read before the probes for the
    // same reason but a narrower one: a same-life write (an adopt backfill, a
    // reconcile verdict) can land while we probe, and the epoch does not move for a
    // model-only change. Presenting the revision we read makes the store drop this
    // result instead of letting it repaint the newer one. Refreshes of this
    // conversation are serialized above, so there is no second refresh to order
    // against here — this gate is against the non-refresh observers.
    const observedSeq = observationSeqOf(conversation);
    // Every commit below is a routine observation, so it carries both markers; a
    // launch reservation held meanwhile drops it outright (the launch owns the
    // row in that window) and a newer applied change refuses it as stale.
    const observationWrite = { observation: true as const, expectedObservationSeq: observedSeq };
    const observations = await observationsFor(conversation);
    const verdict: StateVerdict = evaluateState(observations);
    // A launch that was refused never started a process, so there is nothing to
    // observe that would make it "starting" again: `evaluateState`'s fallback for a
    // never-launched row would resurrect the refusal as a ghost launch and discard
    // the reason. Keep the recorded failure as it stands.
    if (verdict.state === "starting" && conversation.state === "error" && !observations.everLaunched) {
      // Refused launches leave the recorded failure standing; no probe may
      // resurrect it as a ghost launch. The read still goes through the epoch
      // gate so a newer life's row is what the caller sees.
      return (await options.store.updateConversationIfCurrent(conversationId, observedEpoch, {}, observationWrite))?.conversation ?? null;
    }

    // Compute the patch once and use those same values for the comparison and the
    // write. Comparing a normalized patch against the row and then writing a
    // differently-normalized one is how a poll loop appends an identical row on
    // every read: the store is append-only, so a log that grows on every poll is
    // a log nobody can read.
    const host = observations.recoveredHost ? observations.host : null;
    const patch: Partial<Conversation> = {
      state: verdict.state,
      ownership: verdict.ownership,
      statusDetail: verdict.detail,
    };
    const pane = observations.tmux?.alive ? observations.tmux : null;
    if (pane?.panePid !== null && pane?.panePid !== undefined && conversation.tmuxPanePid === null) {
      // The launch's follow-up tmux listing failed, so the row never got a PID and
      // no writer will ever backfill it. The session was qualified by id *and*
      // server identity, so the live enumeration is the pane PID we are missing.
      // Without this the row is permanently unstoppable (identity incomplete) and
      // permanently unknown.
      patch.tmuxPanePid = pane.panePid;
    }
    if (host) {
      patch.nativeSessionId = host.sessionId;
      patch.hostInstanceId = host.instanceId;
      // A generation belongs to one host instance. For the same instance an absent
      // generation is not evidence of a rotation, so the recorded value stands; a
      // *different* instance brings its own generation, `null` included, because
      // carrying the old number over would pair two identities that never coexisted.
      patch.hostGeneration = host.instanceId === conversation.hostInstanceId
        ? host.generation ?? conversation.hostGeneration
        : host.generation;
      // The model the host reports is what is running now; `modelPreference` is the
      // next-launch choice and is never written here.
      patch.model = host.model ?? conversation.model;
    } else if (pane) {
      // A live pane with no attributable host: keeping the previous instance would
      // claim a room is serving this process when nothing matched it.
      patch.hostInstanceId = null;
      patch.hostGeneration = null;
    }
    const changed = (Object.keys(patch) as Array<keyof Conversation>).some((key) => conversation[key] !== patch[key]);
    // An unchanged poll writes nothing and claims nothing — there is no ordering
    // fact to record, and a later refresh must not lose to it. It still re-reads so
    // the caller gets the row as it stands now: a launch or stop that moved the
    // epoch while we probed must not be answered with the pre-probe snapshot.
    if (!changed) return (await options.store.getConversation(conversationId)) ?? conversation;

    // Conditional commit: if a newer life began while we probed, this patch
    // describes a process that is already gone, so it is dropped and the newer
    // row is returned instead. A refresh that writes nothing is fine; a stale
    // refresh overwriting a new host/model/state is not. The same conditional
    // shape covers a *same-life* write — the revision read before probing refuses
    // a result a newer writer (an adopt backfill, a reconcile verdict) already
    // superseded. Two refreshes never overlap here: they are serialized at entry.
    return (await options.store.updateConversationIfCurrent(conversationId, observedEpoch, patch, observationWrite))?.conversation ?? null;
  });

  /** Record the runtime facts we can only learn from the machine. */
  async function adopt(conversation: Conversation, managed: RuntimeTmuxSession[], hosts: RuntimeHost[]): Promise<Conversation> {
    const patch: Partial<Conversation> = {};
    // A routine observation like `refresh`: capture the revision the row stood at
    // before the probe below, so a same-life write landing meanwhile is not
    // overwritten by a header read for the older row, and a launch that claimed
    // the row meanwhile drops this entirely.
    const observedSeq = observationSeqOf(conversation);

    if (conversation.nativeSessionPath && !conversation.nativeSessionId) {
      const header = await options.adapters.findBySessionId(conversation.nativeSessionPath);
      if (header) patch.nativeSessionId = header;
    }


    if (Object.keys(patch).length === 0) return conversation;
    // A journal probe ran during this call, so a launch could have claimed the row
    // meanwhile. The header backfill is bound to the life it was read for; if that
    // life is over, the row as it now stands is the answer.
    return (await options.store.updateConversationIfCurrent(conversation.id, epochOf(conversation), patch, { observation: true, expectedObservationSeq: observedSeq }))?.conversation ?? conversation;
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
    // The reservation is taken by the STORE, on the store's own queue, before any
    // adapter is called. That single queue is what orders this against a project
    // delete: `reserveLaunch` and `deleteProject` are sections of it, so exactly one
    // of them commits first. Reserve first → the delete's queued section sees the
    // claim and refuses with `has_conversations`, nothing is written. Delete first →
    // the row is gone, this returns false, and we refuse with `agent_not_running`
    // before creating any process. There is no window in which both sides miss each
    // other, which is what the previous eager-but-separate-mutex shape left open.
    //
    // `false` has two causes, and the caller must not confuse them: the row is gone
    // (a delete committed first), or another launch already holds the claim. The row
    // read tells them apart, and only the first is `agent_not_running`; the second is
    // a duplicate-writer refusal. Neither case took a claim, so nothing is released.
    if (!(await options.store.reserveLaunch(conversationId))) {
      if (!(await options.store.getConversation(conversationId))) {
        throw new RuntimeFailure("agent_not_running", `Unknown conversation ${conversationId}`);
      }
      await options.store
        .recordEvent(conversationId, "launch.refused", { code: "conflict_owner", key: `conversation:${conversationId}` })
        .catch(() => null);
      throw new RuntimeFailure("conflict_owner", "Another launch for this conversation is already in progress.");
    }
    // From here this call holds the claim, and only it may release it.
    let ownershipRetained = false;
    try {
      const initial = await options.store.getConversation(conversationId);
      if (!initial) throw new RuntimeFailure("agent_not_running", `Unknown conversation ${conversationId}`);

      let launched!: RuntimeTmuxSession;
      // The epoch the record write assigned; handed to `waitForPublish` so its
      // late writes are conditional on the life they were computed for.
      let publishEpoch = 0;
      await withLaunchLock(async () => {
        const conversation = await options.store.getConversation(conversationId);
        if (!conversation) throw new RuntimeFailure("agent_not_running", `Unknown conversation ${conversationId}`);
        const hosts = await options.adapters.listHosts().catch(() => {
          throw new RuntimeFailure("registry_unreadable", "The OMP Collab registry could not be read.");
        });
        const managedResult = await readManagedTmux();
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

        launched = await options.adapters.launch({ ...spec, conversationId });
        // The epoch the row holds right now is the life this launch is about to
        // replace. The store advances it when the record below lands, and every
        // later write of this call is conditional on the value the store returns,
        // so a stop or another life landing meanwhile cannot be overwritten by a
        // result computed for this launch.
        const observedEpoch = epochOf(conversation);
        try {
          const recorded = await options.store.updateConversationIfCurrent(conversationId, observedEpoch, {
            tmuxSessionId: launched.id,
            tmuxSessionName: launched.name,
            tmuxServerIdentity: launched.serverIdentity,
            tmuxPanePid: launched.panePid,
            nativeSessionPath: spec.resumeSessionPath ?? conversation.nativeSessionPath,
            state: "starting",
            ownership: "managed",
            statusDetail: "Starting…",
          });
          // `null` is a gone row; `applied: false` means a newer life took the row
          // while we were launching, so our identity was never recorded and this
          // process is exactly the unrecorded writer the undo below exists for.
          if (!recorded?.applied) throw new RuntimeFailure("agent_not_running", "The conversation changed identity before its launched agent could be recorded.");
          publishEpoch = epochOf(recorded.conversation);
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
          // Conditional on the life we launched under: if the row already moved on,
          // this failure describes a process that is no longer the row's, and
          // writing it would mark a life we do not own. The reservation handling
          // below still reflects the real process — only the row write is refused.
          await options.store
            .updateConversationIfCurrent(conversationId, observedEpoch, {
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
        await options.store.recordEvent(conversationId, "agent.launched", { tmuxSessionId: launched.id, tmuxSessionName: launched.name });
      });
      return await waitForPublish(conversationId, launched, spec, publishEpoch);
    } finally {
      // Released unless ownership was deliberately retained for a process that
      // really exists: then the claim is what stops a retry forking the session that
      // process is already writing. That retention has no in-process release —
      // `stop` does not clear it, and a retry is refused by the same claim — so a
      // conversation left in that state stays unstartable and undeletable until the
      // process is accounted for and the backend restarts (the set is in-memory),
      // at which point `reconcile` re-reads the machine. Nothing kills the process
      // automatically; see docs/architecture/session-lifecycle.md.
      if (!ownershipRetained) options.store.releaseLaunch(conversationId);
    }
  }
  /** Wait for a newly published host and record it only after positive lineage confirmation. */
  async function waitForPublish(
    conversationId: string,
    launched: RuntimeTmuxSession,
    spec: RuntimeLaunchSpec,
    launchEpoch: number,
  ): Promise<Conversation> {
    const deadline = clock.now() + publishTimeoutMs;
    let registryReadable = true;
    let identityUnverified = false;
    let identityReason: string | null = null;

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
        // Not seeing the session is not the same as the process having exited. The
        // pane PID the launch recorded is the corroboration; while it lives (or its
        // liveness cannot be established) this is an unverified observation and the
        // loop keeps waiting rather than claiming an exit we did not observe.
        if (processAlive(launched.panePid) !== false) continue;
        await options.store.recordEvent(conversationId, "agent.exited", { duringStartup: true, tmuxSessionId: launched.id });
        // Bound to the launch this call owns: an old start's late "exited" must not
        // mark the row of a newer life that took over while we were waiting.
        return (
          (await options.store.updateConversationIfCurrent(conversationId, launchEpoch, {
            state: "error",
            statusDetail: "The agent process exited during startup.",
          }))?.conversation ?? conversation
        );
      }
      const recordedPanePid = conversation.tmuxPanePid !== null && conversation.tmuxPanePid === still.panePid
        ? conversation.tmuxPanePid
        : null;
      const match = await matchPublishedHost(hosts, recordedPanePid, conversation.nativeSessionId);
      if (match.uncertain) {
        identityUnverified = true;
        identityReason = match.detail;
      }

      const host = match.host;
      if (host) {
        await options.store.recordEvent(conversationId, "agent.hosted", {
          instanceId: host.instanceId,
          generation: host.generation,
          sessionId: host.sessionId,
        });
        const state = hostState(host);
        return (
          (await options.store.updateConversationIfCurrent(conversationId, launchEpoch, {
            hostInstanceId: host.instanceId,
            hostGeneration: host.generation ?? conversation.hostGeneration,
            nativeSessionId: host.sessionId,
            model: host.model ?? conversation.model,
            state,
            statusDetail: state === "unknown"
              ? "The agent does not report turn state (older OMP); activity here is unconfirmed."
              : null,
            lastActivityAt: new Date(clock.now()).toISOString(),
          }))?.conversation ?? conversation
        );
      }
    }

    await options.store.recordEvent(conversationId, "agent.publish_timeout", { timeoutMs: publishTimeoutMs });
    const latest = await options.store.getConversation(conversationId);
    if (!latest) throw new RuntimeFailure("agent_not_running", `Conversation ${conversationId} disappeared`);
    return (
      // An old start's late publish-timeout lands only on the life it launched;
      // a newer life keeps its own state.
      (await options.store.updateConversationIfCurrent(conversationId, launchEpoch, {
        state: registryReadable && !identityUnverified ? "starting" : "unknown",
        statusDetail: !registryReadable
          ? "The OMP Collab registry could not be read during startup, so session publication is unknown."
          : identityUnverified
            ? identityReason ?? "The agent is running, but the published host process could not be positively matched to its tmux process."
            : "The agent is running, but no Collab host was positively matched to its tmux process before startup timed out.",
      }))?.conversation ?? latest
    );
  }

  async function stop(conversationId: string, timeoutMs = stopTimeoutMs): Promise<Conversation> {
    const conversation = await options.store.getConversation(conversationId);
    if (!conversation) throw new RuntimeFailure("agent_not_running", `Unknown conversation ${conversationId}`);
    if (conversation.ownership === "external") {
      throw new RuntimeFailure("agent_not_running", "This agent was started outside the app, so it is not ours to stop. Attach to it from a terminal instead.");
    }
    if (!conversation.tmuxSessionId) throw new RuntimeFailure("agent_not_running", "This conversation has no managed agent process.");
    /**
     * The life this stop acts on. The probes below take real time, and a launch
     * (or another stop) can open a new life in the row while they run, so every
     * write is conditional on the epoch this stop started from.
     */
    let stopEpoch = epochOf(conversation);
    /**
     * Commit a result about the process this stop settled: the guarded kill ran, or
     * the recorded pane PID is confirmed gone (ESRCH). The row is only the record of
     * that, so a display write that moved the epoch does not make the machine
     * evidence wrong. `state` is a lifecycle field, and a routine refresh noticing
     * `idle`->`running` bumps the epoch without putting any process behind the row;
     * refusing there reports a stop that already took effect as a conflict.
     *
     * What must still win is a genuinely newer life. A launch always records its own
     * `tmuxSessionId` - a stop keeps the old one - so a new process is exactly a
     * row whose recorded session is no longer the one this stop settled: that row is
     * refused, whatever its epoch. The same session id means only a display write
     * moved the epoch, so the commit is retried against the row as it now stands;
     * the retry is conditional again, so a launch landing in between still wins.
     */
    const commit = async (patch: Partial<Conversation>): Promise<Conversation> => {
      let result = await options.store.updateConversationIfCurrent(conversationId, stopEpoch, patch);
      if (!result) throw new RuntimeFailure("agent_not_running", `Conversation ${conversationId} disappeared while the stop was in progress.`);
      if (!result.applied) {
        const sameSession = result.conversation.tmuxSessionId === conversation.tmuxSessionId
          && result.conversation.tmuxServerIdentity === conversation.tmuxServerIdentity;
        if (sameSession) result = await options.store.updateConversationIfCurrent(conversationId, epochOf(result.conversation), patch);
      }
      if (!result?.applied) {
        throw new RuntimeFailure("agent_not_running", "A newer lifecycle replaced this conversation while the stop was in progress, so the stale stop result was discarded.");
      }
      stopEpoch = epochOf(result.conversation);
      return result.conversation;
    };
    const refuse = async (reason: string): Promise<never> => {
      // Conditional too: if the row has moved on, the newer life's row is not ours
      // to mark unknown. The refusal itself still stands — it describes the process
      // this stop observed.
      await options.store.updateConversationIfCurrent(conversationId, stopEpoch, { state: "unknown", statusDetail: reason });
      throw new RuntimeFailure("agent_not_running", reason);
    };
    if (!conversation.tmuxServerIdentity || conversation.tmuxPanePid === null || !conversation.nativeSessionId) {
      return refuse("The recorded pane identity is incomplete, so ownership cannot be verified.");
    }
    const serverIdentity = await options.adapters.tmuxServerIdentity().catch(() => "unknown" as const);
    if (serverIdentity === "unknown") return refuse("The tmux server identity could not be verified, so this process cannot be safely stopped.");
    if (serverIdentity === null) {
      if (processAlive(conversation.tmuxPanePid) === false) {
        // Accepted: ESRCH means no process holds the recorded pane PID any more, so
        // there is no writer on that pane to protect. A renamed-but-live session runs
        // under a *different* PID; a different PID behind this one is PID reuse, which
        // can only delay a stop, never fabricate one.
        await options.store.recordEvent(conversationId, "agent.stopped", { tmuxSessionId: conversation.tmuxSessionId, alreadyGone: true });
        return await commit({ state: "stopped", statusDetail: "Stopped." });
      }
      return refuse("The recorded tmux pane is not verifiably gone; ownership cannot be confirmed.");
    }
    if (serverIdentity !== conversation.tmuxServerIdentity) return refuse("The tmux server identity changed, so this process cannot be safely stopped.");
    const pane = await options.adapters.getTmux(conversation.tmuxSessionId);
    if (!pane.ok) return refuse("The recorded tmux pane could not be verified, so this process cannot be safely stopped.");
    if (!pane.session || !pane.session.alive) {
      // A missing pane is not proof its process exited: the session may have been
      // renamed away, or the enumeration may be racing a restart. The recorded pane
      // PID is the corroboration, exactly as in the polling loop below.
      if (processAlive(conversation.tmuxPanePid) !== false) {
        return refuse("The recorded tmux pane is not verifiably gone; its process may still be running, so ownership cannot be confirmed.");
      }
      await options.store.recordEvent(conversationId, "agent.stopped", { tmuxSessionId: conversation.tmuxSessionId, alreadyGone: true });
      return await commit({ state: "stopped", statusDetail: "Stopped." });
    }
    if (pane.session.serverIdentity !== conversation.tmuxServerIdentity || pane.session.panePid !== conversation.tmuxPanePid) {
      return refuse("The recorded tmux pane identity or PID changed, so this process cannot be safely stopped.");
    }
    const hosts = await options.adapters.listHosts().catch(() => null);
    if (hosts === null) return refuse("The host registry could not be read, so the pane's native session cannot be verified.");
    const lineage = await Promise.all(hosts.filter((host) => host.pid !== null).map(async (host) => ({
      host,
      result: await options.adapters.isProcessDescendant(host.pid!, conversation.tmuxPanePid!),
    })));
    if (lineage.some(({ result }) => result === "unknown")) return refuse("Host process lineage could not be verified, so the pane's native session cannot be verified.");
    const paneHosts = lineage.filter(({ result }) => result === true).map(({ host }) => host);
    if (paneHosts.length !== 1 || paneHosts[0]!.sessionId !== conversation.nativeSessionId) {
      return refuse("The recorded tmux pane is not positively verified as serving this native session.");
    }
    await options.adapters.killTmux(conversation.tmuxSessionId, conversation.tmuxServerIdentity);
    await commit({ state: "stopping", statusDetail: "Stopping the agent…" });
    const deadline = clock.now() + timeoutMs;
    while (clock.now() < deadline) {
      await clock.sleep(250);
      const currentServerIdentity = await options.adapters.tmuxServerIdentity().catch(() => "unknown" as const);
      if (currentServerIdentity === "unknown") continue;
      if (currentServerIdentity === null) {
        if (processAlive(conversation.tmuxPanePid) !== false) continue;
        await options.store.recordEvent(conversationId, "agent.stopped", { tmuxSessionId: conversation.tmuxSessionId });
        return await commit({ state: "stopped", statusDetail: "Stopped." });
      }
      if (currentServerIdentity !== conversation.tmuxServerIdentity) continue;
      const probe = await options.adapters.getTmux(conversation.tmuxSessionId);
      if (!probe.ok) continue;
      if (probe.session && probe.session.serverIdentity !== conversation.tmuxServerIdentity) continue;
      const identityAfterProbe = await options.adapters.tmuxServerIdentity().catch(() => "unknown" as const);
      if (identityAfterProbe !== conversation.tmuxServerIdentity) continue;
      if (!probe.session && processAlive(conversation.tmuxPanePid) !== false) continue;
      if (!probe.session || !probe.session.alive) {
        await options.store.recordEvent(conversationId, "agent.stopped", { tmuxSessionId: conversation.tmuxSessionId });
        return await commit({ state: "stopped", statusDetail: "Stopped." });
      }
    }
    await options.store.recordEvent(conversationId, "agent.stop_timeout", { timeoutMs });
    return await commit({ state: "stopping", statusDetail: "The process has not exited yet." });
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

    /**
     * Reconcile reads every row once, then probes the machine; a launch or a stop
     * can commit while those probes run. Each row's write is therefore conditional
     * on the epoch it was read at, so a reconciliation verdict about the previous
     * life cannot be stamped onto a newer one. `applied: false` means the row moved
     * on and this pass simply does not speak for it.
     *
     * The verdict is also a routine observation of one life, so it carries the
     * revision the row was read at: a same-life write that committed while this
     * pass probed the machine is newer news, and this older verdict is dropped.
     * A launch that claimed the row meanwhile drops it too — the launch owns the
     * row between its reserve and its publish.
     */
    const writeIfCurrent = (conversation: Conversation, patch: Partial<Conversation>) =>
      options.store.updateConversationIfCurrent(conversation.id, epochOf(conversation), patch, {
        observation: true,
        expectedObservationSeq: observationSeqOf(conversation),
      });

    // A failed enumeration is not "nothing is running". Without the session list
    // no conversation's ownership can be confirmed, so every verdict here would
    // be a guess: report unknown and leave the stored states alone.
    if (!managedResult.ok) {
      for (const conversation of all) {
        await writeIfCurrent(conversation, {
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
        await writeIfCurrent(conversation, {
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
        await writeIfCurrent(conversation, {
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
        await writeIfCurrent(conversation, {
          state: "unknown",
          statusDetail: "The OMP Collab registry could not be read, so the live state is unknown.",
        });
        report.unknown += 1;
        continue;
      }

      if (conversation.nativeSessionId) {
        const leaseLive = await options.adapters.isSessionLive(conversation.nativeSessionId).catch(() => "unknown" as const);
        if (leaseLive !== false) {
          await writeIfCurrent(conversation, {
            state: "unknown",
            ...(leaseLive === true ? { ownership: "external" as const } : {}),
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

  /**
   * A launch is "in flight" for a conversation from the moment it holds a
   * reservation until the process identity is recorded (or the reservation is
   * released). The reservation set is the only place that covers the window where
   * the process exists but `tmuxSessionId` is still null.
   */
  function isLaunching(conversationId: string): boolean {
    // The store owns the claim, and its answer is the right one for this observer:
    // a reservation is only ever taken inside the store queue, so a stale `false`
    // here cannot let anything unsafe happen — a deleter that acts on it still has
    // `deleteProject` re-check inside that same queue, where the claim either is
    // visible (refusal) or the row it would drop is gone.
    return options.store.isLaunchReserved(conversationId);
  }

  return { refresh, start, stop, reconcile, activeCount, isLaunching, observe };
}
