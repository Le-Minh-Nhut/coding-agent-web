# Premium design spec (round 58)

Scope: `apps/web` presentation only. No server, contract, lifecycle or protocol
change. This file is the testable target; `tests/e2e/premium-visual.spec.ts`
asserts the parts a browser can hold (geometry, contrast, DOM roles), and the
captures in `docs/audits/assets/round58/` are for human review.

---

## 0. Reference situation — what actually exists on this machine

**No owner-supplied "premium dark-mode reference" image exists anywhere I could
find, and this is a negative result from a search, not an assumption.**

Searched (whole filesystem, `-xdev`, excluding `node_modules`, `.git`, browser
caches): every `*.png|jpg|jpeg|webp` under `/home/heheboiz` at depth ≤ 4 and every
image under the repo; all four `~/Pictures/Screenshots/*`; all of `~/Downloads`
(215 images); `/tmp`, `/var/tmp`; the omp agent blob store
(`~/.omp/agent/blobs/`, 900+ files); and every session journal under
`~/.omp/agent/sessions/`, checking for attached image content blocks
(`{"type":"image"}`, `data:image/`, `"image_url"`, `file://…png`).

What the search *did* find, and why each is not the reference:

| candidate | verdict |
| --- | --- |
| `docs/audits/assets/round57/{idle,running}-*.png` (8 files, 2026-11-06 19:42) | **the current UI**, not a target. These are round 57's own captures of this app. |
| `~/Pictures/Screenshots/Screenshot From 2026-11-06 00-15-2{1,6}.png` (1919x1009) | **I read both.** They are screenshots of a *terminal* showing a markdown performance report — a before/after metrics table, testing counts, a deployment summary. Not a UI reference. |
| `~/Pictures/Screenshots/Screenshot From 2026-11-0{3,10-31}-*.png` (1228x175, 1426x325) | **I read both.** Thin terminal strips. Not a UI reference. |
| `docs/audits/assets/round54-*.png` (7, in `~/.cache2|cache3/caw-screens`) | round 54's own captures: the sheet, the agents layer, the hostile banner stack. Current UI. |
| `docs/assets/screens/**` (91 files) | the round-8/round-30/round-55 screen inventory. Current UI at earlier revisions. |
| `.omp/agent/blobs/*` portrait phone-shaped images | all are **this app's own captures** re-encoded by the harness (780x1688 / 750x1334 / 640x1136 / 860x1864 — exactly the four phone viewports at DPR 2). No foreign reference among them. |
| `docs/audits/round54-premium-mobile-design.md` §1 | says so itself: *"the screenshot itself was not available"*. |

The brief that started this line of work (recovered verbatim from the session
journal, `~/.omp/agent/sessions/-data-coding-agent-web/2026-11-06T14-33-40-…/__advisor.jsonl`)
states the owner supplied **two** screenshots — the desired interface and the
current one — and that they "represent" those two things. Neither was attached to
any recoverable context on this machine: the journals contain no image content
block at all, so the bytes never reached disk. I am reporting this rather than
reconstructing a target from adjectives.

**Therefore the target below is derived strictly from the two written sources that
do exist** — `round54-premium-mobile-design.md` §1/§3 (the characterisation of the
reference: near-black canvas, ONE compact header row, small status dot/word,
subtle model/status metadata, compact navigation summaries, rounded right-aligned
user bubble, auto-collapsing long prompts, minimal assistant chrome, elegant
expandable tool summaries, compact fixed composer) — plus what the round-57
captures objectively show as *divergences from that characterisation*. Each
divergence is named with the measurement that proves it, in §2.

## 0.1 What the round-57 captures show (read by me, pixel-level)

I read `idle-{320,375,390,430}` and `running-{320,390,430}` directly. Two
objective measurements come out of the pixels, and both are the kind of thing the
written characterisation predicts:

