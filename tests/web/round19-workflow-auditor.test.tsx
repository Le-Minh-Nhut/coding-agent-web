// @vitest-environment jsdom
import React from "react";
import {afterEach,expect,it,vi} from "vitest";
import {act,cleanup,fireEvent,render,waitFor} from "@testing-library/react";
import {CollabSocket,type HostFrame} from "@caw/collab-protocol";
import {ConversationView} from "../../apps/web/src/components/ConversationView.js";
import {api} from "../../apps/web/src/api.js";
vi.mock("../../apps/web/src/api.js",()=>({api:{getConversation:vi.fn(),getAttachInstructions:vi.fn(),getConversationLink:vi.fn(),getModels:vi.fn(),getConversationHistory:vi.fn(),setConversationModel:vi.fn(),restartConversation:vi.fn()}}));
afterEach(()=>{cleanup();vi.restoreAllMocks();});
const base:any={id:"c",projectId:"p",title:"Chat",state:"idle",ownership:"managed",modelPreference:"model-a",model:"model-a",nativeSessionId:"native-A"};
function welcome(entryCount=0):HostFrame{return {t:"welcome",proto:3,header:{type:"session",id:"native-A",cwd:"/work",timestamp:""},state:{isStreaming:false,queuedMessageCount:0,cwd:"/work",participants:[]},agents:[],entryCount};}
async function fixture(entryCount=0){
 vi.mocked(api.getConversation).mockResolvedValue({ok:true,data:{...base}});
 vi.mocked(api.getAttachInstructions).mockResolvedValue({ok:true,data:{available:false}} as any);
 vi.mocked(api.getModels).mockResolvedValue({ok:true,data:{models:["model-a","model-b","model-c"],source:"omp",reason:null}});
 vi.mocked(api.getConversationLink).mockResolvedValue({ok:true,data:{url:"ws://127.0.0.1:7466/r/0123456789abcdef.AQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQE",access:"full",instanceId:"host-A",generation:1}});
 vi.mocked(api.getConversationHistory).mockResolvedValue({ok:false,error:{code:"not_found",message:"No saved history"}});
 let socket:CollabSocket|null=null;
 vi.spyOn(CollabSocket.prototype,"connect").mockImplementation(function(this:CollabSocket){socket=this;this.onOpen?.();});
 vi.spyOn(CollabSocket.prototype,"send").mockResolvedValue(true);
 const view=render(<ConversationView conversationId="c" onBack={()=>{}}/>);
 await waitFor(()=>expect(socket).not.toBeNull());await act(async()=>socket!.onFrame?.(welcome(entryCount),0));
 return {view,emit:async(frame:HostFrame)=>{await act(async()=>socket!.onFrame?.(frame,0));},disconnect:async()=>{await act(async()=>socket!.onClose?.("network closed",false));}};
}
it.each([false,true])("V19 historical snapshot text cannot acknowledge a newly sent prompt (same text=%s)",async(sameText)=>{
 const f=await fixture(1);const composer=f.view.container.querySelector("textarea")!;
 fireEvent.change(composer,{target:{value:"continue"}});await act(async()=>fireEvent.click(f.view.getByRole("button",{name:"Send"})));
 expect(composer.value).toBe("");
 // This entry predates the new send; the welcome snapshot was still in flight.
 const entry:any={type:"message",id:"old-entry",parentId:null,timestamp:"2026-01-01T00:00:00Z",message:{role:"user",content:sameText?"continue":"an unrelated old instruction",timestamp:1}};
 await f.emit({t:"snapshot-chunk",entries:[entry],final:true});
 await f.emit({t:"error",message:"prompting is unavailable until the host finishes starting up"});
 const recovery=f.view.container.querySelector(".refused-prompt")?.textContent??"";
 const recoverable=composer.value==="continue"||recovery.includes("continue");
 console.log("AUDIT19 snapshot false ack",JSON.stringify({sameText,draft:composer.value,recovery,recoverable}));
 expect(recoverable).toBe(true);
});

