# Round 8: Mobile UX Visual Review & Screen Assessment

Generated: 2026-10-26  
Auditor: Vision Reviewer (`ws7-vision-review`)  
Basis: Pixel inspection of rendered PNG screenshots in `docs/assets/screens/` combined with Playwright DOM geometry from `manifest.md`.

---

## 1. Executive Summary

### Three Worst Issues Across All Screens
1. **Markdown Table Column Collapse (Severity: HIGH)**  
   - **File**: `docs/assets/screens/390x844-wide-table.png` (also verified in `375x812-wide-table.png`, `430x932-wide-table.png`).  
   - **Observed Behavior**: The 10-column table has no `min-width` or wrapper with `overflow-x: auto; white-space: nowrap`. As a result, columns collapse down to ~30px widths on mobile, forcing every word into a vertical single-letter ribbon (`n-o-d-e---e-a-s-t---0-1`). The table is completely unreadable.  
   - **Minimal Adjustment**: Wrap Markdown `<table>` elements in an `overflow-x: auto` container and set `white-space: nowrap; min-width: max-content;` so columns maintain their natural width and scroll horizontally.
2. **Floating "↓ Latest" Button Occlusion & Popover Collision (Severity: HIGH)**  
   - **File**: `docs/assets/screens/390x844-slash-suggestions.png`, `docs/assets/screens/390x844-long-response.png`, `docs/assets/screens/375x812-expanded-tool-details.png`.  
   - **Observed Behavior**: The "↓ Latest" button floats in a fixed position at bottom-right inside `.messages-scroll`. In chat viewports, it floats directly on top of the text and code block tail lines. In slash-suggestions viewports, it sits directly over the `/goal` suggestion and `/clear` tag, blocking touch interactions and obscuring content.  
   - **Minimal Adjustment**: (a) Hide "↓ Latest" whenever the slash suggestions menu or composer popups are open; (b) Add bottom clearance padding inside `.messages-scroll` so transcript text never terminates underneath the button.
3. **Abrupt Code Line Truncation Without Overflow Affordance (Severity: MED)**  
   - **File**: `docs/assets/screens/390x844-large-code-block.png`, `docs/assets/screens/375x812-expanded-tool-details.png`.  
   - **Observed Behavior**: Monospace `<pre>` blocks correctly isolate horizontal scroll, but on iOS (where scrollbars are hidden by default), lines cut off cleanly at the right border (`// A ~200-character line to verify horizo`, `(14 te`). There is no visual cue (fade gradient or right-edge shadow) indicating that code continues offscreen.  
   - **Minimal Adjustment**: Add a subtle right-edge fade mask (`mask-image: linear-gradient(to right, black calc(100% - 24px), transparent)`) or border-right shadow on horizontally scrolling code blocks.

### Three Things That Look Genuinely Good
1. **Typography & Dark Contrast**: The 15px font with 22.5px line-height on dark slate cards (`#161b22`) over deep navy-black backgrounds (`#0d1117`) offers superb contrast, crisp character rendering, and a comfortable ~45-character line length that prevents reading fatigue.
2. **Navigation & Session Management Screens**: `390x844-conversation-list.png` and `390x844-project-list.png` provide clear hierarchy, generous card padding, full ≥44px touch targets (`+ New chat`, `Resume in app`, `← Back`), and distinct color-coded badges (`LIVE`, `STARTING`, `TRACKED`).
3. **Subagent & Modal Overlays**: `390x844-subagent-panel.png` and `390x844-new-folder-form.png` present well-proportioned centered dialogs with ~16px gutters, clean scrim dimming, and obvious tap targets.

### Bed-Reading Assessment ("Could I read a long coding-agent response on this in bed on an iPhone without strain?")
**Yes, with two specific reservations.** For plain prose responses, reading in a dark room at arm's length is comfortable and low-strain: the dark background eliminates glare, the 15px/22.5px typography is sharp, and message line lengths naturally avoid excessive eye tracking. However, reading experience degrades immediately if the response contains tabular data or long code snippets: tables become an unreadable vertical ribbon of single characters, and long code lines truncate with no visual hint that swiping horizontally is possible. Furthermore, the "↓ Latest" floating pill currently sits directly on top of the final sentences of the assistant response, requiring the user to manually scroll past the tail just to read concluding remarks. Fixing the table horizontal scroll and clearing the "↓ Latest" button overlap will make long-form reading completely effortless.

---

