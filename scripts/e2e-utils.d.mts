export function matchesServerWriterEnviron(environ: string, stateDir: string): boolean;
export function reapServerWriters(stateDir: string, excludedPid: number, signal?: NodeJS.Signals): void;
