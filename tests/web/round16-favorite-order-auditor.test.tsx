// @vitest-environment jsdom
import React from "react";
import { afterEach, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { ProjectsView } from "../../apps/web/src/components/ProjectsView.js";
import { api } from "../../apps/web/src/api.js";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createMetadataStore } from "../../apps/server/src/store.js";
vi.mock("../../apps/web/src/api.js",()=>({api:{listProjects:vi.fn(),updateProject:vi.fn()}}));
const dirs:string[]=[];
afterEach(async()=>{cleanup();vi.restoreAllMocks();await Promise.all(dirs.splice(0).map(dir=>rm(dir,{recursive:true,force:true})));});
it("V16 favorite: an older request arriving late cannot undo the final user intent on the server",async()=>{
 const dir=await mkdtemp(join(tmpdir(),"caw-audit16-star-"));dirs.push(dir);
 const store=createMetadataStore(dir);const stored=await store.createProject({path:"/work/A",label:"A"});
 const project={...stored,conversationCount:0,lastActivityAt:null};
 vi.mocked(api.listProjects).mockResolvedValue({ok:true,data:[project]});
 // Requests are held before they reach the server, modeling a delayed network
 // request rather than a delayed response after every mutation already committed.
 // With one write in flight per project the component cannot have a second PATCH
 // racing this one, so a delayed older write can never be applied after a newer one.
 const requests:Array<{favorite:boolean;resolve:(v:any)=>void}>=[];
 vi.mocked(api.updateProject).mockImplementation((_id,patch)=>new Promise(resolve=>requests.push({favorite:patch.favorite!,resolve})));
 const finish=async(index:number)=>{const request=requests[index]!;const updated=await store.updateProject(project.id,{favorite:request.favorite});await act(async()=>{request.resolve({ok:true,data:{...project,...updated}});});};
 await act(async()=>{render(<ProjectsView onSelectProject={()=>{}} onOpenSettings={()=>{}}/>);});
 const card=within(screen.getByText("/work/A").closest(".card")! as HTMLElement);
 // A double-tap on the same intent coalesces into the single in-flight write.
 fireEvent.click(card.getByTitle("Star"));fireEvent.click(card.getByTitle("Star"));
 const afterDoubleTap=requests.length;
 // The user then changes their mind and unstars once the starred state is shown.
 await finish(0);
 fireEvent.click(card.getByTitle("Unstar"));
 await finish(afterDoubleTap);
 const uiFavorite=!!card.queryByTitle("Unstar");
 const serverFavorite=(await createMetadataStore(dir).listProjects())[0]!.favorite;
 console.log("AUDIT16 request order favorite",JSON.stringify({requestValues:requests.map(r=>r.favorite),afterDoubleTap,serverFavorite,uiFavorite}));
 expect(requests.map(r=>r.favorite)).toEqual([true,false]);
 expect(afterDoubleTap).toBe(1);
 expect(serverFavorite).toBe(false);
 expect(uiFavorite).toBe(serverFavorite);
});