- **The header is a lighter band across the top.** Sampling column x=2 down each
  capture, the header band is a single uniform `rgb(27,27,27)`
  (`--surface-primary` #1b1b1b) for the first **56 css px** at all four widths
  (640/750/780/860 device px ÷ DPR 2), against a `#050505` canvas below it. The
  reference's "near-black canvas" is therefore not what the shipped screen looks
  like: the top 56px is a visibly raised plate. The composer repeats it at the
  bottom.
- **The dashboard row is a second plate**, ~64-72 css px including its gutter, of
  three bordered `#242424` cards, directly under the first. Measured in the
  captures: the first transcript row does not start until ~128 css px down a
  568px screen — **23% of a small phone's height is permanent chrome** before any
  conversation is visible.

Also visible, and matching §1's "anti-requirements" list: the header's status word
is green enough to be one of the two loudest inks on the screen; the dashboard's
three cards carry two lines of centred-ish text each; the composer is a full-width
field with a saturated blue square inside it.

---

## 0.2 Commands — build and capture (RUN, results in §0.3)

Two workers shared this machine during stage 1, so the build and the Playwright runs
were deferred to stage 2. They were run there; §0.3 records what they returned.

```bash
# 1. build the bundle the capture harness serves
cd /home/heheboiz/data/coding-agent-web
pnpm --filter @caw/web build

# 2. the new geometry + contrast gate, and its captures into the repo location.
#    --workers=1 and a TMPDIR outside the repo, as the brief requires.
TMPDIR=$HOME/.cache CAW_SCREENS_DIR=$PWD/docs/audits/assets/round58 \
  npx playwright test tests/e2e/premium-visual.spec.ts \
  --project=chromium --workers=1 --reporter=line

# 3. the pre-existing gates this change could have broken (run after 2, one at a time)
TMPDIR=$HOME/.cache npx playwright test tests/e2e/round54-mobile-redesign.spec.ts \
  tests/e2e/round50-measure.spec.ts tests/e2e/files-center.spec.ts \
  tests/e2e/sync-states-visual.spec.ts --project=chromium --workers=1 --reporter=line

# 4. unit suites and the type gates
pnpm test
pnpm -r typecheck
```

`docs/audits/assets/round58/` now holds **28** files: the 20 the brief named plus
eight for the two surfaces the windowing change added (`search`, `subagents` — see
§0.4). A failing gate is reported as-is; no assertion was relaxed.

---

## 0.3 What the gates returned (stage 2, this machine)

Build: `pnpm --filter @caw/web build` → `index.css` **57.63 kB** (gzip 10.54), JS
**481.91 kB** (gzip 142.18). With the `premium.css` import commented out, the same
tree builds CSS **53.01 kB** (gzip 9.78) and byte-identical JS: the layer costs
**+4.62 kB raw / +0.76 kB gzip** and nothing at runtime.

My gate, `tests/e2e/premium-visual.spec.ts`: **4 passed** (28 captures).

Geometry, identical in all seven states and 53px at all four widths:

| width | header | dashboard row | cards | document overflow | sub-44px controls | overlaps |
| --- | --- | --- | --- | --- | --- | --- |
| 320x568 | 53 | 48 | 3 × 44 | 0px | none | none |
| 375x667 | 53 | 48 | 3 × 44 | 0px | none | none |
| 390x844 | 53 | 48 | 3 × 44 | 0px | none | none |
| 430x932 | 53 | 52 | 3 × 44 | 0px | none | none |

Painted contrast, read from laid-out elements with alpha composited against the real
stack (every one ≥ 4.5:1): title 18.69, status word 7.52, dashboard value 14.24,
dashboard sub-line 4.86 (the floor), warning notice 8.19, user bubble 14.24,
assistant prose 18.69, composer value 16.60.

Pre-existing gates: **38 passed, 1 failed** —
`round50-measure.spec.ts:217 "render cost of a 2000-row transcript with 50 tool
calls"`, expecting `> 100` mounted `.message-card, .activity-group` and receiving
**16** (15 with this layer disabled and not rebuilt). That test predates windowing
and asserts the *unwindowed* mount count; it is a `scroll-core` contract question,
not a paint regression, and its assertion was not touched. `round54-mobile-redesign`,
`files-center`, `sync-states-visual` and `screens` all passed.

`tests/web` unit suite: **105 files / 865 tests passed**.

## 0.4 The windowing change, checked against this layer

`MessageRow.tsx` now emits `.transcript-entries` > (`.transcript-entry`
`display:contents` | `.transcript-spacer`). This file styles neither, and contains no
`.messages-content > *`, no `.message-card` sibling rule and no `:first-child` /
`:last-child` rule anywhere. The only transcript-adjacent selector is the reading
rhythm, now scoped by surface (`.conversation-column`, `.agent-chat-scroll`,
`.history-reader` — see §0.5). So the spacers collapse exactly as rows do.

Measured, not assumed (300 entries, 320x568): 22 mounted cards = 1008px, 1 spacer =
12301px, 22 flex gaps × 10px = 220px → the `.transcript-entries` box is 13529px, and
`scrollHeight` is 13539px = that box plus the scroller's own 10px padding. Gap is
applied once per boundary including the spacer's, so the document height agrees with
the window's own offset arithmetic to the pixel (0px drift beyond the known padding).

Two new surfaces are styled here, in the same explicit-specificity style, because no
other owner claimed them and both looked unstyled against this palette:

- `.transcript-search` — `--chrome-bg` + hairline instead of `styles.css`'s raised
  `--surface` band; the field takes `--field-bg`/`--field-border` and the control
  radius at 1rem (iOS zoom floor); the count line stays `--text-muted` (6.38:1).
- `.conversation-column > .subagent-row` — the dashboard row's own gutter and the
  `--text-muted` hint colour. Its internals (`.subagent-row-head`, `-state`,
  `-label`, `-chevron`, `-hint`) belong to `tool-activity.css` and are untouched, so
  the two files cannot fight.


## 0.5 Reach after the adversarial review (W8 / W27 / W10)

`docs/audits/adversarial-review-round58.md` found that
`body .message-content:not(pre)` reached more than the conversation column.
`.message-content` is rendered by:

| surface | container | inside the conversation column? |
| --- | --- | --- |
| live transcript, saved transcript, streaming card, `AdvisorMessageCard` | `.conversation-column` | yes |
| one agent's own chat (`AgentDetail` → `AgentChat`) | `.agent-chat-scroll` | no |
| a saved session opened from History | `.history-reader` | no |

The rule is now three selectors naming those three surfaces, so the reach is
declared rather than incidental. The two non-conversation surfaces are named
deliberately: they are the same reading task at the same density, and leaving them
at the body's 1.5 while the conversation uses 1.55 would have been an accident of
scope. Their own line-height declarations (e.g. `.agent-chat-raw summary`) are more
specific or on different elements and are unaffected.

Two further clean-ups in the same file, both deletions rather than changes:

- `body .message-card.user { border-radius: var(--radius-message) }` was removed —
  `styles.css:943` already sets exactly that value, so the rule changed nothing.
- The three remaining unprefixed heads (`.conversation-column :focus-visible`,
  `.notice-banner .notice-text`, `.notice-row .notice-banner`) gained the `body`
  prefix, so the file's specificity claim is now uniformly true instead of true
  with three exceptions.

Confirmed still absent: no `!important`, no `display: none`, nothing that shrinks a
control below 44px, and no selector reaching Files Center, Agent Detail's own
chrome, Login or Settings. Every selector in the file now starts with `body`, apart
from `:root` and the `@media` wrapper.

## 1. Token table

Surfaces first, then text, then state. Every text token is listed with the surface
it is **actually painted on** and the measured WCAG 2.1 contrast there. Values are
new in this round; the ones inherited unchanged are marked *(inherited)* and their
values come from `styles.css:15-66`.

### 1.1 Surfaces

| Token | Value | Role |
| --- | --- | --- |
| `--chrome-bg` | `#050505` | canvas **and** the header/composer bars. New: chrome no longer gets its own lighter fill. |
| `--field-bg` | `#161616` | the one raised surface in the composer |
| `--field-border` | `#262626` | its hairline |
| `--hairline` | `#1f1f1f` | the 1px rule that separates chrome from canvas |
| `--app-bg` | `#050505` *(inherited)* | canvas / layer background |
| `--surface-primary` | `#1b1b1b` *(inherited)* | cards on the layers (Agents, Files, Activity) |
| `--surface-secondary` | `#242424` *(inherited)* | user bubble, dashboard card fill |
| `--surface-elevated` | `#292929` *(inherited)* | floating sheet, Latest button |
| `--surface-hover` | `#2f2f2f` *(inherited)* | pressed/hover fill |

### 1.2 Text — measured on its real surface

Every ratio below is computed in `tests/e2e/premium-visual.spec.ts` from the
browser's own computed colours (twice: once from the token table, once from the
laid-out element over its composited background). Floor is WCAG AA 4.5:1.

