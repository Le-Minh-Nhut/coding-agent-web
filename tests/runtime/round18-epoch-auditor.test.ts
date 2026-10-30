import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { epochOf, observationSeqOf } from "@caw/contracts";
import { createSupervisor, type RuntimeAdapters, type RuntimeHost, type RuntimeTmuxSession } from "@caw/runtime";
import { createMetadataStore } from "../../apps/server/src/store.js";

function deferred<T>() { let resolve!: (value:T)=>void; const promise=new Promise<T>(r=>resolve=r);return {promise,resolve}; }
const host=(model="model-A"):RuntimeHost=>({instanceId:"host-A",generation:1,pid:1000000001,sessionId:"native-A",cwd:"/work",model,participants:0,relayConnected:true,inputRequired:false,busy:false,access:"control"});
const pane:RuntimeTmuxSession={id:"$1",name:"pane",alive:true,panePid:1000000001,serverIdentity:"private:1"};

it.each([false,true])("V18 publication still commits after a routine refresh during startup=%s",async(withRefresh)=>{
 const dir=await mkdtemp(join(tmpdir(),"caw-r18-publish-"));
 try{
  const store=createMetadataStore(dir);const p=await store.createProject({path:dir});const c=await store.createConversation({projectId:p.id});
  let sessions:RuntimeTmuxSession[]=[],hosts:RuntimeHost[]=[];const sleeping=deferred<void>(),release=deferred<void>();let time=0;
  const adapters:RuntimeAdapters={listManagedTmux:async()=>[...sessions],listHosts:async()=>[...hosts],isSessionLive:async()=>hosts.length>0,sessionPathExists:async()=>true,findBySessionId:async()=>"/tmp/native-A",newestSessionFor:async()=>null,isProcessDescendant:async(pid,parent)=>pid===parent,tmuxServerIdentity:async()=>"private:1",getTmux:async()=>({ok:true,session:sessions[0]??null}),killTmux:async()=>{},launch:async()=>{sessions=[pane];return pane;}};
  const supervisor=createSupervisor({store,adapters,maxActive:3,publishTimeoutMs:10,publishPollMs:1,clock:{now:()=>time,sleep:async(ms)=>{sleeping.resolve();await release.promise;time+=ms;}}});
  const starting=supervisor.start(c.id,{conversationId:c.id,name:"pane",cwd:dir});await sleeping.promise;
  const before=(await store.getConversation(c.id))!;
  if(withRefresh)await supervisor.refresh(c.id);
  hosts=[host()];release.resolve();const result=await starting;
  console.log("AUDIT18 publication refresh",JSON.stringify({withRefresh,launchEpoch:epochOf(before),finalEpoch:epochOf(result),state:result.state,nativeSessionId:result.nativeSessionId,hostInstanceId:result.hostInstanceId,hostedEvents:(await store.listEvents(c.id)).filter(e=>e.type==="agent.hosted").length}));
  expect(result.nativeSessionId).toBe("native-A");expect(result.state).toBe("idle");
 }finally{await rm(dir,{recursive:true,force:true});}
});

it("V18 an older model-only refresh cannot overwrite a newer model-only refresh",async()=>{
 const dir=await mkdtemp(join(tmpdir(),"caw-r18-model-"));
 try{
  const store=createMetadataStore(dir);const p=await store.createProject({path:dir});const c=await store.createConversation({projectId:p.id,nativeSessionId:"native-A"});
  await store.updateConversation(c.id,{nativeSessionPath:"/tmp/native-A",tmuxSessionId:pane.id,tmuxServerIdentity:pane.serverIdentity,tmuxPanePid:pane.panePid,hostInstanceId:"host-A",hostGeneration:1,state:"idle",statusDetail:"No turn in flight.",model:"seed-model"});
  const firstEntered=deferred<void>(),firstGate=deferred<boolean>();let probes=0;let currentHost=host("older-model");
  const adapters:RuntimeAdapters={listManagedTmux:async()=>[pane],listHosts:async()=>[{...currentHost}],isSessionLive:async()=>true,sessionPathExists:async()=>{if(++probes===1){firstEntered.resolve();return firstGate.promise;}return true;},findBySessionId:async()=>"/tmp/native-A",newestSessionFor:async()=>null,isProcessDescendant:async(pid,parent)=>pid===parent,tmuxServerIdentity:async()=>"private:1",getTmux:async()=>({ok:true,session:pane}),killTmux:async()=>{},launch:async()=>{throw new Error("not used");}};
  const supervisor=createSupervisor({store,adapters,maxActive:3});
  // The first refresh samples `older-model`; the model moves forward while it is
  // still probing. The second refresh is serialized behind it and cannot read the
  // row or probe until the first has committed, so it reads the row the first left
  // and samples `newer-model`. The newest observation is the one that remains,
  // whichever order the two commits would have completed in.
  const older=supervisor.refresh(c.id);await firstEntered.promise;
  currentHost=host("newer-model");
  const newer=supervisor.refresh(c.id);
  firstGate.resolve(true);const olderResult=(await older)!;
  const newerResult=(await newer)!;const final=(await store.getConversation(c.id))!;
  console.log("AUDIT18 model freshness",JSON.stringify({olderModel:olderResult.model,newerModel:newerResult.model,finalModel:final.model,olderEpoch:epochOf(olderResult),finalEpoch:epochOf(final)}));
  expect(olderResult.model).toBe("older-model");
  expect(newerResult.model).toBe("newer-model");
  expect(final.model).toBe("newer-model");
 }finally{await rm(dir,{recursive:true,force:true});}
});