it("V19 a live-to-saved-history fallback renders each native message only once",async()=>{
 const f=await fixture(1);
 const entry:any={type:"message",id:"same-entry",parentId:null,timestamp:"2026-01-01T00:00:00Z",message:{role:"user",content:"ONE_NATIVE_MESSAGE",timestamp:1}};
 await f.emit({t:"snapshot-chunk",entries:[entry],final:true});
 expect(f.view.getAllByText("ONE_NATIVE_MESSAGE")).toHaveLength(1);
 await f.disconnect();
 vi.mocked(api.getConversationLink).mockResolvedValue({ok:false,error:{code:"link_unavailable",message:"Agent stopped"}});
 vi.mocked(api.getConversationHistory).mockResolvedValue({ok:true,data:{header:{sessionId:"native-A",cwd:"/work",timestamp:null,version:3,title:"History"},entries:[entry],truncated:false,truncatedByBytes:false,truncatedByEntries:false,skippedOversized:false,hasOlder:false,nextCursor:null}});
 await act(async()=>fireEvent.click(f.view.getByRole("button",{name:"Retry"})));
 await f.view.findByText(/Saved transcript —/);
 const rows=f.view.getAllByText("ONE_NATIVE_MESSAGE").length;
 console.log("AUDIT19 live to saved duplicates",JSON.stringify({nativeEntries:1,displayedRows:rows}));
 expect(rows).toBe(1);
});
it.each([false,true])("V19 restart completion keeps model edits made while it was pending=%s",async(editDuring)=>{
 const f=await fixture();vi.spyOn(window,"confirm").mockReturnValue(true);
 let finishSave!:(value:any)=>void,finishRestart!:(value:any)=>void;
 vi.mocked(api.setConversationModel).mockReturnValue(new Promise(resolve=>finishSave=resolve));
 vi.mocked(api.restartConversation).mockReturnValue(new Promise(resolve=>finishRestart=resolve));
 fireEvent.click(f.view.getByText("Conversation model settings"));
 const input=f.view.getByLabelText("Custom model ID") as HTMLInputElement;
 fireEvent.change(input,{target:{value:"model-b"}});
 fireEvent.click(f.view.getByRole("button",{name:"Save & restart agent"}));
 expect(input.disabled).toBe(false);
 if(editDuring)fireEvent.change(input,{target:{value:"model-c"}});
 await act(async()=>finishSave({ok:true,data:{...base,modelPreference:"model-b"}}));
 await act(async()=>finishRestart({ok:true,data:{...base,modelPreference:"model-b",model:"model-b"}}));
 console.log("AUDIT19 model restart draft",JSON.stringify({editDuring,draft:input.value}));
 expect(input.value).toBe(editDuring?"model-c":"model-b");
});

it("V19 restart via Enter-key send during bootstrap still recovers the refused prompt",async()=>{
 const f=await fixture(1);
 const composer=f.view.container.querySelector("textarea")!;
 fireEvent.change(composer,{target:{value:"continue"}});
 await act(async()=>{fireEvent.keyDown(composer,{key:"Enter",shiftKey:false});});
 expect(composer.value).toBe("");
 const entry:any={type:"message",id:"old-key",parentId:null,timestamp:"2026-01-01T00:00:00Z",message:{role:"user",content:"continue",timestamp:1}};
 await f.emit({t:"snapshot-chunk",entries:[entry],final:true});
 await f.emit({t:"error",message:"prompting is unavailable until the host finishes starting up"});
 const recovery=f.view.container.querySelector(".refused-prompt")?.textContent??"";
 console.log("AUDIT19 enter key bootstrap",JSON.stringify({draft:composer.value,recovery}));
 expect(composer.value==="continue"||recovery.includes("continue")).toBe(true);
});