| Token | Value | Surface | Contrast |
| --- | --- | --- | --- |
| `--text-primary` | `#f5f5f5` *(inherited)* | `--chrome-bg` | **18.69:1** |
| `--text-primary` | `#f5f5f5` | `--field-bg` | **16.60:1** |
| `--text-primary` | `#f5f5f5` | `--surface-secondary` (bubble/card) | **14.24:1** |
| `--text-secondary` | `#a5a5a5` *(inherited)* | `--chrome-bg` | **8.27:1** |
| `--text-secondary` | `#a5a5a5` | `--surface-elevated` (sheet) | **5.91:1** |
| `--text-muted` | `#909090` *(inherited)* | `--chrome-bg` | **6.38:1** |
| `--text-muted` | `#909090` | `--field-bg` (composer placeholder) | **5.67:1** |
| `--text-muted` | `#909090` | `--surface-secondary` (dashboard sub-line) | **4.86:1** ← the floor |
| `--text-muted` | `#909090` | `--tv-inset` #0b0d11 (diff gutter) | **6.09:1** |
| `--text-muted` | `#909090` | `--surface-elevated` (sheet meta) | **4.56:1** |
| `--text-secondary` | `#a5a5a5` | 12% neutral tint (`#161616`, `.banner.unknown`) | **7.35:1** |
| `--text-faint` | `#777777` *(inherited)* | — | **ornament only**, never text: 3.85:1 on `#1b1b1b`, 4.18:1 on `#121212` |
| `--warning` | `#f59e0b` *(inherited)* | 12% warning tint over canvas (`#221706`) | **8.19:1** |
| `--danger-text` | `#f87171` *(inherited)* | 10% danger tint over canvas (`#1a0808`) | **7.02:1** |
| `--success` | `#22c55e` *(inherited)* | 10% success tint over canvas (`#08180e`) | **8.03:1** |
| `--primary` | `#4d94ff` *(inherited)* | 10% primary tint over canvas (`#08101c`) | **6.35:1** |
| white | `#ffffff` | `--primary-action` `#1f6feb` (Send fill) | **4.63:1** |
| status word `idle`/`running` | `color-mix(in oklab, #3fb950 72%, #909090)` = `rgb(103,176,74)` | `--chrome-bg` | **7.65:1** *(from `styles.css:1708`; unchanged this round)* |