it("V18 a refresh in the post-spawn pre-record window cannot discard a legitimate resumed launch",async()=>{
 const dir=await mkdtemp(join(tmpdir(),"caw-r18-record-"));
 try{
  const store=createMetadataStore(dir);const p=await store.createProject({path:dir});const c=await store.createConversation({projectId:p.id,nativeSessionId:"native-A"});
  await store.updateConversation(c.id,{nativeSessionPath:"/tmp/native-A",state:"stopped",tmuxSessionId:"$0",tmuxServerIdentity:"private:1",tmuxPanePid:1000000000});
  let sessions:RuntimeTmuxSession[]=[],hosts:RuntimeHost[]=[];
  const entered=deferred<void>(),release=deferred<void>();const killed:string[]=[];
  const adapters:RuntimeAdapters={listManagedTmux:async()=>[...sessions],listHosts:async()=>[...hosts],isSessionLive:async()=>hosts.length>0,sessionPathExists:async()=>true,findBySessionId:async()=>"/tmp/native-A",newestSessionFor:async()=>null,isProcessDescendant:async(pid,parent)=>pid===parent,tmuxServerIdentity:async()=>"private:1",getTmux:async()=>({ok:true,session:sessions[0]??null}),killTmux:async(id)=>{killed.push(id);sessions=[];hosts=[];},launch:async()=>{sessions=[pane];hosts=[host()];entered.resolve();await release.promise;return pane;}};
  const supervisor=createSupervisor({store,adapters,maxActive:3,publishTimeoutMs:0});
  const starting=supervisor.start(c.id,{conversationId:c.id,name:"pane",cwd:dir,resumeSessionPath:"/tmp/native-A"}).then(value=>({value,error:null as string|null}),error=>({value:null,error:String(error)}));
  await entered.promise;await supervisor.refresh(c.id);release.resolve();const result=await starting;
  console.log("AUDIT18 pre-record refresh",JSON.stringify({error:result.error,killed,finalState:(await store.getConversation(c.id))?.state,finalOwnership:(await store.getConversation(c.id))?.ownership}));
  expect(killed).toEqual([]);expect(result.error).toBeNull();
 }finally{await rm(dir,{recursive:true,force:true});}
});

it("V18 a refresh during the publish wait cannot stop the launch's own publish-timeout write",async()=>{
 const dir=await mkdtemp(join(tmpdir(),"caw-r18-timeout-"));
 try{
  const store=createMetadataStore(dir);const p=await store.createProject({path:dir});const c=await store.createConversation({projectId:p.id});
  let sessions:RuntimeTmuxSession[]=[],hosts:RuntimeHost[]=[];
  const slept=deferred<void>(),release=deferred<void>();let sleeps=0,time=0;
  const adapters:RuntimeAdapters={listManagedTmux:async()=>[...sessions],listHosts:async()=>[...hosts],isSessionLive:async()=>false,sessionPathExists:async()=>true,findBySessionId:async()=>null,newestSessionFor:async()=>null,isProcessDescendant:async(pid,parent)=>pid===parent,tmuxServerIdentity:async()=>"private:1",getTmux:async()=>({ok:true,session:sessions[0]??null}),killTmux:async()=>{},launch:async()=>{sessions=[pane];return pane;}};
  const supervisor=createSupervisor({store,adapters,maxActive:3,publishTimeoutMs:10,publishPollMs:1,clock:{now:()=>time,sleep:async(ms)=>{time+=ms;if(++sleeps===1){slept.resolve();await release.promise;}}}});
  const starting=supervisor.start(c.id,{conversationId:c.id,name:"pane",cwd:dir});
  await slept.promise;
  // The launch still holds the reservation, so the routine refresh is dropped
  // instead of stamping `unknown` + a fresh epoch onto the row mid-launch.
  const during=await supervisor.refresh(c.id);
  release.resolve();const result=await starting;
  const final=(await store.getConversation(c.id))!;
  console.log("AUDIT18 refresh during publish",JSON.stringify({duringState:during?.state,resultState:result.state,finalState:final.state,finalDetail:final.statusDetail,tmuxSessionId:final.tmuxSessionId,nativeSessionId:final.nativeSessionId}));
  expect(during?.state).toBe("starting");
  // The timeout verdict for THIS launch landed: the row is the launch's life, not
  // the refresh's `unknown`, and it still carries the launch's tmux identity.
  expect(result.state).toBe("starting");
  expect(final.tmuxSessionId).toBe("$1");
  expect(final.nativeSessionId).toBeNull();
 }finally{await rm(dir,{recursive:true,force:true});}
});

