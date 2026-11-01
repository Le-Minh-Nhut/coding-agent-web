import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

describe("Mobile touch targets CSS specification", () => {
  const cssPath = resolve(__dirname, "../../apps/web/src/styles.css");
  const css = readFileSync(cssPath, "utf8");

  it("defines the --touch-min token at 44px", () => {
    expect(css).toMatch(/--touch-min:\s*44px;/);
  });

  it("enforces minimum touch dimensions on all buttons", () => {
    // Buttons must have min-height and min-width of --touch-min, with centered inline-flex layout
    expect(css).toMatch(/button\s*{[^}]*min-height:\s*var\(--touch-min\);/s);
    expect(css).toMatch(/button\s*{[^}]*min-width:\s*var\(--touch-min\);/s);
    expect(css).toMatch(/button\s*{[^}]*display:\s*inline-flex;/s);
    expect(css).toMatch(/button\s*{[^}]*align-items:\s*center;/s);
    expect(css).toMatch(/button\s*{[^}]*justify-content:\s*center;/s);
  });

  it("enforces minimum touch dimensions on form inputs and interactive selectors", () => {
    expect(css).toMatch(/input,\s*textarea,\s*select\s*{[^}]*min-height:\s*var\(--touch-min\);/s);
    expect(css).toMatch(/details\s+summary\s*{[^}]*min-height:\s*var\(--touch-min\);/s);
    expect(css).toMatch(/\.folder-item\s*{[^}]*min-height:\s*var\(--touch-min\);/s);
    expect(css).toMatch(/\[role="button"\]\s*{[^}]*min-height:\s*var\(--touch-min\);/s);
  });

  it("pins safe-area insets across screen edges and containers", () => {
    expect(css).toMatch(/--safe-top:\s*env\(safe-area-inset-top,\s*0px\);/);
    expect(css).toMatch(/--safe-bottom:\s*env\(safe-area-inset-bottom,\s*0px\);/);
    expect(css).toMatch(/\.app-header\s*{[^}]*padding:[^}]*var\(--safe-top\)/s);
    expect(css).toMatch(/\.composer-container\s*{[^}]*padding:[^}]*var\(--safe-bottom\)/s);
    expect(css).toMatch(/\.view-container\s*{[^}]*padding:[^}]*var\(--safe-top\)[^}]*var\(--safe-bottom\)/s);
    expect(css).toMatch(/\.modal-overlay\s*{[^}]*padding:[^}]*var\(--safe-top\)[^}]*var\(--safe-bottom\)/s);
  });
});
