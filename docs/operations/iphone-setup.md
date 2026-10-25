# iPhone setup and daily use

The phone is a controller. It never holds credentials beyond a session cookie,
and it never stores a room link.

## 1. Private network access (Tailscale)

```bash
tailscale status                      # confirm you are logged in and up
tailscale status --json | grep DNSName # your machine's tailnet name
```

Install Tailscale on the iPhone and log into the same tailnet. Then, on the
laptop, let the app be reachable inside the tailnet over HTTPS — this is also
what makes WebCrypto available to the browser, which the live session transport
requires:

```bash
# one-time: allow your user to manage Serve without sudo
sudo tailscale set --operator=$USER

# put the app behind TLS on the tailnet (the app itself stays on loopback)
tailscale serve --bg --https=443 http://127.0.0.1:8791
tailscale serve status
```

Open `https://<machine>.<tailnet>.ts.net/` on your phone.

Make sure `publicOrigin` in `caw.config.json` (or `CAW_PUBLIC_ORIGIN`) matches this
exact origin (`https://<machine>.<tailnet>.ts.net`). The server uses this to mint
live-session deep links that point at your Serve endpoint rather than internal loopback.

**The relay port must never be proxied.** The app listens on `8791` and the private
Collab relay listens on `8792`. Only `8791` goes through Serve. The relay's host
endpoint — the one our own agents connect to — is deliberately reachable only from
loopback, because `tailscale serve` rewrites the peer address of every remote caller
to loopback, which means a proxied relay would let anyone on the tailnet claim the
host role of a room. Serving `8792` as well would silently reopen that hole:

```bash
# WRONG — never do this
tailscale serve --bg --https=8443 http://127.0.0.1:8792
```

Guests (your phone) reach rooms through the app's origin, which is why one `serve`
rule is enough.

**Never use `tailscale funnel`.** Funnel publishes to the public internet; this
app is a remote-control surface for a shell on your laptop.

## 2. Install as an app (PWA)

1. Open the URL in **Safari** (not Chrome — iOS installs PWAs only from Safari).
2. Share → **Add to Home Screen**.
3. Launch it from the Home Screen.

Launching from the Home Screen gives you: no browser chrome, a persistent
session cookie, and — importantly on iOS — storage that is not evicted on the
7-day timer Safari applies to ordinary sites.

## 3. Sign in

Enter your password once. The session cookie is `__Host-`, Secure, HttpOnly and
SameSite=Lax, which means it is not readable by scripts and not sent on
cross-site requests. Sessions last 30 days by default and can be revoked from
the app's settings screen (or by deleting the state directory on the laptop).

## 4. Daily use

| Goal | Steps |
| --- | --- |
| Start a new chat | Projects → pick a project → **New chat** → type → send |
| Continue a CLI chat | Project → the native sessions list → pick the session → **Resume** |
| Join something already running | Project → conversation list → a conversation with a live badge → open |
| Watch a long task and leave | Send the prompt, then simply close Safari. The agent keeps running. |
| Stop an agent | **Stop** in the conversation header (sends an interrupt, not a kill) |
| Inspect subagents | The subagents panel in the conversation; tap one for its transcript |
| Approve a tool call | A question card appears; approve or reject. If it times out, the request is refused rather than silently allowed. |
| Take over on the laptop | Conversation → **How to attach** → copy the private-socket `tmux -S ... attach` command and run it in a terminal |

### Behaviour you should expect

- **Closing Safari does not stop the agent.** It detaches your viewer. The
  process keeps its tmux session.
- **The phone going to sleep may drop the live connection.** On return the app
  reconnects and re-syncs from the agent, rather than replaying a stale buffer.
  A dropped connection is reported as disconnected — never as "the agent
  finished".
- **`idle` means "no turn in flight right now"**, not "the work is done". OMP
  reports a turn boundary, and the agent may still be waiting on a queued
  follow-up or background job.
- **Only one writer per session.** If you open the same conversation on the
  laptop with OMP's own CLI, the app will refuse to start a competing process
  and tell you why rather than forking your history.

## 5. Rotating access

```bash
# laptop: revoke every active session cookie at once (sessions are held in memory)
systemctl --user restart coding-agent-web

# to reset the password and generate a fresh one-time setup token on next boot:
systemctl --user stop coding-agent-web
rm ~/.local/state/coding-agent-web/auth-password.json
systemctl --user start coding-agent-web
```

To remove phone access entirely: `tailscale serve reset` (ends tailnet access),
or remove the device from your tailnet. Deleting the Home Screen app clears its
local storage but is not by itself a security control — revoke on the laptop.

## 6. What cannot be verified without a physical iPhone

Automated browser tests run at iPhone viewport sizes, but they are not iOS
Safari. These behaviours were designed for and must be confirmed by hand on a
real device the first time you set this up:

- the software keyboard not covering the composer (safe-area + `visualViewport`);
- scrolling a long transcript while streaming, without scroll jumps;
- reconnecting after the phone suspends the tab for several minutes;
- the PWA launching standalone with correct safe-area insets on a notched device.
