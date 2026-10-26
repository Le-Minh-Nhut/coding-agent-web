# Screenshot Inventory & Geometry Report

Generated: 2026-10-26T12:21:46.621Z
Total screenshots: 83
Viewports tested: 375x812, 390x844, 430x932, 768x1024, 1280x800

## 1. Verified Interactions (Tested at 390×844)

| Interaction | Result | Measurement | Status |
| :--- | :--- | :--- | :--- |
| (i) Scroll up in transcript, stream more content | Scroll position did not jump | Before: 150px, After: 150px | **PASS** |
| (ii) Tap "↓ Latest" button | Returned to transcript tail | Remaining distance to tail: 0px | **PASS** |
| (iii) Expand tool details | Reader scroll position preserved | Before: 0px, After: 0px | **PASS** |
| (iv) Open & close subagent panel | Chat scroll position unchanged | Before: 0px, After: 0px | **PASS** |
| (v) Focus composer | Fully inside viewport | y: 788px, height: 44px (viewport 844px) | **PASS (keyboard-unverified)** |

*Note on (v):* Mobile software keyboard cannot be simulated in headless Playwright; marked keyboard-unverified.

## 2. Layout Note: Transcript Scrolling & "Fits Vertically"

In the initial pre-fix measurement, `.messages-scroll` reported `no-scroll` (`scrollHeight === clientHeight = 3325px`) because `.conversation-screen` had `flex: 1 1 0%` inside an unconstrained `#root`, expanding the entire transcript to the content height. In that state, the transcript container was NOT scrolling internally; the entire browser window/document scrolled instead, preventing the detached condition from ever triggering. After the layout fix (`flex: 0 0 100dvh`), `.messages-scroll` is constrained to the viewport (`clientHeight: ~650px`, `scrollHeight: ~3325px`) and correctly scrolls internally (`scroll-Y`), allowing the "↓ Latest" button to render and function as designed.

## 3. Geometry Table Per Screen

