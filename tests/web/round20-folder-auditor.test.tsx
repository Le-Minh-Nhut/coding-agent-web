// @vitest-environment jsdom
import React from "react";
import {afterEach,expect,it,vi} from "vitest";
import {act,cleanup,fireEvent,render,screen} from "@testing-library/react";
import {FolderBrowser} from "../../apps/web/src/components/FolderBrowser.js";
import {api} from "../../apps/web/src/api.js";
vi.mock("../../apps/web/src/api.js",()=>({api:{browse:vi.fn(),createDirectory:vi.fn()}}));
afterEach(()=>{cleanup();vi.restoreAllMocks();});
it("V20 folder creation does not discard a newer unsaved name in the same pending form",async()=>{
 vi.mocked(api.browse).mockResolvedValue({ok:true,data:{path:"/work",parent:null,roots:["/work"],entries:[],hasMore:false,nextCursor:null}});
 let finish!:(v:any)=>void;vi.mocked(api.createDirectory).mockReturnValue(new Promise(resolve=>finish=resolve));
 await act(async()=>{render(<FolderBrowser onSelect={()=>{}} onCancel={()=>{}}/>);});
 fireEvent.click(screen.getByRole("button",{name:"+ New Folder"}));
 const input=screen.getByLabelText(/New folder in/) as HTMLInputElement;
 fireEvent.change(input,{target:{value:"Submitted"}});fireEvent.click(screen.getByRole("button",{name:"Create folder"}));
 expect(input.disabled).toBe(false);fireEvent.change(input,{target:{value:"New unsaved folder"}});
 await act(async()=>finish({ok:true,data:{path:"/work/Submitted"}}));
 const current=screen.queryByLabelText(/New folder in/) as HTMLInputElement|null;
 console.log("AUDIT20 create folder draft",JSON.stringify({formOpen:!!current,draft:current?.value??null}));
 expect(current?.value).toBe("New unsaved folder");
});
