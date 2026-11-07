"""Antonomy keeper daemon: the keeper and cranker jobs that keep the product moving.

Everything on the contract is permissionless or allow-listed, so something has
to call it. This loop reads the contract's views and makes the calls that are
due, nothing else:

  keeper account  (allow-listed on the contract)
    post_trending        the round's market, read by keeper/trending.py
    post_request_odds    each requested market's odds, same reader
  cranker account (anyone)
    finalize_markets, crank_round, start_round        the round
    crank_burn, execute_burn                          the Burn colony's day
    finalize_request_odds, crank_request              requested forecasts
  agent account   (optional, --agent)
    claim_play_tokens, register_agent                 once, when it can afford the deposit
    post_forecast        each open market and request, once, at the odds the
                         keepers' median already put on chain (a baseline
                         forecaster: the Agents colony then mirrors the market
                         until other agents post their own odds)

Dry run unless --send: it prints the NEAR CLI commands it would sign. Usage:

  python3 -I keeper/daemon.py --contract <c> --keeper <acct> --cranker <acct> \\
      [--agent <acct>] [--once] [--interval 60] [--send]

Burn colony cranks: one call steps up to 1,500 ticks (about 195 TGas), so the
daemon calls once 1,500 ticks are due, 29 calls over the day, and once more
at 24:00 for the last tick. A day's run can start until the next day's 12:00
and then catches up, so the daemon may be down for up to about 23 hours
without losing a burn day; longer, and that day is skipped.

Seeds: the call that draws a seed (the round's first crank_round, a day's first
crank_burn, a request's first crank_request) carries the signature of the drand
quicknet round the view names (`drand_round`); the contract checks it. Until
that beacon is published or fetched, the call waits for the next tick.
"""
import argparse
import json
import os
import shlex
import subprocess
import sys
import time

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(HERE, "..", "bots"))
from swarm import RPC, Chain, fetch_beacon  # noqa: E402

DAY_MS = 86_400_000
STAKING_MS = DAY_MS // 2           # token/src/day.rs: the colony runs 12:00 to 24:00 UTC
BURN_TICKS = 43_200
TICKS_PER_CALL = 1_500             # token/src/burnrun.rs
TRENDING = os.path.join(HERE, "trending.py")
LIGHT_GAS, HEAVY_GAS = "100.0 Tgas", "300.0 Tgas"
LATE_FINALIZE_MS = 30 * 60_000     # how long after publish a late post is still finalized
TRENDING_COUNT = 12                # markets per round (contract MAX_TRENDING)
MAX_ROUND_CRANKS = 60              # cranks per tick: five colonies for each of up to 12 markets
MAX_BURN_CATCHUP = 5               # cranks per tick when the colony is behind the clock
BPS = 10_000                       # agent odds must sum to exactly this (token/src/agents.rs)
DEADLINE_MARGIN_MS = 10_000        # a deadline-bound call this close to its deadline isn't sent


# rpc.testnet.near.org is fastnear behind another name, under the same per-IP
# limit, so the fallback is another provider.
RPCS = [RPC, "https://near-testnet.drpc.org", "https://archival-rpc.testnet.near.org"]

class MultiChain:
    """`Chain` views that fall back across several RPC endpoints: the public
    ones rate-limit by IP (HTTP 429), and the daemon must not go blind."""

    def __init__(self, rpcs, contract):
        self.chains = [Chain(r, contract) for r in rpcs]

    def view(self, method, args=None):
        last = None
        for c in self.chains:
            try:
                return c.view(method, args)
            except (RuntimeError, OSError, ValueError) as e:
                last = e
        raise last


def call(account, method, args=None, gas=LIGHT_GAS, read=None, by=None):
    """One planned transaction. `read` names a reader that fills in `args`
    first: ("trending",) or ("request", id, slug). `by` is the time (ms) after
    which the contract refuses it; such calls are sent first in a tick."""
    return {"account": account, "method": method, "args": args or {}, "gas": gas, "read": read, "by": by}


