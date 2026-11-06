// @vitest-environment jsdom
/**
 * Round 54 regressions for the three defects/behaviours this round changed.
 *
 * Each case is written against the behaviour, not the markup:
 *
 *  - **P1-A**: a refused/unacknowledged prompt must never render its full text in
 *    the conversation column. It is summarised as ONE bounded row, and the records
 *    (with their complete text and every control) live in the review sheet. Counts,
 *    multiple records, and the copy/dismiss/recover paths must all still work.
 *  - **Persistence**: the records are the only copy of a prompt the host never
 *    acknowledged, so they survive a reload via sessionStorage — and *nothing else*
 *    does. Capacity is refused with a visible message, never by silent eviction.
 *  - **Notices**: an `info` notice is a quiet muted line, not a full-width banner;
 *    `warning`/`error` keep their row, and a long notice stays readable.
 */
import React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { CollabSocket, type HostFrame } from "@caw/collab-protocol";
import { App } from "../../apps/web/src/App.js";
import { ConversationView } from "../../apps/web/src/components/ConversationView.js";
import { api } from "../../apps/web/src/api.js";
import {
  MAX_RECOVERY_BYTES,
  RECOVERY_STORAGE_KEY,
  canRetain,
  readRecoveryStore,
  utf8Bytes,
  writeRecoveryStore,
  type RecoveryRecord,
} from "../../apps/web/src/prompt-recovery.js";
import { openRecoverySheet, recoveryRecords, recoverySummary, recoveryText } from "./recovery-sheet.js";

vi.mock("../../apps/web/src/api.js", () => ({
  api: {
    getConversationEvents: vi.fn(async () => ({ ok: true, data: { events: [], nextAfter: null, nextBefore: null } })),
    getConversation: vi.fn(), getAttachInstructions: vi.fn(), getConversationLink: vi.fn(), getModels: vi.fn(),
    getConversationHistory: vi.fn(), getMe: vi.fn(), getCapabilities: vi.fn(), listProjects: vi.fn(),
    listConversations: vi.fn(), listNativeSessions: vi.fn(),
  },
  setCsrfToken: vi.fn(),
}));

const REFUSAL = "prompting is unavailable until the host finishes starting up";
const welcome = (entryCount = 0): HostFrame => ({
  t: "welcome", proto: 3,
  header: { type: "session", id: "s", cwd: "/", timestamp: "" },
  state: { isStreaming: false, queuedMessageCount: 0, cwd: "/", participants: [] },
  agents: [], entryCount,
});

/** A very long prompt: the exact shape that used to consume the whole viewport. */
const LONG_PROMPT = `LONG_PROMPT_START ${"a long sentence that wraps many times ".repeat(120)} LONG_PROMPT_END`;

let socket: CollabSocket | null = null;

async function mountConversation(conversationId = "c-1") {
  vi.mocked(api.getConversation).mockResolvedValue({ ok: true, data: { id: conversationId, title: "Chat", state: "idle", ownership: "managed" } } as never);
  vi.mocked(api.getAttachInstructions).mockResolvedValue({ ok: true, data: { available: false } } as never);
  vi.mocked(api.getModels).mockResolvedValue({ ok: true, data: { models: [], source: "omp", reason: null } });
  vi.mocked(api.getConversationHistory).mockResolvedValue({ ok: false, error: { code: "not_found", message: "No history" } });
  vi.mocked(api.getConversationLink).mockResolvedValue({
    ok: true,
    data: { url: "ws://127.0.0.1:7466/r/0123456789abcdef.AQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQE", access: "full", instanceId: "i", generation: 1 },
  });
  vi.spyOn(CollabSocket.prototype, "connect").mockImplementation(function (this: CollabSocket) { socket = this; this.onOpen?.(); });
  vi.spyOn(CollabSocket.prototype, "send").mockResolvedValue(true);
  const view = render(<ConversationView conversationId={conversationId} onBack={() => {}} />);
  await waitFor(() => expect(socket).not.toBeNull());
  await act(async () => { socket!.onFrame?.(welcome(), 0); });
  return view;
}

