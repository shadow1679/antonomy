#!/bin/sh
# One-time (and safe to repeat) setup for the demo crew that keeper/daemon.py
# runs with --staker, --demo-agent and --requester (keeper/demo.py): creates
# the persona accounts, with a key in the macOS keychain, tops up their NEAR
# for gas and their play tokens, and leaves accounts that are already funded
# alone.
#
#   keeper/demo_setup.sh          show what it would do
#   keeper/demo_setup.sh --send   do it
#
# Where the funds come from (testnet only):
#   NEAR        the cranker account, which holds the daemon's gas money. Each
#               persona needs roughly 0.1 to 0.4 NEAR a day while the crew runs,
#               so the defaults give 2 NEAR each and a child account 1 NEAR.
#   $ANTO       the treasury (`ft_transfer`).
# The contract account is never asked for NEAR: most of its balance is locked
# as the contract's storage. A persona that is a sub-account of another persona
# is created by that parent; any other `x.testnet` name would need the CLI's
# faucet service, which rate-limits (HTTP 429).
#
# Override with env vars: ANTO_CONTRACT, ANTO_NETWORK (the CLI network used for
# setup), ANTO_FUNDER (pays the NEAR), ANTO_STAKERS / ANTO_DEMO_AGENTS /
# ANTO_REQUESTER (account:style, space-separated; keeper/launchd.sh reads the
# same variables, so the two always agree). List a parent before its children.
set -eu

CONTRACT=${ANTO_CONTRACT:-antonomy-oracle.testnet}
NETWORK=${ANTO_NETWORK:-testnet-fastnear}
FUNDER=${ANTO_FUNDER:-cranker.$CONTRACT}
TREASURY=${ANTO_TREASURY:-treasury.$CONTRACT}
STAKERS=${ANTO_STAKERS:-"sugar1.$CONTRACT:follower sugar2.$CONTRACT:contrarian sugar3.sugar1.$CONTRACT:mixed"}
DEMO_AGENTS=${ANTO_DEMO_AGENTS:-"agent2.sugar1.$CONTRACT:sharp agent3.sugar2.$CONTRACT:flat"}
REQUESTER=${ANTO_REQUESTER:-requester.$CONTRACT}
NEAR_EACH=2                            # whole NEAR a persona should hold
NEAR_PARENT=5                          # whole NEAR a persona that creates accounts should hold
NEAR_CHILD=1                           # NEAR a new child account starts with
STAKER_ANTO=250                        # play tokens to hold: stakes plus headroom
AGENT_ANTO=40                          # the 10 deposit and some spare
REQUESTER_ANTO=250                     # two requests at 100 each, and spare
SEND=0
[ "${1:-}" = "--send" ] && SEND=1

root=$(cd "$(dirname "$0")/.." && pwd)

run() {
  if [ "$SEND" = 1 ]; then "$@"; else echo "dry: $*" >&2; fi
}

# What the chain says about an account, over JSON-RPC with a fallback: for
# `near`, "missing" or its whole NEAR; for `anto`, its whole play tokens. Both
# RPCs down is not an answer: it fails instead of guessing.
chain() {
  python3 -I -c '
import base64, json, sys, urllib.request
what, acct, contract = sys.argv[1:4]
def rpc(params):
    for url in ("https://near-testnet.drpc.org", "https://test.rpc.fastnear.com"):
        body = json.dumps({"jsonrpc": "2.0", "id": "x", "method": "query", "params": params}).encode()
        req = urllib.request.Request(url, body, {"content-type": "application/json", "user-agent": "antonomy/0"})
        try:
            return json.load(urllib.request.urlopen(req, timeout=20))
        except OSError:
            continue
    sys.exit("RPCs down")
if what == "near":
    out = rpc({"request_type": "view_account", "finality": "final", "account_id": acct})
    res = out.get("result") or {}
    if "amount" in res:
        print(int(res["amount"]) // 10**24)
    elif "UnknownAccount" in json.dumps(out) or "does not exist" in json.dumps(out):
        print("missing")
    else:
        sys.exit("cannot read %s: %s" % (acct, json.dumps(out)[:200]))
else:
    out = rpc({"request_type": "call_function", "finality": "final", "account_id": contract,
               "method_name": "ft_balance_of",
               "args_base64": base64.b64encode(json.dumps({"account_id": acct}).encode()).decode()})
    print(int(json.loads(bytes(out["result"]["result"]))) // 10**24)
' "$1" "$2" "$CONTRACT"
}

top_up_near() {  # account, whole NEAR it should hold at least
  have=$(chain near "$1")
  if [ "$have" -lt "$2" ]; then
    echo "$1 holds $have NEAR, sending $(($2 - have))" >&2
    run near tokens "$FUNDER" send-near "$1" "$(($2 - have)) NEAR" network-config "$NETWORK" sign-with-keychain send
  fi
}

top_up_anto() {  # account, whole $ANTO it should hold at least
  have=$(chain anto "$1")
  if [ "$have" -lt "$2" ]; then
    echo "$1 holds $have \$ANTO, sending $(($2 - have))" >&2
    run near contract call-function as-transaction "$CONTRACT" ft_transfer \
      json-args "{\"receiver_id\":\"$1\",\"amount\":\"$(($2 - have))$(printf '%024d' 0)\"}" \
      prepaid-gas '30.0 Tgas' attached-deposit '1 yoctoNEAR' \
      sign-as "$TREASURY" network-config "$NETWORK" sign-with-keychain send
  fi
}

ensure() {  # account, whole $ANTO it should hold
  acct=$1
  if [ "$(chain near "$acct")" = missing ]; then
    parent=${acct#*.}
    if [ "$parent" = "$CONTRACT" ]; then
      echo "$acct: refusing to spend the contract account's NEAR" >&2
      exit 1
    elif [ "$parent" = testnet ]; then
      echo "$acct is a top-level name: it needs the CLI faucet service (rate-limited)" >&2
      run near account create-account sponsor-by-faucet-service "$acct" \
        autogenerate-new-keypair save-to-keychain network-config testnet create
    else
      top_up_near "$parent" "$NEAR_PARENT"
      run near account create-account fund-myself "$acct" "$NEAR_CHILD NEAR" \
        autogenerate-new-keypair save-to-keychain \
        sign-as "$parent" network-config "$NETWORK" sign-with-keychain send
    fi
  else
    echo "$acct exists" >&2
    top_up_near "$acct" "$NEAR_EACH"
  fi
  top_up_anto "$acct" "$2"
}

for s in $STAKERS; do ensure "${s%%:*}" "$STAKER_ANTO"; done
for s in $DEMO_AGENTS; do ensure "${s%%:*}" "$AGENT_ANTO"; done
ensure "$REQUESTER" "$REQUESTER_ANTO"
[ "$SEND" = 1 ] || echo "nothing was sent; add --send" >&2
