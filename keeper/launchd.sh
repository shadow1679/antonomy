#!/bin/sh
# Run keeper/daemon.py as a macOS LaunchAgent, so it keeps making the keeper,
# cranker and agent calls after the terminal or Claude Code session is closed,
# and starts again at login. Testnet accounts below; override with env vars.
# The demo crew (keeper/demo.py: stakers, extra agents, a Recruit requester that
# asks twice) is on by default; run keeper/demo_setup.sh --send once to create
# and fund its accounts, or set ANTO_STAKERS="" ANTO_DEMO_AGENTS="" ANTO_REQUESTER=""
# to run without it.
#
#   keeper/launchd.sh install     write the plist, load it, start the daemon
#   keeper/launchd.sh uninstall   stop it and remove the plist
#   keeper/launchd.sh status      is it loaded; the last log lines
#
# Signing uses the NEAR CLI with the login keychain, so the Mac must be
# logged in (a sleeping Mac makes no calls; caffeinate keeps it awake).
set -eu

CONTRACT=${ANTO_CONTRACT:-antonomy-oracle.testnet}
# Space-separated: every allow-listed keeper this daemon signs for (each reads
# Polymarket on its own; the contract takes the quorum's median).
KEEPERS=${ANTO_KEEPERS:-"keeper.$CONTRACT keeper2.$CONTRACT keeper3.$CONTRACT"}
CRANKER=${ANTO_CRANKER:-cranker.$CONTRACT}
AGENT=${ANTO_AGENT:-agent.$CONTRACT}
# Demo crew, account[:style] space-separated (keep in step with demo_setup.sh).
STAKERS=${ANTO_STAKERS-"sugar1.$CONTRACT:follower sugar2.$CONTRACT:contrarian sugar3.sugar1.$CONTRACT:mixed"}
DEMO_AGENTS=${ANTO_DEMO_AGENTS-"agent2.sugar1.$CONTRACT:sharp agent3.sugar2.$CONTRACT:flat"}
REQUESTER=${ANTO_REQUESTER-"requester.$CONTRACT"}
INTERVAL=${ANTO_INTERVAL:-45}
# The NEAR CLI networks the calls sign through, in order: a call whose RPC
# fails goes to the next. Every near.org and fastnear testnet RPC shares one
# per-IP rate limit with the daemon's views, so dRPC comes first: a CLI network
# entry `testnet-drpc` with rpc_url https://near-testnet.drpc.org/ (copy
# `testnet-fastnear` in the CLI config). dRPC answers some cranks with
# "Internal server error", hence the fallbacks.
NETWORKS=${ANTO_NETWORKS:-"testnet-drpc testnet-fastnear"}

LABEL=com.antonomy.daemon
PLIST=$HOME/Library/LaunchAgents/$LABEL.plist
LOG=$HOME/Library/Logs/antonomy-daemon.log
DOMAIN=gui/$(id -u)
ROOT=$(cd "$(dirname "$0")/.." && pwd)

case "${1:-}" in
install)
  KEEPER_ARGS=
  for k in $KEEPERS; do
    KEEPER_ARGS="$KEEPER_ARGS<string>--keeper</string><string>$k</string>"
  done
  CREW_ARGS=
  for k in $STAKERS; do
    CREW_ARGS="$CREW_ARGS<string>--staker</string><string>$k</string>"
  done
  for k in $DEMO_AGENTS; do
    CREW_ARGS="$CREW_ARGS<string>--demo-agent</string><string>$k</string>"
  done
  [ -z "$REQUESTER" ] || CREW_ARGS="$CREW_ARGS<string>--requester</string><string>$REQUESTER</string>"
  NETWORK_ARGS=
  for n in $NETWORKS; do
    NETWORK_ARGS="$NETWORK_ARGS<string>--network</string><string>$n</string>"
  done
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
    $KEEPER_ARGS
    <string>--cranker</string><string>$CRANKER</string>
    <string>--agent</string><string>$AGENT</string>
    $CREW_ARGS
    <string>--interval</string><string>$INTERVAL</string>
    $NETWORK_ARGS
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
