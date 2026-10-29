// @vitest-environment jsdom
import React from "react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { FolderBrowser } from "../../apps/web/src/components/FolderBrowser.js";
import { api } from "../../apps/web/src/api.js";
vi.mock("../../apps/web/src/api.js", () => ({ api: { browse: vi.fn(), createDirectory: vi.fn() } }));
afterEach(() => { cleanup(); vi.restoreAllMocks(); });
beforeEach(() => vi.resetAllMocks());
const child = (path: string) => ({ name: path.split("/").at(-1)!, path, isDirectory: true, allowed: true, hasProject: false });
const listing = (path: string, children: string[] = []) => ({ ok: true as const, data: { path, parent: null, roots: ["/work"], entries: children.map(child), hasMore: false, nextCursor: null } });
it("V13 folder: a late create cannot select a path outside the directory now shown", async () => {
  let complete!: (result: any) => void;
  vi.mocked(api.createDirectory).mockReturnValue(new Promise(resolve => complete = resolve));
  vi.mocked(api.browse).mockImplementation(async path => listing(path ?? "/work", path ? [] : ["/work/other"]));
  const selected: string[] = [];
  await act(async () => { render(<FolderBrowser onSelect={path => selected.push(path)} onCancel={() => {}} />); });
  fireEvent.click(screen.getByRole("button", {name: "+ New Folder"}));
  fireEvent.change(screen.getByLabelText(/New folder in/), {target: {value: "created"}});
  await act(async () => { fireEvent.click(screen.getByRole("button", {name: "Create folder"})); });
  await act(async () => { fireEvent.click(screen.getByText("📁 other")); });
  expect(screen.getByText("New folder in /work/other")).toBeTruthy();
  await act(async () => { complete({ok:true, data:{path:"/work/created"}}); });
  fireEvent.click(screen.getByRole("button", {name:"Use this folder"}));
  console.log("AUDIT13 late folder create", JSON.stringify({displayed:"/work/other",selected}));
  expect(selected).toEqual(["/work/other"]);
});
it("V13 folder control: create without navigation selects its created directory", async () => {
  vi.mocked(api.createDirectory).mockResolvedValue({ok:true,data:{path:"/work/created"}});
  vi.mocked(api.browse).mockResolvedValue(listing("/work", ["/work/created"]));
  const selected: string[] = [];
  await act(async () => { render(<FolderBrowser onSelect={path => selected.push(path)} onCancel={() => {}} />); });
  fireEvent.click(screen.getByRole("button", {name: "+ New Folder"}));
  fireEvent.change(screen.getByLabelText(/New folder in/), {target: {value: "created"}});
  await act(async () => { fireEvent.click(screen.getByRole("button", {name: "Create folder"})); });
  fireEvent.click(screen.getByRole("button", {name:"Use this folder"}));
  expect(selected).toEqual(["/work/created"]);
});
