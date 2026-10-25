// @vitest-environment jsdom
import React from "react";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, act, fireEvent } from "@testing-library/react";
import { ActivityPanel, humanizeEventType } from "../../apps/web/src/components/ActivityPanel.js";
import { api } from "../../apps/web/src/api.js";
import type { ConversationEvent } from "@caw/contracts";

vi.mock("../../apps/web/src/api.js", () => ({
  api: {
    getConversationEvents: vi.fn(),
  },
}));

describe("ActivityPanel UI", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("humanizeEventType translates all supervisor types and handles unknown types gracefully", () => {
    expect(humanizeEventType("launch.refused")).toBe("Launch Refused");
    expect(humanizeEventType("agent.launched")).toBe("Agent Launched");
    expect(humanizeEventType("agent.hosted")).toBe("Agent Collab Hosted");
    expect(humanizeEventType("agent.exited")).toBe("Agent Exited");
    expect(humanizeEventType("agent.stop_requested")).toBe("Stop Requested");
    expect(humanizeEventType("agent.stopped")).toBe("Agent Stopped");
    expect(humanizeEventType("agent.stop_timeout")).toBe("Stop Timed Out");
    expect(humanizeEventType("agent.publish_timeout")).toBe("Publish Timed Out");

    // Unknown event types must not crash and format nicely
    expect(humanizeEventType("custom.step_executed")).toBe("Custom Step Executed");
    expect(humanizeEventType("strange_new_event")).toBe("Strange New Event");
    expect(humanizeEventType("arbitrary")).toBe("Arbitrary");
  });

  it("shows an honest empty state when there are no events", () => {
    const { getByRole } = render(<ActivityPanel events={[]} />);
    const status = getByRole("status");
    expect(status.textContent).toBe("No activity recorded for this conversation yet.");
  });

  it("renders events newest first with humanized labels and details", () => {
    const events: ConversationEvent[] = [
      {
        seq: 1,
        type: "agent.launched",
        ts: "2026-10-25T01:00:00.000Z",
        payload: { tmuxSessionId: "$1", tmuxSessionName: "test-session" },
      },
      {
        seq: 2,
        type: "agent.hosted",
        ts: "2026-10-25T01:01:00.000Z",
        payload: { instanceId: "inst-1" },
      },
    ];

    const { container } = render(<ActivityPanel events={events} />);
    const items = container.querySelectorAll(".activity-item");
    expect(items.length).toBe(2);

    // Newest first: seq 2 before seq 1
    expect(items[0]?.textContent).toContain("Agent Collab Hosted");
    expect(items[0]?.textContent).toContain("#2");
    expect(items[0]?.textContent).toContain("inst-1");

    expect(items[1]?.textContent).toContain("Agent Launched");
    expect(items[1]?.textContent).toContain("#1");
    expect(items[1]?.textContent).toContain("$1");
  });

  it("does not crash on an unknown event type or null payload", () => {
    const events: ConversationEvent[] = [
      {
        seq: 10,
        type: "future.experimental.probe",
        ts: "2026-10-25T01:02:00.000Z",
        payload: null,
      },
      {
        seq: 11,
        type: "weird-event-name",
        ts: "2026-10-25T01:03:00.000Z",
        payload: "primitive-string-payload",
      },
    ];

    expect(() => {
      const { container } = render(<ActivityPanel events={events} />);
      expect(container.textContent).toContain("Future Experimental Probe");
      expect(container.textContent).toContain("Weird Event Name");
      expect(container.textContent).toContain("primitive-string-payload");
    }).not.toThrow();
  });

  it("supports pagination when nextAfter is present", async () => {
    vi.mocked(api.getConversationEvents).mockResolvedValue({
      ok: true,
      data: {
        events: [
          {
            seq: 1,
            type: "agent.launched",
            ts: "2026-10-25T01:00:00.000Z",
            payload: {},
          },
        ],
        nextAfter: null,
      },
    });

    const initialEvents: ConversationEvent[] = [
      {
        seq: 2,
        type: "agent.hosted",
        ts: "2026-10-25T01:01:00.000Z",
        payload: {},
      },
    ];

    let viewContainer: HTMLElement | null = null;
    await act(async () => {
      const { container } = render(
        <ActivityPanel
          conversationId="c-1"
          events={initialEvents}
          nextAfter={2}
        />
      );
      viewContainer = container;
    });

    const loadMoreButton = viewContainer?.querySelector("button.ghost");
    expect(loadMoreButton?.textContent).toContain("Load older activity");

    await act(async () => {
      fireEvent.click(loadMoreButton!);
    });

    expect(api.getConversationEvents).toHaveBeenCalledWith("c-1", { after: 2 });
    const items = viewContainer?.querySelectorAll(".activity-item");
    expect(items?.length).toBe(2);
  });
});
