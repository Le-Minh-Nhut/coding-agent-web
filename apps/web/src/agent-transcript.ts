/**
 * Native OMP journal → conversation rows.
 *
 * The agent-detail view fetches an agent's *own* session journal over the wire
 * (`fetch-transcript` / `transcript`, `packages/collab-protocol/src/types.ts:248,269`)
 * and must render it like the conversation, not as raw text. This module is the one
 * place that turns those bytes into rows, so the view never sees JSONL and the
 * conversation reducer (`transcript.ts`) is never forked.
 *
 * Two measured facts drive the design:
 *
 *  - The reply carries complete lines in `text` and the trailing partial line in
 *    `carry` — `applyTranscript` splits them exactly that way
 *    (`apps/web/src/transcript.ts:609-613`). `carry` is a *prefix of a record*, never
 *    a record, so it is never parsed here. Parsing it would emit a row for half a
 *    line and then emit the same record again, whole, on the next poll.
 *  - A native journal holds record kinds the collab host filters out before sending
 *    (`WIRE_SESSION_ENTRY_TYPES`, upstream `packages/coding-agent/src/collab/host.ts:103-110`):
 *    the 255-byte `title` slot, the `session` header, `session_init`, `model_usage`
 *    and the `custom` bookkeeping records. They are decoded — so a malformed one is
 *    *counted*, never silently dropped — but they build no rows: their own text is
 *    internal. The two that do carry user-facing facts
 *    (`session_init.task`/`.agent`/`.resolvedModel` and `model_change.model`) are
 *    read as fields, never rendered as prose.
 */
import type { SessionEntry } from "@caw/collab-protocol";
import { transcriptMessagesFromEntries, type TranscriptMessage, type TranscriptReply } from "./transcript.js";

/** Everything the agent-detail view derives from one transcript reply. */
export interface AgentTranscript {
  rows: TranscriptMessage[];
  /** Last `model_change.model`, else `session_init.resolvedModel`; `null` when neither was recorded. */
  model: string | null;
  /** `session_init.task`, verbatim. `null` when the journal carried no init record. */
  task: string | null;
  /** `session_init.agent` — the agent definition name, e.g. `scout`. `null` when absent. */
  agentName: string | null;
  /**
   * Non-blank lines that were not a JSON object. Surfaced rather than swallowed:
   * "this journal has N records I could not read" and "this agent said nothing"
   * must not render the same way.
   */
  unreadableRecords: number;
  /** `false` while a trailing partial line is still pending in `carry`. */
  complete: boolean;
}

/**
 * Decode JSONL text into records, skipping blank lines and never throwing.
 *
 * A line counts as unreadable when it is not a JSON object — it fails to parse, or
 * it parses to `null`, a scalar, or an array. Blank lines are skipped without being
 * counted: the first line of every journal is the fixed-width `title` slot and the
 * last line of a chunk often trails, and neither is a record that went missing.
 */
export function parseNativeEntries(text: string): { entries: unknown[]; unreadableRecords: number } {
  const entries: unknown[] = [];
  let unreadableRecords = 0;
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (trimmed === "") continue;
    let decoded: unknown;
    try {
      decoded = JSON.parse(trimmed);
    } catch {
      unreadableRecords += 1;
      continue;
    }
    if (decoded === null || typeof decoded !== "object" || Array.isArray(decoded)) {
      unreadableRecords += 1;
      continue;
    }
    entries.push(decoded);
  }
  return { entries, unreadableRecords };
}

/**
 * Rows for one agent's journal, built by the conversation reducer's own
 * `transcriptMessagesFromEntries` rather than a second implementation, so a subagent
 * transcript and the conversation cannot drift apart.
 *
 * The cast is the JSON boundary the vendored wire types describe: these values came
 * from `JSON.parse`, and `SessionEntry` covers the kinds this client renders.
 * `displayMessage` skips every kind it does not know, so an unrecognised record
 * produces no row instead of a wrong one.
 */
export function nativeRows(entries: readonly unknown[]): TranscriptMessage[] {
  return transcriptMessagesFromEntries(entries as readonly SessionEntry[]);
}

/** `session_init`, the one native-only record whose fields the view displays. */
interface SessionInitFields {
  task: string | null;
  agent: string | null;
  resolvedModel: string | null;
}

function sessionInitOf(record: unknown): SessionInitFields | null {
  if (record === null || typeof record !== "object") return null;
  if (!("type" in record) || record.type !== "session_init") return null;
  return {
    task: ("task" in record && typeof record.task === "string" ? record.task : null),
    agent: ("agent" in record && typeof record.agent === "string" ? record.agent : null),
    resolvedModel: ("resolvedModel" in record && typeof record.resolvedModel === "string" ? record.resolvedModel : null),
  };
}

function modelChangeOf(record: unknown): string | null {
  if (record === null || typeof record !== "object") return null;
  if (!("type" in record) || record.type !== "model_change") return null;
  return "model" in record && typeof record.model === "string" && record.model !== "" ? record.model : null;
}

/**
 * One reply's worth of agent-detail data.
 *
 * `reply.text` is the only thing parsed. `carry` sets `complete` and nothing else,
 * which is what makes repeated polling idempotent: an unchanged cursor re-delivers
 * the same bytes, re-parsing them yields the same rows, and the pending partial
 * never becomes a row until it arrives whole.
 */
export function agentTranscriptFromReply(reply: TranscriptReply): AgentTranscript {
  const { entries, unreadableRecords } = parseNativeEntries(reply.text);
  // A later record supersedes an earlier one: the journal is append-only, so the
  // last model_change is the model the session is on now.
  let model: string | null = null;
  let sessionResolved: string | null = null;
  let task: string | null = null;
  let agentName: string | null = null;
  for (const entry of entries) {
    const changed = modelChangeOf(entry);
    if (changed !== null) model = changed;
    const init = sessionInitOf(entry);
    if (init !== null) {
      if (init.resolvedModel !== null) sessionResolved = init.resolvedModel;
      if (init.task !== null) task = init.task;
      if (init.agent !== null) agentName = init.agent;
    }
  }
  return {
    rows: nativeRows(entries),
    model: model ?? sessionResolved,
    task,
    agentName,
    unreadableRecords,
    complete: (reply.carry ?? "") === "",
  };
}
