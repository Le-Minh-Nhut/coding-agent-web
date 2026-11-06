// @vitest-environment jsdom
// Dashboard card honesty.
//
// The owner's report showed "12 Agents" with "0 running" beside it, which reads
// as twelve concurrent agents — a number that would be alarming and is not what
// is being counted. The count is every agent the conversation ever spawned; the
// card must not let a finished total masquerade as live load.
import React from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { DashboardCards } from "../../apps/web/src/components/DashboardCards.js";
import { modelDisplayName } from "../../apps/web/src/agent-model.js";

afterEach(cleanup);

function renderCards(agents: { total: number; running: number }) {
  render(
    <DashboardCards
      counts={{ agents, files: null }}
      onOpenAgents={vi.fn()}
      onOpenFiles={vi.fn()}
      onOpenActivity={vi.fn()}
    />,
  );
}

describe("dashboard agent card scope", () => {
  it("says a large historical total is not live load", () => {
    renderCards({ total: 12, running: 0 });
    expect(screen.getByText("12 Agents")).toBeTruthy();
    // The sub-line must disclaim the total rather than implying twelve processes.
    expect(screen.getByText(/all-time/)).toBeTruthy();
  });

  it("shows the running count plainly when work is in flight", () => {
    renderCards({ total: 12, running: 3 });
    expect(screen.getByText("3 running")).toBeTruthy();
  });

  it("keeps the accessible name and both numbers", () => {
    renderCards({ total: 12, running: 0 });
    const card = screen.getByRole("button", { name: /Agents: 12 total, 0 running/ });
    expect(card).toBeTruthy();
  });
});

describe("model display name", () => {
  it("keeps the model name and drops the provider path", () => {
    expect(modelDisplayName("9router/wdb/deepseek-ai/DeepSeek-V4.1-Flash")).toBe("DeepSeek-V4.1-Flash");
  });

  it("returns a bare identifier unchanged", () => {
    expect(modelDisplayName("gpt-5")).toBe("gpt-5");
  });

  it("tolerates a trailing separator rather than returning nothing", () => {
    expect(modelDisplayName("provider/model/")).toBe("model");
  });
});
