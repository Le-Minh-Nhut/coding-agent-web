import { createHash, randomBytes, scrypt as scryptCallback, timingSafeEqual } from "node:crypto";
import { constants } from "node:fs";
import { promisify } from "node:util";
import { chmod, mkdir, open, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";

const scrypt = promisify(scryptCallback);
const HASH_BYTES = 64;
const COOKIE_NAME = "__Host-caw_session";

type PasswordRecord = { salt: string; hash: string };
type SessionRecord = { csrf: string; expiresAt: number };
type RateState = { failures: number; blockedUntil: number };

export interface AuthenticationService {
  cookieName: string;
  initAuth(): Promise<{ setupRequired: boolean; setupToken?: string }>;
  verifyPassword(password: string, ip?: string): Promise<boolean>;
  createSession(): { token: string; csrfToken: string; expiresAt: number };
  verifySession(token: string | undefined): { csrfToken: string; expiresAt: number } | null;
  verifyCsrf(token: string | undefined, csrf: string | undefined): boolean;
  revokeAll(): void;
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
  const ttlMs = (options.ttlHours ?? 720) * 60 * 60 * 1000;
  const now = options.now ?? Date.now;
  let passwordRecord: PasswordRecord | null = null;

  async function derive(password: string, salt: Buffer): Promise<Buffer> {
    return Buffer.from(await scrypt(password, salt, HASH_BYTES) as Buffer);
  }
  async function persistPassword(password: string): Promise<void> {
    await mkdir(options.stateDir, { recursive: true, mode: 0o700 });
    const salt = randomBytes(16);
    const record = { salt: salt.toString("hex"), hash: (await derive(password, salt)).toString("hex") };
    const temp = `${file}.${randomBytes(8).toString("hex")}.tmp`;
    await mkdir(options.stateDir, { recursive: true, mode: 0o700 });
    await chmod(options.stateDir, 0o700);
    await writeFile(temp, JSON.stringify(record), { mode: 0o600, flag: "wx" });
    await chmod(temp, 0o600);
    await rename(temp, file);
    passwordRecord = record;
  }

  return {
    cookieName,
    async initAuth() {
      let handle;
      try { handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW); }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw new Error(`Cannot open auth password record: ${error instanceof Error ? error.message : String(error)}`);
        const setupToken = randomBytes(32).toString("base64url");
        await persistPassword(setupToken);
        (options.setupOutput ?? ((token) => process.stdout.write(`Coding Agent Web one-time setup token: ${token}\n`)))(setupToken);
        return { setupRequired: true, setupToken };
      }
      try {
        if (!(await handle.stat()).isFile()) throw new Error("auth password record is not a regular file");
        await handle.chmod(0o600);
        passwordRecord = JSON.parse(await handle.readFile("utf8")) as PasswordRecord;
      } finally { await handle.close(); }
      if (!/^[a-f0-9]{32}$/.test(passwordRecord.salt) || !/^[a-f0-9]{128}$/.test(passwordRecord.hash)) throw new Error("Invalid auth password record format");
      return { setupRequired: false };
    },
    async verifyPassword(password, ip = "unknown") {
      const time = now();
      const ipState = ipRates.get(ip) ?? { failures: 0, blockedUntil: 0 };
      if (time < ipState.blockedUntil || time < globalRate.blockedUntil) return false;
      let valid = false;
      if (passwordRecord) valid = timingSafeEqual(await derive(password, Buffer.from(passwordRecord.salt, "hex")), Buffer.from(passwordRecord.hash, "hex"));
      if (valid) {
        ipRates.delete(ip);
        globalRate = { failures: 0, blockedUntil: 0 };
      } else {
        const failures = ipState.failures + 1;
        ipRates.set(ip, { failures, blockedUntil: time + Math.min(15 * 60_000, 250 * 2 ** Math.min(failures - 1, 12)) });
        const globalFailures = globalRate.failures + 1;
        const globalBlockedUntil = globalFailures >= GLOBAL_FAILURE_THRESHOLD
          ? time + Math.min(15 * 60_000, 250 * 2 ** Math.min(globalFailures - GLOBAL_FAILURE_THRESHOLD, 12))
          : 0;
        globalRate = { failures: globalFailures, blockedUntil: globalBlockedUntil };
      }
      return valid;
    },
    createSession() {
      const token = randomBytes(32).toString("base64url");
      const csrfToken = randomBytes(32).toString("base64url");
      const expiresAt = now() + ttlMs;
      sessions.set(createHash("sha256").update(token).digest("hex"), { csrf: csrfToken, expiresAt });
      return { token, csrfToken, expiresAt };
    },
    verifySession(token) {
      if (!token) return null;
      const key = createHash("sha256").update(token).digest("hex");
      const record = sessions.get(key);
      if (!record) return null;
      if (record.expiresAt <= now()) { sessions.delete(key); return null; }
      return { csrfToken: record.csrf, expiresAt: record.expiresAt };
    },
    verifyCsrf(token, csrf) {
      const session = this.verifySession(token);
      return !!session && !!csrf && safeEqual(session.csrfToken, csrf);
    },
    revokeAll() { sessions.clear(); },
    cookie(token, maxAgeSeconds) {
      // Secure means browsers must reach this server over HTTPS; tailscale serve provides HTTPS.
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
