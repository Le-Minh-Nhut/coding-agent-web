// @vitest-environment jsdom
import React from "react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { App } from "../../apps/web/src/App.js";
import { api } from "../../apps/web/src/api.js";
vi.mock("../../apps/web/src/api.js", () => ({ api: { getMe:vi.fn(),getCapabilities:vi.fn(),listProjects:vi.fn(),listConversations:vi.fn(),listNativeSessions:vi.fn(),createConversation:vi.fn() } }));
vi.mock("../../apps/web/src/components/ProjectsView.js", () => ({ ProjectsView: ({onSelectProject}:any) => <div><button onClick={()=>onSelectProject("p1")}>Open P1</button><button onClick={()=>onSelectProject("p2")}>Open P2</button></div>, resetProjectMutationState: () => {} }));
vi.mock("../../apps/web/src/components/ConversationView.js", () => ({ ConversationView: ({conversationId}:any) => <div data-testid="conversation">Conversation {conversationId}</div> }));
afterEach(()=>{cleanup();vi.restoreAllMocks();});
beforeEach(()=>{
 vi.resetAllMocks();
 vi.mocked(api.getMe).mockResolvedValue({ok:true,data:{csrfToken:"fixture"}});
 vi.mocked(api.getCapabilities).mockResolvedValue({ok:true,data:{} as any});
 vi.mocked(api.listProjects).mockResolvedValue({ok:true,data:[{id:"p1",label:"Project One",path:"/work/p1"},{id:"p2",label:"Project Two",path:"/work/p2"}] as any});
 vi.mocked(api.listConversations).mockResolvedValue({ok:true,data:[]});
 vi.mocked(api.listNativeSessions).mockResolvedValue({ok:true,data:[]});
});
it("V13 navigation: a late new-chat response must not hijack another project", async()=>{
 let complete!: (v:any)=>void;
 vi.mocked(api.createConversation).mockReturnValue(new Promise(resolve=>complete=resolve));
 await act(async()=>{render(<App/>);});
 await act(async()=>{fireEvent.click(screen.getByRole("button",{name:"Open P1"}));});
 await act(async()=>{fireEvent.click(screen.getByRole("button",{name:"+ New chat"}));});
 await act(async()=>{fireEvent.click(screen.getByRole("button",{name:"← Back"}));});
 await act(async()=>{fireEvent.click(screen.getByRole("button",{name:"Open P2"}));});
 expect(screen.getByRole("heading",{name:"Project Two"})).toBeTruthy();
 await act(async()=>{complete({ok:true,data:{id:"chat-from-p1",projectId:"p1"}});});
 console.log("AUDIT13 late chat navigation",document.body.textContent);
 expect(screen.queryByTestId("conversation")).toBeNull();
 expect(screen.queryByRole("heading",{name:"Project Two"})).not.toBeNull();
});
