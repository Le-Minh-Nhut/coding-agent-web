// @vitest-environment jsdom
// Regressions for the round-17 web fixes, covering the branches the auditor
// probes do not: the refused-prompt strip's recover/copy/replacement/clearing
// paths, rename single-flight coalescing across dialogs, projects and failures,
// folder loader ownership after the generation bump was narrowed to real
// reloads, and every logout outcome plus the CSRF token surviving a failed
// revoke.
import React from "react";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { CollabSocket, type HostFrame } from "@caw/collab-protocol";
import type { ApiResult, Conversation, DirectoryListing, ProjectWithStats } from "@caw/contracts";
import * as apiModule from "../../apps/web/src/api.js";
import { api } from "../../apps/web/src/api.js";
import { ConversationView } from "../../apps/web/src/components/ConversationView.js";
import { FolderBrowser } from "../../apps/web/src/components/FolderBrowser.js";
import { ProjectsView } from "../../apps/web/src/components/ProjectsView.js";
import { SettingsView } from "../../apps/web/src/components/SettingsView.js";
import { createMetadataStore } from "../../apps/server/src/store.js";

vi.mock("../../apps/web/src/api.js", async () => {
  const actual = await vi.importActual<typeof apiModule>("../../apps/web/src/api.js");
  return {
    ...actual,
    api: {
      getConversation: vi.fn(),
      getAttachInstructions: vi.fn(),
      getConversationLink: vi.fn(),
      getModels: vi.fn(),
      getRuntime: vi.fn(),
      getMe: vi.fn(),
      getCapabilities: vi.fn(),
      listProjects: vi.fn(),
      updateProject: vi.fn(),
      browse: vi.fn(),
      createDirectory: vi.fn(),
      logout: vi.fn(),
    },
  };
});

const REFUSAL = "prompting is unavailable until the host finishes starting up";

const welcome = (): HostFrame => ({
  t: "welcome", proto: 3,
  header: { type: "session", id: "session", cwd: "/", timestamp: new Date().toISOString() },
  state: { isStreaming: false, queuedMessageCount: 0, cwd: "/", participants: [] },
  agents: [], entryCount: 0,
});

const conversation = (id: string): Conversation => ({
  id, projectId: "p-1", nativeSessionId: null, nativeSessionPath: null, title: "Chat", model: null,
  ownership: "managed", state: "idle", tmuxSessionId: null, tmuxSessionName: null, tmuxServerIdentity: null,
  tmuxPanePid: null, hostInstanceId: null, hostGeneration: null,
  createdAt: "", updatedAt: "", lastActivityAt: null, statusDetail: null, modelPreference: null,
});

const child = (path: string) => ({ name: path.split("/").at(-1)!, path, isDirectory: true, allowed: true, hasProject: false });
const listing = (path: string, children: string[], cursor: string | null = null, roots = ["/work"]): ApiResult<DirectoryListing> => ({
  ok: true,
  data: { path, parent: null, roots, entries: children.map(child), hasMore: cursor !== null, nextCursor: cursor },
});

let socket: CollabSocket | null = null;
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); socket = null; });

