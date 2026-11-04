import { existsSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

/**
 * OMP's own directory resolution, mirrored.
 *
 * CAW reads OMP's state off the filesystem — session journals, writer leases,
 * the Collab discovery registry — so every one of those paths has to be the
 * path OMP itself would compute. Deriving them independently is how CAW and
 * OMP drifted apart: CAW treated any set `XDG_STATE_HOME` as authoritative
 * while OMP only adopts it once `$XDG_STATE_HOME/omp` actually exists, so a
 * user with the variable exported but nothing migrated had CAW probing a
 * directory OMP never writes.
 *
 * Mirrors `packages/utils/src/dirs.ts` in oh-my-pi. Keep the two in step.
 */

/** OMP's config-directory name; `PI_CONFIG_DIR` overrides the `.omp` default. */
const CONFIG_DIR_NAME = ".omp";

/** Profile-name grammar from OMP's `PROFILE_NAME_RE`. */
const PROFILE_NAME_RE = /^[a-z0-9][a-z0-9._-]{0,63}$/;

/** Windows device names OMP rejects as profile names. */
const WINDOWS_RESERVED_BASENAME_RE = /^(?:CON|PRN|AUX|NUL|COM[0-9]|LPT[0-9])(?:\..*)?$/i;

/**
 * Normalize and validate a profile name the way OMP does. `undefined` is the
 * implicit default (empty, whitespace, or the `default` sentinel); a malformed
 * name throws, because resolving a path OMP would refuse to resolve is worse
 * than failing loudly.
 */
export function normalizeProfileName(profile: string | undefined): string | undefined {
  const normalized = profile?.trim();
  if (!normalized || normalized === "default") return undefined;
  if (
    normalized === "." ||
    normalized === ".." ||
    normalized.endsWith(".") ||
    !PROFILE_NAME_RE.test(normalized) ||
    WINDOWS_RESERVED_BASENAME_RE.test(normalized)
  ) {
    throw new Error(
      `Invalid OMP profile "${profile}". Profile names must match ${PROFILE_NAME_RE.source}, ` +
        `cannot be "." or "..", cannot end with ".", and cannot be a Windows reserved device name ` +
        `(CON, PRN, AUX, NUL, COM0-9, LPT0-9, or any of those with an extension).`,
    );
  }
  return normalized;
}

/**
 * The active profile from OMP's two env vars. `OMP_PROFILE` is canonical and
 * takes precedence; an explicitly-empty `OMP_PROFILE` selects the default
 * profile rather than falling back to `PI_PROFILE`.
 */
export function resolveProfileEnv(omp: string | undefined, pi: string | undefined): string | undefined {
  return normalizeProfileName(omp !== undefined ? omp : pi);
}

/** Profile-independent config root (`~/.omp`), shared by every OMP profile. */
export function getBaseConfigRoot(): string {
  return path.join(homedir(), process.env.PI_CONFIG_DIR || CONFIG_DIR_NAME);
}

function getProfileConfigRoot(profile: string | undefined): string {
  const root = getBaseConfigRoot();
  return profile ? path.join(root, "profiles", profile) : root;
}

/**
 * Whether `XDG_*_HOME` is in play. Linux/Darwin only, and only once the
 * `$XDG_*_HOME/omp` app root exists — OMP does not adopt an XDG root that has
 * never been created (`omp config init-xdg` makes it). Keying on the variable
 * alone is the mismatch this module exists to prevent.
 */
function xdgAppRoot(envVar: string, profile: string | undefined): string | undefined {
  if (process.platform !== "linux" && process.platform !== "darwin") return undefined;
  const value = process.env[envVar];
  if (!value) return undefined;
  const appRoot = path.join(value, "omp");
  if (profile) {
    // Named profiles are pinned on the profile-specific XDG path, never the
    // base app root, so a profile's location cannot silently move later.
    const profilePath = path.join(appRoot, "profiles", profile);
    return existsSync(profilePath) ? profilePath : undefined;
  }
  return existsSync(appRoot) ? appRoot : undefined;
}

/**
 * The XDG root OMP would use for machine-global (`baseRoot`) paths. Unlike the
 * per-agent gate this is keyed on the base app root alone, independent of both
 * the profile and any agent-dir override, so every OMP process on the machine
 * agrees on one location.
 */
function baseXdgRoot(envVar: string): string | undefined {
  if (process.platform !== "linux" && process.platform !== "darwin") return undefined;
  const value = process.env[envVar];
  if (!value) return undefined;
  const appRoot = path.join(value, "omp");
  return existsSync(appRoot) ? appRoot : undefined;
}

export interface OmpDirOptions {
  /** `PI_CODING_AGENT_DIR` override; ignored while a named profile is active, as OMP does. */
  agentDirOverride?: string;
  /** Active profile; defaults to `OMP_PROFILE ?? PI_PROFILE`. */
  profile?: string;
}

export interface OmpDirs {
  /** Session journals' parent directory. */
  sessionsDir: string;
  /** Session ownership leases (shared by every profile). */
  sessionOwnersDir: string;
  /** Collab host discovery registry (shared by every profile). */
  collabHostsDir: string;
}

/**
 * Resolve the three OMP directories CAW reads, using OMP's rules.
 *
 * The Collab registry and the lease directory are profile-independent in OMP
 * (any process under any profile must meet the same lease), and the registry
 * deliberately ignores the XDG override entirely — OMP's
 * `collabHostsRuntimeDir()` is `getBaseConfigRoot()/run/collab-hosts` with no
 * XDG branch, so a set `XDG_STATE_HOME` must not move it here either.
 */
export function resolveOmpDirs(options: OmpDirOptions = {}): OmpDirs {
  const profile = normalizeProfileName(options.profile ?? process.env.OMP_PROFILE ?? process.env.PI_PROFILE);
  const baseRoot = getBaseConfigRoot();

  const configRoot = getProfileConfigRoot(profile);
  const defaultAgentDir = path.join(configRoot, "agent");
  const agentDirOverride = profile ? undefined : options.agentDirOverride;
  const agentDir = agentDirOverride ? path.resolve(agentDirOverride) : defaultAgentDir;

  const isDefaultAgentDir = agentDir === defaultAgentDir;
  // Match OMP: an explicit agent-dir override wins over XDG.
  const xdgData = isDefaultAgentDir ? xdgAppRoot("XDG_DATA_HOME", profile) : undefined;
  // XDG flattens the agent/ prefix: ~/.omp/agent/sessions → $XDG_DATA_HOME/omp/sessions
  const agentDataRoot = xdgData ?? agentDir;

  const baseStateRoot = baseXdgRoot("XDG_STATE_HOME") ?? baseRoot;

  return {
    sessionsDir: path.join(agentDataRoot, "sessions"),
    sessionOwnersDir: path.join(baseStateRoot, "run", "session-owners"),
    collabHostsDir: path.join(baseRoot, "run", "collab-hosts"),
  };
}
