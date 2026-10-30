import {mkdtemp,rm} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {expect,it} from "vitest";
import {epochOf,observationSeqOf} from "@caw/contracts";
import {createSupervisor,type RuntimeAdapters,type RuntimeHost,type RuntimeTmuxSession} from "@caw/runtime";
import {createMetadataStore} from "../../apps/server/src/store.js";
function deferred<T>(){let resolve!:(v:T)=>void;const promise=new Promise<T>(r=>resolve=r);return {promise,resolve};}

/**
 * V20-08: `observationSeq` orders *commits*, but a routine observation is not
 * atomic — the row read happens first and the machine probes second. Two
 * overlapping refreshes of one life can therefore sample the machine in either
 * order, and any ordering fact captured at the row read names the wrong snapshot
 * "newer": a refresh that entered last can carry the oldest content and repaint
 * it, and it can equally find "nothing to change" while an earlier capture's real
 * observation is still in flight and then suppress that observation.
 *
 * The fix is serialization: refreshes of one conversation run one at a time, so
 * the second reads the row (and its revision) only after the first has committed.
 * The plain `expectedObservationSeq` gate then keeps the newest observation in
 * either entry order, and no capture can be stale-news of its sibling. These
 * probes hold the two refreshes' *entry* order fixed and vary which one is
 * started first; the newer-content refresh is always the one that observes the
 * machine last, which under serialization is the one that enters last.
 */
it.each([false,true])("V20 the newest observation survives either refresh order (second refresh joins an in-flight one=%s)",async(joins)=>{
 const dir=await mkdtemp(join(tmpdir(),"caw-r20-observe-"));
 try{
  const store=createMetadataStore(dir);const p=await store.createProject({path:dir});const c=await store.createConversation({projectId:p.id,nativeSessionId:"native-A"});
  const pane:RuntimeTmuxSession={id:"$1",name:"pane",alive:true,panePid:1000000001,serverIdentity:"private:1"};
  await store.updateConversation(c.id,{nativeSessionPath:"/tmp/native-A",tmuxSessionId:pane.id,tmuxServerIdentity:pane.serverIdentity,tmuxPanePid:pane.panePid,hostInstanceId:"host-A",hostGeneration:1,state:"idle",model:"seed-model",statusDetail:"No turn in flight."});
  // The machine's model is the function of *when* a refresh probes: the first
  // refresh probes while it still holds the older model, everyone after sees the
  // newer one. Only one refresh probes at a time (serialized), so this is the
  // machine moving forward while the second refresh waits its turn.
  let probes=0;let model="older-model";
  const entered=[deferred<void>(),deferred<void>()],gates=[deferred<boolean>(),deferred<boolean>()];
  const host=():RuntimeHost=>({instanceId:"host-A",generation:1,pid:pane.panePid,sessionId:"native-A",cwd:dir,model,participants:0,relayConnected:true,inputRequired:false,busy:false,access:"control"});
  const adapters:RuntimeAdapters={listManagedTmux:async()=>[pane],listHosts:async()=>[host()],isSessionLive:async()=>true,sessionPathExists:async()=>{const i=probes++;entered[i]!.resolve();return gates[i]!.promise;},findBySessionId:async()=>"/tmp/native-A",newestSessionFor:async()=>null,isProcessDescendant:async(pid,parent)=>pid===parent,tmuxServerIdentity:async()=>"private:1",getTmux:async()=>({ok:true,session:pane}),killTmux:async()=>{},launch:async()=>{throw new Error("no launch");}};
  const supervisor=createSupervisor({store,adapters,maxActive:3});
  const older=supervisor.refresh(c.id);await entered[0]!.promise;
  model="newer-model";
  // `joins`: start the second refresh *while* the first is still in its probe
  // (it registers on the in-flight chain), or *after* the first has resolved (the
  // chain entry is gone and it takes the fresh path). Either way it must read the
  // row the first committed, so its observation is the newer one.
  const joined=joins?supervisor.refresh(c.id):null;
  gates[0]!.resolve(true);const olderResult=(await older)!;
  const second=joined??supervisor.refresh(c.id);
  gates[1]!.resolve(true);const newerResult=(await second)!;
  const final=(await store.getConversation(c.id))!;
  console.log("AUDIT20 observation order",JSON.stringify({joins,olderModel:olderResult.model,newerModel:newerResult.model,finalModel:final.model,finalSeq:final.observationSeq}));
  // The first refresh probed while the machine still held the older model; the
  // second probed afterwards and observed the newer one. Either entry order ends
  // on the newest observation.
  expect(olderResult.model).toBe("older-model");
  expect(newerResult.model).toBe("newer-model");
  expect(final.model).toBe("newer-model");
 }finally{await rm(dir,{recursive:true,force:true});}
});

