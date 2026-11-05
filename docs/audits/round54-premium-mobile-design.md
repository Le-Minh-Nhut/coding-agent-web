# Round 54 — premium mobile conversation redesign (spec, defects, measurements)

Scope: `apps/web` only. No backend, no contracts, no lifecycle change — this round
changes *presentation* and the two confirmed layout defects.

## 1. Reference analysis (from the brief; the screenshot itself was not available)

Near-black canvas, one compact header row, a small green running dot, subtle
model/status metadata, three compact navigation cards, a rounded right-aligned
user bubble, auto-collapsing long prompts, minimal assistant chrome, collapsible
tool activity, dedicated subagent screens, and a fixed compact composer.

Three of those requirements are really *anti-requirements*, and they drive the
whole design:

- **nothing permanently visible except what the user acts on** — hence level-based
  notice rendering rather than a banner per event;
- **subtraction, not addition** — hence the removal of the bordered card around
  every assistant reply and the removal of the full-text refusal banners;
- **colour means state**, never decoration — green = running/ok, amber = warning,
  red = danger/actionable. No bright blue full-width bar for a routine event.

## 2. Existing UI weaknesses, with evidence

| # | Weakness | Evidence |
| --- | --- | --- |
| W1 | A refused/unconfirmed prompt rendered its **complete** text as a full-width banner *outside* `.messages-scroll`, inside `.conversation-screen { height:100dvh; overflow:hidden }`. A long prompt consumed the viewport and the transcript became unreachable until reload. | `ConversationView.tsx` (old `refusedRecoveries.map(...)` block), `styles.css:96-103` (`.conversation-screen`), `styles.css:105` (`.app-header` sibling flow) |
| W2 | `AgentsCenter`/`AgentDetail` rendered as siblings **after** the composer inside `.conversation-screen`, so they competed with the chat layout and the composer stayed visible underneath them. No history entry: the browser's Back left the app. | `ConversationView.tsx` (old `agentNav.open && (…)` after the composer form) |
| W3 | A routine `info` notice ("Mobile Web Controller joined the collab session") painted a full-width blue banner. Host emits it per join/leave/interrupt. | upstream `packages/coding-agent/src/collab/host.ts:846`; `transcript.ts` `applyEvent` notice branch; `.banner.info` in `styles.css` |
| W4 | Every assistant reply carried a bordered card + a capitalized role label: the largest avoidable source of vertical noise in a long transcript. | `styles.css` `.message-card`/`.message-card.assistant`; `ConversationView.tsx` `MessageRow` role div |
| W5 | The recovery list was in-memory only, so a **page reload destroyed the only copy** of an unacknowledged prompt. | `docs/architecture/prompt-state-and-retention-contract.md:17`; no `localStorage`/`sessionStorage`/IndexedDB anywhere in `apps/web/src` |
| W6 | The recovery list was unbounded on the web path while the guest client enforces 256 records / 1 MiB. | `packages/guest/src/lib/client.ts:147,149` |

## 3. Token system

Declared in `:root` (`apps/web/src/styles.css`), with the measured contrast each
token actually needs. Legacy names are kept as aliases so no component had to
learn a new vocabulary in the same commit.

| Token | Value | Measured on its real surface |
| --- | --- | --- |
| `--app-bg` | `#050505` | canvas |
| `--surface-primary` | `#1b1b1b` | `--text-primary` 15.8:1 |
| `--surface-secondary` | `#242424` | `--text-secondary` 6.3:1 |
| `--surface-elevated` | `#292929` | `--text-muted` 4.56:1 |
| `--text-primary` | `#f5f5f5` | 13.3:1 worst case |
| `--text-secondary` | `#a5a5a5` | 5.91:1 worst case |
| `--text-muted` | `#909090` | 5.4:1 on `--surface-primary`, 4.56:1 elevated |
| `--text-faint` | `#777777` | ornament only (dots/hairlines); as text it is 3.85:1 — **not** used for text |
| `--border-subtle` | `#292929` | — |
| `--success` | `#22c55e` | 7.56:1 on surface |
| `--danger` (fill) | `#dc2626` | white on it 4.83:1 |
| `--danger-text` | `#f87171` | 5.61:1 on `--surface-secondary` |
| `--warning` | `#f59e0b` | 8.02:1 on surface |
| radii | card 16 / message 18 / composer 16 / control 10 | `--radius-*` |

Two departures from the brief's starting values, both forced by AA:
`--text-muted` `#777777 → #909090` (3.85:1 → 5.4:1 on the primary surface, which is
where body-size muted copy sits), and `--danger` `#ef4444 → #dc2626` as a **fill**
(white on `#ef4444` is only 3.76:1). The brief's `#777777` survives as
`--text-faint`, restricted to non-text ornament.

`safe-area-*`, `--touch-min: 44px`, and the mono/sans stacks are unchanged.

## 4. Component hierarchy

```
App
└── ConversationView
    ├── .conversation-column                 (inert while the layer is open)
    │   ├── ConversationHeader (inline JSX)  ← back, title, status line (+model), Stop, ⋯
    │   ├── DashboardCards                    ← 3 nav summaries, 56px
    │   ├── recovery summary row (one row)    ← count only
    │   ├── status banners (actionable only)
    │   ├── NoticeRow                         ← one protocol notice, level-clamped
    │   └── .messages-scroll
    │       ├── TranscriptList → MessageRow | ActivityGroupRow
    │       └── approval card
    ├── .latest-row (floating)
    ├── composer-container
    ├── .agents-layer                         ← fixed inset:0, own scroll
    │   └── AgentsCenter | AgentDetail | "Agent unavailable"
    ├── RecoverySheet (ModalOverlay)          ← full prompt text + controls
    ├── ActivityPanel / AdvisorPanel / VibePanel / model sheet
```