it("V19 a post-snapshot send is acknowledged by its own echo as before",async()=>{
 const f=await fixture(0);
 const composer=f.view.container.querySelector("textarea")!;
 fireEvent.change(composer,{target:{value:"hi"}});
 await act(async()=>fireEvent.click(f.view.getByRole("button",{name:"Send"})));
 await f.emit({t:"event",event:{type:"message_end",message:{role:"user",content:"hi",timestamp:1}}});
 await f.emit({t:"error",message:"prompting is unavailable until the host finishes starting up"});
 const recovery=f.view.container.querySelector(".refused-prompt")?.textContent??"";
 console.log("AUDIT19 post snapshot refusal",JSON.stringify({draft:composer.value,recovery,userRows:f.view.container.querySelectorAll(".message-card.user").length}));
 expect(recovery).toBe("");
 expect(composer.value).toBe("");
});

it("V19 a pre-snapshot prompt whose snapshot text differs still refuses into recovery",async()=>{
 const f=await fixture(1);
 const composer=f.view.container.querySelector("textarea")!;
 fireEvent.change(composer,{target:{value:"continue"}});
 await act(async()=>fireEvent.click(f.view.getByRole("button",{name:"Send"})));
 const entry:any={type:"message",id:"old-other",parentId:null,timestamp:"2026-01-01T00:00:00Z",message:{role:"user",content:"an unrelated old instruction",timestamp:1}};
 await f.emit({t:"snapshot-chunk",entries:[entry],final:true});
 await f.emit({t:"error",message:"prompting is unavailable until the host finishes starting up"});
 const recovery=f.view.container.querySelector(".refused-prompt")?.textContent??"";
 console.log("AUDIT19 differing snapshot control",JSON.stringify({draft:composer.value,recovery}));
 // The composer was never retyped, so the direct-restore path is correct here:
 // the refused text is back in the composer (or, if a strip exists, in the strip).
 expect(composer.value==="continue"||recovery.includes("continue")).toBe(true);
});

it("V19 live-to-saved-to-live keeps each native row once and preserves an unacked prompt",async()=>{
 const f=await fixture(1);
 const entry:any={type:"message",id:"same-entry",parentId:null,timestamp:"2026-01-01T00:00:00Z",message:{role:"user",content:"ONE_NATIVE_MESSAGE",timestamp:1}};
 await f.emit({t:"snapshot-chunk",entries:[entry],final:true});
 expect(f.view.getAllByText("ONE_NATIVE_MESSAGE")).toHaveLength(1);
 const composer=f.view.container.querySelector("textarea")!;
 fireEvent.change(composer,{target:{value:"UNACKED_LOCAL"}});
 await act(async()=>fireEvent.click(f.view.getByRole("button",{name:"Send"})));
 await f.disconnect();
 vi.mocked(api.getConversationLink).mockResolvedValue({ok:false,error:{code:"link_unavailable",message:"Agent stopped"}});
 vi.mocked(api.getConversationHistory).mockResolvedValue({ok:true,data:{header:{sessionId:"native-A",cwd:"/work",timestamp:null,version:3,title:"History"},entries:[entry],truncated:false,truncatedByBytes:false,truncatedByEntries:false,skippedOversized:false,hasOlder:false,nextCursor:null}});
 await act(async()=>fireEvent.click(f.view.getByRole("button",{name:"Retry"})));
 await f.view.findByText(/Saved transcript —/);
 expect(f.view.getAllByText("ONE_NATIVE_MESSAGE")).toHaveLength(1);
 expect(f.view.getAllByText("UNACKED_LOCAL")).toHaveLength(1);
 console.log("AUDIT19 live-saved-live",JSON.stringify({native:f.view.getAllByText("ONE_NATIVE_MESSAGE").length,optimistic:f.view.getAllByText("UNACKED_LOCAL").length}));
});

