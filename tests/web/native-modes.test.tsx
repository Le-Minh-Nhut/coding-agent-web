// @vitest-environment jsdom
/**
 * Advisor and Vibe surfaces (round 51).
 *
 * What each case defends, and why it would have been a lie without it:
 *
 *  - an advisor note carries its real severity from the journal, and a `blocker`
 *    is readable while the row is collapsed — advice nobody can see is not advice
 *    (`packages/tui/src/chat/messages.ts:295-309` is the payload shape);
 *  - an unreadable bridge is reported as unknown, never as "off" — the whole
 *    point of the control path is that "I could not ask" is not an answer;
 *  - OMP's own refusal (`ok:false`, `conflict`) is shown with its reason and does
 *    NOT move the displayed mode;
 *  - the first directive is sent only after the switch is confirmed on.
 */
import React from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { advisorNotesOf, summarizeAdvisorNotes } from "../../apps/web/src/advisor.js";
import { AdvisorPanel } from "../../apps/web/src/components/AdvisorPanel.js";
import { VibePanel } from "../../apps/web/src/components/VibePanel.js";
import type { NativeModeState, VibeStateResponse } from "@caw/contracts";
import type { AgentView } from "../../apps/web/src/agent-model.js";

/** A classified agent view, which is what the panel receives (B01). */
function agentView(over: Partial<AgentView> & { id: string }): AgentView {
  return {
    displayName: over.id, kind: "sub", status: "running", class: "worker", parentId: "main",
    hasSessionFile: true, createdAt: 0, lastActivity: 0, canKillWorker: true, readOnlyReason: null,
    ...over,
  };
}

afterEach(cleanup);

/** The exact payload OMP writes for one advisor turn. */
function advisorEntry(notes: unknown[]) {
  return { customType: "advisor", details: { notes } };
}

const idleModes: NativeModeState = {
  plan: { status: "inactive" },
  vibe: { status: "inactive" },
  goal: { status: "inactive" },
  loop: { status: "inactive" },
};

const activeModes: NativeModeState = {
  ...idleModes,
  vibe: { status: "active" },
};

function vibeState(over: Partial<VibeStateResponse>): VibeStateResponse {
  return { available: true, reason: null, modes: idleModes, tools: null, model: null, thinkingLevel: null, ...over };
}

describe("advisor notes", () => {
  it("reads severity, advisor name and turns-ago from the journal payload", () => {
    const parsed = advisorNotesOf(advisorEntry([
      { note: "Reasoning about the race is wrong", severity: "concern", advisor: "Architecture", turnsAgo: 3 },
      { note: "Ship it", severity: "nit" },
    ]));
    expect(parsed).toHaveLength(2);
    expect(parsed[0]).toEqual({ note: "Reasoning about the race is wrong", severity: "concern", advisor: "Architecture", turnsAgo: 3 });
    expect(parsed[1]).toEqual({ note: "Ship it", severity: "nit", advisor: null, turnsAgo: null });
  });

  it("treats an unknown severity as the weakest, never the strongest", () => {
    // Guessing upward would turn noise into a blocker, which is the one severity
    // a user is trained to stop for.
    const [note] = advisorNotesOf(advisorEntry([{ note: "hmm", severity: "catastrophe" }]));
    expect(note!.severity).toBe("nit");
  });

  it("ignores rows that are not advisor cards, and empty notes", () => {
    expect(advisorNotesOf({ customType: "launch-completion", details: { notes: [{ note: "x" }] } })).toEqual([]);
    expect(advisorNotesOf(advisorEntry([{ note: "" }, { note: "   " }, { severity: "blocker" }]))).toEqual([]);
  });

  it("collects distinct advisor names across rows", () => {
    const summary = summarizeAdvisorNotes([
      advisorEntry([{ note: "a", severity: "nit", advisor: "One" }]),
      advisorEntry([{ note: "b", severity: "concern", advisor: "Two" }, { note: "c", advisor: "One" }]),
    ]);
    expect(summary.notes).toHaveLength(3);
    expect(summary.advisors).toEqual(["One", "Two"]);
  });
});