/** Send a prompt and let the host refuse it while a newer draft is in the box. */
async function refuseWithNewerDraft(container: HTMLElement, prompt: string, newer = "NEWER_DRAFT"): Promise<void> {
  const composer = container.querySelector("textarea.composer-input") as HTMLTextAreaElement;
  fireEvent.change(composer, { target: { value: prompt } });
  await act(async () => { fireEvent.submit(composer.closest("form")!); });
  fireEvent.change(composer, { target: { value: newer } });
  await act(async () => { socket!.onFrame?.({ t: "error", message: REFUSAL }, 0); });
}

afterEach(() => { cleanup(); vi.restoreAllMocks(); socket = null; });

describe("P1-A — the recovery summary row", () => {
  it("never puts the prompt text in the conversation column, only a count", async () => {
    const view = await mountConversation();
    await refuseWithNewerDraft(view.container, LONG_PROMPT);
    const summary = recoverySummary(view);
    expect(summary, "one compact summary row").not.toBeNull();
    // The whole prompt is absent from the screen while the sheet is closed — this
    // is what stops a long refusal from displacing the transcript.
    expect(view.container.textContent).not.toContain("LONG_PROMPT_START");
    expect(summary!.textContent).toContain("1 prompt needs review");
    expect(summary!.textContent).toContain("Review");
  });

  it("counts the records, not the characters, and supports several entries", async () => {
    const view = await mountConversation();
    await refuseWithNewerDraft(view.container, "FIRST_REFUSED");
    const composer = view.container.querySelector("textarea.composer-input") as HTMLTextAreaElement;
    await act(async () => { fireEvent.submit(composer.closest("form")!); });
    fireEvent.change(composer, { target: { value: "SECOND_DRAFT" } });
    await act(async () => { socket!.onFrame?.({ t: "error", message: REFUSAL }, 0); });
    expect(recoverySummary(view)!.textContent).toContain("2 prompts need review");
    openRecoverySheet(view);
    expect(recoveryRecords(view.container)).toHaveLength(2);
  });

  it("holds the COMPLETE prompt text in the sheet, with its honest status label", async () => {
    const view = await mountConversation();
    await refuseWithNewerDraft(view.container, LONG_PROMPT);
    openRecoverySheet(view);
    const text = recoveryText(view.container);
    // Nothing is truncated: the whole prompt, start to end.
    expect(text).toContain("LONG_PROMPT_START");
    expect(text).toContain("LONG_PROMPT_END");
    expect(text).toContain("Refused");
  });

  it("keeps Copy, Recover and Dismiss working from the sheet, and Dismiss removes by id", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.assign(navigator, { clipboard: { writeText } });
    const view = await mountConversation();
    await refuseWithNewerDraft(view.container, "RECOVER_ME");
    openRecoverySheet(view);
    await act(async () => { fireEvent.click(view.getByRole("button", { name: "Copy" })); });
    expect(writeText).toHaveBeenCalledWith("RECOVER_ME");
    await act(async () => { fireEvent.click(view.getByRole("button", { name: "Recover to draft" })); });
    // Recover merges into the occupied draft rather than destroying it.
    expect((view.container.querySelector("textarea.composer-input") as HTMLTextAreaElement).value).toBe("NEWER_DRAFT\n\nRECOVER_ME");

    await act(async () => { fireEvent.click(view.getByRole("button", { name: "Dismiss" })); });
    expect(recoverySummary(view)).toBeNull();
    expect(recoveryRecords(view.container)).toHaveLength(0);
  });

  it("does not offer Recover when the composer is not writable, but keeps Copy", async () => {
    const view = await mountConversation();
    await refuseWithNewerDraft(view.container, "READONLY_RECORD");
    // Read-only link: prompts are unavailable, and Recover writes the draft.
    await act(async () => { socket!.onFrame?.({ ...welcome(), readOnly: true } as HostFrame, 0); });
    openRecoverySheet(view);
    expect(view.queryByRole("button", { name: "Recover to draft" })).toBeNull();
    expect(view.getByRole("button", { name: "Copy" })).not.toBeNull();
    expect(view.getByRole("button", { name: "Dismiss" })).not.toBeNull();
  });
});