## 2. Core iPhone Screen Assessments (390×844 & 375×812)

### 1. `390x844-long-response.png`
- **What is Visible**: Header with back arrow (`←`), "Seeded conversation" title, "Effective model: not reported" subtitle, and "Activity" button. Collapsible "Conversation model settings" summary box below header. "Connected — no turn in flight" blue status banner. Chat transcript with right-aligned User bubble ("Check status of the test suite"), left-aligned Assistant card ("All 42 tests passing..."), second User bubble, and start of Assistant's "Test Suite Audit & Session Verification Report". Floating "↓ Latest" button in lower right. Docked composer at bottom (`Send instructions to agent...` input and blue `Send` button).
- **Text Readability**: Body text (15px / 22.5px) is very comfortable. High contrast white/off-white text on dark slate-blue cards (`#161b22`). Optimal line length of 40–45 characters per line.
- **Spacing / Density**: Card padding (12–16px) is airy. Message boundaries are unmistakable. Top chrome (header + model settings box + status banner) occupies ~165px (~20% of vertical space), which reduces transcript viewport height but leaves enough room for reading.
- **Clipping / Overlap**: **DEFECT**. The floating "↓ Latest" pill button sits directly on top of the assistant message body text, obscuring words ("disco", "and high-frequency stream interleaving").
- **Buttons / Touch Affordances**: `Send` button (blue, ~44px height) is prominent. Composer input is easy to tap. Back arrow `←` has 45×44px hit target according to manifest, though visually compact.
- **Visual Hierarchy**: Conversation content occupies the center, but the top model settings box is visually heavy.
- **Verdict**: `needs a specific minimal adjustment`
  - *Smallest concrete change*: Add bottom margin or padding clearance inside `.messages-scroll` so message text cannot scroll directly behind the floating "↓ Latest" button.

---

### 2. `390x844-large-code-block.png`
- **What is Visible**: Scrolled transcript showing heading "Stream Reconstruction Implementation", intro sentence, and a TypeScript code block. Below it, test runner intro sentence and a second code block showing test output. Floating "↓ Latest" button in lower right. Docked composer at bottom.
- **Code Blocks & Monospace Legibility**: Monospace font (13–14px) is clean and legible. The toolbar displays language tag (`typescript`, `text`) on left and "Copy" button on right.
- **Horizontal Scroll & Truncation**: Long lines (`// A ~200-character line to verify horizo`, `const activeStreamBuffer = await fetchR`) cut off sharply at the right border. Because iOS suppresses scrollbars until active touch, there is no visual affordance that the code block scrolls horizontally.
- **Clipping / Overlap**: The "↓ Latest" button floats directly over lines in the bottom code block (`=== RUN TestSessionLifecycle...`).
- **Touch Affordances**: "Copy" button in code header is clearly tappable with a visible border.
- **Verdict**: `needs a specific minimal adjustment`
  - *Smallest concrete change*: Add a subtle right-edge fade mask or border shadow to scrollable code blocks to hint at hidden horizontal content, and offset "↓ Latest" away from code content.

---

### 3. `390x844-wide-table.png`
- **What is Visible**: A Markdown table intended to show 10 columns: Node Identifier, Pod Replica, Microservice Component, Commit Version, Cloud Region, Zone, Runtime Health, Latency (p95), Memory (RSS), Error Budget.
- **Table Rendering**: **CRITICAL FAILURE**. The table columns are squashed into 1-character-wide vertical ribbons. Text wraps character-by-character vertically:
  ```
  n  p  S  v  U  u  A  8  1  9
  o  o  e  2  S  s  c  4  3  9
  d  d  s  .  -  -  t  .  4  .
  e  -  s  1  E  e  i  1  .  9
  -  r  i  8  a  a  v  m  8  2
  e  e  o  .  s  s  e  s  M  0
  a  c  n  4  t  t  P     B  %
  s  o  L  -  (  -  r
  t  n  i  c  V  1  o
  -  c  f  8  i  b  c
  0  i  e  9  r     e
  2  l  c  2  g     s
     e  y  a  i     s
     -  c     n     i
     b  l     i     n
     2  e     a     g
        R     )
        e
        c
  ```
  Data is completely destroyed and unreadable.
- **Clipping / Overlap**: Columns run off the right side, and "↓ Latest" hovers over data cells.
- **Verdict**: `needs a specific minimal adjustment`
  - *Smallest concrete change*: Wrap table in a `<div>` with `overflow-x: auto;` and apply `white-space: nowrap; min-width: max-content;` to `table` or cells.