| Viewport | Screen | Page H-Overflow | .messages-scroll | Body Font / Line-H | Composer Bounding Box | Model Selector Box | Latest-to-Composer Gap | Min Touch Target | Code Scroll/Client | Table Scroll/Client | Latest Btn |
| :--- | :--- | :---: | :---: | :---: | :---: | :---: | :---: | :---: | :---: | :---: | :---: | :---: |
| 375x812 | project-list | NO | N/A | 15px / 22.5px | N/A | N/A | N/A | 125×44 (`button.primary`) | N/A | N/A | Hidden |
| 375x812 | folder-browser | NO | N/A | 15px / 22.5px | N/A | N/A | N/A | 125×44 (`button.primary`) | N/A | N/A | Hidden |
| 375x812 | new-folder-form | NO | N/A | 15px / 22.5px | N/A | N/A | N/A | 125×44 (`button.primary`) | N/A | N/A | Hidden |
| 375x812 | folder-browser-paginated | NO | N/A | 15px / 22.5px | N/A | N/A | N/A | 125×44 (`button.primary`) | N/A | N/A | Hidden |
| 375x812 | conversation-list | NO | N/A | 15px / 22.5px | N/A | N/A | N/A | 106×44 (`button.primary`) | N/A | N/A | Hidden |
| 375x812 | model-settings-expanded | NO | no-scroll (375px) | 15px / 22.5px | 375×69@y=743 (in-vp) | 317×44@(29, 179) | N/A | 45×44 (`button.ghost`) | N/A | N/A | Hidden |
| 375x812 | model-selector-populated | NO | no-scroll (375px) | 15px / 22.5px | 375×69@y=743 (in-vp) | 317×44@(29, 179) | N/A | 45×44 (`button.ghost`) | N/A | N/A | Hidden |
| 375x812 | short-exchange | NO | no-scroll (375px) | 15px / 22.5px | 375×69@y=743 (in-vp) | 317×44@(29, 171) | N/A | 45×44 (`button.ghost`) | N/A | N/A | Hidden |
| 375x812 | long-response | NO | scroll-Y (375px) | 15px / 22.5px | 375×69@y=743 (in-vp) | 317×44@(29, 171) | 12px | 45×44 (`button.ghost`) | 1807 / 311 (scroll-X) | 1472 / 313 (scroll-X) | Visible |
| 375x812 | wide-table | NO | scroll-Y (375px) | 15px / 22.5px | 375×69@y=743 (in-vp) | 317×44@(29, 171) | 12px | 45×44 (`button.ghost`) | 1807 / 311 (scroll-X) | 1472 / 313 (scroll-X) | Visible |
| 375x812 | unbroken-string | NO | scroll-Y (375px) | 15px / 22.5px | 375×69@y=743 (in-vp) | 317×44@(29, 171) | 12px | 45×44 (`button.ghost`) | 1807 / 311 (scroll-X) | 1472 / 313 (scroll-X) | Visible |
| 375x812 | large-code-block | NO | scroll-Y (375px) | 15px / 22.5px | 375×69@y=743 (in-vp) | 317×44@(29, 171) | 12px | 45×44 (`button.ghost`) | 1807 / 311 (scroll-X) | 1472 / 313 (scroll-X) | Visible |
| 375x812 | expanded-tool-details | NO | scroll-Y (375px) | 15px / 22.5px | 375×69@y=743 (in-vp) | 317×44@(29, 171) | 12px | 45×44 (`button.ghost`) | 1807 / 311 (scroll-X) | 1472 / 313 (scroll-X) | Visible |
| 375x812 | subagent-panel | NO | scroll-Y (375px) | 15px / 22.5px | 375×69@y=743 (in-vp) | 317×44@(29, 171) | 12px | 45×44 (`button.ghost`) | 1807 / 311 (scroll-X) | 1472 / 313 (scroll-X) | Visible |
| 375x812 | slash-suggestions | NO | scroll-Y (375px) | 15px / 22.5px | 375×69@y=743 (in-vp) | 317×44@(29, 171) | N/A | 45×44 (`button.ghost`) | 1807 / 311 (scroll-X) | 1472 / 313 (scroll-X) | Hidden |
| 375x812 | slash-command-intercepted | NO | scroll-Y (375px) | 15px / 22.5px | 375×69@y=743 (in-vp) | 317×44@(29, 171) | N/A | 45×44 (`button.ghost`) | 1807 / 311 (scroll-X) | 1472 / 313 (scroll-X) | Hidden |
| 375x812 | approval-request | NO | scroll-Y (375px) | 15px / 22.5px | 375×69@y=743 (in-vp) | 317×44@(29, 171) | N/A | 45×44 (`button.ghost`) | 1807 / 311 (scroll-X) | 1472 / 313 (scroll-X) | Hidden |
| 375x812 | read-only-welcome | NO | no-scroll (375px) | 15px / 22.5px | 375×69@y=743 (in-vp) | 317×44@(29, 171) | N/A | 45×44 (`button.ghost`) | N/A | N/A | Hidden |
| 375x812 | read-only-conversation | NO | no-scroll (375px) | 15px / 22.5px | 375×69@y=743 (in-vp) | 317×44@(29, 171) | N/A | 45×44 (`button.ghost`) | N/A | N/A | Hidden |
| 390x844 | project-list | NO | N/A | 15px / 22.5px | N/A | N/A | N/A | 125×44 (`button.primary`) | N/A | N/A | Hidden |
| 390x844 | folder-browser | NO | N/A | 15px / 22.5px | N/A | N/A | N/A | 125×44 (`button.primary`) | N/A | N/A | Hidden |
| 390x844 | new-folder-form | NO | N/A | 15px / 22.5px | N/A | N/A | N/A | 125×44 (`button.primary`) | N/A | N/A | Hidden |
| 390x844 | folder-browser-paginated | NO | N/A | 15px / 22.5px | N/A | N/A | N/A | 125×44 (`button.primary`) | N/A | N/A | Hidden |
| 390x844 | conversation-list | NO | N/A | 15px / 22.5px | N/A | N/A | N/A | 106×44 (`button.primary`) | N/A | N/A | Hidden |
| 390x844 | model-settings-expanded | NO | no-scroll (390px) | 15px / 22.5px | 390×69@y=775 (in-vp) | 332×44@(29, 179) | N/A | 45×44 (`button.ghost`) | N/A | N/A | Hidden |
| 390x844 | model-selector-populated | NO | no-scroll (390px) | 15px / 22.5px | 390×69@y=775 (in-vp) | 332×44@(29, 179) | N/A | 45×44 (`button.ghost`) | N/A | N/A | Hidden |
| 390x844 | short-exchange | NO | no-scroll (390px) | 15px / 22.5px | 390×69@y=775 (in-vp) | 332×44@(29, 171) | N/A | 45×44 (`button.ghost`) | N/A | N/A | Hidden |
| 390x844 | long-response | NO | scroll-Y (390px) | 15px / 22.5px | 390×69@y=775 (in-vp) | 332×44@(29, 171) | 12px | 45×44 (`button.ghost`) | 1807 / 326 (scroll-X) | 1472 / 328 (scroll-X) | Visible |
| 390x844 | wide-table | NO | scroll-Y (390px) | 15px / 22.5px | 390×69@y=775 (in-vp) | 332×44@(29, 171) | 12px | 45×44 (`button.ghost`) | 1807 / 326 (scroll-X) | 1472 / 328 (scroll-X) | Visible |
| 390x844 | unbroken-string | NO | scroll-Y (390px) | 15px / 22.5px | 390×69@y=775 (in-vp) | 332×44@(29, 171) | 12px | 45×44 (`button.ghost`) | 1807 / 326 (scroll-X) | 1472 / 328 (scroll-X) | Visible |
| 390x844 | large-code-block | NO | scroll-Y (390px) | 15px / 22.5px | 390×69@y=775 (in-vp) | 332×44@(29, 171) | 12px | 45×44 (`button.ghost`) | 1807 / 326 (scroll-X) | 1472 / 328 (scroll-X) | Visible |
| 390x844 | expanded-tool-details | NO | scroll-Y (390px) | 15px / 22.5px | 390×69@y=775 (in-vp) | 332×44@(29, 171) | 12px | 45×44 (`button.ghost`) | 1807 / 326 (scroll-X) | 1472 / 328 (scroll-X) | Visible |
| 390x844 | subagent-panel | NO | scroll-Y (390px) | 15px / 22.5px | 390×69@y=775 (in-vp) | 332×44@(29, 171) | 12px | 45×44 (`button.ghost`) | 1807 / 326 (scroll-X) | 1472 / 328 (scroll-X) | Visible |
| 390x844 | slash-suggestions | NO | scroll-Y (390px) | 15px / 22.5px | 390×69@y=775 (in-vp) | 332×44@(29, 171) | N/A | 45×44 (`button.ghost`) | 1807 / 326 (scroll-X) | 1472 / 328 (scroll-X) | Hidden |
| 390x844 | slash-command-intercepted | NO | scroll-Y (390px) | 15px / 22.5px | 390×69@y=775 (in-vp) | 332×44@(29, 171) | N/A | 45×44 (`button.ghost`) | 1807 / 326 (scroll-X) | 1472 / 328 (scroll-X) | Hidden |
| 390x844 | approval-request | NO | scroll-Y (390px) | 15px / 22.5px | 390×69@y=775 (in-vp) | 332×44@(29, 171) | N/A | 45×44 (`button.ghost`) | 1807 / 326 (scroll-X) | 1472 / 328 (scroll-X) | Hidden |
| 390x844 | read-only-welcome | NO | no-scroll (390px) | 15px / 22.5px | 390×69@y=775 (in-vp) | 332×44@(29, 171) | N/A | 45×44 (`button.ghost`) | N/A | N/A | Hidden |
| 390x844 | read-only-conversation | NO | no-scroll (390px) | 15px / 22.5px | 390×69@y=775 (in-vp) | 332×44@(29, 171) | N/A | 45×44 (`button.ghost`) | N/A | N/A | Hidden |
| 430x932 | project-list | NO | N/A | 15px / 22.5px | N/A | N/A | N/A | 125×44 (`button.primary`) | N/A | N/A | Hidden |
| 430x932 | folder-browser | NO | N/A | 15px / 22.5px | N/A | N/A | N/A | 125×44 (`button.primary`) | N/A | N/A | Hidden |
| 430x932 | new-folder-form | NO | N/A | 15px / 22.5px | N/A | N/A | N/A | 125×44 (`button.primary`) | N/A | N/A | Hidden |
| 430x932 | folder-browser-paginated | NO | N/A | 15px / 22.5px | N/A | N/A | N/A | 125×44 (`button.primary`) | N/A | N/A | Hidden |
| 430x932 | conversation-list | NO | N/A | 15px / 22.5px | N/A | N/A | N/A | 106×44 (`button.primary`) | N/A | N/A | Hidden |
| 430x932 | model-settings-expanded | NO | no-scroll (430px) | 15px / 22.5px | 430×69@y=863 (in-vp) | 372×44@(29, 179) | N/A | 45×44 (`button.ghost`) | N/A | N/A | Hidden |
| 430x932 | model-selector-populated | NO | no-scroll (430px) | 15px / 22.5px | 430×69@y=863 (in-vp) | 372×44@(29, 179) | N/A | 45×44 (`button.ghost`) | N/A | N/A | Hidden |
| 430x932 | short-exchange | NO | no-scroll (430px) | 15px / 22.5px | 430×69@y=863 (in-vp) | 372×44@(29, 171) | N/A | 45×44 (`button.ghost`) | N/A | N/A | Hidden |
| 430x932 | long-response | NO | scroll-Y (430px) | 15px / 22.5px | 430×69@y=863 (in-vp) | 372×44@(29, 171) | 12px | 45×44 (`button.ghost`) | 1807 / 366 (scroll-X) | 1472 / 368 (scroll-X) | Visible |
| 430x932 | wide-table | NO | scroll-Y (430px) | 15px / 22.5px | 430×69@y=863 (in-vp) | 372×44@(29, 171) | 12px | 45×44 (`button.ghost`) | 1807 / 366 (scroll-X) | 1472 / 368 (scroll-X) | Visible |
| 430x932 | unbroken-string | NO | scroll-Y (430px) | 15px / 22.5px | 430×69@y=863 (in-vp) | 372×44@(29, 171) | 12px | 45×44 (`button.ghost`) | 1807 / 366 (scroll-X) | 1472 / 368 (scroll-X) | Visible |
| 430x932 | large-code-block | NO | scroll-Y (430px) | 15px / 22.5px | 430×69@y=863 (in-vp) | 372×44@(29, 171) | 12px | 45×44 (`button.ghost`) | 1807 / 366 (scroll-X) | 1472 / 368 (scroll-X) | Visible |
| 430x932 | expanded-tool-details | NO | scroll-Y (430px) | 15px / 22.5px | 430×69@y=863 (in-vp) | 372×44@(29, 171) | 12px | 45×44 (`button.ghost`) | 1807 / 366 (scroll-X) | 1472 / 368 (scroll-X) | Visible |
| 430x932 | subagent-panel | NO | scroll-Y (430px) | 15px / 22.5px | 430×69@y=863 (in-vp) | 372×44@(29, 171) | 12px | 45×44 (`button.ghost`) | 1807 / 366 (scroll-X) | 1472 / 368 (scroll-X) | Visible |
| 430x932 | slash-suggestions | NO | scroll-Y (430px) | 15px / 22.5px | 430×69@y=863 (in-vp) | 372×44@(29, 171) | N/A | 45×44 (`button.ghost`) | 1807 / 366 (scroll-X) | 1472 / 368 (scroll-X) | Hidden |
| 430x932 | slash-command-intercepted | NO | scroll-Y (430px) | 15px / 22.5px | 430×69@y=863 (in-vp) | 372×44@(29, 171) | N/A | 45×44 (`button.ghost`) | 1807 / 366 (scroll-X) | 1472 / 368 (scroll-X) | Hidden |
| 430x932 | approval-request | NO | scroll-Y (430px) | 15px / 22.5px | 430×69@y=863 (in-vp) | 372×44@(29, 171) | N/A | 45×44 (`button.ghost`) | 1807 / 366 (scroll-X) | 1472 / 368 (scroll-X) | Hidden |
| 430x932 | read-only-welcome | NO | no-scroll (430px) | 15px / 22.5px | 430×69@y=863 (in-vp) | 372×44@(29, 171) | N/A | 45×44 (`button.ghost`) | N/A | N/A | Hidden |
| 430x932 | read-only-conversation | NO | no-scroll (430px) | 15px / 22.5px | 430×69@y=863 (in-vp) | 372×44@(29, 171) | N/A | 45×44 (`button.ghost`) | N/A | N/A | Hidden |
| 768x1024 | project-list | NO | N/A | 15px / 22.5px | N/A | N/A | N/A | 125×44 (`button.primary`) | N/A | N/A | Hidden |
| 768x1024 | folder-browser | NO | N/A | 15px / 22.5px | N/A | N/A | N/A | 125×44 (`button.primary`) | N/A | N/A | Hidden |
| 768x1024 | new-folder-form | NO | N/A | 15px / 22.5px | N/A | N/A | N/A | 125×44 (`button.primary`) | N/A | N/A | Hidden |
| 768x1024 | conversation-list | NO | N/A | 15px / 22.5px | N/A | N/A | N/A | 82×44 (`button.ghost`) | N/A | N/A | Hidden |
| 768x1024 | short-exchange | NO | no-scroll (768px) | 15px / 22.5px | 768×69@y=955 (in-vp) | 710×44@(29, 171) | N/A | 45×44 (`button.ghost`) | N/A | N/A | Hidden |
| 768x1024 | long-response | NO | scroll-Y (768px) | 15px / 22.5px | 768×69@y=955 (in-vp) | 710×44@(29, 171) | 12px | 45×44 (`button.ghost`) | 1807 / 704 (scroll-X) | 1472 / 706 (scroll-X) | Visible |
| 768x1024 | wide-table | NO | scroll-Y (768px) | 15px / 22.5px | 768×69@y=955 (in-vp) | 710×44@(29, 171) | 12px | 45×44 (`button.ghost`) | 1807 / 704 (scroll-X) | 1472 / 706 (scroll-X) | Visible |
| 768x1024 | unbroken-string | NO | scroll-Y (768px) | 15px / 22.5px | 768×69@y=955 (in-vp) | 710×44@(29, 171) | 12px | 45×44 (`button.ghost`) | 1807 / 704 (scroll-X) | 1472 / 706 (scroll-X) | Visible |
| 768x1024 | large-code-block | NO | scroll-Y (768px) | 15px / 22.5px | 768×69@y=955 (in-vp) | 710×44@(29, 171) | 12px | 45×44 (`button.ghost`) | 1807 / 704 (scroll-X) | 1472 / 706 (scroll-X) | Visible |
| 768x1024 | expanded-tool-details | NO | scroll-Y (768px) | 15px / 22.5px | 768×69@y=955 (in-vp) | 710×44@(29, 171) | 12px | 45×44 (`button.ghost`) | 1807 / 704 (scroll-X) | 1472 / 706 (scroll-X) | Visible |
| 768x1024 | subagent-panel | NO | scroll-Y (768px) | 15px / 22.5px | 768×69@y=955 (in-vp) | 710×44@(29, 171) | 12px | 45×44 (`button.ghost`) | 1807 / 704 (scroll-X) | 1472 / 706 (scroll-X) | Visible |
| 768x1024 | slash-suggestions | NO | scroll-Y (768px) | 15px / 22.5px | 768×69@y=955 (in-vp) | 710×44@(29, 171) | N/A | 45×44 (`button.ghost`) | 1807 / 704 (scroll-X) | 1472 / 706 (scroll-X) | Hidden |
| 768x1024 | approval-request | NO | scroll-Y (768px) | 15px / 22.5px | 768×69@y=955 (in-vp) | 710×44@(29, 171) | N/A | 45×44 (`button.ghost`) | 1807 / 704 (scroll-X) | 1472 / 706 (scroll-X) | Hidden |
| 1280x800 | project-list | NO | N/A | 15px / 22.5px | N/A | N/A | N/A | 125×44 (`button.primary`) | N/A | N/A | Hidden |
| 1280x800 | folder-browser | NO | N/A | 15px / 22.5px | N/A | N/A | N/A | 125×44 (`button.primary`) | N/A | N/A | Hidden |
| 1280x800 | new-folder-form | NO | N/A | 15px / 22.5px | N/A | N/A | N/A | 125×44 (`button.primary`) | N/A | N/A | Hidden |
| 1280x800 | conversation-list | NO | N/A | 15px / 22.5px | N/A | N/A | N/A | 82×44 (`button.ghost`) | N/A | N/A | Hidden |
| 1280x800 | short-exchange | NO | no-scroll (900px) | 15px / 22.5px | 900×69@y=731 (in-vp) | 842×44@(219, 171) | N/A | 45×44 (`button.ghost`) | N/A | N/A | Hidden |
| 1280x800 | long-response | NO | scroll-Y (900px) | 15px / 22.5px | 900×69@y=731 (in-vp) | 842×44@(219, 171) | 12px | 45×44 (`button.ghost`) | 1807 / 836 (scroll-X) | 1472 / 838 (scroll-X) | Visible |
| 1280x800 | wide-table | NO | scroll-Y (900px) | 15px / 22.5px | 900×69@y=731 (in-vp) | 842×44@(219, 171) | 12px | 45×44 (`button.ghost`) | 1807 / 836 (scroll-X) | 1472 / 838 (scroll-X) | Visible |
| 1280x800 | unbroken-string | NO | scroll-Y (900px) | 15px / 22.5px | 900×69@y=731 (in-vp) | 842×44@(219, 171) | 12px | 45×44 (`button.ghost`) | 1807 / 836 (scroll-X) | 1472 / 838 (scroll-X) | Visible |
| 1280x800 | large-code-block | NO | scroll-Y (900px) | 15px / 22.5px | 900×69@y=731 (in-vp) | 842×44@(219, 171) | 12px | 45×44 (`button.ghost`) | 1807 / 836 (scroll-X) | 1472 / 838 (scroll-X) | Visible |
| 1280x800 | expanded-tool-details | NO | scroll-Y (900px) | 15px / 22.5px | 900×69@y=731 (in-vp) | 842×44@(219, 171) | 12px | 45×44 (`button.ghost`) | 1807 / 836 (scroll-X) | 1472 / 838 (scroll-X) | Visible |
| 1280x800 | subagent-panel | NO | scroll-Y (900px) | 15px / 22.5px | 900×69@y=731 (in-vp) | 842×44@(219, 171) | 12px | 45×44 (`button.ghost`) | 1807 / 836 (scroll-X) | 1472 / 838 (scroll-X) | Visible |
| 1280x800 | slash-suggestions | NO | scroll-Y (900px) | 15px / 22.5px | 900×69@y=731 (in-vp) | 842×44@(219, 171) | N/A | 45×44 (`button.ghost`) | 1807 / 836 (scroll-X) | 1472 / 838 (scroll-X) | Hidden |
| 1280x800 | approval-request | NO | scroll-Y (900px) | 15px / 22.5px | 900×69@y=731 (in-vp) | 842×44@(219, 171) | N/A | 45×44 (`button.ghost`) | 1807 / 836 (scroll-X) | 1472 / 838 (scroll-X) | Hidden |

