// @vitest-environment jsdom
/**
 * D3 (round 28 post-fix audit): the overlay bound keydown to its own React
 * subtree, so a key event whose target is outside that subtree — the state a real
 * browser puts a user in when they click non-focusable dialog text (focus moves to
 * <body>) — never reached the handler and Escape stopped closing the dialog.
 *
 * jsdom does not move focus when a non-focusable element is clicked, so the test
 * performs the blur the browser performs: after the click the active element is
 * <body>, and the key event is dispatched on <body>, exactly where the browser
 * would target it.
 */
import React from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { ModalOverlay } from "../../apps/web/src/components/ModalOverlay.js";

afterEach(cleanup);

function Dialog({ onClose, bodyText = "Non-focusable body text" }: { onClose: () => void; bodyText?: string }) {
  return (
    <ModalOverlay onClose={onClose} aria-label="Test dialog" overlayProps={{ className: "modal-overlay" }}>
      <div className="modal-content">
        <h3>Test dialog</h3>
        <p>{bodyText}</p>
        <button type="button" onClick={onClose}>
          Cancel
        </button>
      </div>
    </ModalOverlay>
  );
}

/** Click the dialog's own paragraph, then blur, the way a pointer click on inert text does. */
function clickDialogTextThenBlur(text: string): void {
  const paragraph = screen.getByText(text);
  fireEvent.click(paragraph);
  (document.activeElement as HTMLElement | null)?.blur();
}

