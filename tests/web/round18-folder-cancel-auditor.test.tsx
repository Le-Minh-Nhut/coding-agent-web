// @vitest-environment jsdom
import React from "react";
import {afterEach,expect,it,vi} from "vitest";
import {act,cleanup,fireEvent,render,screen,within} from "@testing-library/react";
import {FolderBrowser} from "../../apps/web/src/components/FolderBrowser.js";
import {api} from "../../apps/web/src/api.js";
vi.mock("../../apps/web/src/api.js",()=>({api:{browse:vi.fn(),createDirectory:vi.fn()}}));
afterEach(()=>{cleanup();vi.restoreAllMocks();});
it.each([true,false])("V18 cancelled folder create cannot mutate the next form (old success=%s)",async(success)=>{
 vi.mocked(api.browse).mockResolvedValue({ok:true,data:{path:"/work",parent:null,roots:["/work"],entries:[],hasMore:false,nextCursor:null}});
 let finish!:(value:any)=>void;vi.mocked(api.createDirectory).mockReturnValue(new Promise(resolve=>finish=resolve));
 await act(async()=>{render(<FolderBrowser onSelect={()=>{}} onCancel={()=>{}}/>);});
 fireEvent.click(screen.getByRole("button",{name:"+ New Folder"}));fireEvent.change(screen.getByLabelText(/New folder in/),{target:{value:"A"}});
 fireEvent.click(screen.getByRole("button",{name:"Create folder"}));
 fireEvent.click(within(screen.getByLabelText(/New folder in/).closest("form")!).getByRole("button",{name:"Cancel"}));
 fireEvent.click(screen.getByRole("button",{name:"+ New Folder"}));fireEvent.change(screen.getByLabelText(/New folder in/),{target:{value:"B unsaved"}});
 await act(async()=>finish(success?{ok:true,data:{path:"/work/A"}}:{ok:false,error:{code:"internal",message:"Old cancelled create failed"}}));
 const input=screen.queryByLabelText(/New folder in/) as HTMLInputElement|null;
 console.log("AUDIT18 folder cancelled create",JSON.stringify({success,formOpen:!!input,draft:input?.value??null,error:screen.queryByRole("alert")?.textContent??null}));
 expect(input?.value).toBe("B unsaved");
 expect(screen.queryByRole("alert")).toBeNull();
});

// --- Round 18 owner regressions for the same region -------------------------
// The dialog operation token, not just the navigation generation, must own every
// form-state write. Cancel replaces the token; a submitted form mints a new one.

const child=(path:string)=>({name:path.split("/").at(-1)!,path,isDirectory:true,allowed:true,hasProject:false});
const listing=(path:string,children:string[]=[])=>({ok:true as const,data:{path,parent:null,roots:["/work"],entries:children.map(child),hasMore:false,nextCursor:null}});
// jsdom in this repo has no Promise.withResolvers; the deferred resolver is needed to land a response late.
const deferred=()=>{let resolve!:(value:any)=>void;const promise=new Promise(r=>{resolve=r;});return {promise,resolve};};
const field=()=>screen.queryByLabelText(/New folder in/) as HTMLInputElement|null;
const openForm=()=>fireEvent.click(screen.getByRole("button",{name:"+ New Folder"}));
const typeName=(value:string)=>fireEvent.change(screen.getByLabelText(/New folder in/),{target:{value}});
const submitForm=()=>fireEvent.click(screen.getByRole("button",{name:"Create folder"}));
const cancelForm=()=>fireEvent.click(within(screen.getByLabelText(/New folder in/).closest("form")!).getByRole("button",{name:"Cancel"}));
const alertText=()=>screen.queryByRole("alert")?.textContent??null;

