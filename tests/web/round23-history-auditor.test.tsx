// @vitest-environment jsdom
import React from "react";
import {afterEach,expect,it,vi} from "vitest";
import {act,cleanup,fireEvent,render,screen,waitFor} from "@testing-library/react";
import {CollabSocket,type HostFrame} from "@caw/collab-protocol";
import {ConversationView} from "../../apps/web/src/components/ConversationView.js";
import {App} from "../../apps/web/src/App.js";
import {api} from "../../apps/web/src/api.js";
vi.mock("../../apps/web/src/api.js",()=>({api:{getConversation:vi.fn(),getAttachInstructions:vi.fn(),getConversationLink:vi.fn(),setConversationModel:vi.fn(),restartConversation:vi.fn(),getModels:vi.fn(),getConversationHistory:vi.fn(),getMe:vi.fn(),getCapabilities:vi.fn(),listProjects:vi.fn(),listConversations:vi.fn(),listNativeSessions:vi.fn()}}));
afterEach(()=>{cleanup();vi.restoreAllMocks();});
const base:any={id:"c",projectId:"p",title:"Chat",state:"idle",ownership:"managed",modelPreference:"model-a",model:"model-a",nativeSessionId:"native-A"};
function welcome(entryCount=0):HostFrame{return {t:"welcome",proto:3,header:{type:"session",id:"native-A",cwd:"/work",timestamp:""},state:{isStreaming:false,queuedMessageCount:0,cwd:"/work",participants:[]},agents:[],entryCount};}
const refusal:HostFrame={t:"error",message:"prompting is unavailable until the host finishes starting up"};
const row=(id:string,text:string,ts=1):any=>({type:"message",id,parentId:null,timestamp:"2026-01-01T00:00:00Z",message:{role:"user",content:text,timestamp:ts}});
const collabRow=(id:string,text:string):any=>({type:"custom_message",id,parentId:null,timestamp:new Date().toISOString(),customType:"collab-prompt",content:text,display:true,details:{from:"Mobile Web Controller"}});
async function fixture(entryCount=0,realApp=false,initialRead:any=null){
 vi.mocked(api.getConversation).mockReturnValue(initialRead??Promise.resolve({ok:true,data:{...base}}));
 vi.mocked(api.getAttachInstructions).mockResolvedValue({ok:true,data:{available:false}} as any);
 vi.mocked(api.getModels).mockResolvedValue({ok:true,data:{models:[],source:"omp",reason:null}});
 vi.mocked(api.getConversationLink).mockResolvedValue({ok:true,data:{url:"ws://127.0.0.1:7466/r/0123456789abcdef.AQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQE",access:"full",instanceId:"host-A",generation:1}});
 vi.mocked(api.getConversationHistory).mockResolvedValue({ok:false,error:{code:"not_found",message:"No saved history"}});
 vi.mocked(api.getMe).mockResolvedValue({ok:true,data:{csrfToken:"test"}});
 vi.mocked(api.getCapabilities).mockResolvedValue({ok:true,data:{}} as any);
 vi.mocked(api.listProjects).mockResolvedValue({ok:true,data:[{id:"p",path:"/work",label:"Project A",favorite:false,conversationCount:1,lastActivityAt:null,createdAt:"",updatedAt:""}]});
 vi.mocked(api.listConversations).mockResolvedValue({ok:true,data:[base]} as any);
 vi.mocked(api.listNativeSessions).mockResolvedValue({ok:true,data:[]});
 const sockets:CollabSocket[]=[];
 vi.spyOn(CollabSocket.prototype,"connect").mockImplementation(function(this:CollabSocket){sockets.push(this);this.onOpen?.();});
 vi.spyOn(CollabSocket.prototype,"send").mockResolvedValue(true);
 const view=render(realApp?<App/>:<ConversationView conversationId="c" onBack={()=>{}}/>);
 if(realApp){fireEvent.click(await screen.findByText("Project A"));fireEvent.click(await screen.findByText("Chat"));}
 await waitFor(()=>expect(sockets).toHaveLength(1));
 const emit=async(frame:HostFrame)=>{await act(async()=>sockets.at(-1)!.onFrame?.(frame,0));};
 await emit(welcome(entryCount));
 const input=()=>view.container.querySelector("textarea")!;
 const type=(text:string)=>fireEvent.change(input(),{target:{value:text}});
 const send=async(text:string)=>{type(text);await act(async()=>fireEvent.click(view.getByRole("button",{name:"Send"})));};
 const recovery=()=>[...view.container.querySelectorAll(".refused-prompt")].map(e=>e.textContent).join("\n");
 return {view,emit,input,type,send,recovery,sockets};
}

