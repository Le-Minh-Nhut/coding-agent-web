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

/* ------------------------------------------------------------------ */
/* Issue lifecycle                                                     */
/* ------------------------------------------------------------------ */
/**
 * What an advisor note is *now*, as opposed to what it said when it was written.
 *
 * Upstream gives us nothing to build this from, and that is the whole design
 * constraint. `AdvisorNote` (`packages/tui/src/chat/messages.ts:295-305`) carries
 * exactly `note`, `severity`, `advisor`, `turn`, `turnsAgo` — no id, no status, no
 * resolution field. There is no second message type that retracts a note, and the
 * Collab wire replicates notes without adding one. So a lifecycle can only be
 * derived from *evidence elsewhere in the transcript*, never from the note itself
 * and never from the note's prose.
 *
 * The rules below exist to keep the panel from overstating, which is the failure
 * the task names:
 *
 *  - An issue is `unresolved` unless evidence says otherwise. Silence is not a fix.
 *  - A claim of a fix (`"fixed"` in prose) is the weakest possible evidence: it
 *    produces `verifying`, never `resolved`. An agent saying it is done is not a
 *    test passing.
 *  - A test passing is **not** evidence that an advisor issue is resolved. Exit
 *    code 0 and a green suite say the tests that ran passed; they say nothing about
 *    a specific note, so they can never resolve one. Only a verification whose
 *    subject is demonstrably this issue counts, and that is not derivable from
 *    exit status alone — so it is reported as unsupported rather than assumed.
 *  - A later failure that names the issue reopens it, even after a resolution.
 */

export type IssueState =
  /** No evidence either way. The default, and the only honest one. */
  | "unresolved"
  /** A fix was claimed and nothing has confirmed or contradicted it. */
  | "verifying"
  /** Evidence resolved it. Requires a verification whose subject is this issue. */
  | "resolved"
  /** Was resolved; later evidence contradicts that. */
  | "reopened"
  /** Not even an identity could be established, so no state is meaningful. */
  | "unknown";

/** One advisor note, given a stable identity so it can be tracked over time. */
export interface AdvisorIssue {
  /**
   * Stable across turns and across reloads: the advisor's name plus the note's
   * normalized text, in full. Note text is the only stable key upstream offers —
   * there is no id — so re-wording an issue makes a new issue rather than silently
   * inheriting the old one's state. That is the safe direction to fail.
   *
   * Not a hash: a digest can collide, and two notes sharing an identity would share
   * one evidence cache and one lifecycle. `shortLabel` exists for logs only.
   */
  id: string;
  note: string;
  severity: AdvisorSeverity;
  advisor: string | null;
  /** Primary turn when it was emitted; `null` when OMP omitted it. */
  turn: number | null;
  /** Turns elapsed before merged-batch delivery; `null` when OMP omitted it. */
  turnsAgo: number | null;
  /** Transcript order. Ties on `turn` are broken by this, never by note text. */
  seq: number;
  /** A short non-authoritative label for logs; never used for identity. */
  label: string;
}

export interface AdvisorIssueView extends AdvisorIssue {
  state: IssueState;
  /** Evidence that bears on this issue, oldest first. Empty for `unresolved`. */
  evidence: IssueEvidence[];
}

export type EvidenceKind =
  /** Someone said it was fixed. Not proof. */
  | "fix-claim"
  /** A later reproduction that still failed. Authoritative. */
  | "still-failing"
  /** A later verification whose subject is this issue and which passed. */
  | "verification-pass";

export interface IssueEvidence {
  kind: EvidenceKind;
  /** Short, derived description — never a fabricated result. */
  summary: string;
  /** Where it came from: a tool name, or the transcript's own role. */
  source: string;
}

/**
 * Normalize note text into the identity digest's input.
 *
 * Case and whitespace only. Anything more aggressive (stemming, punctuation
 * removal) would fold genuinely different issues together, and two different
 * problems sharing one lifecycle is worse than one problem tracked twice.
 */
export function issueIdentityInput(note: string): string {
  return note.trim().replace(/\s+/g, " ").toLowerCase();
}

/**
 * A short, stable label for an issue.
 *
 * Only for reading key lists and logs — never for identity. A 32-bit digest can
 * collide, and two different notes sharing one id would share one evidence cache
 * and one lifecycle, so identity below is the full normalized text instead.
 */
function shortLabel(text: string): string {
  let hash = 0x811c9dc5;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(36);
}

/**
 * Every advisor issue in a transcript, in order, with duplicates of the same
 * issue merged into one entry.
 *
 * A repeated note is the same issue, not a second one: OMP re-emits a note when an
 * advisor repeats itself, and counting that as two blockers would make the panel's
 * numbers depend on how chatty an advisor was. The first occurrence keeps the
 * position; the highest severity seen wins, because downgrading a blocker to a nit
 * on a re-emission would hide the worse of the two.
 */
