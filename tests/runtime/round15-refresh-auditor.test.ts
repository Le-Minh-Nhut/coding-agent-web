import { createMetadataStore } from "../../apps/server/src/store.js";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import path from "node:path";
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

it("V15 refresh: absent optional generation must not append identical metadata on every read", async()=>{
 const world=makeWorld();
 const seeded=world.seed({nativeSessionId:"native-A",nativeSessionPath:"/tmp/journal",tmuxSessionId:"$1",tmuxServerIdentity:"private-socket:1",tmuxPanePid:1002,hostInstanceId:"host-A",hostGeneration:3,state:"idle",statusDetail:"No turn in flight."});
 world.tmuxSessions.push({id:"$1",name:"managed-pane",alive:true,panePid:1002,serverIdentity:"private-socket:1"});
 world.hosts.push({instanceId:"host-A",generation:null,pid:1002,sessionId:"native-A",cwd:"/tmp/project",model:"m",participants:1,relayConnected:true,inputRequired:false,busy:false,access:"control"});
 world.setLease(true);
 const dir=await mkdtemp("/tmp/caw-audit15-refresh-");
 try{
  const store=createMetadataStore(dir);const project=await store.createProject({path:"/tmp/project"});const c=await store.createConversation({projectId:project.id});
  await store.updateConversation(c.id,{...seeded,id:c.id,projectId:project.id});
  const supervisor=createSupervisor({store,adapters:world.adapters,maxActive:3});
  await supervisor.refresh(c.id);
  const before=Buffer.byteLength(await readFile(path.join(dir,"metadata.jsonl"),"utf8"));
  for(let i=0;i<25;i++)await supervisor.refresh(c.id);
  const after=Buffer.byteLength(await readFile(path.join(dir,"metadata.jsonl"),"utf8"));
  console.log("AUDIT15 refresh append",JSON.stringify({refreshes:25,bytesBefore:before,bytesAfter:after,additionalBytes:after-before}));
  expect(after).toBe(before);
 }finally{await rm(dir,{recursive:true,force:true});}
});
it("V15 refresh: an effective model change is persisted even when state and room identity stay stable",async()=>{
 const world=makeWorld();
 world.seed({nativeSessionId:"native-A",nativeSessionPath:"/tmp/journal",tmuxSessionId:"$1",tmuxServerIdentity:"private-socket:1",tmuxPanePid:1002,hostInstanceId:"host-A",hostGeneration:3,model:"old-model",state:"idle",statusDetail:"No turn in flight."});
 world.tmuxSessions.push({id:"$1",name:"managed-pane",alive:true,panePid:1002,serverIdentity:"private-socket:1"});
 world.hosts.push({instanceId:"host-A",generation:3,pid:1002,sessionId:"native-A",cwd:"/tmp/project",model:"new-model",participants:1,relayConnected:true,inputRequired:false,busy:false,access:"control"});
 world.setLease(true);
 const supervisor=createSupervisor({store:world.store,adapters:world.adapters,maxActive:3});
 const refreshed=await supervisor.refresh("c1");
 console.log("AUDIT15 stale effective model",JSON.stringify({observed:world.hosts[0]!.model,persisted:refreshed?.model}));
 expect(refreshed?.model).toBe("new-model");
});
it("V15 publication: a missing tmux observation must not claim a live recorded PID exited",async()=>{
 const world=makeWorld(); world.seed();
 world.adapters.launch=async()=>({id:"$1",name:"pane",alive:true,panePid:process.pid,serverIdentity:"private-socket:1"});
 const supervisor=createSupervisor({store:world.store,adapters:world.adapters,clock:instantClock,publishTimeoutMs:50,publishPollMs:1,maxActive:3});
 const result=await supervisor.start("c1",{conversationId:"c1",name:"pane",cwd:"/tmp",ompBinary:"omp",env:{}} as RuntimeLaunchSpec);
 console.log("AUDIT15 false startup exit",JSON.stringify({pidAlive:true,state:result.state,detail:result.statusDetail,events:world.events}));
 expect(result.state).not.toBe("error");
 expect(world.events.some(e=>e.type==="agent.exited")).toBe(false);
});
