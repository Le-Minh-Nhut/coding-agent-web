import { describe, expect, it } from "vitest";
import { chainMutation, resetMutationQueues, MUTATION_CANCELLED } from "../../apps/web/src/mutation-order.js";

// Node 20.19 here has no Promise.withResolvers, so the executor form is required.
const gate = () => {
  let release!: () => void;
  const released = new Promise<void>((resolve) => (release = resolve));
  return { released, release };
};

describe("chainMutation", () => {
  it("runs same-key mutations in submission order, the first finishing before the second starts", async () => {
    const g = gate();
    const order: string[] = [];
    const first = chainMutation("k", async () => {
      order.push("first:start");
      await g.released;
      order.push("first:end");
    });
    const second = chainMutation("k", async () => {
      order.push("second:start");
    });
    await Promise.resolve();
    expect(order).toEqual(["first:start"]);
    g.release();
    await Promise.all([first, second]);
    expect(order).toEqual(["first:start", "first:end", "second:start"]);
  });

  it("a failed predecessor does not block its successor", async () => {
    const failed = chainMutation("k", async () => {
      throw new Error("boom");
    });
    const next = chainMutation("k", async () => "ok");
    await expect(failed).rejects.toThrow("boom");
    await expect(next).resolves.toBe("ok");
  });

  it("prunes the entry once settled: the next mutation for that key starts synchronously", async () => {
    await chainMutation("k", async () => undefined);
    // The prune runs on the settlement continuation, one microtask after the caller's
    // await resumes — flush it before probing.
    await Promise.resolve();
    await Promise.resolve();
    const order: string[] = [];
    void chainMutation("k", async () => {
      order.push("start");
    });
    // A retained entry would defer this run a microtask; a pruned one starts it now.
    expect(order).toEqual(["start"]);
  });

  it("independent keys do not serialize: a gated key does not hold an idle one", async () => {
    const g = gate();
    const order: string[] = [];
    void chainMutation("slow", async () => {
      await g.released;
      order.push("slow");
    });
    await chainMutation("fast", async () => {
      order.push("fast");
    });
    expect(order).toEqual(["fast"]);
    g.release();
  });

  it("resetMutationQueues drops the tails: a fresh submission for a gated key starts immediately", async () => {
    const g = gate();
    const order: string[] = [];
    void chainMutation("reset-key", async () => {
      order.push("old:start");
      await g.released;
      order.push("old:end");
    });
    // The old write for the key is still open — without the reset, the next
    // submission would queue behind it instead of going out now.
    resetMutationQueues();
    void chainMutation("reset-key", async () => {
      order.push("new:start");
    });
    // No microtask flush: a chained tail would defer this start.
    expect(order).toEqual(["old:start", "new:start"]);
    g.release();
    await Promise.resolve();
    expect(order).toEqual(["old:start", "new:start", "old:end"]);
  });

  it("resetMutationQueues retires a successor already chained: it does not run", async () => {
    const g = gate();
    const order: string[] = [];
    const first = chainMutation("reset-key", async () => {
      order.push("first:start");
      await g.released;
      order.push("first:end");
    });
    // Submitted before the reset, so its continuation is already attached to
    // `first`. The predecessor is in flight and cannot be recalled, but the
    // successor has not issued anything yet: at the boundary its lifetime ends, so
    // it must settle as cancelled instead of sending the user's old intent under
    // the next session's credentials.
    const successor = chainMutation("reset-key", async () => {
      order.push("successor");
    });
    resetMutationQueues();
    g.release();
    await expect(first).resolves.toBeUndefined();
    await expect(successor).resolves.toBe(MUTATION_CANCELLED);
    await Promise.resolve();
    expect(order).toEqual(["first:start", "first:end"]);
  });

  it("a chained submission retired at the boundary never runs its body: no send", async () => {
    const g = gate();
    let runs = 0;
    // A predecessor must be in flight for the gate to be observable at all: with an
    // idle key the attempt starts synchronously (see the prune case), so it would
    // have issued its request before any boundary could be crossed. A queued
    // attempt is the only one that can be caught by the gate.
    void chainMutation("spy-key", async () => {
      await g.released;
    });
    const queued = chainMutation("spy-key", async () => {
      runs++;
      return "sent";
    });
    resetMutationQueues();
    g.release();
    await expect(queued).resolves.toBe(MUTATION_CANCELLED);
    expect(runs).toBe(0);
  });

  it("same-generation submissions are not cancelled", async () => {
    const first = chainMutation("control-key", async () => "first");
    const second = chainMutation("control-key", async () => "second");
    await expect(first).resolves.toBe("first");
    await expect(second).resolves.toBe("second");
  });

  it("a cancelled successor does not poison the chain", async () => {
    const g = gate();
    void chainMutation("poison-key", async () => {
      await g.released;
    });
    const blocked = chainMutation("poison-key", async () => "blocked");
    resetMutationQueues();
    g.release();
    // The retired attempt settled normally, so its key is free: the next submission
    // for the same key runs its own value rather than hanging behind a dead chain.
    await expect(blocked).resolves.toBe(MUTATION_CANCELLED);
    await expect(chainMutation("poison-key", async () => "after")).resolves.toBe("after");
  });
});