describe("V17-02 refused prompt recovery", () => {
  const mountConversation = async (conversationId = "c-1") => {
    vi.mocked(api.getConversation).mockResolvedValue({ ok: true, data: conversation(conversationId) });
    vi.mocked(api.getAttachInstructions).mockResolvedValue({ ok: true, data: { conversationId, available: false, command: null, tmuxSessionName: null, reason: null } });
    vi.mocked(api.getModels).mockResolvedValue({ ok: true, data: { models: [], source: "omp", reason: null } });
    vi.mocked(api.getConversationLink).mockResolvedValue({ ok: true, data: { url: "ws://127.0.0.1:7466/r/0123456789abcdef.AQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQE", access: "full", instanceId: "i", generation: 1 } });
    vi.spyOn(CollabSocket.prototype, "connect").mockImplementation(function (this: CollabSocket) { socket = this; this.onOpen?.(); });
    vi.spyOn(CollabSocket.prototype, "send").mockResolvedValue(true);
    const onDraftChange = vi.fn();
    const view = render(<ConversationView conversationId={conversationId} onDraftChange={onDraftChange} onBack={() => {}} />);
    await waitFor(() => expect(socket).not.toBeNull());
    await act(async () => { socket!.onFrame?.(welcome(), 0); });
    await waitFor(() => expect(view.container.querySelector("textarea.composer-input")).not.toBeNull());
    return { view, onDraftChange, composer: () => view.container.querySelector("textarea.composer-input") as HTMLTextAreaElement };
  };
  const refuseTypingDraft = async (composer: () => HTMLTextAreaElement) => {
    fireEvent.change(composer(), { target: { value: "PROMPT_B" } });
    await act(async () => { fireEvent.submit(composer().closest("form")!); });
    fireEvent.change(composer(), { target: { value: "DRAFT_C" } });
    await act(async () => { socket!.onFrame?.({ t: "error", message: REFUSAL }, 0); });
  };

  it("keeps the newer draft and recovers the refused text only on an explicit click", async () => {
    const { view, onDraftChange, composer } = await mountConversation();
    await refuseTypingDraft(composer);
    // The user's newer draft is untouched, the refused prompt is reachable behind
    // its own affordance, and it never masquerades as a host-confirmed message row.
    expect(composer().value).toBe("DRAFT_C");
    expect(view.container.querySelectorAll(".message-card.user")).toHaveLength(0);
    expect(view.container.querySelector(".refused-prompt")?.textContent).toContain("PROMPT_B");
    fireEvent.click(screen.getByRole("button", { name: "Recover" }));
    expect(composer().value).toBe("PROMPT_B");
    expect(onDraftChange).toHaveBeenLastCalledWith("PROMPT_B");
    expect(view.container.querySelector(".refused-prompt")).toBeNull();
  });

  it("recovers the refused prompt after the user clears the newer draft", async () => {
    const { view, composer } = await mountConversation();
    await refuseTypingDraft(composer);
    fireEvent.change(composer(), { target: { value: "" } });
    expect(view.container.querySelector(".refused-prompt")).not.toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Recover" }));
    expect(composer().value).toBe("PROMPT_B");
  });

  it("copies the refused text through the same clipboard contract as code blocks", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal("navigator", { ...navigator, clipboard: { writeText } });
    const { composer } = await mountConversation();
    await refuseTypingDraft(composer);
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Copy" })); });
    expect(writeText).toHaveBeenCalledWith("PROMPT_B");
    expect(screen.getByRole("button", { name: "Copied" })).not.toBeNull();
    // Copying is not a recovery: the composer still holds the user's newer draft.
    expect(composer().value).toBe("DRAFT_C");
  });

  it("reports a missing clipboard instead of silently doing nothing", async () => {
    vi.stubGlobal("navigator", { ...navigator, clipboard: undefined });
    const { composer } = await mountConversation();
    await refuseTypingDraft(composer);
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Copy" })); });
    expect(screen.getByRole("button", { name: "Copy failed" })).not.toBeNull();
  });

  it("shows only the newest refused prompt when a second refusal arrives", async () => {
    const { view, composer } = await mountConversation();
    await refuseTypingDraft(composer);
    expect(view.container.querySelector(".refused-prompt")?.textContent).toContain("PROMPT_B");
    // Send the draft: it is accepted, the composer clears, then it too is refused
    // while newer content is typed. The single affordance must now carry C.
    await act(async () => { fireEvent.submit(composer().closest("form")!); });
    fireEvent.change(composer(), { target: { value: "DRAFT_D" } });
    await act(async () => { socket!.onFrame?.({ t: "error", message: REFUSAL }, 0); });
    expect(composer().value).toBe("DRAFT_D");
    expect(view.container.querySelector(".refused-prompt")?.textContent).toContain("DRAFT_C");
    expect(view.container.querySelector(".refused-prompt")?.textContent).not.toContain("PROMPT_B");
  });

  it("drops a stale refusal when the conversation changes", async () => {
    const { view, composer } = await mountConversation("c-1");
    await refuseTypingDraft(composer);
    expect(view.container.querySelector(".refused-prompt")).not.toBeNull();
    view.rerender(<ConversationView conversationId="c-2" draft="" onDraftChange={() => {}} onBack={() => {}} />);
    expect(view.container.querySelector(".refused-prompt")).toBeNull();
    expect(view.container.textContent).not.toContain("PROMPT_B");
  });

  it("still restores directly into the untouched composer", async () => {
    const { view, composer } = await mountConversation();
    fireEvent.change(composer(), { target: { value: "PROMPT_B" } });
    await act(async () => { fireEvent.submit(composer().closest("form")!); });
    await act(async () => { socket!.onFrame?.({ t: "error", message: REFUSAL }, 0); });
    expect(composer().value).toBe("PROMPT_B");
    expect(view.container.querySelector(".refused-prompt")).toBeNull();
  });
});