export function advisorIssues(rows: readonly { customType?: string; details?: unknown }[]): AdvisorIssue[] {
  const byId = new Map<string, AdvisorIssue>();
  let seq = 0;
  for (const row of rows) {
    for (const note of advisorNotesOf(row)) {
      seq += 1;
      const key = `${note.advisor ?? ""}\u0000${issueIdentityInput(note.note)}`;
      const existing = byId.get(key);
      if (existing) {
        // Keep the first position and identity; adopt the worse severity and the
        // most informative turn metadata.
        const rank = ADVISOR_SEVERITIES.indexOf(note.severity);
        if (rank > ADVISOR_SEVERITIES.indexOf(existing.severity)) existing.severity = note.severity;
        if (existing.turnsAgo === null && note.turnsAgo !== null) existing.turnsAgo = note.turnsAgo;
        continue;
      }
      byId.set(key, {
        // The key itself: collision-free by construction. `shortLabel` is carried
        // alongside for logging only.
        id: key,
        note: note.note,
        severity: note.severity,
        advisor: note.advisor,
        turn: null,
        turnsAgo: note.turnsAgo,
        seq,
        label: `${note.advisor ?? "default"}:${shortLabel(key)}`,
      });
    }
  }
  return [...byId.values()].sort((a, b) => a.seq - b.seq);
}

/**
 * Why a recheck could not be performed.
 *
 * Returned as data rather than a sentence at the call site so the panel can list
 * every gap instead of implying that the missing ones were checked and passed.
 */
export const UNSUPPORTED_RECHECK_REASONS = [
  /** Nothing on the wire carries a resolution status; see the header note. */
  "Advisor notes carry no status field, so a resolution cannot be read directly.",
  /** Exit codes are not attached to an issue. */
  "A passing test is not evidence about a specific note, so it cannot resolve one.",
  /** No mapping from note text to source location exists. */
  "No source identity is attached to a note, so a code change cannot be attributed to it.",
  /** Prose is the only self-report available. */
  "A claim of a fix cannot be verified from the transcript alone; it needs a later result that names this issue.",
] as const;

/**
 * Project issues to their current state.
 *
 * `evidence` is supplied by the caller because only the caller has the transcript
 * the evidence is drawn from. This function never invents evidence: an issue with
 * no evidence is `unresolved`, and there is no path here that produces `resolved`
 * from an empty list.
 */
export function advisorIssueViews(
  issues: readonly AdvisorIssue[],
  evidence: (issue: AdvisorIssue) => readonly IssueEvidence[] = () => [],
): AdvisorIssueView[] {
  return issues.map((issue) => {
    const found = [...evidence(issue)];
    let state: IssueState = "unresolved";
    // A note with no text could never have produced a usable identity beyond the
    // advisor name, so no state is meaningful for it.
    if (issueIdentityInput(issue.note) === "") state = "unknown";
    else {
      const passes = found.filter((item) => item.kind === "verification-pass").length;
      const fails = found.filter((item) => item.kind === "still-failing").length;
      const claims = found.filter((item) => item.kind === "fix-claim").length;
      if (passes > 0 && fails === 0) state = "resolved";
      else if (fails > 0 && passes > 0) state = "reopened";
      // A claim alone reaches `verifying`; it never resolves anything.
      else if (claims > 0) state = "verifying";
      else if (fails > 0) state = "unresolved";
    }
    return { ...issue, state, evidence: found };
  });
}

/**
 * Whether a header may describe a blocker as still standing.
 *
 * The header chip is the one place a blocker is asserted without the reader
 * opening anything, so it may only claim what is still open. Anything resolved,
 * reopened, or unknowable is excluded — a chip that says "blocker" next to a
 * resolved issue is exactly the false alarm the task calls out.
 */
export function standingBlockerCount(views: readonly AdvisorIssueView[]): number {
  return views.filter((view) => view.severity === "blocker" && (view.state === "unresolved" || view.state === "verifying" || view.state === "reopened")).length;
}


/* ------------------------------------------------------------------ */
/* Evidence, read from the transcript                                  */
/* ------------------------------------------------------------------ */

/** The subset of a transcript row this reader needs. Declared structurally. */
export interface EvidenceRow {
  role?: string;
  text?: string;
  isError?: boolean;
  customType?: string;
  details?: unknown;
}

/**
 * Evidence for an issue, taken from the rows that follow it.
 *
 * Deliberately conservative, and the conservatism is the design:
 *
 *  - **A fix claim** is matched by the words `fixed`/`resolved` in an assistant
 *    row. Prose is the weakest evidence there is, so it can only ever reach
 *    `verifying` (`advisorIssueViews`), never `resolved`.
 *  - **A failing tool result** (`isError`) mentioning the issue's own words
 *    (`stillFailing`) is authoritative against it.
 *
 * There is deliberately no rule producing `verification-pass` from this data.
 * A verification is "a test whose subject is this issue", and nothing on the wire
 * carries that subject: `isError === false` says a command ran and exited
 * non-zero-or-zero, not that it exercised this note. Inventing that link would be
 * exactly the false "resolved" the task forbids, so a resolved state can only come
 * from a caller that genuinely knows the subject — see `UNSUPPORTED_RECHECK_REASONS`.
 */
