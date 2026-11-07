"""Antonomy bot swarm: rule-based bots that stake on the Burn colony every round
and earn from the play-token reward pool when their burn size wins.

Usage:
  python3 -I bots/swarm.py --contract <contract> \\
      --bot follower=<account> --bot contrarian=<account> --bot heavy=<account> [--send]
  python3 -I bots/swarm.py --contract <contract> --bot ... --withdraw [--send]

Strategies (Burn colony only; forecast colonies never pay out):
  follower    stakes FLOW_AMOUNT on the option with the most stake weight.
  contrarian  stakes FLOW_AMOUNT on the option with the least stake weight.
              Square-root weighting makes a thin option's first tokens count
              the most, and a winning thin option has fewer stakers to share with.
  heavy       stakes everything up to the per-wallet cap on HEAVY_FAVOURITE,
              the largest burn. Shows that the cap and square-root weighting
              stop one rich wallet from taking over the colony.
Ties go to the lowest option index, as in the sim. Every amount is clipped to
the bot's balance and to its headroom under the wallet cap.

Bots run in the order given and read the stake weights again before each one
acts, so later bots react to earlier ones. Without --send nothing is signed:
the plans go to stdout as JSON lines and the NEAR CLI commands to stderr.
The dry run adds isqrt(amount) to the chosen option's weight before the next
bot reads it, which is exact only when that bot had no stake there yet.

Each bot is its own testnet account. Give it a key that can only call the
staking methods and pays gas from a small allowance:
  near account add-key <bot> grant-function-call-access --allowance '0.5 NEAR' \\
    --contract-account-id <contract> --function-names 'stake, unstake, settle' \\
    autogenerate-new-keypair save-to-keychain network-config testnet \\
    sign-with-keychain send
Fund it with play tokens from the treasury (`ft_transfer`) before the first round.

After the drand round is published, anyone calls `settle`; then --withdraw
unstakes every entry the bots hold, read from the final stake snapshot.
Rewards land in the bots' balances when the colony executes the burn.

Reads go to a public RPC (read-only, no keys); writes go through the NEAR CLI
and the local keychain. No paid LLM calls.
"""
import argparse
import base64
import json
import math
import shlex
import subprocess
import sys
import time
import urllib.request
from collections import namedtuple

BURN_COLONY = 0
BURN_OPTIONS = 5
ONE = 10**24
FLOW_AMOUNT = 10 * ONE
HEAVY_FAVOURITE = 4          # 2.00% of the treasury, the top of the burn menu
RPC = "https://test.rpc.fastnear.com"
GAS = "100.0 Tgas"

# weights: per-option sqrt-yocto sums (contract `stake_weights`); balance,
# staked and cap in yocto.
Wallet = namedtuple("Wallet", "weights balance staked cap")


def argmax(xs):
    return max(range(len(xs)), key=lambda i: (xs[i], -i))


def argmin(xs):
    return min(range(len(xs)), key=lambda i: (xs[i], i))


def follower(w):
    return argmax(w.weights), FLOW_AMOUNT


def contrarian(w):
    return argmin(w.weights), FLOW_AMOUNT


def heavy(w):
    return HEAVY_FAVOURITE, w.cap - w.staked


STRATEGIES = {"follower": follower, "contrarian": contrarian, "heavy": heavy}


def plan(strategy, w):
    """(option, amount) to stake, or None if the bot has nothing to add."""
    option, want = STRATEGIES[strategy](w)
    amount = min(want, w.balance, w.cap - w.staked)
    return (option, amount) if amount > 0 else None


