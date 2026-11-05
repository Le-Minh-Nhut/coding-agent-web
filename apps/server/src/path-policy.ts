import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { lstat, mkdir, realpath, readdir } from "node:fs/promises";
import { isAbsolute, join, parse, relative, resolve, sep } from "node:path";
import type { DirectoryEntry, DirectoryListing } from "@caw/contracts";

export class PathPolicyError extends Error {
  constructor(readonly code: "path_forbidden" | "path_not_found" | "not_a_directory" | "already_exists", message: string) {
    super(message);
    this.name = "PathPolicyError";
  }
}

const DEFAULT_DIRECTORY_PAGE_SIZE = 100;
const MAX_DIRECTORY_PAGE_SIZE = 500;
const directoryCursorKey = randomBytes(32);

interface DirectoryCursor {
  version: 1;
  pathHash: string;
  name: string;
  rawName: string;
}

function encodeDirectoryCursor(cursor: DirectoryCursor): string {
  const payload = Buffer.from(JSON.stringify(cursor)).toString("base64url");
  const signature = createHmac("sha256", directoryCursorKey).update(payload).digest("base64url");
  return `${payload}.${signature}`;
}

function decodeDirectoryCursor(value: string): DirectoryCursor {
  const [payload, signature, extra] = value.split(".");
  if (!payload || !signature || extra !== undefined || !/^[A-Za-z0-9_-]+$/u.test(payload) || !/^[A-Za-z0-9_-]{43}$/u.test(signature)) {
    throw new PathPolicyError("path_forbidden", "Invalid directory cursor");
  }
  const expected = createHmac("sha256", directoryCursorKey).update(payload).digest();
  let supplied: Buffer;
  try { supplied = Buffer.from(signature, "base64url"); } catch { throw new PathPolicyError("path_forbidden", "Invalid directory cursor"); }
  if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) throw new PathPolicyError("path_forbidden", "Invalid directory cursor");
  let parsed: unknown;
  try { parsed = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")); } catch { throw new PathPolicyError("path_forbidden", "Invalid directory cursor"); }
  if (!parsed || typeof parsed !== "object") throw new PathPolicyError("path_forbidden", "Invalid directory cursor");
  const cursor = parsed as Record<string, unknown>;
  if (cursor.version !== 1 || typeof cursor.pathHash !== "string" || !/^[a-f0-9]{64}$/u.test(cursor.pathHash) || typeof cursor.name !== "string" || typeof cursor.rawName !== "string" || !cursor.rawName || cursor.name !== cursor.rawName.normalize("NFC")) {
    throw new PathPolicyError("path_forbidden", "Invalid directory cursor");
  }
  return cursor as unknown as DirectoryCursor;
}
/** Listing validates canonical paths; any later open must use O_NOFOLLOW and fstat the handle to close remaining TOCTOU risk where supported. */
export class WorkspacePathPolicy {
  constructor(private readonly configuredRoots: readonly string[], private readonly hasProject: (canonicalPath: string) => boolean | Promise<boolean> = () => false) {}
  /** Display-only containment: unlike assertInsideRoots, this lexical check touches no filesystem; never use it before opening or launching a path. */
  isInsideConfiguredRoots(path: string): boolean {
    return !path.includes("\0") && isAbsolute(path) && this.inside(path, this.configuredRoots);
  }
  /**
   * Read-grade containment for a *listing*: canonicalize the path and check the
   * real roots. Unreadable roots are dropped rather than failing the batch, and
   * the caller decides what to do about a path it cannot canonicalize (a cwd in
   * a symlink loop is not evidence that the rest of the page is bad).
   */
  async isInsideConfiguredRootsForRead(path: string): Promise<boolean> {
    if (!this.isInsideConfiguredRoots(path)) return false;
    let canonicalPath: string;
    try {
      canonicalPath = await realpath(path);
    } catch (error) {
      // A session whose cwd no longer exists is a supported history-only row.
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return true;
      throw error;
    }
    return this.inside(canonicalPath, (await this.verifiedRoots()).roots);
  }