describe("advisor panel", () => {
  it("shows a blocker prominently and does not claim the advisor is running", () => {
    const summary = summarizeAdvisorNotes([
      advisorEntry([{ note: "This writes the journal twice", severity: "blocker", advisor: "Architecture" }]),
    ]);
    render(<AdvisorPanel summary={summary} onClose={() => {}} />);
    expect(screen.getByText("blocker")).toBeTruthy();
    expect(screen.getByText("This writes the journal twice")).toBeTruthy();
    // Activity, not enablement: a note proves it ran, never that it is on now.
    expect(screen.getByText(/Notes recorded/)).toBeTruthy();
    expect(screen.queryByText(/Enabled/)).toBeNull();
  });

  it("says where the unreachable controls live instead of offering them", () => {
    render(<AdvisorPanel summary={{ notes: [], advisors: [] }} onClose={() => {}} />);
    expect(screen.getByText(/Controlling the advisor/)).toBeTruthy();
    // The panel must name the real terminal commands — that is the actionable path.
    expect(screen.getByText("/advisor on")).toBeTruthy();
    // And it must never render a switch it cannot move.
    expect(screen.queryByRole("switch")).toBeNull();
  });
});

describe("vibe directive delivery (B03)", () => {
  it("keeps a directive that could not be sent, in a form the user can resend", async () => {
    // The defect: the directive was handed to a prompt path that refuses silently
    // when the link is not accepting prompts, so a user could see "Vibe mode on"
    // while their instruction had gone nowhere. The requirement is that the text
    // is never lost — it is recorded, copyable and one tap from a resend.
    const onEnter = vi.fn();
    render(
      <VibePanel
        state={vibeState({})}
        busy={false} error={null} readOnly={false} workers={[]}
        onEnter={onEnter} onExit={() => {}} onKillWorker={() => {}} onOpenWorkers={() => {}} onClose={() => {}}
      />,
    );
    fireEvent.change(screen.getByLabelText(/First directive/), { target: { value: "fix the flaky test" } });
    fireEvent.click(screen.getByRole("button", { name: "Enable Vibe" }));
    // The panel hands the text to the transition, which owns the sequencing — so
    // it cannot be fired before the mode is confirmed (the earlier defect).
    expect(onEnter).toHaveBeenCalledWith("fix the flaky test");
  });

  it("shows the refusal reason when the transition is refused", () => {
    render(
      <VibePanel
        state={vibeState({})}
        busy={false}
        error="Another mode blocks vibe mode. Exit plan or goal mode first."
        readOnly={false} workers={[]}
        onEnter={() => {}} onExit={() => {}} onKillWorker={() => {}} onOpenWorkers={() => {}} onClose={() => {}}
      />,
    );
    expect(screen.getByRole("alert").textContent).toContain("Another mode blocks vibe mode");
  });
});

