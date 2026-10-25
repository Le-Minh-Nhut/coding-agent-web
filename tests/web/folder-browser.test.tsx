// @vitest-environment jsdom
import React from "react";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, act, fireEvent, cleanup } from "@testing-library/react";
import { FolderBrowser } from "../../apps/web/src/components/FolderBrowser.js";
import { api } from "../../apps/web/src/api.js";
vi.mock("../../apps/web/src/api.js", () => ({
  api: {
    browse: vi.fn(),
    createDirectory: vi.fn(),
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

  it("creates a folder, refreshes listing, and selects the new path", async () => {
    const rootListing = {
      path: "/home/user/work", parent: null, roots: ["/home/user/work"],
      entries: [],
    };
    const createdListing = {
      ...rootListing,
      entries: [{ name: "new-folder", path: "/home/user/work/new-folder", isDirectory: true, allowed: true, hasProject: false }],
    };
    vi.mocked(api.browse).mockResolvedValueOnce({ ok: true, data: rootListing });
    vi.mocked(api.browse).mockResolvedValueOnce({ ok: true, data: createdListing });
    vi.mocked(api.createDirectory).mockResolvedValue({ ok: true, data: { path: "/home/user/work/new-folder" } });
    const onSelect = vi.fn();

    await act(async () => { render(<FolderBrowser onSelect={onSelect} onCancel={() => {}} />); });
    fireEvent.click(screen.getByRole("button", { name: "+ New Folder" }));
    fireEvent.change(screen.getByLabelText(/New folder in/), { target: { value: "new-folder" } });
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Create folder" })); });

    expect(api.createDirectory).toHaveBeenCalledWith("/home/user/work", "new-folder");
    expect(api.browse).toHaveBeenCalledTimes(2);
    expect(screen.getByText("Selected")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Use this folder" }));
    expect(onSelect).toHaveBeenCalledWith("/home/user/work/new-folder");
  });

  it("shows the server error text when folder creation fails", async () => {
    vi.mocked(api.browse).mockResolvedValue({
      ok: true, data: { path: "/home/user/work", parent: null, roots: ["/home/user/work"], entries: [] },
    });
    vi.mocked(api.createDirectory).mockResolvedValue({
      ok: false, error: { code: "already_exists", message: "A file or directory with that name already exists" },
    });
    await act(async () => { render(<FolderBrowser onSelect={() => {}} onCancel={() => {}} />); });
    fireEvent.click(screen.getByRole("button", { name: "+ New Folder" }));
    fireEvent.change(screen.getByLabelText(/New folder in/), { target: { value: "occupied" } });
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Create folder" })); });
    expect(screen.getByRole("alert").textContent).toBe("A file or directory with that name already exists");
  });

  it("lets the user switch to another configured workspace root without exposing outside ancestors", async () => {
    vi.mocked(api.browse).mockImplementation(async (path) => ({
      ok: true,
      data: {
        path: path ?? "/home/user/work",
        parent: null,
        roots: ["/home/user/work", "/srv/work"],
        entries: [],
      },
    }));
    const onSelect = vi.fn();
    await act(async () => { render(<FolderBrowser onSelect={onSelect} onCancel={() => {}} />); });
    expect(screen.getByRole("button", { name: "work", exact: true })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "user", exact: true })).toBeNull();
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "/srv/work" })); });
    expect(api.browse).toHaveBeenLastCalledWith("/srv/work");
    expect(screen.getByRole("button", { name: "work", exact: true })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "srv", exact: true })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Use this folder" }));
    expect(onSelect).toHaveBeenCalledWith("/srv/work");
  });
});
