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
it("V16 deletion: launch beginning during observation must still block project deletion", async()=>{
 const {app:initialApp,headers,store,dir,auth,config}=await fixture();await initialApp.close();
 const p=await store.createProject({path:dir});const c=await store.createConversation({projectId:p.id});
 let releaseObserve!:()=>void;let seenObserve!:()=>void;
 const observed=new Promise<void>(resolve=>seenObserve=resolve);
 const observeGate=new Promise<void>(resolve=>releaseObserve=resolve);
 let releaseLaunch!:(pane:any)=>void;let seenLaunch!:()=>void;
 const launching=new Promise<void>(resolve=>seenLaunch=resolve);
 const launchGate=new Promise<any>(resolve=>releaseLaunch=resolve);
 const killed:string[]=[];
 const adapters:any={listManagedTmux:async()=>[],listHosts:async()=>[],isSessionLive:async()=>false,tmuxServerIdentity:async()=>"private:1",getTmux:async()=>({ok:true,session:null}),sessionPathExists:async()=>false,findBySessionId:async()=>null,isProcessDescendant:async()=>false,newestSessionFor:async()=>null,launch:async()=>{seenLaunch();return launchGate;},killTmux:async(id:string)=>{killed.push(id);}};
 const supervisor=createSupervisor({store,adapters,maxActive:3,publishTimeoutMs:1});
 const observe=supervisor.observe;
 supervisor.observe=async(id:string)=>{const result=await observe(id);seenObserve();await observeGate;return result;};
 const app=buildApp({config,auth,store,supervisor,originAllowlist:["https://workspace.test"]});
 let start:Promise<unknown>|undefined;
 try{
  const deletion=app.inject({method:"DELETE",url:`/api/projects/${p.id}`,headers}).then(r=>r);
  await observed;
  start=supervisor.start(c.id,{conversationId:c.id,name:"pane",cwd:dir}).catch(e=>String(e));
  await launching;expect(supervisor.isLaunching(c.id)).toBe(true);
  releaseObserve();const response=await deletion;
  const projectRemains=(await store.listProjects()).some(row=>row.id===p.id);
  console.log("AUDIT16 delete/start race",JSON.stringify({status:response.statusCode,isLaunching:supervisor.isLaunching(c.id),projectRemains,conversationRemains:!!await store.getConversation(c.id)}));
  expect(response.statusCode).toBe(409);
 }finally{releaseObserve?.();releaseLaunch?.({id:"$1",name:"pane",alive:true,panePid:1000000000,serverIdentity:"private:1"});await start;await app.close();}
});