## 3. Detailed Screenshot Inventory

### `375x812-project-list.png`

- **Viewport**: 375x812
- **Screen**: project-list
- **Page-level Horizontal Overflow**: None (fits window)
- **Transcript Container (.messages-scroll)**: Not present
- **Body Text Typography**: font-size: 15px, line-height: 22.5px
- **Minimum Touch Target**: 125px × 44px on `button.primary` ("+ New Project")

### `375x812-folder-browser.png`

- **Viewport**: 375x812
- **Screen**: folder-browser
- **Page-level Horizontal Overflow**: None (fits window)
- **Transcript Container (.messages-scroll)**: Not present
- **Body Text Typography**: font-size: 15px, line-height: 22.5px
- **Minimum Touch Target**: 125px × 44px on `button.primary` ("+ New Project")

### `375x812-new-folder-form.png`

- **Viewport**: 375x812
- **Screen**: new-folder-form
- **Page-level Horizontal Overflow**: None (fits window)
- **Transcript Container (.messages-scroll)**: Not present
- **Body Text Typography**: font-size: 15px, line-height: 22.5px
- **Minimum Touch Target**: 125px × 44px on `button.primary` ("+ New Project")

### `375x812-folder-browser-paginated.png`

- **Viewport**: 375x812
- **Screen**: folder-browser-paginated
- **Page-level Horizontal Overflow**: None (fits window)
- **Transcript Container (.messages-scroll)**: Not present
- **Body Text Typography**: font-size: 15px, line-height: 22.5px
- **Minimum Touch Target**: 125px × 44px on `button.primary` ("+ New Project")

### `375x812-conversation-list.png`

- **Viewport**: 375x812
- **Screen**: conversation-list
- **Page-level Horizontal Overflow**: None (fits window)
- **Transcript Container (.messages-scroll)**: Not present
- **Body Text Typography**: font-size: 15px, line-height: 22.5px
- **Minimum Touch Target**: 106px × 44px on `button.primary` ("+ New chat")

### `375x812-model-settings-expanded.png`

- **Viewport**: 375x812
- **Screen**: model-settings-expanded
- **Page-level Horizontal Overflow**: None (fits window)
- **Transcript Container (.messages-scroll)**: Fits vertically
- **Body Text Typography**: font-size: 15px, line-height: 22.5px
- **Composer Bounding Box**: 375px × 69px at (x: 0, y: 743), fully inside viewport: YES, bottom padding: 12px
- **Model selector box**: 317px × 44px at (29, 179)
- **Transcript box**: 343px × 119px at (16, 562); Latest intersection: null
- **Minimum Touch Target**: 45px × 44px on `button.ghost` ("←")

### `375x812-model-selector-populated.png`

- **Viewport**: 375x812
- **Screen**: model-selector-populated
- **Page-level Horizontal Overflow**: None (fits window)
- **Transcript Container (.messages-scroll)**: Fits vertically
- **Body Text Typography**: font-size: 15px, line-height: 22.5px
- **Composer Bounding Box**: 375px × 69px at (x: 0, y: 743), fully inside viewport: YES, bottom padding: 12px
- **Model selector box**: 317px × 44px at (29, 179)
- **Transcript box**: 343px × 119px at (16, 562); Latest intersection: null
- **Minimum Touch Target**: 45px × 44px on `button.ghost` ("←")

### `375x812-short-exchange.png`

- **Viewport**: 375x812
- **Screen**: short-exchange
- **Page-level Horizontal Overflow**: None (fits window)
- **Transcript Container (.messages-scroll)**: Fits vertically
- **Body Text Typography**: font-size: 15px, line-height: 22.5px
- **Composer Bounding Box**: 375px × 69px at (x: 0, y: 743), fully inside viewport: YES, bottom padding: 12px
- **Model selector box**: 317px × 44px at (29, 171)
- **Transcript box**: 343px × 188px at (16, 251); Latest intersection: null
- **Minimum Touch Target**: 45px × 44px on `button.ghost` ("←")

### `375x812-long-response.png`

- **Viewport**: 375x812
- **Screen**: long-response
- **Page-level Horizontal Overflow**: None (fits window)
- **Transcript Container (.messages-scroll)**: Overflows vertically (scrollable)
- **Body Text Typography**: font-size: 15px, line-height: 22.5px
- **Composer Bounding Box**: 375px × 69px at (x: 0, y: 743), fully inside viewport: YES, bottom padding: 12px
- **Latest button box**: 74px × 44px at (285, 688)
- **Latest-to-composer gap**: 12px
- **Model selector box**: 317px × 44px at (29, 171)
- **Transcript box**: 343px × 432px at (16, 251); Latest intersection: false
- **Code Block Scroll Geometry**: scrollWidth: 1807px, clientWidth: 311px (horizontal scroll: YES)
- **Table Scroll Geometry**: scrollWidth: 1472px, clientWidth: 313px (horizontal scroll: YES)
- **Minimum Touch Target**: 45px × 44px on `button.ghost` ("←")

### `375x812-wide-table.png`

- **Viewport**: 375x812
- **Screen**: wide-table
- **Page-level Horizontal Overflow**: None (fits window)
- **Transcript Container (.messages-scroll)**: Overflows vertically (scrollable)
- **Body Text Typography**: font-size: 15px, line-height: 22.5px
- **Composer Bounding Box**: 375px × 69px at (x: 0, y: 743), fully inside viewport: YES, bottom padding: 12px
- **Latest button box**: 74px × 44px at (285, 688)
- **Latest-to-composer gap**: 12px
- **Model selector box**: 317px × 44px at (29, 171)
- **Transcript box**: 343px × 448px at (16, 235); Latest intersection: false
- **Code Block Scroll Geometry**: scrollWidth: 1807px, clientWidth: 311px (horizontal scroll: YES)
- **Table Scroll Geometry**: scrollWidth: 1472px, clientWidth: 313px (horizontal scroll: YES)
- **Minimum Touch Target**: 45px × 44px on `button.ghost` ("←")

### `375x812-unbroken-string.png`

- **Viewport**: 375x812
- **Screen**: unbroken-string
- **Page-level Horizontal Overflow**: None (fits window)
- **Transcript Container (.messages-scroll)**: Overflows vertically (scrollable)
- **Body Text Typography**: font-size: 15px, line-height: 22.5px
- **Composer Bounding Box**: 375px × 69px at (x: 0, y: 743), fully inside viewport: YES, bottom padding: 12px
- **Latest button box**: 74px × 44px at (285, 688)
- **Latest-to-composer gap**: 12px
- **Model selector box**: 317px × 44px at (29, 171)
- **Transcript box**: 343px × 448px at (16, 235); Latest intersection: false
- **Code Block Scroll Geometry**: scrollWidth: 1807px, clientWidth: 311px (horizontal scroll: YES)
- **Table Scroll Geometry**: scrollWidth: 1472px, clientWidth: 313px (horizontal scroll: YES)
- **Minimum Touch Target**: 45px × 44px on `button.ghost` ("←")

### `375x812-large-code-block.png`

- **Viewport**: 375x812
- **Screen**: large-code-block
- **Page-level Horizontal Overflow**: None (fits window)
- **Transcript Container (.messages-scroll)**: Overflows vertically (scrollable)
- **Body Text Typography**: font-size: 15px, line-height: 22.5px
- **Composer Bounding Box**: 375px × 69px at (x: 0, y: 743), fully inside viewport: YES, bottom padding: 12px
- **Latest button box**: 74px × 44px at (285, 688)
- **Latest-to-composer gap**: 12px
- **Model selector box**: 317px × 44px at (29, 171)
- **Transcript box**: 343px × 448px at (16, 235); Latest intersection: false
- **Code Block Scroll Geometry**: scrollWidth: 1807px, clientWidth: 311px (horizontal scroll: YES)
- **Table Scroll Geometry**: scrollWidth: 1472px, clientWidth: 313px (horizontal scroll: YES)
- **Minimum Touch Target**: 45px × 44px on `button.ghost` ("←")

### `375x812-expanded-tool-details.png`

- **Viewport**: 375x812
- **Screen**: expanded-tool-details
- **Page-level Horizontal Overflow**: None (fits window)
- **Transcript Container (.messages-scroll)**: Overflows vertically (scrollable)
- **Body Text Typography**: font-size: 15px, line-height: 22.5px
- **Composer Bounding Box**: 375px × 69px at (x: 0, y: 743), fully inside viewport: YES, bottom padding: 12px
- **Latest button box**: 74px × 44px at (285, 688)
- **Latest-to-composer gap**: 12px
- **Model selector box**: 317px × 44px at (29, 171)
- **Transcript box**: 343px × 448px at (16, 235); Latest intersection: false
- **Code Block Scroll Geometry**: scrollWidth: 1807px, clientWidth: 311px (horizontal scroll: YES)
- **Table Scroll Geometry**: scrollWidth: 1472px, clientWidth: 313px (horizontal scroll: YES)
- **Minimum Touch Target**: 45px × 44px on `button.ghost` ("←")

