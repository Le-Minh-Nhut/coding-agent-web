// @vitest-environment jsdom
import React from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import type {
  AgentSnapshot,
  SessionHeader,
} from "../../packages/guest/src/vendor/wire";
import {
  GuestClient,
  PromptRecoveryStore,
} from "../../packages/guest/src/lib/client";
import { AgentsPanel } from "../../packages/guest/src/components/agents/AgentsPanel";
import { AgentDrawer } from "../../packages/guest/src/components/agents/AgentDrawer";
import { Composer } from "../../packages/guest/src/components/shell/Composer";
import { Toasts } from "../../packages/guest/src/components/shell/Toasts";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});
const link = "wss://example.com/r/AAAAAAAAAAAAAAAA." + "B".repeat(43);
const state = (isStreaming = false) => ({
  isStreaming,
  queuedMessageCount: 0,
  cwd: "",
  participants: [],
});
const agent = (id: string): AgentSnapshot => ({
  id,
  displayName: id,
  kind: "sub",
  status: "running",
  hasSessionFile: false,
  createdAt: 0,
  lastActivity: 0,
});
const welcome = (
  client: GuestClient,
  agents: AgentSnapshot[],
  isStreaming = false,
  entryCount = 0,
) =>
  client.applyFrameForTest({
    t: "welcome",
    proto: 3,
    header: { id: "session" } as unknown as SessionHeader,
    state: state(isStreaming),
    agents,
    entryCount,
  });

it("uses welcome roster immediately and replaces it on every welcome; agents deltas survive snapshots", () => {
  const client = new GuestClient(link, "guest", new PromptRecoveryStore());
  welcome(client, [agent("A"), agent("B")], true, 1);
  expect(client.getSnapshot().agents.map((a) => a.id)).toEqual(["A", "B"]);
  expect(client.getSnapshot().working).toBe(true);
  const first = render(
    <AgentsPanel
      agents={client.getSnapshot().agents}
      progress={client.getSnapshot().progress}
      lifecycle={client.getSnapshot().lifecycle}
      selectedId={null}
      onSelect={() => {}}
    />,
  );
  expect(first.getByText("A")).toBeTruthy();
  welcome(client, [agent("B"), agent("C")], false);
  expect(client.getSnapshot().agents.map((a) => a.id)).toEqual(["B", "C"]);
  expect(client.getSnapshot().working).toBe(false);
  welcome(client, [], true);
  expect(client.getSnapshot().agents).toEqual([]);
  expect(client.getSnapshot().working).toBe(true);
  welcome(client, [], false, 2);
  client.applyFrameForTest({
    t: "bus",
    channel: "task:subagent:progress",
    data: {
      index: 0,
      agent: "X",
      task: "task",
      progress: {
        index: 0,
        id: "X",
        agent: "X",
        status: "running",
        task: "task",
        recentTools: [],
        recentOutput: [],
        toolCount: 0,
        requests: 0,
        tokens: 0,
        cost: 0,
        durationMs: 0,
      },
    },
  });
  client.applyFrameForTest({ t: "agents", agents: [agent("X")] });
  expect(client.getSnapshot().agents.map((a) => a.id)).toEqual(["X"]);
  expect(client.getSnapshot().progress.has("X")).toBe(true);
  client.close();
});

it("clears old absent-agent grace on welcome before fresh bus progress", () => {
  const client = new GuestClient(link, "guest", new PromptRecoveryStore());
  const progress = {
    index: 0,
    agent: "X",
    task: "task",
    progress: {
      index: 0,
      id: "X",
      agent: "X",
      status: "running" as const,
      task: "task",
      recentTools: [],
      recentOutput: [],
      toolCount: 0,
      requests: 0,
      tokens: 0,
      cost: 0,
      durationMs: 0,
    },
  };
  welcome(client, []);
  client.applyFrameForTest({
    t: "bus",
    channel: "task:subagent:progress",
    data: progress,
  });
  client.applyFrameForTest({ t: "agents", agents: [] });
  expect(client.getSnapshot().progress.has("X")).toBe(true);
  welcome(client, []);
  client.applyFrameForTest({
    t: "bus",
    channel: "task:subagent:progress",
    data: progress,
  });
  client.applyFrameForTest({ t: "agents", agents: [] });
  expect(client.getSnapshot().progress.has("X")).toBe(true);
  client.close();
});

