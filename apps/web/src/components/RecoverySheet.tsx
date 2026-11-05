/**
 * The bounded recovery sheet.
 *
 * Why it exists
 * -------------
 * Refused/unacknowledged prompts used to render as full-width banners in the
 * conversation column, each carrying the COMPLETE prompt text. A long prompt
 * therefore consumed the viewport above the transcript, and because
 * `.conversation-screen` is `height: 100dvh; overflow: hidden`, the transcript
 * behind it was unreachable until a reload (P1-A). The transcript is the surface
 * the user came for, so it must never be displaced by a record about a prompt
 * the host rejected.
 *
 * The fix is not to show less of the record — deleting the only copy of a prompt
 * is exactly the loss the strip was added to prevent. It is to show the summary
 * where the record does not compete with the transcript (one compact row), and
 * the full text in a modal that owns the viewport while it is open. `ModalOverlay`
 * brings the focus trap and Escape handling, so nothing about that contract is
 * re-implemented here.
 *
 * Honesty
 * -------
 * The three status labels are the ones the existing code already used, verbatim:
 * a record is `Unconfirmed` (host receipt unknown — it may already have run),
 * `Echoed` (a live echo proved the host saw it) or `Refused` (the host declined).
 * Nothing here re-derives or upgrades a status, and every record states its own
 * uncertainty rather than being averaged into one number.
 */
import { ModalOverlay } from "./ModalOverlay.js";
import type { RecoveryRecord } from "../prompt-recovery.js";

export interface RecoverySheetProps {
  records: readonly RecoveryRecord[];
  /** Copy reads this record's text; the sheet owns only the "copied" label. */
  copyState: { id: number; state: "copied" | "failed" } | null;
  /**
   * Recover writes the composer draft, so it is offered only while the composer is
   * writable: staging text into a hidden composer would silently overwrite the
   * App-owned draft, which may hold newer work.
   */
  canRecover: boolean;
  onCopy(record: RecoveryRecord): void;
  onRecover(record: RecoveryRecord): void;
  onDismiss(record: RecoveryRecord): void;
  onClose(): void;
}

/** The status word and its explanation, exactly as the inline strip stated them. */
export function recoveryStatusLabel(record: RecoveryRecord): string {
  if (record.unconfirmed) return "Unconfirmed";
  if (record.echoed) return "Echoed";
  return "Refused";
}

export function recoveryStatusDetail(record: RecoveryRecord): string {
  if (record.unconfirmed) return "Host receipt unknown; this prompt may already have executed.";
  if (record.echoed) return "The host echoed this text during the live session.";
  return "The host declined this prompt; nothing was submitted.";
}

export function RecoverySheet({ records, copyState, canRecover, onCopy, onRecover, onDismiss, onClose }: RecoverySheetProps) {
  return (
    <ModalOverlay onClose={onClose} aria-labelledby="recovery-sheet-title" overlayProps={{ className: "modal-overlay recovery-sheet-overlay" }}>
      <section className="modal-content recovery-sheet" aria-labelledby="recovery-sheet-title">
        <header className="recovery-sheet-head">
          <h3 id="recovery-sheet-title" style={{ fontSize: "1rem" }}>
            Prompts needing review ({records.length})
          </h3>
          <button type="button" className="ghost" aria-label="Close prompt review" onClick={onClose}>
            ✕
          </button>
        </header>
        <p className="recovery-sheet-note" role="note">
          These prompts were never acknowledged by the host. Nothing is resent automatically; recover
          one into the composer to send it yourself, or copy it before dismissing.
        </p>
        <ul className="recovery-sheet-list">
          {records.map((record) => (
            <li key={record.id} className="recovery-record">
              <div className="recovery-record-head">
                <span className={`badge ${record.unconfirmed ? "warning" : record.echoed ? "idle" : "error"}`}>{recoveryStatusLabel(record)}</span>
                <span className="recovery-record-detail">{recoveryStatusDetail(record)}</span>
              </div>
              {/* The COMPLETE original text, verbatim and unwrapped-clipped: this is
                  the only place the full copy is available once the composer has newer
                  content, so it is never truncated to a preview. */}
              <pre className="recovery-record-text"><code>{record.text}</code></pre>
              <div className="recovery-record-actions">
                {canRecover && (
                  <button type="button" className="ghost" onClick={() => onRecover(record)}>
                    Recover to draft
                  </button>
                )}
                <button type="button" className="ghost" onClick={() => onCopy(record)}>
                  {copyState?.id === record.id ? (copyState.state === "copied" ? "Copied" : "Copy failed") : "Copy"}
                </button>
                <button type="button" className="ghost" onClick={() => onDismiss(record)}>
                  Dismiss
                </button>
              </div>
            </li>
          ))}
        </ul>
      </section>
    </ModalOverlay>
  );
}
