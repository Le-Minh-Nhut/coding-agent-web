import { lstat, mkdir, realpath, readdir } from "node:fs/promises";
import { isAbsolute, join, parse, relative, resolve, sep } from "node:path";
import type { DirectoryEntry, DirectoryListing } from "@caw/contracts";

export class PathPolicyError extends Error {
  constructor(readonly code: "path_forbidden" | "path_not_found" | "not_a_directory" | "already_exists", message: string) {
    super(message);
    this.name = "PathPolicyError";
  }
}

/** Listing validates canonical paths; any later open must use O_NOFOLLOW and fstat the handle to close remaining TOCTOU risk where supported. */
export class WorkspacePathPolicy {
  constructor(private readonly configuredRoots: readonly string[], private readonly hasProject: (canonicalPath: string) => boolean = () => false) {}

  private async roots(): Promise<string[]> {
    return Promise.all(this.configuredRoots.map(async (root) => {
      if (root.includes("\0")) throw new PathPolicyError("path_forbidden", "Workspace root contains NUL");
      try {
        const canonical = await realpath(root);
        if (!(await lstat(canonical)).isDirectory()) throw new PathPolicyError("not_a_directory", `Workspace root is not a directory: ${root}`);
        return canonical;
      } catch (error) {
        if (error instanceof PathPolicyError) throw error;
        const code = (error as NodeJS.ErrnoException).code;
        if (code === "ELOOP") throw new PathPolicyError("path_forbidden", "Workspace root contains a symlink loop");
        if (code === "ENOENT") throw new PathPolicyError("path_not_found", `Workspace root does not exist: ${root}`);
        throw error;
      }
    }));
  }

  private inside(path: string, roots: readonly string[]): boolean {
    const pathParts = resolve(path).split(sep).filter(Boolean).map((part) => part.normalize("NFC"));
    return roots.some((root) => {
      const rootParts = resolve(root).split(sep).filter(Boolean).map((part) => part.normalize("NFC"));
      return pathParts.length >= rootParts.length && rootParts.every((part, index) => pathParts[index] === part);
    });
  }

