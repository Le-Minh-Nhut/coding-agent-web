import { createHash, randomBytes, scrypt as scryptCallback, timingSafeEqual } from "node:crypto";
import { constants } from "node:fs";
import { promisify } from "node:util";
import { chmod, mkdir, open, rename, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { loadConfig } from "./config.js";

const scrypt = promisify(scryptCallback);
const HASH_BYTES = 64;
const COOKIE_NAME = "__Host-caw_session";
const PENDING_TOKEN_TTL_MS = 15 * 60_000;

type PasswordRecord = { salt: string; hash: string; kind: "password"; legacy?: true };
type PendingRecord = { salt: string; hash: string; kind: "pending"; expiresAt: number; used?: true };
type AuthRecord = PasswordRecord | PendingRecord;
type AuthenticationResult = "password" | "setup" | false;
type SessionRecord = { csrf: string; expiresAt: number; passwordSetupRequired: boolean };
type RateState = { failures: number; blockedUntil: number };
export type PasswordSetupResult = "changed" | "matches_pending_token" | false;

export interface AuthenticationService {
  cookieName: string;
  initAuth(): Promise<{ setupRequired: boolean; setupToken?: string }>;
  authenticate(password: string, ip?: string): Promise<AuthenticationResult>;
  verifyPassword(password: string, ip?: string): Promise<boolean>;
  createSession(passwordSetupRequired?: boolean): { token: string; csrfToken: string; expiresAt: number };
  verifySession(token: string | undefined): { csrfToken: string; expiresAt: number; passwordSetupRequired: boolean } | null;
  completePasswordSetup(password: string, sessionToken: string): Promise<PasswordSetupResult>;
  changePassword(currentPassword: string, newPassword: string, sessionToken: string, ip?: string): Promise<boolean>;
  verifyCsrf(token: string | undefined, csrf: string | undefined): boolean;
  revokeAll(): void;
  revokeAllExcept(token: string): void;
  resetAuth(): Promise<string>;
  cookie(token: string, maxAgeSeconds: number): string;
  clearCookie(): string;
}

function safeEqual(left: string, right: string): boolean {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
}

const GLOBAL_FAILURE_THRESHOLD = 50;

export function createAuthenticationService(options: { stateDir: string; ttlHours?: number; insecureCookies?: boolean; now?: () => number; setupOutput?: (token: string) => void }): AuthenticationService {
  const file = join(options.stateDir, "auth-password.json");
  const cookieName = options.insecureCookies ? "caw_session" : COOKIE_NAME;
  const sessions = new Map<string, SessionRecord>();
  const ipRates = new Map<string, RateState>();
  let globalRate: RateState = { failures: 0, blockedUntil: 0 };
  let credentialWriteInProgress = false;
  const ttlMs = (options.ttlHours ?? 720) * 60 * 60 * 1000;
  const now = options.now ?? Date.now;
  let authRecord: AuthRecord | null = null;
  /**
   * F-A2: bumped by every credential write. A password check reads the record
   * before its scrypt await, so a rotation that lands inside that window would
   * otherwise let a login authenticated against the OLD credential mint a live
   * session. The check compares this counter across the await and refuses.
   */
  let credentialGeneration = 0;

  async function derive(password: string, salt: Buffer): Promise<Buffer> {
    return Buffer.from(await scrypt(password, salt, HASH_BYTES) as Buffer);
  }

  async function persistRecord(record: AuthRecord): Promise<void> {
    await mkdir(options.stateDir, { recursive: true, mode: 0o700 });
    await chmod(options.stateDir, 0o700);
    const temp = `${file}.${randomBytes(8).toString("hex")}.tmp`;
    await writeFile(temp, JSON.stringify(record), { mode: 0o600, flag: "wx" });
    await chmod(temp, 0o600);
    await rename(temp, file);
    authRecord = record;
    credentialGeneration += 1;
  }

  async function matches(password: string, kind: AuthRecord["kind"]): Promise<boolean> {
    const record = authRecord;
    if (!record || record.kind !== kind) return false;
    if (record.kind === "pending" && (record.expiresAt <= now() || record.used)) return false;
    // F-A2: `derive` (scrypt) is an await window. A credential write that lands
    // inside it — a password rotation or a reset — means the hash just compared
    // is no longer the credential of record, so the comparison proves nothing
    // about the CURRENT credential. Refuse; the caller answers 401.
    const generation = credentialGeneration;
    const candidate = await derive(password, Buffer.from(record.salt, "hex"));
    if (credentialGeneration !== generation) return false;
    return safeEqual(candidate.toString("hex"), record.hash);
  }

  async function matchesPendingToken(password: string): Promise<boolean> {
    const record = authRecord;
    if (record?.kind !== "pending" || !record.used || record.expiresAt <= now()) return false;
    // F-A2 family: a reset that persists a new pending token inside the scrypt
    // window invalidates the record compared here.
    const generation = credentialGeneration;
    const candidate = await derive(password, Buffer.from(record.salt, "hex"));
    if (credentialGeneration !== generation) return false;
    return safeEqual(candidate.toString("hex"), record.hash);
  }

  function recordFailure(ip: string, time: number, state: RateState): void {
    const failures = state.failures + 1;
    ipRates.set(ip, { failures, blockedUntil: time + Math.min(15 * 60_000, 250 * 2 ** Math.min(failures - 1, 12)) });
    const globalFailures = globalRate.failures + 1;
    const globalBlockedUntil = globalFailures >= GLOBAL_FAILURE_THRESHOLD
      ? time + Math.min(15 * 60_000, 250 * 2 ** Math.min(globalFailures - GLOBAL_FAILURE_THRESHOLD, 12))
      : 0;
    globalRate = { failures: globalFailures, blockedUntil: globalBlockedUntil };
  }

  async function checkCredential(password: string, ip: string, allowSetup = true): Promise<AuthenticationResult> {
    const time = now();
    const ipState = ipRates.get(ip) ?? { failures: 0, blockedUntil: 0 };
    if (time < ipState.blockedUntil || time < globalRate.blockedUntil) return false;

    const passwordValid = await matches(password, "password");
    let result: AuthenticationResult = passwordValid ? "password" : false;
    if (!passwordValid && allowSetup && !credentialWriteInProgress && await matches(password, "pending")) {
      const pending = authRecord;
      if (pending?.kind === "pending" && !pending.used && !credentialWriteInProgress) {
        credentialWriteInProgress = true;
        try {
          await persistRecord({ ...pending, used: true });
          result = "setup";
        } catch {
          result = false;
        } finally {
          credentialWriteInProgress = false;
        }
      }
    }
    if (result) {
      ipRates.delete(ip);
      globalRate = { failures: 0, blockedUntil: 0 };
    } else {
      recordFailure(ip, time, ipState);
    }
    return result;
  }


  async function mintPendingToken(): Promise<string> {
    const setupToken = randomBytes(32).toString("base64url");
    const salt = randomBytes(16);
    await persistRecord({
      kind: "pending",
      salt: salt.toString("hex"),
      hash: (await derive(setupToken, salt)).toString("hex"),
      expiresAt: now() + PENDING_TOKEN_TTL_MS,
    });
    sessions.clear();
    return setupToken;
  }

  async function verifyPasswordOnly(password: string, ip: string): Promise<boolean> {
    return (await checkCredential(password, ip, false)) === "password";
  }

  return {
    cookieName,
    async initAuth() {
      let handle;
      try { handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW); }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw new Error(`Cannot open auth password record: ${error instanceof Error ? error.message : String(error)}`);
        const setupToken = await mintPendingToken();
        (options.setupOutput ?? ((token) => process.stdout.write(`Coding Agent Web one-time setup token: ${token}\n`)))(setupToken);
        return { setupRequired: true, setupToken };
      }

      try {
        if (!(await handle.stat()).isFile()) throw new Error("auth password record is not a regular file");
        await handle.chmod(0o600);
        const parsed: unknown = JSON.parse(await handle.readFile("utf8"));
        if (!parsed || typeof parsed !== "object") throw new Error("Invalid auth password record format");
        const record = parsed as Record<string, unknown>;
        if (typeof record.salt !== "string" || !/^[a-f0-9]{32}$/.test(record.salt) || typeof record.hash !== "string" || !/^[a-f0-9]{128}$/.test(record.hash)) throw new Error("Invalid auth password record format");
        if (record.kind === undefined) {
          authRecord = { salt: record.salt, hash: record.hash, kind: "password", legacy: true };
          await handle.close();
          handle = undefined;
          await persistRecord(authRecord);
          return { setupRequired: false };
        }
        if (record.kind === "password" && (record.legacy === undefined || record.legacy === true)) {
          authRecord = { salt: record.salt, hash: record.hash, kind: "password", ...(record.legacy === true ? { legacy: true as const } : {}) };
        } else if (record.kind === "pending" && (record.used === undefined || record.used === true) && typeof record.expiresAt === "number" && Number.isFinite(record.expiresAt)) {
          authRecord = { salt: record.salt, hash: record.hash, kind: "pending", expiresAt: record.expiresAt, ...(record.used === true ? { used: true as const } : {}) };
        } else {
          throw new Error("Invalid auth password record format");
        }
      } finally {
        await handle?.close();
      }
      return { setupRequired: authRecord?.kind === "pending" };
    },
    async authenticate(password, ip = "unknown") {
      return checkCredential(password, ip);
    },
    async verifyPassword(password, ip = "unknown") {
      return (await checkCredential(password, ip, false)) === "password";
    },
    createSession(passwordSetupRequired = false) {
      const token = randomBytes(32).toString("base64url");
      const csrfToken = randomBytes(32).toString("base64url");
      const expiresAt = now() + ttlMs;
      sessions.set(createHash("sha256").update(token).digest("hex"), { csrf: csrfToken, expiresAt, passwordSetupRequired });
      return { token, csrfToken, expiresAt };
    },
    verifySession(token) {
      if (!token) return null;
      const key = createHash("sha256").update(token).digest("hex");
      const record = sessions.get(key);
      if (!record) return null;
      if (record.expiresAt <= now()) {
        sessions.delete(key);
        return null;
      }
      return { csrfToken: record.csrf, expiresAt: record.expiresAt, passwordSetupRequired: record.passwordSetupRequired };
    },
    async completePasswordSetup(password, sessionToken) {
      const key = createHash("sha256").update(sessionToken).digest("hex");
      const session = sessions.get(key);
      if (!session?.passwordSetupRequired || session.expiresAt <= now() || credentialWriteInProgress || !(authRecord?.kind === "pending" && authRecord.used && authRecord.expiresAt > now())) return false;
      credentialWriteInProgress = true;
      try {
        if (await matchesPendingToken(password)) return "matches_pending_token";
        const salt = randomBytes(16);
        await persistRecord({ kind: "password", salt: salt.toString("hex"), hash: (await derive(password, salt)).toString("hex") });
        // Deriving and persisting the credential is an await window. A logout
        // (`revokeAll`) or a reset that lands inside it clears the map, and
        // re-setting the captured object afterwards would resurrect a session the
        // owner already revoked. Keep the session only when the map still holds
        // that exact object (the same token key, never replaced) and it has not
        // expired since; the new credential is already on disk either way. When it
        // is gone the change still reports success and the client simply gets 401
        // on the next call, which is the honest answer.
        //
        // F-A1: every OTHER live session must still be revoked. The requester's
        // own expiry must not make the revocation conditional, so the clear is
        // unconditional and only the re-add is gated.
        const stillOurs = sessions.get(key) === session && session.expiresAt > now();
        sessions.clear();
        if (stillOurs) {
          session.passwordSetupRequired = false;
          sessions.set(key, session);
        }
        return "changed";
      } finally {
        credentialWriteInProgress = false;
      }
    },
    async changePassword(currentPassword, newPassword, sessionToken, ip = "unknown") {
      const key = createHash("sha256").update(sessionToken).digest("hex");
      const session = sessions.get(key);
      if (!session || session.passwordSetupRequired || session.expiresAt <= now() || credentialWriteInProgress) return false;
      credentialWriteInProgress = true;
      try {
        if (!(await verifyPasswordOnly(currentPassword, ip))) return false;
        const salt = randomBytes(16);
        await persistRecord({ kind: "password", salt: salt.toString("hex"), hash: (await derive(newPassword, salt)).toString("hex") });
        // Same revocation window as completePasswordSetup: a logout or reset that
        // revoked this session while the new credential was being derived and
        // persisted must not be undone by reinstating the captured object.
        // F-A1: and the other live sessions are revoked regardless of whether the
        // requester itself expired inside the window.
        const stillOurs = sessions.get(key) === session && session.expiresAt > now();
        sessions.clear();
        if (stillOurs) sessions.set(key, session);
        return true;
      } finally {
        credentialWriteInProgress = false;
      }
    },
    verifyCsrf(token, csrf) {
      const session = this.verifySession(token);
      return !!session && !!csrf && safeEqual(session.csrfToken, csrf);
    },
    revokeAll() {
      sessions.clear();
    },
    revokeAllExcept(token) {
      const keep = createHash("sha256").update(token).digest("hex");
      for (const key of sessions.keys()) if (key !== keep) sessions.delete(key);
    },
    async resetAuth() {
      const setupToken = await mintPendingToken();
      (options.setupOutput ?? ((token) => process.stdout.write(`Coding Agent Web one-time setup token: ${token}\n`)))(setupToken);
      return setupToken;
    },
    cookie(token, maxAgeSeconds) {
      const secure = options.insecureCookies ? "" : "; Secure";
      return `${cookieName}=${token}; HttpOnly; SameSite=Lax; Path=/${secure}; Max-Age=${Math.max(0, Math.floor(maxAgeSeconds))}`;
    },
    clearCookie() {
      const secure = options.insecureCookies ? "" : "; Secure";
      return `${cookieName}=; HttpOnly; SameSite=Lax; Path=/${secure}; Max-Age=0`;
    },
  };
}

export const sessionCookieName = COOKIE_NAME;

async function runAuthCli(): Promise<void> {
  if (process.argv[2] !== "reset" || process.argv.length > 3) {
    process.stderr.write("Usage: pnpm --filter @caw/server exec tsx src/auth.ts reset\n");
    process.exitCode = 2;
    return;
  }
  const config = await loadConfig();
  const auth = createAuthenticationService({ stateDir: config.stateDir });
  await auth.resetAuth();
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  runAuthCli().catch((error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
