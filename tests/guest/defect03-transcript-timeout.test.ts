// @vitest-environment jsdom
import { describe, expect, it, vi, afterEach } from "vitest";
import { GuestClient } from "../../packages/guest/src/lib/client";
import { generateRoomKey } from "../../packages/guest/src/lib/codec";
import { formatCollabLink } from "../../packages/guest/src/lib/link";

describe("DEFECT-03: offline fetchTranscript resolves null immediately without 10s stall", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("resolves null on next tick when socket is offline rather than waiting for 10s timeout", async () => {
    vi.useFakeTimers();
    const key = generateRoomKey();
    const link = formatCollabLink("ws://127.0.0.1:9999", "testroom1234567890", key);
    const client = new GuestClient(link, "test-user");

    let resolved = false;
    let result: unknown = undefined;

    client.fetchTranscript("subagent-1", 0).then((res) => {
      resolved = true;
      result = res;
    });

    // Advance by 50ms (well under 10,000ms TRANSCRIPT_TIMEOUT_MS)
    await vi.advanceTimersByTimeAsync(50);

    expect(resolved).toBe(true);
    expect(result).toBeNull();
  });
});