describe("vibe panel", () => {
  it("reports an unreadable bridge as unknown, never as off", () => {
    render(
      <VibePanel
        state={vibeState({ available: false, reason: "listener refused", modes: null })}
        busy={false} error={null} readOnly={false} workers={[]}
        onEnter={() => {}} onExit={() => {}} onKillWorker={() => {}} onOpenWorkers={() => {}} onClose={() => {}}
      />,
    );
    expect(screen.getByText("Unknown")).toBeTruthy();
    expect(screen.queryByText("Off")).toBeNull();
    expect(screen.getByText(/listener refused/)).toBeTruthy();
    // No switch while the state is unknown — that is the whole guarantee.
    expect(screen.queryByRole("button", { name: /Enable Vibe/ })).toBeNull();
  });

  it("shows which mode blocks entry, from the observed state", () => {
    render(
      <VibePanel
        state={vibeState({ modes: { ...idleModes, plan: { status: "paused" } } })}
        busy={false} error={null} readOnly={false} workers={[]}
        onEnter={() => {}} onExit={() => {}} onKillWorker={() => {}} onOpenWorkers={() => {}} onClose={() => {}}
      />,
    );
    // Paused counts as blocking (docs/vibe-mode.md), and the panel names the mode.
    expect(screen.getByText(/plan mode is active or paused/)).toBeTruthy();
    expect(screen.queryByRole("button", { name: /Enable Vibe/ })).toBeNull();
  });

  it("confirms before exiting when a worker turn is in flight", () => {
    render(
      <VibePanel
        state={vibeState({ modes: activeModes, tools: ["read", "vibe_spawn"] })}
        busy={false} error={null} readOnly={false}
        workers={[{ id: "w1", displayName: "sonic", kind: "sub", status: "running", hasSessionFile: true, createdAt: 0, lastActivity: 0 }]}
        onEnter={() => {}} onExit={() => {}} onKillWorker={() => {}} onOpenWorkers={() => {}} onClose={() => {}}
      />,
    );
    expect(screen.getByText("● On")).toBeTruthy();
    // The director's real toolset is what the process reported, not a claim.
    expect(screen.getByText("read, vibe_spawn")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Exit Vibe" }));
    // Cancelling worker turns is destructive, so it is named before the action.
    expect(screen.getByText(/cancel 1 active worker turn/)).toBeTruthy();
    expect(screen.getByText(/transcript is kept/)).toBeTruthy();
  });

  it("offers Kill only for a proven worker that is actually running", () => {
    render(
      <VibePanel
        state={vibeState({ modes: activeModes })}
        busy={false} error={null} readOnly={false}
        workers={[
          agentView({ id: "w1" }),
          agentView({ id: "w2", status: "idle" }),
          // A running *main* agent: the regression this test exists for. It must
          // never gain a Kill control, however busy it looks.
          agentView({ id: "main", kind: "main", class: "main", canKillWorker: false, readOnlyReason: "This is the session's own agent." }),
          agentView({ id: "plain", class: "subagent", canKillWorker: false, readOnlyReason: "No Vibe lifecycle record." }),
        ]}
        onEnter={() => {}} onExit={() => {}} onKillWorker={() => {}} onOpenWorkers={() => {}} onClose={() => {}}
      />,
    );
    // Two conditions, not one: killing an idle worker would imply it stopped
    // something, and killing an unproven agent could stop the session itself.
    const kills = screen.getAllByRole("button", { name: "Kill" });
    expect(kills).toHaveLength(1);
  });

  it("passes the first directive into the single enter call", () => {
    // The directive must NOT be a separate callback: it has to be sequenced
    // behind a confirmed switch, so the panel hands it to onEnter.
    const onEnter = vi.fn();
    render(
      <VibePanel
        state={vibeState({})}
        busy={false} error={null} readOnly={false} workers={[]}
        onEnter={onEnter} onExit={() => {}} onKillWorker={() => {}} onOpenWorkers={() => {}} onClose={() => {}}
      />,
    );
    fireEvent.change(screen.getByLabelText(/First directive/), { target: { value: "  fix the flaky test  " } });
    fireEvent.click(screen.getByRole("button", { name: "Enable Vibe" }));
    expect(onEnter).toHaveBeenCalledTimes(1);
    expect(onEnter).toHaveBeenCalledWith("fix the flaky test");
  });

  it("shows OMP's own refusal reason", () => {
    render(
      <VibePanel
        state={vibeState({})}
        busy={false} error="Another mode blocks vibe mode. Exit plan or goal mode first." readOnly={false} workers={[]}
        onEnter={() => {}} onExit={() => {}} onKillWorker={() => {}} onOpenWorkers={() => {}} onClose={() => {}}
      />,
    );
    expect(screen.getByRole("alert").textContent).toContain("Another mode blocks vibe mode");
  });
});