describe("D3 Escape is bound to the document, not the overlay subtree", () => {
  it("closes through onClose when Escape is pressed after clicking dialog text", () => {
    const onClose = vi.fn();
    const { container } = render(<Dialog onClose={onClose} />);

    clickDialogTextThenBlur("Non-focusable body text");
    expect(document.activeElement).toBe(document.body);
    expect(container.querySelector('[role="dialog"]')).not.toBeNull();

    fireEvent.keyDown(document.body, { key: "Escape" });

    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("keeps the Tab wrap at the edges and still closes from outside focus", () => {
    const onClose = vi.fn();
    render(<Dialog onClose={onClose} />);

    const cancel = screen.getByRole("button", { name: "Cancel" });
    cancel.focus();
    // Only one focusable inside: Shift+Tab and Tab both wrap onto it.
    fireEvent.keyDown(cancel, { key: "Tab", shiftKey: true });
    expect(document.activeElement).toBe(cancel);
    fireEvent.keyDown(cancel, { key: "Tab" });
    expect(document.activeElement).toBe(cancel);

    cancel.blur();
    expect(document.activeElement).toBe(document.body);
    fireEvent.keyDown(document.body, { key: "Escape" });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("traps Shift+Tab when focus sits on <body>, the state an inert-text click produces", () => {
    const onClose = vi.fn();
    render(
      <ModalOverlay onClose={onClose} aria-label="Test dialog" overlayProps={{ className: "modal-overlay" }}>
        <div className="modal-content">
          <p>Non-focusable body text</p>
          <button type="button">First</button>
          <button type="button">Second</button>
        </div>
      </ModalOverlay>,
    );

    // Exactly the state the Escape fix targets: the click on inert text leaves the
    // browser's focus on <body>. Shift+Tab from there used to walk BACKWARDS out of
    // the modal onto the controls the overlay covers — a keyboard route to a second
    // dialog stacked on top of this one.
    clickDialogTextThenBlur("Non-focusable body text");
    expect(document.activeElement).toBe(document.body);

    fireEvent.keyDown(document.body, { key: "Tab", shiftKey: true });

    const dialog = screen.getByRole("dialog", { name: "Test dialog" });
    expect(dialog.contains(document.activeElement)).toBe(true);
    expect((document.activeElement as HTMLElement).textContent).toBe("Second");
  });

  it("traps a forward Tab from <body> on the dialog's first control", () => {
    const onClose = vi.fn();
    render(
      <ModalOverlay onClose={onClose} aria-label="Test dialog" overlayProps={{ className: "modal-overlay" }}>
        <div className="modal-content">
          <p>Non-focusable body text</p>
          <button type="button">First</button>
          <button type="button">Second</button>
        </div>
      </ModalOverlay>,
    );

    clickDialogTextThenBlur("Non-focusable body text");
    fireEvent.keyDown(document.body, { key: "Tab" });

    const dialog = screen.getByRole("dialog", { name: "Test dialog" });
    expect(dialog.contains(document.activeElement)).toBe(true);
    expect((document.activeElement as HTMLElement).textContent).toBe("First");
  });

  it("lets only the topmost dialog answer Escape", () => {
    const closeLower = vi.fn();
    const closeUpper = vi.fn();
    const view = render(<Dialog onClose={closeLower} />);
    // The second dialog mounts on top of the first (the keyboard route above can
    // produce exactly this): each overlay installs its own document listener, so
    // without a stack a single Escape dismissed both.
    view.rerender(
      <>
        <Dialog onClose={closeLower} />
        <Dialog onClose={closeUpper} />
      </>,
    );

    expect(document.querySelectorAll('[role="dialog"]').length).toBe(2);
    fireEvent.keyDown(document.body, { key: "Escape" });

    expect(closeUpper).toHaveBeenCalledTimes(1);
    expect(closeLower).not.toHaveBeenCalled();

    // Once the top one is gone the lower dialog answers Escape again.
    view.rerender(<Dialog onClose={closeLower} />);
    fireEvent.keyDown(document.body, { key: "Escape" });
    expect(closeLower).toHaveBeenCalledTimes(1);
  });

  it("still traps Tab when the dialog contains no focusable control", () => {
    // A control on the page behind the overlay: the first thing a Tab that escaped
    // the dialog would reach.
    const behind = document.createElement("button");
    behind.textContent = "Behind";
    document.body.appendChild(behind);

    const onClose = vi.fn();
    render(
      <ModalOverlay onClose={onClose} aria-label="Static dialog" overlayProps={{ className: "modal-overlay" }}>
        <p>Nothing to focus here</p>
      </ModalOverlay>,
    );
    const dialog = screen.getByRole("dialog", { name: "Static dialog" });
    // The mount effect lands focus on the dialog itself when it has no control.
    expect(document.activeElement).toBe(dialog);

    // A pointer click on the inert text drops focus to <body>; the trap must put the
    // user back inside the dialog rather than let the page behind take focus.
    (document.activeElement as HTMLElement | null)?.blur();
    expect(document.activeElement).toBe(document.body);

    fireEvent.keyDown(document.body, { key: "Tab" });
    expect(document.activeElement).toBe(dialog);
    expect(document.activeElement).not.toBe(behind);

    fireEvent.keyDown(document.body, { key: "Tab", shiftKey: true });
    expect(document.activeElement).toBe(dialog);

    expect(onClose).not.toHaveBeenCalled();
    behind.remove();
  });

  it("removes its document keydown listener on unmount", () => {
    const added = vi.spyOn(document, "addEventListener");
    const removed = vi.spyOn(document, "removeEventListener");
    const onClose = vi.fn();
    const { unmount } = render(<Dialog onClose={onClose} />);

    const handler = added.mock.calls.find(([type]) => type === "keydown")?.[1];
    expect(handler).toBeTypeOf("function");

    unmount();

    // The observable consequence: the very listener the overlay installed is taken
    // off `document`. Without the cleanup it stays for the life of the tab — one per
    // dialog the user has ever opened.
    expect(removed.mock.calls.filter(([type, fn]) => type === "keydown" && fn === handler)).toHaveLength(1);

    // And the stale handler is really gone: a later Escape reaches nothing.
    fireEvent.keyDown(document.body, { key: "Escape" });
    expect(onClose).not.toHaveBeenCalled();

    added.mockRestore();
    removed.mockRestore();
  });

  it("keeps the dialog semantics and Escape's dismiss-only routing", () => {
    const onClose = vi.fn();
    const confirm = vi.fn();
    render(
      <ModalOverlay onClose={onClose} aria-label="Delete something" overlayProps={{ className: "modal-overlay" }}>
        <p>Body text with no focusable sibling</p>
        <button type="button" onClick={confirm}>
          Confirm Delete
        </button>
      </ModalOverlay>,
    );

    const dialog = screen.getByRole("dialog", { name: "Delete something" });
    expect(dialog.getAttribute("aria-modal")).toBe("true");

    clickDialogTextThenBlur("Body text with no focusable sibling");
    fireEvent.keyDown(document.body, { key: "Escape" });

    expect(onClose).toHaveBeenCalledTimes(1);
    expect(confirm).not.toHaveBeenCalled();
  });
});
