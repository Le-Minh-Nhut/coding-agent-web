import { mkdtemp, mkdir, rm, readFile, appendFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import ts from "typescript";
import { evaluateState } from "../../packages/runtime/src/state.js";
import type { Observations } from "../../packages/runtime/src/state.js";
import { afterEach, describe, expect, it } from "vitest";
import { createAuthenticationService } from "../../apps/server/src/auth.js";
import { createRuntimeSpec, launchWithOverlay } from "../../apps/server/src/server.js";
import { buildApp } from "../../apps/server/src/app.js";
import type { Conversation, NativeSessionSummary } from "@caw/contracts";
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
  return { app, headers, dir, store };
}

it("V13 API: project listing supplies its declared statistics", async()=>{
 const {app,headers,store,dir}=await fixture();
 try {
  const project=await store.createProject({path:dir,label:"Audit project"});
  const conversation=await store.createConversation({projectId:project.id});
  await store.updateConversation(conversation.id,{lastActivityAt:"2026-10-29T09:00:00.000Z"});
  const response=await app.inject({method:"GET",url:"/api/projects",headers:{cookie:headers.cookie}});
  const row=response.json().data[0];
  console.log("AUDIT13 real project API",JSON.stringify(row));
  expect(row).toMatchObject({conversationCount:1,lastActivityAt:"2026-10-29T09:00:00.000Z"});
 } finally {await app.close();}
});
it.each(["EACCES","EIO"]) ("V13 wiring: %s journal probe failure stays unknown, not missing", async(code)=>{
 const source=await readFile("apps/server/src/server.ts","utf8");
 const start=source.indexOf("sessionPathExists: async (sessionPath) => {");
 const end=source.indexOf("\n    findBySessionId:",start);
 if(start<0||end<0)throw new Error("Production adapter source not found");
 const expression="({"+source.slice(start,end)+"})";
 const codeJs=ts.transpileModule("const adapter = "+expression+";",{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.ESNext}}).outputText;
 const adapter=Function("stat",codeJs+"return adapter;")(async()=>{throw Object.assign(new Error("probe failed"),{code});}) as { sessionPathExists(path: string): Promise<boolean> };
 let observation: boolean|"unknown";
 try{observation=await adapter.sessionPathExists("/work/session.jsonl");}catch{observation="unknown";}
 const observations: Observations = { observedEpoch:0,tmux:null,host:null,leaseLive:false,sessionPathExists:observation,sessionPathReason:null,hasNativeSession:true,everLaunched:true,stopRequested:false,registryUnreadable:false,tmuxOwnershipUnknown:false,tmuxEnumerationFailed:false,tmuxEnumerationReason:null };
 const verdict=evaluateState(observations);
 console.log("AUDIT13 production journal probe",JSON.stringify({code,observation,verdict}));
 expect(verdict.state).toBe("unknown");
});
it("V13 store: a torn final append does not make all earlier metadata unavailable",async()=>{
 const {app,store,dir}=await fixture();
 try{
  const project=await store.createProject({path:dir,label:"Persisted"});
  await appendFile(join(dir,"metadata.jsonl"),'{"op":"conversation","value":');
  const reopened=createMetadataStore(dir);
  let recovered:any=null,error:string|null=null;
  try{recovered=await reopened.listProjects();}catch(e){error=String(e);}
  console.log("AUDIT13 partial journal",JSON.stringify({recovered,error}));
  expect(error).toBeNull();
  expect(recovered).toContainEqual(project);
 }finally{await app.close();}
});

it("V13 store control: complete metadata survives reopen",async()=>{
 const {app,store,dir}=await fixture();
 try{const project=await store.createProject({path:dir,label:"Complete"});expect(await createMetadataStore(dir).listProjects()).toEqual([project]);}finally{await app.close();}
});
it("V13 project badge: a registered child directory is marked as a project",async()=>{
 const {app,headers,store,dir}=await fixture();
 try{
  const child=join(dir,"registered");await mkdir(child);await store.createProject({path:child,label:"Registered"});
  const response=await app.inject({method:"GET",url:"/api/browse?"+new URLSearchParams({path:dir,limit:"100"}),headers:{cookie:headers.cookie}});
  const entry=response.json().data.entries.find((entry:any)=>entry.path===child);
  console.log("AUDIT13 project browse badge",JSON.stringify(entry));
  expect(entry.hasProject).toBe(true);
 }finally{await app.close();}
});
