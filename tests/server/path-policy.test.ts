import { mkdtemp, mkdir, readdir, realpath, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { PathPolicyError, WorkspacePathPolicy } from "../../apps/server/src/path-policy.js";

const dirs: string[] = [];
async function tempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "caw-path-"));
  dirs.push(dir);
  return dir;
}
afterEach(async () => { await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true }))); });

async function expectCode(promise: Promise<unknown>, code: string) {
  await expect(promise).rejects.toMatchObject({ code });
}

describe("WorkspacePathPolicy", () => {
  it("rejects sibling-prefix escapes and absolute paths outside allowed roots", async () => {
    const parent = await tempDir();
    const root = join(parent, "user");
    const sibling = join(parent, "user2");
    await mkdir(root); await mkdir(sibling);
    const policy = new WorkspacePathPolicy([root]);
    await expectCode(policy.assertInsideRoots(sibling), "path_forbidden");
    await expectCode(policy.assertInsideRoots(join(sibling, "nonexistent")), "path_forbidden");
  });

  it("rejects symlink escapes and loops, while allowing an inside-root directory link", async () => {
    const parent = await tempDir();
    const root = join(parent, "root"); const outside = join(parent, "outside");
    await mkdir(root); await mkdir(outside); await mkdir(join(root, "real"));
    await symlink(outside, join(root, "escape"));
    await symlink(join(root, "real"), join(root, "alias"));
    await symlink(join(root, "loop"), join(root, "loop"));
    const policy = new WorkspacePathPolicy([root]);
    await expectCode(policy.assertInsideRoots(join(root, "escape"), true), "path_forbidden");
    expect(await policy.assertInsideRoots(join(root, "alias"), true)).toBe(await realpath(join(root, "real")));
    await expectCode(policy.assertInsideRoots(join(root, "loop"), true), "path_forbidden");
  });

  it("rejects traversal, NUL, missing paths, and files where directory required", async () => {
    const root = await tempDir();
    const file = join(root, "file"); await writeFile(file, "data");
    const policy = new WorkspacePathPolicy([root]);
    await expectCode(policy.assertInsideRoots(`${root}/../elsewhere`), "path_forbidden");
    await expectCode(policy.assertInsideRoots(`${root}\0evil`), "path_forbidden");
    await expectCode(policy.assertInsideRoots(join(root, "missing")), "path_not_found");
    await expectCode(policy.assertInsideRoots(file, true), "not_a_directory");
  });

  it("maps NFC request names to NFD entries and lists a normalized display name", async () => {
    const root = await tempDir();
    const decomposed = "cafe\u0301";
    await mkdir(join(root, decomposed));
    const policy = new WorkspacePathPolicy([root]);
    expect(await policy.assertInsideRoots(join(root, "café"), true)).toBe(join(root, decomposed));
    expect((await policy.listDirectory(root)).entries[0]?.name).toBe("café");
    await expectCode(policy.classifyChild(root, "../escape"), "path_forbidden");
  });

  it("refuses browsing when no roots are configured", async () => {
    const error = await new WorkspacePathPolicy([]).listDirectory().catch((value: unknown) => value);
    expect(error).toBeInstanceOf(PathPolicyError);
    expect((error as PathPolicyError).code).toBe("path_forbidden");
  });

  it("creates directory inside allowed root and returns the created absolute path", async () => {
    const root = await tempDir();
    const parent = join(root, "parent");
    await mkdir(parent);
    const policy = new WorkspacePathPolicy([root]);
    const created = await policy.createDirectory(parent, "child");
    expect(created).toBe(join(parent, "child"));
    expect((await stat(created)).isDirectory()).toBe(true);
  });

  it("refuses directory creation and leaves directory in place when parent is swapped to an outside symlink during mkdir", async () => {
    const base = await tempDir();
    const root = join(base, "root");
    const outside = join(base, "outside");
    const parent = join(root, "parent");
    await mkdir(root);
    await mkdir(outside);
    await mkdir(parent);

    class SwappedParentPolicy extends WorkspacePathPolicy {
      protected override async makeDirectory(target: string): Promise<void> {
        await rm(parent, { recursive: true });
        await symlink(outside, parent);
        await super.makeDirectory(target);
      }
    }

    const policy = new SwappedParentPolicy([root]);
    await expectCode(policy.createDirectory(parent, "swapped-child"), "path_forbidden");
    // Directory was created outside root and must remain in place (no cleanup delete)
    expect((await stat(join(outside, "swapped-child"))).isDirectory()).toBe(true);
  });

  it("refuses directory creation when parent realpath mismatches before mkdir", async () => {
    const base = await tempDir();
    const root = join(base, "root");
    const outside = join(base, "outside");
    const parent = join(root, "parent");
    await mkdir(root);
    await mkdir(outside);
    await mkdir(parent);

    class PreMkdirSwapPolicy extends WorkspacePathPolicy {
      override async assertInsideRoots(path: string, requireDirectory = false): Promise<string> {
        const canonical = await super.assertInsideRoots(path, requireDirectory);
        await rm(canonical, { recursive: true });
        await symlink(outside, canonical);
        return canonical;
      }
    }

    const policy = new PreMkdirSwapPolicy([root]);
    await expectCode(policy.createDirectory(parent, "child"), "path_forbidden");
    expect(await stat(join(outside, "child")).then(() => true, () => false)).toBe(false);
  });

  it("rejects Unicode-equivalent directory creation when an NFD-equivalent entry exists without modifying on-disk count", async () => {
    const root = await tempDir();
    const parent = join(root, "parent");
    await mkdir(parent);
    const decomposed = "cafe\u0301";
    await mkdir(join(parent, decomposed));
    const before = await readdir(parent);
    expect(before).toHaveLength(1);

    const policy = new WorkspacePathPolicy([root]);
    await expectCode(policy.createDirectory(parent, "café"), "already_exists");

    const after = await readdir(parent);
    expect(after).toEqual(before);
  });
  it("pages large listings in stable order without duplicates or skipped existing entries", async () => {
    const root = await tempDir();
    const names = Array.from({ length: 37 }, (_, index) => `entry-${String(index).padStart(2, "0")}`);
    await Promise.all(names.map((name) => mkdir(join(root, name))));
    const policy = new WorkspacePathPolicy([root]);
    const collected: string[] = [];
    let cursor: string | undefined;
    do {
      const page = await policy.listDirectory(root, { limit: 7, cursor });
      collected.push(...page.entries.map((entry) => entry.name));
      expect(page.hasMore).toBe(page.nextCursor !== null);
      cursor = page.nextCursor ?? undefined;
    } while (cursor);
    expect(collected).toEqual([...names].sort((a, b) => a.localeCompare(b)));
    expect(new Set(collected).size).toBe(names.length);
  });

  it("enforces page caps, rejects invalid and cross-directory cursors, and keeps unpaged listings", async () => {
    const root = await tempDir();
    const other = join(root, "other");
    const outside = await tempDir();
    await mkdir(other);
    await Promise.all(Array.from({ length: 505 }, (_, index) => mkdir(join(root, `item-${String(index).padStart(3, "0")}`))));
    await mkdir(join(other, "child"));
    const policy = new WorkspacePathPolicy([root]);
    const capped = await policy.listDirectory(root, { limit: 900 });
    expect(capped.entries).toHaveLength(500);
    expect(capped.hasMore).toBe(true);
    expect(capped.nextCursor).toBeTruthy();
    expect((await policy.listDirectory(root)).entries).toHaveLength(506);
    await expectCode(policy.listDirectory(root, { cursor: "garbage" }), "path_forbidden");
    await expectCode(policy.listDirectory(other, { cursor: capped.nextCursor! }), "path_forbidden");
    await expectCode(policy.listDirectory(outside, { cursor: capped.nextCursor! }), "path_forbidden");
  });

  it("shows a directory immediately after creating it", async () => {
    const root = await tempDir();
    const policy = new WorkspacePathPolicy([root]);
    const created = await policy.createDirectory(root, "new-chat");
    const listing = await policy.listDirectory(root, { limit: 10 });
    expect(listing.entries).toContainEqual(expect.objectContaining({ name: "new-chat", path: created, isDirectory: true }));
  });
});
