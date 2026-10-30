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

it.each([false,true])("V21 late initial metadata must preserve a model draft already edited (edit=%s)",async(edit)=>{
 const d=deferred();const f=await fixture(0,false,d.promise);
 fireEvent.click(screen.getByText("Conversation model settings"));
 const input=screen.getByLabelText("Custom model ID") as HTMLInputElement;
 if(edit)fireEvent.change(input,{target:{value:"NEW_UNSAVED_MODEL"}});
 await act(async()=>d.resolve({ok:true,data:{...base,modelPreference:"OLD_SAVED_MODEL"}}));
 console.log("AUDIT21 initial model draft",JSON.stringify({edit,draft:input.value}));
 expect(input.value).toBe(edit?"NEW_UNSAVED_MODEL":"OLD_SAVED_MODEL");
});

it("V21 saved transcript offers a way to reconnect after an external host resumes",async()=>{
 const f=await fixture(0,false,Promise.resolve({ok:true,data:{...base,ownership:"external"}}));await enterSaved(f,history("SAVED_ROW"));
 expect(screen.queryByRole("button",{name:"Save & restart agent"})).toBeNull();
 // No control room is live, so the user needs a fresh link check. This is also
 // needed for external chats where the app cannot restart the process itself.
 const links=screen.queryAllByRole("button",{name:/Retry|Open live view|Get new link|Reconnect/i});
 console.log("AUDIT21 saved reconnect",JSON.stringify({reconnectActions:links.map(e=>e.textContent)}));
 expect(links.length).toBeGreaterThan(0);
});

it.each([false,true])("V21 old saved pagination cannot reappear after live restart and later live-history conflict (late page=%s)",async(late)=>{
 const f=await fixture();await enterSaved(f,history("OLD_TAIL","older-cursor"));
 const d=deferred();
 if(late){vi.mocked(api.getConversationHistory).mockReturnValueOnce(d.promise as any);fireEvent.click(screen.getByRole("button",{name:"Load older"}));}
 vi.spyOn(window,"confirm").mockReturnValue(true);
 vi.mocked(api.setConversationModel).mockResolvedValue({ok:true,data:{...base}});
 vi.mocked(api.restartConversation).mockResolvedValue({ok:true,data:{...base}});
 vi.mocked(api.getConversationLink).mockResolvedValue({ok:true,data:{url:"ws://127.0.0.1:7466/r/0123456789abcdef.AQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQE",access:"full",instanceId:"host-B",generation:2}});
 fireEvent.click(screen.getByText("Conversation model settings"));
 await act(async()=>fireEvent.click(screen.getByRole("button",{name:"Save & restart agent"})));
 await waitFor(()=>expect(f.sockets).toHaveLength(2));await f.emit(welcome(0));
 if(late)await act(async()=>d.resolve(history("STALE_OLDER")));
 expect(screen.queryByText("STALE_OLDER")).toBeNull();
 // Later the registry cannot mint a link, while the history endpoint positively
 // reports that a writer is live. A stale saved page must not override that fact.
 await act(async()=>f.sockets.at(-1)!.onClose?.("closed",false));
 vi.mocked(api.getConversationLink).mockResolvedValue({ok:false,error:{code:"link_unavailable",message:"Room rotating"}});
 vi.mocked(api.getConversationHistory).mockResolvedValue({ok:false,error:{code:"conflict_owner",message:"Session is live"}});
 await act(async()=>fireEvent.click(screen.getByRole("button",{name:"Retry"})));
 if(!late)await screen.findByRole("button",{name:"Open live view"});
 const stale=screen.queryByText("STALE_OLDER")!==null;
 const deadClaim=screen.queryByText(/Saved transcript — this session is not running/)!==null;
 console.log("AUDIT21 stale history mode",JSON.stringify({late,stale,deadClaim,openLive:screen.queryByRole("button",{name:"Open live view"})!==null}));
 expect(deadClaim).toBe(false);expect(stale).toBe(false);
});