it("lets B chat while A is pending without A completion unlocking B", async () => {
  const resolvers = new Map<string, (value: boolean) => void>();
  const send = vi.fn(
    (_cmd: string, id: string) =>
      new Promise<boolean>((resolve) => {
        resolvers.set(id, resolve);
      }),
  );
  const client = { sendAgentCmd: send } as unknown as GuestClient;
  const base = {
    progress: undefined,
    lifecycle: undefined,
    client,
    phase: "live" as const,
    onClose: () => {},
  };
  const view = render(<AgentDrawer {...base} agent={agent("A")} />);
  fireEvent.change(screen.getByPlaceholderText("message A…"), {
    target: { value: "same text" },
  });
  fireEvent.click(screen.getByRole("button", { name: "send" }));
  view.rerender(<AgentDrawer {...base} agent={agent("B")} />);
  fireEvent.change(screen.getByPlaceholderText("message B…"), {
    target: { value: "same text" },
  });
  fireEvent.click(screen.getByRole("button", { name: "send" }));
  expect(send.mock.calls.map((call) => call[1])).toEqual(["A", "B"]);
  resolvers.get("A")!(true);
  await Promise.resolve();
  await Promise.resolve();
  fireEvent.click(screen.getByRole("button", { name: "send" }));
  expect(send).toHaveBeenCalledTimes(2);
  resolvers.get("B")!(false);
  await vi.waitFor(() =>
    expect(
      screen.getByText("message not sent — press send to retry"),
    ).toBeTruthy(),
  );
});

it("does not show stale response or stop failures under a new approval", async () => {
  let rejectAbort!: (error: Error) => void;
  const resolvers: Array<(accepted: boolean) => void> = [];
  const client = {
    getSnapshot: () => ({ unconfirmedPrompts: [], notices: [] }),
    subscribe: () => () => {},
    releaseRecoveredPrompts: () => {},
    sendUiResponse: () =>
      new Promise<boolean>((resolve) => resolvers.push(resolve)),
    sendAbort: () =>
      new Promise<boolean>((_resolve, reject) => {
        rejectAbort = reject;
      }),
  } as unknown as GuestClient;
  const request = (reqId: number) => ({
    reqId,
    kind: "select" as const,
    title: `Approval ${reqId}`,
    options: ["Yes"],
  });
  let active = request(1);
  const renderComposer = () => (
    <Composer
      client={client}
      phase="live"
      readOnly={false}
      uiRequest={active}
      uiRequestEnd={null}
      working={true}
      queuedMessageCount={0}
      draft=""
      onDraftChange={() => {}}
    />
  );
  const view = render(renderComposer());
  fireEvent.click(screen.getByRole("button", { name: "○ Yes" }));
  resolvers[0](false);
  await vi.waitFor(() =>
    expect(
      screen.getByText("response not sent — retry or check connection"),
    ).toBeTruthy(),
  );
  fireEvent.click(screen.getByRole("button", { name: /Stop/ }));
  active = request(2);
  view.rerender(renderComposer());
  await vi.waitFor(() => expect(rejectAbort).toBeDefined());
  rejectAbort(new Error("old abort"));
  await Promise.resolve();
  await Promise.resolve();
  expect(
    screen.queryByText("response not sent — retry or check connection"),
  ).toBeNull();
  expect(
    screen.queryByText("stop request not sent — connection lost or offline"),
  ).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "○ Yes" }));
  resolvers[1](false);
  await vi.waitFor(() =>
    expect(
      screen.getByText("response not sent — retry or check connection"),
    ).toBeTruthy(),
  );
});
it("does not carry pending Stop failure into replacement client", async () => {
  let resolveAbort!: (sent: boolean) => void;
  const clientA = {
    getSnapshot: () => ({ unconfirmedPrompts: [], notices: [] }),
    subscribe: () => () => {},
    releaseRecoveredPrompts: () => {},
    sendAbort: () =>
      new Promise<boolean>((resolve) => {
        resolveAbort = resolve;
      }),
  } as unknown as GuestClient;
  const clientB = {
    getSnapshot: () => ({ unconfirmedPrompts: [], notices: [] }),
    subscribe: () => () => {},
    releaseRecoveredPrompts: () => {},
    sendAbort: vi.fn(),
  } as unknown as GuestClient;
  const renderComposer = (client: GuestClient) => (
    <Composer
      client={client}
      phase="live"
      readOnly={false}
      uiRequest={null}
      uiRequestEnd={null}
      working={true}
      queuedMessageCount={0}
      draft=""
      onDraftChange={() => {}}
    />
  );
  const view = render(renderComposer(clientA));
  fireEvent.click(screen.getByRole("button", { name: /Stop/ }));
  view.rerender(renderComposer(clientB));
  await act(async () => {
    resolveAbort(false);
  });
  expect(
    screen.queryByText("stop request not sent — connection lost or offline"),
  ).toBeNull();
});

it("shows replacement client notice after dismissing same id from old client", () => {
  const clientA = {} as GuestClient;
  const clientB = {} as GuestClient;
  const notice = (message: string) => [
    { id: 1, level: "error" as const, message, at: 0 },
  ];
  const view = render(
    <Toasts client={clientA} notices={notice("A failure")} />,
  );
  fireEvent.click(screen.getByTitle("dismiss"));
  expect(screen.queryByText("A failure")).toBeNull();
  view.rerender(<Toasts client={clientB} notices={notice("B failure")} />);
  expect(screen.getByText("B failure")).toBeTruthy();
});
