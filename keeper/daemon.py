"""Antonomy keeper daemon: the keeper and cranker jobs that keep the product moving.

Everything on the contract is permissionless or allow-listed, so something has
to call it. This loop reads the contract's views and makes the calls that are
due, nothing else:

  keeper accounts (allow-listed on the contract; --keeper, repeatable)
    post_trending        the round's markets, each keeper reading them with
                         keeper/trending.py on its own; a keeper whose list
                         differs from the others' (a volume reshuffle between
                         reads) reads again while posting is open
    post_request_odds    each requested market's odds, same reader
    post_resolutions     every RESOLVE_EVERY_MS, each keeper reads how the
                         markets waiting in the scorebook stand
                         (keeper/resolve.py) and posts the reads that changed
  cranker account (anyone)
    finalize_markets, crank_round, start_round        the round
    crank_burn, execute_burn                          the Burn colony's day
    finalize_request_odds, crank_request              requested forecasts
    fulfill_randomness                                randomness service: proves each
                                                      waited-for drand round once
    score_market                                      a market whose resolution is final
  agent account   (optional, --agent)
    claim_play_tokens, register_agent                 once, when it can afford the deposit
    commit_forecast,     each open market and request, once, at the odds the
    reveal_forecast      keepers' median already put on chain (a baseline
                         forecaster: the Agents colony then mirrors the market
                         until other agents post their own odds): a hash while
                         the window hides posts, the odds in its last third

Dry run unless --send: it prints the NEAR CLI commands it would sign. Each
send goes through the first NEAR CLI network (--network, repeatable); if that
RPC fails (an HTTP error, a timeout) the same call goes to the next one. A call
the contract itself rejected is not sent again. A retried call that did land
the first time is harmless: an extra crank runs the next colony, and the
once-only calls are refused the second time. Usage:

  python3 -I keeper/daemon.py --contract <c> --keeper <acct> [--keeper <acct>...] --cranker <acct> \\
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
import re
import shlex
import subprocess
import sys
import threading
import time

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(HERE, "..", "bots"))
from swarm import RPC, Chain, fetch_beacon  # noqa: E402
sys.path.insert(0, HERE)
import demo  # noqa: E402
from demo import (AGENT_STYLES, STAKE_STYLES, Crew, agent_steps, call, crew_steps,  # noqa: E402
                  parse_personas, pick_market, to_bps)  # noqa: F401

DAY_MS = 86_400_000
STAKING_MS = DAY_MS // 2           # token/src/day.rs: the colony runs 12:00 to 24:00 UTC
BURN_TICKS = 43_200
TICKS_PER_CALL = 1_500             # token/src/burnrun.rs
TRENDING = os.path.join(HERE, "trending.py")
RESOLVE = os.path.join(HERE, "resolve.py")
RESOLVE_EVERY_MS = 30 * 60_000     # how often the keepers re-read the open markets' resolutions
FINAL = ("resolved", "fifty_fifty")
HEAVY_GAS = "300.0 Tgas"
LATE_FINALIZE_MS = 30 * 60_000     # how long after publish a late post is still finalized
TRENDING_COUNT = 12                # markets per round (contract MAX_TRENDING)
RECRUIT_SCAN = 30                  # trending markets the demo requester picks from
RECRUIT_SETTLE_MS = 2 * 60_000     # after a request, wait for the chain to show it
RECRUIT_RETRY_MS = 30 * 60_000     # wait this long after the reader found no market to request
WINDOW_OPENERS = ("finalize_markets", "finalize_request_odds")   # calls that open an agents' window
COLONIES_PER_MARKET = 3            # token/src/round.rs: Momentum, Community, Agents
MAX_ROUND_CRANKS = 36              # cranks per tick: three colonies for each of up to 12 markets
MAX_BURN_CATCHUP = 5               # cranks per tick when the colony is behind the clock
DEADLINE_MARGIN_MS = 10_000        # a deadline-bound call this close to its deadline isn't sent
# The transaction ran and the contract refused it: another RPC won't change that.
REJECTED = re.compile(r"ExecutionError|Smart contract panicked|ActionError")
# The RPC took the transaction but gave no result: on the heavy multi-block
# cranks the node's wait for the result fails with this, and the transaction
# usually lands anyway. A second send through another network would be a
# second transaction, so a call with no deadline is not repeated: the next
# tick plans again from the chain's state, which shows whether it landed.
UNSURE = re.compile(r'internal error: \[Some\("Internal server error"\)\]')
UNCONFIRMED = "unconfirmed"


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


def list_key(post):
    """What keepers must agree on (token/src/market.rs `list_key`)."""
    return tuple((m["market_id"], tuple(m["outcomes"])) for m in post)


def to_repost(posts, quorum):
    """Our keepers that should read and post again: every one that hasn't
    posted, and, once all have but no list has `quorum` of them, those
    outside the largest group (ties: the group of the first keeper)."""
    missing = [k for k, p in posts.items() if p is None]
    if missing or len(posts) < quorum:
        return missing
    groups = {}
    for k, p in posts.items():
        groups.setdefault(list_key(p), []).append(k)
    best = max(groups.values(), key=len)
    return [] if len(best) >= quorum else [k for k in posts if k not in best]


def resolution_steps(chain, keepers, cranker, resolve):
    """Score each market whose resolution is final; with `resolve`, have each
    keeper read the others again. A contract without the scorebook has no
    `open_markets` view: nothing to do."""
    try:
        openm = chain.view("open_markets", {"from_index": 0, "limit": 50})
    except (RuntimeError, OSError, ValueError, KeyError):
        return []
    steps = []
    waiting = []
    for m in openm:
        if (m.get("resolution") or {}).get("state") in FINAL:
            steps.append(call(cranker, "score_market", {"market_id": m["market_id"]}))
        else:
            waiting.append(m)
    if resolve and waiting:
        for k in keepers:
            todo = []
            for m in waiting:
                mine = next(([st, end] for who, st, end in m["keepers_posted"] if who == k), None)
                todo.append({"market_id": m["market_id"], "outcomes": m["outcomes"], "mine": mine})
            steps.append(call(k, "post_resolutions", read=("resolutions", todo)))
    return steps


def plan(chain, keepers, cranker, now_ms, refused=(), agent=None, beacon=lambda rnd: None, resolve=False):
    """The calls due now, in order. Pure apart from the chain reads and
    `beacon(round)`, which returns a drand signature or None. `keepers` are
    the allow-listed accounts this daemon signs for. `resolve` asks the
    keepers to read the open markets' resolutions again."""
    steps = []

    # ---- the round ----
    rs = chain.view("round_status")
    phase = rs["phase"]
    if phase == "posting":
        _, quorum = chain.view("keepers")
        posts = {k: chain.view("keeper_post", {"account_id": k}) for k in keepers}
        for k in to_repost(posts, quorum):
            steps.append(call(k, "post_trending", read=("trending",)))
    elif phase == "agents":
        if rs["markets"] is None and now_ms >= rs["close_at_ms"]:
            steps.append(call(cranker, "finalize_markets"))
    elif phase in ("ready", "running"):
        # One call per colony, so catch up on every one still due this tick.
        run = rs.get("run")
        left = COLONIES_PER_MARKET * len(rs["markets"] or [1]) - sum(len(m["colony_hashes"]) for m in (run or {"markets": []})["markets"])
        first = {} if run is not None else seed_args(rs, beacon)
        if first is not None:
            steps.append(call(cranker, "crank_round", first))
            for _ in range(max(1, min(MAX_ROUND_CRANKS, left)) - 1):
                steps.append(call(cranker, "crank_round"))
    elif phase == "skipped" \
            and any(chain.view("keeper_post", {"account_id": k}) is not None for k in keepers) \
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
        listed, _ = chain.view("keepers")
        for r in recent:
            rid = r["id"]
            if r["phase"] == "odds":
                todo = [] if rid in refused else [k for k in keepers if k not in r["keepers_posted"]]
                for k in todo:
                    steps.append(call(k, "post_request_odds", read=("request", rid, r["market_id"])))
                if not todo and (now_ms >= r["odds_by_ms"] or set(listed) <= set(r["keepers_posted"])):
                    steps.append(call(cranker, "finalize_request_odds", {"request_id": rid}))
            elif r["phase"] == "forecasting" and now_ms >= r["forecast_by_ms"]:
                args = seed_args(r, beacon, {"request_id": rid})
                if args is not None:
                    steps.append(call(cranker, "crank_request", args))
            elif r["phase"] == "running":
                steps.append(call(cranker, "crank_request", {"request_id": rid}))

    # ---- randomness as a service ----
    # Prove each drand round some request waits for, once its beacon is out.
    # A contract without the service has no such views: nothing to do.
    try:
        count = chain.view("randomness_count")
        asked = chain.view("randomness_requests", {"from_id": max(0, count - 50), "limit": 50}) if count else []
    except (RuntimeError, OSError, ValueError, KeyError):
        asked = []
    for rnd in sorted({r["drand_round"] for r in asked if r["status"] == "pending"}):
        sig = beacon(rnd)
        if sig is not None:
            steps.append(call(cranker, "fulfill_randomness", {"drand_round": rnd, "drand_signature": sig}))
    steps += resolution_steps(chain, keepers, cranker, resolve)
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


