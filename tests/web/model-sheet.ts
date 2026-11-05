/**
 * Shared helper for opening the model-settings sheet in tests.
 *
 * The model controls used to be an inline `<details>` whose <summary> read
 * "Conversation model settings", so a test could open it with one click on that
 * text. They are a sheet now (round 51) opened from the overflow menu, which
 * gives the transcript the full viewport height on a phone.
 *
 * Keeping the open sequence in one place means the next move of these controls
 * is one edit here instead of thirty across ten files. Callers keep every
 * assertion they had; only the way the panel is revealed changes.
 */
import { fireEvent, screen, within, type Queries } from "@testing-library/react";

/** The sheet, once open. Throws with a clear message when it did not open. */
export function modelSheet(): HTMLElement {
  const sheet = document.querySelector(".model-sheet");
  if (sheet === null) throw new Error("model settings sheet is not open");
  return sheet as HTMLElement;
}

/**
 * Open model settings through the real user path: overflow menu → Model settings.
 *
 * `view` is the render result, so this works for both `screen`-based and
 * container-based tests. Returns the sheet element for scoped queries.
 */
export function openModelSheet(view?: { getByRole: (typeof screen)["getByRole"] }): HTMLElement {
  const ui = view ?? screen;
  fireEvent.click(ui.getByRole("button", { name: "More actions" }));
  fireEvent.click(ui.getByRole("button", { name: "Model settings" }));
  return modelSheet();
}

/**
 * Same open, but first waits for the view to render.
 *
 * Callers that used `await findByText("Conversation model settings")` were waiting
 * for the conversation to paint before touching the controls; the overflow button
 * is the equivalent landmark, so awaiting it preserves that wait.
 */
export async function openModelSheetWhenReady(): Promise<HTMLElement> {
  await screen.findByRole("button", { name: "More actions" });
  return openModelSheet();
}

/** Query inside the open sheet, so a same-named control elsewhere cannot match. */
export function withinModelSheet(): Queries {
  return within(modelSheet());
}
