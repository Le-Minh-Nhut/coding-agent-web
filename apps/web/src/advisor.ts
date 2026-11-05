/**
 * Advisor notes, read from the session's own history.
 *
 * OMP persists every advisor turn as a `custom_message` whose `details.notes` is
 * a structured list (`packages/tui/src/chat/messages.ts:295-309`):
 *
 *   { note: string, severity?: "nit"|"concern"|"blocker", advisor?: string,
 *     turn?: number, turnsAgo?: number }
 *
 * The Collab wire replicates `custom_message` entries, so these arrive with no
 * new transport and no new server work. This module is the one place that
 * interprets them, so the chat card and the advisor panel cannot disagree about
 * what a note says or how severe it is.
 *
 * Two rules, both about not overstating:
 *  - a missing or unrecognised severity is `nit`, never something worse, because
 *    guessing upward would make a blocker out of noise;
 *  - nothing here infers that the advisor is *enabled*. Notes prove it ran; the
 *    enable flag is not on this transport at all.
 */
import { isRecord } from "./guest-tools.js";

/** Severities OMP emits, weakest first (`packages/tui/src/chat/messages.ts:289`). */
export const ADVISOR_SEVERITIES = ["nit", "concern", "blocker"] as const;
export type AdvisorSeverity = (typeof ADVISOR_SEVERITIES)[number];

export interface AdvisorNote {
  note: string;
  severity: AdvisorSeverity;
  /** Which configured advisor produced it; `null` for the default advisor. */
  advisor: string | null;
  /** Turns elapsed before a merged batch delivered it; `null` when OMP omitted it. */
  turnsAgo: number | null;
}

export interface AdvisorSummary {
  notes: AdvisorNote[];
  /** Distinct advisor names that produced notes, in first-seen order. */
  advisors: string[];
  /**
   * True when a recorded note is a blocker.
   *
   * Deliberately *not* called "active" or "current": these are notes OMP wrote
   * into the transcript, which may be minutes or hours old. Nothing here knows
   * whether the advisor is enabled or still running — that state is not on this
   * transport at all — so this flag may only ever drive "a blocker was recorded",
   * never "something is wrong right now".
   */
  hasBlocker: boolean;
}

function severityOf(raw: unknown): AdvisorSeverity {
  return typeof raw === "string" && (ADVISOR_SEVERITIES as readonly string[]).includes(raw)
    ? (raw as AdvisorSeverity)
    : "nit";
}

/**
 * Notes carried by one transcript row, or `[]` when it is not an advisor card.
 *
 * A malformed entry is dropped rather than rendered as an empty note: an advisor
 * card with a blank body would look like an advisor that had nothing to say.
 */
export function advisorNotesOf(entry: { customType?: string; details?: unknown }): AdvisorNote[] {
  if (entry.customType !== "advisor" || !isRecord(entry.details)) return [];
  const raw = entry.details.notes;
  if (!Array.isArray(raw)) return [];
  const notes: AdvisorNote[] = [];
  for (const item of raw) {
    if (!isRecord(item)) continue;
    const text = typeof item.note === "string" ? item.note : null;
    if (text === null || text.trim() === "") continue;
    notes.push({
      note: text,
      severity: severityOf(item.severity),
      advisor: typeof item.advisor === "string" && item.advisor !== "" ? item.advisor : null,
      turnsAgo: typeof item.turnsAgo === "number" && Number.isFinite(item.turnsAgo) ? item.turnsAgo : null,
    });
  }
  return notes;
}

/**
 * Every advisor note in a transcript, newest last, with the advisor names seen.
 *
 * Order is the transcript's own; the panel sorts for display, and a caller that
 * wants chronological order gets it here without re-sorting.
 */
export function summarizeAdvisorNotes(rows: readonly { customType?: string; details?: unknown }[]): AdvisorSummary {
  const notes: AdvisorNote[] = [];
  const advisors: string[] = [];
  for (const row of rows) {
    for (const note of advisorNotesOf(row)) {
      notes.push(note);
      if (note.advisor !== null && !advisors.includes(note.advisor)) advisors.push(note.advisor);
    }
  }
  return { notes, advisors, hasBlocker: notes.some((note) => note.severity === "blocker") };
}
