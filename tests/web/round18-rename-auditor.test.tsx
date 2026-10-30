// @vitest-environment jsdom
import React from "react";
import {afterEach,expect,it,vi} from "vitest";
import {act,cleanup,fireEvent,render,screen} from "@testing-library/react";
import {ProjectsView} from "../../apps/web/src/components/ProjectsView.js";
import {api} from "../../apps/web/src/api.js";
vi.mock("../../apps/web/src/api.js",()=>({api:{listProjects:vi.fn(),updateProject:vi.fn()}}));
afterEach(()=>{cleanup();vi.restoreAllMocks();});
async function fixture(){
 let project={id:"A",label:"Original",path:"/work/A",favorite:false,conversationCount:0,lastActivityAt:null,createdAt:"",updatedAt:""};
 vi.mocked(api.listProjects).mockImplementation(async()=>({ok:true,data:[{...project}]}));
 const requests:Array<{label:string;resolve:(v:any)=>void}>=[];
 vi.mocked(api.updateProject).mockImplementation((_id,patch)=>new Promise(resolve=>requests.push({label:patch.label!,resolve})));
 await act(async()=>{render(<ProjectsView onSelectProject={()=>{}} onOpenSettings={()=>{}}/>);});
 const open=()=>fireEvent.click(screen.getByRole("button",{name:"Rename"}));
 const edit=(value:string)=>fireEvent.change(screen.getByRole("textbox"),{target:{value}});
 const save=()=>fireEvent.click(screen.getByRole("button",{name:"Save"}));
 const finish=async(index:number,ok=true)=>{const r=requests[index]!;if(ok)project={...project,label:r.label};await act(async()=>r.resolve(ok?{ok:true,data:{...project}}:{ok:false,error:{code:"internal",message:"Second rename failed"}}));};
 return {requests,open,edit,save,finish};
}
it("V18 Rename keeps unsaved edits made after the pending Save",async()=>{
 const f=await fixture();f.open();f.edit("Saved label");f.save();f.edit("New unsaved draft");await f.finish(0);
 const input=screen.queryByRole("textbox") as HTMLInputElement|null;
 console.log("AUDIT18 Rename unsaved",JSON.stringify({editorOpen:!!input,draft:input?.value??null}));
 expect(input?.value).toBe("New unsaved draft");
});
it("V18 a coalesced Save from a reopened dialog owns its own failure feedback",async()=>{
 const f=await fixture();f.open();f.edit("First Save");f.save();fireEvent.click(screen.getByRole("button",{name:"Cancel"}));
 f.open();f.edit("Second Save");f.save();await f.finish(0);expect(f.requests).toHaveLength(2);await f.finish(1,false);
 const error=screen.queryByRole("alert")?.textContent??null;
 console.log("AUDIT18 Rename reopened failure",JSON.stringify({requestLabels:f.requests.map(r=>r.label),error,draft:(screen.queryByRole("textbox") as HTMLInputElement|null)?.value}));
 expect(error??"").toContain("Second rename failed");
});