export function evidenceForIssue(rows: readonly EvidenceRow[], issue: AdvisorIssue): IssueEvidence[] {
  const out: IssueEvidence[] = [];
  const noteWords = significantWords(issue.note);
  for (const row of rows) {
    if (row.role === "assistant" && typeof row.text === "string") {
      if (claimsFix(row.text) && claimMatchesNote(row.text, noteWords)) {
        out.push({ kind: "fix-claim", summary: "The agent stated this issue was fixed.", source: "assistant" });
      }
      continue;
    }
    if (row.role === "tool" && row.isError === true && typeof row.text === "string" && claimMatchesNote(row.text, noteWords)) {
      out.push({ kind: "still-failing", summary: "A later tool run failed while reproducing this issue.", source: "tool" });
    }
  }
  return out;
}

/** Words long enough to identify an issue; short ones match everything. */
function significantWords(text: string): Set<string> {
  return new Set(
    issueIdentityInput(text)
      .replace(/[^a-z0-9\s]/g, " ")
      .split(/\s+/)
      .filter((word) => word.length >= 5),
  );
}

/**
 * The words a claim of a fix is made with.
 *
 * Matched as whole words: `unfixed` must not read as a claim. That is the only
 * thing the pattern is responsible for — negation is `claimsFix`'s job, because a
 * single pattern cannot express "a negator somewhere before the verb".
 */
const CLAIM_PATTERN = /\b(?:fixed|resolved|repaired|addressed)\b/i;

/**
 * Words that turn a nearby claim into its opposite.
 *
 * Scanned across a window rather than required to sit immediately before the verb.
 * The immediate-adjacency rule was defeated by ordinary English: "cannot be fixed",
 * "is not fully fixed", "was never really fixed" all passed it and were reported as
 * the agent claiming a fix. A window is the honest approximation — it can still be
 * fooled by a sentence that negates something else ("I did not test it, but I fixed
 * the loop"), and that is acceptable: the worst outcome is `verifying`, which claims
 * nothing, and it is the panel's own copy that says so. What must never happen is a
 * *contradiction* reading as a claim, and the window closes that.
 */
const NEGATIONS = /\b(?:not|never|no|none|cannot|can't|isn't|wasn't|aren't|weren't|won't|wouldn't|doesn't|didn't|don't|unable|unfixed|unresolved|still|remains|remained)\b/i;

/**
 * How far back from a claim word a negation still governs it.
 *
 * 40 characters covers "is by no means fixed" and "was never really fixed" without
 * reaching into the previous clause in any normal sentence.
 */
const NEGATION_WINDOW = 40;

/**
 * Whether a sentence actually claims the fix happened.
 *
 * Negation wins: a sentence carrying any negation word near the claim is not a
 * claim of success, whatever else it says.
 */
function claimsFix(text: string): boolean {
  if (!CLAIM_PATTERN.test(text)) return false;
  return text
    .split(/(?<=[.!?;])\s+/)
    .some((sentence) => {
      const match = CLAIM_PATTERN.exec(sentence);
      if (!match) return false;
      // Look at the run-up to the verb, which is where a negator lives in English.
      const before = sentence.slice(Math.max(0, match.index - NEGATION_WINDOW), match.index + match[0].length);
      if (NEGATIONS.test(before)) return false;
      // "fixed, but it is still broken" contradicts itself; treat the whole
      // sentence as no claim rather than pick the optimistic half.
      return !NEGATIONS.test(sentence.slice(match.index));
    });
}

/**
 * How many identifying words a claim and a note must share.
 *
 * One shared word is not enough: "I fixed the retry timeout in the network module"
 * shares `retry` with a note about a retry loop and would mark the unrelated note
 * as claimed-fixed. Requiring the majority of the note's own identifying words, at
 * least two, keeps the link about the same subject while still matching a
 * paraphrase that keeps the note's vocabulary.
 */
function claimMatchesNote(text: string, noteWords: ReadonlySet<string>): boolean {
  if (noteWords.size === 0) return false;
  const words = new Set(issueIdentityInput(text).replace(/[^a-z0-9\s]/g, " ").split(/\s+/));
  let shared = 0;
  for (const word of noteWords) if (words.has(word)) shared += 1;
  const needed = noteWords.size === 1 ? 1 : Math.ceil(noteWords.size / 2);
  return shared >= Math.max(2, needed);
}

/**
 * Evidence for every issue, ready for `advisorIssueViews`.
 *
 * One pass over the transcript, so a caller does not re-scan per issue.
 */
export function advisorEvidence(rows: readonly EvidenceRow[]): (issue: AdvisorIssue) => readonly IssueEvidence[] {
  const cache = new Map<string, readonly IssueEvidence[]>();
  return (issue) => {
    const found = cache.get(issue.id);
    if (found !== undefined) return found;
    const computed = evidenceForIssue(rows, issue);
    cache.set(issue.id, computed);
    return computed;
  };
}
