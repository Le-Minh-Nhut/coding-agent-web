// @vitest-environment jsdom
import React from "react";
import { afterEach, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { ProjectsView } from "../../apps/web/src/components/ProjectsView.js";
import { api } from "../../apps/web/src/api.js";
vi.mock("../../apps/web/src/api.js",()=>({api:{listProjects:vi.fn(),updateProject:vi.fn()}}));
afterEach(()=>{cleanup();vi.restoreAllMocks();});
it("V15 rename: a late save for A must not close B's editor and discard its draft",async()=>{
 const projects=["A","B"].map(id=>({id,label:id,path:`/work/${id}`,favorite:false,conversationCount:0,lastActivityAt:null,createdAt:"",updatedAt:""}));
 vi.mocked(api.listProjects).mockResolvedValue({ok:true,data:projects});
 let finish!:(v:any)=>void;vi.mocked(api.updateProject).mockReturnValue(new Promise(resolve=>finish=resolve));
 await act(async()=>{render(<ProjectsView onSelectProject={()=>{}} onOpenSettings={()=>{}}/>);});
 const card=(id:string)=>within(screen.getByText(`/work/${id}`).closest(".card")! as HTMLElement);
 fireEvent.click(card("A").getByRole("button",{name:"Rename"}));
 fireEvent.change(screen.getByRole("textbox"),{target:{value:"A saved"}});
 fireEvent.click(screen.getByRole("button",{name:"Save"}));
 fireEvent.click(screen.getByRole("button",{name:"Cancel"}));
 fireEvent.click(card("B").getByRole("button",{name:"Rename"}));
 fireEvent.change(screen.getByRole("textbox"),{target:{value:"B unfinished draft"}});
 await act(async()=>{finish({ok:true,data:{...projects[0]!,label:"A saved"}});});
 console.log("AUDIT15 late rename",JSON.stringify({editorOpen:!!screen.queryByRole("textbox"),draft:(screen.queryByRole("textbox") as HTMLInputElement|null)?.value}));
 expect((screen.getByRole("textbox") as HTMLInputElement).value).toBe("B unfinished draft");
});
