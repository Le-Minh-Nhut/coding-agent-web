/**
 * `@caw/relay` package entrypoint: the relay, its static client handler, and the env-driven
 * composition the server process uses.
 */
import {
  DEFAULT_RELAY_HOST,
  DEFAULT_RELAY_PORT,
  createRelay,
  type Relay,
  type RelayOptions,
} from "./relay";

export * from "./relay";
export * from "./static";

/** Kept in lockstep with package.json; `tests/relay/package.test.ts` fails on drift. */
export const RELAY_VERSION = "0.1.0";

/** Environment variable names read by {@link relayOptionsFromEnv}. */
export const RELAY_ENV = {
  port: "CAW_RELAY_PORT",
  host: "CAW_RELAY_HOST",
  allowedOrigins: "CAW_RELAY_ALLOWED_ORIGINS",
  staticDir: "CAW_RELAY_STATIC_DIR",
} as const;

/**
 * Build relay options from the environment. Absent values fall back to the loopback defaults;
 * malformed values throw rather than silently binding somewhere unexpected.
 */
export function relayOptionsFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): RelayOptions {
  const options: RelayOptions = {
    host: env[RELAY_ENV.host] ?? DEFAULT_RELAY_HOST,
    port: DEFAULT_RELAY_PORT,
    version: RELAY_VERSION,
  };
  const rawPort = env[RELAY_ENV.port];
  if (rawPort !== undefined && rawPort !== "") {
    const parsed = Number(rawPort);
    if (!Number.isInteger(parsed) || parsed < 0 || parsed > 65_535) {
      throw new Error(
        `${RELAY_ENV.port} must be an integer port, received ${JSON.stringify(rawPort)}`,
      );
    }
    options.port = parsed;
  }
  const rawOrigins = env[RELAY_ENV.allowedOrigins];
  if (rawOrigins !== undefined && rawOrigins !== "") {
    const origins = rawOrigins
      .split(",")
      .map((entry) => entry.trim())
      .filter((entry) => entry !== "");
    if (origins.length === 0)
      throw new Error(`${RELAY_ENV.allowedOrigins} is set but lists no origin`);
    options.allowedOrigin = origins;
  }
  const rawStaticDir = env[RELAY_ENV.staticDir];
  if (rawStaticDir !== undefined && rawStaticDir !== "")
    options.staticDir = rawStaticDir;
  return options;
}

/**
 * Create and start the relay described by the environment. The caller owns the returned instance's
 * lifecycle (typically the server process, which stops it on SIGTERM).
 */
export async function startRelayFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): Promise<Relay> {
  const relay = createRelay(relayOptionsFromEnv(env));
  await relay.start();
  return relay;
}
