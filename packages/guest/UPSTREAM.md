# Upstream Provenance and Vendoring Guide

## Provenance

- **Upstream Repository**: https://github.com/can1357/oh-my-pi
- **Upstream Version**: OMP v18.12.2 / v18.12.6
- **License**: MIT (see `NOTICE` in this directory)

## Vendored Sources

The guest client in this directory (`packages/guest/`) is vendored from upstream Oh My Pi:

1. `packages/collab-web`:
   - `index.html` -> `index.html`
   - `public/*` -> `public/*`
   - `src/` (main.tsx, app.tsx, components/**, lib/**, styles/**, tool-render/**) -> `src/`
2. `packages/wire/src/*.ts` -> `src/vendor/wire/`
   - Dependency-free wire protocol types (`WireFrame`, `CollabUiRequest`, etc.)
3. `packages/utils/src/` -> `src/vendor/utils/`
   - `marked.ts`, `marked-list.ts`, `math-delimiters.ts`
   - `marked/core.ts`, `marked/inline-closers.ts`, `marked/inline-text.ts`

## Modifications Relative to Upstream

1. **Third-Party Script & Remote Asset Removal (`index.html`)**:
   - Stripped third-party analytics script (`https://um.can.ac/script.js`).
   - Removed external metadata URLs pointing to `https://my.omp.sh/` and `https://omp.sh/`.
   - All asset references (icons, web manifest, Open Graph images) are origin-relative (`./...`).

2. **Content Security Policy (`index.html`)**:
   - Added meta CSP restricting `default-src 'none'`, `script-src 'self'`, `style-src 'self' 'unsafe-inline'`, `img-src 'self' data: https:`, `connect-src 'self' ws: wss:`, `font-src 'self' data:`, `manifest-src 'self'`, `frame-ancestors 'none'`, `base-uri 'none'`, `form-action 'self'`.

3. **Markdown & Image Scheme Hardening (`src/components/transcript/Markdown.tsx`)**:
   - Upstream renderer only gated links and html, leaving `renderer.image` without a scheme gate.
   - Added `safeSrc` gate: allows only `https:` and `data:image/(png|jpeg|jpg|gif|webp|svg+xml);base64,...`. Rejects `http:`, `javascript:`, `file:`, `blob:`, and non-image `data:` schemes.
   - Added `renderer.image` override to enforce `safeSrc` and safely escape title/alt attributes.
   - Enhanced external link safety with `rel="noopener noreferrer"`.
   - Exported `renderMarkdown` and `safeSrc` for testing.

4. **Mobile-First Layout & Safe Areas (`src/styles/base.css`, `src/components/shell/shell.css`)**:
   - Added `viewport-fit=cover` and iOS PWA meta tags in `index.html`.
   - Updated layout heights to use `100dvh` (dynamic viewport height) alongside `--viewport-height`.
   - Incorporated `env(safe-area-inset-top)`, `env(safe-area-inset-bottom)`, `env(safe-area-inset-left)`, and `env(safe-area-inset-right)` across the shell header, connect screen, and composer.
   - Kept composer bottom-docked with `visualViewport` dynamic height adjustment on virtual keyboard display.

5. **Toolchain & Type Compatibility (`scripts/build-guest.mjs`, `tsconfig.json`, `src/env.d.ts`)**:
   - Replaced bun-only build with pinned `esbuild` script (`scripts/build-guest.mjs`) that builds to `packages/guest/dist/` in ~200ms without bun.
   - Defined `Timer` type alias in `src/env.d.ts` to replace Bun-specific global types.
   - Configured path aliases in `tsconfig.json` and `build-guest.mjs` to resolve `@oh-my-pi/pi-wire` and `@oh-my-pi/pi-utils/*` to vendored sources.

## How to Re-Vendor on an Upstream Bump

1. Extract new upstream OMP sources (e.g. to `/tmp/upstream-omp`).
2. Copy client sources:
   ```bash
   cp -r /tmp/upstream-omp/packages/collab-web/public packages/guest/
   cp -r /tmp/upstream-omp/packages/collab-web/src packages/guest/
   cp -r /tmp/upstream-omp/packages/wire/src/*.ts packages/guest/src/vendor/wire/
   cp /tmp/upstream-omp/packages/utils/src/marked*.ts packages/guest/src/vendor/utils/
   cp /tmp/upstream-omp/packages/utils/src/math-delimiters.ts packages/guest/src/vendor/utils/
   cp -r /tmp/upstream-omp/packages/utils/src/marked packages/guest/src/vendor/utils/
   ```
3. Re-apply patches:
   - In `packages/guest/index.html`: re-check CSP, viewport-fit=cover, relative links, remove analytics.
   - In `packages/guest/src/components/transcript/Markdown.tsx`: re-verify `safeSrc` and `renderer.image` override.
   - In `packages/guest/src/components/shell/shell.css` and `src/styles/base.css`: ensure `100dvh` and `env(safe-area-inset-*)` rules are intact.
   - In `packages/guest/src/env.d.ts`: ensure `Timer` alias is present.
4. Verify build and tests:
   ```bash
   node scripts/build-guest.mjs
   pnpm --filter @caw/guest typecheck
   pnpm test tests/guest
   ```
