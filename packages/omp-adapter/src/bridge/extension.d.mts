/**
 * Types for the OMP-side extension module.
 *
 * `extension.mjs` is loaded by OMP's own Bun runtime, never by this repository's
 * TypeScript build, so it carries no types of its own. This declaration exists
 * only so the tests that drive the real module can import it without a cast.
 */
export interface BridgeExtensionPi {
  on(event: string, handler: (event: unknown, ctx: unknown) => unknown): void;
}

export default function cawBridge(pi: BridgeExtensionPi): void;
