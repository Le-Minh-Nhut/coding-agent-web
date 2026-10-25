import { describe, expect, it } from "vitest";
import type { Conversation } from "@caw/contracts";
import { createSupervisor } from "@caw/runtime";
import type { ConversationRuntimeStore, RuntimeAdapters, RuntimeTmuxSession } from "@caw/runtime";

/**
 * Narrow probe for one reconcile branch: a conversation that was launched, whose
 * tmux session is gone, whose native journal survives, and whose lease is free
 * must be `stopped` — never `unknown`. It is reproduced here so the verdict can be
 * observed without launching a real agent.
 */
function storeWith(conversation: Conversation) {
  const conversations = new Map([[conversation.id, conversation]]);
  const store: ConversationRuntimeStore = {
    getConversation: async (id) => conversations.get(id) ?? null,
    listAllConversations: async () => [...conversations.values()],
    updateConversation: async (id, patch) => {
      const current = conversations.get(id);
      if (!current) return null;
      const next = { ...current, ...patch };
      conversations.set(id, next);
      return next;
    },
    recordEvent: async () => null,
  };
  return { store, conversations };
}

describe("reconcile verdict for a dead managed process", () => {
  it("reports stopped when the process is gone, the journal survives and the lease is free", async () => {
    const conversation: Conversation = {
      id: "c1",
      projectId: "p1",
      nativeSessionId: "01a16ed6-2ebb-7609-a2a2-e76d0d8dd06e",
      nativeSessionPath: "/tmp/journal.jsonl",
      title: "c1",
      model: null,
      ownership: "managed",
      state: "running",
      tmuxSessionId: "$0",
      tmuxSessionName: "caw-c1",
      tmuxPanePid: 1_000_000_000,
      tmuxServerIdentity: "socket:$0:1234",
      hostInstanceId: null,
      hostGeneration: null,
      createdAt: "",
      updatedAt: "",
      lastActivityAt: null,
      statusDetail: null,
    };
    const { store, conversations } = storeWith(conversation);

    const adapters: RuntimeAdapters = {
      listHosts: async () => [],
      // The tmux session is gone: killed, or its server died.
      listManagedTmux: async () => [] as RuntimeTmuxSession[],
      getTmux: async () => ({ ok: true as const, session: null }),
      tmuxServerIdentity: async () => "socket:$0:1234",
      launch: async () => {
        throw new Error("not used");
      },
      killTmux: async () => {},
      isSessionLive: async () => false,
      newestSessionFor: async () => null,
      sessionPathExists: async () => true,
      findBySessionId: async () => "/tmp/journal.jsonl",
    };

    const supervisor = createSupervisor({ store, adapters, maxActive: 2 });
    const report = await supervisor.reconcile();
    const after = conversations.get("c1")!;

    // Report the observed verdict so a failure names the actual branch.
    expect({ report, state: after.state, detail: after.statusDetail }).toEqual({
      report: { adopted: 0, external: 0, stopped: 1, unknown: 0, registered: 0 },
      state: "stopped",
      detail: expect.stringContaining("no longer running"),
    });
  });
});