  private rootAncestor(path: string, roots: readonly string[]): boolean {
    return roots.some((root) => {
      const rel = relative(path, root);
      return rel === "" || (rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
    });
  }

  private async canonicalize(path: string, roots: readonly string[]): Promise<string> {
    if (path.includes("\0")) throw new PathPolicyError("path_forbidden", "Path contains NUL");
    if (!isAbsolute(path)) throw new PathPolicyError("path_forbidden", "Workspace path must be absolute");
    const normalized = path.normalize("NFC");
    const volumeRoot = parse(normalized).root;
    const segments = normalized.slice(volumeRoot.length).split(sep);
    if (segments.some((part) => part === ".." || part === "." || part.includes("\\") || /[\u0000-\u001f\u007f]/u.test(part))) {
      throw new PathPolicyError("path_forbidden", "Path contains a forbidden segment");
    }
    const lexicalRoots = [...roots, ...this.configuredRoots.map((root) => resolve(root))];
    if (!this.inside(normalized, lexicalRoots)) throw new PathPolicyError("path_forbidden", "Path is outside configured workspace roots");
    let current = volumeRoot;
    for (const segment of segments.filter(Boolean)) {
      let names: string[];
      try { names = await readdir(current); }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") throw new PathPolicyError("path_not_found", "Path does not exist");
        if ((error as NodeJS.ErrnoException).code === "ENOTDIR") throw new PathPolicyError("not_a_directory", "Path component is not a directory");
        if ((error as NodeJS.ErrnoException).code === "ELOOP") throw new PathPolicyError("path_forbidden", "Path contains a symlink loop");
        throw error;
      }
      const matches = names.filter((name) => name.normalize("NFC") === segment);
      if (matches.length > 1) throw new PathPolicyError("path_forbidden", "Path is ambiguous after Unicode normalization");
      if (matches.length === 0) throw new PathPolicyError("path_not_found", "Path does not exist");
      current = join(current, matches[0]!);
      try { current = await realpath(current); }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") throw new PathPolicyError("path_not_found", "Path does not exist");
        if ((error as NodeJS.ErrnoException).code === "ELOOP") throw new PathPolicyError("path_forbidden", "Path contains a symlink loop");
        throw error;
      }
      if (!this.inside(current, roots) && !this.rootAncestor(current, roots)) throw new PathPolicyError("path_forbidden", "Path is outside configured workspace roots");
    }
    return current;
  }

  async assertInsideRoots(path: string, requireDirectory = false): Promise<string> {
    const roots = await this.roots();
    const canonical = await this.canonicalize(path, roots);
    if (!this.inside(canonical, roots)) throw new PathPolicyError("path_forbidden", "Path is outside configured workspace roots");
    if (requireDirectory) {
      try {
        if (!(await lstat(canonical)).isDirectory()) throw new PathPolicyError("not_a_directory", "Path is not a directory");
      } catch (error) {
        if (error instanceof PathPolicyError) throw error;
        if ((error as NodeJS.ErrnoException).code === "ELOOP") throw new PathPolicyError("path_forbidden", "Path contains a symlink loop");
        throw error;
      }
    }
    return canonical;
  }

  async classifyChild(parent: string, name: string): Promise<DirectoryEntry> {
    if (!name || name === "." || name === ".." || name.includes("/") || name.includes("\\") || name.includes("\0") || /[\u0000-\u001f\u007f]/u.test(name)) {
      throw new PathPolicyError("path_forbidden", "Invalid directory entry name");
    }
    const displayName = name.normalize("NFC");
    const candidate = resolve(parent, name);
    try {
      const canonical = await realpath(candidate);
      const roots = await this.roots();
      const allowed = this.inside(canonical, roots);
      return { name: displayName, path: allowed ? canonical : candidate, isDirectory: allowed && (await lstat(canonical)).isDirectory(), allowed, hasProject: allowed && this.hasProject(canonical) };
    } catch (error) {
      if (["ELOOP", "ENOENT"].includes((error as NodeJS.ErrnoException).code ?? "")) return { name: displayName, path: candidate, isDirectory: false, allowed: false, hasProject: false };
      throw error;
    }
  }

  protected async makeDirectory(target: string): Promise<void> {
    await mkdir(target, { recursive: false });
  }

  async createDirectory(parentPath: string, name: string): Promise<string> {
    if (!name || name === "." || name === ".." || name.includes("/") || name.includes("\\") || name.includes("\0") || /[\u0000-\u001f\u007f]/u.test(name)) {
      throw new PathPolicyError("path_forbidden", "Invalid directory name");
    }
    const parent = await this.assertInsideRoots(parentPath, true);

    let existingEntries: string[];
    try {
      existingEntries = await readdir(parent);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") throw new PathPolicyError("path_not_found", "Parent directory does not exist");
      if ((error as NodeJS.ErrnoException).code === "ENOTDIR") throw new PathPolicyError("not_a_directory", "Parent path is not a directory");
      if ((error as NodeJS.ErrnoException).code === "ELOOP") throw new PathPolicyError("path_forbidden", "Path contains a symlink loop");
      throw error;
    }
    const normalizedTargetName = name.normalize("NFC");
    if (existingEntries.some((entry) => entry.normalize("NFC") === normalizedTargetName)) {
      throw new PathPolicyError("already_exists", "A file or directory with that name already exists");
    }

    let currentParent: string;
    try {
      currentParent = await realpath(parent);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ELOOP") throw new PathPolicyError("path_forbidden", "Path contains a symlink loop");
      if ((error as NodeJS.ErrnoException).code === "ENOENT") throw new PathPolicyError("path_not_found", "Parent directory does not exist");
      throw error;
    }
    if (currentParent !== parent) {
      throw new PathPolicyError("path_forbidden", "Parent directory changed during creation");
    }

    const target = join(parent, name);
    try {
      await this.makeDirectory(target);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") {
        throw new PathPolicyError("already_exists", "A file or directory with that name already exists");
      }
      throw error;
    }

    // why: races a local actor who already has shell on the machine; detect-and-refuse rather than
    // guarantee atomicity, because there is no portable mkdirat here. State residual ceiling: leaves
    // created directory in place if outside roots (no deletion attempt).
    // ponytail: detect-and-refuse; native openat/mkdirat binding needed if true atomicity required.
    let canonicalTarget: string;
    try {
      canonicalTarget = await realpath(target);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ELOOP") throw new PathPolicyError("path_forbidden", "Path contains a symlink loop");
      if ((error as NodeJS.ErrnoException).code === "ENOENT") throw new PathPolicyError("path_not_found", "Path does not exist");
      throw error;
    }
    const roots = await this.roots();
    if (!this.inside(canonicalTarget, roots)) {
      throw new PathPolicyError("path_forbidden", "Created directory is outside configured workspace roots");
    }

    return canonicalTarget;
  }

  async listDirectory(path?: string): Promise<DirectoryListing> {
    const roots = await this.roots();
    if (roots.length === 0) throw new PathPolicyError("path_forbidden", "No workspace roots configured; set CAW_ALLOWED_ROOTS before browsing");
    const canonical = await this.assertInsideRoots(path ?? roots[0]!, true);
    const entries: DirectoryEntry[] = [];
    for (const name of await readdir(canonical)) entries.push(await this.classifyChild(canonical, name));
    entries.sort((a, b) => a.name.localeCompare(b.name));
    const parentPath = resolve(canonical, "..");
    return { path: canonical, parent: this.inside(parentPath, roots) ? parentPath : null, roots, entries };
  }
}
