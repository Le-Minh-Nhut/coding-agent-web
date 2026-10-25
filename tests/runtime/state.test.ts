import { describe, expect, it } from "vitest";
import type { Conversation } from "@caw/contracts";
import { evaluateState, launchVerdict } from "@caw/runtime";
import type { Observations, RuntimeHost, RuntimeTmuxSession } from "@caw/runtime";

const tmux = (over: Partial<RuntimeTmuxSession> = {}): RuntimeTmuxSession => ({
  id: "$7",
  name: "caw-abcd1234",
  alive: true,
  panePid: 4242,
  serverIdentity: "private-socket:1:100",
  ...over,
});

const host = (over: Partial<RuntimeHost> = {}): RuntimeHost => ({
  instanceId: "abc123",
  generation: 1,
  pid: 4242,
  sessionId: "01a16ed6-2ebb-7609-a2a2-e76d0d8dd06e",
  cwd: "/tmp/project",
  model: "provider/model",
  participants: 1,
  relayConnected: true,
  inputRequired: false,
  busy: false,
  access: "control",
  ...over,
});

const obs = (over: Partial<Observations> = {}): Observations => ({
  tmux: null,
  host: null,
  leaseLive: false,
  sessionPathExists: false,
  hasNativeSession: false,
  everLaunched: false,
  stopRequested: false,
  registryUnreadable: false,
  tmuxOwnershipUnknown: false,
  sessionPathReason: null,
  tmuxEnumerationFailed: false,
  tmuxEnumerationReason: null,
  ...over,
});

describe("evaluateState", () => {
  it("reports running only when a turn is actually in flight", () => {
    expect(evaluateState(obs({ tmux: tmux(), host: host({ busy: true }) })).state).toBe("running");
  });

  it("never reports a finished turn as settled, only as idle", () => {
    // busy=false means no turn in flight; OMP reports false during scheduling
    // pauses too, so this must not become a completion claim.
    expect(evaluateState(obs({ tmux: tmux(), host: host({ busy: false }) })).state).toBe("idle");
  });

  it("keeps an unknown busy flag unknown with an explicit caveat", () => {
    const verdict = evaluateState(obs({ tmux: tmux(), host: host({ busy: null }) }));
    expect(verdict.state).toBe("unknown");
    expect(verdict.detail).toMatch(/does not report turn state/i);
  });

  it("keeps an external host with an unknown busy flag unknown", () => {
    const verdict = evaluateState(obs({ tmux: null, host: host({ busy: null }) }));
    expect(verdict.state).toBe("unknown");
    expect(verdict.detail).toMatch(/does not report turn state/i);
  });
  it("keeps an absent busy field unknown in managed and external observations", () => {
    const managed = evaluateState(obs({ tmux: tmux(), host: host({ busy: undefined }) }));
    const external = evaluateState(obs({ host: host({ busy: undefined }) }));
    expect(managed.state).toBe("unknown");
    expect(external.state).toBe("unknown");
  });

  it("prioritises a waiting host question over turn state", () => {
    expect(evaluateState(obs({ tmux: tmux(), host: host({ busy: true, inputRequired: true }) })).state).toBe("awaiting_input");
  });

  it("distinguishes a live process that is not hosting from a running agent", () => {
    const verdict = evaluateState(obs({ tmux: tmux(), host: null }));
    expect(verdict.state).toBe("idle");
    expect(verdict.detail).toMatch(/not sharing a session/i);
  });

  it("reports unknown, not a disconnected room, when the listing omits relayConnected", () => {
    // `false` relay connectivity is a positive fact about a live room; an absent
    // field is not that fact, so the verdict must stay non-committal.
    const verdict = evaluateState(obs({ tmux: tmux(), host: host({ relayConnected: null }) }));
    expect(verdict.state).toBe("unknown");
    expect(verdict.detail).toMatch(/does not report relay connectivity/i);
  });

  it("does not claim a waiting question when inputRequired is absent", () => {
    const verdict = evaluateState(obs({ tmux: tmux(), host: host({ busy: true, inputRequired: null }) }));
    expect(verdict.state).toBe("running");
    expect(verdict.state).not.toBe("awaiting_input");
  });

  it("marks a host we do not manage as external, and never as ours", () => {
    const verdict = evaluateState(obs({ tmux: null, host: host({ busy: true }) }));
    expect(verdict).toEqual({ state: "running", ownership: "external", detail: expect.stringMatching(/outside this app/i) });
  });

  it("reports stopped when the process is gone and the history survives", () => {
    const verdict = evaluateState(obs({ tmux: tmux({ alive: false }), sessionPathExists: true, hasNativeSession: true }));
    expect(verdict.state).toBe("stopped");
  });
  it("requires a confirmed free lease before reporting stopped", () => {
    const verdict = evaluateState(obs({ tmux: tmux({ alive: false }), leaseLive: "unknown", everLaunched: true }));
    expect(verdict.state).toBe("unknown");
    expect(verdict.detail).toMatch(/lease could not be checked/i);
  });
  it("reports stopped with a confirmed-free lease after process exit", () => {
    const verdict = evaluateState(obs({ tmux: tmux({ alive: false }), leaseLive: false, everLaunched: true, sessionPathExists: true }));
    expect(verdict.state).toBe("stopped");
  });
 it("keeps unknown lease with no process and prior launch unconfirmed", () => {
   const verdict = evaluateState(obs({ leaseLive: "unknown", everLaunched: true, sessionPathExists: true }));
   expect(verdict.state).toBe("unknown");
   expect(verdict.detail).toMatch(/lease could not be checked/i);
 });
  it("keeps ownership unknown for an unverifiable recorded tmux server", () => {
    const verdict = evaluateState(obs({ tmuxOwnershipUnknown: true, everLaunched: true, leaseLive: false }));
    expect(verdict.state).toBe("unknown");
    expect(verdict.detail).toMatch(/tmux server identity .*cannot be verified/i);
  });

  it("reports error only when a recorded session identity is now unreadable", () => {
    const verdict = evaluateState(
      obs({ tmux: tmux({ alive: false }), hasNativeSession: true, sessionPathExists: false, everLaunched: true }),
    );
    expect(verdict.state).toBe("error");
  });

  it("does not claim a lost history when it never recorded a session identity", () => {
    const verdict = evaluateState(obs({ tmux: tmux({ alive: false }), everLaunched: true, sessionPathExists: false }));
    expect(verdict.state).toBe("stopped");
    expect(verdict.detail).not.toMatch(/could not be found/i);
  });

  it("reports unknown, not error, when the journal probe could not run", () => {
    // §5: a throw from the existence probe used to be read as "the history is
    // gone" and persisted as `error`. Unknown is the honest answer.
    const verdict = evaluateState(
      obs({
        tmux: tmux({ alive: false }),
        hasNativeSession: true,
        everLaunched: true,
        sessionPathExists: "unknown",
        sessionPathReason: "EACCES: permission denied",
      }),
    );
    expect(verdict.state).toBe("unknown");
    expect(verdict.detail).toMatch(/EACCES/);
  });

  it("reports unknown, not stopped, when the tmux enumeration failed", () => {
    const verdict = evaluateState(
      obs({
        everLaunched: true,
        tmuxEnumerationFailed: true,
        tmuxEnumerationReason: "The tmux session list could not be read (boom), so the live state is unknown.",
      }),
    );
    expect(verdict.state).toBe("unknown");
    expect(verdict.state).not.toBe("stopped");
    expect(verdict.detail).toMatch(/could not be read/i);
  });

  it("still reports error for a confirmed-missing journal, so not everything is unknown", () => {
    const verdict = evaluateState(
      obs({ tmux: tmux({ alive: false }), hasNativeSession: true, everLaunched: true, sessionPathExists: false }),
    );
    expect(verdict.state).toBe("error");
  });

  it("reports unknown, not stopped, when the registry cannot be read", () => {
    const verdict = evaluateState(obs({ tmux: tmux({ alive: false }), registryUnreadable: true, sessionPathExists: true }));
    expect(verdict.state).toBe("unknown");
    expect(verdict.state).not.toBe("stopped");
  });

  it("reports stopping while a stop is in flight on a live process", () => {
    expect(evaluateState(obs({ tmux: tmux(), stopRequested: true })).state).toBe("stopping");
  });

  it("settles a completed stop to stopped rather than error", () => {
    expect(evaluateState(obs({ tmux: tmux({ alive: false }), stopRequested: true, sessionPathExists: false })).state).toBe("stopped");
  });

  it("flags a foreign writer as unknown so the UI cannot claim the session is ours", () => {
    const verdict = evaluateState(obs({ leaseLive: true, sessionPathExists: true }));
    expect(verdict.state).toBe("unknown");
    expect(verdict.detail).toMatch(/not managed here/i);
  });
});

