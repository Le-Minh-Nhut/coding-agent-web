// @vitest-environment jsdom
import React from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { ProjectDetailView } from "../../apps/web/src/components/ProjectDetailView.js";
import { api } from "../../apps/web/src/api.js";
import type { Conversation, NativeSessionSummary } from "@caw/contracts";

vi.mock("../../apps/web/src/api.js", () => ({
  api: {
    getConversationEvents: vi.fn(async () => ({ ok: true, data: { events: [], nextAfter: null, nextBefore: null } })),
    listProjects: vi.fn(),
    listConversations: vi.fn(),
    listNativeSessions: vi.fn(),
    createConversation: vi.fn(),
    attachLiveSession: vi.fn(),
    restartConversation: vi.fn(),
  },
}));

type SessionWithHost = NativeSessionSummary;

function session(over: Partial<NativeSessionSummary> = {}): NativeSessionSummary {
  return {
    sessionId: "01a16ed6-2ebb-7609-a2a2-e76d0d8dd06e",
    path: "/tmp/project/session.jsonl",
    cwd: "/tmp/project",
    title: "A session",
    updatedAt: "2026-01-01T00:00:00.000Z",
    cwdAvailable: true,
    conversationId: null,
    live: false,
    hasCollabHost: false,
    tracked: false,
    ...over,
  };
}

async function renderWith(sessions: SessionWithHost[], onSelectConversation = () => {}, projectLabel = "project") {
  vi.mocked(api.listProjects).mockResolvedValue({
    ok: true,
    data: [{ id: "p1", path: "/tmp/project", label: projectLabel, favorite: false, createdAt: "", updatedAt: "" }],
  } as never);
  vi.mocked(api.listNativeSessions).mockResolvedValue({ ok: true, data: sessions } as never);

  let unmount!: () => void;
  await act(async () => {
    unmount = render(<ProjectDetailView projectId="p1" onBack={() => {}} onSelectConversation={onSelectConversation} />).unmount;
  });
  return unmount;
}

function externalConversation(): Conversation {
  return {
    id: "external-chat", projectId: "p1", nativeSessionId: session().sessionId, nativeSessionPath: null,
    title: "A session", modelPreference: null, model: null, ownership: "external", state: "unknown",
    tmuxSessionId: null, tmuxSessionName: null, tmuxServerIdentity: null, tmuxPanePid: null,
    hostInstanceId: "host", hostGeneration: 1, createdAt: "", updatedAt: "", lastActivityAt: null,
    statusDetail: "Observed live session; lifecycle is not managed here.",
  };
}