describe("V17-04 rename single-flight", () => {
  const tempDirs: string[] = [];
  afterEach(async () => { await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true }))); });

  const setup = async (labels: string[]) => {
    const dir = await mkdtemp(join(tmpdir(), "caw-r17w-rename-"));
    tempDirs.push(dir);
    const store = createMetadataStore(dir);
    const created: ProjectWithStats[] = [];
    for (const label of labels) {
      const project = await store.createProject({ path: `/work/${label}`, label });
      created.push({ ...project, conversationCount: 0, lastActivityAt: null });
    }
    vi.mocked(api.listProjects).mockImplementation(async () => ({ ok: true, data: (await store.listProjects()).map((project) => ({ ...project, conversationCount: 0, lastActivityAt: null })) }));
    const pending: Array<{ id: string; label: string; resolve: (value: ApiResult<ProjectWithStats>) => void }> = [];
    vi.mocked(api.updateProject).mockImplementation((id, patch) => new Promise<ApiResult<ProjectWithStats>>((resolve) => pending.push({ id, label: patch.label!, resolve })));
    await act(async () => { render(<ProjectsView onSelectProject={() => {}} onOpenSettings={() => {}} />); });
    const card = (path: string) => within(screen.getByText(path).closest(".card")! as HTMLElement);
    const settle = async (index: number, ok = true) => {
      const request = pending[index]!;
      const result = ok ? await store.updateProject(request.id, { label: request.label }) : null;
      await act(async () => {
        request.resolve(ok
          ? { ok: true, data: { ...result!, conversationCount: 0, lastActivityAt: null } }
          : { ok: false, error: { code: "internal", message: "Injected rename failure" } });
      });
    };
    const persistedLabel = async (index = 0) => (await createMetadataStore(dir).listProjects()).find((row) => row.id === created[index]!.id)!.label;
    return { pending, card, settle, persistedLabel };
  };

  it("coalesces two Saves into one follow-up so the last label persists whatever the arrival order", async () => {
    const { pending, card, settle, persistedLabel } = await setup(["Original"]);
    fireEvent.click(card("/work/Original").getByRole("button", { name: "Rename" }));
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "First label" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "Final label" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    // The second Save recorded an intent instead of racing a second PATCH.
    expect(pending.map((request) => request.label)).toEqual(["First label"]);
    await settle(0);
    // Exactly one follow-up carries the newest label, so arrival order cannot decide.
    expect(pending.map((request) => request.label)).toEqual(["First label", "Final label"]);
    await settle(1);
    expect(await persistedLabel()).toBe("Final label");
    expect(screen.queryByRole("textbox")).toBeNull();
  });

  it("does not send a follow-up when both Saves asked for the same label", async () => {
    const { pending, card, settle } = await setup(["Original"]);
    fireEvent.click(card("/work/Original").getByRole("button", { name: "Rename" }));
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "Same" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await settle(0);
    expect(pending).toHaveLength(1);
  });

  it("a follow-up response cannot close a dialog opened for another rename", async () => {
    const { pending, card, settle } = await setup(["A", "B"]);
    fireEvent.click(card("/work/A").getByRole("button", { name: "Rename" }));
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "A one" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "A two" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    fireEvent.click(card("/work/B").getByRole("button", { name: "Rename" }));
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "B draft" } });
    // A's original and follow-up land while B's editor is open: both must survive.
    await settle(0);
    await settle(1);
    expect(pending.map((request) => request.label)).toEqual(["A one", "A two"]);
    expect((screen.getByRole("textbox") as HTMLInputElement).value).toBe("B draft");
  });

  it("keeps two projects' rename flights independent", async () => {
    const { pending, card, settle } = await setup(["A", "B"]);
    fireEvent.click(card("/work/A").getByRole("button", { name: "Rename" }));
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "A new" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    fireEvent.click(card("/work/B").getByRole("button", { name: "Rename" }));
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "B new" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(pending.map((request) => request.label)).toEqual(["A new", "B new"]);
    await settle(1);
    await settle(0);
  });

  it("still sends the newest intent when the first write fails", async () => {
    const { pending, card, settle, persistedLabel } = await setup(["Original"]);
    fireEvent.click(card("/work/Original").getByRole("button", { name: "Rename" }));
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "First label" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "Final label" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await settle(0, false);
    expect(screen.getByRole("alert").textContent).toContain("Injected rename failure");
    expect(pending.map((request) => request.label)).toEqual(["First label", "Final label"]);
    await settle(1);
    expect(await persistedLabel()).toBe("Final label");
  });
});

