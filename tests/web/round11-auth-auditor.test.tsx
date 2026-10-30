// @vitest-environment jsdom
import React from "react";
import {afterEach,beforeEach,it,expect,vi} from "vitest";
import {act,cleanup,render,waitFor} from "@testing-library/react";
import {api} from "../../apps/web/src/api.js";
import {App} from "../../apps/web/src/App.js";
vi.mock("../../apps/web/src/api.js",()=>({api:{getMe:vi.fn(),getCapabilities:vi.fn()}}));
vi.mock("../../apps/web/src/components/ProjectsView.js",()=>({ProjectsView:()=> <div>Project screen</div>,resetProjectMutationState:vi.fn()}));
afterEach(()=>{cleanup();vi.restoreAllMocks();});
beforeEach(()=>vi.clearAllMocks());
it("audit11 control: unauthenticated startup offers sign-in",async()=>{
 vi.mocked(api.getMe).mockResolvedValue({ok:false,httpStatus:401,error:{code:"unauthorized",message:"Expired"}});
 const view=render(<App/>);
 expect(await view.findByRole("button",{name:"Sign in"})).toBeTruthy();
});
it("audit11 control: authenticated startup opens projects",async()=>{
 vi.mocked(api.getMe).mockResolvedValue({ok:true,data:{csrfToken:"test"}});
 vi.mocked(api.getCapabilities).mockResolvedValue({ok:true,data:{} as never});
 const view=render(<App/>);expect(await view.findByText("Project screen")).toBeTruthy();
});
it("audit11: startup does not hang when setup session expires during validation",async()=>{
 vi.mocked(api.getMe).mockResolvedValueOnce({ok:true,data:{csrfToken:"setup-test"}}).mockResolvedValueOnce({ok:false,httpStatus:401,error:{code:"unauthorized",message:"Session expired"}});
 vi.mocked(api.getCapabilities).mockResolvedValue({ok:false,httpStatus:403,error:{code:"unauthorized",message:"Set owner password"}});
 const view=render(<App/>);
 await waitFor(()=>expect(api.getMe).toHaveBeenCalledTimes(2));
 await act(async()=>{await Promise.resolve();});
 console.log("AUDIT11 auth startup",JSON.stringify({loading:!!view.queryByText("Loading workspace…"),canSignIn:!!view.queryByRole("button",{name:"Sign in"})}));
 expect(view.queryByText("Loading workspace…")).toBeNull();
});