### `375x812-subagent-panel.png`

- **Viewport**: 375x812
- **Screen**: subagent-panel
- **Page-level Horizontal Overflow**: None (fits window)
- **Transcript Container (.messages-scroll)**: Overflows vertically (scrollable)
- **Body Text Typography**: font-size: 15px, line-height: 22.5px
- **Composer Bounding Box**: 375px × 69px at (x: 0, y: 743), fully inside viewport: YES, bottom padding: 12px
- **Latest button box**: 74px × 44px at (285, 688)
- **Latest-to-composer gap**: 12px
- **Model selector box**: 317px × 44px at (29, 171)
- **Transcript box**: 343px × 448px at (16, 235); Latest intersection: false
- **Code Block Scroll Geometry**: scrollWidth: 1807px, clientWidth: 311px (horizontal scroll: YES)
- **Table Scroll Geometry**: scrollWidth: 1472px, clientWidth: 313px (horizontal scroll: YES)
- **Minimum Touch Target**: 45px × 44px on `button.ghost` ("←")

### `375x812-slash-suggestions.png`

- **Viewport**: 375x812
- **Screen**: slash-suggestions
- **Page-level Horizontal Overflow**: None (fits window)
- **Transcript Container (.messages-scroll)**: Overflows vertically (scrollable)
- **Body Text Typography**: font-size: 15px, line-height: 22.5px
- **Composer Bounding Box**: 375px × 69px at (x: 0, y: 743), fully inside viewport: YES, bottom padding: 12px
- **Model selector box**: 317px × 44px at (29, 171)
- **Transcript box**: 343px × 288px at (16, 235); Latest intersection: null
- **Code Block Scroll Geometry**: scrollWidth: 1807px, clientWidth: 311px (horizontal scroll: YES)
- **Table Scroll Geometry**: scrollWidth: 1472px, clientWidth: 313px (horizontal scroll: YES)
- **Minimum Touch Target**: 45px × 44px on `button.ghost` ("←")

### `375x812-slash-command-intercepted.png`

- **Viewport**: 375x812
- **Screen**: slash-command-intercepted
- **Page-level Horizontal Overflow**: None (fits window)
- **Transcript Container (.messages-scroll)**: Overflows vertically (scrollable)
- **Body Text Typography**: font-size: 15px, line-height: 22.5px
- **Composer Bounding Box**: 375px × 69px at (x: 0, y: 743), fully inside viewport: YES, bottom padding: 12px
- **Model selector box**: 317px × 44px at (29, 171)
- **Transcript box**: 343px × 288px at (16, 235); Latest intersection: null
- **Code Block Scroll Geometry**: scrollWidth: 1807px, clientWidth: 311px (horizontal scroll: YES)
- **Table Scroll Geometry**: scrollWidth: 1472px, clientWidth: 313px (horizontal scroll: YES)
- **Minimum Touch Target**: 45px × 44px on `button.ghost` ("←")

### `375x812-approval-request.png`

- **Viewport**: 375x812
- **Screen**: approval-request
- **Page-level Horizontal Overflow**: None (fits window)
- **Transcript Container (.messages-scroll)**: Overflows vertically (scrollable)
- **Body Text Typography**: font-size: 15px, line-height: 22.5px
- **Composer Bounding Box**: 375px × 69px at (x: 0, y: 743), fully inside viewport: YES, bottom padding: 12px
- **Model selector box**: 317px × 44px at (29, 171)
- **Transcript box**: 343px × 492px at (16, 235); Latest intersection: null
- **Code Block Scroll Geometry**: scrollWidth: 1807px, clientWidth: 311px (horizontal scroll: YES)
- **Table Scroll Geometry**: scrollWidth: 1472px, clientWidth: 313px (horizontal scroll: YES)
- **Minimum Touch Target**: 45px × 44px on `button.ghost` ("←")

### `375x812-read-only-welcome.png`

- **Viewport**: 375x812
- **Screen**: read-only-welcome
- **Page-level Horizontal Overflow**: None (fits window)
- **Transcript Container (.messages-scroll)**: Fits vertically
- **Body Text Typography**: font-size: 15px, line-height: 22.5px
- **Composer Bounding Box**: 375px × 69px at (x: 0, y: 743), fully inside viewport: YES, bottom padding: 12px
- **Model selector box**: 317px × 44px at (29, 171)
- **Transcript box**: 343px × 91px at (16, 315); Latest intersection: null
- **Minimum Touch Target**: 45px × 44px on `button.ghost` ("←")

### `375x812-read-only-conversation.png`

- **Viewport**: 375x812
- **Screen**: read-only-conversation
- **Page-level Horizontal Overflow**: None (fits window)
- **Transcript Container (.messages-scroll)**: Fits vertically
- **Body Text Typography**: font-size: 15px, line-height: 22.5px
- **Composer Bounding Box**: 375px × 69px at (x: 0, y: 743), fully inside viewport: YES, bottom padding: 12px
- **Model selector box**: 317px × 44px at (29, 171)
- **Transcript box**: 343px × 286px at (16, 315); Latest intersection: null
- **Minimum Touch Target**: 45px × 44px on `button.ghost` ("←")

### `390x844-project-list.png`

- **Viewport**: 390x844
- **Screen**: project-list
- **Page-level Horizontal Overflow**: None (fits window)
- **Transcript Container (.messages-scroll)**: Not present
- **Body Text Typography**: font-size: 15px, line-height: 22.5px
- **Minimum Touch Target**: 125px × 44px on `button.primary` ("+ New Project")

### `390x844-folder-browser.png`

- **Viewport**: 390x844
- **Screen**: folder-browser
- **Page-level Horizontal Overflow**: None (fits window)
- **Transcript Container (.messages-scroll)**: Not present
- **Body Text Typography**: font-size: 15px, line-height: 22.5px
- **Minimum Touch Target**: 125px × 44px on `button.primary` ("+ New Project")

### `390x844-new-folder-form.png`

- **Viewport**: 390x844
- **Screen**: new-folder-form
- **Page-level Horizontal Overflow**: None (fits window)
- **Transcript Container (.messages-scroll)**: Not present
- **Body Text Typography**: font-size: 15px, line-height: 22.5px
- **Minimum Touch Target**: 125px × 44px on `button.primary` ("+ New Project")

### `390x844-folder-browser-paginated.png`

- **Viewport**: 390x844
- **Screen**: folder-browser-paginated
- **Page-level Horizontal Overflow**: None (fits window)
- **Transcript Container (.messages-scroll)**: Not present
- **Body Text Typography**: font-size: 15px, line-height: 22.5px
- **Minimum Touch Target**: 125px × 44px on `button.primary` ("+ New Project")

### `390x844-conversation-list.png`

- **Viewport**: 390x844
- **Screen**: conversation-list
- **Page-level Horizontal Overflow**: None (fits window)
- **Transcript Container (.messages-scroll)**: Not present
- **Body Text Typography**: font-size: 15px, line-height: 22.5px
- **Minimum Touch Target**: 106px × 44px on `button.primary` ("+ New chat")

### `390x844-model-settings-expanded.png`

- **Viewport**: 390x844
- **Screen**: model-settings-expanded
- **Page-level Horizontal Overflow**: None (fits window)
- **Transcript Container (.messages-scroll)**: Fits vertically
- **Body Text Typography**: font-size: 15px, line-height: 22.5px
- **Composer Bounding Box**: 390px × 69px at (x: 0, y: 775), fully inside viewport: YES, bottom padding: 12px
- **Model selector box**: 332px × 44px at (29, 179)
- **Transcript box**: 358px × 97px at (16, 562); Latest intersection: null
- **Minimum Touch Target**: 45px × 44px on `button.ghost` ("←")

### `390x844-model-selector-populated.png`

- **Viewport**: 390x844
- **Screen**: model-selector-populated
- **Page-level Horizontal Overflow**: None (fits window)
- **Transcript Container (.messages-scroll)**: Fits vertically
- **Body Text Typography**: font-size: 15px, line-height: 22.5px
- **Composer Bounding Box**: 390px × 69px at (x: 0, y: 775), fully inside viewport: YES, bottom padding: 12px
- **Model selector box**: 332px × 44px at (29, 179)
- **Transcript box**: 358px × 97px at (16, 562); Latest intersection: null
- **Minimum Touch Target**: 45px × 44px on `button.ghost` ("←")

### `390x844-short-exchange.png`

- **Viewport**: 390x844
- **Screen**: short-exchange
- **Page-level Horizontal Overflow**: None (fits window)
- **Transcript Container (.messages-scroll)**: Fits vertically
- **Body Text Typography**: font-size: 15px, line-height: 22.5px
- **Composer Bounding Box**: 390px × 69px at (x: 0, y: 775), fully inside viewport: YES, bottom padding: 12px
- **Model selector box**: 332px × 44px at (29, 171)
- **Transcript box**: 358px × 188px at (16, 251); Latest intersection: null
- **Minimum Touch Target**: 45px × 44px on `button.ghost` ("←")

### `390x844-long-response.png`

- **Viewport**: 390x844
- **Screen**: long-response
- **Page-level Horizontal Overflow**: None (fits window)
- **Transcript Container (.messages-scroll)**: Overflows vertically (scrollable)
- **Body Text Typography**: font-size: 15px, line-height: 22.5px
- **Composer Bounding Box**: 390px × 69px at (x: 0, y: 775), fully inside viewport: YES, bottom padding: 12px
- **Latest button box**: 74px × 44px at (300, 720)
- **Latest-to-composer gap**: 12px
- **Model selector box**: 332px × 44px at (29, 171)
- **Transcript box**: 358px × 464px at (16, 251); Latest intersection: false
- **Code Block Scroll Geometry**: scrollWidth: 1807px, clientWidth: 326px (horizontal scroll: YES)
- **Table Scroll Geometry**: scrollWidth: 1472px, clientWidth: 328px (horizontal scroll: YES)
- **Minimum Touch Target**: 45px × 44px on `button.ghost` ("←")

### `390x844-wide-table.png`