---

### 4. `390x844-unbroken-string.png`
- **What is Visible**: Section heading "Canonical Snapshot Checkpoint URL", explanatory text, and an unbroken 300+ character link token (`https://internal-control-plane.omp.local/...`). Auth token string below. Composer docked at bottom.
- **Text Readability & Wrapping**: Long unbroken token wraps cleanly across multiple lines within the card boundaries (`overflow-wrap: break-word` / `anywhere`). No page-level horizontal overflow.
- **Clipping / Overlap**: No horizontal blowout. "↓ Latest" button hovers over the end of the URL string.
- **Verdict**: `acceptable for daily use` (URL wrapping works as intended; shared "↓ Latest" button placement fix applies).

---

### 5. `390x844-slash-suggestions.png`
- **What is Visible**: Composer has focus and `/` entered. Autocomplete popup menu floats above the composer with items: `/model`, `/compact`, `/clear`, `/goal`. Yellow "Terminal only" badges on terminal-exclusive items.
- **Clipping / Overlap**: **HIGH SEVERITY COLLISION**. The "↓ Latest" floating button renders directly on top of the `/goal` suggestion and overlaps the `/clear` badge. Tapping `/goal` will trigger "↓ Latest" instead.
- **Touch Affordances**: Suggestion items have tall hit areas (≥44px) and clear rounded container styling.
- **Verdict**: `needs a specific minimal adjustment`
  - *Smallest concrete change*: Hide the "↓ Latest" button whenever slash suggestions are active (or elevate slash suggestions z-index and dismiss "↓ Latest").

---

### 6. `390x844-subagent-panel.png`
- **What is Visible**: Semi-transparent dark overlay over chat transcript. Centered modal dialog titled "Subagents (2)" with "×" close button. Two agent list items: `scout-codebase` with blue `RUNNING` badge, and `test-runner-worker` with grey `IDLE` badge.
- **Readability & Spacing**: Clean dark card styling, ~16px viewport margins on left/right. Generous touch areas on agent rows.
- **Clipping / Overlap**: None. Dialog fits within viewport.
- **Verdict**: `acceptable for daily use`.

---

### 7. `390x844-approval-request.png`
- **What is Visible**: Previous tool execution output in transcript. "Approval Requested" card with bright blue border and header. Host execution prompt (`rm -rf /tmp/caw-build-cache`). Action buttons: "Approve (Once)", "Approve for Session", and "Deny". Composer at bottom.
- **Buttons / Touch Affordances**: "Approve (Once)" and "Approve for Session" share row 1; "Deny" wraps to row 2. All three buttons have identical bright blue styling.
- **Hierarchy & Polish**: Giving "Deny" identical primary blue styling creates risk of mis-taps. "Deny" should be secondary/ghost or subtle danger.
- **Verdict**: `needs a specific minimal adjustment`
  - *Smallest concrete change*: Style "Deny" as a ghost/secondary button to visually separate rejection from approval actions.

---

### 8. `390x844-conversation-list.png`
- **What is Visible**: Header with `← Back` button, project title "Seeded Fixture", and folder path. Section "Conversations" with "+ New chat" button and "Seeded conversation" card with "STARTING" badge. Section "Native OMP Sessions" with 3 session cards, including "Resume in app" button and badges ("LIVE", "UNKNOWN", "TRACKED").
- **Readability & Spacing**: Excellent hierarchy. 15px font is very readable. Card borders and background contrast are sharp.
- **Touch Targets**: All buttons and cards have ≥44px height.
- **Clipping**: None.
- **Verdict**: `acceptable for daily use`.

---

### 9. `390x844-new-folder-form.png`
- **What is Visible**: "Browse Folders" modal overlay. Breadcrumb navigation, root path selectors, inline "New folder in ..." form with text input, "Create folder" button, and "Cancel" button. Folder listing below (`m-touch`, `p-alpha`, `seeded`). Bottom buttons: "Cancel" and "Use this folder".
- **Density & Touch**: Folder items have large tap targets. In the inline creation form, the input and two buttons share a single row; "Create folder" wraps to two lines inside its button (`Create \n folder`), but remains legible and functional.
- **Clipping**: None.
- **Verdict**: `acceptable for daily use`.

---

