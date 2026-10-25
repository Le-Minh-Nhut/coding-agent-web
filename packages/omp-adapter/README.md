# @caw/omp-adapter

Adapter layer between Coding Agent Web workspace and local OMP runtime on Ubuntu.

## Modules

- `capabilities.ts`: detects `omp` and `tmux` binaries, parses versions, caches probe.
- `session-catalog.ts`: native session bucket encoding (`-tmp-...`, `-...`, `--...--`), bounded 64 KiB header parsing.
- `session-lease.ts`: Linux abstract socket lease detection (`@omp-file-lock-<high><low>`) with pure-TS xxh64.
- `tmux.ts`: isolated array-argv tmux session lifecycle (`caw-` namespace, `$N` identifiers).
- `collab-registry.ts`: `omp collab list` and `omp collab link` integration.
- `errors.ts`: typed adapter errors mapping to `@caw/contracts` error codes.
