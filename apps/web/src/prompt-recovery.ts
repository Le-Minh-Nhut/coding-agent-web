/**
 * Retention for prompts the host did not acknowledge.
 *
 * Why this module exists
 * ----------------------
 * A refused or unacknowledged prompt is the only copy of the user's text. The
 * app kept it in React state, so a page reload (or an iOS process eviction)
 * destroyed it silently — the exact loss the recovery UI exists to prevent. The
 * contract (`docs/architecture/prompt-state-and-retention-contract.md`) names
 * tab-scoped persistence as the fix, and this is it.
 *
 * What is persisted, and what is deliberately not
 * ----------------------------------------------
 * **Only** the recovery records: the text, its status flags and the conversation
 * id they belong to. Never the Collab link (it is a bearer credential — a
 * script-readable copy would outlive the component that holds it and widen the
 * XSS/blame window documented in `docs/architecture/security-model.md`), never
 * the transcript, never drafts. `sessionStorage` rather than `localStorage`: it
 * dies with the tab, so a closed tab leaves nothing behind on a shared device.
 *
 * Capacity
 * --------
 * The same limits the vendored guest client enforces
 * (`packages/guest/src/lib/client.ts:147,149`) — 256 records, 1 MiB of retained
 * text — applied to *retention* rather than to the send. A record that does not
 * fit is refused with a message the user can act on; nothing is silently evicted,
 * because evicting is the data loss this module exists to stop.
 */

/** One retained prompt, exactly as the conversation view holds it. */
export interface RecoveryRecord {
  id: number;
  text: string;
  /** Host receipt unknown; may already have executed. */
  unconfirmed?: boolean;
  /** A live echo proved the host saw this text. */
  echoed?: boolean;
  /** The draft text a Recover merged into (dedupe for repeated activation). */
  recoveredText?: string;
}

/** Retained-record ceiling, mirroring `MAX_UNCONFIRMED_PROMPTS`. */
export const MAX_RECOVERY_RECORDS = 256;
/** Retained-text ceiling in UTF-8 bytes, mirroring `MAX_RECOVERY_BYTES`. */
export const MAX_RECOVERY_BYTES = 1_048_576;
/** One namespaced key; versioned so a shape change cannot be misread. */
export const RECOVERY_STORAGE_KEY = "caw.promptRecovery.v1";

/**
 * UTF-8 length without `TextEncoder`, which jsdom and some older WebViews do not
 * expose. Counting by code point is what "1 MiB of the user's text" means for any
 * language, and it matches the guest client's `Buffer.byteLength` accounting.
 */
export function utf8Bytes(text: string): number {
  let bytes = 0;
  for (const character of text) {
    const code = character.codePointAt(0) ?? 0;
    if (code < 0x80) bytes += 1;
    else if (code < 0x800) bytes += 2;
    else if (code < 0x10000) bytes += 3;
    else bytes += 4;
  }
  return bytes;
}

/** Total retained text, in the bytes the ceiling is measured in. */
export function recoveryBytes(records: readonly RecoveryRecord[]): number {
  let bytes = 0;
  for (const record of records) bytes += utf8Bytes(record.text);
  return bytes;
}

export type CapacityVerdict = { ok: true } | { ok: false; reason: string };

/**
 * Whether one more record may be retained.
 *
 * Checked *before* the append so the message can name the limit that was hit, and
 * separately from the send: a full recovery list must never stop the prompt
 * reaching the host.
 */
export function canRetain(records: readonly RecoveryRecord[], text: string): CapacityVerdict {
  if (records.length >= MAX_RECOVERY_RECORDS) {
    return { ok: false, reason: `recovery list is full (${MAX_RECOVERY_RECORDS} records)` };
  }
  const bytes = recoveryBytes(records) + utf8Bytes(text);
  if (bytes > MAX_RECOVERY_BYTES) {
    return { ok: false, reason: `recovery list is full (${Math.round(MAX_RECOVERY_BYTES / 1024 / 1024)} MiB of retained prompts)` };
  }
  return { ok: true };
}