Two usages were **wrong before this round** and are fixed here, both in the
"token is ornament-only, the usage was not" class:

- `.files-diff-gutter` (`files.css:296`) painted `--text-faint` as 0.78rem *text*
  on `--tv-inset`: 4.34:1. Now `--text-muted` (6.09:1); the hierarchy is unchanged
  because the code beside it is `--text-primary`.
- `.agent-chat-carry` (`agent-chat.css:137`) painted `--text-faint` as 0.8rem
  italic text on `--surface` (3.85:1). **Not changed in this round** — that file is
  not in this workstream's ownership and the element is a `role="note"` annotation
  rather than body copy. Recorded here as an outstanding defect for whoever owns
  `agent-chat.css`.

### 1.3 Type scale

| Token | Value | Used for |
| --- | --- | --- |
| *(none)* | — | the composer field deliberately stays `1rem`: iOS Safari zooms the viewport when a focused field is under 16px |
| `--fs-value` | `0.8rem` | dashboard card's primary line |
| `--fs-meta` | `0.72rem` | dashboard card's second line |
| `--fs-status` | `0.75rem` | header status dot + word + model |
| `--lh-prose` | `1.55` | message prose (`.message-content:not(pre)`), up from the inherited 1.5 |

Not changed: body `15px` (`styles.css:78`), the mono stack, the sans stack. The
round-57 captures show the *prose density* as the readable part of this app; this
spec does not touch it beyond a small line-height increase for long replies.

### 1.4 Spacing, radii, elevation

