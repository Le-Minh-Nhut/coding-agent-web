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
async function fixture(entryCount=0,realApp=false,initialRead:any=null,attach:any={available:false}){
 vi.mocked(api.getConversation).mockReturnValue(initialRead??Promise.resolve({ok:true,data:{...base}}));
 vi.mocked(api.getAttachInstructions).mockResolvedValue({ok:true,data:attach} as any);
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

it.each([false,true])('V25 older Retry metadata must not repaint a newer Retry result (overlap=%s)',async overlap=>{
 const f=await fixture();await enterSaved(f,history('SAVED_TAIL'));
 const first=deferred(),second=deferred();
 vi.mocked(api.getConversation).mockReturnValueOnce(first.promise as any).mockReturnValueOnce(second.promise as any);
 await act(async()=>fireEvent.click(screen.getByRole('button',{name:'Open live view'})));
 if(!overlap)await act(async()=>first.resolve({ok:true,data:{...base,modelPreference:'OLDER_READ_MODEL'}}));
 await act(async()=>fireEvent.click(screen.getByRole('button',{name:'Open live view'})));
 await act(async()=>second.resolve({ok:true,data:{...base,modelPreference:'NEWER_READ_MODEL'}}));
 await waitFor(()=>expect(screen.getByText('Preferred for next launch:').textContent).toContain('NEWER_READ_MODEL'));
 if(overlap)await act(async()=>first.resolve({ok:true,data:{...base,modelPreference:'OLDER_READ_MODEL'}}));
 const text=screen.getByText('Preferred for next launch:').textContent;
 console.log('AUDIT25 metadata read/read',JSON.stringify({overlap,text}));
 expect(text).toContain('NEWER_READ_MODEL');
});

it.each([false,true])('V25 terminal attach instructions must follow a successful managed restart (restart=%s)',async restart=>{
 const oldCommand='tmux -S /private/caw.sock attach-session -t $1',newCommand='tmux -S /private/caw.sock attach-session -t $2';
 const f=await fixture(0,false,null,{available:true,command:oldCommand});
 await act(async()=>f.sockets.at(-1)!.onClose?.('closed',false));
 vi.mocked(api.getConversationLink).mockResolvedValue({ok:false,error:{code:'link_unavailable',message:'No room'}});
 vi.mocked(api.getConversationHistory).mockResolvedValue({ok:false,error:{code:'not_found',message:'No journal'}});
 await act(async()=>fireEvent.click(screen.getByRole('button',{name:'Retry'})));
 await screen.findByText(oldCommand);
 if(restart){
  vi.spyOn(window,'confirm').mockReturnValue(true);
  vi.mocked(api.setConversationModel).mockResolvedValue({ok:true,data:{...base,tmuxSessionId:'$1'}});
  vi.mocked(api.restartConversation).mockResolvedValue({ok:true,data:{...base,tmuxSessionId:'$2'}});
  vi.mocked(api.getAttachInstructions).mockResolvedValue({ok:true,data:{available:true,command:newCommand}} as any);
  fireEvent.click(screen.getByText('Conversation model settings'));
  await act(async()=>fireEvent.click(screen.getByRole('button',{name:'Save & restart agent'})));
  await screen.findByText('Agent restarted.');
 }
 const oldVisible=screen.queryByText(oldCommand)!==null,newVisible=screen.queryByText(newCommand)!==null;
 console.log('AUDIT25 attach after restart',JSON.stringify({restart,oldVisible,newVisible}));
 expect(restart?newVisible:oldVisible).toBe(true);
 if(restart)expect(oldVisible).toBe(false);
});