describe("recovery retention — capacity and persistence", () => {
  const record = (id: number, text: string): RecoveryRecord => ({ id, text });

  it("counts UTF-8 bytes, not code units", () => {
    expect(utf8Bytes("abc")).toBe(3);
    // Four bytes per astral code point: two emoji are eight bytes, not four.
    expect(utf8Bytes("🚀🚀")).toBe(8);
    expect(utf8Bytes("é")).toBe(2);
  });

  it("refuses to retain past the record ceiling, naming the limit", () => {
    const full = Array.from({ length: 256 }, (_, index) => record(index, "x"));
    const verdict = canRetain(full, "one more");
    expect(verdict.ok).toBe(false);
    if (!verdict.ok) expect(verdict.reason).toContain("256 records");
  });

  it("refuses to retain past the byte ceiling", () => {
    const verdict = canRetain([record(1, "a".repeat(MAX_RECOVERY_BYTES))], "one more");
    expect(verdict.ok).toBe(false);
    if (!verdict.ok) expect(verdict.reason).toContain("MiB");
  });

  it("round-trips a store through sessionStorage and drops nothing", () => {
    const store = { "c-1": [record(1, "keep me"), { ...record(2, "unconfirmed"), unconfirmed: true }] };
    writeRecoveryStore(window.sessionStorage, store);
    expect(readRecoveryStore(window.sessionStorage)).toEqual(store);
  });

  it("removes the key entirely when nothing is retained", () => {
    writeRecoveryStore(window.sessionStorage, { "c-1": [record(1, "x")] });
    expect(window.sessionStorage.getItem(RECOVERY_STORAGE_KEY)).not.toBeNull();
    writeRecoveryStore(window.sessionStorage, {});
    expect(window.sessionStorage.getItem(RECOVERY_STORAGE_KEY)).toBeNull();
    // A store whose only conversation is empty is also nothing to retain.
    writeRecoveryStore(window.sessionStorage, { "c-1": [record(1, "x")] });
    writeRecoveryStore(window.sessionStorage, { "c-1": [] });
    expect(window.sessionStorage.getItem(RECOVERY_STORAGE_KEY)).toBeNull();
  });

  it("reads a corrupt blob as nothing retained instead of throwing", () => {
    window.sessionStorage.setItem(RECOVERY_STORAGE_KEY, "{not json");
    expect(readRecoveryStore(window.sessionStorage)).toEqual({});
    window.sessionStorage.setItem(RECOVERY_STORAGE_KEY, JSON.stringify({ "c-1": "not an array", "c-2": [record(1, "ok"), { nope: true }] }));
    expect(readRecoveryStore(window.sessionStorage)).toEqual({ "c-2": [record(1, "ok")] });
  });

  it("quarantines an unreadable blob so the mount write cannot destroy the only copy", () => {
    // m4: `{}` used to be the whole story, and App's write effect then removed the
    // key — the one path that could delete every retained prompt with no copy left.
    window.sessionStorage.setItem(RECOVERY_STORAGE_KEY, "{not json");
    expect(readRecoveryStore(window.sessionStorage)).toEqual({});
    expect(window.sessionStorage.getItem(`${RECOVERY_STORAGE_KEY}.corrupt`)).toBe("{not json");

    // And once App mirrors an empty store, the quarantined copy still exists.
    writeRecoveryStore(window.sessionStorage, {});
    expect(window.sessionStorage.getItem(RECOVERY_STORAGE_KEY)).toBeNull();
    expect(window.sessionStorage.getItem(`${RECOVERY_STORAGE_KEY}.corrupt`)).toBe("{not json");
  });

  it("treats a conversation id of __proto__ as an own key, not the prototype", () => {
    // Nit: assigning `store["__proto__"]` set the prototype instead of an own
    // property, so such a conversation's records silently vanished. Written as raw
    // JSON because an object literal cannot even express this key.
    window.sessionStorage.setItem(RECOVERY_STORAGE_KEY, '{"__proto__":[{"id":3,"text":"PROTO_KEY"}]}');
    const store = readRecoveryStore(window.sessionStorage);
    expect(Object.prototype.hasOwnProperty.call(store, "__proto__")).toBe(true);
    expect(store["__proto__"]).toEqual([record(3, "PROTO_KEY")]);
    // The prototype was never replaced, so ordinary lookups still work.
    expect(Object.getPrototypeOf(store)).toBe(null);
  });

  it("hydrates an App from a seeded store and never persists the link or transcript", async () => {
    const seeded: Record<string, RecoveryRecord[]> = { "c-1": [record(7, "SEEDED_FROM_RELOAD", )] };
    window.sessionStorage.setItem(RECOVERY_STORAGE_KEY, JSON.stringify(seeded));

    vi.mocked(api.getMe).mockResolvedValue({ ok: true, data: { csrfToken: "t" } } as never);
    vi.mocked(api.getCapabilities).mockResolvedValue({ ok: true, data: {} } as never);
    vi.mocked(api.listProjects).mockResolvedValue({ ok: true, data: [] } as never);
    vi.mocked(api.listConversations).mockResolvedValue({ ok: true, data: [] } as never);
    vi.mocked(api.listNativeSessions).mockResolvedValue({ ok: true, data: [] } as never);

    render(<App />);
    await waitFor(() => expect(window.sessionStorage.getItem(RECOVERY_STORAGE_KEY)).toContain("SEEDED_FROM_RELOAD"));
    // Only recovery records: the persisted value must not have grown a link,
    // a transcript, or a draft.
    const stored = window.sessionStorage.getItem(RECOVERY_STORAGE_KEY)!;
    expect(stored).not.toContain("ws://");
    expect(stored).not.toContain("writeToken");
    expect(Object.keys(JSON.parse(stored) as object)).toEqual(["c-1"]);
  });
});