- **Viewport**: 390x844
- **Screen**: wide-table
- **Page-level Horizontal Overflow**: None (fits window)
- **Transcript Container (.messages-scroll)**: Overflows vertically (scrollable)
- **Body Text Typography**: font-size: 15px, line-height: 22.5px
- **Composer Bounding Box**: 390px × 69px at (x: 0, y: 775), fully inside viewport: YES, bottom padding: 12px
- **Latest button box**: 74px × 44px at (300, 720)
- **Latest-to-composer gap**: 12px
- **Model selector box**: 332px × 44px at (29, 171)
- **Transcript box**: 358px × 480px at (16, 235); Latest intersection: false
- **Code Block Scroll Geometry**: scrollWidth: 1807px, clientWidth: 326px (horizontal scroll: YES)
- **Table Scroll Geometry**: scrollWidth: 1472px, clientWidth: 328px (horizontal scroll: YES)
- **Minimum Touch Target**: 45px × 44px on `button.ghost` ("←")

### `390x844-unbroken-string.png`

- **Viewport**: 390x844
- **Screen**: unbroken-string
- **Page-level Horizontal Overflow**: None (fits window)
- **Transcript Container (.messages-scroll)**: Overflows vertically (scrollable)
- **Body Text Typography**: font-size: 15px, line-height: 22.5px
- **Composer Bounding Box**: 390px × 69px at (x: 0, y: 775), fully inside viewport: YES, bottom padding: 12px
- **Latest button box**: 74px × 44px at (300, 720)
- **Latest-to-composer gap**: 12px
- **Model selector box**: 332px × 44px at (29, 171)
- **Transcript box**: 358px × 480px at (16, 235); Latest intersection: false
- **Code Block Scroll Geometry**: scrollWidth: 1807px, clientWidth: 326px (horizontal scroll: YES)
- **Table Scroll Geometry**: scrollWidth: 1472px, clientWidth: 328px (horizontal scroll: YES)
- **Minimum Touch Target**: 45px × 44px on `button.ghost` ("←")

### `390x844-large-code-block.png`

- **Viewport**: 390x844
- **Screen**: large-code-block
- **Page-level Horizontal Overflow**: None (fits window)
- **Transcript Container (.messages-scroll)**: Overflows vertically (scrollable)
- **Body Text Typography**: font-size: 15px, line-height: 22.5px
- **Composer Bounding Box**: 390px × 69px at (x: 0, y: 775), fully inside viewport: YES, bottom padding: 12px
- **Latest button box**: 74px × 44px at (300, 720)
- **Latest-to-composer gap**: 12px
- **Model selector box**: 332px × 44px at (29, 171)
- **Transcript box**: 358px × 480px at (16, 235); Latest intersection: false
- **Code Block Scroll Geometry**: scrollWidth: 1807px, clientWidth: 326px (horizontal scroll: YES)
- **Table Scroll Geometry**: scrollWidth: 1472px, clientWidth: 328px (horizontal scroll: YES)
- **Minimum Touch Target**: 45px × 44px on `button.ghost` ("←")

### `390x844-expanded-tool-details.png`

- **Viewport**: 390x844
- **Screen**: expanded-tool-details
- **Page-level Horizontal Overflow**: None (fits window)
- **Transcript Container (.messages-scroll)**: Overflows vertically (scrollable)
- **Body Text Typography**: font-size: 15px, line-height: 22.5px
- **Composer Bounding Box**: 390px × 69px at (x: 0, y: 775), fully inside viewport: YES, bottom padding: 12px
- **Latest button box**: 74px × 44px at (300, 720)
- **Latest-to-composer gap**: 12px
- **Model selector box**: 332px × 44px at (29, 171)
- **Transcript box**: 358px × 480px at (16, 235); Latest intersection: false
- **Code Block Scroll Geometry**: scrollWidth: 1807px, clientWidth: 326px (horizontal scroll: YES)
- **Table Scroll Geometry**: scrollWidth: 1472px, clientWidth: 328px (horizontal scroll: YES)
- **Minimum Touch Target**: 45px × 44px on `button.ghost` ("←")

### `390x844-subagent-panel.png`

- **Viewport**: 390x844
- **Screen**: subagent-panel
- **Page-level Horizontal Overflow**: None (fits window)
- **Transcript Container (.messages-scroll)**: Overflows vertically (scrollable)
- **Body Text Typography**: font-size: 15px, line-height: 22.5px
- **Composer Bounding Box**: 390px × 69px at (x: 0, y: 775), fully inside viewport: YES, bottom padding: 12px
- **Latest button box**: 74px × 44px at (300, 720)
- **Latest-to-composer gap**: 12px
- **Model selector box**: 332px × 44px at (29, 171)
- **Transcript box**: 358px × 480px at (16, 235); Latest intersection: false
- **Code Block Scroll Geometry**: scrollWidth: 1807px, clientWidth: 326px (horizontal scroll: YES)
- **Table Scroll Geometry**: scrollWidth: 1472px, clientWidth: 328px (horizontal scroll: YES)
- **Minimum Touch Target**: 45px × 44px on `button.ghost` ("←")

### `390x844-slash-suggestions.png`

- **Viewport**: 390x844
- **Screen**: slash-suggestions
- **Page-level Horizontal Overflow**: None (fits window)
- **Transcript Container (.messages-scroll)**: Overflows vertically (scrollable)
- **Body Text Typography**: font-size: 15px, line-height: 22.5px
- **Composer Bounding Box**: 390px × 69px at (x: 0, y: 775), fully inside viewport: YES, bottom padding: 12px
- **Model selector box**: 332px × 44px at (29, 171)
- **Transcript box**: 358px × 320px at (16, 235); Latest intersection: null
- **Code Block Scroll Geometry**: scrollWidth: 1807px, clientWidth: 326px (horizontal scroll: YES)
- **Table Scroll Geometry**: scrollWidth: 1472px, clientWidth: 328px (horizontal scroll: YES)
- **Minimum Touch Target**: 45px × 44px on `button.ghost` ("←")

### `390x844-slash-command-intercepted.png`

- **Viewport**: 390x844
- **Screen**: slash-command-intercepted
- **Page-level Horizontal Overflow**: None (fits window)
- **Transcript Container (.messages-scroll)**: Overflows vertically (scrollable)
- **Body Text Typography**: font-size: 15px, line-height: 22.5px
- **Composer Bounding Box**: 390px × 69px at (x: 0, y: 775), fully inside viewport: YES, bottom padding: 12px
- **Model selector box**: 332px × 44px at (29, 171)
- **Transcript box**: 358px × 320px at (16, 235); Latest intersection: null
- **Code Block Scroll Geometry**: scrollWidth: 1807px, clientWidth: 326px (horizontal scroll: YES)
- **Table Scroll Geometry**: scrollWidth: 1472px, clientWidth: 328px (horizontal scroll: YES)
- **Minimum Touch Target**: 45px × 44px on `button.ghost` ("←")

### `390x844-approval-request.png`

- **Viewport**: 390x844
- **Screen**: approval-request
- **Page-level Horizontal Overflow**: None (fits window)
- **Transcript Container (.messages-scroll)**: Overflows vertically (scrollable)
- **Body Text Typography**: font-size: 15px, line-height: 22.5px
- **Composer Bounding Box**: 390px × 69px at (x: 0, y: 775), fully inside viewport: YES, bottom padding: 12px
- **Model selector box**: 332px × 44px at (29, 171)
- **Transcript box**: 358px × 524px at (16, 235); Latest intersection: null
- **Code Block Scroll Geometry**: scrollWidth: 1807px, clientWidth: 326px (horizontal scroll: YES)
- **Table Scroll Geometry**: scrollWidth: 1472px, clientWidth: 328px (horizontal scroll: YES)
- **Minimum Touch Target**: 45px × 44px on `button.ghost` ("←")

### `390x844-read-only-welcome.png`

- **Viewport**: 390x844
- **Screen**: read-only-welcome
- **Page-level Horizontal Overflow**: None (fits window)
- **Transcript Container (.messages-scroll)**: Fits vertically
- **Body Text Typography**: font-size: 15px, line-height: 22.5px
- **Composer Bounding Box**: 390px × 69px at (x: 0, y: 775), fully inside viewport: YES, bottom padding: 12px
- **Model selector box**: 332px × 44px at (29, 171)
- **Transcript box**: 358px × 91px at (16, 315); Latest intersection: null
- **Minimum Touch Target**: 45px × 44px on `button.ghost` ("←")

### `390x844-read-only-conversation.png`

- **Viewport**: 390x844
- **Screen**: read-only-conversation
- **Page-level Horizontal Overflow**: None (fits window)
- **Transcript Container (.messages-scroll)**: Fits vertically
- **Body Text Typography**: font-size: 15px, line-height: 22.5px
- **Composer Bounding Box**: 390px × 69px at (x: 0, y: 775), fully inside viewport: YES, bottom padding: 12px
- **Model selector box**: 332px × 44px at (29, 171)
- **Transcript box**: 358px × 286px at (16, 315); Latest intersection: null
- **Minimum Touch Target**: 45px × 44px on `button.ghost` ("←")

### `430x932-project-list.png`

- **Viewport**: 430x932
- **Screen**: project-list
- **Page-level Horizontal Overflow**: None (fits window)
- **Transcript Container (.messages-scroll)**: Not present
- **Body Text Typography**: font-size: 15px, line-height: 22.5px
- **Minimum Touch Target**: 125px × 44px on `button.primary` ("+ New Project")

### `430x932-folder-browser.png`

- **Viewport**: 430x932
- **Screen**: folder-browser
- **Page-level Horizontal Overflow**: None (fits window)
- **Transcript Container (.messages-scroll)**: Not present
- **Body Text Typography**: font-size: 15px, line-height: 22.5px
- **Minimum Touch Target**: 125px × 44px on `button.primary` ("+ New Project")

### `430x932-new-folder-form.png`

- **Viewport**: 430x932
- **Screen**: new-folder-form
- **Page-level Horizontal Overflow**: None (fits window)
- **Transcript Container (.messages-scroll)**: Not present
- **Body Text Typography**: font-size: 15px, line-height: 22.5px
- **Minimum Touch Target**: 125px × 44px on `button.primary` ("+ New Project")

### `430x932-folder-browser-paginated.png`

- **Viewport**: 430x932
- **Screen**: folder-browser-paginated
- **Page-level Horizontal Overflow**: None (fits window)
- **Transcript Container (.messages-scroll)**: Not present
- **Body Text Typography**: font-size: 15px, line-height: 22.5px
- **Minimum Touch Target**: 125px × 44px on `button.primary` ("+ New Project")

### `430x932-conversation-list.png`

- **Viewport**: 430x932
- **Screen**: conversation-list
- **Page-level Horizontal Overflow**: None (fits window)
- **Transcript Container (.messages-scroll)**: Not present
- **Body Text Typography**: font-size: 15px, line-height: 22.5px
- **Minimum Touch Target**: 106px × 44px on `button.primary` ("+ New chat")

### `430x932-model-settings-expanded.png`