/**
 * The completion-order probe above releases the gates one at a time. This arms the
 * property serialization is there to give: the second refresh's row read happens
 * *after* the first has committed, so it presents the revision the first left
 * rather than the same stale revision. The newest observation must be what remains,
 * and the second refresh's own revision must have advanced past the seed.
 */
it("V20 the second refresh reads the row the first left, so the newest observation remains",async()=>{
 const dir=await mkdtemp(join(tmpdir(),"caw-r20-parity-"));
 try{
  const store=createMetadataStore(dir);const p=await store.createProject({path:dir});const c=await store.createConversation({projectId:p.id,nativeSessionId:"native-A"});
  const pane:RuntimeTmuxSession={id:"$1",name:"pane",alive:true,panePid:1000000001,serverIdentity:"private:1"};
  await store.updateConversation(c.id,{nativeSessionPath:"/tmp/native-A",tmuxSessionId:pane.id,tmuxServerIdentity:pane.serverIdentity,tmuxPanePid:pane.panePid,hostInstanceId:"host-A",hostGeneration:1,state:"idle",model:"seed-model",statusDetail:"No turn in flight."});
  let model="older-model";const entered=[deferred<void>(),deferred<void>()],gates=[deferred<boolean>(),deferred<boolean>()];let probes=0;
  const host=():RuntimeHost=>({instanceId:"host-A",generation:1,pid:pane.panePid,sessionId:"native-A",cwd:dir,model,participants:0,relayConnected:true,inputRequired:false,busy:false,access:"control"});
  const adapters:RuntimeAdapters={listManagedTmux:async()=>[pane],listHosts:async()=>[host()],isSessionLive:async()=>true,sessionPathExists:async()=>{const i=probes++;entered[i]!.resolve();return gates[i]!.promise;},findBySessionId:async()=>"/tmp/native-A",newestSessionFor:async()=>null,isProcessDescendant:async(pid,parent)=>pid===parent,tmuxServerIdentity:async()=>"private:1",getTmux:async()=>({ok:true,session:pane}),killTmux:async()=>{},launch:async()=>{throw new Error("no launch");}};
  // Record every row read the store serves, so the second refresh's read can be
  // shown to be *of the row the first committed*, not of the seed.
  const reads:number[]=[];const realGet=store.getConversation.bind(store);
  store.getConversation=async(id)=>{const row=await realGet(id);if(row)reads.push(row.observationSeq??0);return row;};
  const supervisor=createSupervisor({store,adapters,maxActive:3});
  const older=supervisor.refresh(c.id);await entered[0]!.promise;
  model="newer-model";const newer=supervisor.refresh(c.id);
  gates[0]!.resolve(true);const olderResult=(await older)!;
  gates[1]!.resolve(true);const newerResult=(await newer)!;
  const final=(await store.getConversation(c.id))!;
  console.log("AUDIT20 parity re-read",JSON.stringify({reads,finalModel:final.model,seq:final.observationSeq}));
  expect(final.model).toBe("newer-model");
  // The second refresh's first read is the row the first refresh left: the seed
  // revision (1) is followed by the committed one (2) before the second probes.
  expect(reads).toContain(2);
  expect(newerResult.model).toBe("newer-model");
  expect(olderResult.model).toBe("older-model");
 }finally{await rm(dir,{recursive:true,force:true});}
});