### 10. `375x812-expanded-tool-details.png`
- **What is Visible**: Expanded "Tool (Bash)" card displaying terminal command `$ vitest run tests/protocol` and 15 lines of test output. Header has "bash" title, "Code" label, and "Copy" button. Monospace test runner output shows passed test suites. Floating "↓ Latest" button. Composer docked at bottom.
- **Monospace Legibility & Truncation**: Code text is legible. Long lines truncate at the right border without overflow hints (`RUN  v2.1.8 /home/heheboiz/data/cod`, `✓ tests/protocol/codec.test.ts (14`).
- **Clipping / Overlap**: "↓ Latest" button hovers directly over test summary counts (`Tests 28 passed`, `Duration 412ms...`).
- **Card Nesting**: 3 levels of nested borders/padding consume ~64px of horizontal space, leaving ~311px for terminal output.
- **Verdict**: `needs a specific minimal adjustment`
  - *Smallest concrete change*: Add horizontal scroll fade indicator to terminal pre-block, and clear "↓ Latest" button overlay.

---

## 3. Spot-Checks (Extreme iPhone Sizes & Desktop)

| File | Viewport | Key Visual Finding | Status |
| :--- | :--- | :--- | :--- |
| `375x812-wide-table.png` | 375×812 | Catastrophic column crushing identical to 390px, but even narrower (313px width). 1-letter vertical ribbons. | **Broken** |
| `430x932-wide-table.png` | 430×932 | Proves column collapse occurs even on iPhone Pro Max (430px wide). Proves bug is CSS table layout failure, not viewport width limitation. | **Broken** |
| `1280x800-wide-table.png` | 1280×800 | On desktop, table renders with wide readable columns across screen. Confirms failure is restricted to narrow viewports. | **Pass (Desktop)** |
| `375x812-large-code-block.png` | 375×812 | Code lines truncate even earlier (`hori`, `fetc`, `Corr`). Zero overflow cue. "↓ Latest" occludes test log. | **Needs adjustment** |
| `430x932-large-code-block.png` | 430×932 | Wider line allowance, but truncation remains abrupt at right border without fade cue. | **Needs adjustment** |
| `375x812-slash-suggestions.png` | 375×812 | Header wraps onto 2 lines (`Seeded \n conversation`). "↓ Latest" collides with `/goal` and `/clear` tag. | **Needs adjustment** |
| `430x932-slash-suggestions.png` | 430×932 | "↓ Latest" still collides with `/goal` suggestion on 430px wide. | **Needs adjustment** |
| `375x812-approval-request.png` | 375×812 | Header wraps onto 2 lines. Button row breaks into row 1 ("Approve (Once)") and row 2 ("Approve for Session" + "Deny"). | **Pass (functional)** |
| `430x932-approval-request.png` | 430×932 | Ample header room. Buttons fit neatly in two rows. "Deny" still styled as blue primary. | **Pass (functional)** |
| `375x812-conversation-list.png` | 375×812 | Fully readable, no clipping, excellent card spacing, all targets ≥44px. | **Pass** |
| `430x932-conversation-list.png` | 430×932 | Spatially generous, clean status badges, flawless hierarchy. | **Pass** |
| `375x812-project-list.png` | 375×812 | "Seeded Fixture", "Rename", and "Delete" sit tightly on one line. Target sizes pass. | **Pass** |
| `430x932-project-list.png` | 430×932 | Clean, balanced layout. | **Pass** |
| `375x812-short-exchange.png` | 375×812 | Transcript fits vertically. "↓ Latest" is correctly hidden. Generous reading space. | **Pass** |
| `1280x800-long-response.png` | 1280×800 | Layout is centered max-width (~900px). "↓ Latest" sits in empty right-hand gutter (x: ~1210px), causing no text occlusion. Proves occlusion is mobile-only. | **Pass (Desktop)** |

---

## 4. Complete Inspected Files Inventory

