// @vitest-environment jsdom
import React from "react";
import { afterEach, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { FolderBrowser } from "../../apps/web/src/components/FolderBrowser.js";
import { api } from "../../apps/web/src/api.js";
vi.mock("../../apps/web/src/api.js", () => ({ api: { browse: vi.fn(), createDirectory: vi.fn() } }));
afterEach(() => { cleanup(); vi.restoreAllMocks(); });
const child=(path:string)=>({name:path.split("/").at(-1)!,path,isDirectory:true,allowed:true,hasProject:false});
const listing=(path:string,children:string[],cursor:string|null=null)=>({ok:true as const,data:{path,parent:null,roots:["/work"],entries:children.map(child),hasMore:cursor!==null,nextCursor:cursor}});
it("V15 folder pagination: a failed old page must not report an error for the new directory",async()=>{
  let complete!:(v:any)=>void;
  vi.mocked(api.browse).mockImplementation((path,options)=>options?.cursor ? new Promise(resolve=>complete=resolve) : Promise.resolve(path==="/work/other"?listing(path,[]):listing("/work",["/work/other"],"page2")));
  await act(async()=>{render(<FolderBrowser onSelect={()=>{}} onCancel={()=>{}}/>);});
  fireEvent.click(screen.getByRole("button",{name:/Load more/}));
  await act(async()=>{fireEvent.click(screen.getByText("📁 other"));});
  await act(async()=>{complete({ok:false,error:{code:"internal",message:"Old directory page failed"}});});
  console.log("AUDIT15 late folder page",JSON.stringify({alert:screen.queryByRole("alert")?.textContent,currentDirectory:"/work/other"}));
  expect(screen.queryByRole("alert")).toBeNull();
});