describe("V17-05 folder loader ownership", () => {
  it("a Roots click during the initial load does not invalidate its only completion", async () => {
    const deferred = new Map<string, (value: ApiResult<DirectoryListing>) => void>();
    vi.mocked(api.browse).mockImplementation((path) => new Promise<ApiResult<DirectoryListing>>((resolve) => { deferred.set(path ?? "/", resolve); }));
    await act(async () => { render(<FolderBrowser onSelect={() => {}} onCancel={() => {}} />); });
    fireEvent.click(screen.getByRole("button", { name: "Roots" }));
    await act(async () => { deferred.get("/")!(listing("/work", ["ready"])); });
    expect(screen.getByText("📁 ready")).not.toBeNull();
    expect((screen.getByRole("button", { name: "Use this folder" }) as HTMLButtonElement).disabled).toBe(false);
  });

  it("clicking the breadcrumb of the current directory leaves a pending page intact", async () => {
    const page = new Map<string, (value: ApiResult<DirectoryListing>) => void>();
    vi.mocked(api.browse).mockImplementation((path, options) => options?.cursor
      ? new Promise<ApiResult<DirectoryListing>>((resolve) => { page.set("more", resolve); })
      : Promise.resolve(listing(path ?? "/work/A", ["/work/A/other"], "page2")));
    await act(async () => { render(<FolderBrowser onSelect={() => {}} onCancel={() => {}} />); });
    // Navigate to the directory the breadcrumb names, so its currentPath matches it.
    fireEvent.click(screen.getByRole("button", { name: "A" }));
    await act(async () => {});
    fireEvent.click(screen.getByRole("button", { name: "Load more" }));
    // Re-asserting the current directory is a no-op: a bump here would strand the page.
    fireEvent.click(screen.getByRole("button", { name: "A" }));
    await act(async () => { page.get("more")!(listing("/work/A", ["/work/A/tail"], "page3")); });
    expect(screen.getByText("📁 tail")).not.toBeNull();
  });

  it("cancelling the new-folder form leaves an in-flight page request intact", async () => {
    const deferred = new Map<string, (value: ApiResult<DirectoryListing>) => void>();
    vi.mocked(api.browse).mockImplementation((_path, options) => options?.cursor
      ? new Promise<ApiResult<DirectoryListing>>((resolve) => { deferred.set("more", resolve); })
      : Promise.resolve(listing("/work", ["/work/other"], "page2")));
    await act(async () => { render(<FolderBrowser onSelect={() => {}} onCancel={() => {}} />); });
    fireEvent.click(screen.getByRole("button", { name: "Load more" }));
    fireEvent.click(screen.getByRole("button", { name: "+ New Folder" }));
    const form = screen.getByLabelText(/New folder in/).closest("form")!;
    fireEvent.click(within(form).getByRole("button", { name: "Cancel" }));
    await act(async () => { deferred.get("more")!(listing("/work", ["/work/tail"], "page3")); });
    expect(screen.getByText("📁 tail")).not.toBeNull();
  });

  it("a real navigation still drops the previous loader's completion", async () => {
    const deferred = new Map<string, (value: ApiResult<DirectoryListing>) => void>();
    vi.mocked(api.browse).mockImplementation((path) => new Promise<ApiResult<DirectoryListing>>((resolve) => { deferred.set(path ?? "/", resolve); }));
    await act(async () => { render(<FolderBrowser onSelect={() => {}} onCancel={() => {}} />); });
    await act(async () => { deferred.get("/")!(listing("/work", ["/work/B"])); });
    await act(async () => { fireEvent.click(screen.getByText("📁 B")); });
    // Roots from /work/B is a real navigation: it bumps the generation, so the
    // abandoned /work/B load cannot write into the new one.
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Roots" })); });
    await act(async () => { deferred.get("/work/B")!(listing("/work/B", ["/work/B/stale"])); });
    expect(screen.queryByText("📁 stale")).toBeNull();
    await act(async () => { deferred.get("/")!(listing("/work", ["/work/B"])); });
    expect(screen.getByText("📁 B")).not.toBeNull();
  });
});

