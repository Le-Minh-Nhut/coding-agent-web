// @vitest-environment jsdom
import React from "react";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, act, fireEvent, cleanup } from "@testing-library/react";
import { FolderBrowser } from "../../apps/web/src/components/FolderBrowser.js";
import { api } from "../../apps/web/src/api.js";
vi.mock("../../apps/web/src/api.js", () => ({
  api: {
    browse: vi.fn(),
  },
}));

describe("FolderBrowser", () => {
  beforeEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  it("shows our human error text for path_forbidden", async () => {
    vi.mocked(api.browse).mockResolvedValue({
      ok: false,
      error: { code: "path_forbidden", message: "Path escapes roots" },
    });

    await act(async () => {
      render(<FolderBrowser onSelect={() => {}} onCancel={() => {}} />);
    });

    const errorAlert = screen.getByRole("alert");
    expect(errorAlert.textContent).toBe(
      "Access forbidden: path is outside allowed workspace directories"
    );
  });

  it("shows only directories and marks paths outside allowed roots as disabled", async () => {
    vi.mocked(api.browse).mockResolvedValue({
      ok: true,
      data: {
        path: "/home/user/work",
        parent: "/home/user",
        roots: ["/home/user/work"],
        entries: [
          {
            name: "src",
            path: "/home/user/work/src",
            isDirectory: true,
            allowed: true,
            hasProject: false,
          },
          {
            name: "README.md",
            path: "/home/user/work/README.md",
            isDirectory: false,
            allowed: true,
            hasProject: false,
          },
          {
            name: "symlink-escape",
            path: "/home/user/work/symlink-escape",
            isDirectory: true,
            allowed: false,
            hasProject: false,
          },
        ],
      },
    });

    let containerEl: HTMLElement | null = null;
    await act(async () => {
      const { container } = render(<FolderBrowser onSelect={() => {}} onCancel={() => {}} />);
      containerEl = container;
    });

    // 1. Assert non-directory README.md is not listed as a selectable directory
    expect(containerEl?.textContent).not.toContain("README.md");

    // 2. Assert allowed directory is listed
    expect(containerEl?.textContent).toContain("src");

    // 3. Assert escaping directory is marked disabled
    const items = containerEl?.querySelectorAll(".folder-item");
    const disabledItems = containerEl?.querySelectorAll(".folder-item.disabled");

    expect(items?.length).toBeGreaterThan(0);
    expect(disabledItems?.length).toBe(1);
    expect(disabledItems?.[0]?.textContent).toContain("symlink-escape");
  });

  it("commits selected directory when clicking 'Use this folder'", async () => {
    vi.mocked(api.browse).mockResolvedValue({
      ok: true,
      data: {
        path: "/home/user/work",
        parent: null,
        roots: ["/home/user/work"],
        entries: [],
      },
    });

    const onSelect = vi.fn();
    await act(async () => {
      render(<FolderBrowser onSelect={onSelect} onCancel={() => {}} />);
    });

    const useButton = screen.getByRole("button", { name: "Use this folder" });
    expect(useButton).not.toBeNull();
    expect((useButton as HTMLButtonElement).disabled).toBe(false);

    act(() => {
      fireEvent.click(useButton);
    });

    expect(onSelect).toHaveBeenCalledWith("/home/user/work");
  });
});