1. `docs/assets/screens/390x844-long-response.png`
2. `docs/assets/screens/390x844-large-code-block.png`
3. `docs/assets/screens/390x844-wide-table.png`
4. `docs/assets/screens/390x844-unbroken-string.png`
5. `docs/assets/screens/390x844-slash-suggestions.png`
6. `docs/assets/screens/390x844-subagent-panel.png`
7. `docs/assets/screens/390x844-approval-request.png`
8. `docs/assets/screens/390x844-conversation-list.png`
9. `docs/assets/screens/390x844-new-folder-form.png`
10. `docs/assets/screens/375x812-expanded-tool-details.png`
11. `docs/assets/screens/375x812-wide-table.png`
12. `docs/assets/screens/430x932-wide-table.png`
13. `docs/assets/screens/1280x800-wide-table.png`
14. `docs/assets/screens/375x812-large-code-block.png`
15. `docs/assets/screens/430x932-large-code-block.png`
16. `docs/assets/screens/375x812-slash-suggestions.png`
17. `docs/assets/screens/430x932-slash-suggestions.png`
18. `docs/assets/screens/375x812-project-list.png`
19. `docs/assets/screens/430x932-project-list.png`
20. `docs/assets/screens/375x812-short-exchange.png`
21. `docs/assets/screens/375x812-approval-request.png`
22. `docs/assets/screens/430x932-approval-request.png`
23. `docs/assets/screens/375x812-conversation-list.png`
24. `docs/assets/screens/430x932-conversation-list.png`
25. `docs/assets/screens/375x812-folder-browser.png`
26. `docs/assets/screens/375x812-long-response.png`
27. `docs/assets/screens/390x844-expanded-tool-details.png`
28. `docs/assets/screens/430x932-long-response.png`
29. `docs/assets/screens/1280x800-long-response.png`

---

## 5. Re-Verification After Fixes

Recaptured screenshots at all viewports re-inspected on 2026-10-26.

### Per-Defect Verdicts

1. **Wide-Table Collapse**: **GENUINELY FIXED (CLOSED)**
   +- **Evidence**: Inspected `375x812-wide-table.png`, `390x844-wide-table.png`, `430x932-wide-table.png`. The previous vertical single-letter ribbons (`n-o-d-e---e-a-s-t---0-1`) are completely gone. Tables now render as proper tabular grids with full readable headers (`Node Identifier`, `Pod Replica`, `Microservice Component`, etc.), preserved cell whitespace, and an internal horizontal scroll container (`scrollWidth: 1472px` inside `clientWidth: 313px/328px`). Page-level horizontal overflow remains `NO`. Narrow prose and standard content in `long-response.png` are unaffected and do not inflate.

2. **"↓ Latest" Occlusion & Menu Collision**: **GENUINELY FIXED FOR BLOCKERS; NOMINAL OVERLAY ON MID-SCROLL (CLOSED FOR BLOCKERS)**
   +- **Evidence**:
     +- **Slash suggestions**: Inspected `390x844-slash-suggestions.png` and `375x812-slash-suggestions.png`. The "↓ Latest" button is completely suppressed while the autocomplete suggestions menu is open. Zero collision or occlusion with `/goal`, `/clear`, or the yellow "Terminal only" tags.
     +- **Tail reading**: Additional bottom clearance in `.messages-scroll` ensures the tail message content can scroll clear above the composer and button.
     +- **Mid-scroll note**: In `390x844-long-response.png` and `390x844-large-code-block.png`, when scrolled into the middle of the transcript, the floating pill sits over background text/logs passing beneath it. This is standard floating button behavior on mobile viewports without gutters, as long as tail reading and touch interactions are unblocked.

3. **Code-Block Edge Fade**: **GENUINELY FIXED (CLOSED)**
   +- **Evidence**: Inspected `390x844-large-code-block.png`, `375x812-expanded-tool-details.png`, and `430x932-approval-request.png`. Horizontally scrollable code blocks now feature a clean, subtle alpha fade on the rightmost ~24px. It reads naturally as a visual cue indicating hidden overflow text, rather than a clipping glitch or rendering artifact.

4. **Approval Card Button Hierarchy**: **GENUINELY FIXED (CLOSED)**
   +- **Evidence**: Inspected `390x844-approval-request.png` and `430x932-approval-request.png`. "Approve (Once)" and "Approve for Session" maintain solid primary blue fills. "Deny" is restyled as a secondary/ghost text button below them, clearly differentiating rejection from approval and preventing accidental mis-taps.

### Fresh Post-Fix Verdict
The mobile reading and interaction experience across 375×812, 390×844, and 430×932 is now **acceptable for daily use**. The fixes broke nothing: page-level horizontal stability is preserved (`Page H-Overflow: NO`), touch targets meet or exceed 44px, and modal overlays retain clean scrims and centering. With tables restored to readable horizontal containers, code blocks telegraphing horizontal overflow, the slash menu freed from button collisions, and the approval hierarchy clarified, reading long-form coding agent outputs on an iPhone in bed is now comfortable and strain-free.