describe("launchVerdict — the duplicate-writer guard", () => {
  const base = { liveTmux: null, host: null, leaseLive: false as const, activeCount: 0, maxActive: 3 };

  it("allows a launch when nothing writes the session", () => {
    expect(launchVerdict(base)).toEqual({ allowed: true });
  });

  it("refuses when a managed process is already alive", () => {
    const verdict = launchVerdict({ ...base, liveTmux: tmux() });
    expect(verdict.allowed).toBe(false);
    expect(verdict.allowed === false && verdict.code).toBe("conflict_owner");
  });

  it("refuses when another process is serving the session", () => {
    const verdict = launchVerdict({ ...base, host: host() });
    expect(verdict.allowed === false && verdict.code).toBe("conflict_owner");
  });

  it("refuses when the writer lease is held by anything at all", () => {
    const verdict = launchVerdict({ ...base, leaseLive: true });
    expect(verdict.allowed === false && verdict.code).toBe("conflict_owner");
    expect(verdict.allowed === false && verdict.message).toMatch(/fork/i);
  });

  it("refuses when the lease cannot be determined, because a wrong guess forks history", () => {
    const verdict = launchVerdict({ ...base, leaseLive: "unknown" });
    expect(verdict.allowed === false && verdict.code).toBe("conflict_owner");
    expect(verdict.allowed === false && verdict.message).toMatch(/could not be checked/i);
  });

  it("refuses past the concurrency cap", () => {
    const verdict = launchVerdict({ ...base, activeCount: 3, maxActive: 3 });
    expect(verdict.allowed === false && verdict.code).toBe("conflict_limit");
  });

  it("checks ownership before the cap, so a conflict is never reported as a limit", () => {
    const verdict = launchVerdict({ ...base, liveTmux: tmux(), activeCount: 9, maxActive: 3 });
    expect(verdict.allowed === false && verdict.code).toBe("conflict_owner");
  });
});

describe("conversation shape used by the supervisor", () => {
  it("keeps identity fields the supervisor relies on optional-but-explicit", () => {
    const conversation: Conversation = {
      id: "c1",
      projectId: "p1",
      nativeSessionId: null,
      nativeSessionPath: null,
      title: "t",
      model: null,
      ownership: "managed",
      state: "starting",
      tmuxSessionId: null,
      tmuxSessionName: null,
      tmuxServerIdentity: null, tmuxPanePid: null,
      hostInstanceId: null,
      hostGeneration: null,
      createdAt: "",
      updatedAt: "",
      lastActivityAt: null,
      statusDetail: null,
    };
    expect(evaluateState(obs()).state).toBe("starting");
    expect(conversation.nativeSessionId).toBeNull();
  });
});