it("V21 a later good journal read clears a stuck live-host verdict (conflict then ok)",async()=>{
 const f=await fixture();
 // The host disappears; a Retry finds no link and the journal reports a live writer.
 await act(async()=>f.sockets.at(-1)!.onClose?.("closed",false));
 vi.mocked(api.getConversationLink).mockResolvedValue({ok:false,error:{code:"link_unavailable",message:"No link"}});
 vi.mocked(api.getConversationHistory).mockResolvedValue({ok:false,error:{code:"conflict_owner",message:"Session is live"}});
 await act(async()=>fireEvent.click(screen.getByRole("button",{name:"Retry"})));
 await screen.findByRole("button",{name:"Open live view"});
 const stuckLive=screen.queryByText("Writer status unverified")!==null;
 // The writer is gone; the SAME read that once said conflict_owner now reads fine.
 // ok and conflict_owner are mutually exclusive verdicts, so ok must clear the
 // stale verdict or the view is stuck on "Writer status unverified" forever.
 vi.mocked(api.getConversationHistory).mockResolvedValue(history("SAVED_AFTER_LIVE"));
 await act(async()=>fireEvent.click(screen.getByRole("button",{name:"Open live view"})));
 await screen.findByText(/Saved transcript —/);
 const savedRendered=screen.queryByText("SAVED_AFTER_LIVE")!==null;
 const stillLive=screen.queryByText("Writer status unverified")!==null;
 console.log("AUDIT21 history verdict clears",JSON.stringify({stuckLive,savedRendered,stillLive}));
 expect(stuckLive).toBe(true);
 expect(savedRendered).toBe(true);
 expect(stillLive).toBe(false);
});

it("V21 a late saved page cannot re-seed saved mode after a successful live reconnect",async()=>{
 const f=await fixture();
 await enterSaved(f,history("OLD_TAIL","older-cursor"));
 const d=deferred();
 vi.mocked(api.getConversationHistory).mockReturnValueOnce(d.promise as any);
 fireEvent.click(screen.getByRole("button",{name:"Load older"}));
 // A successful reconnect bumps the mode generation and clears savedHistory.
 vi.mocked(api.getConversationLink).mockResolvedValue({ok:true,data:{url:"ws://127.0.0.1:7466/r/0123456789abcdef.AQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQE",access:"full",instanceId:"host-B",generation:2}});
 await act(async()=>fireEvent.click(screen.getByRole("button",{name:"Open live view"})));
 await waitFor(()=>expect(f.sockets).toHaveLength(2));
 await f.emit(welcome(0));
 const liveBefore=screen.queryByText("STALE_OLDER")!==null;
 // The page now resolves for a mode that no longer exists. Only the paging
 // generation clause drops it — it must not re-create savedHistory.
 await act(async()=>d.resolve(history("STALE_OLDER")));
 const staleInLive=screen.queryByText("STALE_OLDER")!==null;
 const olderError=screen.queryByText(/Could not load older history/)!==null;
 // Later the link dies again; a re-seeded savedHistory would now surface the
 // stale page as if it were this conversation's transcript.
 await act(async()=>f.sockets.at(-1)!.onClose?.("closed",false));
 vi.mocked(api.getConversationLink).mockResolvedValue({ok:false,error:{code:"link_unavailable",message:"No host"}});
 vi.mocked(api.getConversationHistory).mockResolvedValue({ok:false,error:{code:"not_found",message:"No saved history"}});
 await act(async()=>fireEvent.click(screen.getByRole("button",{name:"Retry"})));
 const staleAfterLoss=screen.queryByText("STALE_OLDER")!==null;
 const tailAfterLoss=screen.queryByText("OLD_TAIL")!==null;
 console.log("AUDIT21 late page after reconnect",JSON.stringify({liveBefore,staleInLive,olderError,staleAfterLoss,tailAfterLoss}));
 expect(liveBefore).toBe(false);
 expect(staleInLive).toBe(false);
 expect(olderError).toBe(false);
 expect(staleAfterLoss).toBe(false);
 expect(tailAfterLoss).toBe(false);
});