- Spacing: the app's existing 4/8/12/16/24 scale. `premium.css` declares only the
  three steps chrome consumes (`--sp-1..--sp-3`); the rest live in `styles.css`.
- Radii *(inherited, unchanged)*: card 16, message 18, composer 16, control 10.
- Elevation, one level:
  - `--elev-float`: `0 8px 24px rgba(0,0,0,0.55)` — overflow sheet, Latest button,
    bottom sheets. Value unchanged from `styles.css:1818`; now a token so the
    chrome states it once.
  - The sticky bars get **no shadow**: they sit on the canvas with a 1px
    `--hairline` rule instead. A shadow under a bar on a near-black canvas reads as
    a gradient smear, which is the opposite of "premium".
  - No coloured glow anywhere. A glow is decoration, and colour means state.

---

## 2. Composition

### 2.1 Header — 53 box px of chrome (52 content), at every width

| | before (measured in round-57 captures) | after (budget) |
| --- | --- | --- |
| chrome height | 56.0 css px, all four widths (measured from the captures) | **53 box px** = 44px control + 2×4px padding + 1px hairline (gate: ≤ 56) |
| fill | `#1b1b1b` plate | `#050505` canvas + 1px `--hairline` |
| content | ← · title / `● status · model` · chips · Stop · ⋯ | identical |

Composition at 320 / 375 / 390 / 430, left to right, one row, never wrapping:
back (44), title block (flex 1, ellipsised), status line under it inside the same
44px box (dot 6px + word + optional model), then the fixed action cluster
(chips ≤ 34vw at ≤480px, Stop 44x44 while running, ⋯ 44x44). The action cluster is
`flex: none`; everything that can shrink does, and it shrinks before the cluster.

What this deliberately keeps from round 54/57 (do not regress): the status dot +
word stays the *only* representation of idle/running; the model label stays hidden
≤480px with the full id on `title`/`aria-label`; Stop stays a translucent tinted
44x44 square outside the menu; chips stay bounded and hide below 360px.

**Stage-2 note:** §7 concludes the header needs **no JSX change at all**. The 56→53
height and the one-control reading both come from CSS + markup that already exists
(`.header-status` is already a flex row containing the dot and the word). Page on
`ConversationView.tsx` is not required for anything in this section.

### 2.2 Dashboard / navigation summaries — 44px, one row

The owner's complaint: *"the dashboard eats transcript space"*. The constraint
from the brief: **Agents, Files and Activity must stay reachable**.

Chosen presentation: keep three tap targets in one bounded row, **44px** each
(down from 56px), same information, same accessible names, same destinations. Row
height 44 + 8px gutter = **52px**, down from 64-72px. That is 12-20px of transcript
returned on every screen, without removing a single affordance. The gate allows 54
so a 1px border on the card cannot fail the build; the built value is 52.

Rejected alternatives, and why:

- *Fold the row into the overflow menu only.* Cheapest on pixels, but it makes
  three primary destinations two taps and hides them behind a glyph the owner has
  never used. §7.2 of round 54 already says each destination is duplicated in the
  menu for reachability — that stays, as the secondary path.
- *One segmented 44px strip ("Agents 12 · Files 3 · Activity").* Fewer pixels still,
  but each segment drops below 64px wide at 320px, which is under a comfortable
  thumb target and under the two-line information the cards carry.
- *Sticky/collapsing on scroll.* Adds scroll-position state, a height animation,
  and a class of bug (reacting to a scroll that another workstream is measuring).
  Not taken: the row scrolls away with the transcript today, and it must keep
  doing so.

At 320px each card is ~95px wide: `12 Agents` / `0 running · all-time` still lays
out on two lines, and the trailing qualifier ellipsises exactly as the round-57
capture shows. The full string is on the card's `aria-label`, so assistive tech
never sees the clip.

### 2.3 Composer — compact, one row, bottom-anchored

`--chrome-bg` background + hairline (was `--surface-primary` + border), field on
`--field-bg` with the composer radius, 8px padding, gap 8, Send a 44×44 icon
control. The placeholder is `--text-muted` on `--field-bg` = **5.67:1**. The field
grows to 140px then scrolls internally (unchanged). Safe-area bottom inset
preserved (a permanent `tests/web/touch-targets.test.ts` assertion).

