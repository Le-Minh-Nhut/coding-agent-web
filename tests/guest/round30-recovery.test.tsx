// @vitest-environment jsdom
import React from "react";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, waitFor, screen, within } from "@testing-library/react";
import type { ReactNode } from "react";
import type { SessionHeader } from "@oh-my-pi/pi-wire";
import { Banners } from "../../packages/guest/src/components/shell/Banners";
import { Composer } from "../../packages/guest/src/components/shell/Composer";
import { CollabSocket } from "../../packages/guest/src/lib/socket";
import { GuestClient, PromptRecoveryStore } from "../../packages/guest/src/lib/client";
let App: () => ReactNode;
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

beforeAll(async () => {
  // App imports ThemeToggle, which reads matchMedia during module evaluation.
  vi.stubGlobal("matchMedia", vi.fn(() => ({ matches: false, addEventListener: vi.fn(), removeEventListener: vi.fn() })));
  ({ App } = await import("../../packages/guest/src/app"));
});

const link = "wss://example.com/r/AAAAAAAAAAAAAAAA." + "B".repeat(43);

function setupClient(): GuestClient {
  vi.spyOn(CollabSocket.prototype, "send").mockResolvedValue(true);
  const client = new GuestClient(link, "tester");
  client.applyFrameForTest({
    t: "welcome",
    proto: 3,
    header: { id: "sess-1" } as unknown as SessionHeader,
    state: { isStreaming: false, queuedMessageCount: 0, cwd: "", participants: [] },
    agents: [],
    entryCount: 0,
  });
  return client;
}

function renderComposer(client: GuestClient) {
  function Harness() {
    const [draft, setDraft] = React.useState("");
    return <Composer client={client} phase="live" readOnly={false} uiRequest={null} working={false} queuedMessageCount={0} draft={draft} onDraftChange={setDraft} />;
  }
  return render(<Harness />);
}

