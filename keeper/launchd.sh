#!/bin/sh
# Run keeper/daemon.py as a macOS LaunchAgent, so it keeps making the keeper,
# cranker and agent calls after the terminal or Claude Code session is closed,
# and starts again at login. Testnet accounts below; override with env vars.
#
#   keeper/launchd.sh install     write the plist, load it, start the daemon
#   keeper/launchd.sh uninstall   stop it and remove the plist
#   keeper/launchd.sh status      is it loaded; the last log lines
#
# Signing uses the NEAR CLI with the login keychain, so the Mac must be
# logged in (a sleeping Mac makes no calls; caffeinate keeps it awake).
set -eu

CONTRACT=${ANTO_CONTRACT:-antonomy-oracle.testnet}
KEEPER=${ANTO_KEEPER:-keeper.$CONTRACT}
CRANKER=${ANTO_CRANKER:-cranker.$CONTRACT}
AGENT=${ANTO_AGENT:-agent.$CONTRACT}
INTERVAL=${ANTO_INTERVAL:-45}
# The NEAR CLI network the cranks sign through. Every near.org and fastnear
# testnet RPC shares one per-IP rate limit with the daemon's views, so the
# signing goes to dRPC: a CLI network entry `testnet-drpc` with rpc_url
# https://near-testnet.drpc.org/ (copy `testnet-fastnear` in the CLI config).
NETWORK=${ANTO_NETWORK:-testnet-drpc}

LABEL=com.antonomy.daemon
PLIST=$HOME/Library/LaunchAgents/$LABEL.plist
LOG=$HOME/Library/Logs/antonomy-daemon.log
DOMAIN=gui/$(id -u)
ROOT=$(cd "$(dirname "$0")/.." && pwd)

case "${1:-}" in
install)
  mkdir -p "$HOME/Library/LaunchAgents" "$HOME/Library/Logs"
  cat > "$PLIST" <<PL
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>$LABEL</string>
  <key>ProgramArguments</key><array>
    <string>/usr/bin/caffeinate</string><string>-i</string>
    <string>/usr/bin/python3</string><string>-I</string><string>$ROOT/keeper/daemon.py</string>
    <string>--contract</string><string>$CONTRACT</string>
    <string>--keeper</string><string>$KEEPER</string>
    <string>--cranker</string><string>$CRANKER</string>
    <string>--agent</string><string>$AGENT</string>
    <string>--interval</string><string>$INTERVAL</string>
    <string>--network</string><string>$NETWORK</string>
    <string>--send</string>
  </array>
  <key>WorkingDirectory</key><string>$ROOT</string>
  <key>EnvironmentVariables</key><dict>
    <key>PATH</key><string>$HOME/.cargo/bin:/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin</string>
  </dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>ThrottleInterval</key><integer>30</integer>
  <key>StandardOutPath</key><string>$LOG</string>
  <key>StandardErrorPath</key><string>$LOG</string>
</dict></plist>
PL
  launchctl bootout "$DOMAIN/$LABEL" 2>/dev/null || true
  launchctl bootstrap "$DOMAIN" "$PLIST"
  echo "installed $PLIST; log: $LOG"
  ;;
uninstall)
  launchctl bootout "$DOMAIN/$LABEL" 2>/dev/null || true
  rm -f "$PLIST"
  echo "removed $LABEL"
  ;;
status)
  launchctl print "$DOMAIN/$LABEL" 2>/dev/null | grep -E "state|pid|last exit" || echo "not loaded"
  tail -n 15 "$LOG" 2>/dev/null || true
  ;;
*)
  echo "usage: $0 install|uninstall|status" >&2
  exit 2
  ;;
esac