- **Viewport**: 430x932
- **Screen**: model-settings-expanded
- **Page-level Horizontal Overflow**: None (fits window)
- **Transcript Container (.messages-scroll)**: Fits vertically
- **Body Text Typography**: font-size: 15px, line-height: 22.5px
- **Composer Bounding Box**: 430px × 69px at (x: 0, y: 863), fully inside viewport: YES, bottom padding: 12px
- **Model selector box**: 372px × 44px at (29, 179)
- **Transcript box**: 398px × 97px at (16, 562); Latest intersection: null
- **Minimum Touch Target**: 45px × 44px on `button.ghost` ("←")

### `430x932-model-selector-populated.png`

- **Viewport**: 430x932
- **Screen**: model-selector-populated
- **Page-level Horizontal Overflow**: None (fits window)
- **Transcript Container (.messages-scroll)**: Fits vertically
- **Body Text Typography**: font-size: 15px, line-height: 22.5px
- **Composer Bounding Box**: 430px × 69px at (x: 0, y: 863), fully inside viewport: YES, bottom padding: 12px
- **Model selector box**: 372px × 44px at (29, 179)
- **Transcript box**: 398px × 97px at (16, 562); Latest intersection: null
- **Minimum Touch Target**: 45px × 44px on `button.ghost` ("←")

### `430x932-short-exchange.png`

- **Viewport**: 430x932
- **Screen**: short-exchange
- **Page-level Horizontal Overflow**: None (fits window)
- **Transcript Container (.messages-scroll)**: Fits vertically
- **Body Text Typography**: font-size: 15px, line-height: 22.5px
- **Composer Bounding Box**: 430px × 69px at (x: 0, y: 863), fully inside viewport: YES, bottom padding: 12px
- **Model selector box**: 372px × 44px at (29, 171)
- **Transcript box**: 398px × 188px at (16, 251); Latest intersection: null
- **Minimum Touch Target**: 45px × 44px on `button.ghost` ("←")

### `430x932-long-response.png`

- **Viewport**: 430x932
- **Screen**: long-response
- **Page-level Horizontal Overflow**: None (fits window)
- **Transcript Container (.messages-scroll)**: Overflows vertically (scrollable)
- **Body Text Typography**: font-size: 15px, line-height: 22.5px
- **Composer Bounding Box**: 430px × 69px at (x: 0, y: 863), fully inside viewport: YES, bottom padding: 12px
- **Latest button box**: 74px × 44px at (340, 808)
- **Latest-to-composer gap**: 12px
- **Model selector box**: 372px × 44px at (29, 171)
- **Transcript box**: 398px × 552px at (16, 251); Latest intersection: false
- **Code Block Scroll Geometry**: scrollWidth: 1807px, clientWidth: 366px (horizontal scroll: YES)
- **Table Scroll Geometry**: scrollWidth: 1472px, clientWidth: 368px (horizontal scroll: YES)
- **Minimum Touch Target**: 45px × 44px on `button.ghost` ("←")

### `430x932-wide-table.png`

- **Viewport**: 430x932
- **Screen**: wide-table
- **Page-level Horizontal Overflow**: None (fits window)
- **Transcript Container (.messages-scroll)**: Overflows vertically (scrollable)
- **Body Text Typography**: font-size: 15px, line-height: 22.5px
- **Composer Bounding Box**: 430px × 69px at (x: 0, y: 863), fully inside viewport: YES, bottom padding: 12px
- **Latest button box**: 74px × 44px at (340, 808)
- **Latest-to-composer gap**: 12px
- **Model selector box**: 372px × 44px at (29, 171)
- **Transcript box**: 398px × 568px at (16, 235); Latest intersection: false
- **Code Block Scroll Geometry**: scrollWidth: 1807px, clientWidth: 366px (horizontal scroll: YES)
- **Table Scroll Geometry**: scrollWidth: 1472px, clientWidth: 368px (horizontal scroll: YES)
- **Minimum Touch Target**: 45px × 44px on `button.ghost` ("←")

### `430x932-unbroken-string.png`

- **Viewport**: 430x932
- **Screen**: unbroken-string
- **Page-level Horizontal Overflow**: None (fits window)
- **Transcript Container (.messages-scroll)**: Overflows vertically (scrollable)
- **Body Text Typography**: font-size: 15px, line-height: 22.5px
- **Composer Bounding Box**: 430px × 69px at (x: 0, y: 863), fully inside viewport: YES, bottom padding: 12px
- **Latest button box**: 74px × 44px at (340, 808)
- **Latest-to-composer gap**: 12px
- **Model selector box**: 372px × 44px at (29, 171)
- **Transcript box**: 398px × 568px at (16, 235); Latest intersection: false
- **Code Block Scroll Geometry**: scrollWidth: 1807px, clientWidth: 366px (horizontal scroll: YES)
- **Table Scroll Geometry**: scrollWidth: 1472px, clientWidth: 368px (horizontal scroll: YES)
- **Minimum Touch Target**: 45px × 44px on `button.ghost` ("←")

### `430x932-large-code-block.png`

- **Viewport**: 430x932
- **Screen**: large-code-block
- **Page-level Horizontal Overflow**: None (fits window)
- **Transcript Container (.messages-scroll)**: Overflows vertically (scrollable)
- **Body Text Typography**: font-size: 15px, line-height: 22.5px
- **Composer Bounding Box**: 430px × 69px at (x: 0, y: 863), fully inside viewport: YES, bottom padding: 12px
- **Latest button box**: 74px × 44px at (340, 808)
- **Latest-to-composer gap**: 12px
- **Model selector box**: 372px × 44px at (29, 171)
- **Transcript box**: 398px × 568px at (16, 235); Latest intersection: false
- **Code Block Scroll Geometry**: scrollWidth: 1807px, clientWidth: 366px (horizontal scroll: YES)
- **Table Scroll Geometry**: scrollWidth: 1472px, clientWidth: 368px (horizontal scroll: YES)
- **Minimum Touch Target**: 45px × 44px on `button.ghost` ("←")

### `430x932-expanded-tool-details.png`

- **Viewport**: 430x932
- **Screen**: expanded-tool-details
- **Page-level Horizontal Overflow**: None (fits window)
- **Transcript Container (.messages-scroll)**: Overflows vertically (scrollable)
- **Body Text Typography**: font-size: 15px, line-height: 22.5px
- **Composer Bounding Box**: 430px × 69px at (x: 0, y: 863), fully inside viewport: YES, bottom padding: 12px
- **Latest button box**: 74px × 44px at (340, 808)
- **Latest-to-composer gap**: 12px
- **Model selector box**: 372px × 44px at (29, 171)
- **Transcript box**: 398px × 568px at (16, 235); Latest intersection: false
- **Code Block Scroll Geometry**: scrollWidth: 1807px, clientWidth: 366px (horizontal scroll: YES)
- **Table Scroll Geometry**: scrollWidth: 1472px, clientWidth: 368px (horizontal scroll: YES)
- **Minimum Touch Target**: 45px × 44px on `button.ghost` ("←")

### `430x932-subagent-panel.png`

- **Viewport**: 430x932
- **Screen**: subagent-panel
- **Page-level Horizontal Overflow**: None (fits window)
- **Transcript Container (.messages-scroll)**: Overflows vertically (scrollable)
- **Body Text Typography**: font-size: 15px, line-height: 22.5px
- **Composer Bounding Box**: 430px × 69px at (x: 0, y: 863), fully inside viewport: YES, bottom padding: 12px
- **Latest button box**: 74px × 44px at (340, 808)
- **Latest-to-composer gap**: 12px
- **Model selector box**: 372px × 44px at (29, 171)
- **Transcript box**: 398px × 568px at (16, 235); Latest intersection: false
- **Code Block Scroll Geometry**: scrollWidth: 1807px, clientWidth: 366px (horizontal scroll: YES)
- **Table Scroll Geometry**: scrollWidth: 1472px, clientWidth: 368px (horizontal scroll: YES)
- **Minimum Touch Target**: 45px × 44px on `button.ghost` ("←")

### `430x932-slash-suggestions.png`

- **Viewport**: 430x932
- **Screen**: slash-suggestions
- **Page-level Horizontal Overflow**: None (fits window)
- **Transcript Container (.messages-scroll)**: Overflows vertically (scrollable)
- **Body Text Typography**: font-size: 15px, line-height: 22.5px
- **Composer Bounding Box**: 430px × 69px at (x: 0, y: 863), fully inside viewport: YES, bottom padding: 12px
- **Model selector box**: 372px × 44px at (29, 171)
- **Transcript box**: 398px × 408px at (16, 235); Latest intersection: null
- **Code Block Scroll Geometry**: scrollWidth: 1807px, clientWidth: 366px (horizontal scroll: YES)
- **Table Scroll Geometry**: scrollWidth: 1472px, clientWidth: 368px (horizontal scroll: YES)
- **Minimum Touch Target**: 45px × 44px on `button.ghost` ("←")

### `430x932-slash-command-intercepted.png`

- **Viewport**: 430x932
- **Screen**: slash-command-intercepted
- **Page-level Horizontal Overflow**: None (fits window)
- **Transcript Container (.messages-scroll)**: Overflows vertically (scrollable)
- **Body Text Typography**: font-size: 15px, line-height: 22.5px
- **Composer Bounding Box**: 430px × 69px at (x: 0, y: 863), fully inside viewport: YES, bottom padding: 12px
- **Model selector box**: 372px × 44px at (29, 171)
- **Transcript box**: 398px × 421px at (16, 235); Latest intersection: null
- **Code Block Scroll Geometry**: scrollWidth: 1807px, clientWidth: 366px (horizontal scroll: YES)
- **Table Scroll Geometry**: scrollWidth: 1472px, clientWidth: 368px (horizontal scroll: YES)
- **Minimum Touch Target**: 45px × 44px on `button.ghost` ("←")

### `430x932-approval-request.png`

- **Viewport**: 430x932
- **Screen**: approval-request
- **Page-level Horizontal Overflow**: None (fits window)
- **Transcript Container (.messages-scroll)**: Overflows vertically (scrollable)
- **Body Text Typography**: font-size: 15px, line-height: 22.5px
- **Composer Bounding Box**: 430px × 69px at (x: 0, y: 863), fully inside viewport: YES, bottom padding: 12px
- **Model selector box**: 372px × 44px at (29, 171)
- **Transcript box**: 398px × 612px at (16, 235); Latest intersection: null
- **Code Block Scroll Geometry**: scrollWidth: 1807px, clientWidth: 366px (horizontal scroll: YES)
- **Table Scroll Geometry**: scrollWidth: 1472px, clientWidth: 368px (horizontal scroll: YES)
- **Minimum Touch Target**: 45px × 44px on `button.ghost` ("←")

### `430x932-read-only-welcome.png`