def read_resolutions(todo):
    """`post_resolutions` arguments: the keeper's fresh reads of `todo`'s
    markets that differ from its post on chain (`mine`, [state, end_ms]),
    or None when nothing changed or the reader failed."""
    ask = [{"market_id": t["market_id"], "outcomes": t["outcomes"]} for t in todo]
    out = subprocess.run([sys.executable, "-I", RESOLVE, "--open", "-"], input=json.dumps(ask),
                         capture_output=True, text=True, timeout=300)
    if out.returncode != 0 or not out.stdout.strip():
        return None
    mine = {t["market_id"]: t["mine"] for t in todo}
    changed = [p for p in json.loads(out.stdout)["resolutions"]
               if p["market_id"] in mine and mine[p["market_id"]] != [p["state"], p["end_ms"]]]
    return {"resolutions": changed} if changed else None


def read_recruit(exclude):
    """`request_forecast` arguments: the first trending market not in
    `exclude`, or None."""
    out = _read(["--count", str(RECRUIT_SCAN)])
    return None if out is None else pick_market(out["markets"], set(exclude))


def cli(contract, step, network):
    return [
        "near", "contract", "call-function", "as-transaction", contract, step["method"],
        "json-args", json.dumps(step["args"], separators=(",", ":")),
        "prepaid-gas", step["gas"], "attached-deposit", "0 NEAR",
        "sign-as", step["account"], "network-config", network, "sign-with-keychain", "send",
    ]


