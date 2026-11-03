#!/usr/bin/env bash
set -euo pipefail
unit=coding-agent-web.service
unit_file=${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user/$unit
dry=0; yes=0
for arg in "$@"; do case $arg in --dry-run) dry=1;; --yes) yes=1;; *) echo 'Usage: uninstall.sh [--dry-run] [--yes]' >&2; exit 2;; esac; done
if ((dry)); then printf 'Would stop and disable %s and remove only %s\n' "$unit" "$unit_file"; exit 0; fi
if ((!yes)); then [[ -t 0 ]] || { echo 'Non-interactive use requires --yes.' >&2; exit 2; }; read -r -p "Remove $unit and its rendered unit file? Application and agent data will remain. [y/N] " answer; [[ $answer == [yY] || $answer == [yY][eE][sS] ]] || { echo 'Cancelled.'; exit 0; }; fi
systemctl --user disable --now "$unit" || true
if [[ -f $unit_file ]]; then rm -- "$unit_file"; fi
systemctl --user daemon-reload
printf 'SUCCESS: removed unit; application source, config, state, agents, history and Tailscale configuration untouched.\n'