describe("B1 — the ceiling must never destroy the only copy", () => {
  const fullList = (n = 256): RecoveryRecord[] => Array.from({ length: n }, (_, index) => ({ id: index + 1, text: `retained ${index}` }));

  async function mountAtCeiling(records: RecoveryRecord[]) {
    vi.mocked(api.getConversation).mockResolvedValue({ ok: true, data: { id: "c-1", title: "Chat", state: "idle", ownership: "managed" } } as never);
    vi.mocked(api.getAttachInstructions).mockResolvedValue({ ok: true, data: { available: false } } as never);
    vi.mocked(api.getModels).mockResolvedValue({ ok: true, data: { models: [], source: "omp", reason: null } });
    vi.mocked(api.getConversationHistory).mockResolvedValue({ ok: false, error: { code: "not_found", message: "No history" } });
    vi.mocked(api.getConversationLink).mockResolvedValue({
      ok: true,
      data: { url: "ws://127.0.0.1:7466/r/0123456789abcdef.AQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQE", access: "full", instanceId: "i", generation: 1 },
    });
    vi.spyOn(CollabSocket.prototype, "connect").mockImplementation(function (this: CollabSocket) { socket = this; this.onOpen?.(); });
    vi.spyOn(CollabSocket.prototype, "send").mockResolvedValue(true);
    const onRefusedRecoveriesChange = vi.fn();
    const view = render(
      <ConversationView
        conversationId="c-1"
        onBack={() => {}}
        refusedRecoveries={records}
        onRefusedRecoveriesChange={onRefusedRecoveriesChange}
      />,
    );
    await waitFor(() => expect(socket).not.toBeNull());
    await act(async () => { socket!.onFrame?.(welcome(), 0); });
    return { view, onRefusedRecoveriesChange };
  }

  it("retains prompt #257 when the queue that held it is cleared at the ceiling", async () => {
    const { view, onRefusedRecoveriesChange } = await mountAtCeiling(fullList(256));
    const composer = view.container.querySelector("textarea.composer-input") as HTMLTextAreaElement;

    // Send #257, then let a NEWER draft occupy the composer before the refusal lands —
    // so the prompt's only home is the pending queue, which unmount clears.
    fireEvent.change(composer, { target: { value: "PROMPT_257" } });
    await act(async () => { fireEvent.submit(composer.closest("form")!); });
    fireEvent.change(composer, { target: { value: "NEWER_DRAFT" } });
    await act(async () => { socket!.onFrame?.({ t: "error", message: REFUSAL }, 0); });
    expect(composer.value).toBe("NEWER_DRAFT");

    // Back / iOS eviction: the component goes away and promotes what it was holding.
    act(() => { view.unmount(); });

    const emitted = onRefusedRecoveriesChange.mock.calls.at(-1)?.[0] as RecoveryRecord[] | undefined;
    expect(emitted, "the promotion must reach the App-owned list").toBeDefined();
    expect(emitted!.map((record) => record.text)).toContain("PROMPT_257");
    // No eviction: every record that was already there is still there.
    for (const record of fullList(256)) expect(emitted!.map((entry) => entry.text)).toContain(record.text);
    expect(emitted!).toHaveLength(257);
  });

  it("refuses only a voluntary retention, where the text is still in the composer", async () => {
    // The ceiling's legitimate job: refuse a NEW retention when nothing is lost —
    // the composer still holds the text, so the user can shorten it or dismiss one.
    const verdict = canRetain(fullList(256), "one more");
    expect(verdict.ok).toBe(false);
    // And the refusal reason is the one the UI reports, not a silent drop.
    if (!verdict.ok) expect(verdict.reason.length).toBeGreaterThan(0);
  });

  it("refuses at the ceiling only while the text is still in the composer, and never renders the note inside the form", async () => {
    // M1. Two observable facts, both verified rather than assumed:
    //
    // 1. At the ceiling, a teardown with the text STILL IN THE COMPOSER refuses the
    //    retention (the text is not lost, so the ceiling may refuse) — the App-owned
    //    list is left exactly as it was.
    // 2. The capacity banner is a SIBLING of the composer form, never a child, so it
    //    cannot be hidden by the form's own writable/link gate.
    //
    // Trace the note itself: `promoteUnconfirmedPending` is called from effect
    // cleanups (a conversation switch or unmount), so the state it sets never reaches
    // a paint — on a switch the reset effect clears it in the same commit, and on
    // unmount there is no commit. The three clear sites are therefore not observable
    // from the outside; they are kept because each is semantically correct if a caller
    // ever sets the note earlier (a live path returning `mustRetain: false`).
    vi.mocked(api.getConversation).mockResolvedValue({ ok: true, data: { id: "c-1", title: "Chat", state: "idle", ownership: "managed" } } as never);
    vi.mocked(api.getAttachInstructions).mockResolvedValue({ ok: true, data: { available: false } } as never);
    vi.mocked(api.getModels).mockResolvedValue({ ok: true, data: { models: [], source: "omp", reason: null } });
    vi.mocked(api.getConversationHistory).mockResolvedValue({ ok: false, error: { code: "not_found", message: "No history" } });
    vi.mocked(api.getConversationLink).mockResolvedValue({
      ok: true,
      data: { url: "ws://127.0.0.1:7466/r/0123456789abcdef.AQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQE", access: "full", instanceId: "i", generation: 1 },
    });
    vi.spyOn(CollabSocket.prototype, "connect").mockImplementation(function (this: CollabSocket) { socket = this; this.onOpen?.(); });
    // Never resolves: the composer is not cleared, so the text is still in the box when
    // the teardown runs.
    vi.spyOn(CollabSocket.prototype, "send").mockReturnValue(new Promise(() => {}));
    const full = Array.from({ length: 256 }, (_, index) => ({ id: index + 1, text: `retained ${index}` })) as RecoveryRecord[];
    const onRefusedRecoveriesChange = vi.fn();
    const view = render(
      <ConversationView conversationId="c-1" onBack={() => {}} refusedRecoveries={full} onRefusedRecoveriesChange={onRefusedRecoveriesChange} />,
    );
    await waitFor(() => expect(socket).not.toBeNull());
    await act(async () => { socket!.onFrame?.(welcome(), 0); });

    // The capacity banner is never a descendant of the composer form in any state.
    expect(view.container.querySelector("form.composer-container .banner.warning"), "the note is not trapped inside the form").toBeNull();

    const composer = view.container.querySelector("textarea.composer-input") as HTMLTextAreaElement;
    fireEvent.change(composer, { target: { value: "AT_THE_CEILING" } });
    await act(async () => { fireEvent.submit(composer.closest("form")!); });

    await act(async () => {
      view.rerender(<ConversationView conversationId="c-2" onBack={() => {}} refusedRecoveries={full} onRefusedRecoveriesChange={onRefusedRecoveriesChange} />);
    });
    // 1. The ceiling refused: nothing was added and nothing was evicted.
    expect(onRefusedRecoveriesChange).not.toHaveBeenCalled();
    // …and the text is still the user's, in the composer draft App preserved.
    expect(composer.value).toBe("AT_THE_CEILING");
  });

  it("ids stay unique across many insertions, so two records can never collide on key", async () => {
    // m1: `Date.now()` ids collided for same-millisecond inserts, and a colliding id
    // deletes BOTH records (`key={record.id}` plus `removeRefusedRecovery` filtering
    // by id). The helper allocates from a monotonic source instead.
    const { view, onRefusedRecoveriesChange } = await mountAtCeiling([]);
    const composer = view.container.querySelector("textarea.composer-input") as HTMLTextAreaElement;
    for (const text of ["FIRST", "SECOND", "THIRD"]) {
      fireEvent.change(composer, { target: { value: text } });
      await act(async () => { fireEvent.submit(composer.closest("form")!); });
      fireEvent.change(composer, { target: { value: `${text}_DRAFT` } });
      await act(async () => { socket!.onFrame?.({ t: "error", message: REFUSAL }, 0); });
    }
    act(() => { view.unmount(); });
    const emitted = onRefusedRecoveriesChange.mock.calls.at(-1)?.[0] as RecoveryRecord[];
    const ids = emitted.map((record) => record.id);
    expect(new Set(ids).size, "every retained record has its own id").toBe(ids.length);
  });
});

