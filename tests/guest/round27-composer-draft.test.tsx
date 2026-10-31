// @vitest-environment jsdom
/**
 * F13: the composer must not destroy the user's draft before delivery is known.
 *
 * `sendPrompt` reports whether the frame was handed to the socket or queued. A
 * refused send (socket closed, connection ended, queue full) leaves the draft in
 * the box and says so, instead of silently losing typed input.
 */
import { describe, expect, it, vi } from "vitest";
import { render, fireEvent, act } from "@testing-library/react";
import { Composer } from "../../packages/guest/src/components/shell/Composer";
import type { GuestClient } from "../../packages/guest/src/lib/client";

function stubClient(
  sendPrompt: (text: string) => boolean | Promise<boolean>,
): GuestClient {
  return {
    sendPrompt,
    sendUiResponse: vi.fn(),
    sendAbort: vi.fn(),
  } as unknown as GuestClient;
}

function composer(client: GuestClient) {
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

function typeDraft(container: HTMLElement, text: string): HTMLTextAreaElement {
  const input = container.querySelector("textarea");
  if (!input) throw new Error("composer textarea missing");
  fireEvent.change(input, { target: { value: text } });
  return input;
}

describe("guest composer draft retention (F13)", () => {
  it("keeps the draft when the send is refused", async () => {
    const client = stubClient(async () => false);
    const { container } = composer(client);
    const input = typeDraft(container, "important prompt");
    fireEvent.keyDown(input, { key: "Enter" });

    await vi.waitFor(() =>
      expect(container.textContent).toMatch(/not sent|failed|try again/i),
    );
    expect((container.querySelector("textarea") as HTMLTextAreaElement).value).toBe(
      "important prompt",
    );
  });

  it("clears the draft once the send is accepted or queued", async () => {
    const client = stubClient(async () => true);
    const { container } = composer(client);
    const input = typeDraft(container, "delivered prompt");
    fireEvent.keyDown(input, { key: "Enter" });

    await vi.waitFor(() =>
      expect((container.querySelector("textarea") as HTMLTextAreaElement).value).toBe(
        "",
      ),
    );
  });

  it("accepts a synchronous boolean from the client without losing the draft", async () => {
    const client = stubClient(() => false);
    const { container } = composer(client);
    const input = typeDraft(container, "sync refusal");
    fireEvent.keyDown(input, { key: "Enter" });

    await vi.waitFor(() =>
      expect((container.querySelector("textarea") as HTMLTextAreaElement).value).toBe(
        "sync refusal",
      ),
    );
  });

  it("does not clear text typed while a queued send was still awaiting its flush", async () => {
    // A frame queued behind the handshake resolves `true` only once it reaches the
    // wire, which can be well after the user has typed something new: that newer
    // draft must survive the late acceptance.
    let settle!: (value: boolean) => void;
    const pending = new Promise<boolean>((resolve) => {
      settle = resolve;
    });
    const client = stubClient(() => pending);
    const { container } = composer(client);
    const input = typeDraft(container, "first prompt");
    fireEvent.keyDown(input, { key: "Enter" });

    typeDraft(container, "second draft typed meanwhile");
    // Resolve and drain the acceptance callback plus its React commit before asserting.
    await act(async () => {
      settle(true);
      await pending;
    });

    expect((container.querySelector("textarea") as HTMLTextAreaElement).value).toBe(
      "second draft typed meanwhile",
    );
  });

  it("sends exactly one prompt when Enter is pressed twice before the send settles", async () => {
    // Retaining the draft until delivery is known means `canSend` stays true for the
    // whole round trip. Without a re-entry guard the second press queues the same
    // prompt again — the commit path must make the second press a no-op instead.
    let settle!: (value: boolean) => void;
    const pending = new Promise<boolean>((resolve) => {
      settle = resolve;
    });
    const sendPrompt = vi.fn(() => pending);
    const client = stubClient(sendPrompt);
    const { container } = composer(client);
    const input = typeDraft(container, "hello");

    fireEvent.keyDown(input, { key: "Enter" });
    fireEvent.keyDown(input, { key: "Enter" });

    expect(sendPrompt).toHaveBeenCalledTimes(1);
    expect((container.querySelector("textarea") as HTMLTextAreaElement).value).toBe("hello");

    // The normal clear contract still holds once the send settles.
    await act(async () => {
      settle(true);
      await pending;
    });
    expect((container.querySelector("textarea") as HTMLTextAreaElement).value).toBe("");
  });

  it("ignores the Send control while a prompt is already in flight", async () => {
    let settle!: (value: boolean) => void;
    const pending = new Promise<boolean>((resolve) => {
      settle = resolve;
    });
    const sendPrompt = vi.fn(() => pending);
    const client = stubClient(sendPrompt);
    const { container } = composer(client);
    const input = typeDraft(container, "one shot");

    fireEvent.keyDown(input, { key: "Enter" });
    fireEvent.click(container.querySelector("button")!);

    expect(sendPrompt).toHaveBeenCalledTimes(1);

    await act(async () => {
      settle(false);
      await pending;
    });
    // Refused: the draft survives and the guard is released for a retry.
    expect((container.querySelector("textarea") as HTMLTextAreaElement).value).toBe("one shot");
    fireEvent.keyDown(input, { key: "Enter" });
    expect(sendPrompt).toHaveBeenCalledTimes(2);
  });

  it("clears the sent text when nothing was typed since", async () => {
    let settle!: (value: boolean) => void;
    const pending = new Promise<boolean>((resolve) => {
      settle = resolve;
    });
    const client = stubClient(() => pending);
    const { container } = composer(client);
    const input = typeDraft(container, "queued prompt");
    fireEvent.keyDown(input, { key: "Enter" });

    settle(true);
    await vi.waitFor(() =>
      expect((container.querySelector("textarea") as HTMLTextAreaElement).value).toBe(""),
    );
  });
});
