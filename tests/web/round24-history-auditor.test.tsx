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

const deferred=()=>{let resolve!:(v:any)=>void;const promise=new Promise<any>(r=>resolve=r);return {promise,resolve};};
const history=(text:string,cursor:string|null=null):any=>({ok:true,data:{header:{sessionId:"native-A",cwd:"/work",timestamp:null,version:3,title:"History"},entries:[row(text,text)],hasOlder:cursor!==null,nextCursor:cursor,truncated:false,truncatedByBytes:false,truncatedByEntries:false,skippedOversized:false}});
async function enterSaved(f:Awaited<ReturnType<typeof fixture>>,page:any){
 await act(async()=>f.sockets.at(-1)!.onClose?.("closed",false));
 vi.mocked(api.getConversationLink).mockResolvedValue({ok:false,error:{code:"link_unavailable",message:"No link"}});
 vi.mocked(api.getConversationHistory).mockResolvedValue(page);
 await act(async()=>fireEvent.click(screen.getByRole("button",{name:"Retry"})));
 await screen.findByText(/Saved transcript —/);
}

it.each([false,true])('V24 a page requested during a tail refresh cannot erase the refreshed tail (overlap=%s)',async overlap=>{
 const f=await fixture();await enterSaved(f,history('OLD_TAIL','old-cursor'));
 const tail=deferred(),older=deferred();
 const requests:(string|undefined)[]=[];
 vi.mocked(api.getConversationHistory).mockImplementation(async(_id,before)=>{
  requests.push(before);
  return before===undefined?tail.promise:older.promise;
 });
 await act(async()=>fireEvent.click(screen.getByRole('button',{name:'Open live view'})));
 await waitFor(()=>expect(requests).toContain(undefined));
 if(overlap)await act(async()=>fireEvent.click(screen.getByRole('button',{name:'Load older'})));
 await act(async()=>tail.resolve(history('NEW_TAIL','new-cursor')));
 await screen.findByText('NEW_TAIL');
 if(!overlap)await act(async()=>fireEvent.click(screen.getByRole('button',{name:'Load older'})));
 await act(async()=>older.resolve(history('OLDER_ROW')));
 const newestStillVisible=screen.queryByText('NEW_TAIL')!==null;
 const oldTailReappeared=screen.queryByText('OLD_TAIL')!==null;
 console.log('AUDIT24 history overlap',JSON.stringify({overlap,requests,newestStillVisible,oldTailReappeared,olderVisible:screen.queryByText('OLDER_ROW')!==null}));
 expect(newestStillVisible).toBe(true);
 expect(oldTailReappeared).toBe(false);
});

it.each(['ok','conflict_owner'] as const)('V24 older-page writer verdict must supersede an archived stopped claim (%s)',async kind=>{
 const f=await fixture();await enterSaved(f,history('CACHED_TAIL','older-cursor'));
 vi.mocked(api.getConversationHistory).mockResolvedValue(kind==='ok'?history('OLDER_ROW'):{ok:false,error:{code:'conflict_owner',message:'Native session is live or its writer status cannot be verified.'}});
 await act(async()=>fireEvent.click(screen.getByRole('button',{name:'Load older'})));
 const stoppedClaim=screen.queryByText(/Saved transcript — this session is not running/)!==null;
 console.log('AUDIT24 page verdict',JSON.stringify({kind,stoppedClaim,cachedVisible:screen.queryByText('CACHED_TAIL')!==null,errorVisible:screen.queryByText('Native session is live or its writer status cannot be verified.')!==null}));
 expect(stoppedClaim).toBe(kind==='ok');
 expect(screen.queryByText('CACHED_TAIL')).not.toBeNull();
});