const deferred=()=>{let resolve!:(v:any)=>void;const promise=new Promise(r=>resolve=r);return {promise,resolve};};
const history=(text:string,cursor:string|null=null):any=>({ok:true,data:{header:{sessionId:"native-A",cwd:"/work",timestamp:null,version:3,title:"History"},entries:[row(text,text)],hasOlder:cursor!==null,nextCursor:cursor,truncated:false,truncatedByBytes:false,truncatedByEntries:false,skippedOversized:false}});
async function enterSaved(f:Awaited<ReturnType<typeof fixture>>,page:any){
 await act(async()=>f.sockets.at(-1)!.onClose?.("closed",false));
 vi.mocked(api.getConversationLink).mockResolvedValue({ok:false,error:{code:"link_unavailable",message:"No link"}});
 vi.mocked(api.getConversationHistory).mockResolvedValue(page);
 await act(async()=>fireEvent.click(screen.getByRole("button",{name:"Retry"})));
 await screen.findByText(/Saved transcript —/);
}

it.each(["ok","not_found","internal","path_forbidden"] as const)("V22 a fresh history verdict supersedes a previous live verdict (%s)",async(kind)=>{
 const f=await fixture();
 await act(async()=>f.sockets.at(-1)!.onClose?.("closed",false));
 vi.mocked(api.getConversationLink).mockResolvedValue({ok:false,error:{code:"link_unavailable",message:"No room"}});
 vi.mocked(api.getConversationHistory).mockResolvedValue({ok:false,error:{code:"conflict_owner",message:"Writer is live"}});
 await act(async()=>fireEvent.click(screen.getByRole("button",{name:"Retry"})));
 await screen.findByText("Writer status unverified");
 vi.mocked(api.getConversationHistory).mockResolvedValue(kind==="ok"?history("SAVED_AFTER_STOP"):{ok:false,error:{code:kind,message:"New verdict cannot verify the host"}});
 await act(async()=>fireEvent.click(screen.getByRole("button",{name:"Open live view"})));
 const staleLive=screen.queryByText("Writer status unverified")!==null;
 console.log("AUDIT22 history verdict",JSON.stringify({kind,staleLive,body:f.view.container.textContent?.includes("Host presence is not yet verified")}));
 expect(staleLive).toBe(false);
});

it.each([false,true])('V23 a retry metadata read cannot rewind a successful model save (late=%s)',async late=>{
 const f=await fixture();await enterSaved(f,history('SAVED_TAIL'));
 fireEvent.click(screen.getByText('Conversation model settings'));
 const d=deferred();
 if(late){
  vi.mocked(api.getConversation).mockReturnValueOnce(d.promise as any);
  await act(async()=>fireEvent.click(screen.getByRole('button',{name:'Open live view'})));
 }
 fireEvent.change(screen.getByLabelText('Custom model ID'),{target:{value:'NEW_SAVED_MODEL'}});
 vi.mocked(api.setConversationModel).mockResolvedValue({ok:true,data:{...base,modelPreference:'NEW_SAVED_MODEL'}});
 await act(async()=>fireEvent.click(screen.getByRole('button',{name:'Save model'})));
 await screen.findByText('Model saved for next launch.');
 const preference=()=>screen.getByText('Preferred for next launch:').textContent;
 const before=preference();
 if(late)await act(async()=>d.resolve({ok:true,data:{...base,modelPreference:'OLD_SAVED_MODEL'}}));
 const after=preference(),draft=(screen.getByLabelText('Custom model ID') as HTMLInputElement).value;
 console.log('AUDIT23 saved model metadata',JSON.stringify({late,before,after,draft}));
 expect(after).toContain('NEW_SAVED_MODEL');
});

it('V23 a writer-status-unverifiable history response is not proof that a live host is available',async()=>{
 const f=await fixture();
 await act(async()=>f.sockets.at(-1)!.onClose?.('closed',false));
 vi.mocked(api.getConversationLink).mockResolvedValue({ok:false,error:{code:'link_unavailable',message:'No connected room'}});
 vi.mocked(api.getConversationHistory).mockResolvedValue({ok:false,error:{code:'conflict_owner',message:'Native session is live or its writer status cannot be verified.'}});
 await act(async()=>fireEvent.click(screen.getByRole('button',{name:'Retry'})));
 const positive=screen.queryByText('This session is live. Open the live view to read it.')!==null;
 console.log('AUDIT23 ambiguous history conflict',JSON.stringify({positive}));
 expect(positive).toBe(false);
});

async function savedWithLateRead(){
 const f=await fixture();await enterSaved(f,history('SAVED_TAIL'));
 fireEvent.click(screen.getByText('Conversation model settings'));
 const d=deferred();
 vi.mocked(api.getConversation).mockReturnValueOnce(d.promise as any);
 await act(async()=>fireEvent.click(screen.getByRole('button',{name:'Open live view'})));
 fireEvent.change(screen.getByLabelText('Custom model ID'),{target:{value:'NEW_SAVED_MODEL'}});
 return {f,d,preference:()=>screen.getByText('Preferred for next launch:').textContent};
}

it('V23 a read started before a FAILED save still applies (no mutation landed)',async()=>{
 const {d,preference}=await savedWithLateRead();
 vi.mocked(api.setConversationModel).mockResolvedValue({ok:false,error:{code:'internal',message:'Model store unavailable'}});
 await act(async()=>fireEvent.click(screen.getByRole('button',{name:'Save model'})));
 await screen.findByText('Model store unavailable');
 await act(async()=>d.resolve({ok:true,data:{...base,modelPreference:'OLD_SAVED_MODEL'}}));
 const after=preference();
 console.log('AUDIT23 failed save keeps late read',JSON.stringify({after}));
 // The save landed nothing, so the read is still the newest truth.
 expect(after).toContain('OLD_SAVED_MODEL');
});

