import { mkdtemp, mkdir, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RuntimeError, createSupervisor } from "@caw/runtime";
import { afterEach, describe, expect, it } from "vitest";
import { createAuthenticationService } from "../../apps/server/src/auth.js";
import { createRuntimeSpec, launchWithOverlay } from "../../apps/server/src/server.js";
import { buildApp } from "../../apps/server/src/app.js";
import type { Conversation, NativeSessionSummary, Project } from "@caw/contracts";
import type { RuntimeLaunchSpec, Supervisor } from "@caw/runtime";
import type { CollabHost, NativeSessionHistory } from "@caw/omp-adapter";
import type { ServerConfig } from "../../apps/server/src/config.js";
import type { WorkspacePathPolicy } from "../../apps/server/src/path-policy.js";
import { createMetadataStore } from "../../apps/server/src/store.js";

const dirs: string[] = [];
afterEach(async () => { await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true }))); });
async function fixture(options: { paths?: WorkspacePathPolicy; tmuxSocketPath?: string; tmuxServerIdentity?: () => Promise<string | null>; supervisor?: Supervisor; runtimeSpec?: (conversation: Conversation, input: { resumeSessionId?: string; model?: string }) => Promise<RuntimeLaunchSpec> | RuntimeLaunchSpec; modelCatalog?: { listModels(): Promise<string[]>; listModelsDetailed(): Promise<{ models: string[]; source: "omp" | "unavailable"; reason: string | null }> }; listNativeSessions?: (conversation: { projectPath: string }) => Promise<Array<Omit<NativeSessionSummary, "hasCollabHost">>>; listCollabHosts?: () => Promise<CollabHost[]>; findLiveHost?: (sessionId: string) => Promise<CollabHost | null>; readNativeHistory?: (sessionId: string, expectedCwd: string, options?: { before?: string }) => Promise<NativeSessionHistory> } = {}) {
  const dir = await mkdtemp(join(tmpdir(), "caw-app-")); dirs.push(dir);
  const auth = createAuthenticationService({ stateDir: dir, setupOutput: () => undefined }); await auth.initAuth();
  const config: ServerConfig = { host: "127.0.0.1", port: 8791, stateDir: dir, allowedRoots: [dir], relayPort: 8792, relayAllowedOrigins: [], maxActiveAgents: 3, authTokenTtlHours: 720, trustTailscaleOrigin: false, logLevel: "silent", insecureCookies: false };
  const store = createMetadataStore(dir);
  const app = buildApp({ config, auth, store, originAllowlist: ["https://workspace.test"], ...options });
  const session = auth.createSession();
  const headers = { cookie: `__Host-caw_session=${session.token}`, origin: "https://workspace.test", "x-caw-csrf": session.csrfToken };
  return { app, headers, dir, store, config, auth };
}
it("V15 deletion: a running managed conversation must not lose its only reachable project",async()=>{
 const {app:initialApp,headers,store,dir,auth,config}=await fixture();
 await initialApp.close();
 const pane={id:"$1",name:"pane",alive:true,panePid:process.pid,serverIdentity:"private:1"};
 const adapters:any={listManagedTmux:async()=>[pane],listHosts:async()=>[],isSessionLive:async()=>true,tmuxServerIdentity:async()=>"private:1",getTmux:async()=>({ok:true,session:pane}),sessionPathExists:async()=>true,findBySessionId:async()=>null,isProcessDescendant:async(a:number,b:number)=>a===b};
 const supervisor=createSupervisor({store,adapters,maxActive:3});
 const app=buildApp({config,auth,store,supervisor,originAllowlist:["https://workspace.test"]});
 try{
  const project=await store.createProject({path:dir,label:"Active project"});
  const conversation=await store.createConversation({projectId:project.id});
  await store.updateConversation(conversation.id,{state:"running",tmuxSessionId:"$1",tmuxServerIdentity:"private:1",tmuxPanePid:process.pid,nativeSessionId:"live-native"});
  const before=await supervisor.activeCount();
  const response=await app.inject({method:"DELETE",url:`/api/projects/${project.id}`,headers});
  let replacement: Project | null = null;
  let readdRefused: string | null = null;
  // Harness adaptation: with the delete refused the project must still exist, so
  // re-adding the same path is expected to be rejected. The original probe had no
  // guard because the old behaviour deleted the project; the assertion below is
  // unchanged.
  try { replacement = await store.createProject({path:dir,label:"Same path again"}); }
  catch (error) { readdRefused = error instanceof Error ? error.message : String(error); }
  const old=await store.getConversation(conversation.id);
  const visible=replacement ? await store.listConversations(replacement.id) : await store.listConversations(project.id);
  console.log("AUDIT15 orphan project",JSON.stringify({activeCountBefore:before.count,activeCountAfter:(await supervisor.activeCount()).count,deleteStatus:response.statusCode,readdRefused,orphanStillRunning:old?.state,newProjectConversations:visible.length,oldProjectExists:(await store.listProjects()).some(p=>p.id===old?.projectId)}));
  expect(response.statusCode).toBe(409);
  // Strengthened: the refusal must actually be a refusal. Either re-adding the same
  // path is rejected, or the project is still there — and in every case the live
  // conversation keeps its reachable project and is still accounted for.
  expect(old).not.toBeNull();
  expect((await store.listProjects()).some(p=>p.id===old?.projectId)).toBe(true);
  expect(old?.state).toBe("running");
  if (replacement) expect(visible.map(c=>c.id)).toEqual([conversation.id]);
  else expect(readdRefused).toMatch(/already exists/i);
 }finally{await app.close();}
});
it("V15 control: oversized event limit clamps to 500 and all pages stay reachable",async()=>{
 const {app,headers,store,dir}=await fixture();
 try{
  const p=await store.createProject({path:dir}); const c=await store.createConversation({projectId:p.id});
  for(let i=0;i<1001;i++)await store.recordEvent(c.id,"audit.event",{i});
  const response=await app.inject({method:"GET",url:`/api/conversations/${c.id}/events?limit=1000`,headers:{cookie:headers.cookie}});
  const data=response.json().data;
  console.log("AUDIT15 max events page",JSON.stringify({status:response.statusCode,length:data.events.length,nextAfter:data.nextAfter,total:(await store.listEvents(c.id,1000,10)).length+1000}));
  expect(data.events).toHaveLength(500);
  expect(data.nextAfter).toBe(500);
  const next=(await app.inject({method:"GET",url:`/api/conversations/${c.id}/events?limit=1000&after=500`,headers:{cookie:headers.cookie}})).json().data;
  const last=(await app.inject({method:"GET",url:`/api/conversations/${c.id}/events?limit=1000&after=1000`,headers:{cookie:headers.cookie}})).json().data;
  expect(next.nextAfter).toBe(1000);
  expect(last.events).toHaveLength(1);
  expect(last.nextAfter).toBeNull();
 }finally{await app.close();}
});
it("V15 launch failure: a refused creation must not remain falsely starting",async()=>{
 const supervisor={start:async()=>{throw new RuntimeError("conflict_limit","No active slots");}} as unknown as Supervisor;
 const {app,headers,store,dir}=await fixture({supervisor,runtimeSpec:()=>({} as RuntimeLaunchSpec)});
 try{
  const p=await store.createProject({path:dir});
  const response=await app.inject({method:"POST",url:`/api/projects/${p.id}/conversations`,headers,payload:{resumeSessionId:"saved-session"}});
  const rows=await store.listConversations(p.id);
  console.log("AUDIT15 failed creation",JSON.stringify({status:response.statusCode,rows:rows.map(({state,nativeSessionId,tmuxSessionId})=>({state,nativeSessionId,tmuxSessionId}))}));
  expect(response.statusCode).toBe(409);
  expect(rows.every(row=>row.state!=="starting")).toBe(true);
 }finally{await app.close();}
});
