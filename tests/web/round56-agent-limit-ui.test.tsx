// @vitest-environment jsdom
/**
 * The Agent limits card is a control, not a readout.
 *
 * These are DOM assertions on the real component because the interesting failures
 * are rendering failures: a pending change that looks saved, a failed save that
 * silently discards the draft, or an unknown occupancy rendered as zero.
 */
import React from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { SettingsView } from "../../apps/web/src/components/SettingsView.js";
import { api } from "../../apps/web/src/api.js";

vi.mock("../../apps/web/src/api.js", () => ({
  api: { getRuntime: vi.fn(), getAgentLimit: vi.fn(), setAgentLimit: vi.fn() },
  setCsrfToken: vi.fn(),
}));

afterEach(() => { cleanup(); vi.restoreAllMocks(); });

const runtimeFixture = { ok: false, error: { code: "internal", message: "no runtime" } };
function limitView(over: Record<string, unknown> = {}) {
  return { ok: true, data: { limit: 3, source: "default", min: 1, max: 100, fallback: 3, activeCount: 1, activeCountReason: null, overLimit: false, ...over } };
}

async function mount() {
  vi.mocked(api.getRuntime).mockResolvedValue(runtimeFixture as never);
  render(<SettingsView onBack={() => {}} onLogout={() => {}} />);
  await screen.findByText("Agent limits");
}

/** The stepper input, addressed by its accessible name. */
const stepper = () => screen.getByLabelText("Maximum concurrent agents") as HTMLInputElement;

describe("Agent limits card", () => {
  it("shows the effective limit and occupancy, and marks the source", async () => {
    vi.mocked(api.getAgentLimit).mockResolvedValue(limitView({ limit: 5, source: "setting", activeCount: 2, fallback: 3 }) as never);
    await mount();
    expect(stepper().value).toBe("5");
    expect(screen.getByText(/Active:/).textContent).toContain("2");
    expect(screen.getByText(/Persisted setting/)).toBeTruthy();
  });

  it("does not render an unknown occupancy as zero", async () => {
    vi.mocked(api.getAgentLimit).mockResolvedValue(limitView({ activeCount: null, activeCountReason: "tmux could not be enumerated" }) as never);
    await mount();
    // "Could not count" is not "the machine is idle".
    expect(screen.getByText(/Active:/).textContent).toContain("unknown");
    expect(screen.getByText(/tmux could not be enumerated/)).toBeTruthy();
  });

  it("separates a pending change from the saved value and only saves on demand", async () => {
    vi.mocked(api.getAgentLimit).mockResolvedValue(limitView({ limit: 3 }) as never);
    vi.mocked(api.setAgentLimit).mockResolvedValue(limitView({ limit: 6, source: "setting" }) as never);
    await mount();

    fireEvent.click(screen.getByLabelText("Increase limit"));
    fireEvent.click(screen.getByLabelText("Increase limit"));
    fireEvent.click(screen.getByLabelText("Increase limit"));
    expect(stepper().value).toBe("6");
    // The pending change is visible as pending, and nothing was sent yet.
    expect(screen.getByText(/Pending change: 3 →/)).toBeTruthy();
    expect(api.setAgentLimit).not.toHaveBeenCalled();

    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Save changes" })); });
    expect(api.setAgentLimit).toHaveBeenCalledWith(6);
    expect(screen.getByText(/Limit saved/)).toBeTruthy();
    // The pending marker is gone because there is nothing pending any more.
    expect(screen.queryByText(/Pending change/)).toBeNull();
  });

  it("keeps the owner's draft when the save fails, and says so", async () => {
    vi.mocked(api.getAgentLimit).mockResolvedValue(limitView({ limit: 3 }) as never);
    vi.mocked(api.setAgentLimit).mockResolvedValue({ ok: false, error: { code: "invalid_setting", message: "The agent limit must be between 1 and 100." } } as never);
    await mount();

    fireEvent.click(screen.getByLabelText("Increase limit"));
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Save changes" })); });

    expect(screen.getByRole("alert").textContent).toContain("between 1 and 100");
    // The draft survives, so a retry does not need the owner to redo the edit.
    expect(stepper().value).toBe("4");
    expect(screen.getByText(/Pending change: 3 →/)).toBeTruthy();
  });

  it("cannot step outside the bounds the server reports", async () => {
    vi.mocked(api.getAgentLimit).mockResolvedValue(limitView({ limit: 100 }) as never);
    await mount();
    // At the ceiling the increase control is unavailable rather than offering a
    // value the server would refuse.
    expect((screen.getByLabelText("Increase limit") as HTMLButtonElement).disabled).toBe(true);
  });

  it("explains that running agents survive a lower limit", async () => {
    vi.mocked(api.getAgentLimit).mockResolvedValue(limitView({ limit: 2, activeCount: 4, overLimit: true }) as never);
    await mount();
    expect(screen.getByRole("status").textContent).toMatch(/left alone/i);
  });

  it("reports a failed read instead of inventing a limit", async () => {
    vi.mocked(api.getAgentLimit).mockResolvedValue({ ok: false, error: { code: "internal", message: "boom" } } as never);
    await mount();
    expect(screen.getByText(/Could not read the current limit/)).toBeTruthy();
  });
});