describe("R30-03: prompt recovery notice accumulation and cursor monotonicity", () => {
  it("recovers prompt on 0 prior notices → new error", async () => {
    const client = setupClient();
    const view = renderComposer(client);

    const textarea = view.getByPlaceholderText(/prompt the host agent/i) as HTMLTextAreaElement;
    fireEvent.change(textarea, { target: { value: "prompt zero" } });
    fireEvent.keyDown(textarea, { key: "Enter" });
    await waitFor(() => expect(textarea.value).toBe(""));

    const errorMsg = "prompting is unavailable until the host finishes starting up";
    client.applyFrameForTest({ t: "error", message: errorMsg });

    await waitFor(() => {
      expect(textarea.value).toBe("");
      expect(view.container.textContent).toContain("prompt zero");
    });
  });

  it("recovers prompt on 49 prior notices → new error (notice 50)", async () => {
    const client = setupClient();
    const view = renderComposer(client);

    for (let i = 1; i <= 49; i++) {
      client.applyFrameForTest({
        t: "event",
        event: { type: "notice", level: "info", message: `info ${i}` },
      });
    }
    expect(client.getSnapshot().notices.length).toBe(49);

    const textarea = view.getByPlaceholderText(/prompt the host agent/i) as HTMLTextAreaElement;
    fireEvent.change(textarea, { target: { value: "prompt 49" } });
    fireEvent.keyDown(textarea, { key: "Enter" });
    await waitFor(() => expect(textarea.value).toBe(""));

    const errorMsg = "prompting is unavailable until the host finishes starting up";
    client.applyFrameForTest({ t: "error", message: errorMsg });

    await waitFor(() => {
      expect(textarea.value).toBe("");
      expect(view.container.textContent).toContain("prompt 49");
    });
  });

  it("recovers prompt on 50 prior notices → new error (notice 51, window saturated)", async () => {
    const client = setupClient();
    const view = renderComposer(client);

    for (let i = 1; i <= 50; i++) {
      client.applyFrameForTest({
        t: "event",
        event: { type: "notice", level: "info", message: `info ${i}` },
      });
    }
    expect(client.getSnapshot().notices.length).toBe(50);

    const textarea = view.getByPlaceholderText(/prompt the host agent/i) as HTMLTextAreaElement;
    fireEvent.change(textarea, { target: { value: "prompt 50" } });
    fireEvent.keyDown(textarea, { key: "Enter" });
    await waitFor(() => expect(textarea.value).toBe(""));

    const errorMsg = "prompting is unavailable until the host finishes starting up";
    client.applyFrameForTest({ t: "error", message: errorMsg });

    await waitFor(() => {
      expect(textarea.value).toBe("");
      expect(view.container.textContent).toContain("prompt 50");
    });
  });

  it("recovers prompt after 100 consecutive notices", async () => {
    const client = setupClient();
    const view = renderComposer(client);

    for (let i = 1; i <= 100; i++) {
      client.applyFrameForTest({
        t: "event",
        event: { type: "notice", level: "info", message: `info ${i}` },
      });
    }

    const textarea = view.getByPlaceholderText(/prompt the host agent/i) as HTMLTextAreaElement;
    fireEvent.change(textarea, { target: { value: "prompt 100" } });
    fireEvent.keyDown(textarea, { key: "Enter" });
    await waitFor(() => expect(textarea.value).toBe(""));

    const errorMsg = "prompting is unavailable until the host finishes starting up";
    client.applyFrameForTest({ t: "error", message: errorMsg });

    await waitFor(() => {
      expect(textarea.value).toBe("");
      expect(view.container.textContent).toContain("prompt 100");
    });
  });

  it("handles multiple notices arriving before one React render", async () => {
    const client = setupClient();
    const view = renderComposer(client);

    const textarea = view.getByPlaceholderText(/prompt the host agent/i) as HTMLTextAreaElement;
    fireEvent.change(textarea, { target: { value: "multi notice prompt" } });
    fireEvent.keyDown(textarea, { key: "Enter" });
    await waitFor(() => expect(textarea.value).toBe(""));

    const errorMsg = "prompting is unavailable until the host finishes starting up";
    // Fire two notices synchronously before React processes
    client.applyFrameForTest({ t: "event", event: { type: "notice", level: "info", message: "background note" } });
    client.applyFrameForTest({ t: "error", message: errorMsg });

    await waitFor(() => {
      expect(textarea.value).toBe("");
      expect(view.container.textContent).toContain("multi notice prompt");
    });
  });

  it("handles error notice then info notice without losing error", async () => {
    const client = setupClient();
    const view = renderComposer(client);

    const textarea = view.getByPlaceholderText(/prompt the host agent/i) as HTMLTextAreaElement;
    fireEvent.change(textarea, { target: { value: "prompt error then info" } });
    fireEvent.keyDown(textarea, { key: "Enter" });
    await waitFor(() => expect(textarea.value).toBe(""));

    const errorMsg = "prompting is unavailable until the host finishes starting up";
    client.applyFrameForTest({ t: "error", message: errorMsg });
    client.applyFrameForTest({ t: "event", event: { type: "notice", level: "info", message: "subsequent info" } });

    await waitFor(() => {
      expect(textarea.value).toBe("");
      expect(view.container.textContent).toContain("prompt error then info");
    });
  });

  it("handles info notice then error notice", async () => {
    const client = setupClient();
    const view = renderComposer(client);

    const textarea = view.getByPlaceholderText(/prompt the host agent/i) as HTMLTextAreaElement;
    fireEvent.change(textarea, { target: { value: "prompt info then error" } });
    fireEvent.keyDown(textarea, { key: "Enter" });
    await waitFor(() => expect(textarea.value).toBe(""));

    const errorMsg = "prompting is unavailable until the host finishes starting up";
    client.applyFrameForTest({ t: "event", event: { type: "notice", level: "info", message: "preceding info" } });
    client.applyFrameForTest({ t: "error", message: errorMsg });

    await waitFor(() => {
      expect(textarea.value).toBe("");
      expect(view.container.textContent).toContain("prompt info then error");
    });
  });

  it("handles reconnect after notice saturation", async () => {
    const client = setupClient();
    const view = renderComposer(client);

    for (let i = 1; i <= 60; i++) {
      client.applyFrameForTest({
        t: "event",
        event: { type: "notice", level: "info", message: `info ${i}` },
      });
    }

    // Reconnect simulation: welcome frame
    client.applyFrameForTest({
      t: "welcome",
      proto: 3,
      header: { id: "sess-1" } as unknown as SessionHeader,
      state: { isStreaming: false, queuedMessageCount: 0, cwd: "", participants: [] },
      agents: [],
      entryCount: 0,
    });

    const textarea = view.getByPlaceholderText(/prompt the host agent/i) as HTMLTextAreaElement;
    fireEvent.change(textarea, { target: { value: "prompt after reconnect" } });
    fireEvent.keyDown(textarea, { key: "Enter" });
    await waitFor(() => expect(textarea.value).toBe(""));

    const errorMsg = "prompting is unavailable until the host finishes starting up";
    client.applyFrameForTest({ t: "error", message: errorMsg });

    await waitFor(() => {
      expect(textarea.value).toBe("");
      expect(view.container.textContent).toContain("prompt after reconnect");
    });
  });

  it("does not restore draft on unrelated error notice", async () => {
    const client = setupClient();
    const view = renderComposer(client);

    const textarea = view.getByPlaceholderText(/prompt the host agent/i) as HTMLTextAreaElement;
    fireEvent.change(textarea, { target: { value: "unrelated test prompt" } });
    fireEvent.keyDown(textarea, { key: "Enter" });
    await waitFor(() => expect(textarea.value).toBe(""));

    // Unrelated background error notice
    client.applyFrameForTest({ t: "error", message: "transcript socket failed" });

    // Wait short delay to ensure no restoration
    await new Promise((r) => setTimeout(r, 50));
    expect(textarea.value).toBe("");
    expect(view.queryByText("transcript socket failed")).toBeNull();
  });

  it("does not re-fire recovery for old notices when mounting late", async () => {
    const client = setupClient();
    // 60 notices accumulate BEFORE Composer mounts
    for (let i = 1; i <= 59; i++) {
      client.applyFrameForTest({
        t: "event",
        event: { type: "notice", level: "info", message: `old info ${i}` },
      });
    }
    client.applyFrameForTest({
      t: "error",
      message: "prompting is unavailable until the host finishes starting up",
    });

    // Composer mounts now
    const view = renderComposer(client);
    const textarea = view.getByPlaceholderText(/prompt the host agent/i) as HTMLTextAreaElement;
    expect(textarea.value).toBe("");
    expect(view.queryByText(/prompting is unavailable/i)).toBeNull();
  });
});