it("V19 saved paging dedupes repeated entry ids after entering saved mode",async()=>{
 const f=await fixture(0);
 await f.disconnect();
 vi.mocked(api.getConversationLink).mockResolvedValue({ok:false,error:{code:"link_unavailable",message:"Agent stopped"}});
 const older=(id:string,text:string)=>({type:"message",id,parentId:null,timestamp:"2026-01-01T00:00:02Z",message:{role:"user",content:text,timestamp:2}});
 vi.mocked(api.getConversationHistory)
  .mockResolvedValueOnce({ok:true,data:{header:{sessionId:"native-A",cwd:"/work",timestamp:null,version:3,title:"History"},entries:[older("b","PAGE_B")],truncated:false,truncatedByBytes:false,truncatedByEntries:false,skippedOversized:false,hasOlder:true,nextCursor:"cursor-1"}} as any)
  .mockResolvedValueOnce({ok:true,data:{header:{sessionId:"native-A",cwd:"/work",timestamp:null,version:3,title:"History"},entries:[older("a","PAGE_A"),older("b","PAGE_B")],truncated:false,truncatedByBytes:false,truncatedByEntries:false,skippedOversized:false,hasOlder:false,nextCursor:null}} as any);
 await act(async()=>fireEvent.click(f.view.getByRole("button",{name:"Retry"})));
 await f.view.findByText(/Saved transcript —/);
 await act(async()=>fireEvent.click(f.view.getByRole("button",{name:"Load older"})));
 await f.view.findByText("PAGE_A");
 console.log("AUDIT19 saved paging dedupe",JSON.stringify({b:f.view.getAllByText("PAGE_B").length,a:f.view.getAllByText("PAGE_A").length}));
 expect(f.view.getAllByText("PAGE_B")).toHaveLength(1);
 expect(f.view.getAllByText("PAGE_A")).toHaveLength(1);
});

it("V19 an unacked prompt that matches a saved row does not duplicate it",async()=>{
 const f=await fixture(0);
 const entry:any={type:"message",id:"echo-entry",parentId:null,timestamp:"2026-01-01T00:00:00Z",message:{role:"user",content:"MATCHED",timestamp:1}};
 const composer=f.view.container.querySelector("textarea")!;
 fireEvent.change(composer,{target:{value:"MATCHED"}});
 await act(async()=>fireEvent.click(f.view.getByRole("button",{name:"Send"})));
 await f.disconnect();
 vi.mocked(api.getConversationLink).mockResolvedValue({ok:false,error:{code:"link_unavailable",message:"Agent stopped"}});
 vi.mocked(api.getConversationHistory).mockResolvedValue({ok:true,data:{header:{sessionId:"native-A",cwd:"/work",timestamp:null,version:3,title:"History"},entries:[entry],truncated:false,truncatedByBytes:false,truncatedByEntries:false,skippedOversized:false,hasOlder:false,nextCursor:null}} as any);
 await act(async()=>fireEvent.click(f.view.getByRole("button",{name:"Retry"})));
 await f.view.findByText(/Saved transcript —/);
 console.log("AUDIT19 saved-mode matching optimistic",JSON.stringify({rows:f.view.getAllByText("MATCHED").length}));
 expect(f.view.getAllByText("MATCHED")).toHaveLength(1);
});

it("V19 restart save-only success and failure keep the edited draft",async()=>{
 const f=await fixture();
 fireEvent.click(f.view.getByText("Conversation model settings"));
 const input=f.view.getByLabelText("Custom model ID") as HTMLInputElement;
 vi.mocked(api.setConversationModel).mockResolvedValue({ok:true,data:{...base,modelPreference:"model-b"}} as any);
 fireEvent.change(input,{target:{value:"model-b"}});
 await act(async()=>fireEvent.click(f.view.getByRole("button",{name:"Save model"})));
 expect(input.value).toBe("model-b");
 vi.mocked(api.setConversationModel).mockResolvedValue({ok:false,error:{code:"internal",message:"save failed"}} as any);
 fireEvent.change(input,{target:{value:"model-z"}});
 await act(async()=>fireEvent.click(f.view.getByRole("button",{name:"Save model"})));
 console.log("AUDIT19 save-only",JSON.stringify({draft:input.value}));
 expect(input.value).toBe("model-z");
});

