// @vitest-environment jsdom
import React from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { ProjectDetailView } from "../../apps/web/src/components/ProjectDetailView.js";
import { api } from "../../apps/web/src/api.js";
import type { NativeSessionSummary } from "@caw/contracts";

vi.mock("../../apps/web/src/api.js", () => ({
  api: {
    listProjects: vi.fn(),
    listConversations: vi.fn(),
    listNativeSessions: vi.fn(),
    createConversation: vi.fn(),
  },
}));

/**
 * The native-session badge is the only place the UI claims whether a session is
 * being written. A failed lease observation arrives as `"unknown"` — a truthy
 * string — so a naive `sess.live && …` renders an unverifiable session as
 * confidently live and invites the owner to start a second writer on it.
 */
function session(over: Partial<NativeSessionSummary> = {}): NativeSessionSummary {
  return {
    sessionId: "01a16ed6-2ebb-7609-a2a2-e76d0d8dd06e",
    path: "/tmp/project/session.jsonl",
    cwd: "/tmp/project",
    title: "A session",
    updatedAt: "2026-01-01T00:00:00.000Z",
    live: false,
    tracked: false,
    ...over,
  };
}

async function renderWith(sessions: NativeSessionSummary[], onSelectConversation = () => {}) {
  vi.mocked(api.listProjects).mockResolvedValue({
    ok: true,
    data: [{ id: "p1", path: "/tmp/project", label: "project", favorite: false, createdAt: "", updatedAt: "" }],
  } as never);
  vi.mocked(api.listNativeSessions).mockResolvedValue({ ok: true, data: sessions } as never);

  await act(async () => {
    render(<ProjectDetailView projectId="p1" onBack={() => {}} onSelectConversation={onSelectConversation} />);
  });
}

describe("native session liveness badge", () => {
  beforeEach(() => {
    cleanup();
    vi.clearAllMocks();
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
    vi.mocked(api.createConversation).mockResolvedValue({
      ok: true, data: { id: "resumed-conversation" },
    } as never);
    await renderWith([session({ live: false })], onSelectConversation);
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Resume in app" }));
    });
    expect(api.createConversation).toHaveBeenCalledWith("p1", "A session", session().sessionId);
    expect(onSelectConversation).toHaveBeenCalledWith("resumed-conversation");
  });

  it("offers terminal guidance for a live native writer without resume action", async () => {
    await renderWith([session({ live: true })]);
    expect(screen.getByText("This session already has a writer. Attach in the terminal instead.")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Resume in app" })).toBeNull();
    expect(api.createConversation).not.toHaveBeenCalled();
  });
  it("surfaces a conflict_owner response if writer appears after listing", async () => {
    vi.mocked(api.createConversation).mockResolvedValue({
      ok: false, error: { code: "conflict_owner", message: "Refusing to fork history" },
    } as never);
    await renderWith([session({ live: false })]);
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Resume in app" }));
    });
    expect(screen.getByRole("alert").textContent).toMatch(/already has a writer/i);
    expect(screen.getByRole("alert").textContent).toMatch(/attach in the terminal/i);
    expect(api.createConversation).toHaveBeenCalledTimes(1);
  });


  it("does not offer resume when the lease is unknown or session is already tracked", async () => {
    await renderWith([session({ live: "unknown" }), session({ sessionId: "tracked-id", tracked: true })]);
    expect(screen.queryByRole("button", { name: "Resume in app" })).toBeNull();
  });

  it("shows persisted lifecycle details beside the conversation state", async () => {
    vi.mocked(api.listConversations).mockResolvedValue({
      ok: true,
      data: [{ id: "c1", title: "Stopped chat", state: "stopped", statusDetail: "The agent process is no longer running; its conversation history is intact.", model: null, lastActivityAt: null }],
    } as never);
    await renderWith([]);
    expect(screen.getByText("The agent process is no longer running; its conversation history is intact.")).toBeTruthy();
  });
});