describe("R30-04: prompt recovery when user types meanwhile and adversarial scenarios", () => {
  it("keeps prompt A retrievable when user types B before rejection of A arrives", async () => {
    const client = setupClient();
    const view = renderComposer(client);

    const textarea = view.getByPlaceholderText(/prompt the host agent/i) as HTMLTextAreaElement;
    fireEvent.change(textarea, { target: { value: "prompt A that host will reject" } });
    fireEvent.keyDown(textarea, { key: "Enter" });
    await waitFor(() => expect(textarea.value).toBe(""));

    // User types B
    fireEvent.change(textarea, { target: { value: "typing draft B meanwhile" } });
    expect(textarea.value).toBe("typing draft B meanwhile");

    // Host rejects A
    const errorMsg = "prompting is unavailable until the host finishes starting up";
    client.applyFrameForTest({ t: "error", message: errorMsg });

    // Draft B must remain intact in textarea
    expect(textarea.value).toBe("typing draft B meanwhile");

    // Prompt A must be visible and retrievable in the DOM
    await waitFor(() => {
      expect(view.container.textContent).toContain("prompt A that host will reject");
    });

    // Test Recover button: user clicks Recover
    const recoverBtn = view.getByRole("button", { name: "Recover" });
    fireEvent.click(recoverBtn);
    // Draft B and prompt A are merged/restored
    expect(textarea.value).toContain("prompt A that host will reject");
    expect(textarea.value).toContain("typing draft B meanwhile");
  });

  it("allows user to inspect, copy, and dismiss unconfirmed prompt", async () => {
    const client = setupClient();
    const view = renderComposer(client);

    const textarea = view.getByPlaceholderText(/prompt the host agent/i) as HTMLTextAreaElement;
    fireEvent.change(textarea, { target: { value: "inspectable prompt A" } });
    fireEvent.keyDown(textarea, { key: "Enter" });
    await waitFor(() => expect(textarea.value).toBe(""));

    fireEvent.change(textarea, { target: { value: "draft B" } });

    // Host rejects A
    client.applyFrameForTest({
      t: "error",
      message: "prompting is unavailable until the host finishes starting up",
    });

    // Inspect: text is present in DOM
    expect(view.container.textContent).toContain("inspectable prompt A");

    // Copy: mock navigator.clipboard
    const writeTextMock = vi.fn().mockResolvedValue(undefined);
    Object.assign(navigator, {
      clipboard: { writeText: writeTextMock },
    });

    const copyBtn = view.getByRole("button", { name: "Copy" });
    fireEvent.click(copyBtn);
    expect(writeTextMock).toHaveBeenCalledWith("inspectable prompt A");

    // Dismiss: user clicks Dismiss
    const dismissBtn = view.getByRole("button", { name: "Dismiss" });
    fireEvent.click(dismissBtn);

    // Prompt A is dismissed from unconfirmed list
    await waitFor(() => {
      expect(view.queryByRole("button", { name: "Recover" })).toBeNull();
    });
    expect(client.getSnapshot().unconfirmedPrompts.length).toBe(0);
  });

  it("prefers the newest refused prompt when two refusals coexist", async () => {
    const client = setupClient();
    const view = renderComposer(client);

    const textarea = view.getByPlaceholderText(/prompt the host agent/i) as HTMLTextAreaElement;
    const refusal = "prompting is unavailable until the host finishes starting up";

    // Send A. While A is in flight the user types scratch text, so the refusal
    // cannot restore-and-dismiss A: it stays in the store as `refused`.
    fireEvent.change(textarea, { target: { value: "prompt A" } });
    fireEvent.keyDown(textarea, { key: "Enter" });
    await waitFor(() => expect(textarea.value).toBe(""));
    fireEvent.change(textarea, { target: { value: "scratch" } });
    client.applyFrameForTest({ t: "error", message: refusal });
    await waitFor(() => {
      expect(
        client.getSnapshot().unconfirmedPrompts.some(
          (p) => p.text === "prompt A" && p.status === "refused",
        ),
      ).toBe(true);
    });
    expect(textarea.value).toBe("scratch");

    // Empty the textarea so the second refusal takes the restore path.
    fireEvent.change(textarea, { target: { value: "" } });

    // Send B, then refuse it. Store now holds [A:refused, B:refused].
    fireEvent.change(textarea, { target: { value: "prompt B" } });
    fireEvent.keyDown(textarea, { key: "Enter" });
    await waitFor(() => expect(textarea.value).toBe(""));
    client.applyFrameForTest({ t: "error", message: refusal });

    expect(textarea.value).toBe("");
    expect(view.container.textContent).toContain("prompt B");

    // Nothing is lost: A is still retrievable in the store and the strip.
    const store = client.getSnapshot().unconfirmedPrompts;
    expect(store.some((p) => p.text === "prompt A" && p.status === "refused")).toBe(true);
    expect(view.container.textContent).toContain("prompt A");
  });

  it("send A → disconnect → reconnect keeps A retrievable", async () => {
    const client = setupClient();
    const view = renderComposer(client);

    const textarea = view.getByPlaceholderText(/prompt the host agent/i) as HTMLTextAreaElement;
    fireEvent.change(textarea, { target: { value: "unconfirmed across reconnect" } });
    fireEvent.keyDown(textarea, { key: "Enter" });
    await waitFor(() => expect(textarea.value).toBe(""));

    // Type something so it is not in textarea
    fireEvent.change(textarea, { target: { value: "new note" } });

    // Host reconnects with welcome frame (no entry for A)
    client.applyFrameForTest({
      t: "welcome",
      proto: 3,
      header: { id: "sess-2" } as unknown as SessionHeader,
      state: { isStreaming: false, queuedMessageCount: 0, cwd: "", participants: [] },
      agents: [],
      entryCount: 0,
    });

    // A must still be present and retrievable!
    expect(client.getSnapshot().unconfirmedPrompts.some((p) => p.text === "unconfirmed across reconnect")).toBe(true);
    expect(view.container.textContent).toContain("unconfirmed across reconnect");
  });

  it("send A → close guest keeps unconfirmed prompts in snapshot", async () => {
    const client = setupClient();
    const view = renderComposer(client);

    const textarea = view.getByPlaceholderText(/prompt the host agent/i) as HTMLTextAreaElement;
    fireEvent.change(textarea, { target: { value: "prompt before close" } });
    fireEvent.keyDown(textarea, { key: "Enter" });
    await waitFor(() => expect(textarea.value).toBe(""));

    client.close();
    client.applyFrameForTest({ t: "bye", reason: "user closed" });
    expect(client.getSnapshot().phase).toBe("ended");
    expect(client.getSnapshot().unconfirmedPrompts.some((p) => p.text === "prompt before close")).toBe(true);
  });

  it("send A → component unmount preserves prompt on client and restores on remount", async () => {
    const client = setupClient();

    const view1 = renderComposer(client);
    const textarea1 = view1.getByPlaceholderText(/prompt the host agent/i) as HTMLTextAreaElement;
    fireEvent.change(textarea1, { target: { value: "prompt surviving unmount" } });
    fireEvent.keyDown(textarea1, { key: "Enter" });
    await waitFor(() => expect(textarea1.value).toBe(""));

    // Unmount Composer
    view1.unmount();

    // Client still holds prompt
    expect(client.getSnapshot().unconfirmedPrompts.some((p) => p.text === "prompt surviving unmount")).toBe(true);

    // Remount Composer with same client
    const view2 = renderComposer(client);
    expect(view2.container.textContent).toContain("prompt surviving unmount");
  });

  it("send A → host confirms A via a genuine transcript event", async () => {
    const client = setupClient();
    const view = renderComposer(client);

    const textarea = view.getByPlaceholderText(/prompt the host agent/i) as HTMLTextAreaElement;
    fireEvent.change(textarea, { target: { value: "confirmed by entry" } });
    fireEvent.keyDown(textarea, { key: "Enter" });
    await waitFor(() => expect(textarea.value).toBe(""));

    expect(client.getSnapshot().unconfirmedPrompts.length).toBe(1);

    // Host sends message entry confirming "confirmed by entry"
    client.applyFrameForTest({
      t: "entry",
      entry: {
        type: "message",
        id: "msg-1",
        parentId: null,
        timestamp: new Date().toISOString(),
        message: {
          role: "user",
          content: "confirmed by entry",
          timestamp: Date.now(),
        },
      },
    });

    // Entry echo is non-destructive evidence, not proof of sender identity.
    await waitFor(() => {
      expect(client.getSnapshot().unconfirmedPrompts).toHaveLength(1);
      expect(client.getSnapshot().unconfirmedPrompts[0].status).toBe("echoed");
      expect(view.queryByRole("button", { name: "Recover" })).toBeNull();
      expect(view.getByRole("button", { name: "Copy" })).toBeTruthy();
      expect(view.getByRole("button", { name: "Dismiss" })).toBeTruthy();
    });
  });

  it("send A → host streaming does not falsely confirm A without transcript entry", async () => {
    const client = setupClient();
    const view = renderComposer(client);

    const textarea = view.getByPlaceholderText(/prompt the host agent/i) as HTMLTextAreaElement;
    fireEvent.change(textarea, { target: { value: "not confirmed merely by stream" } });
    fireEvent.keyDown(textarea, { key: "Enter" });
    await waitFor(() => expect(textarea.value).toBe(""));

    expect(client.getSnapshot().unconfirmedPrompts.length).toBe(1);

    // Host emits state with isStreaming: true
    client.applyFrameForTest({
      t: "state",
      state: { isStreaming: true, queuedMessageCount: 0, cwd: "", participants: [] },
    });

    // A must STILL be unconfirmed (streaming is not proof of acceptance)
    expect(client.getSnapshot().unconfirmedPrompts.length).toBe(1);

    // Only when genuine transcript entry arrives does A confirm
    client.applyFrameForTest({
      t: "entry",
      entry: {
        type: "message",
        id: "msg-stream-1",
        parentId: null,
        timestamp: new Date().toISOString(),
        message: {
          role: "user",
          content: "not confirmed merely by stream",
          timestamp: Date.now(),
        },
      },
    });
    expect(client.getSnapshot().unconfirmedPrompts[0].status).toBe("echoed");
  });

  it("send A → send result resolves after a newer draft was entered", async () => {
    let resolveSend!: (v: boolean) => void;
    const client = setupClient();
    vi.spyOn(CollabSocket.prototype, "send").mockImplementation(
      () =>
        new Promise<boolean>((r) => {
          resolveSend = r;
        }),
    );
    const view = renderComposer(client);
    const textarea = view.getByPlaceholderText(/prompt the host agent/i) as HTMLTextAreaElement;
    fireEvent.change(textarea, { target: { value: "in-flight prompt" } });
    fireEvent.keyDown(textarea, { key: "Enter" });

    // User types newer text while send is pending
    fireEvent.change(textarea, { target: { value: "newer draft entered while in-flight" } });

    // Send resolves true
    await act(async () => {
      resolveSend(true);
    });

    // Newer draft is NOT cleared
    expect(textarea.value).toBe("newer draft entered while in-flight");

    // In-flight prompt is tracked in unconfirmed list
    expect(client.getSnapshot().unconfirmedPrompts.some((p) => p.text === "in-flight prompt")).toBe(true);
    expect(view.container.textContent).toContain("in-flight prompt");
  });

  it("rapid Enter / double-click sends only once", async () => {
    let resolveSend!: (v: boolean) => void;
    const client = setupClient();
    const spy = vi.spyOn(client, "sendPrompt");
    vi.spyOn(CollabSocket.prototype, "send").mockImplementation(
      () =>
        new Promise<boolean>((r) => {
          resolveSend = r;
        }),
    );
    const view = renderComposer(client);
    const textarea = view.getByPlaceholderText(/prompt the host agent/i) as HTMLTextAreaElement;
    fireEvent.change(textarea, { target: { value: "single submission" } });

    // Press Enter twice rapidly
    fireEvent.keyDown(textarea, { key: "Enter" });
    fireEvent.keyDown(textarea, { key: "Enter" });

    expect(spy).toHaveBeenCalledTimes(1);

    await act(async () => {
      resolveSend(true);
    });
  });

  it("preserves queued prompt when state frames arrive during streaming turn and connection drops before flush", async () => {
    const client = setupClient();
    // Host is currently streaming turn T
    client.applyFrameForTest({
      t: "state",
      state: { isStreaming: true, queuedMessageCount: 0, cwd: "", participants: [] },
    });

    const view = renderComposer(client);

    const textarea = view.getByPlaceholderText(/prompt the host agent/i) as HTMLTextAreaElement;
    fireEvent.change(textarea, { target: { value: "queued prompt while turn in flight" } });
    fireEvent.keyDown(textarea, { key: "Enter" });
    await waitFor(() => expect(textarea.value).toBe(""));

    // Host sends another state frame for turn T (still streaming)
    client.applyFrameForTest({
      t: "state",
      state: { isStreaming: true, queuedMessageCount: 1, cwd: "", participants: [] },
    });

    // Connection drops before host accepts or echoes the queued prompt
    client.applyFrameForTest({ t: "bye", reason: "connection lost" });

    // Prompt A must STILL be retrievable on client!
    expect(
      client.getSnapshot().unconfirmedPrompts.some((p) => p.text === "queued prompt while turn in flight"),
    ).toBe(true);
  });

  it("refuses the send before dispatch at capacity without evicting any recovery record", async () => {
    const client = setupClient();
    const send = vi.spyOn(CollabSocket.prototype, "send");
    for (let i = 1; i <= 256; i++) {
      const prompt = client.recordPrompt(`prompt submission ${i}`);
      client.markPromptRefused(prompt.id, "refused");
    }
    const before = client.getSnapshot().unconfirmedPrompts.map((p) => p.id);
    expect(client.recordPrompt("prompt submission 257").id).toBe(0);
    expect(client.getSnapshot().unconfirmedPrompts.map((p) => p.id)).toEqual(before);
    expect(send).not.toHaveBeenCalled();
    expect(client.getSnapshot().notices.at(-1)?.message).toContain("Recovery limit reached (256)");
  });

  it("Defect 1 fail-before: consecutive identical prompts create independent records and are confirmed individually", async () => {
    const client = setupClient();
    const view = renderComposer(client);

    const textarea = view.getByPlaceholderText(/prompt the host agent/i) as HTMLTextAreaElement;

    // Send "continue" 1st time
    fireEvent.change(textarea, { target: { value: "continue" } });
    fireEvent.keyDown(textarea, { key: "Enter" });
    await waitFor(() => expect(textarea.value).toBe(""));

    // Send "continue" 2nd time
    fireEvent.change(textarea, { target: { value: "continue" } });
    fireEvent.keyDown(textarea, { key: "Enter" });
    await waitFor(() => expect(textarea.value).toBe(""));

    // Must have 2 distinct records
    expect(client.getSnapshot().unconfirmedPrompts.length).toBe(2);

    // Host confirms the first "continue"
    client.applyFrameForTest({
      t: "entry",
      entry: {
        type: "message",
        id: "msg-cont-1",
        parentId: null,
        timestamp: new Date().toISOString(),
        message: { role: "user", content: "continue", timestamp: Date.now() },
      },
    });

    // First echo settles one record; second identical attempt remains inspectable.
    expect(client.getSnapshot().unconfirmedPrompts).toHaveLength(2);
    expect(client.getSnapshot().unconfirmedPrompts.filter(p => p.status === "echoed")).toHaveLength(1);
  });

  it("Defect 3 fail-before: offline prompts beyond 50 are not evicted while held in socket queue", async () => {
    const client = setupClient();
    // Send 60 prompts while offline
    for (let i = 1; i <= 60; i++) {
      client.recordPrompt(`offline prompt ${i}`);
    }
    // On current code with MAX_UNCONFIRMED_PROMPTS = 50, prompt 1 is evicted
    expect(client.getSnapshot().unconfirmedPrompts.some((p) => p.text === "offline prompt 1")).toBe(true);
  });

  it("Defect 5 fail-before: Recover appended to non-empty draft does not discard record from client store", async () => {
    const client = setupClient();
    const view = renderComposer(client);

    const textarea = view.getByPlaceholderText(/prompt the host agent/i) as HTMLTextAreaElement;
    fireEvent.change(textarea, { target: { value: "recoverable prompt" } });
    fireEvent.keyDown(textarea, { key: "Enter" });
    await waitFor(() => expect(textarea.value).toBe(""));

    // Type non-empty draft into textarea
    fireEvent.change(textarea, { target: { value: "existing draft" } });

    // Host rejects
    client.applyFrameForTest({
      t: "error",
      message: "prompting is unavailable until the host finishes starting up",
    });

    // User clicks Recover
    const recoverBtn = view.getByRole("button", { name: "Recover" });
    fireEvent.click(recoverBtn);

    expect(textarea.value).toBe("existing draft\nrecoverable prompt");

    // Prompt must NOT be discarded from store when appended to non-empty text
    expect(client.getSnapshot().unconfirmedPrompts.some((p) => p.text === "recoverable prompt")).toBe(true);
  });

  it("historical snapshot with same text cannot confirm an unresolved send", () => {
    const client = setupClient();
    client.recordPrompt("continue");
    client.applyFrameForTest({
      t: "welcome",
      proto: 3,
      header: { id: "sess-2" } as unknown as SessionHeader,
      state: { isStreaming: false, queuedMessageCount: 0, cwd: "", participants: [] },
      agents: [],
      entryCount: 1,
    });
    client.applyFrameForTest({
      t: "snapshot-chunk",
      entries: [{
        type: "message", id: "old", parentId: null, timestamp: new Date().toISOString(),
        message: { role: "user", content: "continue", timestamp: Date.now() },
      }],
      final: true,
    });
    expect(client.getSnapshot().unconfirmedPrompts.map((p) => p.text)).toEqual(["continue"]);
  });

  it("does not guess which prompt an uncorrelated refusal belongs to", () => {
    const client = setupClient();
    client.recordPrompt("A");
    client.recordPrompt("B");
    client.applyFrameForTest({ t: "error", message: "Prompt was not submitted. Please resend it when the host is ready." });
    expect(client.getSnapshot().unconfirmedPrompts.map((p) => p.status)).toEqual(["queued_local", "queued_local"]);
  });

  it("keeps recovery activation idempotent when draft already contains restored text", async () => {
    const client = setupClient();
    const view = renderComposer(client);
    const textarea = view.getByPlaceholderText(/prompt the host agent/i) as HTMLTextAreaElement;
    fireEvent.change(textarea, { target: { value: "recover me" } });
    fireEvent.keyDown(textarea, { key: "Enter" });
    await waitFor(() => expect(textarea.value).toBe(""));
    client.applyFrameForTest({ t: "error", message: "Prompt was not submitted. Please resend it when the host is ready." });
    fireEvent.change(textarea, { target: { value: "draft" } });
    const recover = view.getAllByRole("button", { name: "Recover" })[0];
    fireEvent.click(recover);
    fireEvent.click(recover);
    expect(textarea.value).toBe("draft\nrecover me");
  });

  it("leaves multiple same-connection prompts unconfirmed on session-switch bye", () => {
    const client = setupClient();
    client.recordPrompt("prompt A");
    client.recordPrompt("prompt B");
    const byeReason = "session switched; prompts not shown in the conversation were not submitted. Rejoin and resend them";
    client.applyFrameForTest({ t: "bye", reason: byeReason });
    expect(client.getSnapshot().unconfirmedPrompts.map((p) => p.status)).toEqual(["queued_local", "queued_local"]);
    expect(client.getSnapshot().endedReason).toBe(byeReason);
  });
});