it("V19 restart submitted value is the edited draft, so unchanged completion is consistent",async()=>{
 const f=await fixture();vi.spyOn(window,"confirm").mockReturnValue(true);
 let finishSave!:(value:any)=>void,finishRestart!:(value:any)=>void;
 const saveSpy=vi.mocked(api.setConversationModel).mockReturnValue(new Promise(resolve=>finishSave=resolve));
 vi.mocked(api.restartConversation).mockReturnValue(new Promise(resolve=>finishRestart=resolve));
 fireEvent.click(f.view.getByText("Conversation model settings"));
 const input=f.view.getByLabelText("Custom model ID") as HTMLInputElement;
 // Edit BEFORE clicking restart: the edited value is what gets submitted, so the
 // completion applying the server value back is consistent with the user's intent.
 fireEvent.change(input,{target:{value:"model-c"}});
 fireEvent.click(f.view.getByRole("button",{name:"Save & restart agent"}));
 expect(saveSpy).toHaveBeenCalledWith("c","model-c");
 await act(async()=>finishSave({ok:true,data:{...base,modelPreference:"model-c"}}));
 await act(async()=>finishRestart({ok:true,data:{...base,modelPreference:"model-c",model:"model-c"}}));
 console.log("AUDIT19 edit before restart",JSON.stringify({draft:input.value,submitted:saveSpy.mock.calls.at(-1)?.[1]}));
 expect(input.value).toBe("model-c");
});

it("V19 dropdown edit during restart is preserved too",async()=>{
 const f=await fixture();vi.spyOn(window,"confirm").mockReturnValue(true);
 let finishSave!:(value:any)=>void,finishRestart!:(value:any)=>void;
 vi.mocked(api.setConversationModel).mockReturnValue(new Promise(resolve=>finishSave=resolve));
 vi.mocked(api.restartConversation).mockReturnValue(new Promise(resolve=>finishRestart=resolve));
 fireEvent.click(f.view.getByText("Conversation model settings"));
 const input=f.view.getByLabelText("Custom model ID") as HTMLInputElement;
 const select=f.view.container.querySelector("#conversation-model") as HTMLSelectElement;
 fireEvent.change(input,{target:{value:"model-b"}});
 fireEvent.click(f.view.getByRole("button",{name:"Save & restart agent"}));
 fireEvent.change(select,{target:{value:"model-c"}});
 expect(select.value).toBe("model-c");
 await act(async()=>finishSave({ok:true,data:{...base,modelPreference:"model-b"}}));
 await act(async()=>finishRestart({ok:true,data:{...base,modelPreference:"model-b",model:"model-b"}}));
 console.log("AUDIT19 dropdown edit during restart",JSON.stringify({select:select.value,input:input.value,disabled:input.disabled}));
 expect(input.value).toBe("model-c");
 expect(input.disabled).toBe(false);
});

// ── Round-19 post-fix regressions (reviewer findings 1 and 6) ────────────────

/**
 * Finding 1: a pre-snapshot prompt whose echo arrived as a GENUINE live frame
 * during the bootstrap snapshot. The replay applies that echo, so the prompt is
 * genuinely acknowledged — the rebase must not raise its allowance and block it.
 *
 * Old behaviour: the rebase set hostEchoCount to the replay-published count, the
 * optimistic row survived the allowance filter (duplicate), and the prompt stayed
 * pending so the LATER refusal was misattributed to it (find() picks the first
 * pending prompt).
 */
