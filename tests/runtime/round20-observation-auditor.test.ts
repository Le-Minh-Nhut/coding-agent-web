import {mkdtemp,rm} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {expect,it} from "vitest";
import {createSupervisor,type RuntimeAdapters,type RuntimeHost,type RuntimeTmuxSession} from "@caw/runtime";
import {createMetadataStore} from "../../apps/server/src/store.js";
function deferred<T>(){let resolve!:(v:T)=>void;const promise=new Promise<T>(r=>resolve=r);return {promise,resolve};}
it.each([false,true])("V20 newest completed same-life observation survives either completion order (old completes first=%s)",async(oldFirst)=>{
 const dir=await mkdtemp(join(tmpdir(),"caw-r20-observe-"));
 try{
 const store=createMetadataStore(dir);const p=await store.createProject({path:dir});const c=await store.createConversation({projectId:p.id,nativeSessionId:"native-A"});
 const pane:RuntimeTmuxSession={id:"$1",name:"pane",alive:true,panePid:1000000001,serverIdentity:"private:1"};
 await store.updateConversation(c.id,{nativeSessionPath:"/tmp/native-A",tmuxSessionId:pane.id,tmuxServerIdentity:pane.serverIdentity,tmuxPanePid:pane.panePid,hostInstanceId:"host-A",hostGeneration:1,state:"idle",model:"seed-model",statusDetail:"No turn in flight."});
 let model="older-model",probes=0;const entered=[deferred<void>(),deferred<void>()],gates=[deferred<boolean>(),deferred<boolean>()];
 const host=():RuntimeHost=>({instanceId:"host-A",generation:1,pid:pane.panePid,sessionId:"native-A",cwd:dir,model,participants:0,relayConnected:true,inputRequired:false,busy:false,access:"control"});
 const adapters:RuntimeAdapters={listManagedTmux:async()=>[pane],listHosts:async()=>[host()],isSessionLive:async()=>true,sessionPathExists:async()=>{const i=probes++;entered[i]!.resolve();return gates[i]!.promise;},findBySessionId:async()=>"/tmp/native-A",newestSessionFor:async()=>null,isProcessDescendant:async(pid,parent)=>pid===parent,tmuxServerIdentity:async()=>"private:1",getTmux:async()=>({ok:true,session:pane}),killTmux:async()=>{},launch:async()=>{throw new Error("no launch");}};
 const supervisor=createSupervisor({store,adapters,maxActive:3});
 const older=supervisor.refresh(c.id);await entered[0]!.promise;
 model="newer-model";const newer=supervisor.refresh(c.id);await entered[1]!.promise;
 // Both read the same store revision. The HOST observation for newer was taken
 // later; the gates affect only a file-existence probe, never the captured model.
 if(oldFirst){gates[0]!.resolve(true);await older;gates[1]!.resolve(true);await newer;}
 else{gates[1]!.resolve(true);await newer;gates[0]!.resolve(true);await older;}
 const final=(await store.getConversation(c.id))!;
 console.log("AUDIT20 observation order",JSON.stringify({oldFirst,finalModel:final.model}));
 expect(final.model).toBe("newer-model");
 }finally{await rm(dir,{recursive:true,force:true});}
});
/**
 * The completion-order probe above releases the gates one at a time, so the two
 * commits never reach the store together. This arms the interleaving they can
 * still produce: both captures pass their freshness read at the same revision,
 * and the OLDER capture is the one the store serializes first. The newer capture
 * must re-read and take the row, not lose to the older snapshot it supersedes.
 */
it("V20 newest capture wins when both commit at the same revision and the older one is queued first",async()=>{
 const dir=await mkdtemp(join(tmpdir(),"caw-r20-parity-"));
 try{
 const store=createMetadataStore(dir);const p=await store.createProject({path:dir});const c=await store.createConversation({projectId:p.id,nativeSessionId:"native-A"});
 const pane:RuntimeTmuxSession={id:"$1",name:"pane",alive:true,panePid:1000000001,serverIdentity:"private:1"};
 await store.updateConversation(c.id,{nativeSessionPath:"/tmp/native-A",tmuxSessionId:pane.id,tmuxServerIdentity:pane.serverIdentity,tmuxPanePid:pane.panePid,hostInstanceId:"host-A",hostGeneration:1,state:"idle",model:"seed-model",statusDetail:"No turn in flight."});
 let model="older-model";const entered=[deferred<void>(),deferred<void>()],gates=[deferred<boolean>(),deferred<boolean>()];let probes=0;
 const host=():RuntimeHost=>({instanceId:"host-A",generation:1,pid:pane.panePid,sessionId:"native-A",cwd:dir,model,participants:0,relayConnected:true,inputRequired:false,busy:false,access:"control"});
 const adapters:RuntimeAdapters={listManagedTmux:async()=>[pane],listHosts:async()=>[host()],isSessionLive:async()=>true,sessionPathExists:async()=>{const i=probes++;entered[i]!.resolve();return gates[i]!.promise;},findBySessionId:async()=>"/tmp/native-A",newestSessionFor:async()=>null,isProcessDescendant:async(pid,parent)=>pid===parent,tmuxServerIdentity:async()=>"private:1",getTmux:async()=>({ok:true,session:pane}),killTmux:async()=>{},launch:async()=>{throw new Error("no launch");}};
 // Hold the first commit the store sees until the older capture has committed, so
 // the newer capture's first attempt is refused and it must retry.
 const realUpdate=store.updateConversationIfCurrent.bind(store);let updates=0;const firstCommitEntered=deferred<void>(),releaseFirst=deferred<void>();
 store.updateConversationIfCurrent=async(id,epoch,patch,opts)=>{updates+=1;if(updates===1){firstCommitEntered.resolve();await releaseFirst.promise;}return realUpdate(id,epoch,patch,opts);};
 const supervisor=createSupervisor({store,adapters,maxActive:3});
 const older=supervisor.refresh(c.id);await entered[0]!.promise;
 model="newer-model";const newer=supervisor.refresh(c.id);await entered[1]!.promise;
 // Newer commits first in line; the store blocks it, then the older capture
 // commits while it is held. The newer snapshot must still be what remains.
 gates[1]!.resolve(true);await firstCommitEntered.promise;
 gates[0]!.resolve(true);await older;
 releaseFirst.resolve();await newer;
 const final=(await store.getConversation(c.id))!;
 console.log("AUDIT20 parity race",JSON.stringify({updates,finalModel:final.model,seq:final.observationSeq}));
 expect(final.model).toBe("newer-model");
 }finally{await rm(dir,{recursive:true,force:true});}
});
