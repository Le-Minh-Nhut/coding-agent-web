import { mkdtemp, mkdir, realpath, rm, symlink, writeFile } from "node:fs/promises";
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
});