/** The storage interface this module needs — narrowed so a test can pass a stub. */
export type RecoveryStorage = Pick<Storage, "getItem" | "setItem" | "removeItem">;

/**
 * The tab's sessionStorage, or `null` when it cannot be used.
 *
 * Access itself throws in a sandboxed iframe or with storage disabled, so the
 * lookup is guarded: a browser that refuses storage must not break the app, and
 * the records then live in memory exactly as they did before.
 */
export function tabStorage(): RecoveryStorage | null {
  try {
    return typeof window === "undefined" ? null : window.sessionStorage ?? null;
  } catch {
    return null;
  }
}

/**
 * A stored record only counts when the two fields the UI needs are the right
 * type. Checked per field with `typeof` rather than asserting the whole shape:
 * a blob written by an older version must be read by field, not trusted.
 */
function isRetainedRecord(value: unknown): value is RecoveryRecord {
  if (value === null || typeof value !== "object") return false;
  const candidate = value as Partial<RecoveryRecord>;
  return typeof candidate.id === "number" && Number.isFinite(candidate.id) && typeof candidate.text === "string";
}

/**
 * Read the persisted per-conversation lists.
 *
 * Anything unreadable yields `{}`: a corrupt blob must degrade to "nothing was
 * retained", never to a crash on boot and never to a partially-typed record that
 * the UI would then try to render.
 *
 * m4: before degrading, the unreadable blob is preserved verbatim under
 * `<key>.corrupt`. App's write effect would otherwise delete the key on the next
 * mount — the one path that could destroy every retained prompt at once, with no
 * copy anywhere. Keeping the raw text makes it recoverable by hand.
 */
export function readRecoveryStore(storage: RecoveryStorage | null): Record<string, RecoveryRecord[]> {
  if (storage === null) return {};
  let raw: string | null = null;
  try {
    raw = storage.getItem(RECOVERY_STORAGE_KEY);
  } catch {
    return {};
  }
  if (raw === null || raw === "") return {};
  const quarantine = (): Record<string, RecoveryRecord[]> => {
    try {
      storage.setItem(`${RECOVERY_STORAGE_KEY}.corrupt`, raw);
    } catch {
      // A storage that refuses the quarantine write has nothing more to offer.
    }
    return {};
  };
  try {
    const parsed: unknown = JSON.parse(raw);
    if (parsed === null || typeof parsed !== "object") return quarantine();
    const store: Record<string, RecoveryRecord[]> = Object.create(null) as Record<string, RecoveryRecord[]>;
    for (const [conversationId, value] of Object.entries(parsed as Record<string, unknown>)) {
      if (!Array.isArray(value)) continue;
      const records = value.filter(isRetainedRecord);
      if (records.length > 0) store[conversationId] = records;
    }
    return store;
  } catch {
    return quarantine();
  }
}

/**
 * Persist the per-conversation lists.
 *
 * An empty store removes the key outright rather than writing `{}`: nothing
 * retained means nothing on disk to leak, and a stale key would otherwise look
 * like retained state to the next boot. A storage write that fails (quota,
 * disabled) is not fatal — the in-memory records are still the truth and are
 * still on screen.
 */
export function writeRecoveryStore(storage: RecoveryStorage | null, store: Record<string, RecoveryRecord[]>): void {
  if (storage === null) return;
  try {
    const nonEmpty = Object.entries(store).filter(([, records]) => records.length > 0);
    if (nonEmpty.length === 0) {
      storage.removeItem(RECOVERY_STORAGE_KEY);
      return;
    }
    storage.setItem(RECOVERY_STORAGE_KEY, JSON.stringify(Object.fromEntries(nonEmpty)));
  } catch {
    /* Storage is a convenience, never the source of truth. */
  }
}
