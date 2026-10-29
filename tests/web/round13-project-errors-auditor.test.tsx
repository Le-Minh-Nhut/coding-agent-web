// @vitest-environment jsdom
import React from "react";
import {afterEach,beforeEach,expect,it,vi} from "vitest";
import {act,cleanup,fireEvent,render,screen} from "@testing-library/react";
import {ProjectsView} from "../../apps/web/src/components/ProjectsView.js";
import {ProjectDetailView} from "../../apps/web/src/components/ProjectDetailView.js";
import {ActivityPanel} from "../../apps/web/src/components/ActivityPanel.js";
import {api} from "../../apps/web/src/api.js";
vi.mock("../../apps/web/src/api.js",()=>({api:{listProjects:vi.fn(),listConversations:vi.fn(),listNativeSessions:vi.fn(),updateProject:vi.fn(),getConversationEvents:vi.fn()}}));
const project={id:"p1",label:"Project",path:"/work",favorite:false,conversationCount:0,lastActivityAt:null,createdAt:"",updatedAt:""};
afterEach(()=>{cleanup();vi.restoreAllMocks();});
beforeEach(()=>{
 vi.resetAllMocks();
 vi.mocked(api.listProjects).mockResolvedValue({ok:true,data:[project]});
 vi.mocked(api.listConversations).mockResolvedValue({ok:true,data:[]});
 vi.mocked(api.listNativeSessions).mockResolvedValue({ok:true,data:[]});
});
it("V13 favorite: two pending same-value updates do not invert displayed server state",async()=>{
 const pending:Array<(v:any)=>void>=[];
 vi.mocked(api.updateProject).mockImplementation(()=>new Promise(resolve=>pending.push(resolve)));
 await act(async()=>{render(<ProjectsView onSelectProject={()=>{}} onOpenSettings={()=>{}}/>);});
 fireEvent.click(screen.getByTitle("Star"));
 fireEvent.click(screen.getByTitle("Star"));
 await act(async()=>{for(const resolve of pending)resolve({ok:true,data:{...project,favorite:true}});});
 console.log("AUDIT13 favorite",JSON.stringify({requests:vi.mocked(api.updateProject).mock.calls,serverFavorite:true,uiStarred:Boolean(screen.queryByTitle("Unstar"))}));
 expect(screen.queryByTitle("Unstar")).not.toBeNull();
});
it("V13 list errors: a failed conversation request is not an empty project",async()=>{
 vi.mocked(api.listConversations).mockResolvedValue({ok:false,error:{code:"internal",message:"Conversation store temporarily unavailable"}});
 await act(async()=>{render(<ProjectDetailView projectId="p1" onBack={()=>{}} onSelectConversation={()=>{}}/>);});
 console.log("AUDIT13 conversation list failure",JSON.stringify({alert:screen.queryByRole("alert")?.textContent,emptyClaim:Boolean(screen.queryByText("No conversations yet."))}));
 expect(screen.queryByText("No conversations yet.")).toBeNull();
 expect(screen.queryByRole("alert")?.textContent).toContain("temporarily unavailable");
});
it("V13 list errors: a failed activity request is not proof of no recorded events",async()=>{
 vi.mocked(api.getConversationEvents).mockResolvedValue({ok:false,error:{code:"internal",message:"Activity store temporarily unavailable"}});
 await act(async()=>{render(<ActivityPanel conversationId="c1"/>);});
 console.log("AUDIT13 activity failure",document.body.textContent);
 expect(screen.queryByText("No activity recorded for this conversation yet.")).toBeNull();
 expect(screen.queryByRole("alert")?.textContent).toContain("temporarily unavailable");
});