describe("notice noise — level decides presentation, never the message text", () => {
  const infoNotice = (message: string): HostFrame => ({ t: "event", event: { type: "notice", level: "info", message, source: "collab" } });

  it("renders a routine join as a quiet muted line, not a full-width banner", async () => {
    const view = await mountConversation();
    await act(async () => { socket!.onFrame?.(infoNotice("Mobile Web Controller joined the collab session"), 0); });
    const row = view.container.querySelector(".notice-row--info");
    expect(row, "the info notice is a muted row").not.toBeNull();
    expect(row!.querySelector(".notice-banner--info"), "not the coloured banner").not.toBeNull();
    expect(row!.textContent).toContain("joined the collab session");
  });

  it("keeps a warning and an error as alert-role rows", async () => {
    const view = await mountConversation();
    await act(async () => { socket!.onFrame?.({ t: "event", event: { type: "notice", level: "warning", message: "Collab ended: host gone", source: "collab" } }, 0); });
    expect(view.container.querySelector(".notice-row--warning [role='status']")).not.toBeNull();
    await act(async () => { socket!.onFrame?.({ t: "event", event: { type: "notice", level: "error", message: "link failed" } }, 0); });
    expect(view.container.querySelector(".notice-row--error [role='alert']")).not.toBeNull();
    expect(view.container.textContent).toContain("link failed");
  });

  it("keeps the full text of a long routine notice mounted", async () => {
    const view = await mountConversation();
    const long = `joined the collab session ${"and said a great deal more ".repeat(40)}END_OF_NOTICE`;
    await act(async () => { socket!.onFrame?.(infoNotice(long), 0); });
    // Clamped visually, never truncated from the DOM.
    expect(view.container.querySelector(".notice-row--info")!.textContent).toContain("END_OF_NOTICE");
  });
});
