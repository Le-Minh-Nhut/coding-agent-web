# Screenshot Evidence Policy (Option B — External Evidence)

1. **Tracked repository baseline**:
   `docs/assets/screens/` tracks 83 historical PNG screenshots across 5 viewports (375×812, 390×844, 430×932, 768×1024, 1280×800).

2. **External evidence**:
   Full test suites test 7 viewports producing 109 screenshots. The 26 additional images (375×667: 13, 1440×900: 13) are external evidence generated into scratch directories (`$TMPDIR/caw-screens` or `/var/tmp/r30-web/screens`) and intentionally kept outside git to avoid repository bloat. They are not claimed as tracked git artifacts.

3. **Output guard**:
   `tests/e2e/screens.spec.ts` defaults to `$TMPDIR/caw-screens` and refuses to write inside `docs/` unless `CAW_SCREENSHOTS_COMMIT=1` is explicitly set. Standard `pnpm test:e2e` runs never modify committed screenshots.
