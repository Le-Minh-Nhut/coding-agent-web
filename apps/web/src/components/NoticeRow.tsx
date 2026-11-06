/**
 * One protocol notice, bounded by its level.
 *
 * Why this component exists
 * -------------------------
 * The host emits an `info` notice with `source: "collab"` every time a guest joins
 * or leaves ("Mobile Web Controller joined the collab session"). It rendered as a
 * bright, full-width banner — so the 390px screen opened with a permanent blue bar
 * announcing a routine, anonymous event, and a long notice could push the
 * transcript down with no way to read it in full.
 *
 * The classification is the notice's own `level`, never its text: a host-supplied
 * message is not something to regex (steering: no regex classification, no second
 * event store, nothing deleted or hidden). Only the *presentation* changes:
 *
 *  - `error`   — an alert row (role="alert"), two rendered lines with an expander.
 *  - `warning` — the `.banner.warning` row it always was, same bounding.
 *  - `info`    — a quiet muted line, one rendered line, same expander.
 *
 * Nothing is truncated anywhere: the full message stays mounted and one tap
 * reveals it. The collapse is a `line-clamp`, so the element's `scrollHeight`
 * still reports the unclipped height — which is how the expander knows it is
 * needed at all.
 */
import { useEffect, useId, useLayoutEffect, useRef, useState } from "react";

/**
 * How long a routine `info` notice stays on screen.
 *
 * A Collab join is a transient fact, not a status: "Mobile Web Controller joined
 * the collab session" is true for a moment and then is not news. It used to stay
 * until the transport replaced it, which on a healthy long-lived link means forever
 * — a permanent strip above the transcript reporting something that already
 * happened. Warnings and errors are never auto-dismissed: those are the two levels
 * that can still require action, so the reader decides when they go.
 */
const INFO_NOTICE_LINGER_MS = 6_000;

export interface NoticeRowProps {
  notice: { level: "info" | "warning" | "error"; message: string };
}

export function NoticeRow({ notice }: NoticeRowProps) {
  const id = useId();
  const textRef = useRef<HTMLSpanElement | null>(null);
  const [expanded, setExpanded] = useState(false);
  const [clamped, setClamped] = useState(false);
  const [expired, setExpired] = useState(false);
  const { level, message } = notice;

  /**
   * Retire a routine notice after it has been read.
   *
   * The row is removed from the DOM, not just hidden, so the transcript regains the
   * space. Nothing is deleted from the authoritative record: a notice is transient
   * transport state (`transcript.ts:610`) and the host's own journal is untouched,
   * so this only shortens how long the app keeps announcing it. An expansion by the
   * reader cancels the timer — the user is deliberately looking at it.
   */
  useEffect(() => {
    if (level !== "info" || expanded) return;
    const timer = setTimeout(() => setExpired(true), INFO_NOTICE_LINGER_MS);
    return () => clearTimeout(timer);
  }, [level, message, expanded]);

  useLayoutEffect(() => {
    const element = textRef.current;
    if (element === null) return;
    // Re-measured while collapsed only: an expanded row is by definition not
    // clamped, and measuring it would clear the flag and hide the control that
    // collapsed it again.
    //
    // Nit: the call site keys this component by `notice.message`, and the claim that
    // an identical repeated notice re-collapses was simply untrue — a same-text
    // notice does not remount. That is deliberate now, not accidental: identical
    // text carries no new information, so keeping the reader's expansion is the
    // right behaviour rather than a bug to work around.
    const measure = (): void => {
      if (expanded) return;
      setClamped(element.scrollHeight > element.clientHeight + 1);
    };
    measure();
    const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(measure);
    observer?.observe(element);
    return () => observer?.disconnect();
  }, [message, level, expanded]);

  // Two rendered lines for anything actionable, one for routine chatter.
  const clampClass = expanded ? "" : level === "info" ? " notice-text--1" : " notice-text--2";

  // Routine chatter that has been read is gone from the layout entirely; keeping it
  // mounted but transparent would still cost a row on every phone-width screen.
  if (expired) return null;

  return (
    <div className={`notice-row notice-row--${level}`}>
      <div
        className={level === "info" ? "notice-banner notice-banner--info" : `banner ${level} notice-banner`}
        role={level === "error" ? "alert" : "status"}
      >
        <span id={id} ref={textRef} className={`notice-text${clampClass}`}>
          {message}
        </span>
      </div>
      {clamped && (
        <button
          type="button"
          className="ghost notice-toggle"
          aria-expanded={expanded}
          aria-controls={id}
          onClick={() => setExpanded((value) => !value)}
        >
          {expanded ? "Show less" : "Show more"}
        </button>
      )}
    </div>
  );
}