### 2.4 Message chrome

- **User**: right-aligned bubble, `--surface-secondary` fill, no border,
  `--radius-message` 18px, `max-width: 85%`, `--text-primary` = **14.24:1**.
  Unchanged from round 54, and all of it already true in `styles.css:938-946` —
  this round adds **no rule** for the bubble. (It briefly had one; it re-declared
  the same radius and was deleted in the review pass, §0.5.)
- **Assistant**: no box, no border, no padding — `--text-primary` on the canvas at
  **18.69:1**, prose at `--lh-prose` 1.55. Unchanged except the rhythm, which is
  scoped per reading surface (`.conversation-column`, `.agent-chat-scroll`,
  `.history-reader`; §0.5).
- **Tool rows**: owned by another workstream. This spec asserts nothing about
  their look; it only requires that no chrome control overlaps them (§5).
- **Notices / banners**: one language. A tinted row in the level's own colour, a
  `--hairline`-free flat fill, the level's colour for the text, and — for
  `warning`/`error` only — a leading mark (`!` / `✕`) so the two are
  distinguishable without colour. The mark is **CSS generated content**
  (`::before` with `content: "!" / ""`), not a DOM node: it must not appear in the
  row's `textContent`, which `tests/web/mobile-reading-ux.test.tsx` compares to the
  host's message, and the `/ ""` alternative-text form keeps it out of the
  accessible name too. `info` stays a plain muted line with no mark. Each row keeps
  its own `role` (`status` / `alert`).

---

## 3. Running-state matrix

Eleven states. For each: what changes, and what must NOT change. "Legible" below
means the §4 invariants hold in that state — asserted for the seven states a mock
host can drive (`tests/e2e/premium-visual.spec.ts` `STATES`, captured to
`docs/audits/assets/round58/`); the other four are driven by existing specs and
their invariants are the same set.