/**
 * F1 regression: a refresh that would carry the *oldest* content must not be able
 * to repaint it over a newer sample. Under the pre-serialization ticket mechanism
 * a later-entering refresh whose probes raced an earlier one could do exactly that
 * (its ticket was highest, so the supersede path handed it the row). Serialization
 * removes the race: the later-entering refresh probes after the earlier one has
 * committed, so its content is the machine's current state, not a stale sample.
 */
it("V20 a later-entering refresh cannot repaint older content over a newer sample",async()=>{
 const dir=await mkdtemp(join(tmpdir(),"caw-r20-f1-"));
 try{
  const store=createMetadataStore(dir);const p=await store.createProject({path:dir});const c=await store.createConversation({projectId:p.id,nativeSessionId:"native-A"});
  const pane:RuntimeTmuxSession={id:"$1",name:"pane",alive:true,panePid:1000000001,serverIdentity:"private:1"};
  await store.updateConversation(c.id,{nativeSessionPath:"/tmp/native-A",tmuxSessionId:pane.id,tmuxServerIdentity:pane.serverIdentity,tmuxPanePid:pane.panePid,hostInstanceId:"host-A",hostGeneration:1,state:"idle",model:"seed-model",statusDetail:"No turn in flight."});
  let model="older-model";
  const entered=deferred<void>(),gate=deferred<boolean>();let probes=0;
  const probeOrder:string[]=[];
  const host=():RuntimeHost=>({instanceId:"host-A",generation:1,pid:pane.panePid,sessionId:"native-A",cwd:dir,model,participants:0,relayConnected:true,inputRequired:false,busy:false,access:"control"});
  const adapters:RuntimeAdapters={listManagedTmux:async()=>[pane],listHosts:async()=>{probeOrder.push(`probe${++probes}=${model}`);return [host()];},isSessionLive:async()=>true,sessionPathExists:async()=>{entered.resolve();return gate.promise;},findBySessionId:async()=>"/tmp/native-A",newestSessionFor:async()=>null,isProcessDescendant:async(pid,parent)=>pid===parent,tmuxServerIdentity:async()=>"private:1",getTmux:async()=>({ok:true,session:pane}),killTmux:async()=>{},launch:async()=>{throw new Error("no launch");}};
  const supervisor=createSupervisor({store,adapters,maxActive:3});
  // Refresh A enters first and samples "older-model"; the machine moves forward
  // while it is still probing. Refresh B enters later and is serialized behind A:
  // it cannot sample until A has committed, so it must sample "newer-model".
  const a=supervisor.refresh(c.id);await entered.promise;
  model="newer-model";
  const b=supervisor.refresh(c.id);
  gate.resolve(true);
  const aResult=(await a)!;const bResult=(await b)!;const final=(await store.getConversation(c.id))!;
  console.log("AUDIT20 f1",JSON.stringify({probeOrder,aModel:aResult.model,bModel:bResult.model,finalModel:final.model}));
  expect(probeOrder).toEqual(["probe1=older-model","probe2=newer-model"]);
  expect(aResult.model).toBe("older-model");
  expect(bResult.model).toBe("newer-model");
  expect(final.model).toBe("newer-model");
 }finally{await rm(dir,{recursive:true,force:true});}
});

/**
 * F2 regression: a refresh that finds nothing to change (an unchanged poll) must
 * not suppress a later refresh's real observation. Under the pre-serialization
 * ticket mechanism the unchanged poll recorded a ticket and a later, genuinely
 * newer observation was dropped as `ticket < committed`. With refreshes
 * serialized the unchanged poll returns without claiming anything, so the newer
 * observation lands.
 */
