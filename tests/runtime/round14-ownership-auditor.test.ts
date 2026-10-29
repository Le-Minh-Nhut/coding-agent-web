import { mkdtemp, rm } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import type { Conversation } from "@caw/contracts";
import { createSupervisor } from "@caw/runtime";
import type {
  ConversationRuntimeStore,
  RuntimeAdapters,
  RuntimeHost,
  RuntimeLaunchSpec,
  RuntimeTmuxSession,
} from "@caw/runtime";
import type { TmuxSession } from "../../packages/omp-adapter/src/types.js";

function runtimeSession(session: TmuxSession): RuntimeTmuxSession {
  return {
    id: session.id,
    name: session.name,
    alive: session.alive,
    panePid: session.panePid,
    serverIdentity: session.serverIdentity,
  };
}

/** A controllable world: tmux sessions, rooms, leases, and a journal of events. */
function makeWorld() {
  const tmuxSessions: RuntimeTmuxSession[] = [];
  const hosts: RuntimeHost[] = [];
  let lease: boolean | "unknown" = false;
  let registryThrows = false;
  let tmuxListThrows = false;
  let probeFails = false;
  let storeWriteThrows = false;
  let killThrows = false;
  let nextId = 1;
  let tmuxServerIdentity: string | null = "private-socket:1";

  const events: Array<{ conversationId: string; type: string; payload: unknown }> = [];
  const launches: RuntimeLaunchSpec[] = [];
  const kills: string[] = [];

  const adapters: RuntimeAdapters = {
    async listHosts() {
      if (registryThrows) throw new Error("registry unreadable");
      return hosts;
    },
    async listManagedTmux() {
      if (tmuxListThrows) throw new Error("tmux enumeration failed");
      return tmuxSessions;
    },
    async getTmux(id) {
      if (probeFails) return { ok: false as const, reason: "tmux probe could not run" };
      return { ok: true as const, session: tmuxSessions.find((session) => session.id === id) ?? null };
    },
    async isProcessDescendant(candidatePid, panePid) {
      return candidatePid === panePid;
    },
    async tmuxServerIdentity() {
      return tmuxServerIdentity;
    },
    async launch(spec) {
      launches.push(spec);
      const session: RuntimeTmuxSession = {
        id: `$${nextId++}`,
        name: spec.name,
        alive: true,
        panePid: 1000 + nextId,
        serverIdentity: tmuxServerIdentity ?? "private-socket:1",
      };
      tmuxSessions.push(session);
      return session;
    },
    async killTmux(id, expectedIdentity) {
      expect(expectedIdentity).toBe(tmuxServerIdentity);
      kills.push(id);
      if (killThrows) throw new Error("injected guarded kill failure");
      const index = tmuxSessions.findIndex((session) => session.id === id);
      if (index >= 0) tmuxSessions.splice(index, 1);
    },
    async isSessionLive() {
      return lease;
    },
    async newestSessionFor() {
      return null;
    },
    async sessionPathExists() {
      return true;
    },
    async findBySessionId() {
      return "/tmp/sessions/journal.jsonl";
    },
  };

  const conversations = new Map<string, Conversation>();
  const reserved = new Set<string>();
  const store: ConversationRuntimeStore = {
    async getConversation(id) {
      return conversations.get(id) ?? null;
    },
    async listAllConversations() {
      return [...conversations.values()];
    },
    async updateConversation(id, patch) {
      const current = conversations.get(id);
      if (!current) return null;
      if (storeWriteThrows) throw new Error("simulated store write failure after tmux launch");
      const next = { ...current, ...patch, updatedAt: new Date().toISOString() };
      conversations.set(id, next);
      return next;
    },
    async updateConversationIfCurrent(id, expectedEpoch, patch) {
      const current = conversations.get(id);
      if (!current) return null;
      if ((current.lifecycleEpoch ?? 0) !== expectedEpoch) return { conversation: current, applied: false };
      if (storeWriteThrows) throw new Error("simulated store write failure after tmux launch");
      const next = { ...current, ...patch, updatedAt: new Date().toISOString() };
      conversations.set(id, next);
      return { conversation: next, applied: true };
    },
    async recordEvent(conversationId, type, payload) {
      events.push({ conversationId, type, payload });
      return { conversationId, type, payload };
    },
    async reserveLaunch(id: string) {
      if (!conversations.has(id)) return false;
      reserved.add(id);
      return true;
    },
    releaseLaunch(id: string) {
      reserved.delete(id);
    },
    isLaunchReserved(id: string) {
      return reserved.has(id);
    },
  };

  function seed(over: Partial<Conversation> = {}): Conversation {
    const conversation: Conversation = {
      id: over.id ?? "c1",
      projectId: "p1",
      nativeSessionId: null,
      nativeSessionPath: null,
      title: "conversation",
      model: null,
      ownership: "managed",
      state: "starting",
      tmuxSessionId: null,
      tmuxSessionName: null,
      tmuxServerIdentity: null, tmuxPanePid: null,
      hostInstanceId: null,
      hostGeneration: null,
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
      lastActivityAt: null,
      statusDetail: null,
      ...over,
    };
    conversations.set(conversation.id, conversation);
    return conversation;
  }

  return {
    adapters,
    store,
    seed,
    tmuxSessions,
    hosts,
    events,
    launches,
    kills,
    setLease: (value: boolean | "unknown") => {
      lease = value;
    },
    breakRegistry: (value: boolean) => {
      registryThrows = value;
    },
    breakTmuxList: (value: boolean) => {
      tmuxListThrows = value;
    },
    breakTmuxProbe: (value: boolean) => {
      probeFails = value;
    },
    breakStoreWrites: (value: boolean) => {
      storeWriteThrows = value;
    },
    breakKills: (value: boolean) => {
      killThrows = value;
    },
    setServerIdentity: (value: string | null) => {
      tmuxServerIdentity = value;
    },
  };
}

