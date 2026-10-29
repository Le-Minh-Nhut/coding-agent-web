// @vitest-environment jsdom
import React from "react";
import { afterEach, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { ProjectsView } from "../../apps/web/src/components/ProjectsView.js";
import { api } from "../../apps/web/src/api.js";
vi.mock("../../apps/web/src/api.js",()=>({api:{listProjects:vi.fn(),createProject:vi.fn()}}));
vi.mock("../../apps/web/src/components/FolderBrowser.js",()=>({FolderBrowser:({onSelect}:any)=><div><button onClick={()=>onSelect("/work/A")}>Pick A</button><button onClick={()=>onSelect("/work/B")}>Pick B</button></div>}));
afterEach(()=>{cleanup();vi.restoreAllMocks();});
it("V16 create: replacing a pending form cannot leave the next form permanently disabled",async()=>{
 vi.mocked(api.listProjects).mockResolvedValue({ok:true,data:[]});
 let finish!:(v:any)=>void;vi.mocked(api.createProject).mockReturnValue(new Promise(resolve=>finish=resolve));
 await act(async()=>{render(<ProjectsView onSelectProject={()=>{}} onOpenSettings={()=>{}}/>);});
 fireEvent.click(screen.getByRole("button",{name:"+ New Project"}));fireEvent.click(screen.getByRole("button",{name:"Pick A"}));
 fireEvent.click(screen.getByRole("button",{name:/^Create$/}));
 fireEvent.click(screen.getByRole("button",{name:"Cancel"}));
 fireEvent.click(screen.getByRole("button",{name:"+ New Project"}));fireEvent.click(screen.getByRole("button",{name:"Pick B"}));
 await act(async()=>{finish({ok:true,data:{id:"A",path:"/work/A",label:"A",favorite:false}});});
 const button=screen.getByRole("button",{name:/^Create$/}) as HTMLButtonElement;
 console.log("AUDIT16 create form pending",JSON.stringify({newDraft:(screen.getByPlaceholderText(/Display label/) as HTMLInputElement).value,createDisabled:button.disabled}));
 expect(button.disabled).toBe(false);
});