| state | what changes | what must NOT change |
| --- | --- | --- |
| **idle** | status dot+word = green-mixed `idle`; no Stop; composer accepts input | the status line is the *only* idle representation (no banner); dashboard reachable; header ≤53px (asserted ≤54) |
| **streaming** | assistant row appears as chrome-free prose; header status `running`; Stop appears (44×44) | header height unchanged by Stop; the transcript keeps scrolling under the reader (no yank); composer stays enabled |
| **tool running** | a tool row/group appears in the transcript (another workstream's surface); assistant prose may continue above it | no chrome control overlaps the row; the transcript's usable height stays >100px; groups stay collapsed by default |
| **multiple subagents working** | the Vibe/agent count chips appear in the action cluster; Agents card's running count rises | chips stay ≤34vw and ellipsise before the title; the header still does not wrap; card count is never mistaken for live load (the `all-time` qualifier survives) |
| **results arriving** | new rows land at the tail; if the reader is detached, the Latest button floats | a detached reader's scroll position is not moved by an append; the Latest button never covers the composer or an approval (`bottom: safe + 84px`, unchanged) |
| **advisor verified issue** | the `Adv ⚠` chip appears in the action cluster for a *standing blocker* only | a count of historical notes does not produce a chip (round 57's rule); the chip hides below 360px; the Advisor panel stays reachable from the menu by name |
| **approval required** | the approval card renders in the transcript, focus-visible, with Approve/Deny/Cancel | it is **never** moved into a menu or the header; Deny is visually distinct from Approve; its tinted background keeps body text ≥4.5:1 (**17.36:1** measured) |
| **connection interrupted** | a `reconnecting`/`disconnected` banner row (tinted, level-coloured); composer disabled; Retry present | history is not deleted or greyed; the banner is not reported as `unknown`/`idle`; the transcript does not collapse; the composer's disabled state is honest, not merely dim |
| **transcript search open** | `.transcript-search` panel appears between the banners and the scroller; the transcript keeps a real viewport above the composer (150px at 320x568 — the smallest of any state) | the panel does not become a dialog and does not block the header; the result count is a polite live region; the field keeps `1rem`; the scroller still scrolls under it |
| **subagents working** | `.subagent-row` appears between the dashboard row and the transcript, in the dashboard's gutter, with one 44px tap to Agents | it renders **nothing** at zero running; it is not inside the transcript's window (it must not scroll away or be unmounted); the row does not disturb the dashboard's 3-column geometry |
| **read-only / view link** | Stop is absent, composer disabled, "Read-only view" banner present | Approve/Deny/Cancel are absent rather than present-and-inert; Copy/Dismiss stay available where they exist |

Colour is spent only on these states. There is no decorative hue in the chrome.

---

## 4. Acceptance criteria (all asserted numerically)

In `tests/e2e/premium-visual.spec.ts`, at **320x568, 375x667, 390x844, 430x932**,
for **idle, streaming, tool-running, approval, connection-lost, search,
subagents**:

1. `document.documentElement.scrollWidth - clientWidth <= 1` — no horizontal
   overflow.
2. `.app-header` `scrollWidth - clientWidth <= 1` — the header never overflows.
3. `.messages-scroll` height `> 100` — the transcript keeps a real viewport.
4. Every control inside the owned chrome is `>= 43.9` in **both** axes (43.9, not
   44, is the 2x-DPR subpixel of a genuine 44px box; recorded because a visual
   review once reported exactly 43.5 and "fixing" it would have been wrong).
5. No two laid-out controls overlap by more than 1px in both axes.
6. `.composer-container` does not extend past the viewport bottom, and its top is
   not above `.messages-scroll`'s bottom.
7. `.app-header` height **≤ 54** box px (design 53 = 44 control + 2×4 padding + 1px
   hairline). The brief's ceiling is 56; asserting 54 means a regression fails
   instead of hiding inside the slack.
8. `.dashboard-row` has **exactly 3** columns, each card ≤ 46px, row ≤ 54px.
9. Every text token in §1.2 `>= 4.5:1`, measured twice (token table, and
   computed-on-element with alpha compositing).
10. Notice rows keep their roles: `.notice-row--warning [role=status]`,
    `.notice-row--error [role=alert]`, the level mark comes from `::before`
    generated content so the row's `textContent` is still exactly the host's
    message, `info` has no mark, and a long notice's full text stays in the DOM.

These are permanent. **None of them may be weakened to make a future change pass.**

---

## 5. Files

| file | change |
| --- | --- |
| `apps/web/src/premium.css` | **new.** Tokens, typography, spacing, elevation, and the additive header/composer/dashboard/notice/message-chrome overrides, plus resting styles for the two surfaces the windowing change added (`.transcript-search`, the subagent roll-up's gutter and hint). All state-banner rules are scoped to `body .conversation-column ...`, which contains the header, dashboard, transcript, notices and the composer form — and excludes the overlay panels (siblings), the history view and the settings cards. |
| `apps/web/src/main.tsx` | one import line after `styles.css`. |
| `apps/web/src/components/DashboardCards.tsx` | comment only (the 320px behaviour is now stated where the string lives). No markup change. |
| `apps/web/src/components/NoticeRow.tsx` | **no change** (a comment was added and then reverted with the glyph: the level mark is CSS generated content in `premium.css`, so the component and its DOM text are untouched). |
| `apps/web/src/files.css` | `.files-diff-gutter` `--text-faint` → `--text-muted` (4.34:1 → 6.09:1). |
| `tests/e2e/premium-visual.spec.ts` | **new.** §4. |

Not touched, by instruction: `ConversationView.tsx`, `MessageRow.tsx`,
`ToolActivity.tsx`, `tool-activity.ts`, `transcript.ts`, the existing body of
`styles.css`. `agents.css` and `agent-chat.css` needed no token change (their
tokens come from `styles.css`); the one outstanding `agent-chat.css` defect is
recorded in §1.2 instead of being edited from here.

---

## 6. Known limits of this spec

- **No pixel gate.** Every claim here is DOM/computed-style. The PNGs are for
  human review; a claim that can only be made by looking at ink is not asserted.
- **The tool-activity surface is excluded** from the control scan (§4.4/5) by
  design — another workstream owns it, and a gate that fails on a control this
  change did not touch is a gate that would have to be weakened.
- **Physical iPhone** is still unverified (no device). Virtual keyboard, iOS tab
  eviction, and real safe-area insets on notched hardware are outside what a
  Chromium viewport can prove.
- **WebKit** cannot launch on this host (missing `libmanette-0.2-0`), so the
  `webkit` project is skipped. Real Safari is unverified.

---

## 7. Stage-2 patch plan — `ConversationView.tsx` (header + composer)

**Not applied.** `MessageRow.tsx` / `ConversationView.tsx` are `scroll-core`'s while
windowed rendering lands. Anchors are as the file stands (3399 lines, mtime
2026-11-06 20:00). Re-verify them after that workstream lands — line numbers will
have moved, the selectors and the *shape* of each change will not.

### 7.1 Header — conclusion: **zero JSX changes are required**

Everything the brief asks for at this anchor is achievable in CSS, and is already
written in `premium.css`:

| Requirement | Where it is satisfied | Needs `ConversationView.tsx`? |
| --- | --- | --- |
| header ≤ 56px, compact | `premium.css` `body .conversation-column > .app-header` (4px padding) + the existing 44px controls; computed 53px | **no** |
| one row, no wrap | existing `.app-header` flex row (`styles.css:432`), `.conversation-header-title` `flex:1 min-width:0` (447), `.conversation-header-actions` `flex:none` (466) | **no** |
| model id truncated with `title` | already there: `styles.css:137-149` (`.header-status-model`, `max-width:42%`, ellipsis) + `ConversationView.tsx:2536` already sets `title={reportedModel}` and `aria-label={`Model ${reportedModel}`}` | **no** |
| Stop control unchanged | `ConversationView.tsx:2590-2601`, `styles.css:1401-1407` + the ≤480px icon rules at `1738-1777` | **no** |
| status dot + word on one line | `.header-status` is already `display:flex; gap:6px` (`styles.css:1371-1380`) with the dot as a flex item at `2530-2531`; premium.css narrows the gap to 4px (`.header-status { gap: var(--sp-1) }`) | **no** |

The one change §2.1 previously held open — wrapping the dot and the word in a
`header-status-line` span — **is not needed and must not be applied**: flexbox is
already laying those two nodes out as siblings with a gap, so there is no collision
to fix, and a wrapper with no rule behind it is scaffolding. If a round-58 capture
ever shows the dot touching the word, the cause would be the gap, and the fix is the
gap value — not a new element.

**So the stage-2 header patch is: nothing.** Do not touch lines 2501-2543.

### 7.2 Composer — conclusion: **zero JSX changes are required**

| Requirement | Where it is satisfied | Needs JSX? |
| --- | --- | --- |
| field styling (`--field-bg`, `--field-border`, radius, placeholder) | `premium.css` `body .composer-input` + `::placeholder` | **no** |
| compact, one row, bottom-anchored | `premium.css` `body .composer-container` (8px padding, hairline, canvas background) | **no** |
| Send unchanged | `ConversationView.tsx:3265-3273` — 44×44, `aria-label="Send"`, white on `#1f6feb` at 4.63:1 | **no** |
| `sendError` banner reaches the new palette | it is a child of the `<form>`, which is a child of `.conversation-column`; every banner rule is scoped to that column | **no** |

Anchor for anyone verifying: `3239-3275` (`<form className="composer-container">`).
No line inside it changes.

### 7.3 If a later round ever DOES need JSX here

The only sanctioned shape is additive and must ship its CSS rule in the same
change. The header's dot and word are already flex siblings, so if they ever
collide the fix is `.header-status { gap }` in `premium.css` — **not** a wrapper
element. A wrapper with no rule behind it is scaffolding.

### 7.4 What stage 2 must NOT do

- Do not remove the three dashboard cards or their menu duplicates.
- Do not move the status word into a banner, or the banner back into the header.
- Do not put Stop inside the overflow menu, or an approval anywhere but the
  transcript.
- Do not delete the `all-time` qualifier or the `Adv` blocker rule.
- Do not add a DOM node for the notice level mark (see §2.4 — it is `::before`
  generated content, and a node there breaks
  `tests/web/mobile-reading-ux.test.tsx`).
- Do not wrap the header status dot/word in a new span; the existing flex gap is
  the mechanism, and it is already correct.