const instantClock = {
  now: () => Date.now(),
  sleep: async () => {},
};

/**
 * A clock whose sleeps return immediately but whose time still advances past any
 * deadline. `now()` is derived from the number of sleeps, so a loop bounded by a
 * deadline cannot spin: it either exits on the first poll or runs out of time.
 * `BOUNDED_POLL_MS` keeps any deadline from being reached before the first poll,
 * so the branch under test is always entered exactly once.
 */
const BOUNDED_POLL_MS = 1_000_000;
function boundedClock(): { now: () => number; sleep: () => Promise<void> } {
  let t = 0;
  return {
    now: () => (t += BOUNDED_POLL_MS),
    sleep: async () => {},
  };
}

it("V14 ownership: refresh cannot label an external native host as managed by an unrelated pane",async()=>{
 const world=makeWorld();
 world.seed({nativeSessionId:"native-A",tmuxSessionId:"$1",tmuxServerIdentity:"private-socket:1",tmuxPanePid:1002,hostInstanceId:"old-host",hostGeneration:1,state:"running"});
 world.tmuxSessions.push({id:"$1",name:"managed-pane",alive:true,panePid:1002,serverIdentity:"private-socket:1"});
 // The owner switched the managed TUI to B; A is now resumed in an external TUI.
 world.hosts.push({instanceId:"external-A",generation:2,pid:9000,sessionId:"native-A",cwd:"/tmp/project",model:"m",participants:1,relayConnected:true,inputRequired:false,busy:true,access:"control"});
 world.hosts.push({instanceId:"managed-B",generation:1,pid:1002,sessionId:"native-B",cwd:"/tmp/project",model:"m",participants:1,relayConnected:true,inputRequired:false,busy:true,access:"control"});
 world.setLease(true);
 const supervisor=createSupervisor({store:world.store,adapters:world.adapters,clock:instantClock,maxActive:3});
 const refreshed=await supervisor.refresh("c1");
 let stopRefused=false;
 try{await supervisor.stop("c1",20);}catch{stopRefused=true;}
 console.log("AUDIT12 host ownership",JSON.stringify({native:refreshed?.nativeSessionId,host:refreshed?.hostInstanceId,ownership:refreshed?.ownership,panePid:refreshed?.tmuxPanePid,selectedHostPid:9000,killed:world.kills,stopRefused}));
 expect(world.kills).toEqual([]);
 expect(refreshed?.ownership === "external" || refreshed?.state === "unknown").toBe(true);
});