it('V23 a read started AFTER a successful save still applies the fresh server value',async()=>{
 const {f,preference}=await savedWithLateRead();
 vi.mocked(api.setConversationModel).mockResolvedValue({ok:true,data:{...base,modelPreference:'NEW_SAVED_MODEL'}});
 await act(async()=>fireEvent.click(screen.getByRole('button',{name:'Save model'})));
 await screen.findByText('Model saved for next launch.');
 // A NEWER read began after the mutation completed: it reflects real truth and applies.
 vi.mocked(api.getConversation).mockResolvedValue({ok:true,data:{...base,modelPreference:'FRESH_SERVER_MODEL'}});
 await act(async()=>fireEvent.click(screen.getByRole('button',{name:'Open live view'})));
 await waitFor(()=>expect(preference()).toContain('FRESH_SERVER_MODEL'));
 console.log('AUDIT23 fresh read after save',JSON.stringify({after:preference(),sockets:f.sockets.length}));
 expect(preference()).toContain('FRESH_SERVER_MODEL');
});

it('V23 a late read from a previous conversation cannot repaint the current one',async()=>{
 const d=deferred();
 const f=await fixture(0,false,d.promise);
 fireEvent.click(screen.getByText('Conversation model settings'));
 // Switch conversations while the first read is still in flight.
 // base is the file's untyped fixture (same style as the round-21 probes).
 const other={...base,id:'c2',title:'Other',modelPreference:'MODEL_B'};
 vi.mocked(api.getConversation).mockResolvedValue({ok:true,data:other});
 f.view.rerender(<ConversationView conversationId="c2" onBack={()=>{}}/>);
 await waitFor(()=>expect(screen.getByText('Preferred for next launch:').textContent).toContain('MODEL_B'));
 await act(async()=>d.resolve({ok:true,data:{...base,modelPreference:'MODEL_A'}}));
 const after=screen.getByText('Preferred for next launch:').textContent;
 console.log('AUDIT23 late read across conversation switch',JSON.stringify({after}));
 expect(after).toContain('MODEL_B');
});

it('V23 a late read resolving after Back/unmount is dropped without error',async()=>{
 const d=deferred();
 const f=await fixture(0,false,d.promise);
 fireEvent.click(screen.getByText('Conversation model settings'));
 f.view.unmount();
 await act(async()=>{d.resolve({ok:true,data:{...base,modelPreference:'MODEL_A'}});});
 console.log('AUDIT23 late read after unmount',JSON.stringify({rendered:document.body.textContent?.length??0}));
 expect(document.body.textContent ?? '').not.toContain('Preferred for next launch:');
});

/**
 * F-B3: a fresh unverified verdict must supersede the CLAIM, not the data. Archived
 * → save → a fresh read that proves nothing (not_found/internal) used to leave the
 * "this session is not running" banner standing over rows it could no longer stand
 * behind, with the fresh failure hidden. The verdict now keeps the rows readable as
 * cached data, replaces that banner with a hedge, and surfaces the same error and
 * Retry the fallback card offers — so a real error can never hide behind the rows.
 */
it.each(['not_found','internal'] as const)('V23 a fresh unverified verdict keeps the cached transcript without claiming liveness (%s)',async kind=>{
 const f=await fixture();
 await enterSaved(f,history('CACHED_TRANSCRIPT'));
 const savedShown=screen.queryByText('CACHED_TRANSCRIPT')!==null;
 const archivedClaim=screen.queryByText(/Saved transcript — this session is not running/)!==null;
 vi.mocked(api.getConversationHistory).mockResolvedValue({ok:false,error:{code:kind,message:kind==='internal'?'Journal read failed':'No saved history'}});
 await act(async()=>fireEvent.click(screen.getByRole('button',{name:'Open live view'})));
 await screen.findByText(/Saved transcript — host presence not verified/);
 const rowsKept=screen.queryByText('CACHED_TRANSCRIPT')!==null;
 const deadClaim=screen.queryByText(/Saved transcript — this session is not running/)!==null;
 const errorVisible=kind==='internal'?screen.queryByText('Journal read failed')!==null:screen.queryByText(/Host presence is not yet verified; this cached transcript may be stale\./)!==null;
 const retryAvailable=screen.queryByRole('button',{name:'Retry'})!==null;
 console.log('AUDIT23 unverified keeps cached transcript',JSON.stringify({kind,savedShown,archivedClaim,rowsKept,deadClaim,errorVisible,retryAvailable}));
 expect(savedShown).toBe(true);
 expect(archivedClaim).toBe(true);
 // The owner's text: a cached transcript may be kept for reading, but it must not
 // prove current liveness. Rows stay; the stopped claim and the hidden error go.
 expect(rowsKept).toBe(true);
 expect(deadClaim).toBe(false);
 expect(errorVisible).toBe(true);
 expect(retryAvailable).toBe(true);
});


