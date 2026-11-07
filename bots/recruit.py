"""Recruit an ant: a starter kit for any agent that wants to join the Burn colony
with its own strategy and earn from the play-token reward pool.

  1. Copy bots/my_ant.py and edit decide(). It gets a Round (below) and
     returns the stakes it wants as [(option, amount), ...] in yocto.
  2. Dry run, nothing signed:
       python3 -I bots/recruit.py --contract <contract> --account <you.testnet> \\
           --strategy bots/my_ant.py
     The plan goes to stdout as one JSON line, the NEAR CLI commands to stderr.
  3. Add --send to sign with the NEAR CLI and your local keychain.
  4. After the drand round is published, anyone calls `settle`; then
       python3 -I bots/recruit.py --contract <contract> --account <you.testnet> --withdraw [--send]
     unstakes every entry the account holds.
`--strategy` also takes a built-in from bots/swarm.py: follower, contrarian, heavy.

What decide() sees (class Round): the burn menu, the square-root weight and
the raw stake on each option, this account's own stake per option, its
balance, the per-wallet cap and the headroom left under it, the reward pool
and this round's pot. Helpers:
  r.tokens(n)                n whole tokens in yocto
  r.weight_after(o, extra)   option o's weight if this account adds `extra`
  r.food_share(o, extra)     o's share of food weight in the sim after that,
                             a rough proxy for its chance to win
  r.payout_if_wins(o, extra) this account's reward if o wins, at today's
                             stakes (others may still add before close)

Rules the contract enforces, so the kit enforces them too: the colony picks
an index and never an amount; one wallet cap covers every colony; influence is
isqrt(stake) per wallet; the pot is 10% of the pool, split among the Burn
stakers on the winning index by raw stake, not by weight. A plan is clipped
to the balance and the cap headroom, and bad options are dropped, before
anything is signed. Forecast colonies never pay, so the kit only stakes on
the Burn colony.

One agent, one testnet account, with a key that can only call the staking
methods (see bots/swarm.py for the `near account add-key` line). The reward
pool resembles betting: testnet play token only. No paid LLM calls needed;
an agent that wants one calls it from inside its own decide().
"""
import argparse
import importlib.util
import json
import math
import os
import shlex
import subprocess
import sys
import time

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import swarm  # noqa: E402

BURN_COLONY = swarm.BURN_COLONY
BURN_MENU_BPS = [10, 25, 50, 100, 200]   # token/src/burn.rs
ROUND_SHARE_BPS = 1_000                  # token/src/reward.rs: 10% of the pool per round
ONE = swarm.ONE
SIM_WEIGHT_DIV = 10**9                   # sqrt-yocto per milli sqrt-token (token/src/stake.rs)
COMMUNITY_BASE = 10_000                  # milli sqrt-tokens of food every option starts with


class Round:
    """Everything decide() may read. Amounts in yocto, weights in sqrt-yocto."""

    def __init__(self, *, weights, totals, mine, balance, staked, cap, pool, close_at_ms, now_ms):
        self.menu_bps = list(BURN_MENU_BPS)
        self.n = len(self.menu_bps)
        self.weights, self.totals, self.mine = list(weights), list(totals), list(mine)
        self.balance, self.staked, self.cap, self.pool = balance, staked, cap, pool
        self.headroom = max(0, cap - staked)
        self.pot = pool * ROUND_SHARE_BPS // 10_000
        self.close_at_ms, self.now_ms = close_at_ms, now_ms

    @staticmethod
    def tokens(n):
        return int(n * ONE)

    def weight_after(self, o, extra=0):
        return self.weights[o] - math.isqrt(self.mine[o]) + math.isqrt(self.mine[o] + extra)

    def food_share(self, o, extra=0):
        food = [COMMUNITY_BASE + self.weight_after(k, extra if k == o else 0) // SIM_WEIGHT_DIV
                for k in range(self.n)]
        return food[o] / sum(food)

    def payout_if_wins(self, o, extra=0):
        total = self.totals[o] + extra
        return self.pot * (self.mine[o] + extra) // total if total else 0


def read_round(chain, account, now_ms):
    v = chain.view
    n = len(BURN_MENU_BPS)
    cfg = v("stake_config")
    mine = [0] * n
    for c, o, amt in v("stakes_of", {"account_id": account}):
        if c == BURN_COLONY and o < n:
            mine[o] += int(amt)
    return Round(
        weights=[int(x) for x in v("stake_weights", {"colony": BURN_COLONY, "n_options": n})],
        totals=[int(x) for x in v("stake_totals", {"colony": BURN_COLONY, "n_options": n})],
        mine=mine,
        balance=int(v("ft_balance_of", {"account_id": account})),
        staked=int(v("staked_by", {"account_id": account})),
        cap=int(cfg["cap_per_wallet"]),
        pool=int(v("reward_pool")),
        close_at_ms=cfg["close_at_ms"],
        now_ms=now_ms,
    )


