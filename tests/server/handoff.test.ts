import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { FastifyInstance } from "fastify";
import type { Server as HttpServer } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import { DefaultNativeSessionCatalog, encodeSessionDirName, type HandoffResult } from "@caw/omp-adapter";
import { createAuthenticationService } from "../../apps/server/src/auth";
import { buildApp } from "../../apps/server/src/app";
import { createMetadataStore } from "../../apps/server/src/store";
import type { MetadataStore, StoreEvent } from "../../apps/server/src/store";
import type { ServerConfig } from "../../apps/server/src/config";

/**
 * The handoff route's refusal matrix.
 *
 * Handoff is a keystroke into a live agent's editor, so every precondition is a
 * refusal we can name. These cases drive the route with a stub adapter and assert
 * which facts earn a delivery and which earn a refusal — the same split the
 * adapter enforces, so the two halves cannot drift apart.
 */
const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

interface HandoffInput { sessionId: string; expectedIdentity: string; expectedPanePid: number; assertIdle: () => Promise<boolean> }

/**
 * A refusal-line count that changes over successive reads, so a test can express
 * "the pane showed N refusals when the paste went in, and M afterwards". The
 * route reads the count once for the baseline and once more to judge the paste,
 * so `risingProbe(0, 1)` is exactly the one-new-refusal case.
 */
function risingProbe(...counts: number[]): () => Promise<number> {
  let index = 0;
  return async () => counts[Math.min(index++, counts.length - 1)]!;
}

async function fixture(options: {
  handoff?: (input: HandoffInput) => Promise<HandoffResult>;
  liveIdentity?: string | null;
  host?: { sessionId: string; access: "view" | "control"; relayConnected: boolean | null; busy: boolean | null; inputRequired: boolean | null } | null;
  conversation?: Record<string, unknown>;
  /** Native journal evidence reader; undefined means "configured, finds nothing". */
  evidence?: ((sessionId: string, sinceMs: number) => Promise<{ entryId: string; timestamp: string } | null>) | null;
  /** Bounded refusal-line count for OMP's own refusal; undefined means "not configured". */
  probe?: ((sessionId: string) => Promise<number>) | null;
  /** Reuse an existing state dir (a restart: fresh process, same journal). */
  stateDir?: string;
  /** Skip creating the project/conversation (they are replayed from the journal). */
  existingConversationId?: string;
  /** Fault injection: wrap the real store the app is built over (the raw one is returned). */
  wrapStore?: (store: MetadataStore) => MetadataStore;
} = {}) {
  const dir = options.stateDir ?? (await mkdtemp(join(tmpdir(), "caw-handoff-route-")));
  if (!options.stateDir) dirs.push(dir);
  const auth = createAuthenticationService({ stateDir: dir, setupOutput: () => undefined });
  await auth.initAuth();
  const config: ServerConfig = {
    host: "127.0.0.1", port: 8791, stateDir: dir, allowedRoots: [dir],
    relayPort: 8792, relayAllowedOrigins: [], maxActiveAgents: 3, authTokenTtlHours: 720,
    trustTailscaleOrigin: false, logLevel: "silent", insecureCookies: false, handoffEvidenceBudgetMs: 0,
  };
  const store = createMetadataStore(dir);
  const app = buildApp({
    config, auth, store: options.wrapStore ? options.wrapStore(store) : store, originAllowlist: ["https://workspace.test"],
    sendHandoff: options.handoff ?? (async () => ({ delivered: true, sessionId: "$0", paneId: "%0", panePid: 42 })),
    tmuxServerIdentity: async () => (options.liveIdentity === undefined ? "sock:1:2" : options.liveIdentity),
    findLiveHost: async () => (options.host === undefined
      ? { instanceId: "i", generation: 1, pid: 1, sessionId: "sess-1", sessionName: null, cwd: dir, model: null, startedAt: null, participants: 0, relayConnected: true, inputRequired: false, busy: false, access: "control" }
      : options.host) as never,
    ...(options.evidence === null ? {} : { readHandoffCompaction: options.evidence ?? (async () => null) }),
    ...(options.probe === null || options.probe === undefined ? {} : { countHandoffRefusals: options.probe }),
  });
  const session = auth.createSession();
  const headers = { cookie: `__Host-caw_session=${session.token}`, origin: "https://workspace.test", "x-caw-csrf": session.csrfToken };
  if (options.existingConversationId !== undefined) {
    // A restart: the rows are replayed from the state dir, so read them back
    // rather than creating duplicates.
    const existing = await store.getConversation(options.existingConversationId);
    if (!existing) throw new Error(`fixture: conversation ${options.existingConversationId} was not replayed`);
    return { app, headers, conversation: existing, store, dir };
  }
  const project = await store.createProject({ path: dir, label: "p" });
  const conversation = await store.createConversation({ projectId: project.id, title: "c" });
  await store.updateConversation(conversation.id, {
    ownership: "managed", state: "idle", nativeSessionId: "sess-1",
    tmuxSessionId: "$0", tmuxSessionName: "caw-c", tmuxServerIdentity: "sock:1:2", tmuxPanePid: 42,
    ...options.conversation,
  });
  return { app, headers, conversation, store, dir };
}

