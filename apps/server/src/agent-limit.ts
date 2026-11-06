/**
 * The one place that decides how many managed main agents may run at once.
 *
 * Precedence, highest first:
 *
 *   1. The persisted setting (`settings:maxActiveAgents` in the metadata journal),
 *      written through the authenticated settings API.
 *   2. The environment/startup value (`CAW_MAX_ACTIVE_AGENTS`, schema default 3).
 *
 * The environment value is the *default for a fresh install*, not a ceiling: an
 * owner who raises the limit in the app means it, and a restart must not silently
 * undo it. There is no third hard ceiling beyond the schema bound — the operator
 * is the only authority on their own machine.
 *
 * The controller holds the effective number in memory and is the object the
 * supervisor reads at admission, so a change lands on the next launch without a
 * restart. The journal write happens first: the number stops being enforced
 * before it is durable, never after.
 */
import type { MetadataStore } from "./store.js";

export const AGENT_LIMIT_KEY = "maxActiveAgents";

/**
 * The bounds an accepted value must satisfy. These mirror the config schema
 * exactly (`config.ts`, `maxActiveAgents`), and the route validates against them
 * rather than trusting anything the client sent.
 */
export const AGENT_LIMIT_MIN = 1;
export const AGENT_LIMIT_MAX = 100;

export type AgentLimitSource = "setting" | "default";

export interface AgentLimitState {
  limit: number;
  source: AgentLimitSource;
}

export class AgentLimitError extends Error {
  constructor(readonly code: "invalid_limit", message: string) {
    super(message);
  }
}

/**
 * Validate one client-supplied value.
 *
 * Returns the integer, or throws. `Number(" 3 ")` is a number, `3.5` is not an
 * integer, `true` is a boolean and never becomes `1`, and a value outside the
 * schema bound is refused rather than clamped: silently turning `9999` into `100`
 * would make the setting lie about what the server enforces.
 */
export function parseAgentLimit(value: unknown): number {
  if (typeof value !== "number" || !Number.isInteger(value)) {
    throw new AgentLimitError("invalid_limit", "The agent limit must be a whole number.");
  }
  if (value < AGENT_LIMIT_MIN || value > AGENT_LIMIT_MAX) {
    throw new AgentLimitError("invalid_limit", `The agent limit must be between ${AGENT_LIMIT_MIN} and ${AGENT_LIMIT_MAX}.`);
  }
  return value;
}

export interface AgentLimitController {
  /** The limit in force right now. Cheap: no I/O, safe to call per admission. */
  current(): AgentLimitState;
  /** Adopt the persisted setting, if any. Call once at boot. */
  load(): Promise<AgentLimitState>;
  /** Validate, persist, then enforce. Rejects without changing anything. */
  update(value: unknown): Promise<AgentLimitState>;
}

export function createAgentLimit(options: { store: MetadataStore; fallback: number }): AgentLimitController {
  let state: AgentLimitState = { limit: options.fallback, source: "default" };
  return {
    current: () => state,
    async load() {
      const persisted = await options.store.getSetting<unknown>(AGENT_LIMIT_KEY);
      if (persisted === undefined) return state;
      try {
        state = { limit: parseAgentLimit(persisted), source: "setting" };
      } catch {
        // A hand-edited journal must not brick startup. Keep the env/default value
        // and leave the bad row in place; the next successful save overwrites it.
        state = { limit: options.fallback, source: "default" };
      }
      return state;
    },
    async update(value) {
      const limit = parseAgentLimit(value);
      await options.store.setSetting(AGENT_LIMIT_KEY, limit);
      state = { limit, source: "setting" };
      return state;
    },
  };
}