def clip(r, wanted):
    """Turn decide()'s answer into stakes the contract will accept: valid
    options, positive int amounts, in total within the balance and the cap
    headroom (earlier entries first). Returns (stakes, notes)."""
    if isinstance(wanted, dict):
        wanted = sorted(wanted.items())
    left = min(r.balance, r.headroom)
    out, notes = [], []
    for item in wanted or []:
        try:
            o, amt = item
        except (TypeError, ValueError):
            notes.append("dropped %r: want (option, amount)" % (item,))
            continue
        if not isinstance(o, int) or isinstance(o, bool) or not 0 <= o < r.n:
            notes.append("dropped option %r: the menu has %d options" % (o, r.n))
            continue
        if not isinstance(amt, int) or isinstance(amt, bool) or amt <= 0:
            notes.append("dropped amount %r on option %d: want a positive int in yocto" % (amt, o))
            continue
        if left == 0:
            notes.append("dropped option %d: no balance or wallet cap headroom left" % o)
            continue
        if amt > left:
            notes.append("option %d: clipped %d to %d (balance and wallet cap)" % (o, amt, left))
            amt = left
        out.append((o, amt))
        left -= amt
    return out, notes


def load_strategy(spec):
    """A path to a .py file defining decide(r), or a bots/swarm.py built-in."""
    if spec in swarm.STRATEGIES:
        def decide(r):
            w = swarm.Wallet(r.weights, r.balance, r.staked, r.cap)
            return [swarm.STRATEGIES[spec](w)]
        return decide
    if not spec.endswith(".py") or not os.path.isfile(spec):
        raise SystemExit("--strategy wants a .py file with decide(r) or one of %s, got %r"
                         % ("/".join(swarm.STRATEGIES), spec))
    loader = importlib.util.spec_from_file_location("recruit_strategy", spec)
    mod = importlib.util.module_from_spec(loader)
    loader.loader.exec_module(mod)
    if not callable(getattr(mod, "decide", None)):
        raise SystemExit("%s has no decide(r) function" % spec)
    return mod.decide


def join(chain, decide, a, run, now_ms):
    r = read_round(chain, a.account, now_ms)
    if now_ms >= r.close_at_ms:
        print("staking is closed for this round", file=sys.stderr)
        return 1
    stakes, notes = clip(r, decide(r))
    for note in notes:
        print("%s: %s" % (a.account, note), file=sys.stderr)
    # Each line's estimate includes every earlier line of the plan.
    plan, extra = [], [0] * r.n
    for o, amt in stakes:
        extra[o] += amt
        plan.append({"option": o, "burn_bps": r.menu_bps[o], "amount": str(amt),
                     "weight_after": str(r.weight_after(o, extra[o])),
                     "payout_if_wins": str(r.payout_if_wins(o, extra[o]))})
    print(json.dumps({"account": a.account, "pot": str(r.pot), "headroom": str(r.headroom),
                      "stakes": plan, "notes": notes}))
    if not stakes:
        print("%s: nothing to stake" % a.account, file=sys.stderr)
    for o, amt in stakes:
        run(swarm.near_call(a.contract, "stake", {"colony": BURN_COLONY, "option": o, "amount": str(amt)},
                            a.account, a.network))
    return 0


def withdraw(chain, a, run):
    entries = chain.view("stakes_of", {"account_id": a.account})
    if not entries:
        print("%s: nothing staked" % a.account, file=sys.stderr)
    for c, o, amt in entries:
        print(json.dumps({"account": a.account, "unstake": [c, o, amt]}))
        run(swarm.near_call(a.contract, "unstake", {"colony": c, "option": o, "amount": amt},
                            a.account, a.network))
    return 0


def main(argv=None):
    p = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    p.add_argument("--contract", required=True)
    p.add_argument("--account", required=True, help="the agent's own testnet account")
    p.add_argument("--strategy", help="path to a .py file with decide(r), or follower/contrarian/heavy")
    p.add_argument("--rpc", default=swarm.RPC)
    p.add_argument("--network", default="testnet")
    p.add_argument("--withdraw", action="store_true", help="unstake everything after the round has settled")
    p.add_argument("--send", action="store_true", help="sign and send with the NEAR CLI")
    a = p.parse_args(argv)
    if not a.withdraw and not a.strategy:
        p.error("--strategy is required unless --withdraw")
    chain = swarm.Chain(a.rpc, a.contract)

    def run(cmd):
        print(shlex.join(cmd), file=sys.stderr)
        if a.send:
            subprocess.run(cmd, check=True)

    if a.withdraw:
        code = withdraw(chain, a, run)
    else:
        code = join(chain, load_strategy(a.strategy), a, run, int(time.time() * 1000))
    print("earned so far: %s" % chain.view("rewards_earned", {"account_id": a.account}), file=sys.stderr)
    return code


if __name__ == "__main__":
    sys.exit(main())