class Operator:
    def __init__(self, chain, contract, keepers, cranker, networks, send, run=None, now_ms=None,
                 readers=None, log=None, agent=None, fetch=None, crew=None, split=False):
        self.chain, self.contract = chain, contract
        self.keepers, self.cranker, self.networks, self.send = keepers, cranker, networks, send
        self.agent, self.crew, self.split = agent, crew or Crew(), split
        self.hold_recruit_until = 0
        self.run = run or self._run
        self.now_ms = now_ms or (lambda: int(time.time() * 1000))
        self.readers = readers or {"trending": read_trending, "request": read_request, "recruit": read_recruit,
                                   "resolutions": read_resolutions}
        self.resolve_at = 0
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
        """True if sent, False if the RPC failed, None if the contract
        rejected the call, UNCONFIRMED if the RPC took it but gave no result."""
        if not self.send:
            return True
        r = subprocess.run(cmd, stdout=subprocess.DEVNULL, stderr=subprocess.PIPE, text=True)
        if r.returncode == 0:
            return True
        self.log(r.stderr.strip()[-300:])
        if REJECTED.search(r.stderr):
            return None
        return UNCONFIRMED if UNSURE.search(r.stderr) else False

    def send_step(self, step):
        """Send `step` through each network in turn until one takes it."""
        for net in self.networks:
            cmd = cli(self.contract, step, net)
            self.log(("send " if self.send else "dry  ") + shlex.join(cmd)[:220])
            ok = self.run(cmd)
            if ok is None:
                return False
            if ok == UNCONFIRMED:
                if step["by"] is None:
                    self.log("no result for %s; the next tick checks the chain" % step["method"])
                    return True
                continue   # a deadline-bound call tries the next network; a repeat is refused harmlessly
            if ok:
                return True
        return False

    def do_step(self, step, sent=(), made=None):
        """Send one planned call: (method, sent_ok), or None if it was
        skipped (its window is closing, its reader refused, it was already
        made by an earlier pass)."""
        if step["by"] is not None and self.now_ms() >= step["by"] - DEADLINE_MARGIN_MS:
            self.log("skip %s: its window closes before it would land" % step["method"])
            return None
        if step["read"] is not None:
            kind, *a = step["read"]
            if kind == "recruit" and self.now_ms() < self.hold_recruit_until:
                return None
            args = self.readers[kind](*a)
            if args is None:
                if kind != "resolutions":   # no news is the usual answer there
                    self.log("skip %s: the keeper reader refused" % step["method"])
                if kind == "request":
                    self.refused.add(a[0])
                elif kind == "recruit":
                    self.hold_recruit_until = self.now_ms() + RECRUIT_RETRY_MS
                return None
            step["args"] = args
        key = (step["account"], step["method"], json.dumps(step["args"], sort_keys=True))
        if key in sent:
            return None
        if made is not None:
            made.add(key)
        ok = self.send_step(step)
        if not ok:
            self.log("failed: %s (will retry next tick)" % step["method"])
        elif step["method"] == "request_forecast":
            # Views lag a fresh transaction a little; a second request would cost a second fee.
            self.hold_recruit_until = self.now_ms() + RECRUIT_SETTLE_MS
        return (step["method"], ok)

    def run_steps(self, steps, sent=(), made=None, parallel=False):
        """Send `steps` in the order that suits their deadlines. `sent` holds
        the calls an earlier pass of this tick made, which are not made again
        (repeats within one pass are meant: a crank per colony); `made`, if
        given, collects this pass's. `parallel` sends each account's calls in
        its own thread (calls of one account stay in order; different accounts
        have their own nonces)."""
        # The keeper's Polymarket reads can take minutes on a bad network, so
        # the on-chain calls that don't need one (cranks, burn) go first, and
        # of those the ones with a deadline (agent posts, stakes) before the
        # rest: a tick of 60 round cranks takes long enough to miss a window.
        steps.sort(key=lambda st: (st["read"] is not None, st["by"] is None))
        if not parallel:
            return [r for r in (self.do_step(st, sent, made) for st in steps) if r is not None]
        by_account = {}
        for st in steps:
            by_account.setdefault(st["account"], []).append(st)
        out = {}

        def work(acct):
            out[acct] = [r for r in (self.do_step(st, sent, made) for st in by_account[acct]) if r is not None]

        threads = [threading.Thread(target=work, args=(acct,)) for acct in by_account]
        for t in threads:
            t.start()
        for t in threads:
            t.join()
        return [r for acct in by_account for r in out.get(acct, [])]

    def tick(self):
        """Make every call that is due. Returns [(method, sent_ok)]. With
        `split`, the agents' and the crew's calls are left to `fast_tick`."""
        made = set()
        resolve = self.now_ms() >= self.resolve_at
        if resolve:
            self.resolve_at = self.now_ms() + RESOLVE_EVERY_MS
        steps = plan(self.chain, self.keepers, self.cranker, self.now_ms(), self.refused,
                     None if self.split else self.agent, self.beacon, resolve)
        if not self.split:
            steps += crew_steps(self.chain, self.crew, self.now_ms(), self.log)
        done = self.run_steps(steps, made=made)
        if not self.split and any(m in WINDOW_OPENERS and ok for m, ok in done):
            # A call just opened an agents' window (the request one is only
            # 60 seconds long): post and stake in it now, not next tick.
            rs = self.chain.view("round_status")
            requests = demo.recent_requests(self.chain)
            again = agent_steps(self.chain, self.agent, self.now_ms(), rs, requests) if self.agent else []
            done += self.run_steps(again + crew_steps(self.chain, self.crew, self.now_ms(), self.log), made)
        return done

    def fast_tick(self):
        """The deadline-bound calls: the baseline agent's posts and the crew's
        stakes, posts and requests. A cranking tick can take minutes (one
        transaction at a time), longer than the 60-second window a request's
        agents have, so these run on their own short loop."""
        chain = demo.Memo(self.chain)
        now = self.now_ms()
        steps = crew_steps(chain, self.crew, now, self.log)
        if self.agent:
            try:
                rs = chain.view("round_status")
                steps += agent_steps(chain, self.agent, now, rs, demo.recent_requests(chain))
            except (RuntimeError, OSError, ValueError, KeyError) as e:
                self.log("agent: %s" % e)
        return self.run_steps(steps, parallel=True)


