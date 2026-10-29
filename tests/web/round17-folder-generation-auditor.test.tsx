// @vitest-environment jsdom
import React from "react";
import { afterEach, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { FolderBrowser } from "../../apps/web/src/components/FolderBrowser.js";
import { api } from "../../apps/web/src/api.js";
vi.mock("../../apps/web/src/api.js", () => ({ api: { browse: vi.fn(), createDirectory: vi.fn() } }));
afterEach(() => { cleanup(); vi.restoreAllMocks(); });
const listing = (names: string[], cursor: string | null = null) => ({ ok: true as const, data: { path: "/work", parent: null, roots: ["/work"], entries: names.map(name => ({ name, path: `/work/${name}`, isDirectory: true, allowed: true, hasProject: false })), hasMore: cursor !== null, nextCursor: cursor } });
it("V17 clicking Roots during the initial root load must not invalidate its only completion", async () => {
  let finish!: (value: any) => void;
  vi.mocked(api.browse).mockReturnValue(new Promise(resolve => { finish = resolve; }));
  await act(async () => { render(<FolderBrowser onSelect={() => {}} onCancel={() => {}} />); });
  fireEvent.click(screen.getByRole("button", { name: "Roots" }));
  await act(async () => { finish(listing(["ready"])); });
  const use = screen.getByRole("button", { name: "Use this folder" }) as HTMLButtonElement;
  console.log("AUDIT17 same Roots", JSON.stringify({ browseCalls: vi.mocked(api.browse).mock.calls.length, loading: !!screen.queryByText("Loading…"), disabled: use.disabled }));
  expect(use.disabled).toBe(false);
});
it("V17 cancel of a new folder form must not strand an ongoing post-create pagination reload", async () => {
  let finish!: (value: any) => void;
  vi.mocked(api.browse).mockImplementation((_path, options) => options?.cursor ? new Promise(resolve => { finish = resolve; }) : Promise.resolve(listing([], "next")));
  vi.mocked(api.createDirectory).mockResolvedValue({ ok: true, data: { path: "/work/ZZZ" } });
  await act(async () => { render(<FolderBrowser onSelect={() => {}} onCancel={() => {}} />); });
  fireEvent.click(screen.getByRole("button", { name: "+ New Folder" }));
  fireEvent.change(screen.getByLabelText(/New folder in/), { target: { value: "ZZZ" } });
  await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Create folder" })); });
  expect(finish).toBeTypeOf("function");
  fireEvent.click(screen.getByRole("button", { name: "+ New Folder" }));
  const form = screen.getByLabelText(/New folder in/).closest("form")!;
  fireEvent.click(form.querySelector('button[type="button"]')!);
  await act(async () => { finish(listing(["ZZZ"])); });
  const use = screen.getByRole("button", { name: "Use this folder" }) as HTMLButtonElement;
  console.log("AUDIT17 form Cancel while auto-page", JSON.stringify({ loading: !!screen.queryByText("Loading…"), disabled: use.disabled }));
  expect(use.disabled).toBe(false);
});
