# Verified vertical slice (M0 proof of concept)

Recorded because these are the observations the architecture decision rests on.
All of it was run on this machine against OMP 18.12.2 with a real agent.

## Setup used

- Private relay: a ~120-line Node relay binding `127.0.0.1:7478`, speaking the
  published contract (upgrades `/r/<roomId>?role=host|guest`, forwards sealed
  frames, rewrites the 4-byte peer prefix on guest egress).
- Agent host: `tmux new-session -d -s <name> -c <project> "omp --config=<overlay>"`
  where the overlay sets `collab.autoStart: control` and
  `collab.relayUrl: ws://localhost:7478`.
- Browser: Chromium at a 390×844 iPhone viewport loading the deep link
  `<webOrigin>/#<relayLink>`.

## Results

| # | Claim | Observation |
| --- | --- | --- |
| 1 | A tmux-hosted OMP hosts itself | `omp collab list --json` reported the host with `relayConnected: true`, `access: "control"` |
| 2 | A private relay replaces the hosted one | The registry row showed `relayConnected: true` against `ws://localhost:7478`; the relay logged `host joined <roomId>` |
| 3 | A browser guest can drive the agent | Prompt typed in the browser composer produced the agent reply `BROWSER-OK` in the live transcript (screenshot) |
| 4 | A terminal attaches to the same process | `tmux capture-pane` on the host showed the same `guest`-attributed prompt and the same reply |
| 5 | Resume of an existing native session works under our launcher | `omp --config <overlay> --resume <journal>` inside tmux published a second registry row serving session `01a16ecf…` with `relayConnected: true` |
| 6 | Two conversations run independently | Two registry rows alive at once: instances for sessions `01a16ed6…` and `01a16ecf…`, each with its own tmux session |
| 7 | **Closing the browser does not stop the agent** | Browser page closed while `busy: true`; the agent continued and completed a 25-line response with **no viewer attached** |
| 8 | **A fresh browser session adopts the same agent** | A new page loaded at the same deep link showed the full transcript including the output produced while no browser existed; no prompt was resubmitted |
| 9 | A second writer does not corrupt the session | A second process opening a live session forked to a new journal (`parentSession` set) instead of interlacing writes |
| 10 | Liveness is externally observable | The lease socket name for a live session was reproduced independently and matched an entry in `/proc/net/unix` |

## What this does not prove

- That *our* UI (not the upstream one) drives agents — that is the M3 acceptance
  test for `apps/web` + `packages/collab-protocol`.
- Anything about iOS Safari itself: the browser used here is Chromium with a
  mobile viewport. Software-keyboard, safe-area and tab-suspension behaviour
  still needs a physical iPhone.
- Behaviour under a restart of the app server mid-turn (M2 reconciliation test).
- Approval (`ui-request`) handling against a host that genuinely asks a question.
