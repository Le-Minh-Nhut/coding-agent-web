// @vitest-environment jsdom
import React from "react";
import { afterEach, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { FolderBrowser } from "../../apps/web/src/components/FolderBrowser.js";
import { api } from "../../apps/web/src/api.js";
vi.mock("../../apps/web/src/api.js",()=>({api:{browse:vi.fn(),createDirectory:vi.fn()}}));
afterEach(()=>{cleanup();vi.restoreAllMocks();});
const child=(path:string)=>({name:path.split("/").at(-1)!,path,isDirectory:true,allowed:true,hasProject:false});
const listing=(path:string,children:string[],cursor:string|null=null)=>({ok:true as const,data:{path,parent:null,roots:["/work"],entries:children.map(child),hasMore:cursor!==null,nextCursor:cursor}});
it("V16 folder: an old navigation's completion cannot release a newer page request",async()=>{
 const pending:Array<{path:string;resolve:(v:any)=>void}>=[];
 vi.mocked(api.browse).mockImplementation((path,options)=>options?.cursor?new Promise(resolve=>pending.push({path:path!,resolve})):Promise.resolve(path==="/work/B"?listing(path,["/work/B/head"],"b2"):listing("/work",["/work/B"],"a2")));
 await act(async()=>{render(<FolderBrowser onSelect={()=>{}} onCancel={()=>{}}/>);});
 fireEvent.click(screen.getByRole("button",{name:"Load more"}));
 await act(async()=>{fireEvent.click(screen.getByText("📁 B"));});
 fireEvent.click(screen.getByRole("button",{name:"Load more"}));
 expect(pending.map(p=>p.path)).toEqual(["/work","/work/B"]);
 await act(async()=>{pending[0]!.resolve(listing("/work",["/work/old-tail"]));});
 const button=screen.queryByRole("button",{name:"Load more"}) as HTMLButtonElement|null;
 if(button&&!button.disabled)fireEvent.click(button);
 await act(async()=>{for(const p of pending.filter(p=>p.path==="/work/B"))p.resolve(listing("/work/B",["/work/B/tail"]));});
 console.log("AUDIT16 folder pending ownership",JSON.stringify({requests:pending.map(p=>p.path),tailRows:screen.queryAllByText("📁 tail").length}));
 expect(screen.queryAllByText("📁 tail")).toHaveLength(1);
});