it("V18 a cancelled create stays invisible while the next form is submitted, then that form's own completion applies",async()=>{
 const a=deferred();const b=deferred();
 vi.mocked(api.browse).mockResolvedValue(listing("/work"));
 vi.mocked(api.createDirectory).mockReturnValueOnce(a.promise as never).mockReturnValueOnce(b.promise as never);
 const selected:string[]=[];
 await act(async()=>{render(<FolderBrowser onSelect={path=>selected.push(path)} onCancel={()=>{}}/>);});
 openForm();typeName("A");submitForm();cancelForm();
 openForm();typeName("B");submitForm();
 expect((screen.getByRole("button",{name:"Creating…"}) as HTMLButtonElement).disabled).toBe(true);
 await act(async()=>a.resolve({ok:false,error:{code:"internal",message:"Old cancelled create failed"}}));
 console.log("AUDIT18 submitted-next stale settle",JSON.stringify({draft:field()?.value??null,error:alertText()}));
 expect(field()?.value).toBe("B");
 expect(alertText()).toBeNull();
 expect(screen.queryByRole("button",{name:"Creating…"})).not.toBeNull();
 await act(async()=>b.resolve({ok:true,data:{path:"/work/B"}}));
 expect(field()).toBeNull();
 fireEvent.click(screen.getByRole("button",{name:"Use this folder"}));
 console.log("AUDIT18 submitted-next own completion",JSON.stringify({selected}));
 expect(selected).toEqual(["/work/B"]);
});

it("V18 a cancelled create cannot blame a form reopened in a different directory",async()=>{
 const a=deferred();
 vi.mocked(api.browse).mockImplementation(async path=>listing(path??"/work",path?[]:["/work/other"]));
 vi.mocked(api.createDirectory).mockReturnValueOnce(a.promise as never);
 const selected:string[]=[];
 await act(async()=>{render(<FolderBrowser onSelect={path=>selected.push(path)} onCancel={()=>{}}/>);});
 openForm();typeName("A");submitForm();cancelForm();
 await act(async()=>{fireEvent.click(screen.getByText("📁 other"));});
 openForm();typeName("B unsaved");
 await act(async()=>a.resolve({ok:false,error:{code:"internal",message:"Old cancelled create failed"}}));
 console.log("AUDIT18 different-directory reopen",JSON.stringify({draft:field()?.value??null,error:alertText()}));
 expect(field()?.value).toBe("B unsaved");
 expect(alertText()).toBeNull();
 fireEvent.click(screen.getByRole("button",{name:"Use this folder"}));
 expect(selected).toEqual(["/work/other"]);
});

it("V18 reopening and cancelling the form twice keeps the draft of the form open when the old create settles",async()=>{
 const a=deferred();
 vi.mocked(api.browse).mockResolvedValue(listing("/work"));
 vi.mocked(api.createDirectory).mockReturnValueOnce(a.promise as never);
 await act(async()=>{render(<FolderBrowser onSelect={()=>{}} onCancel={()=>{}}/>);});
 openForm();typeName("A");submitForm();cancelForm();
 openForm();typeName("B");cancelForm();
 openForm();typeName("A again");
 await act(async()=>a.resolve({ok:true,data:{path:"/work/A"}}));
 console.log("AUDIT18 reopen sequence",JSON.stringify({draft:field()?.value??null,error:alertText()}));
 expect(field()?.value).toBe("A again");
 expect(alertText()).toBeNull();
});

it("V18 after a stale settlement the released form still creates normally",async()=>{
 const a=deferred();const c=deferred();
 vi.mocked(api.browse).mockResolvedValue(listing("/work"));
 vi.mocked(api.createDirectory).mockReturnValueOnce(a.promise as never).mockReturnValueOnce(c.promise as never);
 const selected:string[]=[];
 await act(async()=>{render(<FolderBrowser onSelect={path=>selected.push(path)} onCancel={()=>{}}/>);});
 openForm();typeName("A");submitForm();cancelForm();
 openForm();typeName("C");
 await act(async()=>a.resolve({ok:true,data:{path:"/work/A"}}));
 expect(field()?.value).toBe("C");
 submitForm();
 await act(async()=>c.resolve({ok:true,data:{path:"/work/C"}}));
 fireEvent.click(screen.getByRole("button",{name:"Use this folder"}));
 console.log("AUDIT18 further create after settlement",JSON.stringify({calls:vi.mocked(api.createDirectory).mock.calls.length,selected}));
 expect(vi.mocked(api.createDirectory).mock.calls.length).toBe(2);
 expect(selected).toEqual(["/work/C"]);
});