describe("prompt recovery ended interactions and client replacement", () => {
  it("keeps Recover, Copy, Dismiss reachable inside ended dialog by pointer and keyboard", async () => {
    const client = setupClient();
    const recovered = client.recordPrompt("recover ended prompt");
    const dismissed = client.recordPrompt("dismiss ended prompt");
    client.applyFrameForTest({ t: "bye", reason: "ended" });
    render(<Banners phase="ended" endedReason="ended" loading={null} client={client} readOnly={false} draft="" onDraftChange={() => {}} onRejoin={vi.fn()} onNewLink={vi.fn()} />);
    const dialog = screen.getByRole("alertdialog", { name: "session ended" });
    expect(dialog).toBeTruthy();
    const recover = screen.getAllByRole("button", { name: "Recover" })[0];
    recover.focus();
    expect(document.activeElement).toBe(recover);
    fireEvent.keyDown(recover, { key: "Enter" });
    fireEvent.click(recover);
    expect(client.getSnapshot().unconfirmedPrompts.find(p => p.id === recovered.id)?.status).toBe("recovered");
    const copy = screen.getAllByRole("button", { name: "Copy" })[0];
    fireEvent.click(copy);
    expect(screen.getAllByRole("button", { name: "Dismiss" })).toHaveLength(1);
    fireEvent.click(screen.getAllByRole("button", { name: "Dismiss" })[0]);
    expect(client.getSnapshot().unconfirmedPrompts.some(p => p.id === dismissed.id)).toBe(false);
  });

  it("keeps original room/session records and fences old-client late echo", () => {
    const store = new PromptRecoveryStore();
    const callbacks: Array<(frame: never) => void> = [];
    vi.spyOn(CollabSocket.prototype, "connect").mockImplementation(function (this: CollabSocket) {
      callbacks.push(this.onFrame as (frame: never) => void);
    });
    const first = new GuestClient(link, "tester", store);
    first.connect();
    callbacks[0]({ t: "welcome", proto: 3, header: { id: "old-session" }, state: { isStreaming: false, queuedMessageCount: 0, cwd: "", participants: [] }, agents: [], entryCount: 0 } as never);
    const attempt = first.recordPrompt("old-room prompt");
    const otherLink = "wss://example.com/r/CCCCCCCCCCCCCCCC." + "D".repeat(43);
    const replacement = new GuestClient(otherLink, "tester", store);
    replacement.connect();
    callbacks[1]({ t: "welcome", proto: 3, header: { id: "new-session" }, state: { isStreaming: false, queuedMessageCount: 0, cwd: "", participants: [] }, agents: [], entryCount: 0 } as never);
    const newer = replacement.recordPrompt("new-room prompt");
    callbacks[0]({ t: "entry", entry: { type: "message", id: "late", parentId: null, timestamp: new Date().toISOString(), message: { role: "user", content: "new-room prompt", timestamp: Date.now() } } } as never);
    expect(replacement.getSnapshot().unconfirmedPrompts.find(p => p.id === attempt.id)).toMatchObject({ roomId: "AAAAAAAAAAAAAAAA", sessionId: "old-session", status: "queued_local" });
    expect(replacement.getSnapshot().unconfirmedPrompts.find(p => p.id === newer.id)).toMatchObject({ roomId: "CCCCCCCCCCCCCCCC", sessionId: "new-session", status: "queued_local" });
    expect(store.records.get(newer.id)).toMatchObject({ status: "queued_local", roomId: "CCCCCCCCCCCCCCCC" });
  });

  it("live echo in one room cannot delete another room's same-text recovery record", () => {
    const store = new PromptRecoveryStore();
    const roomA = new GuestClient(link, "tester", store);
    roomA.applyFrameForTest({ t: "welcome", proto: 3, header: { id: "a" } as unknown as SessionHeader, state: { isStreaming: false, queuedMessageCount: 0, cwd: "", participants: [] }, agents: [], entryCount: 0 });
    const attemptA = roomA.recordPrompt("continue");
    const roomBLink = "wss://example.com/r/CCCCCCCCCCCCCCCC." + "D".repeat(43);
    const roomB = new GuestClient(roomBLink, "tester", store);
    roomB.applyFrameForTest({ t: "welcome", proto: 3, header: { id: "b" } as unknown as SessionHeader, state: { isStreaming: false, queuedMessageCount: 0, cwd: "", participants: [] }, agents: [], entryCount: 0 });
    const attemptB = roomB.recordPrompt("continue");
    roomB.applyFrameForTest({ t: "entry", entry: { type: "message", id: "echo", parentId: null, timestamp: new Date().toISOString(), message: { role: "user", content: "continue", timestamp: Date.now() } } });
    expect(store.records.get(attemptA.id)).toMatchObject({ roomId: "AAAAAAAAAAAAAAAA", status: "queued_local" });
    expect(store.records.get(attemptB.id)).toMatchObject({ status: "echoed" });
  });

  it("preserves unresolved record across Rejoin success, failed Rejoin and repeated replacement", () => {
    const store = new PromptRecoveryStore();
    const first = new GuestClient(link, "tester", store);
    first.applyFrameForTest({ t: "welcome", proto: 3, header: { id: "session-A" } as unknown as SessionHeader, state: { isStreaming: false, queuedMessageCount: 0, cwd: "", participants: [] }, agents: [], entryCount: 0 });
    const attempt = first.recordPrompt("survives rejoin");
    const rejoin = () => {
      const client = new GuestClient(link, "tester", store);
      client.applyFrameForTest({ t: "welcome", proto: 3, header: { id: "session-A" } as unknown as SessionHeader, state: { isStreaming: false, queuedMessageCount: 0, cwd: "", participants: [] }, agents: [], entryCount: 0 });
      return client;
    };
    const success = rejoin();
    const failed = rejoin();
    failed.applyFrameForTest({ t: "error", message: "rejoin failed" });
    const repeated = rejoin();
    expect(repeated.getSnapshot().unconfirmedPrompts.filter(p => p.id === attempt.id)).toHaveLength(1);
    expect(repeated.getSnapshot().unconfirmedPrompts[0]).toMatchObject({ roomId: attempt.roomId, sessionId: "session-A" });
    expect(success.getSnapshot().unconfirmedPrompts.some(p => p.id === attempt.id)).toBe(true);
  });

  it("orders ended controls inside scrollable named dialog", () => {
    const client = setupClient();
    client.recordPrompt("tab order prompt");
    client.applyFrameForTest({ t: "bye", reason: "ended" });
    const { container } = render(<Banners phase="ended" endedReason="ended" loading={null} client={client} readOnly={false} draft="" onDraftChange={() => {}} onRejoin={vi.fn()} onNewLink={vi.fn()} />);
    const dialog = screen.getByRole("alertdialog", { name: "session ended" });
    const controls = ["Recover", "Copy", "Dismiss", "Rejoin", "New link"].map(name => screen.getByRole("button", { name }));
    const positions = controls.map(el => [...dialog.querySelectorAll("button")].indexOf(el));
    expect(positions.every((index, position) => position === 0 || positions[position - 1] < index)).toBe(true);
    const overlay = container.querySelector(".sh-ended")!;
    expect(overlay.className).toContain("sh-ended");
    expect(overlay.firstElementChild?.className).toContain("sh-ended-card");
  });

  it("hides a recovered record's Recover control even when draft no longer contains its text", () => {
    const client = setupClient();
    const prompt = client.recordPrompt("restored once");
    client.markPromptRecovered(prompt.id);
    renderComposer(client);
    expect(screen.queryByRole("button", { name: "Recover" })).toBeNull();
    expect(screen.queryByText("restored once")).toBeNull();
    expect(document.querySelector(".sh-recoverable-prompts")).toBeNull();
  });

  it("recovery stays single-insert after repeated activation and reopens after edit removes text", async () => {
    const client = setupClient();
    const prompt = client.recordPrompt("restored once");
    renderComposer(client);
    const textarea = screen.getByRole("textbox") as HTMLTextAreaElement;
    fireEvent.change(textarea, { target: { value: "existing draft" } });
    const recover = screen.getByRole("button", { name: "Recover" });
    act(() => {
      fireEvent.click(recover);
      fireEvent.click(recover);
    });
    expect(textarea.value).toBe("existing draft\nrestored once");
    expect(textarea.value.split("restored once")).toHaveLength(2);
    expect(client.getSnapshot().unconfirmedPrompts.find(p => p.id === prompt.id)?.status).toBe("recovered");
    expect(client.getSnapshot().unconfirmedPrompts.some(p => p.id === prompt.id)).toBe(true);
    fireEvent.change(textarea, { target: { value: "existing draft" } });
    expect(client.getSnapshot().unconfirmedPrompts.find(p => p.id === prompt.id)?.status).toBe("unconfirmed");
    expect(screen.getByRole("button", { name: "Recover" })).toBeTruthy();
  });

  it("makes Recover available again when restored bug changes to debug", () => {
    const client = setupClient();
    const prompt = client.recordPrompt("bug");
    renderComposer(client);
    const textarea = screen.getByRole("textbox");
    fireEvent.click(screen.getByRole("button", { name: "Recover" }));
    expect(client.getSnapshot().unconfirmedPrompts.find(p => p.id === prompt.id)?.status).toBe("recovered");
    fireEvent.change(textarea, { target: { value: "debug" } });
    expect(client.getSnapshot().unconfirmedPrompts.find(p => p.id === prompt.id)?.status).toBe("unconfirmed");
    expect(screen.getByRole("button", { name: "Recover" })).toBeTruthy();
  });

  it("retains prompt and shows manual-copy message when clipboard is unavailable", async () => {
    const client = setupClient();
    const prompt = client.recordPrompt("copy this manually");
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText: vi.fn().mockRejectedValue(new Error("clipboard denied")) } });
    render(<Banners phase="ended" endedReason="ended" loading={null} client={client} readOnly={false} draft="" onDraftChange={() => {}} onRejoin={vi.fn()} onNewLink={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: "Copy" }));
    expect((await screen.findByText(/Clipboard unavailable; select and copy prompt text manually/)).textContent).toContain("Clipboard unavailable; select and copy prompt text manually.");
    expect(client.getSnapshot().unconfirmedPrompts.some(p => p.id === prompt.id)).toBe(true);
  });
});

