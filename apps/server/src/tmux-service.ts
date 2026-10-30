import { join } from "node:path";
import { DefaultTmuxService } from "@caw/omp-adapter";
import type { ServerConfig } from "./config.js";

/** Options every agent launch goes through; exported so a test can assert the wiring. */
export interface PrivateTmuxServiceOptions {
  socketPath: string;
  ompBinary: string | undefined;
}

/**
 * The tmux server this app owns, addressed by its own socket.
 *
 * Two reasons this is not the default server:
 *
 *  1. The owner's own tmux work stays untouched — we never list, adopt or kill a
 *     session we did not create, and our names cannot collide with theirs.
 *  2. A conversation's recorded tmux session id (`$N`) is only unique within one
 *     tmux server lifetime. Binding identity to a server we own, and recording
 *     that server's identity (`#{start_time}`) alongside the id, is what makes
 *     "is `$3` still my agent?" answerable after a restart. On the shared default
 *     server, `$3` could be anything.
 */
export function privateTmuxSocketPath(config: ServerConfig): string {
  return join(config.stateDir, "tmux.sock");
}

/**
 * The launch options the app's tmux service is built from.
 *
 * `config.ompBinaryPath` is the one knob for the `omp` binary this server runs:
 * it pins the Collab registry *and* the agent command tmux is asked to start. A
 * real deployment leaves it unset and gets `omp` from PATH, which the adapter
 * turns into its `"omp"` default; the browser E2E harness sets it to a recorder
 * stub so a create-chat cannot start a real agent.
 */
export function privateTmuxServiceOptions(config: ServerConfig): PrivateTmuxServiceOptions {
  return { socketPath: privateTmuxSocketPath(config), ompBinary: config.ompBinaryPath };
}

/**
 * Kept side-effect free and importable on its own so a test can build exactly the
 * service the server builds without booting the server.
 */
export function createPrivateTmuxService(config: ServerConfig): DefaultTmuxService {
  return new DefaultTmuxService(privateTmuxServiceOptions(config));
}
