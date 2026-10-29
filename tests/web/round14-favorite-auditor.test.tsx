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
  let inFlightA = 0;
  const finish = async(index:number) => { const p=pending[index]!; if(p.id==="A")inFlightA--; await act(async()=>{p.resolve({ok:true,data:{...projects.find(v=>v.id===p.id),favorite:p.favorite}});}); };
  fireEvent.click(card("A").getByTitle("Star"));
  inFlightA++;
  fireEvent.click(card("B").getByTitle("Star"));
  // A second activation on A coalesces into the write already in flight instead
  // of racing a second PATCH the server could apply out of order.
  fireEvent.click(card("A").getByTitle("Star"));
  expect(inFlightA).toBe(1);
  expect(pending.filter(p=>p.id==="A")).toHaveLength(1);
  await finish(0);
  // B is still in flight, yet A is free to send its next intent; the server can
  // only see A's later unstar after A's earlier star, so no old write can win.
  fireEvent.click(card("A").getByTitle("Unstar"));
  inFlightA++;
  expect(inFlightA).toBe(1);
  await finish(2);
  expect(server.get("A")).toBe(false);
  await finish(1);
  console.log("AUDIT14 cross-project favorite", JSON.stringify({requests:pending.map(({id,favorite})=>({id,favorite})),serverFavorite:server.get("A"),uiStarred:!!card("A").queryByTitle("Unstar")}));
  expect(card("A").queryByTitle("Unstar")).toBeNull();
});