def main(argv=None):
    p = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    p.add_argument("--contract", required=True)
    p.add_argument("--keeper", action="append", required=True,
                   help="allow-listed keeper account; repeat for each keeper this daemon signs for")
    p.add_argument("--cranker", required=True, help="any account; pays the gas of the cranks")
    p.add_argument("--agent", help="optional forecaster-agent account: joins and posts the chain's odds on every open market")
    p.add_argument("--staker", action="append", metavar="ACCOUNT[:STYLE]",
                   help="demo staker persona (style %s, default follower); repeatable" % "/".join(STAKE_STYLES))
    p.add_argument("--demo-agent", action="append", metavar="ACCOUNT[:STYLE]",
                   help="extra forecaster agent with its own odds (style %s, default sharp); repeatable"
                   % "/".join(AGENT_STYLES))
    p.add_argument("--requester", help="demo account that pays for Recruit the swarm requests")
    p.add_argument("--recruit-max", type=int, default=2, help="most requests the demo requester makes in all")
    p.add_argument("--recruit-gap", type=int, default=demo.RECRUIT_GAP_MS // 60_000,
                   help="minutes between the demo requester's requests")
    p.add_argument("--rpc", action="append", help="RPC endpoint; repeat for fallbacks (default: three public ones)")
    p.add_argument("--network", action="append",
                   help="NEAR CLI network to sign through; repeat for fallbacks (default: testnet)")
    p.add_argument("--interval", type=int, default=60, help="seconds between ticks")
    p.add_argument("--fast-interval", type=int, default=15,
                   help="seconds between the fast loop's ticks (the agents' and the demo crew's calls, which "
                        "have short windows and run beside the slower cranking loop); 0 = one loop for all")
    p.add_argument("--once", action="store_true")
    p.add_argument("--send", action="store_true", help="sign and send with the NEAR CLI")
    a = p.parse_args(argv)
    op = Operator(MultiChain(a.rpc or RPCS, a.contract), a.contract, a.keeper, a.cranker, a.network or ["testnet"], a.send, agent=a.agent,
                  crew=Crew(parse_personas(a.staker, STAKE_STYLES, "follower"),
                            parse_personas(a.demo_agent, AGENT_STYLES, "sharp"),
                            a.requester, a.recruit_max, a.recruit_gap * 60_000),
                  split=a.fast_interval > 0)
    if op.split and not a.once:
        def fast():
            while True:
                try:
                    op.fast_tick()
                except (RuntimeError, OSError, ValueError, subprocess.SubprocessError) as e:
                    print("fast tick failed: %s" % e, file=sys.stderr)
                time.sleep(a.fast_interval)
        threading.Thread(target=fast, daemon=True).start()
    if op.split and a.once:
        op.fast_tick()
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
