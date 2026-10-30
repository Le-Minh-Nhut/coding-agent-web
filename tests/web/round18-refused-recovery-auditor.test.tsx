// @vitest-environment jsdom
import React,{useState} from "react";
import {afterEach,expect,it,vi} from "vitest";
import {act,cleanup,fireEvent,render,screen,waitFor} from "@testing-library/react";
import {CollabSocket,type HostFrame} from "@caw/collab-protocol";
import {ConversationView} from "../../apps/web/src/components/ConversationView.js";
import {App} from "../../apps/web/src/App.js";
import {api} from "../../apps/web/src/api.js";
vi.mock("../../apps/web/src/api.js",()=>({api:{getConversation:vi.fn(),getAttachInstructions:vi.fn(),getConversationLink:vi.fn(),getModels:vi.fn(),getMe:vi.fn(),getCapabilities:vi.fn(),listProjects:vi.fn(),listConversations:vi.fn(),listNativeSessions:vi.fn()},setCsrfToken:vi.fn()}));
afterEach(()=>{cleanup();vi.restoreAllMocks();});
const welcome:HostFrame={t:"welcome",proto:3,header:{type:"session",id:"s",cwd:"/",timestamp:""},state:{isStreaming:false,queuedMessageCount:0,cwd:"/",participants:[]},agents:[],entryCount:0};
const refusal:HostFrame={t:"error",message:"prompting is unavailable until the host finishes starting up"};
function Parent(){const[open,setOpen]=useState(true);const[draft,setDraft]=useState("");return open?<ConversationView conversationId="c" draft={draft} onDraftChange={setDraft} onBack={()=>setOpen(false)}/>:<button onClick={()=>setOpen(true)}>Reopen same chat</button>;}
async function fixture(realApp=false){
 vi.mocked(api.getConversation).mockResolvedValue({ok:true,data:{id:"c",title:"Chat",state:"idle",ownership:"managed"}} as any);
 vi.mocked(api.getAttachInstructions).mockResolvedValue({ok:true,data:{available:false}} as any);
 vi.mocked(api.getModels).mockResolvedValue({ok:true,data:{models:[],source:"omp",reason:null}});
 vi.mocked(api.getConversationLink).mockResolvedValue({ok:true,data:{url:"ws://127.0.0.1:7466/r/0123456789abcdef.AQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQE",access:"full",instanceId:"i",generation:1}});
 let socket:CollabSocket|null=null;
 vi.spyOn(CollabSocket.prototype,"connect").mockImplementation(function(this:CollabSocket){socket=this;this.onOpen?.();});
 vi.spyOn(CollabSocket.prototype,"send").mockResolvedValue(true);
 vi.mocked(api.getMe).mockResolvedValue({ok:true,data:{csrfToken:"test"}});
 vi.mocked(api.getCapabilities).mockResolvedValue({ok:true,data:{}} as any);
 vi.mocked(api.listProjects).mockResolvedValue({ok:true,data:[{id:"p",path:"/work",label:"Project A",favorite:false,conversationCount:1,lastActivityAt:null,createdAt:"",updatedAt:""}]});
 vi.mocked(api.listConversations).mockResolvedValue({ok:true,data:[{id:"c",projectId:"p",title:"Chat",state:"idle",ownership:"managed"}]} as any);
 vi.mocked(api.listNativeSessions).mockResolvedValue({ok:true,data:[]});
 const view=render(realApp?<App/>:<Parent/>);
 if(realApp){fireEvent.click(await screen.findByText("Project A"));fireEvent.click(await screen.findByText("Chat"));}
 await waitFor(()=>expect(socket).not.toBeNull());await act(async()=>socket!.onFrame?.(welcome,0));
 const input=()=>view.container.querySelector("textarea")!;
 const type=(value:string)=>fireEvent.change(input(),{target:{value}});
 const send=async()=>{await act(async()=>fireEvent.submit(input().closest("form")!));};
 const refuse=async()=>{await act(async()=>socket!.onFrame?.(refusal,0));};
 return {view,input,type,send,refuse,socket:()=>socket,welcome:async()=>{await act(async()=>socket!.onFrame?.(welcome,0));}};
}
it("V18 refused text survives actual App Back/reopen navigation along with its newer draft",async()=>{
 const f=await fixture(true);f.type("REFUSED_B");await f.send();f.type("DRAFT_C");await f.refuse();expect(f.view.container.textContent).toContain("REFUSED_B");
 const old=f.socket();fireEvent.click(screen.getByTitle("Back"));fireEvent.click(await screen.findByText("Chat"));
 await waitFor(()=>expect(f.socket()).not.toBe(old));await f.welcome();
 const recoverable=f.view.container.textContent!.includes("REFUSED_B");
 console.log("AUDIT18 refusal reopen",JSON.stringify({draft:f.input().value,refusedRecoverable:recoverable}));
 expect(f.input().value).toBe("DRAFT_C");expect(recoverable).toBe(true);
});
it("V18 a second refused prompt cannot silently replace the only recovery copy of the first",async()=>{
 const f=await fixture();f.type("REFUSED_B");await f.send();f.type("REFUSED_C");await f.refuse();expect(f.view.container.textContent).toContain("REFUSED_B");
 await f.send();f.type("DRAFT_D");await f.refuse();
 const b=f.view.container.textContent!.includes("REFUSED_B"),c=f.view.container.textContent!.includes("REFUSED_C");
 console.log("AUDIT18 refusal replacement",JSON.stringify({draft:f.input().value,recoverableB:b,recoverableC:c}));
 expect(f.input().value).toBe("DRAFT_D");expect(b).toBe(true);expect(c).toBe(true);
});
it("V18 refused recovery is keyed by conversation: A's strip never appears in B and returns with A",async()=>{
 vi.mocked(api.getConversation).mockResolvedValue({ok:true,data:{id:"c",title:"Chat",state:"idle",ownership:"managed"}} as any);
 vi.mocked(api.getAttachInstructions).mockResolvedValue({ok:true,data:{available:false}} as any);
 vi.mocked(api.getModels).mockResolvedValue({ok:true,data:{models:[],source:"omp",reason:null}});
 vi.mocked(api.getConversationLink).mockResolvedValue({ok:true,data:{url:"ws://127.0.0.1:7466/r/0123456789abcdef.AQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQE",access:"full",instanceId:"i",generation:1}});
 const sockets:CollabSocket[]=[];
 vi.spyOn(CollabSocket.prototype,"connect").mockImplementation(function(this:CollabSocket){sockets.push(this);this.onOpen?.();});
 vi.spyOn(CollabSocket.prototype,"send").mockResolvedValue(true);
 vi.mocked(api.getMe).mockResolvedValue({ok:true,data:{csrfToken:"test"}});
 vi.mocked(api.getCapabilities).mockResolvedValue({ok:true,data:{}} as any);
 vi.mocked(api.listProjects).mockResolvedValue({ok:true,data:[{id:"p",path:"/work",label:"Project A",favorite:false,conversationCount:2,lastActivityAt:null,createdAt:"",updatedAt:""}]});
 vi.mocked(api.listConversations).mockResolvedValue({ok:true,data:[{id:"c",projectId:"p",title:"Chat",state:"idle",ownership:"managed"},{id:"c2",projectId:"p",title:"Other",state:"idle",ownership:"managed"}]} as any);
 vi.mocked(api.listNativeSessions).mockResolvedValue({ok:true,data:[]});
 const view=render(<App/>);
 fireEvent.click(await screen.findByText("Project A"));
 fireEvent.click(await screen.findByText("Chat"));
 await waitFor(()=>expect(sockets).toHaveLength(1));
 await act(async()=>sockets[0]!.onFrame?.(welcome,0));
 const input=()=>view.container.querySelector("textarea")!;
 fireEvent.change(input(),{target:{value:"A_REFUSED"}});
 await act(async()=>fireEvent.submit(input().closest("form")!));
 fireEvent.change(input(),{target:{value:"A_DRAFT"}});
 await act(async()=>sockets[0]!.onFrame?.(refusal,0));
 expect(view.container.textContent).toContain("A_REFUSED");
 fireEvent.click(screen.getByTitle("Back"));
 fireEvent.click(await screen.findByText("Other"));
 await waitFor(()=>expect(sockets).toHaveLength(2));
 await act(async()=>sockets[1]!.onFrame?.(welcome,0));
 const leakedIntoB=view.container.textContent!.includes("A_REFUSED");
 fireEvent.click(screen.getByTitle("Back"));
 fireEvent.click(await screen.findByText("Chat"));
 await waitFor(()=>expect(sockets).toHaveLength(3));
 await act(async()=>sockets[2]!.onFrame?.(welcome,0));
 const backInA=view.container.textContent!.includes("A_REFUSED");
 console.log("AUDIT18 refusal cross-conversation",JSON.stringify({leakedIntoB,backInA}));
 expect(leakedIntoB).toBe(false);
 expect(backInA).toBe(true);
});

