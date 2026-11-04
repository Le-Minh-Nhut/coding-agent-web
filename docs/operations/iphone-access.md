# iPhone access

## Access URL

[https://heheboiz-legion-5-15arh7.tail8d8eff.ts.net/](https://heheboiz-legion-5-15arh7.tail8d8eff.ts.net/) is the app's Tailscale Serve URL. It is tailnet-only, never public.

## Verification

Verified from the laptop on 2026-11-04:

- HTTPS `GET /` returns 200; `GET /api/auth/me` returns 401, as expected when unauthenticated.
- The exact hostname has a TLS certificate issued by Let's Encrypt.
- The Collab guest-path WebSocket upgrade works identically through Serve and on loopback.
- A foreign `Origin` is rejected with 403.
- Serve proxies the app at `127.0.0.1:8791`; private host relay at `127.0.0.1:8792` is not exposed. Funnel is off.

Access from an actual iPhone/Safari device has **not** been verified.

## Open on iPhone

Sign in to the same tailnet: Tailscale must be connected on both devices, with the phone signed into the same account. Open the URL above in Safari. The session cookie is `Secure`, so use HTTPS only; plain `http://` variants will not work. Do not add a port suffix.

If you have the password, log in with it. If not, follow [I lost my password](recovery.md#i-lost-my-password): remove the credential record and restart the service, then read the one-time setup token from the path the app printed (`~/.local/state/coding-agent-web/setup-token`) and paste it at the login screen to set a new password. The token is single-use and expires after a short time.

For network setup details, see [iPhone setup and daily use](iphone-setup.md). See also [deployment](deployment.md).

## Troubleshooting

- **URL unreachable from phone:** Check that Tailscale is connected on both devices and that the phone is on the same tailnet: `tailscale status`.
- **Serve mapping missing or wrong:** `tailscale serve status` must show `https://heheboiz-legion-5-15arh7.tail8d8eff.ts.net (tailnet only)` with `|-- / proxy http://127.0.0.1:8791`. Restore with `tailscale serve --bg --https=443 http://127.0.0.1:8791`. This requires the one-time `sudo tailscale set --operator=$USER` grant documented in [iPhone setup and daily use](iphone-setup.md).
- **502/503 from URL:** The backend is down. Check `systemctl --user status coding-agent-web.service` and `journalctl --user -u coding-agent-web.service -n 100 --no-pager`.
- **Login rejected:** See [I lost my password](recovery.md#i-lost-my-password).

Last verified: **2026-11-04**, from the host over the tailnet, not from a phone.
