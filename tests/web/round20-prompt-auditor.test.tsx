// @vitest-environment jsdom
import React from "react";
import {afterEach,expect,it,vi} from "vitest";
import {act,cleanup,fireEvent,render,screen,waitFor} from "@testing-library/react";
import {CollabSocket,type HostFrame} from "@caw/collab-protocol";
import {ConversationView} from "../../apps/web/src/components/ConversationView.js";
import {App} from "../../apps/web/src/App.js";
import {api} from "../../apps/web/src/api.js";
vi.mock("../../apps/web/src/api.js",()=>({api:{getConversation:vi.fn(),getAttachInstructions:vi.fn(),getConversationLink:vi.fn(),getModels:vi.fn(),getConversationHistory:vi.fn(),getMe:vi.fn(),getCapabilities:vi.fn(),listProjects:vi.fn(),listConversations:vi.fn(),listNativeSessions:vi.fn()}}));
afterEach(()=>{cleanup();vi.restoreAllMocks();});
const base:any={id:"c",projectId:"p",title:"Chat",state:"idle",ownership:"managed",modelPreference:"model-a",model:"model-a",nativeSessionId:"native-A"};
function welcome(entryCount=0):HostFrame{return {t:"welcome",proto:3,header:{type:"session",id:"native-A",cwd:"/work",timestamp:""},state:{isStreaming:false,queuedMessageCount:0,cwd:"/work",participants:[]},agents:[],entryCount};}
const refusal:HostFrame={t:"error",message:"prompting is unavailable until the host finishes starting up"};
const row=(id:string,text:string,ts=1):any=>({type:"message",id,parentId:null,timestamp:"2026-01-01T00:00:00Z",message:{role:"user",content:text,timestamp:ts}});
const collabRow=(id:string,text:string):any=>({type:"custom_message",id,parentId:null,timestamp:new Date().toISOString(),customType:"collab-prompt",content:text,display:true,details:{from:"Mobile Web Controller"}});
async function fixture(entryCount=0,realApp=false){
 vi.mocked(api.getConversation).mockResolvedValue({ok:true,data:{...base}});
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

it.each([false,true])("V20 one real collab-prompt echo acknowledges only one same-text bootstrap send (historical twin=%s)",async(historical)=>{
 const f=await fixture(1);
 await f.send("continue");
 await f.send("continue");
 f.type("NEW_UNSENT_DRAFT");
 // Use the actual host order: the frozen baseline dump precedes every live
 // entry. OMP emits a web prompt as custom_message/collab-prompt, not message.
 await f.emit({t:"snapshot-chunk",entries:[row("old",historical?"continue":"unrelated old row")],final:true});
 await f.emit({t:"entry",entry:collabRow("accepted-new","continue")});
 // There is exactly one new host receipt, plus one still-unconfirmed local
 // send. The baseline row, when same-text, is additional to those two rows.
 const rows=f.view.getAllByText("continue").length;
 console.log("AUDIT20 same-text bootstrap real-wire order",JSON.stringify({historical,draft:f.input().value,newHostReceipts:1,localSends:2,rows,expectedRows:historical?3:2}));
 expect(f.input().value).toBe("NEW_UNSENT_DRAFT");
 expect(rows).toBe(historical?3:2);
});

it("V20 an unacknowledged send survives Back/reopen before any refusal can arrive",async()=>{
 const f=await fixture(0,true);
 await f.send("UNCONFIRMED_PROMPT_A");
 f.type("UNSENT_DRAFT_B");
 // The host has not journaled/echoed A. Closing the view closes its socket,
 // so a later startup refusal cannot reach the unmounted callback.
 fireEvent.click(screen.getByTitle("Back"));
 fireEvent.click(await screen.findByText("Chat"));
 await waitFor(()=>expect(f.sockets).toHaveLength(2));
 await f.emit(welcome(0));
 const present=f.view.container.textContent!.includes("UNCONFIRMED_PROMPT_A")||f.input().value.includes("UNCONFIRMED_PROMPT_A");
 console.log("AUDIT20 unconfirmed navigation",JSON.stringify({draft:f.input().value,unconfirmedRecoverable:present,recovery:f.recovery()}));
 expect(f.input().value).toBe("UNSENT_DRAFT_B");
 expect(present).toBe(true);
});

it("V20 completed snapshot before sends still attributes one real collab echo to just one same-text send",async()=>{
 const f=await fixture(1);
 await f.emit({t:"snapshot-chunk",entries:[row("old","continue")],final:true});
 await f.send("continue");await f.send("continue");f.type("NEW_UNSENT_DRAFT");
 await f.emit({t:"entry",entry:collabRow("new","continue")});
 const rows=f.view.getAllByText("continue").length;
 console.log("AUDIT20 after-bootstrap control",JSON.stringify({draft:f.input().value,rows,expectedRows:3}));
 expect(rows).toBe(3);
});

it("V20 recovery remains copyable when a refused host disappears and Retry cannot mint a link",async()=>{
 const f=await fixture();await f.send("REFUSED_COPY_ME");f.type("KEEP_MY_DRAFT");await f.emit(refusal);
 expect(f.recovery()).toContain("REFUSED_COPY_ME");
 await act(async()=>f.sockets.at(-1)!.onClose?.("host stopped",false));
 vi.mocked(api.getConversationLink).mockResolvedValue({ok:false,error:{code:"link_unavailable",message:"No host"}});
 vi.mocked(api.getConversationHistory).mockResolvedValue({ok:true,data:{header:{sessionId:"native-A",cwd:"/work",timestamp:null,version:3,title:"History"},entries:[],hasOlder:false,nextCursor:null,truncated:false,truncatedByBytes:false,truncatedByEntries:false,skippedOversized:false}});
 await act(async()=>fireEvent.click(f.view.getByRole("button",{name:"Retry"})));
 await f.view.findByText(/Saved transcript —/);
 const copyButtons=f.view.queryAllByRole("button",{name:"Copy"}).length;
 console.log("AUDIT20 offline recovery",JSON.stringify({recovery:f.recovery(),copyButtons}));
 // Copy reads a local value; a live/full-capability room is not needed.
 expect(copyButtons).toBeGreaterThan(0);
});

it.each([
 "prompting is unavailable until the session transition completes",
 "Prompt was not submitted. Please resend it when the host is ready.",
])("V20 explicit OMP non-submission keeps the prompt recoverable: %s",async(message)=>{
 const f=await fixture();await f.send("HOST_DID_NOT_SUBMIT_A");f.type("NEW_UNSENT_B");
 await f.emit({t:"error",message});
 console.log("AUDIT20 actual host non-submission",JSON.stringify({message,draft:f.input().value,recovery:f.recovery()}));
 expect(f.input().value).toBe("NEW_UNSENT_B");
 expect(f.recovery()).toContain("HOST_DID_NOT_SUBMIT_A");
});

it("V20 an unrelated host error does not falsely refuse the pending prompt",async()=>{
 const f=await fixture();await f.send("STILL_PENDING_A");f.type("NEW_UNSENT_B");
 await f.emit({t:"error",message:"agent control is disabled on a read-only link"});
 expect(f.recovery()).toBe("");expect(f.input().value).toBe("NEW_UNSENT_B");
});
