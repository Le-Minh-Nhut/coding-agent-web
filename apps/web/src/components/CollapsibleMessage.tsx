/**
 * Auto-collapsing user prompt.
 *
 * A pasted multi-page prompt otherwise fills the whole phone screen, so a prompt
 * taller than a few rendered lines shows a bounded preview plus a `Show more`
 * control. Nothing is truncated: the body stays mounted in every state, and
 * `Copy` reads the `text` prop — the full original — never the visible slice.
 *
 * The threshold is *visual height*, not a character count. 400 characters on one
 * line and 400 characters over eight lines are different problems on a 320px
 * screen, so the decision comes from the element's own layout: its `scrollHeight`,
 * which reports the unclipped content height even while `max-height` clips it, is
 * compared against the preview cap of `collapsedLines` line boxes. (`getBoundingClientRect`
 * could not do this: while collapsed it returns the clipped height, so the full
 * height would be unmeasurable.) Line height is read from the computed style, so a
 * typography change in `styles.css` moves the threshold with it.
 *
 * Expansion is keyed by the caller's stable `identity`, never an array index: two
 * identical prompts are two independent toggles, and an element recycled onto a
 * new identity collapses again instead of inheriting the old state.
 *
 * Nothing animates, so there is no motion to gate on `prefers-reduced-motion`.
 *
 * ponytail: the full body stays in the DOM while collapsed (deferred mounting
 * would need a second render path and lose in-page find). If a 10k-word prompt
 * measurably hurts on device, mount the body only when expanded, as MessageRow
 * does for tool results.
 */
import { useId, useLayoutEffect, useRef, useState, type ReactNode } from "react";

/** jsdom and pre-layout renders report no computed line box; 1.5 × 14px. */
export const FALLBACK_LINE_PX = 21;

export interface CollapsibleMessageProps {
  /** Rendered body of the prompt. Mounted in full in every state. */
  children: ReactNode;
  /** The full original prompt text. `Copy` reads this, never the rendered slice. */
  text: string;
  /** Stable message identity. The expansion state belongs to this key. */
  identity: string;
  /** Preview height in rendered lines before the control appears. */
  collapsedLines?: number;
}

/** The line box height in px, or a documented fallback when the style is unresolvable. */
function lineHeightPx(element: Element): number {
  const style = getComputedStyle(element);
  const line = Number.parseFloat(style.lineHeight);
  if (Number.isFinite(line) && line > 0) return line;
  const fontSize = Number.parseFloat(style.fontSize);
  return Number.isFinite(fontSize) && fontSize > 0 ? fontSize * 1.5 : FALLBACK_LINE_PX;
}

/**
 * `overflow-wrap: anywhere` rather than `break-word`: only `anywhere` also
 * collapses the min-content width, which is what stops a single unbroken
 * 10,000-character string from forcing its column wider than the viewport.
 */
const WRAPS: { overflowWrap: "anywhere"; minWidth: number } = { overflowWrap: "anywhere", minWidth: 0 };

export function CollapsibleMessage({ children, text, identity, collapsedLines = 4 }: CollapsibleMessageProps): ReactNode {
  const clipId = useId();
  const clipRef = useRef<HTMLDivElement | null>(null);
  // One id, and only the current one counts: an element recycled onto a new
  // message must collapse rather than inherit the previous message's expansion.
  const [expandedFor, setExpandedFor] = useState<string | null>(null);
  const [trackedIdentity, setTrackedIdentity] = useState(identity);
  if (trackedIdentity !== identity) {
    // Adjusting state during render is the documented way to drop state that
    // belongs to a prop: the caller's `identity` is authoritative, not the slot
    // this component happens to occupy.
    setTrackedIdentity(identity);
    setExpandedFor(null);
  }
  const [overflowing, setOverflowing] = useState(false);
  const [limitPx, setLimitPx] = useState(collapsedLines * FALLBACK_LINE_PX);
  const [copyState, setCopyState] = useState<{ id: string; state: "copied" | "failed" } | null>(null);
  const expanded = expandedFor === identity;
  const clipped = overflowing && !expanded;

  useLayoutEffect(() => {
    const element = clipRef.current;
    if (element === null) return;
    const measure = (): void => {
      const limit = collapsedLines * lineHeightPx(element);
      setLimitPx(limit);
      setOverflowing(element.scrollHeight > limit + 1);
    };
    measure();
    // Reflow (rotation, a wider window, a late web font) changes how many lines
    // the text takes, so the decision is re-taken while the element is on screen.
    const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(measure);
    observer?.observe(element);
    return () => observer?.disconnect();
  }, [children, text, identity, collapsedLines]);

  const copy = async (): Promise<void> => {
    // Same clipboard contract as the code-block control: report failure rather
    // than silently doing nothing when the browser exposes no clipboard.
    try {
      if (!navigator.clipboard?.writeText) throw new Error("Clipboard unavailable");
      await navigator.clipboard.writeText(text);
      setCopyState({ id: identity, state: "copied" });
    } catch {
      setCopyState({ id: identity, state: "failed" });
    }
  };

  return (
    <div className="collapsible" style={WRAPS}>
      <div
        ref={clipRef}
        id={clipId}
        className={`collapsible-clip${expanded ? " expanded" : ""}`}
        style={clipped ? { ...WRAPS, maxHeight: `${limitPx}px`, overflow: "hidden" } : WRAPS}
      >
        {children}
      </div>
      {overflowing && (
        <div className="collapsible-controls">
          <button
            type="button"
            className="ghost collapsible-toggle"
            aria-expanded={expanded}
            aria-controls={clipId}
            onClick={() => setExpandedFor(expanded ? null : identity)}
          >
            {expanded ? "Show less" : "Show more"}
          </button>
          {expanded && (
            <button type="button" className="ghost collapsible-copy" onClick={() => void copy()}>
              {copyState?.id === identity ? (copyState.state === "copied" ? "Copied" : "Copy failed") : "Copy"}
            </button>
          )}
        </div>
      )}
    </div>
  );
}