- **Viewport**: 430x932
- **Screen**: read-only-welcome
- **Page-level Horizontal Overflow**: None (fits window)
- **Transcript Container (.messages-scroll)**: Fits vertically
- **Body Text Typography**: font-size: 15px, line-height: 22.5px
- **Composer Bounding Box**: 430px × 69px at (x: 0, y: 863), fully inside viewport: YES, bottom padding: 12px
- **Model selector box**: 372px × 44px at (29, 171)
- **Transcript box**: 398px × 70px at (16, 315); Latest intersection: null
- **Minimum Touch Target**: 45px × 44px on `button.ghost` ("←")

### `430x932-read-only-conversation.png`

- **Viewport**: 430x932
- **Screen**: read-only-conversation
- **Page-level Horizontal Overflow**: None (fits window)
- **Transcript Container (.messages-scroll)**: Fits vertically
- **Body Text Typography**: font-size: 15px, line-height: 22.5px
- **Composer Bounding Box**: 430px × 69px at (x: 0, y: 863), fully inside viewport: YES, bottom padding: 12px
- **Model selector box**: 372px × 44px at (29, 171)
- **Transcript box**: 398px × 265px at (16, 315); Latest intersection: null
- **Minimum Touch Target**: 45px × 44px on `button.ghost` ("←")

### `768x1024-project-list.png`

- **Viewport**: 768x1024
- **Screen**: project-list
- **Page-level Horizontal Overflow**: None (fits window)
- **Transcript Container (.messages-scroll)**: Not present
- **Body Text Typography**: font-size: 15px, line-height: 22.5px
- **Minimum Touch Target**: 125px × 44px on `button.primary` ("+ New Project")

### `768x1024-folder-browser.png`

- **Viewport**: 768x1024
- **Screen**: folder-browser
- **Page-level Horizontal Overflow**: None (fits window)
- **Transcript Container (.messages-scroll)**: Not present
- **Body Text Typography**: font-size: 15px, line-height: 22.5px
- **Minimum Touch Target**: 125px × 44px on `button.primary` ("+ New Project")

### `768x1024-new-folder-form.png`

- **Viewport**: 768x1024
- **Screen**: new-folder-form
- **Page-level Horizontal Overflow**: None (fits window)
- **Transcript Container (.messages-scroll)**: Not present
- **Body Text Typography**: font-size: 15px, line-height: 22.5px
- **Minimum Touch Target**: 125px × 44px on `button.primary` ("+ New Project")

### `768x1024-conversation-list.png`

- **Viewport**: 768x1024
- **Screen**: conversation-list
- **Page-level Horizontal Overflow**: None (fits window)
- **Transcript Container (.messages-scroll)**: Not present
- **Body Text Typography**: font-size: 15px, line-height: 22.5px
- **Minimum Touch Target**: 82px × 44px on `button.ghost` ("← Back")

### `768x1024-short-exchange.png`

- **Viewport**: 768x1024
- **Screen**: short-exchange
- **Page-level Horizontal Overflow**: None (fits window)
- **Transcript Container (.messages-scroll)**: Fits vertically
- **Body Text Typography**: font-size: 15px, line-height: 22.5px
- **Composer Bounding Box**: 768px × 69px at (x: 0, y: 955), fully inside viewport: YES, bottom padding: 12px
- **Model selector box**: 710px × 44px at (29, 171)
- **Transcript box**: 736px × 165px at (16, 251); Latest intersection: null
- **Minimum Touch Target**: 45px × 44px on `button.ghost` ("←")

### `768x1024-long-response.png`

- **Viewport**: 768x1024
- **Screen**: long-response
- **Page-level Horizontal Overflow**: None (fits window)
- **Transcript Container (.messages-scroll)**: Overflows vertically (scrollable)
- **Body Text Typography**: font-size: 15px, line-height: 22.5px
- **Composer Bounding Box**: 768px × 69px at (x: 0, y: 955), fully inside viewport: YES, bottom padding: 12px
- **Latest button box**: 74px × 44px at (678, 900)
- **Latest-to-composer gap**: 12px
- **Model selector box**: 710px × 44px at (29, 171)
- **Transcript box**: 736px × 644px at (16, 251); Latest intersection: false
- **Code Block Scroll Geometry**: scrollWidth: 1807px, clientWidth: 704px (horizontal scroll: YES)
- **Table Scroll Geometry**: scrollWidth: 1472px, clientWidth: 706px (horizontal scroll: YES)
- **Minimum Touch Target**: 45px × 44px on `button.ghost` ("←")

### `768x1024-wide-table.png`

- **Viewport**: 768x1024
- **Screen**: wide-table
- **Page-level Horizontal Overflow**: None (fits window)
- **Transcript Container (.messages-scroll)**: Overflows vertically (scrollable)
- **Body Text Typography**: font-size: 15px, line-height: 22.5px
- **Composer Bounding Box**: 768px × 69px at (x: 0, y: 955), fully inside viewport: YES, bottom padding: 12px
- **Latest button box**: 74px × 44px at (678, 900)
- **Latest-to-composer gap**: 12px
- **Model selector box**: 710px × 44px at (29, 171)
- **Transcript box**: 736px × 660px at (16, 235); Latest intersection: false
- **Code Block Scroll Geometry**: scrollWidth: 1807px, clientWidth: 704px (horizontal scroll: YES)
- **Table Scroll Geometry**: scrollWidth: 1472px, clientWidth: 706px (horizontal scroll: YES)
- **Minimum Touch Target**: 45px × 44px on `button.ghost` ("←")

### `768x1024-unbroken-string.png`

- **Viewport**: 768x1024
- **Screen**: unbroken-string
- **Page-level Horizontal Overflow**: None (fits window)
- **Transcript Container (.messages-scroll)**: Overflows vertically (scrollable)
- **Body Text Typography**: font-size: 15px, line-height: 22.5px
- **Composer Bounding Box**: 768px × 69px at (x: 0, y: 955), fully inside viewport: YES, bottom padding: 12px
- **Latest button box**: 74px × 44px at (678, 900)
- **Latest-to-composer gap**: 12px
- **Model selector box**: 710px × 44px at (29, 171)
- **Transcript box**: 736px × 660px at (16, 235); Latest intersection: false
- **Code Block Scroll Geometry**: scrollWidth: 1807px, clientWidth: 704px (horizontal scroll: YES)
- **Table Scroll Geometry**: scrollWidth: 1472px, clientWidth: 706px (horizontal scroll: YES)
- **Minimum Touch Target**: 45px × 44px on `button.ghost` ("←")

### `768x1024-large-code-block.png`

- **Viewport**: 768x1024
- **Screen**: large-code-block
- **Page-level Horizontal Overflow**: None (fits window)
- **Transcript Container (.messages-scroll)**: Overflows vertically (scrollable)
- **Body Text Typography**: font-size: 15px, line-height: 22.5px
- **Composer Bounding Box**: 768px × 69px at (x: 0, y: 955), fully inside viewport: YES, bottom padding: 12px
- **Latest button box**: 74px × 44px at (678, 900)
- **Latest-to-composer gap**: 12px
- **Model selector box**: 710px × 44px at (29, 171)
- **Transcript box**: 736px × 660px at (16, 235); Latest intersection: false
- **Code Block Scroll Geometry**: scrollWidth: 1807px, clientWidth: 704px (horizontal scroll: YES)
- **Table Scroll Geometry**: scrollWidth: 1472px, clientWidth: 706px (horizontal scroll: YES)
- **Minimum Touch Target**: 45px × 44px on `button.ghost` ("←")

### `768x1024-expanded-tool-details.png`

- **Viewport**: 768x1024
- **Screen**: expanded-tool-details
- **Page-level Horizontal Overflow**: None (fits window)
- **Transcript Container (.messages-scroll)**: Overflows vertically (scrollable)
- **Body Text Typography**: font-size: 15px, line-height: 22.5px
- **Composer Bounding Box**: 768px × 69px at (x: 0, y: 955), fully inside viewport: YES, bottom padding: 12px
- **Latest button box**: 74px × 44px at (678, 900)
- **Latest-to-composer gap**: 12px
- **Model selector box**: 710px × 44px at (29, 171)
- **Transcript box**: 736px × 660px at (16, 235); Latest intersection: false
- **Code Block Scroll Geometry**: scrollWidth: 1807px, clientWidth: 704px (horizontal scroll: YES)
- **Table Scroll Geometry**: scrollWidth: 1472px, clientWidth: 706px (horizontal scroll: YES)
- **Minimum Touch Target**: 45px × 44px on `button.ghost` ("←")

### `768x1024-subagent-panel.png`

- **Viewport**: 768x1024
- **Screen**: subagent-panel
- **Page-level Horizontal Overflow**: None (fits window)
- **Transcript Container (.messages-scroll)**: Overflows vertically (scrollable)
- **Body Text Typography**: font-size: 15px, line-height: 22.5px
- **Composer Bounding Box**: 768px × 69px at (x: 0, y: 955), fully inside viewport: YES, bottom padding: 12px
- **Latest button box**: 74px × 44px at (678, 900)
- **Latest-to-composer gap**: 12px
- **Model selector box**: 710px × 44px at (29, 171)
- **Transcript box**: 736px × 660px at (16, 235); Latest intersection: false
- **Code Block Scroll Geometry**: scrollWidth: 1807px, clientWidth: 704px (horizontal scroll: YES)
- **Table Scroll Geometry**: scrollWidth: 1472px, clientWidth: 706px (horizontal scroll: YES)
- **Minimum Touch Target**: 45px × 44px on `button.ghost` ("←")

### `768x1024-slash-suggestions.png`

- **Viewport**: 768x1024
- **Screen**: slash-suggestions
- **Page-level Horizontal Overflow**: None (fits window)
- **Transcript Container (.messages-scroll)**: Overflows vertically (scrollable)
- **Body Text Typography**: font-size: 15px, line-height: 22.5px
- **Composer Bounding Box**: 768px × 69px at (x: 0, y: 955), fully inside viewport: YES, bottom padding: 12px
- **Model selector box**: 710px × 44px at (29, 171)
- **Transcript box**: 736px × 500px at (16, 235); Latest intersection: null
- **Code Block Scroll Geometry**: scrollWidth: 1807px, clientWidth: 704px (horizontal scroll: YES)
- **Table Scroll Geometry**: scrollWidth: 1472px, clientWidth: 706px (horizontal scroll: YES)
- **Minimum Touch Target**: 45px × 44px on `button.ghost` ("←")

### `768x1024-approval-request.png`

