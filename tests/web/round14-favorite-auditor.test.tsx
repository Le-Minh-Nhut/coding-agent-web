// @vitest-environment jsdom
import React from "react";
import { afterEach, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, within } from "@testing-library/react";
import { ProjectsView } from "../../apps/web/src/components/ProjectsView.js";
import { api } from "../../apps/web/src/api.js";
vi.mock("../../apps/web/src/api.js", () => ({ api: { listProjects: vi.fn(), updateProject: vi.fn() } }));
afterEach(() => { cleanup(); vi.restoreAllMocks(); });
it("V14 stars: another project's flight must not let an older response overwrite a later unstar", async () => {
  const projects = ["A", "B"].map(id => ({id, label:id, path:`/work/${id}`, favorite:false, conversationCount:0, lastActivityAt:null, createdAt:"", updatedAt:""}));
  vi.mocked(api.listProjects).mockResolvedValue({ok:true, data:projects});
  const pending: Array<{id:string; favorite:boolean; resolve:(v:any)=>void}> = [];
  // Server commits immediately in arrival order; only network responses are delayed.
  const server = new Map(projects.map(p => [p.id, false]));
  vi.mocked(api.updateProject).mockImplementation((id, patch) => {
    server.set(id, patch.favorite!);
    return new Promise(resolve => pending.push({id, favorite:patch.favorite!, resolve}));
  });
  const view = render(<ProjectsView onSelectProject={()=>{}} onOpenSettings={()=>{}}/>);
  await act(async()=>{});
  const card = (id:string) => within(view.getByText(`/work/${id}`).closest(".card")! as HTMLElement);
  const finish = async(index:number) => { const p=pending[index]!; await act(async()=>{p.resolve({ok:true,data:{...projects.find(v=>v.id===p.id),favorite:p.favorite}});}); };
  fireEvent.click(card("A").getByTitle("Star"));
  fireEvent.click(card("B").getByTitle("Star"));
  // A is enabled again even though its first request has not answered.
  fireEvent.click(card("A").getByTitle("Star"));
  await finish(0);
  fireEvent.click(card("A").getByTitle("Unstar"));
  await finish(3);
  expect(server.get("A")).toBe(false);
  await finish(2); // late snapshot from the duplicate first intent
  await finish(1);
  console.log("AUDIT14 cross-project favorite", JSON.stringify({requests:pending.map(({id,favorite})=>({id,favorite})),serverFavorite:server.get("A"),uiStarred:!!card("A").queryByTitle("Unstar")}));
  expect(card("A").queryByTitle("Unstar")).toBeNull();
});