describe("App prompt recovery lifecycle integration", () => {
  it("retains one originating record through successful, failed, repeated and cross-room replacement", async () => {
    const clients: GuestClient[] = [];
    vi.spyOn(CollabSocket.prototype, "send").mockResolvedValue(true);
    const connect = vi.spyOn(GuestClient.prototype, "connect").mockImplementation(function (this: GuestClient) {
      clients.push(this);
    });
    window.history.replaceState(null, "", `${window.location.pathname}#${link}`);
    render(<App />);
    await waitFor(() => expect(clients).toHaveLength(1));
    const original = clients[0];
    act(() => original.applyFrameForTest({ t: "welcome", proto: 3, header: { id: "session-A" } as unknown as SessionHeader, state: { isStreaming: false, queuedMessageCount: 0, cwd: "", participants: [] }, agents: [], entryCount: 0 }));
    const prompt = original.recordPrompt("origin record");
    act(() => original.applyFrameForTest({ t: "bye", reason: "ended" }));
    fireEvent.click(screen.getByRole("button", { name: "Rejoin" }));
    await waitFor(() => expect(clients).toHaveLength(2));
    expect(clients[1].getSnapshot().unconfirmedPrompts.filter(p => p.id === prompt.id)).toHaveLength(1);
    expect(clients[1].getSnapshot().unconfirmedPrompts[0]).toMatchObject({ roomId: "AAAAAAAAAAAAAAAA", sessionId: "session-A" });
    act(() => clients[1].applyFrameForTest({ t: "bye", reason: "ended" }));
    connect.mockImplementationOnce(function (this: GuestClient) {
      clients.push(this);
      throw new Error("socket unavailable");
    });
    fireEvent.click(screen.getByRole("button", { name: "Rejoin" }));
    expect(screen.getByRole("alert").textContent).toContain("socket unavailable");
    expect(clients[1].getSnapshot().unconfirmedPrompts.find(p => p.id === prompt.id)).toMatchObject({ roomId: "AAAAAAAAAAAAAAAA", sessionId: "session-A" });
    const failedAttempt = clients[1].recordPrompt("old client still active");
    clients[1].dismissPrompt(failedAttempt.id);
    expect(clients[1].getSnapshot().unconfirmedPrompts.some(p => p.id === failedAttempt.id)).toBe(false);
    connect.mockImplementation(function (this: GuestClient) { clients.push(this); });
    fireEvent.click(screen.getByRole("button", { name: "Rejoin" }));
    await waitFor(() => expect(clients).toHaveLength(4));
    expect(clients[3].getSnapshot().unconfirmedPrompts.filter(p => p.id === prompt.id)).toHaveLength(1);
    expect(screen.queryByRole("alert")).toBeNull();
    act(() => clients[3].applyFrameForTest({ t: "bye", reason: "ended" }));
    fireEvent.click(screen.getByRole("button", { name: "New link" }));
    const linkInput = screen.getByPlaceholderText("ws://host:port/r/room.key");
    const otherLink = "wss://example.com/r/CCCCCCCCCCCCCCCC." + "D".repeat(43);
    fireEvent.change(linkInput, { target: { value: otherLink } });
    fireEvent.click(screen.getByRole("button", { name: /Connect/ }));
    await waitFor(() => expect(clients).toHaveLength(5));
    expect(clients[4].getSnapshot().unconfirmedPrompts.find(p => p.id === prompt.id)).toMatchObject({ roomId: "AAAAAAAAAAAAAAAA", sessionId: "session-A" });
    expect(clients[4].getSnapshot().phase).toBe("connecting");
    expect(screen.queryByText("origin record")).toBeNull();
    expect(connect).toHaveBeenCalledTimes(5);
  });

  it("keeps overlay-recovered prompt reachable after Rejoin unmounts its draft", async () => {
    const clients: GuestClient[] = [];
    vi.spyOn(CollabSocket.prototype, "send").mockResolvedValue(true);
    vi.spyOn(GuestClient.prototype, "connect").mockImplementation(function (this: GuestClient) { clients.push(this); });
    window.history.replaceState(null, "", `${window.location.pathname}#${link}`);
    render(<App />);
    await waitFor(() => expect(clients).toHaveLength(1));
    const original = clients[0];
    act(() => original.applyFrameForTest({ t: "welcome", proto: 3, header: { id: "overlay-session" } as unknown as SessionHeader, state: { isStreaming: false, queuedMessageCount: 0, cwd: "", participants: [] }, agents: [], entryCount: 0 }));
    const prompt = original.recordPrompt("recover through overlay");
    act(() => original.applyFrameForTest({ t: "bye", reason: "ended" }));
    fireEvent.click(within(screen.getByRole("alertdialog", { name: "session ended" })).getByRole("button", { name: "Recover" }));
    expect(original.getSnapshot().unconfirmedPrompts.find(p => p.id === prompt.id)?.status).toBe("recovered");
    fireEvent.click(screen.getByRole("button", { name: "Rejoin" }));
    await waitFor(() => expect(clients).toHaveLength(2));
    expect(clients[1].getSnapshot().unconfirmedPrompts.find(p => p.id === prompt.id)?.status).toBe("recovered");
    expect((screen.getByRole("textbox") as HTMLTextAreaElement).value).toBe("recover through overlay");
  });
});