it("V20 an unchanged poll does not suppress a later, newer observation",async()=>{
 const dir=await mkdtemp(join(tmpdir(),"caw-r20-f2-"));
 try{
  const store=createMetadataStore(dir);const p=await store.createProject({path:dir});const c=await store.createConversation({projectId:p.id,nativeSessionId:"native-A"});
  const pane:RuntimeTmuxSession={id:"$1",name:"pane",alive:true,panePid:1000000001,serverIdentity:"private:1"};
  await store.updateConversation(c.id,{nativeSessionPath:"/tmp/native-A",tmuxSessionId:pane.id,tmuxServerIdentity:pane.serverIdentity,tmuxPanePid:pane.panePid,hostInstanceId:"host-A",hostGeneration:1,state:"idle",model:"seed-model",statusDetail:"No turn in flight."});
  let model="seed-model";
  const host=():RuntimeHost=>({instanceId:"host-A",generation:1,pid:pane.panePid,sessionId:"native-A",cwd:dir,model,participants:0,relayConnected:true,inputRequired:false,busy:false,access:"control"});
  const adapters:RuntimeAdapters={listManagedTmux:async()=>[pane],listHosts:async()=>[host()],isSessionLive:async()=>true,sessionPathExists:async()=>true,findBySessionId:async()=>"/tmp/native-A",newestSessionFor:async()=>null,isProcessDescendant:async(pid,parent)=>pid===parent,tmuxServerIdentity:async()=>"private:1",getTmux:async()=>({ok:true,session:pane}),killTmux:async()=>{},launch:async()=>{throw new Error("no launch");}};
  let writes=0;const realUpdate=store.updateConversationIfCurrent.bind(store);
  store.updateConversationIfCurrent=async(id,epoch,patch,opts)=>{const r=await realUpdate(id,epoch,patch,opts);if(r?.applied)writes+=1;return r;};
  const supervisor=createSupervisor({store,adapters,maxActive:3});
  // The first poll observes exactly what the row already holds: nothing to write.
  const unchanged=await supervisor.refresh(c.id);
  const afterFirst=(await store.getConversation(c.id))!;
  // The machine then moves forward; the next poll must land the newer model.
  model="newer-model";
  const newer=await supervisor.refresh(c.id);
  const final=(await store.getConversation(c.id))!;
  console.log("AUDIT20 f2",JSON.stringify({unchangedModel:unchanged?.model,afterFirstModel:afterFirst.model,newerModel:newer?.model,finalModel:final.model,writes}));
  expect(afterFirst.model).toBe("seed-model");
  expect(newer?.model).toBe("newer-model");
  expect(final.model).toBe("newer-model");
  // Exactly one applied write: the unchanged poll wrote nothing, so it could not
  // have claimed anything for a later observation to lose to.
  expect(writes).toBe(1);
 }finally{await rm(dir,{recursive:true,force:true});}
});

/**
 * The same-life revision gate still protects against a *non-refresh* observer: an
 * adopt backfill or a reconcile verdict commits through the same conditional write
 * (`observation: true` + the revision it read). A refresh that read the row before
 * such a write lands must not repaint over it.
 */
it("V20 a same-life write landing inside a refresh's probe window is not repainted",async()=>{
 const dir=await mkdtemp(join(tmpdir(),"caw-r20-seqgate-"));
 try{
  const store=createMetadataStore(dir);const p=await store.createProject({path:dir});const c=await store.createConversation({projectId:p.id,nativeSessionId:"native-A"});
  const pane:RuntimeTmuxSession={id:"$1",name:"pane",alive:true,panePid:1000000001,serverIdentity:"private:1"};
  await store.updateConversation(c.id,{nativeSessionPath:"/tmp/native-A",tmuxSessionId:pane.id,tmuxServerIdentity:pane.serverIdentity,tmuxPanePid:pane.panePid,hostInstanceId:"host-A",hostGeneration:1,state:"idle",model:"seed-model",statusDetail:"No turn in flight."});
  const entered=deferred<void>(),gate=deferred<boolean>();
  const host=():RuntimeHost=>({instanceId:"host-A",generation:1,pid:pane.panePid,sessionId:"native-A",cwd:dir,model:"refresh-model",participants:0,relayConnected:true,inputRequired:false,busy:false,access:"control"});
  const adapters:RuntimeAdapters={listManagedTmux:async()=>[pane],listHosts:async()=>[host()],isSessionLive:async()=>true,sessionPathExists:async()=>{entered.resolve();return gate.promise;},findBySessionId:async()=>"/tmp/native-A",newestSessionFor:async()=>null,isProcessDescendant:async(pid,parent)=>pid===parent,tmuxServerIdentity:async()=>"private:1",getTmux:async()=>({ok:true,session:pane}),killTmux:async()=>{},launch:async()=>{throw new Error("no launch");}};
  const supervisor=createSupervisor({store,adapters,maxActive:3});
  const read=(await store.getConversation(c.id))!;
  const refreshing=supervisor.refresh(c.id);await entered.promise;
  // Another same-life observer commits a newer row while this refresh probes. The
  // revision the refresh read is now behind, so its commit is refused.
  await store.updateConversationIfCurrent(c.id,epochOf(read),{model:"newer-model"},{observation:true,expectedObservationSeq:observationSeqOf(read)});
  gate.resolve(true);const result=(await refreshing)!;const final=(await store.getConversation(c.id))!;
  console.log("AUDIT20 seqgate",JSON.stringify({resultModel:result.model,finalModel:final.model}));
  expect(final.model).toBe("newer-model");
 }finally{await rm(dir,{recursive:true,force:true});}
});

