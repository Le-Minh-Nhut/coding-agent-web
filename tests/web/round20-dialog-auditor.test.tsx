// @vitest-environment jsdom
import React from "react";
import {afterEach,expect,it,vi} from "vitest";
import {act,cleanup,fireEvent,render,screen} from "@testing-library/react";
import {ProjectsView} from "../../apps/web/src/components/ProjectsView.js";
import {api} from "../../apps/web/src/api.js";
vi.mock("../../apps/web/src/api.js",()=>({api:{listProjects:vi.fn(),updateProject:vi.fn(),createProject:vi.fn()}}));
vi.mock("../../apps/web/src/components/FolderBrowser.js",()=>({FolderBrowser:({onSelect}:any)=><button onClick={()=>onSelect("/work/A")}>Pick A</button>}));
afterEach(()=>{cleanup();vi.restoreAllMocks();});
const deferred=()=>{let resolve!:(v:any)=>void;const promise=new Promise(r=>resolve=r);return {promise,resolve};};
async function fixture(){
 let project={id:"A",label:"Original",path:"/work/A",favorite:false,conversationCount:0,lastActivityAt:null,createdAt:"",updatedAt:""};
 vi.mocked(api.listProjects).mockImplementation(async()=>({ok:true,data:[{...project}]}));
 const requests:Array<{label:string;resolve:(v:any)=>void}>=[];
 vi.mocked(api.updateProject).mockImplementation((_id,patch)=>new Promise(resolve=>requests.push({label:patch.label!,resolve})));
 await act(async()=>{render(<ProjectsView onSelectProject={()=>{}} onOpenSettings={()=>{}}/>);});
 const open=()=>fireEvent.click(screen.getByRole("button",{name:"Rename"}));
 const edit=(value:string)=>fireEvent.change(screen.getByRole("textbox"),{target:{value}});
 const save=()=>fireEvent.click(screen.getByRole("button",{name:"Save"}));
 const finish=async(index:number,ok=true)=>{const r=requests[index]!;if(ok)project={...project,label:r.label};await act(async()=>r.resolve(ok?{ok:true,data:{...project}}:{ok:false,error:{code:"internal",message:"Rename failed"}}));};
 return {requests,open,edit,save,finish};
}

it("V20 Rename keeps an unsaved draft that returns to the first submitted value while a different Save is queued",async()=>{
 const f=await fixture();f.open();f.edit("First");f.save();f.edit("Final");f.save();f.edit("First");
 await f.finish(0);expect(f.requests).toHaveLength(2);await f.finish(1);
 const input=screen.queryByRole("textbox") as HTMLInputElement|null;
 console.log("AUDIT20 rename ABA draft",JSON.stringify({writes:f.requests.map(r=>r.label),editorOpen:!!input,draft:input?.value??null}));
 expect(input?.value).toBe("First");
});

it("V20 Rename forwards a coalesced same-label retry after the first request fails",async()=>{
 const f=await fixture();f.open();f.edit("Desired");f.save();fireEvent.click(screen.getByRole("button",{name:"Cancel"}));
 f.open();f.edit("Desired");f.save();await f.finish(0,false);
 const feedback=screen.queryByRole("alert")?.textContent??"";
 console.log("AUDIT20 rename same-label retry",JSON.stringify({requests:f.requests.map(r=>r.label),feedback,draft:(screen.queryByRole("textbox") as HTMLInputElement|null)?.value}));
 // The new form explicitly submitted the same label: either retry that intent or
 // report its failure to this form, never silently drop both the write and error.
 expect(f.requests.length>1||feedback.includes("Rename failed")).toBe(true);
});

it("V20 project creation does not discard an edited label while its Create is pending",async()=>{
 const f=await fixture();const d=deferred();vi.mocked(api.createProject).mockReturnValue(d.promise as any);
 fireEvent.click(screen.getByRole("button",{name:"+ New Project"}));fireEvent.click(screen.getByRole("button",{name:"Pick A"}));
 const input=screen.getByPlaceholderText(/Display label/) as HTMLInputElement;
 fireEvent.change(input,{target:{value:"Submitted"}});fireEvent.click(screen.getByRole("button",{name:"Create"}));
 expect(input.disabled).toBe(false);fireEvent.change(input,{target:{value:"New unsaved label"}});
 await act(async()=>d.resolve({ok:true,data:{id:"new",path:"/work/A",label:"Submitted",favorite:false}}));
 const current=screen.queryByPlaceholderText(/Display label/) as HTMLInputElement|null;
 console.log("AUDIT20 create project draft",JSON.stringify({formOpen:!!current,draft:current?.value??null}));
 expect(current?.value).toBe("New unsaved label");
});