New files: `components/DashboardCards.tsx`, `components/RecoverySheet.tsx`,
`components/NoticeRow.tsx`, `prompt-recovery.ts`.

## 5. Navigation architecture

Conversation → Agents Center → Agent Detail is three levels in one viewport.

- Only the active screen occupies the content viewport: the layer is
  `position: fixed; inset: 0; z-index: 60; background: var(--app-bg)` with its own
  scroll container (``.agents-center, .agent-detail { flex: 1 1 auto; overflow-y: auto }`).
- The conversation is **never unmounted** while the layer is open — the socket,
  transcript, draft and scroll position all survive. It is marked `inert`, which
  removes it from both the accessibility tree and tab order (not `aria-hidden`,
  which would leave focusable descendants reachable).
- History: opening the list pushes `{cawAgents:"list"}`, opening a detail pushes
  `{cawAgents:"detail", id}`. A single `popstate` listener (installed once, removed
  on unmount) maps state back onto `agentNav`. In-app Back controls apply the state
  **synchronously** and then retire their own entry only when `history.state` shows
  one is ours — so a Back the browser already consumed cannot navigate the user out
  of the app.
- No second socket, no remount, no listener accumulation.
- Agent disappearance keeps the existing "Agent unavailable" honesty; detail
  `onBack` returns to the list; the filter is component state that survives Back.

## 6. Layout — mobile and desktop

| Element | Geometry |
| --- | --- |
| header | one row, `padding: safe-top+6 / 6`, 44px controls; measured ≤ 90px (claim), typically ~56px |
| dashboard row | `grid-template-columns: repeat(3, …)`, cards fixed **56px**; below 359px → 2 columns |
| recovery summary | fixed **44px**, one line, ellipsis |
| transcript | `flex: 1 1 0; height: 0; min-height: 0; overflow-y: auto` — the free height |
| composer | single-line textarea (min 44, max 140 then internal scroll) + 44px icon send; bottom safe-area inset |
| recovery sheet | bottom-anchored, `max-height: 85dvh`, own scroll |
| agents screen | full viewport (`inset: 0`), own scroll; **no composer on screen** |
| notice row | 1 rendered line for `info`, 2 for `warning`/`error`, + optional `Show more` |

Desktop (>900px) is the same single column centered by `#root { max-width: 900px }`;
nothing depends on hover width.

## 7. Interaction states

- Connection: `connecting` → spinner row; `idle`/`running` → header only (no
  banner); `reconnecting`/`disconnected`/`unknown`/retired room/link failure/approval
  pending/read-only → banners stay, because each is actionable.
- Composer disabled for readOnly / disconnected / unknown / connecting /
  reconnecting; draft ownership unchanged (`App` owns drafts, `onDraftChange`).
- Recovery: `Unconfirmed` / `Echoed` / `Refused`, each with its own explanation;
  Copy always, Recover only while the composer is writable, Dismiss always. Never
  auto-resend.
  - **m9 — deliberate tightening.** The old inline strip gated Recover on
    `canWriteToHost && !linkUnavailable`; the sheet adds `&& !transcript.readOnly`.
    That is stricter and correct: the strip's own comment says a Recover must never
    overwrite the App-owned draft, and a read-only view cannot write to the
    composer at all — so the control is absent rather than present-and-inert. Copy
    and Dismiss stay available, so the text is never stranded.
- Retention ceiling (B1): reaching 256 records / 1 MiB refuses a *voluntary*
  retention and says so in the composer's status area ("Not retained: … the prompt
  stays in the composer"). It must never drop a record whose only remaining copy
  is being cleared, because that eviction is the data loss this list exists to
  prevent — the promote/late-echo/recover paths therefore retain past the ceiling.
- Capacity note: rendered as a **sibling of the composer form**, so a refusal is
  visible in read-only and saved mode too, and cleared by a new draft, a send, and
  a conversation switch.
- Agents layer: Back returns to the conversation; the pushed history entry names
  its conversation, so an entry surviving a switch cannot re-open the wrong
  conversation's layer; closing restores focus to a real control (never `body`).
- Tool activity: `✓` completed, `○` running, `✕` failed, expandable; per-file rows
  keep real counts and their own expansion.
- Notices: `info` muted line, `warning` warning row, `error` alert row; all expand.

## 8. Accessibility

Touch targets ≥ 44px (unchanged global rule); accessible names on every icon
button (`Back`, `More actions`, `Send`); `role="status"` only where state genuinely
changes (header status line, banners, notices) and `role="alert"` for a failure;
`ModalOverlay` supplies focus trap + Escape for the sheet; `inert` instead of
`aria-hidden` on covered content; disclosure stays plain buttons (no fake
`role="menu"`); the dashboard is a named `role="group"`.

## 9. Measurable acceptance criteria

- header ≤ 90px tall at every viewport, no horizontal document overflow at 320px;
- dashboard row bounded (each card ≤ 64px, row ≤ 72px);
- recovery summary row ≤ 64px for 1 and for 3 long records;
- transcript scroll region remains scrollable and usable with the summary present;
- agents screen covers 100% of the viewport and the composer is not in the DOM
  subtree rendered for it (`boundingBox()` of `.composer-container` clipped / layer
  top = 0 and bottom = viewport height);
- composer fully inside the viewport, bottom-anchored, safe-area inset respected;
- all named tokens resolve to their specified values via `getComputedStyle`.

Pixel acceptance is **not** claimed by this round's author — see the report; a
separate verification pass owns pixel review.