const post = (app: FastifyInstance<HttpServer>, id: string, headers: Record<string, string>, payload: unknown = { confirmDraftRisk: true }) =>
  app.inject({ method: "POST", url: `/api/conversations/${id}/handoff`, headers, ...(payload === undefined ? {} : { payload }) });

describe("handoff route", () => {
  it("reports `delivered` — never borrowed success — when the paste lands with no native evidence", async () => {
    let received: HandoffInput | null = null;
    const { app, headers, conversation } = await fixture({ handoff: async (input) => { received = input; return { delivered: true, sessionId: "$0", paneId: "%0", panePid: 42 }; } });
    const response = await post(app, conversation.id, headers);
    expect(response.statusCode).toBe(200);
    // A landed paste proves delivery and nothing else; the server must not claim
    // the compaction committed without the journal entry that proves it.
    expect(response.json().data).toEqual({ state: "delivered", paneId: "%0" });
    expect(received).toMatchObject({ sessionId: "$0", expectedIdentity: "sock:1:2", expectedPanePid: 42 });
    // The route hands the adapter a real idleness proof, and it resolves true only
    // on positive registry evidence.
    expect(await received!.assertIdle()).toBe(true);
    await app.close();
  });

  it("reports `committed` only with the matching native journal entry as evidence", async () => {
    const { app, headers, conversation } = await fixture({
      evidence: async () => ({ entryId: "b2d18632", timestamp: new Date().toISOString() }),
    });
    const response = await post(app, conversation.id, headers);
    expect(response.statusCode).toBe(200);
    expect(response.json().data).toEqual({ state: "committed", paneId: "%0", compactionEntryId: "b2d18632" });
    await app.close();
  });

  it("refuses an unconfirmed paste before typing, because the editor cannot be proven empty", async () => {
    let called = false;
    const { app, headers, conversation } = await fixture({ handoff: async () => { called = true; return { delivered: true, sessionId: "$0", paneId: "%0", panePid: 42 }; } });
    const response = await post(app, conversation.id, headers, {});
    expect(response.statusCode).toBe(409);
    expect(response.json().error.code).toBe("draft_unconfirmed");
    // Nothing was typed: the refusal precedes the adapter call, so an unsent
    // draft cannot have been spliced.
    expect(called).toBe(false);
    await app.close();
  });

  it("does not lock the retry out after refusing the draft confirmation", async () => {
    // The client's flow is *designed* around this: ask without the flag, read the
    // refusal, ask again with it. A refusal that took the durable marker would
    // answer the second tap with `handoff_in_flight` for the whole marker TTL.
    const { app, headers, conversation, store } = await fixture({ evidence: async () => null });
    const refused = await post(app, conversation.id, headers, {});
    expect(refused.statusCode).toBe(409);
    expect(refused.json().error.code).toBe("draft_unconfirmed");
    const retry = await post(app, conversation.id, headers, { confirmDraftRisk: true });
    expect(retry.statusCode, JSON.stringify(retry.json())).toBe(200);
    expect(retry.json().data.state).toBe("delivered");
    // And the refusal left no marker behind for a later request to trip over.
    const events = await store.listEventsTail(conversation.id, Number.POSITIVE_INFINITY, 10);
    expect(events.filter((event) => event.type === "handoff-start")).toHaveLength(1);
    await app.close();
  });

  it("takes no durable marker when a precondition refuses, so it cannot lock out", async () => {
    // This refuses before anything is typed, so it must leave the conversation
    // exactly as handoff-able as it found it.
    const unauthorized = await fixture({ liveIdentity: "other:9:9" });
    const refusedIdentity = await post(unauthorized.app, unauthorized.conversation.id, unauthorized.headers);
    expect(refusedIdentity.statusCode).toBe(409);
    expect(refusedIdentity.json().error.code).toBe("conflict_owner");
    expect((await unauthorized.store.listEventsTail(unauthorized.conversation.id, Number.POSITIVE_INFINITY, 10))
      .some((event) => event.type === "handoff-start")).toBe(false);
    await unauthorized.app.close();
  });

  it("retires the marker once a handoff commits, so the next operation is not chained to it", async () => {
    const { app, headers, conversation, store } = await fixture({ evidence: async () => ({ entryId: "e1", timestamp: new Date().toISOString() }) });
    const first = await post(app, conversation.id, headers);
    expect(first.json().data.state).toBe("committed");
    // The operation is finished, so the marker must not still be standing to be
    // re-derived from the compaction on the next request.
    const events = await store.listEventsTail(conversation.id, Number.POSITIVE_INFINITY, 10);
    expect(events.map((event) => event.type)).toContain("handoff-cancelled");
    expect(await post(app, conversation.id, headers)).toMatchObject({ statusCode: 200 });
    await app.close();
  });

  it("keeps refusing while an older compaction exists, using the real journal reader", async () => {
    // The reviewer's scenario, with the real reader instead of a stub: a genuine
    // compaction entry is present but predates the marker, so it is not evidence
    // that the *current* handoff finished. The boundary (`at < sinceMs`) is what
    // makes this fail-safe; a stub that ignored `sinceMs` cannot show it.
    const journalRoot = await mkdtemp(join(tmpdir(), "caw-handoff-journal-"));
    dirs.push(journalRoot);
    const cwd = join(journalRoot, "cwd");
    const bucket = join(journalRoot, "sessions", encodeSessionDirName(cwd));
    await mkdir(bucket, { recursive: true });
    await mkdir(cwd, { recursive: true });
    const journal = join(bucket, "2026-10-26_sess-1.jsonl");
    const oldTimestamp = new Date(Date.now() - 60_000).toISOString();
    await writeFile(journal, [
      JSON.stringify({ type: "session", id: "sess-1", cwd, timestamp: oldTimestamp, version: 3 }),
      JSON.stringify({ type: "compaction", id: "OLD-COMMIT", parentId: null, timestamp: oldTimestamp, summary: "s", firstKeptEntryId: "x", tokensBefore: 1, method: "handoff" }),
    ].join("\n") + "\n", "utf8");
    const reader = new DefaultNativeSessionCatalog({
      sessionsRoot: join(journalRoot, "sessions"),
      leaseProbe: { isLive: async () => false, liveSet: async () => new Map(), leaseName: (id) => id },
    });
    const { app, headers, conversation } = await fixture({
      evidence: (sessionId, sinceMs) => reader.readHandoffCompaction(sessionId, sinceMs),
      probe: async () => 0,
    });
    expect((await post(app, conversation.id, headers)).json().data.state).toBe("delivered");
    const second = await post(app, conversation.id, headers);
    expect(second.statusCode).toBe(409);
    expect(second.json().error.code).toBe("handoff_in_flight");
    await app.close();
  });

  it("keeps the marker when the evidence read fails, so a blip cannot admit a second paste", async () => {
    // A transient failure while evaluating the previous marker (a permission
    // blip on the sessions root, a store write error) is not evidence that no
    // handoff is generating. Clearing on it would let the next request paste
    // into a session OMP may still be compacting.
    let calls = 0;
    const { app, headers, conversation, store } = await fixture({
      evidence: async () => {
        calls += 1;
        // First call: no evidence, so the paste lands and the marker is taken.
        if (calls === 1) return null;
        // Later calls: the reader itself fails.
        throw Object.assign(new Error("EACCES: cannot scan sessions root"), { code: "EACCES" });
      },
      probe: async () => 0,
    });
    expect((await post(app, conversation.id, headers)).json().data.state).toBe("delivered");
    // The failure must refuse, and must not retire the live marker.
    const second = await post(app, conversation.id, headers);
    expect(second.statusCode, JSON.stringify(second.json())).toBe(409);
    expect(second.json().error.code).toBe("handoff_in_flight");
    // And the *next* attempt must still be refused: the blip bought no paste.
    expect((await post(app, conversation.id, headers)).statusCode).toBe(409);
    const events = await store.listEventsTail(conversation.id, Number.POSITIVE_INFINITY, 20);
    expect(events.filter((event) => event.type === "handoff-cancelled")).toHaveLength(0);
    expect(events.filter((event) => event.type === "handoff-start")).toHaveLength(1);
    await app.close();
  });

  it("retires the marker when a NEW refusal appears after the paste, so the retry is immediate", async () => {
    // `delivered` with no journal entry is ambiguous only if the pane is silent.
    // A refusal line that was not there when this paste went in is positive
    // evidence the handoff never started, so the marker goes and the user's retry
    // is not punished with a lockout. The rise is what makes it *this* paste's.
    const { app, headers, conversation, store } = await fixture({
      evidence: async () => null,
      probe: risingProbe(0, 1),
    });
    const first = await post(app, conversation.id, headers);
    expect(first.statusCode).toBe(200);
    expect(first.json().data).toMatchObject({ state: "delivered", refused: true });
    const events = await store.listEventsTail(conversation.id, Number.POSITIVE_INFINITY, 10);
    expect(events.map((event) => event.type)).toContain("handoff-cancelled");
    // The retry is admitted immediately, not after the age backstop.
    expect((await post(app, conversation.id, headers)).statusCode).toBe(200);
    await app.close();
  });

  it("treats a refusal line already on screen as unknown, so a stale warning cannot retire a live marker", async () => {
    // The anchoring rule, stated as the reviewer's scenario: an earlier empty
    // session left "Nothing to hand off" in the pane, and this paste added no
    // refusal of its own. A bare "is the text there" read would retire the marker
    // of an operation that is still generating and admit a second paste into it.
    // An unchanged count is not a verdict, so the request must not claim
    // `refused` and the marker must stand.
    const { app, headers, conversation, store } = await fixture({
      evidence: async () => null,
      probe: async () => 1, // the stale line is present, before and after
    });
    const first = await post(app, conversation.id, headers);
    expect(first.statusCode).toBe(200);
    expect(first.json().data).toMatchObject({ state: "delivered" });
    expect(first.json().data.refused).toBeUndefined();
    const second = await post(app, conversation.id, headers);
    expect(second.statusCode, JSON.stringify(second.json())).toBe(409);
    expect(second.json().error.code).toBe("handoff_in_flight");
    const events = await store.listEventsTail(conversation.id, Number.POSITIVE_INFINITY, 10);
    expect(events.filter((event) => event.type === "handoff-cancelled")).toHaveLength(0);
    await app.close();
  });

  it("fails closed when the marker carries no refusal baseline, so a legacy marker cannot be retired", async () => {
    // A marker written before this rule existed (or one whose baseline read
    // failed) has no "before" to compare against. Reading an absent baseline as
    // "there were none" would invert the invariant for every pre-existing marker,
    // so it must mean "no verdict" instead.
    const { app, headers, conversation, store } = await fixture({
      evidence: async () => null,
      probe: async () => 7,
    });
    await store.recordEvent(conversation.id, "handoff-start", { sessionId: "sess-1", startedAt: Date.now() - 1_000 }, new Date().toISOString());
    const response = await post(app, conversation.id, headers);
    expect(response.statusCode, JSON.stringify(response.json())).toBe(409);
    expect(response.json().error.code).toBe("handoff_in_flight");
    // No baseline-less marker may be retired on a refusal line.
    const events = await store.listEventsTail(conversation.id, Number.POSITIVE_INFINITY, 10);
    expect(events.filter((event) => event.type === "handoff-cancelled")).toHaveLength(0);
    await app.close();
  });

  it("keeps refusing when the pane says nothing decidable", async () => {
    // An unreadable pane or an unchanged count is not a refusal: the operation
    // may still be generating, so the marker stays.
    for (const probe of [async () => 0, async () => { throw new Error("pane gone"); }]) {
      const { app, headers, conversation, store } = await fixture({ evidence: async () => null, probe });
      expect((await post(app, conversation.id, headers)).json().data.state).toBe("delivered");
      const second = await post(app, conversation.id, headers);
      expect(second.statusCode).toBe(409);
      expect(second.json().error.code).toBe("handoff_in_flight");
      const events = await store.listEventsTail(conversation.id, Number.POSITIVE_INFINITY, 10);
      expect(events.filter((event) => event.type === "handoff-cancelled")).toHaveLength(0);
      await app.close();
    }
  });

  it("keeps the marker standing past 50 unrelated events, so runtime traffic cannot admit a second paste", async () => {
    // The marker is one event among many in the same per-conversation stream:
    // the runtime appends agent.launched / agent.exited / launch.refused / ...
    // A lookup answered from a fixed-size window over *all* event types loses
    // the marker the moment 50 unrelated events land after it, and a lost
    // marker reads exactly like "no marker" — which would paste into a session
    // OMP may still be compacting, well inside the 150-minute TTL.
    const { app, headers, conversation, store } = await fixture({ evidence: async () => null, probe: async () => 0 });
    expect((await post(app, conversation.id, headers)).json().data.state).toBe("delivered");
    for (let index = 0; index < 80; index += 1) {
      await store.recordEvent(conversation.id, index % 2 === 0 ? "agent.launched" : "agent.exited", { tmuxSessionId: "$0", tmuxSessionName: "caw-c" });
    }
    const second = await post(app, conversation.id, headers);
    expect(second.statusCode, JSON.stringify(second.json())).toBe(409);
    expect(second.json().error.code).toBe("handoff_in_flight");
    // The refusal is real: no second marker was taken behind it.
    const events = await store.listEventsTail(conversation.id, Number.POSITIVE_INFINITY, 200);
    expect(events.filter((event) => event.type === "handoff-start")).toHaveLength(1);
    await app.close();
  });

  it("refuses when the marker read itself fails, so a store blip cannot overwrite a live marker", async () => {
    // "I could not read the store" is not "no marker stands". Mapping the
    // failure to `null` would make the route write a fresh `handoff-start` over
    // a marker it never evaluated, and admit the paste that marker was refusing.
    // The wrapper fails the marker read through whichever store method performs
    // it (`latestEventOfTypes` now, `listEventsTail` before this change), so
    // this case fails first for the reason it names rather than for a missing
    // method.
    let failReads = false;
    const unreadable = () => Object.assign(new Error("EIO: metadata journal unreadable"), { code: "EIO" });
    const { app, headers, conversation, store } = await fixture({
      evidence: async () => null,
      probe: async () => 0,
      // Both store reads the marker lookup could use are redirected to the same
      // real journal while healthy and made to fail together afterwards, so the
      // case exercises "the marker read failed" rather than "the method the app
      // happens to call is missing".
      wrapStore: (real) => ({
        ...real,
        latestEventOfTypes: <T>(conversationId: string, types: readonly string[]): Promise<StoreEvent<T> | null> =>
          failReads
            ? Promise.reject(unreadable())
            : real.listEventsTail<T>(conversationId, Number.POSITIVE_INFINITY, 1000)
              .then((events) => events.filter((event) => types.includes(event.type)).at(-1) ?? null),
        listEventsTail: <T>(conversationId: string, beforeSeq?: number, limit?: number) =>
          failReads ? Promise.reject(unreadable()) : real.listEventsTail<T>(conversationId, beforeSeq, limit),
      }),
    });
    expect((await post(app, conversation.id, headers)).json().data.state).toBe("delivered");
    failReads = true;
    const second = await post(app, conversation.id, headers);
    expect(second.statusCode, JSON.stringify(second.json())).toBe(409);
    expect(second.json().error.code).toBe("handoff_in_flight");
    // The marker that could not be evaluated is still the only one standing:
    // the failed read bought no paste and wrote no replacement.
    const events = await store.listEventsTail(conversation.id, Number.POSITIVE_INFINITY, 20);
    expect(events.filter((event) => event.type === "handoff-start")).toHaveLength(1);
    await app.close();
  });

  it("refuses a second handoff after the first request ends, because the marker is durable", async () => {
    // The first handoff lands and no compaction entry ever appears: OMP is still
    // generating, or it silently refused. Either way the request is over, so the
    // in-process guard is already released — only durable evidence may refuse.
    const { app, headers, conversation, store, dir } = await fixture({ evidence: async () => null, probe: async () => 0 });
    expect((await post(app, conversation.id, headers)).json().data.state).toBe("delivered");
    const second = await post(app, conversation.id, headers);
    expect(second.statusCode).toBe(409);
    expect(second.json().error.code).toBe("handoff_in_flight");

    // Durability is what the name claims, so it is asserted *behaviourally*: the
    // refusal must survive a process that never saw the first request. The
    // payload is checked too, so a marker written without the fields the next
    // reader needs (the identity, the age, and the refusal baseline) fails here.
    const events = await store.listEventsTail<{ startedAt?: unknown; sessionId?: unknown; refusalBaseline?: unknown }>(conversation.id, Number.POSITIVE_INFINITY, 10);
    const starts = events.filter((event) => event.type === "handoff-start");
    expect(starts).toHaveLength(1);
    expect(starts[0]!.payload).toMatchObject({ sessionId: "sess-1", refusalBaseline: 0 });
    expect(typeof starts[0]!.payload.startedAt).toBe("number");

    // A restart is a fresh app over the same journal with no in-process state:
    // the refusal must be re-derived from the store, not remembered. This is the
    // assertion that makes the case's name true — an in-memory-only mark passes
    // everything above and fails here.
    const restarted = await fixture({ evidence: async () => null, probe: async () => 0, stateDir: dir, existingConversationId: conversation.id });
    const afterRestart = await post(restarted.app, conversation.id, restarted.headers);
    expect(afterRestart.statusCode, JSON.stringify(afterRestart.json())).toBe(409);
    expect(afterRestart.json().error.code).toBe("handoff_in_flight");
    await app.close();
    await restarted.app.close();
  });

  it("abandons a marker older than the age backstop, so an unprovable operation cannot lock handoff out forever", async () => {
    // The one genuinely undecidable case — a paste landed, the journal shows no
    // entry, and the pane says nothing — is bounded by the age backstop. It is
    // the last resort, so it must actually fire: a marker past the TTL is
    // abandoned and the next handoff proceeds.
    const { app, headers, conversation, store } = await fixture({ evidence: async () => null, probe: async () => 0 });
    const longAgo = Date.now() - (150 * 60_000 + 60_000);
    await store.recordEvent(conversation.id, "handoff-start", { sessionId: "sess-1", startedAt: longAgo, refusalBaseline: 0 }, new Date(longAgo).toISOString());
    const response = await post(app, conversation.id, headers);
    expect(response.statusCode, JSON.stringify(response.json())).toBe(200);
    expect(response.json().data.state).toBe("delivered");
    // The abandoned marker was replaced, not merely bypassed: exactly one live
    // start now stands, so the *new* operation is still protected.
    const second = await post(app, conversation.id, headers);
    expect(second.statusCode).toBe(409);
    expect(second.json().error.code).toBe("handoff_in_flight");
    await app.close();
  });

  it("lets a handoff through once the native entry for the previous one is observed", async () => {
    let seen = 0;
    const { app, headers, conversation } = await fixture({ evidence: async () => (seen++ === 0 ? null : { entryId: "e1", timestamp: new Date().toISOString() }) });
    expect((await post(app, conversation.id, headers)).json().data.state).toBe("delivered");
    // Second call: the marker's handoff now has a matching compaction entry, so
    // the previous operation is provably over.
    const second = await post(app, conversation.id, headers);
    expect(second.statusCode).toBe(200);
    await app.close();
  });

  it("refuses a non-managed conversation and one without a recorded tmux identity", async () => {
    const external = await fixture({ conversation: { ownership: "external" } });
    const externalResponse = await post(external.app, external.conversation.id, external.headers);
    expect(externalResponse.statusCode).toBe(409);
    expect(externalResponse.json().error.code).toBe("conflict_owner");
    await external.app.close();

    const untracked = await fixture({ conversation: { tmuxSessionId: null, tmuxServerIdentity: null, tmuxPanePid: null } });
    const untrackedResponse = await post(untracked.app, untracked.conversation.id, untracked.headers);
    expect(untrackedResponse.statusCode).toBe(409);
    expect(untrackedResponse.json().error.code).toBe("conflict_owner");
    await untracked.app.close();
  });

  it("refuses when the recorded tmux server is no longer the live one", async () => {
    const { app, headers, conversation } = await fixture({ liveIdentity: "other:9:9" });
    const response = await post(app, conversation.id, headers);
    expect(response.statusCode).toBe(409);
    expect(response.json().error.code).toBe("conflict_owner");
    await app.close();
  });

  it("never claims idle on absent registry evidence", async () => {
    const cases: Array<Record<string, unknown> | null> = [
      null,
      { sessionId: "sess-1", access: "control", relayConnected: true, busy: null, inputRequired: false },
      { sessionId: "sess-1", access: "control", relayConnected: true, busy: false, inputRequired: null },
      { sessionId: "sess-1", access: "control", relayConnected: null, busy: false, inputRequired: false },
      { sessionId: "sess-1", access: "view", relayConnected: true, busy: false, inputRequired: false },
    ];
    for (const host of cases) {
      let proof: boolean | null = null;
      const { app, headers, conversation } = await fixture({
        host: host as never,
        handoff: async (input) => { proof = await input.assertIdle(); return { delivered: false, refusal: "not_idle", reason: (proof ? "" : "not idle") as string } as HandoffResult; },
      });
      const response = await post(app, conversation.id, headers);
      expect(proof).toBe(false);
      expect(response.statusCode).toBe(409);
      await app.close();
    }
  });

  it("maps an attached terminal to its own code so the client can say 'run it yourself'", async () => {
    const { app, headers, conversation } = await fixture({
      handoff: async () => ({ delivered: false, refusal: "terminal_attached", reason: "A terminal is attached." }),
    });
    const response = await post(app, conversation.id, headers);
    expect(response.statusCode).toBe(409);
    expect(response.json().error.code).toBe("terminal_attached");
    await app.close();
  });

  it("maps every other adapter refusal to conflict_owner rather than a 500", async () => {
    for (const refusal of ["session_missing", "identity_changed", "pane_ambiguous", "pane_changed", "command_changed", "process_changed"] as const) {
      const { app, headers, conversation } = await fixture({ handoff: async () => ({ delivered: false, refusal, reason: "no" }) });
      const response = await post(app, conversation.id, headers);
      expect(response.statusCode).toBe(409);
      expect(response.json().error.code).toBe("conflict_owner");
      await app.close();
    }
  });

  it("refuses a concurrent second handoff while the first is in flight", async () => {
    // Node 20 has no `Promise.withResolvers`, so the executor form is the only
    // way to expose these resolvers here.
    let releaseGate = () => {};
    let signalEntered = () => {};
    const gate = new Promise<void>((resolve) => { releaseGate = resolve; });
    const entered = new Promise<void>((resolve) => { signalEntered = resolve; });
    const { app, headers, conversation } = await fixture({
      handoff: async () => { signalEntered(); await gate; return { delivered: true, sessionId: "$0", paneId: "%0", panePid: 42 }; },
      evidence: async () => null,
      probe: async () => 0,
    });
    const first = post(app, conversation.id, headers);
    // Wait for the first request to be *inside* the adapter call - its mark is
    // already taken and published - rather than guessing at a macrotask.
    await entered;
    const second = await post(app, conversation.id, headers);
    expect(second.statusCode).toBe(409);
    expect(second.json().error.code).toBe("handoff_in_flight");
    releaseGate();
    expect((await first).statusCode).toBe(200);
    await app.close();
  });

  it("refuses a non-empty focus argument with capability_missing", async () => {
    // `/handoff` takes no operand. A caller asking to focus something is asking
    // for keystrokes this server deliberately cannot send, so it is refused by
    // name — before any state is touched — rather than silently dropped.
    const { app, headers, conversation, store } = await fixture();
    const response = await post(app, conversation.id, headers, { focus: "editor" });
    expect(response.statusCode).toBe(409);
    expect(response.json().error.code).toBe("capability_missing");
    // The refusal precedes the operation window: nothing was typed and no marker
    // was taken, so a corrected retry is admitted.
    expect((await store.listEventsTail(conversation.id, Number.POSITIVE_INFINITY, 10))
      .some((event) => event.type === "handoff-start")).toBe(false);
    expect((await post(app, conversation.id, headers)).statusCode).toBe(200);
    await app.close();
  });

  it("404s an unknown conversation and 501s when handoff is not configured", async () => {
    const { app, headers } = await fixture();
    expect((await post(app, "missing-id", headers)).statusCode).toBe(404);
    await app.close();

    // The same conversation, on a server with no handoff adapter at all: the
    // capability is missing, which is a 501 — not a 500 and not a silent no-op.
    const dir = await mkdtemp(join(tmpdir(), "caw-handoff-nocfg-"));
    dirs.push(dir);
    const auth = createAuthenticationService({ stateDir: dir, setupOutput: () => undefined });
    await auth.initAuth();
    const config: ServerConfig = {
      host: "127.0.0.1", port: 8791, stateDir: dir, allowedRoots: [dir],
      relayPort: 8792, relayAllowedOrigins: [], maxActiveAgents: 3, authTokenTtlHours: 720,
      trustTailscaleOrigin: false, logLevel: "silent", insecureCookies: false,
    };
    const store = createMetadataStore(dir);
    const bare = buildApp({ config, auth, store, originAllowlist: ["https://workspace.test"] });
    const session = auth.createSession();
    const bareHeaders = { cookie: `__Host-caw_session=${session.token}`, origin: "https://workspace.test", "x-caw-csrf": session.csrfToken };
    const project = await store.createProject({ path: dir, label: "p" });
    const row = await store.createConversation({ projectId: project.id, title: "c" });
    await store.updateConversation(row.id, { ownership: "managed", nativeSessionId: "sess-1", tmuxSessionId: "$0", tmuxServerIdentity: "sock:1:2", tmuxPanePid: 42 });
    const response = await post(bare, row.id, bareHeaders);
    expect(response.statusCode).toBe(501);
    expect(response.json().error.code).toBe("capability_missing");
    await bare.close();
  });

  it("vacuously admits a later handoff when no native evidence reader is configured", async () => {
    // Without a reader an in-memory mark is the only guard, so this pins that
    // the durable path is not required for basic operation.
    const { app, headers, conversation } = await fixture({ evidence: null, handoff: async () => ({ delivered: true, sessionId: "$0", paneId: "%0", panePid: 42 }) });
    expect((await post(app, conversation.id, headers)).statusCode).toBe(200);
    expect((await post(app, conversation.id, headers)).statusCode).toBe(200);
    await app.close();
  });
});