it.each(["entry","message_end"] as const)("V19-fix1 a live echo during bootstrap is acknowledged, not rebased (%s)",async(kind)=>{
 const f=await fixture(1);
 const composer=f.view.container.querySelector("textarea")!;
 fireEvent.change(composer,{target:{value:"A_ACCEPTED"}});
 await act(async()=>fireEvent.click(f.view.getByRole("button",{name:"Send"})));
 expect(composer.value).toBe("");
 // The real echo for A_ACCEPTED arrives as a live frame while the snapshot is in
 // flight; the reducer queues it into pendingSnapshot.live and the completing
 // snapshot replays it.
 const liveA:HostFrame=kind==="entry"
  ?{t:"entry",entry:{type:"message",id:"live-a",parentId:null,timestamp:"2026-01-01T00:00:00Z",message:{role:"user",content:"A_ACCEPTED",timestamp:1}} as any}
  :{t:"event",event:{type:"message_end",message:{role:"user",content:"A_ACCEPTED",timestamp:1} as any}};
 await f.emit(liveA);
 const oldEntry:any={type:"message",id:"old-history",parentId:null,timestamp:"2026-01-01T00:00:00Z",message:{role:"user",content:"OLD_HISTORY",timestamp:1}};
 await f.emit({t:"snapshot-chunk",entries:[oldEntry],final:true});
 const aRows=f.view.getAllByText("A_ACCEPTED").length;
 console.log("AUDIT19-fix1 live echo during bootstrap",JSON.stringify({kind,aRows}));
 expect(aRows).toBe(1);
 // A is genuinely acknowledged: the NEXT refusal belongs to B, not to A.
 fireEvent.change(composer,{target:{value:"B_REFUSED"}});
 await act(async()=>fireEvent.click(f.view.getByRole("button",{name:"Send"})));
 fireEvent.change(composer,{target:{value:"my newer draft"}});
 await f.emit({t:"error",message:"prompting is unavailable until the host finishes starting up"});
 const recovery=f.view.container.querySelector(".refused-prompt")?.textContent??"";
 console.log("AUDIT19-fix1 refusal attribution",JSON.stringify({kind,recovery,draft:composer.value,aRows:f.view.getAllByText("A_ACCEPTED").length}));
 expect(recovery).toContain("B_REFUSED");
 expect(recovery).not.toContain("A_ACCEPTED");
 expect(composer.value).toBe("my newer draft");
 expect(f.view.getAllByText("A_ACCEPTED")).toHaveLength(1);
});

/**
 * Finding 6: the live streaming assistant bubble must not render in saved mode,
 * where the journal is the only transcript source.
 */
it("V19-fix6 a live streaming bubble does not persist into saved mode",async()=>{
 // entryCount 0: the assistant stream must be applied live (not queued behind a
 // bootstrap snapshot) for the bubble to exist before the fallback.
 const f=await fixture(0);
 const stream={t:"event",event:{type:"message_start",message:{role:"assistant",content:[{type:"text",text:"STREAMING_PARTIAL"}],model:"model-a",usage:{input:0,output:0,cacheRead:0,cacheWrite:0,totalTokens:0,cost:{total:0}},stopReason:"stop",timestamp:1}}} as HostFrame;
 await f.emit(stream);
 expect(f.view.getByText("Assistant (streaming…)")).toBeTruthy();
 expect(f.view.getByText("STREAMING_PARTIAL")).toBeTruthy();
 await f.disconnect();
 vi.mocked(api.getConversationLink).mockResolvedValue({ok:false,error:{code:"link_unavailable",message:"Agent stopped"}});
 vi.mocked(api.getConversationHistory).mockResolvedValue({ok:true,data:{header:{sessionId:"native-A",cwd:"/work",timestamp:null,version:3,title:"History"},entries:[],truncated:false,truncatedByBytes:false,truncatedByEntries:false,skippedOversized:false,hasOlder:false,nextCursor:null}} as any);
 await act(async()=>fireEvent.click(f.view.getByRole("button",{name:"Retry"})));
 await f.view.findByText(/Saved transcript —/);
 const streamingBubble=f.view.queryByText("Assistant (streaming…)");
 const partial=f.view.queryByText("STREAMING_PARTIAL");
 console.log("AUDIT19-fix6 saved mode streaming",JSON.stringify({streamingBubble:streamingBubble!==null,partial:partial!==null}));
 expect(streamingBubble).toBeNull();
 expect(partial).toBeNull();
});