it("V18 a real stop during the publish wait beats the launch's late publish write",async()=>{
 const dir=await mkdtemp(join(tmpdir(),"caw-r18-stoppublish-"));
 try{
  const store=createMetadataStore(dir);const p=await store.createProject({path:dir});const c=await store.createConversation({projectId:p.id,nativeSessionId:"native-A"});
  await store.updateConversation(c.id,{nativeSessionPath:"/tmp/native-A",state:"stopped",tmuxSessionId:"$0",tmuxServerIdentity:"private:1",tmuxPanePid:1000000000});
  let sessions:RuntimeTmuxSession[]=[],hosts:RuntimeHost[]=[];
  const slept=deferred<void>(),release=deferred<void>();let sleeps=0,time=0;const killed:string[]=[];
  const adapters:RuntimeAdapters={listManagedTmux:async()=>[...sessions],listHosts:async()=>[...hosts],isSessionLive:async()=>false,sessionPathExists:async()=>true,findBySessionId:async()=>"/tmp/native-A",newestSessionFor:async()=>null,isProcessDescendant:async(pid,parent)=>pid===parent,tmuxServerIdentity:async()=>"private:1",getTmux:async(id)=>({ok:true,session:sessions.find(s=>s.id===id)??null}),killTmux:async(id)=>{killed.push(id);sessions=sessions.filter(s=>s.id!==id);},launch:async()=>{sessions=[pane];return pane;}};
  const supervisor=createSupervisor({store,adapters,maxActive:3,publishTimeoutMs:10,publishPollMs:1,clock:{now:()=>time,sleep:async(ms)=>{time+=ms;if(++sleeps===1){slept.resolve();await release.promise;}}}});
  const starting=supervisor.start(c.id,{conversationId:c.id,name:"pane",cwd:dir});
  await slept.promise;
  // A real stop settles the recorded pane and the row while the launch still waits.
  sessions=[pane];hosts=[host()];
  const stopped=await supervisor.stop(c.id);
  expect(stopped.state).toBe("stopped");
  expect(killed).toEqual(["$1"]);
  release.resolve();const result=await starting;
  const final=(await store.getConversation(c.id))!;
  console.log("AUDIT18 stop during publish",JSON.stringify({stopState:stopped.state,resultState:result.state,finalState:final.state,finalDetail:final.statusDetail,killed}));
  // The launch's late verdict is bound to the epoch the stop advanced, so the
  // settled `stopped` row stands and the stop was not undone.
  expect(result.state).toBe("stopped");
  expect(final.state).toBe("stopped");
  expect(final.tmuxSessionId).toBe("$1");
 }finally{await rm(dir,{recursive:true,force:true});}
});