- **Viewport**: 768x1024
- **Screen**: approval-request
- **Page-level Horizontal Overflow**: None (fits window)
- **Transcript Container (.messages-scroll)**: Overflows vertically (scrollable)
- **Body Text Typography**: font-size: 15px, line-height: 22.5px
- **Composer Bounding Box**: 768px × 69px at (x: 0, y: 955), fully inside viewport: YES, bottom padding: 12px
- **Model selector box**: 710px × 44px at (29, 171)
- **Transcript box**: 736px × 704px at (16, 235); Latest intersection: null
- **Code Block Scroll Geometry**: scrollWidth: 1807px, clientWidth: 704px (horizontal scroll: YES)
- **Table Scroll Geometry**: scrollWidth: 1472px, clientWidth: 706px (horizontal scroll: YES)
- **Minimum Touch Target**: 45px × 44px on `button.ghost` ("←")

### `1280x800-project-list.png`

- **Viewport**: 1280x800
- **Screen**: project-list
- **Page-level Horizontal Overflow**: None (fits window)
- **Transcript Container (.messages-scroll)**: Not present
- **Body Text Typography**: font-size: 15px, line-height: 22.5px
- **Minimum Touch Target**: 125px × 44px on `button.primary` ("+ New Project")

### `1280x800-folder-browser.png`

- **Viewport**: 1280x800
- **Screen**: folder-browser
- **Page-level Horizontal Overflow**: None (fits window)
- **Transcript Container (.messages-scroll)**: Not present
- **Body Text Typography**: font-size: 15px, line-height: 22.5px
- **Minimum Touch Target**: 125px × 44px on `button.primary` ("+ New Project")

### `1280x800-new-folder-form.png`

- **Viewport**: 1280x800
- **Screen**: new-folder-form
- **Page-level Horizontal Overflow**: None (fits window)
- **Transcript Container (.messages-scroll)**: Not present
- **Body Text Typography**: font-size: 15px, line-height: 22.5px
- **Minimum Touch Target**: 125px × 44px on `button.primary` ("+ New Project")

### `1280x800-conversation-list.png`

- **Viewport**: 1280x800
- **Screen**: conversation-list
- **Page-level Horizontal Overflow**: None (fits window)
- **Transcript Container (.messages-scroll)**: Not present
- **Body Text Typography**: font-size: 15px, line-height: 22.5px
- **Minimum Touch Target**: 82px × 44px on `button.ghost` ("← Back")

### `1280x800-short-exchange.png`

- **Viewport**: 1280x800
- **Screen**: short-exchange
- **Page-level Horizontal Overflow**: None (fits window)
- **Transcript Container (.messages-scroll)**: Fits vertically
- **Body Text Typography**: font-size: 15px, line-height: 22.5px
- **Composer Bounding Box**: 900px × 69px at (x: 190, y: 731), fully inside viewport: YES, bottom padding: 12px
- **Model selector box**: 842px × 44px at (219, 171)
- **Transcript box**: 868px × 165px at (206, 251); Latest intersection: null
- **Minimum Touch Target**: 45px × 44px on `button.ghost` ("←")

### `1280x800-long-response.png`

- **Viewport**: 1280x800
- **Screen**: long-response
- **Page-level Horizontal Overflow**: None (fits window)
- **Transcript Container (.messages-scroll)**: Overflows vertically (scrollable)
- **Body Text Typography**: font-size: 15px, line-height: 22.5px
- **Composer Bounding Box**: 900px × 69px at (x: 190, y: 731), fully inside viewport: YES, bottom padding: 12px
- **Latest button box**: 74px × 44px at (1000, 676)
- **Latest-to-composer gap**: 12px
- **Model selector box**: 842px × 44px at (219, 171)
- **Transcript box**: 868px × 420px at (206, 251); Latest intersection: false
- **Code Block Scroll Geometry**: scrollWidth: 1807px, clientWidth: 836px (horizontal scroll: YES)
- **Table Scroll Geometry**: scrollWidth: 1472px, clientWidth: 838px (horizontal scroll: YES)
- **Minimum Touch Target**: 45px × 44px on `button.ghost` ("←")

### `1280x800-wide-table.png`

- **Viewport**: 1280x800
- **Screen**: wide-table
- **Page-level Horizontal Overflow**: None (fits window)
- **Transcript Container (.messages-scroll)**: Overflows vertically (scrollable)
- **Body Text Typography**: font-size: 15px, line-height: 22.5px
- **Composer Bounding Box**: 900px × 69px at (x: 190, y: 731), fully inside viewport: YES, bottom padding: 12px
- **Latest button box**: 74px × 44px at (1000, 676)
- **Latest-to-composer gap**: 12px
- **Model selector box**: 842px × 44px at (219, 171)
- **Transcript box**: 868px × 436px at (206, 235); Latest intersection: false
- **Code Block Scroll Geometry**: scrollWidth: 1807px, clientWidth: 836px (horizontal scroll: YES)
- **Table Scroll Geometry**: scrollWidth: 1472px, clientWidth: 838px (horizontal scroll: YES)
- **Minimum Touch Target**: 45px × 44px on `button.ghost` ("←")

### `1280x800-unbroken-string.png`

- **Viewport**: 1280x800
- **Screen**: unbroken-string
- **Page-level Horizontal Overflow**: None (fits window)
- **Transcript Container (.messages-scroll)**: Overflows vertically (scrollable)
- **Body Text Typography**: font-size: 15px, line-height: 22.5px
- **Composer Bounding Box**: 900px × 69px at (x: 190, y: 731), fully inside viewport: YES, bottom padding: 12px
- **Latest button box**: 74px × 44px at (1000, 676)
- **Latest-to-composer gap**: 12px
- **Model selector box**: 842px × 44px at (219, 171)
- **Transcript box**: 868px × 436px at (206, 235); Latest intersection: false
- **Code Block Scroll Geometry**: scrollWidth: 1807px, clientWidth: 836px (horizontal scroll: YES)
- **Table Scroll Geometry**: scrollWidth: 1472px, clientWidth: 838px (horizontal scroll: YES)
- **Minimum Touch Target**: 45px × 44px on `button.ghost` ("←")

### `1280x800-large-code-block.png`

- **Viewport**: 1280x800
- **Screen**: large-code-block
- **Page-level Horizontal Overflow**: None (fits window)
- **Transcript Container (.messages-scroll)**: Overflows vertically (scrollable)
- **Body Text Typography**: font-size: 15px, line-height: 22.5px
- **Composer Bounding Box**: 900px × 69px at (x: 190, y: 731), fully inside viewport: YES, bottom padding: 12px
- **Latest button box**: 74px × 44px at (1000, 676)
- **Latest-to-composer gap**: 12px
- **Model selector box**: 842px × 44px at (219, 171)
- **Transcript box**: 868px × 436px at (206, 235); Latest intersection: false
- **Code Block Scroll Geometry**: scrollWidth: 1807px, clientWidth: 836px (horizontal scroll: YES)
- **Table Scroll Geometry**: scrollWidth: 1472px, clientWidth: 838px (horizontal scroll: YES)
- **Minimum Touch Target**: 45px × 44px on `button.ghost` ("←")

### `1280x800-expanded-tool-details.png`

- **Viewport**: 1280x800
- **Screen**: expanded-tool-details
- **Page-level Horizontal Overflow**: None (fits window)
- **Transcript Container (.messages-scroll)**: Overflows vertically (scrollable)
- **Body Text Typography**: font-size: 15px, line-height: 22.5px
- **Composer Bounding Box**: 900px × 69px at (x: 190, y: 731), fully inside viewport: YES, bottom padding: 12px
- **Latest button box**: 74px × 44px at (1000, 676)
- **Latest-to-composer gap**: 12px
- **Model selector box**: 842px × 44px at (219, 171)
- **Transcript box**: 868px × 436px at (206, 235); Latest intersection: false
- **Code Block Scroll Geometry**: scrollWidth: 1807px, clientWidth: 836px (horizontal scroll: YES)
- **Table Scroll Geometry**: scrollWidth: 1472px, clientWidth: 838px (horizontal scroll: YES)
- **Minimum Touch Target**: 45px × 44px on `button.ghost` ("←")

### `1280x800-subagent-panel.png`

- **Viewport**: 1280x800
- **Screen**: subagent-panel
- **Page-level Horizontal Overflow**: None (fits window)
- **Transcript Container (.messages-scroll)**: Overflows vertically (scrollable)
- **Body Text Typography**: font-size: 15px, line-height: 22.5px
- **Composer Bounding Box**: 900px × 69px at (x: 190, y: 731), fully inside viewport: YES, bottom padding: 12px
- **Latest button box**: 74px × 44px at (1000, 676)
- **Latest-to-composer gap**: 12px
- **Model selector box**: 842px × 44px at (219, 171)
- **Transcript box**: 868px × 436px at (206, 235); Latest intersection: false
- **Code Block Scroll Geometry**: scrollWidth: 1807px, clientWidth: 836px (horizontal scroll: YES)
- **Table Scroll Geometry**: scrollWidth: 1472px, clientWidth: 838px (horizontal scroll: YES)
- **Minimum Touch Target**: 45px × 44px on `button.ghost` ("←")

### `1280x800-slash-suggestions.png`

- **Viewport**: 1280x800
- **Screen**: slash-suggestions
- **Page-level Horizontal Overflow**: None (fits window)
- **Transcript Container (.messages-scroll)**: Overflows vertically (scrollable)
- **Body Text Typography**: font-size: 15px, line-height: 22.5px
- **Composer Bounding Box**: 900px × 69px at (x: 190, y: 731), fully inside viewport: YES, bottom padding: 12px
- **Model selector box**: 842px × 44px at (219, 171)
- **Transcript box**: 868px × 276px at (206, 235); Latest intersection: null
- **Code Block Scroll Geometry**: scrollWidth: 1807px, clientWidth: 836px (horizontal scroll: YES)
- **Table Scroll Geometry**: scrollWidth: 1472px, clientWidth: 838px (horizontal scroll: YES)
- **Minimum Touch Target**: 45px × 44px on `button.ghost` ("←")

### `1280x800-approval-request.png`

- **Viewport**: 1280x800
- **Screen**: approval-request
- **Page-level Horizontal Overflow**: None (fits window)
- **Transcript Container (.messages-scroll)**: Overflows vertically (scrollable)
- **Body Text Typography**: font-size: 15px, line-height: 22.5px
- **Composer Bounding Box**: 900px × 69px at (x: 190, y: 731), fully inside viewport: YES, bottom padding: 12px
- **Model selector box**: 842px × 44px at (219, 171)
- **Transcript box**: 868px × 480px at (206, 235); Latest intersection: null
- **Code Block Scroll Geometry**: scrollWidth: 1807px, clientWidth: 836px (horizontal scroll: YES)
- **Table Scroll Geometry**: scrollWidth: 1472px, clientWidth: 838px (horizontal scroll: YES)
- **Minimum Touch Target**: 45px × 44px on `button.ghost` ("←")