describe("native session liveness badge", () => {
  beforeEach(() => {
    cleanup();
    vi.clearAllMocks();
    vi.mocked(api.getConversationEvents).mockResolvedValue({ ok: true, data: { events: [], nextAfter: null, nextBefore: null } });
    vi.mocked(api.listConversations).mockResolvedValue({ ok: true, data: [] } as never);
  });

  it("shows live only when a writer actually holds the lease", async () => {
    await renderWith([session({ live: true })]);
    expect(screen.getByText("live")).toBeTruthy();
    expect(screen.queryByText("unknown")).toBeNull();
  });

  it("shows unknown — not live — when the lease could not be determined", async () => {
    await renderWith([session({ live: "unknown" })]);
    expect(screen.getByText("unknown")).toBeTruthy();
    expect(screen.queryByText("live")).toBeNull();
  });

  it("shows neither badge for a confirmed-free session", async () => {
    await renderWith([session({ live: false })]);
    expect(screen.queryByText("live")).toBeNull();
    expect(screen.queryByText("unknown")).toBeNull();
  });

  it("keeps the tracked badge independent of liveness", async () => {
    await renderWith([session({ live: "unknown", tracked: true })]);
    expect(screen.getByText("unknown")).toBeTruthy();
    expect(screen.getByText("tracked")).toBeTruthy();
  });

  it("resumes only untracked, confirmed-free native sessions through existing API", async () => {
    const onSelectConversation = vi.fn();
    vi.mocked(api.createConversation).mockResolvedValue({ ok: true, data: { id: "resumed-conversation" } } as never);
    await renderWith([session({ live: false })], onSelectConversation);
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Resume in app" })); });
    expect(api.createConversation).toHaveBeenCalledWith("p1", "A session", session().sessionId);
    expect(onSelectConversation).toHaveBeenCalledWith("resumed-conversation");
  });

  it("opens a verified live host through attach route without creating or restarting", async () => {
    const onSelectConversation = vi.fn();
    vi.mocked(api.attachLiveSession).mockResolvedValue({ ok: true, data: externalConversation() } as never);
    await renderWith([session({ live: true, hasCollabHost: true })], onSelectConversation);
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Open live session" })); });
    expect(api.attachLiveSession).toHaveBeenCalledWith("p1", session().sessionId);
    expect(api.createConversation).not.toHaveBeenCalled();
    expect(api.restartConversation).not.toHaveBeenCalled();
    expect(onSelectConversation).toHaveBeenCalledWith("external-chat");
  });

  it("does not offer attach when a live session has no verified Collab host", async () => {
    await renderWith([session({ live: true, hasCollabHost: false })]);
    expect(screen.queryByRole("button", { name: "Open live session" })).toBeNull();
    expect(screen.getByText("Open live unavailable: no verified Collab host for this session.")).toBeTruthy();
    expect(api.attachLiveSession).not.toHaveBeenCalled();
  });

  it("surfaces host listing failure instead of hiding a possible host", async () => {
    vi.mocked(api.listProjects).mockResolvedValue({ ok: true, data: [{ id: "p1", path: "/tmp/project", label: "project", favorite: false, createdAt: "", updatedAt: "" }] } as never);
    vi.mocked(api.listConversations).mockResolvedValue({ ok: true, data: [] } as never);
    vi.mocked(api.listNativeSessions).mockResolvedValue({ ok: false, error: { code: "internal", message: "Could not read Collab host registry." } } as never);
    await act(async () => { render(<ProjectDetailView projectId="p1" onBack={() => {}} onSelectConversation={() => {}} />); });
    expect(screen.getByRole("alert").textContent).toMatch(/Could not read Collab host registry\./);
  });

  it("surfaces a conflict_owner response if writer appears after listing", async () => {
    vi.mocked(api.createConversation).mockResolvedValue({ ok: false, error: { code: "conflict_owner", message: "Refusing to fork history" } } as never);
    await renderWith([session({ live: false })]);
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Resume in app" })); });
    expect(screen.getByRole("alert").textContent).toMatch(/already has a writer/i);
    expect(screen.getByRole("alert").textContent).toMatch(/attach in the terminal/i);
    expect(api.createConversation).toHaveBeenCalledTimes(1);
  });

  it("does not offer resume when the lease is unknown or session is already tracked", async () => {
    await renderWith([session({ live: "unknown" }), session({ sessionId: "tracked-id", tracked: true, conversationId: "known-conversation" })]);
    expect(screen.queryByRole("button", { name: "Resume in app" })).toBeNull();
    expect(screen.getByRole("button", { name: "Open conversation" })).toBeTruthy();
  });
  it("offers a resume action for untracked sessions and hides it for tracked sessions", async () => {
    await renderWith([
      session({ title: "Recreated project session", live: false, tracked: false }),
      session({ sessionId: "tracked-session", title: "Tracked session", live: false, tracked: true, conversationId: "known-conversation" }),
    ], () => {}, "Recreated project");
    expect(screen.getByRole("heading", { name: "Recreated project" })).toBeTruthy();
    expect(screen.getByText("No conversations yet.")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Resume in app" })).toBeTruthy();
    expect(screen.getByText("Tracked session")).toBeTruthy();
    expect(within(screen.getByText("Tracked session").closest(".card")!).getByRole("button", { name: "Open conversation" })).toBeTruthy();
    expect(screen.getAllByRole("button", { name: "Resume in app" })).toHaveLength(1);
  });
  it("retries only failed managed stopped sessions without creating a row", async () => {
    const onSelectConversation = vi.fn();
    const failed = { ...externalConversation(), id: "managed-chat", ownership: "managed" as const, state: "error" as const, modelPreference: "preferred-model" };
    vi.mocked(api.listConversations).mockResolvedValue({ ok: true, data: [failed] } as never);
    vi.mocked(api.restartConversation).mockResolvedValue({ ok: true, data: failed } as never);
    await renderWith([session({ live: false, tracked: true })], onSelectConversation);
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Retry" })); });
    expect(api.restartConversation).toHaveBeenCalledWith(failed.id);
    expect(api.createConversation).not.toHaveBeenCalled();
    expect(onSelectConversation).toHaveBeenCalledWith(failed.id);
  });
  it("does not navigate after Retry settles in a different project view", async () => {
    const onSelectConversation = vi.fn();
    const failed = { ...externalConversation(), id: "managed-chat", ownership: "managed" as const, state: "error" as const };
    let settle!: (value: { ok: true; data: typeof failed }) => void;
    vi.mocked(api.listConversations).mockResolvedValue({ ok: true, data: [failed] } as never);
    vi.mocked(api.restartConversation).mockImplementation(() => new Promise((resolve) => { settle = resolve; }) as never);
    const unmount = await renderWith([session({ live: false, tracked: true })], onSelectConversation);
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    unmount();
    await act(async () => { settle({ ok: true, data: failed }); });
    expect(onSelectConversation).not.toHaveBeenCalled();
  });
  it("does not offer Retry for externally managed live sessions or unsafe writer conflicts", async () => {
    const external = externalConversation();
    vi.mocked(api.listConversations).mockResolvedValue({ ok: true, data: [external] } as never);
    await renderWith([session({ live: true, tracked: true })]);
    expect(screen.queryByRole("button", { name: "Retry" })).toBeNull();
  });
  it("keeps server conflict refusal visible and does not create a second row", async () => {
    const failed = { ...externalConversation(), id: "managed-chat", ownership: "managed" as const, state: "error" as const };
    vi.mocked(api.listConversations).mockResolvedValue({ ok: true, data: [failed] } as never);
    vi.mocked(api.restartConversation).mockResolvedValue({ ok: false, error: { code: "conflict_owner", message: "Writer lease cannot be verified." } } as never);
    await renderWith([session({ live: false, tracked: true })]);
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    await act(async () => {});
    expect(screen.getByRole("alert").textContent).toContain("no second agent was started");
    expect(api.createConversation).not.toHaveBeenCalled();
  });

  it("shows persisted lifecycle details beside the conversation state", async () => {
    vi.mocked(api.listConversations).mockResolvedValue({ ok: true, data: [{ id: "c1", title: "Stopped chat", state: "stopped", statusDetail: "The agent process is no longer running; its conversation history is intact.", model: null, lastActivityAt: null }] } as never);
    await renderWith([]);
    expect(screen.getByText("The agent process is no longer running; its conversation history is intact.")).toBeTruthy();
  });
});
