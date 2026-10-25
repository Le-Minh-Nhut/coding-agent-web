import { lstat, realpath, readdir } from "node:fs/promises";
import { isAbsolute, join, parse, relative, resolve, sep } from "node:path";
import type { DirectoryEntry, DirectoryListing } from "@caw/contracts";

export class PathPolicyError extends Error {
  constructor(readonly code: "path_forbidden" | "path_not_found" | "not_a_directory", message: string) {
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
        if ((error as NodeJS.ErrnoException).code === "ELOOP") throw new PathPolicyError("path_forbidden", "Workspace root contains a symlink loop");
        throw new PathPolicyError("path_not_found", `Workspace root does not exist: ${root}`);
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
