// @vitest-environment jsdom
/**
 * D1 (round 28 post-fix audit): `loadingMore` was the third in-flight flag and the
 * only one the conversation-switch effect did not take over. Switching conversation
 * while a backward page was still in flight left "Load older activity" rendered as
 * "Loading… disabled" on the NEW conversation until the abandoned read landed (and
 * forever if it never did), because `handleLoadMore` early-returns on `loadingMore`.
 */
import React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { ActivityPanel } from "../../apps/web/src/components/ActivityPanel.js";
import { api } from "../../apps/web/src/api.js";

vi.mock("../../apps/web/src/api.js", () => ({ api: { getConversationEvents: vi.fn() } }));

beforeEach(() => {
  vi.clearAllMocks();
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

// Node 20.19 here has no Promise.withResolvers, so the executor form is required.
const deferred = <T,>() => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
};

const eventsPage = (seqs: number[], nextBefore: number | null = null) => ({
  ok: true as const,
  data: {
    events: seqs.map((seq) => ({ seq, type: "agent.launched", ts: "2026-01-01T00:00:00.000Z", payload: null })),
    nextBefore,
  },
});

describe("D1 loadingMore is released when the conversation switches", () => {
  it("re-enables Load older on the new conversation while the abandoned page never settles", async () => {
    const abandoned = deferred<never>();
    // The tail read of the new conversation answers immediately; only the backward
    // page of the old one hangs forever.
    vi.mocked(api.getConversationEvents).mockImplementation((id: string) =>
      id === "c1" ? Promise.resolve(eventsPage([10, 9], 8) as never) : Promise.resolve(eventsPage([30, 29], 28) as never),
    );
    const { rerender } = render(<ActivityPanel conversationId="c1" />);
    await act(async () => {});

    // Back out of c1 with a page in flight that will never resolve.
    vi.mocked(api.getConversationEvents).mockReturnValueOnce(abandoned.promise);
    fireEvent.click(screen.getByRole("button", { name: "Load older activity" }));
    await act(async () => {});
    expect((screen.getByRole("button", { name: "Loading…" }) as HTMLButtonElement).disabled).toBe(true);

    rerender(<ActivityPanel conversationId="c2" />);
    await act(async () => {});

    const loadOlder = screen.getByRole("button", { name: "Load older activity" }) as HTMLButtonElement;
    expect(loadOlder.disabled).toBe(false);

    vi.mocked(api.getConversationEvents).mockResolvedValueOnce(eventsPage([28], 27) as never);
    await act(async () => {
      fireEvent.click(loadOlder);
    });

    // The page the user asked for is rendered, under the newer conversation: the
    // row from the newest read is still there and the older one is above it. A call
    // count alone passes even when the payload is dropped or painted on the wrong
    // conversation.
    expect(screen.getByText("#30")).toBeTruthy();
    expect(screen.getByText("#28")).toBeTruthy();
    // The abandoned c1 page never landed: none of its rows are on screen.
    expect(screen.queryByText("#10")).toBeNull();
    // And the consumed cursor is the new conversation's, so the next page walks back
    // from it rather than from c1's.
    expect(vi.mocked(api.getConversationEvents).mock.calls.at(-1)).toEqual(["c2", { before: 28 }]);
  });

  it("keeps the newer page's spinner when a superseded backward page lands under it", async () => {
    // Two backward pages can be in flight at once across a conversation switch: the
    // first conversation's page is abandoned by the switch, and the page the user
    // asks for on the new conversation is the newest. Releasing `loadingMore`
    // unconditionally on landing would let the abandoned read re-enable
    // "Load older activity" — and start another page — while the newest one is still
    // outstanding.
    const held = new Map<string, (value: unknown) => void>();
    const calls: string[] = [];
    vi.mocked(api.getConversationEvents).mockImplementation(
      (id: string, options?: { before?: number }) => {
        // The cursor is the `nextBefore` the tail read reported: 8 for c1, 28 for c2.
        const key = options?.before === undefined ? `${id}:tail` : `${id}:page:${options.before}`;
        calls.push(key);
        if (key === "c1:page:8" || key === "c2:page:28") {
          return new Promise((resolve) => { held.set(key, resolve); }) as never;
        }
        return Promise.resolve(eventsPage(id === "c1" ? [10, 9] : [30, 29], id === "c1" ? 8 : 28) as never);
      },
    );

    const { rerender } = render(<ActivityPanel conversationId="c1" />);
    await act(async () => {});
    fireEvent.click(screen.getByRole("button", { name: "Load older activity" }));
    await act(async () => {});

    // Switch away with c1's page in flight, then page the new conversation too.
    rerender(<ActivityPanel conversationId="c2" />);
    await act(async () => {});
    fireEvent.click(screen.getByRole("button", { name: "Load older activity" }));
    await act(async () => {});
    expect((screen.getByRole("button", { name: "Loading…" }) as HTMLButtonElement).disabled).toBe(true);
    expect(calls).toEqual(["c1:tail", "c1:page:8", "c2:tail", "c2:page:28"]);

    // The abandoned page lands: it must neither paint nor release the flag the newer
    // page owns.
    await act(async () => {
      held.get("c1:page:8")!(eventsPage([8], 7));
    });
    expect((screen.getByRole("button", { name: "Loading…" }) as HTMLButtonElement).disabled).toBe(true);
    expect(screen.queryByText("#8")).toBeNull();

    // The page the user is waiting on lands and is the one that ends the wait.
    await act(async () => {
      held.get("c2:page:28")!(eventsPage([28], 27));
    });
    expect((screen.getByRole("button", { name: "Load older activity" }) as HTMLButtonElement).disabled).toBe(false);
    expect(screen.getByText("#30")).toBeTruthy();
    expect(screen.getByText("#28")).toBeTruthy();
    expect(screen.queryByText("#8")).toBeNull();
  });

  it("lets the current conversation page again after a switch back", async () => {
    const abandoned = deferred<never>();
    vi.mocked(api.getConversationEvents).mockImplementation((id: string) =>
      Promise.resolve(eventsPage(id === "c1" ? [10, 9] : [30, 29], id === "c1" ? 8 : 28) as never),
    );
    const { rerender } = render(<ActivityPanel conversationId="c1" />);
    await act(async () => {});

    vi.mocked(api.getConversationEvents).mockReturnValueOnce(abandoned.promise);
    fireEvent.click(screen.getByRole("button", { name: "Load older activity" }));
    await act(async () => {});

    rerender(<ActivityPanel conversationId="c2" />);
    await act(async () => {});
    rerender(<ActivityPanel conversationId="c1" />);
    await act(async () => {});

    const loadOlder = screen.getByRole("button", { name: "Load older activity" }) as HTMLButtonElement;
    expect(loadOlder.disabled).toBe(false);
  });
});
