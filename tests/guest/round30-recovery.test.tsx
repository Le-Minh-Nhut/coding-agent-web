// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import type { SessionHeader } from "@oh-my-pi/pi-wire";
import { Composer } from "../../packages/guest/src/components/shell/Composer";
import { GuestClient } from "../../packages/guest/src/lib/client";
import { CollabSocket } from "../../packages/guest/src/lib/socket";

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
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
  return render(
    <Composer
      client={client}
      phase="live"
      readOnly={false}
      uiRequest={null}
      working={false}
      queuedMessageCount={0}
    />,
  );
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
      expect(textarea.value).toBe("prompt zero");
      expect(view.getByText(errorMsg)).toBeTruthy();
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
      expect(textarea.value).toBe("prompt 49");
      expect(view.getByText(errorMsg)).toBeTruthy();
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
      expect(textarea.value).toBe("prompt 50");
      expect(view.getByText(errorMsg)).toBeTruthy();
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
      expect(textarea.value).toBe("prompt 100");
      expect(view.getByText(errorMsg)).toBeTruthy();
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
      expect(textarea.value).toBe("multi notice prompt");
      expect(view.getByText(errorMsg)).toBeTruthy();
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
      expect(textarea.value).toBe("prompt error then info");
      expect(view.getByText(errorMsg)).toBeTruthy();
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
      expect(textarea.value).toBe("prompt info then error");
      expect(view.getByText(errorMsg)).toBeTruthy();
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
      expect(textarea.value).toBe("prompt after reconnect");
      expect(view.getByText(errorMsg)).toBeTruthy();
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

    // The newest refusal (B) must be restored, not the older A.
    await waitFor(() => expect(textarea.value).toBe("prompt B"));

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

    // Prompt is now confirmed and removed from unconfirmed list
    await waitFor(() => {
      expect(client.getSnapshot().unconfirmedPrompts.length).toBe(0);
      expect(view.queryByRole("button", { name: "Recover" })).toBeNull();
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
    expect(client.getSnapshot().unconfirmedPrompts.length).toBe(0);
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

  it("caps unconfirmed prompts at MAX_UNCONFIRMED_PROMPTS (256) via FIFO eviction of refused entries", async () => {
    const client = setupClient();
    // Record 260 prompts, where first 10 were refused
    for (let i = 1; i <= 260; i++) {
      const p = client.recordPrompt(`prompt submission ${i}`);
      if (i <= 10) client.markPromptRefused(p.id, "refused");
    }
    const unconfirmed = client.getSnapshot().unconfirmedPrompts;
    expect(unconfirmed.length).toBe(256);
    // Oldest 4 refused evicted
    expect(unconfirmed.some((p) => p.text === "prompt submission 1")).toBe(false);
    expect(unconfirmed.some((p) => p.text === "prompt submission 260")).toBe(true);
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

    // Only ONE record should be confirmed; second "continue" MUST still be unconfirmed!
    expect(client.getSnapshot().unconfirmedPrompts.length).toBe(1);
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

  it("marks prompt refused when host stops with session switched bye frame", async () => {
    const client = setupClient();
    const view = renderComposer(client);

    const textarea = view.getByPlaceholderText(/prompt the host agent/i) as HTMLTextAreaElement;
    fireEvent.change(textarea, { target: { value: "prompt before session switch" } });
    fireEvent.keyDown(textarea, { key: "Enter" });
    await waitFor(() => expect(textarea.value).toBe(""));

    const byeReason = "session switched; prompts not shown in the conversation were not submitted. Rejoin and resend them";
    client.applyFrameForTest({ t: "bye", reason: byeReason });

    const p = client.getSnapshot().unconfirmedPrompts.find((item) => item.text === "prompt before session switch");
    expect(p?.status).toBe("refused");
    expect(p?.error).toBe(byeReason);
  });
});