/**
 * F3 regression: an unchanged poll writes nothing, but it must still return the row
 * as it stands *now*, not the pre-probe snapshot. This path used to return the row
 * read before the probes (HEAD returned the fresh row through its commit helper), so
 * a launch or stop that moved the epoch while the poll probed was answered with a
 * dead row — the GET handler serves exactly this value.
 */
it("V20 an unchanged poll returns the row as it stands now, not the pre-probe snapshot",async()=>{
 const dir=await mkdtemp(join(tmpdir(),"caw-r20-f3-"));
 try{
  const store=createMetadataStore(dir);const p=await store.createProject({path:dir});const c=await store.createConversation({projectId:p.id,nativeSessionId:"native-A"});
  const pane:RuntimeTmuxSession={id:"$1",name:"pane",alive:true,panePid:1000000001,serverIdentity:"private:1"};
  await store.updateConversation(c.id,{nativeSessionPath:"/tmp/native-A",tmuxSessionId:pane.id,tmuxServerIdentity:pane.serverIdentity,tmuxPanePid:pane.panePid,hostInstanceId:"host-A",hostGeneration:1,state:"idle",model:"seed-model",statusDetail:"No turn in flight."});
  const entered=deferred<void>(),gate=deferred<boolean>();
  const host=():RuntimeHost=>({instanceId:"host-A",generation:1,pid:pane.panePid,sessionId:"native-A",cwd:dir,model:"seed-model",participants:0,relayConnected:true,inputRequired:false,busy:false,access:"control"});
  const adapters:RuntimeAdapters={listManagedTmux:async()=>[pane],listHosts:async()=>[host()],isSessionLive:async()=>true,sessionPathExists:async()=>{entered.resolve();return gate.promise;},findBySessionId:async()=>"/tmp/native-A",newestSessionFor:async()=>null,isProcessDescendant:async(pid,parent)=>pid===parent,tmuxServerIdentity:async()=>"private:1",getTmux:async()=>({ok:true,session:pane}),killTmux:async()=>{},launch:async()=>{throw new Error("no launch");}};
  let writes=0;const realUpdate=store.updateConversationIfCurrent.bind(store);
  store.updateConversationIfCurrent=async(id,epoch,patch,opts)=>{const r=await realUpdate(id,epoch,patch,opts);if(r?.applied)writes+=1;return r;};
  const supervisor=createSupervisor({store,adapters,maxActive:3});
  // The poll observes exactly what the row already holds — nothing to write — but a
  // newer life takes the row while it is still probing.
  const poll=supervisor.refresh(c.id);await entered.promise;
  const moved=await store.updateConversation(c.id,{state:"stopped",statusDetail:"Stopped."});
  gate.resolve(true);const result=(await poll)!;
  console.log("AUDIT20 f3",JSON.stringify({resultState:result.state,resultEpoch:epochOf(result),finalState:moved.state,writes}));
  expect(writes).toBe(0);
  expect(result.state).toBe("stopped");
  expect(epochOf(result)).toBe(epochOf(moved));
 }finally{await rm(dir,{recursive:true,force:true});}
});