class Chain:
    """Read-only contract views over NEAR JSON-RPC."""

    def __init__(self, rpc, contract):
        self.rpc, self.contract = rpc, contract

    def view(self, method, args=None):
        body = json.dumps({
            "jsonrpc": "2.0", "id": "anto", "method": "query",
            "params": {
                "request_type": "call_function", "finality": "final",
                "account_id": self.contract, "method_name": method,
                "args_base64": base64.b64encode(json.dumps(args or {}).encode()).decode(),
            },
        }).encode()
        req = urllib.request.Request(self.rpc, body, {"content-type": "application/json"})
        with urllib.request.urlopen(req, timeout=20) as r:
            out = json.load(r)
        res = out.get("result") or {}
        if "error" in out or "error" in res or "result" not in res:
            raise RuntimeError("%s failed: %s" % (method, out.get("error") or res.get("error")))
        return json.loads(bytes(res["result"]))

    def config(self):
        return self.view("stake_config")

    def weights(self):
        return [int(x) for x in self.view("stake_weights", {"colony": BURN_COLONY, "n_options": BURN_OPTIONS})]

    def wallet(self, account, cap):
        return Wallet(
            self.weights(),
            int(self.view("ft_balance_of", {"account_id": account})),
            int(self.view("staked_by", {"account_id": account})),
            cap,
        )


def near_call(contract, method, args, signer, network):
    return [
        "near", "contract", "call-function", "as-transaction", contract, method,
        "json-args", json.dumps(args, separators=(",", ":")),
        "prepaid-gas", GAS, "attached-deposit", "0 NEAR",
        "sign-as", signer, "network-config", network, "sign-with-keychain", "send",
    ]


def parse_bots(specs):
    bots = []
    for s in specs:
        strategy, sep, account = s.partition("=")
        if not sep or strategy not in STRATEGIES or not account:
            raise SystemExit("--bot wants STRATEGY=ACCOUNT with STRATEGY in %s, got %r"
                             % ("/".join(STRATEGIES), s))
        bots.append((strategy, account))
    return bots


def stake_round(chain, bots, a, run):
    cfg = chain.config()
    if time.time() * 1000 >= cfg["close_at_ms"]:
        print("staking is closed for this round", file=sys.stderr)
        return 1
    cap = int(cfg["cap_per_wallet"])
    local = None  # dry run: weights carried between bots
    for strategy, account in bots:
        w = chain.wallet(account, cap)
        if local is not None:
            w = w._replace(weights=local)
        p = plan(strategy, w)
        print(json.dumps({"bot": account, "strategy": strategy, "weights": [str(x) for x in w.weights],
                          "option": p and p[0], "amount": p and str(p[1])}))
        if p is None:
            print("%s: nothing to stake" % account, file=sys.stderr)
            continue
        args = {"colony": BURN_COLONY, "option": p[0], "amount": str(p[1])}
        run(near_call(a.contract, "stake", args, account, a.network))
        if not a.send:
            local = list(w.weights)
            local[p[0]] += math.isqrt(p[1])
    return 0


def withdraw(chain, bots, a, run):
    entries = chain.view("stake_snapshot")["entries"]
    mine = {account for _, account in bots}
    for account, colony, option, amount in entries:
        if account in mine:
            print(json.dumps({"bot": account, "unstake": [colony, option, amount]}))
            run(near_call(a.contract, "unstake",
                          {"colony": colony, "option": option, "amount": amount}, account, a.network))
    return 0


def summary(chain, bots):
    print("reward pool: %s" % chain.view("reward_pool"), file=sys.stderr)
    for strategy, account in bots:
        earned = chain.view("rewards_earned", {"account_id": account})
        print("%-10s %s earned %s" % (strategy, account, earned), file=sys.stderr)


def main(argv=None):
    p = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    p.add_argument("--contract", required=True)
    p.add_argument("--bot", action="append", required=True, metavar="STRATEGY=ACCOUNT")
    p.add_argument("--rpc", default=RPC)
    p.add_argument("--network", default="testnet")
    p.add_argument("--withdraw", action="store_true", help="unstake after the round has settled")
    p.add_argument("--send", action="store_true", help="sign and send with the NEAR CLI")
    a = p.parse_args(argv)
    bots = parse_bots(a.bot)
    chain = Chain(a.rpc, a.contract)

    def run(cmd):
        print(shlex.join(cmd), file=sys.stderr)
        if a.send:
            subprocess.run(cmd, check=True)

    code = (withdraw if a.withdraw else stake_round)(chain, bots, a, run)
    summary(chain, bots)
    return code


if __name__ == "__main__":
    sys.exit(main())
