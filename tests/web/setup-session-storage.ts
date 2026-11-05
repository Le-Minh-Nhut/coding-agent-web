/**
 * Per-test isolation for the one thing the app now persists.
 *
 * `App` mirrors retained recovery records into `sessionStorage` (see
 * `apps/web/src/prompt-recovery.ts`), which is the fix for the reload-loses-the-
 * prompt defect. Inside a single vitest worker that storage is shared by every
 * test in the file — so a record written by one test would hydrate into the next
 * one's `App`, and a test would see another test's refused prompt. That is test
 * contamination, not app behaviour: a real tab has exactly one `App`.
 *
 * Cleared before each test as well as after, so a test that seeds a store inside
 * its own body keeps it, and nothing survives into a file that only reads.
 */
import { beforeEach, afterEach } from "vitest";

function clear(): void {
  try {
    if (typeof window !== "undefined") window.sessionStorage.clear();
  } catch {
    /* Storage disabled in this environment: nothing was persisted either. */
  }
}

beforeEach(clear);
afterEach(clear);