  /**
   * Canonical, verified roots, plus the configured entries that could not be
   * verified.
   *
   * A configured root that cannot be canonicalized or is not a directory is
   * dropped instead of rejecting the whole batch. Failing closed here would make
   * one stale entry in `CAW_ALLOWED_ROOTS` deny every path AND — because callers
   * like the global listing ask once per session — turn a single bad entry into a
   * blanket 403/500 for unrelated rows. Dropping it keeps the deny direction
   * (`inside()` can never match a root that is not in this list), so the worst
   * case of a broken root is a smaller allowlist, never a larger one.
   *
   * Dropping is **reported**, never silent: a root that is momentarily
   * unreadable (a network mount, a permission blip) otherwise makes legitimate
   * history vanish from the listing with no explanation, so callers relay
   * `dropped` to the client as a warning.
   */
  async verifiedRoots(): Promise<{ roots: string[]; dropped: string[] }> {
    const checked = await Promise.all(this.configuredRoots.map(async (root) => {
      if (root.includes("\0")) return { root, canonical: null };
      try {
        const canonical = await realpath(root);
        return { root, canonical: (await lstat(canonical)).isDirectory() ? canonical : null };
      } catch {
        return { root, canonical: null };
      }
    }));
    return {
      roots: checked.flatMap((entry) => (entry.canonical === null ? [] : [entry.canonical])),
      dropped: checked.flatMap((entry) => (entry.canonical === null ? [entry.root] : [])),
    };
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
        const errno = (error as NodeJS.ErrnoException).code;
        if (errno === "ENOENT") throw new PathPolicyError("path_not_found", "Path does not exist");
        if (errno === "ENOTDIR") throw new PathPolicyError("not_a_directory", "Path component is not a directory");
        if (errno === "ELOOP") throw new PathPolicyError("path_forbidden", "Path contains a symlink loop");
        // A directory the process cannot read is a *configuration* problem (a
        // root that was dropped because its mount went away or its mode changed),
        // not an internal fault: reporting it as 500 makes a broken
        // `CAW_ALLOWED_ROOTS` entry look like a bug in this server.
        if (errno === "EACCES" || errno === "EPERM") throw new PathPolicyError("path_forbidden", "Path is not readable with the current permissions");
        throw error;
      }
      const matches = names.filter((name) => name.normalize("NFC") === segment);
      if (matches.length > 1) throw new PathPolicyError("path_forbidden", "Path is ambiguous after Unicode normalization");
      if (matches.length === 0) throw new PathPolicyError("path_not_found", "Path does not exist");
      current = join(current, matches[0]!);
      try { current = await realpath(current); }
      catch (error) {
        const errno = (error as NodeJS.ErrnoException).code;
        if (errno === "ENOENT") throw new PathPolicyError("path_not_found", "Path does not exist");
        if (errno === "ELOOP") throw new PathPolicyError("path_forbidden", "Path contains a symlink loop");
        if (errno === "EACCES" || errno === "EPERM") throw new PathPolicyError("path_forbidden", "Path is not readable with the current permissions");
        throw error;
      }
      if (!this.inside(current, roots) && !this.rootAncestor(current, roots)) throw new PathPolicyError("path_forbidden", "Path is outside configured workspace roots");
    }
    return current;
  }

  async assertInsideRoots(path: string, requireDirectory = false): Promise<string> {
    const roots = (await this.verifiedRoots()).roots;
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
      const roots = (await this.verifiedRoots()).roots;
      const allowed = this.inside(canonical, roots);
      return { name: displayName, path: allowed ? canonical : candidate, isDirectory: allowed && (await lstat(canonical)).isDirectory(), allowed, hasProject: allowed && await this.hasProject(canonical) };
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
    const roots = (await this.verifiedRoots()).roots;
    if (!this.inside(canonicalTarget, roots)) {
      throw new PathPolicyError("path_forbidden", "Created directory is outside configured workspace roots");
    }

    return canonicalTarget;
  }

  async listDirectory(path?: string, page?: { limit?: number; cursor?: string }): Promise<DirectoryListing> {
    const roots = (await this.verifiedRoots()).roots;
    if (roots.length === 0) throw new PathPolicyError("path_forbidden", "No workspace roots configured; set CAW_ALLOWED_ROOTS before browsing");
    const canonical = await this.assertInsideRoots(path ?? roots[0]!, true);
    const cursor = page?.cursor ? decodeDirectoryCursor(page.cursor) : undefined;
    const pathHash = createHash("sha256").update(canonical).digest("hex");
    if (cursor && cursor.pathHash !== pathHash) throw new PathPolicyError("path_forbidden", "Directory cursor does not belong to this path");
    const paged = page?.limit !== undefined || cursor !== undefined;
    const limit = paged ? Math.min(Math.max(page?.limit ?? DEFAULT_DIRECTORY_PAGE_SIZE, 1), MAX_DIRECTORY_PAGE_SIZE) : Number.POSITIVE_INFINITY;
    let rawNames: string[];
    try {
      rawNames = await readdir(canonical);
    } catch (error) {
      // An unreadable directory is a configuration/permission fact about the
      // workspace, not an internal fault: reporting it as 500 makes a broken
      // root or mode look like a server bug.
      const errno = (error as NodeJS.ErrnoException).code;
      if (errno === "EACCES" || errno === "EPERM") throw new PathPolicyError("path_forbidden", "Directory is not readable with the current permissions");
      if (errno === "ENOENT") throw new PathPolicyError("path_not_found", "Path does not exist");
      if (errno === "ENOTDIR") throw new PathPolicyError("not_a_directory", "Path is not a directory");
      throw error;
    }
    const compareNames = (left: string, right: string) =>
      left.normalize("NFC").localeCompare(right.normalize("NFC")) || (left < right ? -1 : left > right ? 1 : 0);
    rawNames.sort(compareNames);
    // Cursor keys follow the existing NFC-name order; raw names only break equivalent-name ties deterministically. Additions before the cursor are omitted, while removals cannot shift unrelated rows across it; pages are not snapshots.
    const remaining = cursor ? rawNames.filter((name) => compareNames(name, cursor.rawName) > 0) : rawNames;
    const candidateNames = Number.isFinite(limit) ? remaining.slice(0, limit + 1) : remaining;
    const names = candidateNames.slice(0, limit);
    const entries = await Promise.all(names.map((name) => this.classifyChild(canonical, name)));
    const hasMore = candidateNames.length > names.length;
    const lastName = names.at(-1);
    const nextCursor = paged && hasMore && lastName
      ? encodeDirectoryCursor({ version: 1, pathHash, name: lastName.normalize("NFC"), rawName: lastName })
      : null;
    const parentPath = resolve(canonical, "..");
    return {
      path: canonical,
      parent: this.inside(parentPath, roots) ? parentPath : null,
      roots,
      entries,
      hasMore,
      nextCursor,
    };
  }
}
