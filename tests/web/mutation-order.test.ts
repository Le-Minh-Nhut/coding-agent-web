import { describe, expect, it } from "vitest";
import { chainMutation } from "../../apps/web/src/mutation-order.js";

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
});