it("V18 a real replacement makes the previous launch's publish write fail",async()=>{
 const dir=await mkdtemp(join(tmpdir(),"caw-r18-replace-"));
 try{
  const store=createMetadataStore(dir);const p=await store.createProject({path:dir});const c=await store.createConversation({projectId:p.id});
  let sessions:RuntimeTmuxSession[]=[],hosts:RuntimeHost[]=[];let next=1;
  const adapters:RuntimeAdapters={listManagedTmux:async()=>[...sessions],listHosts:async()=>[...hosts],isSessionLive:async()=>false,sessionPathExists:async()=>true,findBySessionId:async()=>null,newestSessionFor:async()=>null,isProcessDescendant:async(pid,parent)=>pid===parent,tmuxServerIdentity:async()=>"private:1",getTmux:async(id)=>({ok:true,session:sessions.find(s=>s.id===id)??null}),killTmux:async()=>{},launch:async()=>{const paneId=`$${next++}`;const session:RuntimeTmuxSession={id:paneId,name:"pane",alive:true,panePid:1000000000+next,serverIdentity:"private:1"};sessions=[session];hosts=[{...host(),pid:session.panePid,sessionId:"native-A"}];return session;}};
  const supervisor=createSupervisor({store,adapters,maxActive:3,publishTimeoutMs:10,publishPollMs:1,clock:{now:()=>0,sleep:async()=>{}}});
  const first=await supervisor.start(c.id,{conversationId:c.id,name:"pane-1",cwd:dir});
  const firstLaunchEpoch=epochOf(first);
  expect(first.state).toBe("idle");
  // The recorded process is gone; a real replacement records its own life.
  sessions=[];hosts=[];
  const second=await supervisor.start(c.id,{conversationId:c.id,name:"pane-2",cwd:dir});
  expect(second.tmuxSessionId).not.toBe(first.tmuxSessionId);
  // The first launch's publish write still names the life the row has left.
  const late=await store.updateConversationIfCurrent(c.id,firstLaunchEpoch,{state:"unknown",statusDetail:"The previous launch's late publish write."});
  const final=(await store.getConversation(c.id))!;
  console.log("AUDIT18 replacement",JSON.stringify({firstEpoch:firstLaunchEpoch,finalEpoch:epochOf(final),firstTmux:first.tmuxSessionId,secondTmux:second.tmuxSessionId,lateApplied:late?.applied,finalState:final.state}));
  expect(late?.applied).toBe(false);
  expect(final.state).toBe("idle");
  expect(final.tmuxSessionId).toBe(second.tmuxSessionId);
 }finally{await rm(dir,{recursive:true,force:true});}
});

it("V18 mirror: a delayed model-only refresh that read the same revision cannot overwrite the one that committed first",async()=>{
 const dir=await mkdtemp(join(tmpdir(),"caw-r18-model-mirror-"));
 try{
  const store=createMetadataStore(dir);const p=await store.createProject({path:dir});const c=await store.createConversation({projectId:p.id,nativeSessionId:"native-A"});
  await store.updateConversation(c.id,{nativeSessionPath:"/tmp/native-A",tmuxSessionId:pane.id,tmuxServerIdentity:pane.serverIdentity,tmuxPanePid:pane.panePid,hostInstanceId:"host-A",hostGeneration:1,state:"idle",statusDetail:"No turn in flight.",model:"seed-model"});
  const firstEntered=deferred<void>(),firstGate=deferred<boolean>();let probes=0;const currentHost=host("newer-model");
  const adapters:RuntimeAdapters={listManagedTmux:async()=>[pane],listHosts:async()=>[{...currentHost}],isSessionLive:async()=>true,sessionPathExists:async()=>{if(++probes===1){firstEntered.resolve();return firstGate.promise;}return true;},findBySessionId:async()=>"/tmp/native-A",newestSessionFor:async()=>null,isProcessDescendant:async(pid,parent)=>pid===parent,tmuxServerIdentity:async()=>"private:1",getTmux:async()=>({ok:true,session:pane}),killTmux:async()=>{},launch:async()=>{throw new Error("not used");}};
  // Record the row revision each refresh reads: this is the fact that decides the
  // case. Under the old ticket mechanism the second refresh could read the seed
  // revision before the first committed and then overwrite it; serialization makes
  // the second's read happen after the first's commit, so it never presents a
  // revision the row has already moved past.
  const reads:number[]=[];const realGet=store.getConversation.bind(store);
  store.getConversation=async(id)=>{const row=await realGet(id);if(row)reads.push(observationSeqOf(row));return row;};
  const supervisor=createSupervisor({store,adapters,maxActive:3});
  const newer=supervisor.refresh(c.id);await firstEntered.promise;
  const older=supervisor.refresh(c.id);
  firstGate.resolve(true);const newerResult=(await newer)!;
  const olderResult=(await older)!;const final=(await store.getConversation(c.id))!;
  console.log("AUDIT18 model mirror",JSON.stringify({newerModel:newerResult.model,olderModel:olderResult.model,finalModel:final.model,seq:observationSeqOf(final),reads}));
  // The first refresh committed `newer-model`; the delayed second refresh read the
  // row *after* that commit (its read is revision 2, not the seed), found the same
  // model already present, and wrote nothing. The row is never repainted by a
  // snapshot taken against a revision it has moved past.
  expect(newerResult.model).toBe("newer-model");
  expect(olderResult.model).toBe("newer-model");
  expect(reads).toContain(2);
  expect(final.model).toBe("newer-model");
 }finally{await rm(dir,{recursive:true,force:true});}
});

