import { useEffect, useRef } from "react";

/**
 * The keyboard contract every modal overlay in the app owes the user, in one place.
 *
 * Kept as a component rather than a hook so its mount lines up with the overlay
 * element it renders: the dialog's own effect can move focus in only after the
 * overlay's siblings (an autofocused input inside a form) have mounted, and
 * unmounting alongside the overlay is exactly when focus must go back.
 *
 * What a dialog owes: a name and dialog semantics (passed through), focus moved
 * inside on open and handed back to the opener on close, Escape closing through the
 * dialog's own dismiss path, and Tab not walking out into the page behind.
 *
 * Escape is routed to `onClose` only — never to a confirm action — so a destructive
 * dialog can be dismissed by it but never triggered by it.
 */
const FOCUSABLE =
  "button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), a[href], [tabindex]:not([tabindex='-1'])";

/**
 * Open overlays in mount order. Every overlay binds its keys to `document` (see
 * below), so with two dialogs on screen each would answer the same Escape and one
 * press would dismiss both. Only the last entry — the topmost dialog — may act.
 * A module-level stack is enough for a single-tab app: overlays are mounted and
 * unmounted, never moved between documents.
 */
const openOverlays: object[] = [];

export interface ModalOverlayProps {
  /** Dismisses the dialog: the same action its Cancel control takes. */
  onClose: () => void;
  /** The overlay's accessible name, set here because the dialog owns its own. */
  "aria-label"?: string;
  "aria-labelledby"?: string;
  /** Extra props for the overlay element (className, styles, click handlers). */
  overlayProps?: React.HTMLAttributes<HTMLDivElement>;
  children: React.ReactNode;
}

export function ModalOverlay({ onClose, overlayProps, children, ...aria }: ModalOverlayProps) {
  const ref = useRef<HTMLDivElement | null>(null);
  /**
   * The control that opened this dialog, captured during the first render.
   *
   * Not in the effect below: a dialog with an autofocused input (the rename field)
   * has already moved focus into itself by the time effects run, so reading
   * `document.activeElement` there would record the input that is about to unmount
   * and there would be nothing to hand focus back to.
   */
  const openerRef = useRef<HTMLElement | null>(
    document.activeElement instanceof HTMLElement ? document.activeElement : null,
  );

  /**
   * This overlay's entry in `openOverlays`: a stable per-instance identity, so the
   * key handler can tell whether it belongs to the topmost dialog. Assigned once
   * during the first render.
   */
  const token = useRef<object | null>(null);
  if (!token.current) token.current = {};

  /**
   * The key handler is installed on `document`, not on the overlay element: a
   * React `onKeyDown` only ever sees events targeting inside the overlay's
   * subtree, and a pointer click on the dialog's own non-focusable text moves
   * focus to `<body>`, after which Escape never reaches the overlay again.
   * `onClose` is read through a ref so the listener is installed once for the
   * dialog's lifetime rather than re-subscribed on every parent render.
   */
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  useEffect(() => {
    const container = ref.current;
    if (!container) return;
    // Only step in when nothing inside took focus (an autofocus input owns it then).
    if (!container.contains(document.activeElement)) {
      const first = container.querySelector<HTMLElement>(FOCUSABLE);
      // preventScroll on both moves: the dialog covers a scrollable transcript, and
      // focusing a control must not scroll the page behind it (the e2e suite asserts
      // modal open/close leaves chat scroll position unchanged).
      if (first) first.focus({ preventScroll: true });
      else {
        // Nothing focusable inside: make the dialog itself the landing point rather
        // than leaving focus on the page behind it.
        container.tabIndex = -1;
        container.focus({ preventScroll: true });
      }
    }
    const opener = openerRef.current;
    return () => {
      // It may legitimately be gone by the time the dialog closes (the row a delete
      // just removed), hence the check.
      if (opener?.isConnected) opener.focus({ preventScroll: true });
    };
  }, []);

  useEffect(() => {
    /**
     * Bound to `document` (capture not needed: nothing in a dialog stops a key
     * event) so Escape and Tab are handled no matter where focus currently sits —
     * including `<body>` after the user clicks the dialog's own inert text.
     */
    const handleKeyDown = (event: KeyboardEvent) => {
      const container = ref.current;
      if (!container) return;
      // Only the topmost dialog may act: with two mounted, each document listener
      // would otherwise answer the same Escape and one press would close both.
      if (openOverlays[openOverlays.length - 1] !== token) return;
      if (event.key === "Escape") {
        event.preventDefault();
        onCloseRef.current();
        return;
      }
      if (event.key !== "Tab") return;
      const focusable = Array.from(container.querySelectorAll<HTMLElement>(FOCUSABLE));
      if (focusable.length === 0) {
        // Nothing to move focus to: leave none of the page's own controls reachable
        // from the dialog, then put the user back on the dialog itself.
        event.preventDefault();
        container.focus({ preventScroll: true });
        return;
      }
      const first = focusable[0]!;
      const last = focusable[focusable.length - 1]!;
      const active = document.activeElement;
      // Wrap at the edges so Tab cannot reach the controls the dialog covers.
      // `currentTarget` is no longer the overlay (the listener is on `document`), so
      // the container itself is compared against: focus on `<body>` — exactly the
      // state a pointer click on inert dialog text produces — is outside the dialog
      // and must wrap too, or Shift+Tab walks out backwards onto the page behind.
      if (event.shiftKey && (active === first || !container.contains(active))) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && (active === last || !container.contains(active))) {
        event.preventDefault();
        first.focus();
      }
    };
    openOverlays.push(token);
    document.addEventListener("keydown", handleKeyDown);
    return () => {
      document.removeEventListener("keydown", handleKeyDown);
      const index = openOverlays.indexOf(token);
      if (index !== -1) openOverlays.splice(index, 1);
    };
  }, []);

  return (
    <div {...overlayProps} ref={ref} role="dialog" aria-modal="true" {...aria}>
      {children}
    </div>
  );
}