def to_bps(odds):
    """`odds` rescaled to sum to exactly BPS, as an agent post must: the
    keepers' median is taken per outcome, so it can sum to a little more or
    less. Largest remainder, ties to the lowest index; all zeros split evenly."""
    odds = [max(0, int(o)) for o in odds]
    total = sum(odds)
    if total == 0:
        odds, total = [1] * len(odds), len(odds)
    out = [o * BPS // total for o in odds]
    rest = sorted(range(len(odds)), key=lambda i: (-(odds[i] * BPS % total), i))
    for i in rest[:BPS - sum(out)]:
        out[i] += 1
    return out


def agent_steps(chain, agent, now_ms, rs, requests):
    """The forecaster agent's calls: join once, then post once on every open
    market (the round's, until its publish time) and request (while its
    agents' window is open)."""
    targets = []                   # (colony, odds, deadline)
    if rs["phase"] == "agents" and rs["markets"] is not None and now_ms < rs["publish_at_ms"]:
        for m in chain.view("forecast_markets") or []:
            targets.append((m["colony"], m["odds"], rs["publish_at_ms"]))
    for r in requests:
        if r["phase"] == "forecasting" and r["market"] is not None \
                and now_ms < (r["forecast_by_ms"] or 0):
            targets.append((r["colony"], r["market"]["odds"], r["forecast_by_ms"]))
    targets = [(c, o, by) for c, o, by in targets
               if agent not in [a for a, _ in chain.view("agent_snapshot", {"colony": c})["posts"]]]
    if not targets:
        return []
    steps = []
    join_by = max(by for _, _, by in targets)
    if not chain.view("is_agent", {"account_id": agent}):
        need = int(chain.view("request_config")["agent_deposit"])
        have = int(chain.view("ft_balance_of", {"account_id": agent}))
        if have < need and not chain.view("has_claimed", {"account_id": agent}):
            steps.append(call(agent, "claim_play_tokens", by=join_by))
            have += int(chain.view("faucet_amount"))
        if have < need:
            return []              # can't join: nothing to do until it is funded
        steps.append(call(agent, "register_agent", by=join_by))
    steps += [call(agent, "post_forecast", {"colony": c, "odds": to_bps(o)}, by=by) for c, o, by in targets]
    return steps


def seed_args(view, beacon, args=None):
    """Arguments for a call that draws a seed: `args` plus the signature of
    the drand round `view` commits to, or None while it isn't available. A
    view without `drand_round` is a contract that doesn't check drand yet."""
    args = dict(args or {})
    rnd = view.get("drand_round")
    if rnd is None:
        return args
    sig = beacon(rnd)
    if sig is None:
        return None
    args["drand_signature"] = sig
    return args


def plan(chain, keeper, cranker, now_ms, refused=(), agent=None, beacon=lambda rnd: None):
    """The calls due now, in order. Pure apart from the chain reads and
    `beacon(round)`, which returns a drand signature or None."""
    steps = []

    # ---- the round ----
    rs = chain.view("round_status")
    phase = rs["phase"]
    if phase == "posting":
        if chain.view("keeper_post", {"account_id": keeper}) is None:
            steps.append(call(keeper, "post_trending", read=("trending",)))
    elif phase == "agents":
        if rs["markets"] is None and now_ms >= rs["close_at_ms"]:
            steps.append(call(cranker, "finalize_markets"))
    elif phase in ("ready", "running"):
        # One call per colony, so catch up on every one still due this tick.
        run = rs.get("run")
        left = 5 * len(rs["markets"] or [1]) - sum(len(m["colony_hashes"]) for m in (run or {"markets": []})["markets"])
        first = {} if run is not None else seed_args(rs, beacon)
        if first is not None:
            steps.append(call(cranker, "crank_round", first))
            for _ in range(max(1, min(MAX_ROUND_CRANKS, left)) - 1):
                steps.append(call(cranker, "crank_round"))
    elif phase == "skipped" and chain.view("keeper_post", {"account_id": keeper}) is not None \
            and now_ms < rs["publish_at_ms"] + LATE_FINALIZE_MS:
        # A post that arrived (or was noticed) late can still be finalized:
        # the contract has no upper bound, so don't throw the round away.
        steps.append(call(cranker, "finalize_markets"))
    elif phase in ("done", "skipped"):
        steps.append(call(cranker, "start_round"))

    # ---- the Burn colony's day ----
    # The newest drawn day (its 12:00 has passed) is the one that runs: from
    # its 12:00 until the next day's, after which a new run replaces it.
    sched = chain.view("burn_schedule")
    run = chain.view("burn_run")
    last = chain.view("last_burn_day")
    drawn = sched.get("drawn_day")
    carry = run is not None and not run["done"] and run["day"] == drawn
    if carry:
        run_at = run["day"] * DAY_MS + STAKING_MS
        allowed = min(BURN_TICKS, max(0, (now_ms - run_at) // 1000))
        behind = allowed - run["t"]
        due = behind // TICKS_PER_CALL + (1 if allowed == BURN_TICKS and behind % TICKS_PER_CALL else 0)
        for _ in range(min(MAX_BURN_CATCHUP, due)):
            steps.append(call(cranker, "crank_burn", gas=HEAVY_GAS))
    elif drawn is not None and (run is None or run["day"] < drawn) and (last is None or last < drawn):
        args = seed_args(sched, beacon)
        if args is not None:
            steps.append(call(cranker, "crank_burn", args, gas=HEAVY_GAS))
    if run is not None and run["done"] and (last is None or last < run["day"]) \
            and now_ms >= (run["day"] + 1) * DAY_MS:
        steps.append(call(cranker, "execute_burn", {"day": run["day"]}))

    # ---- requested forecasts ----
    n = chain.view("forecast_request_count")
    recent = chain.view("forecast_requests", {"from_id": max(0, n - 50), "limit": 50}) if n else []
    if n:
        keepers, _ = chain.view("keepers")
        for r in recent:
            rid = r["id"]
            if r["phase"] == "odds":
                if keeper not in r["keepers_posted"] and rid not in refused:
                    steps.append(call(keeper, "post_request_odds", read=("request", rid, r["market_id"])))
                elif now_ms >= r["odds_by_ms"] or set(keepers) <= set(r["keepers_posted"]):
                    steps.append(call(cranker, "finalize_request_odds", {"request_id": rid}))
            elif r["phase"] == "forecasting" and now_ms >= r["forecast_by_ms"]:
                args = seed_args(r, beacon, {"request_id": rid})
                if args is not None:
                    steps.append(call(cranker, "crank_request", args))
            elif r["phase"] == "running":
                steps.append(call(cranker, "crank_request", {"request_id": rid}))
    if agent:
        steps += agent_steps(chain, agent, now_ms, rs, recent)
    return steps


def _read(argv):
    out = subprocess.run([sys.executable, "-I", TRENDING] + argv,
                         capture_output=True, text=True, timeout=120)
    return json.loads(out.stdout) if out.returncode == 0 and out.stdout.strip() else None


def read_trending():
    """`post_trending` arguments from the keeper's reader, or None."""
    out = _read(["--count", str(TRENDING_COUNT)])
    return None if out is None else {"markets": out["markets"]}


def read_request(rid, slug):
    """`post_request_odds` arguments for a requested market, or None if the
    reader refuses it (blocked, closed or decided)."""
    out = _read(["--request", str(rid), "--market", slug])
    return None if out is None else {"request_id": rid, "market": out["market"]}


def cli(contract, step, network):
    return [
        "near", "contract", "call-function", "as-transaction", contract, step["method"],
        "json-args", json.dumps(step["args"], separators=(",", ":")),
        "prepaid-gas", step["gas"], "attached-deposit", "0 NEAR",
        "sign-as", step["account"], "network-config", network, "sign-with-keychain", "send",
    ]


class Operator:
    def __init__(self, chain, contract, keeper, cranker, network, send, run=None, now_ms=None,
                 readers=None, log=None, agent=None, fetch=None):
        self.chain, self.contract = chain, contract
        self.keeper, self.cranker, self.network, self.send = keeper, cranker, network, send
        self.agent = agent
        self.run = run or self._run
        self.now_ms = now_ms or (lambda: int(time.time() * 1000))
        self.readers = readers or {"trending": read_trending, "request": read_request}
        self.log = log or (lambda m: print(m, file=sys.stderr))
        self.refused = set()
        self.fetch = fetch or fetch_beacon
        self.beacons = {}

    def beacon(self, rnd):
        """drand round `rnd`'s signature, fetched once and kept."""
        if rnd not in self.beacons:
            sig = self.fetch(rnd)
            if sig is None:
                self.log("waiting for drand round %d" % rnd)
                return None
            if len(self.beacons) > 256:
                self.beacons.clear()
            self.beacons[rnd] = sig
        return self.beacons[rnd]

    def _run(self, cmd):
        if not self.send:
            return True
        r = subprocess.run(cmd, stdout=subprocess.DEVNULL, stderr=subprocess.PIPE, text=True)
        if r.returncode != 0:
            self.log(r.stderr.strip()[-300:])
        return r.returncode == 0

    def tick(self):
        """Make every call that is due. Returns [(method, sent_ok)]."""
        done = []
        steps = plan(self.chain, self.keeper, self.cranker, self.now_ms(), self.refused, self.agent,
                     self.beacon)
        # The keeper's Polymarket reads can take minutes on a bad network, so
        # the on-chain calls that don't need one (cranks, burn) go first, and
        # of those the ones with a deadline (agent posts) before the rest: a
        # tick of 60 round cranks takes long enough to miss a posting window.
        steps.sort(key=lambda st: (st["read"] is not None, st["by"] is None))
        for step in steps:
            if step["by"] is not None and self.now_ms() >= step["by"] - DEADLINE_MARGIN_MS:
                self.log("skip %s: its window closes before it would land" % step["method"])
                continue
            if step["read"] is not None:
                kind, *a = step["read"]
                args = self.readers[kind](*a)
                if args is None:
                    self.log("skip %s: the keeper reader refused" % step["method"])
                    if kind == "request":
                        self.refused.add(a[0])
                    continue
                step["args"] = args
            cmd = cli(self.contract, step, self.network)
            self.log(("send " if self.send else "dry  ") + shlex.join(cmd)[:220])
            ok = self.run(cmd)
            if not ok:
                self.log("failed: %s (will retry next tick)" % step["method"])
            done.append((step["method"], ok))
        return done


def main(argv=None):
    p = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    p.add_argument("--contract", required=True)
    p.add_argument("--keeper", required=True, help="allow-listed keeper account")
    p.add_argument("--cranker", required=True, help="any account; pays the gas of the cranks")
    p.add_argument("--agent", help="optional forecaster-agent account: joins and posts the chain's odds on every open market")
    p.add_argument("--rpc", action="append", help="RPC endpoint; repeat for fallbacks (default: three public ones)")
    p.add_argument("--network", default="testnet")
    p.add_argument("--interval", type=int, default=60, help="seconds between ticks")
    p.add_argument("--once", action="store_true")
    p.add_argument("--send", action="store_true", help="sign and send with the NEAR CLI")
    a = p.parse_args(argv)
    op = Operator(MultiChain(a.rpc or RPCS, a.contract), a.contract, a.keeper, a.cranker, a.network, a.send, agent=a.agent)
    while True:
        try:
            op.tick()
        except (RuntimeError, OSError, ValueError, subprocess.SubprocessError) as e:
            print("tick failed: %s" % e, file=sys.stderr)
        if a.once:
            return 0
        time.sleep(a.interval)


if __name__ == "__main__":
    sys.exit(main())
