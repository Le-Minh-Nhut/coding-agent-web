/**
 * Shared helper for opening the prompt-review sheet in tests.
 *
 * Refused/unacknowledged prompts used to be rendered as full-width banners whose
 * complete text sat in the conversation column — which is the P1-A defect (a long
 * prompt displaced the transcript in a `100dvh; overflow: hidden` screen). They
 * are a bounded summary row plus a modal sheet now, so a test that wants to read a
 * record, or act on one, must first open the sheet.
 *
 * Keeping the open sequence in one place means the next move of this UI is one
 * edit here instead of thirty across the auditors. Callers keep every assertion
 * they had — only the way the records are revealed changes, exactly as
 * `model-sheet.ts` did for the model controls in round 51.
 */
import { fireEvent, screen } from "@testing-library/react";

/**
 * m7: the query surface every caller actually holds.
 *
 * The helpers previously took `Pick<Queries, "getByRole" | "queryByRole">`, which
 * the tests' `RenderResult` does not satisfy — the module's own callers were type
 * errors waiting to be noticed. Both `screen` and any `RenderResult` satisfy this
 * structural shape, and the `name` accepts the RegExp callers pass.
 */
type ButtonQueries = {
  getByRole: (role: string, options?: { name?: string | RegExp }) => HTMLElement;
  queryByRole: (role: string, options?: { name?: string | RegExp }) => HTMLElement | null;
};

/** The summary row, when at least one record is retained. */
export function recoverySummary(view?: ButtonQueries): HTMLElement | null {
  const ui = view ?? screen;
  return ui.queryByRole("button", { name: /prompts? need(s)? review/i });
}

/**
 * Open the review sheet through the real user path: the summary row.
 *
 * Throws when no record is retained — a caller that expects a sheet is asserting
 * something about the app, and a silently absent sheet would turn that into a
 * confusing downstream failure instead.
 */
export function openRecoverySheet(view?: ButtonQueries): void {
  const ui = view ?? screen;
  const summary = ui.queryByRole("button", { name: /prompts? need(s)? review/i });
  if (summary === null) throw new Error("no recovery summary row: nothing is retained");
  fireEvent.click(summary);
}

/** The open sheet's records, in the order the app renders them. */
export function recoveryRecords(container: HTMLElement): HTMLElement[] {
  return [...container.querySelectorAll<HTMLElement>(".recovery-record")];
}

/**
 * Every retained record's status label and complete text, joined.
 *
 * This is the shape the tests care about — which record says what — without
 * depending on the exact prose of the sheet's status explanation.
 */
export function recoveryText(container: HTMLElement): string {
  return recoveryRecords(container)
    .map((record) => {
      const label = record.querySelector(".recovery-record .badge")?.textContent ?? "";
      const text = record.querySelector(".recovery-record-text")?.textContent ?? "";
      return `${label} — ${text}`;
    })
    .join("\n");
}