describe("V17-06 logout outcomes", () => {
  const renderSettings = async (onLogout: () => void) => {
    vi.mocked(api.getRuntime).mockResolvedValue({ ok: false, error: { code: "internal", message: "no runtime" } });
    render(<SettingsView onBack={() => {}} onLogout={onLogout} />);
    await screen.findByRole("button", { name: "Sign out" });
  };

  it("signs out on a successful revoke", async () => {
    const onLogout = vi.fn();
    vi.mocked(api.logout).mockResolvedValue({ ok: true, data: { loggedOut: true } });
    await renderSettings(onLogout);
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Sign out" })); });
    expect(onLogout).toHaveBeenCalledTimes(1);
  });

  it("reports an offline logout and offers a retry instead of signing out", async () => {
    const onLogout = vi.fn();
    vi.mocked(api.logout).mockResolvedValue({ ok: false, error: { code: "internal", message: "Network request failed" } });
    vi.mocked(api.getMe).mockResolvedValue({ ok: false, error: { code: "internal", message: "Network request failed" } });
    await renderSettings(onLogout);
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Sign out" })); });
    expect(onLogout).not.toHaveBeenCalled();
    expect(screen.getByRole("alert").textContent).toContain("Network request failed");
    expect(screen.getByRole("button", { name: "Retry sign out" })).not.toBeNull();
  });

  it("surfaces a server failure without pretending the user is signed out", async () => {
    const onLogout = vi.fn();
    vi.mocked(api.logout).mockResolvedValue({ ok: false, error: { code: "internal", message: "Internal server error" }, httpStatus: 500 });
    vi.mocked(api.getMe).mockResolvedValue({ ok: true, data: { csrfToken: "csrf" } });
    await renderSettings(onLogout);
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Sign out" })); });
    expect(onLogout).not.toHaveBeenCalled();
    expect(screen.getByRole("alert").textContent).toContain("Internal server error");
  });

  it("treats an already-expired session as signed out", async () => {
    const onLogout = vi.fn();
    vi.mocked(api.logout).mockResolvedValue({ ok: false, error: { code: "unauthorized", message: "Authentication required" }, httpStatus: 401 });
    await renderSettings(onLogout);
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Sign out" })); });
    expect(onLogout).toHaveBeenCalledTimes(1);
  });

  it("treats a revoked session whose response was lost as signed out via the probe", async () => {
    const onLogout = vi.fn();
    vi.mocked(api.logout).mockResolvedValue({ ok: false, error: { code: "internal", message: "Network request failed" } });
    vi.mocked(api.getMe).mockResolvedValue({ ok: false, error: { code: "unauthorized", message: "Authentication required" }, httpStatus: 401 });
    await renderSettings(onLogout);
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Sign out" })); });
    expect(onLogout).toHaveBeenCalledTimes(1);
  });
});

describe("V17-06 api.logout CSRF ownership", () => {
  // The real module, not the mocked one: the CSRF token's fate is owned by api.logout.
  const realApi = () => vi.importActual<typeof apiModule>("../../apps/web/src/api.js");
  const jsonResponse = (status: number, body: unknown) => ({ status, json: async () => body });

  it("keeps the CSRF token when the revocation never reached the server", async () => {
    const mod = await realApi();
    mod.setCsrfToken("csrf-live");
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("Network request failed")));
    const res = await mod.api.logout();
    expect(res.ok).toBe(false);
    // The retry needs the token: the session cookie is still valid.
    expect(mod.getCsrfToken()).toBe("csrf-live");
  });

  it("clears the CSRF token once the revoke is confirmed", async () => {
    const mod = await realApi();
    mod.setCsrfToken("csrf-live");
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse(200, { ok: true, data: { loggedOut: true } })));
    const res = await mod.api.logout();
    expect(res.ok).toBe(true);
    expect(mod.getCsrfToken()).toBeNull();
  });

  it("clears the CSRF token when the session is already gone", async () => {
    const mod = await realApi();
    mod.setCsrfToken("csrf-live");
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse(401, { ok: false, error: { code: "unauthorized", message: "Authentication required" } })));
    const res = await mod.api.logout();
    expect(res.ok).toBe(false);
    expect(res.httpStatus).toBe(401);
    expect(mod.getCsrfToken()).toBeNull();
  });
});
