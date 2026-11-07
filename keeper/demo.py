"""Antonomy demo crew: persona accounts that keep the live app populated.

The daemon (keeper/daemon.py) already makes every call nobody else is making.
For a demo that also needs activity from the *users* of the product, this
module plans what a few persona accounts would do, using only the contract's
public views and calls any wallet can make:

  stakers     drop $ANTO sugar on the round's markets while staking is open, on
              a requested forecast while its agents' window is open, and on the
              Burn colony once a day. Finished request stakes are withdrawn so
              the same play tokens keep circulating (round stakes are refunded
              when the next round opens).
  agents      forecaster agents with their own take on the keepers' odds:
              sharp (leans into the favourite), flat (hedges toward even),
              noisy (jitter). The Agents colony takes their median.
  requester   one account that pays the Recruit the swarm fee for a trending
              Polymarket market the round isn't already forecasting, at most
              `recruit_max` times in all, one at a time, `recruit_gap_ms` apart.

Personas are deterministic (their choices hash the account, round and market),
so the same chain state gives the same calls. Nobody is paid for being right;
amounts are small and capped by the contract's per-wallet cap. Everything here
is testnet play tokens.

`crew_steps` returns the same step dicts as the daemon's `plan`. Funding the
accounts (NEAR for gas, $ANTO from the treasury) is keeper/demo_setup.sh.
"""
import hashlib
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(HERE, "..", "bots"))
from swarm import BURN_COLONY, BURN_OPTIONS, ONE, Wallet, burn_day, plan as burn_plan  # noqa: E402

LIGHT_GAS = "100.0 Tgas"
BPS = 10_000                       # agent odds must sum to exactly this (token/src/agents.rs)
REQUEST_COLONY = 0x8000            # request id n runs as colony 0x8000 + n
ROUND_STAKE = 3 * ONE              # per market per staker
REQUEST_STAKE = 5 * ONE
ROUND_PICKS = 4                    # markets one staker backs per round
AGENT_PICKS = 5                    # markets one extra agent persona posts on per round
BURN_BUDGET = 30 * ONE             # most one staker keeps on the Burn colony
STAKE_STYLES = ("follower", "contrarian", "mixed")
AGENT_STYLES = ("baseline", "sharp", "flat", "noisy")
BURN_STRATEGY = {"follower": "follower", "contrarian": "contrarian", "mixed": "echo"}
RECRUIT_GAP_MS = 6 * 3_600_000
OPEN_PHASES = ("odds", "forecasting", "running")
READ_ERRORS = (RuntimeError, OSError, ValueError, KeyError)


class Memo:
    """A chain whose identical `view` calls are answered once: one planning
    pass reads the same round, requests and config for every persona."""

    def __init__(self, chain):
        self.chain, self.seen = chain, {}

    def view(self, method, args=None):
        key = (method, repr(sorted((args or {}).items())))
        if key not in self.seen:
            self.seen[key] = self.chain.view(method, args)
        return self.seen[key]


def call(account, method, args=None, gas=LIGHT_GAS, read=None, by=None):
    """One planned transaction. `read` names a reader that fills in `args`
    first: ("trending",), ("request", id, slug) or ("recruit", exclude). `by`
    is the time (ms) after which the contract refuses it; such calls are sent
    first in a tick."""
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


def h(*parts):
    """A stable 64-bit number from `parts`: the personas' only randomness."""
    return int.from_bytes(hashlib.sha256("|".join(map(str, parts)).encode()).digest()[:8], "big")


def shape(style, odds, key):
    """An agent's odds for a market the keepers put at `odds`."""
    n = len(odds)
    if style == "sharp":
        return to_bps([o * o for o in odds])
    if style == "flat":
        return to_bps([o * 6 + BPS // n * 4 for o in odds])
    if style == "noisy":
        return to_bps([o * (80 + h(key, i) % 41) // 100 for i, o in enumerate(odds)])
    return to_bps(odds)


def pick_option(style, odds, key):
    """The option a staker of `style` backs on a market at `odds`."""
    order = sorted(range(len(odds)), key=lambda i: (-odds[i], i))
    if style == "contrarian":
        return order[-1]
    if style == "mixed":
        return order[h(key) % min(3, len(order))]
    return order[0]


def agent_steps(chain, agent, now_ms, rs, requests, style="baseline", picks=None):
    """The forecaster agent's calls: join once, then post once on every open
    market (the round's, until its publish time; only `picks` of them, chosen
    by hash per round, if given: every post costs gas) and request (while its
    agents' window is open), at the keepers' odds reshaped by `style`."""
    targets = []                   # (colony, odds, deadline)
    if rs["phase"] == "agents" and rs["markets"] is not None and now_ms < rs["publish_at_ms"]:
        mine = [(m["colony"], m["odds"], rs["publish_at_ms"]) for m in chain.view("forecast_markets") or []]
        if picks is not None:
            mine = sorted(mine, key=lambda t: h(agent, t[0], t[2]))[:picks]
        targets += mine
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
    steps += [call(agent, "post_forecast", {"colony": c, "odds": shape(style, o, (agent, c, by))}, by=by)
              for c, o, by in targets]
    return steps


def agreed_markets(chain):
    """The market list at least a quorum of keepers posted, with the
    per-outcome median odds, or None. Its order is the order of the round's
    colonies (colony 1 + index) once it is finalized."""
    listed, quorum = chain.view("keepers")
    posts = [p for p in (chain.view("keeper_post", {"account_id": k}) for k in listed) if p]
    groups = {}
    for p in posts:
        groups.setdefault(tuple((m["market_id"], tuple(m["outcomes"])) for m in p), []).append(p)
    if not groups:
        return None
    best = max(groups.values(), key=len)
    if len(best) < quorum:
        return None
    out = []
    for i, m in enumerate(best[0]):
        cols = [p[i]["odds"] for p in best]
        odds = [sorted(c[j] for c in cols)[len(cols) // 2] for j in range(len(m["outcomes"]))]
        out.append({"market_id": m["market_id"], "outcomes": m["outcomes"], "odds": odds})
    return out


def staker_steps(chain, who, style, now_ms, rs, requests, burned):
    """What one staker persona does now. `burned` maps account to the burn
    day it last staked for (the crew keeps it between ticks)."""
    cap = int(chain.view("stake_config")["cap_per_wallet"])
    balance = int(chain.view("ft_balance_of", {"account_id": who}))
    staked = int(chain.view("staked_by", {"account_id": who}))
    held = chain.view("stakes_of", {"account_id": who})
    steps = []
    room = min(balance, cap - staked)

    # Withdraw what finished requests no longer need, so the tokens circulate.
    for colony, option, amount in held:
        if colony >= REQUEST_COLONY:
            r = chain.view("forecast_request", {"request_id": colony - REQUEST_COLONY})
            if r is not None and r["phase"] in ("done", "skipped"):
                steps.append(call(who, "unstake", {"colony": colony, "option": option, "amount": amount}))
                room += int(amount)
    in_colony = {c for c, _, _ in held}

    # The round's markets, while staking is open (stakes close with posting).
    if rs["phase"] == "posting" and now_ms < rs["close_at_ms"]:
        backed = sum(1 for c in in_colony if 0 < c < REQUEST_COLONY)
        for i, m in enumerate(agreed_markets(chain) or []):
            colony = 1 + i
            if backed >= ROUND_PICKS or room < ROUND_STAKE:
                break
            if colony in in_colony or h(who, rs["round"], i) % 2:
                continue
            opt = pick_option(style, m["odds"], (who, rs["round"], i))
            steps.append(call(who, "stake", {"colony": colony, "option": opt, "amount": str(ROUND_STAKE)},
                              by=rs["close_at_ms"]))
            room -= ROUND_STAKE
            backed += 1

    # A requested forecast, while its agents' window is open.
    for r in requests:
        by = r["forecast_by_ms"] or 0
        if r["phase"] == "forecasting" and r["market"] is not None and now_ms < by \
                and r["colony"] not in in_colony and room >= REQUEST_STAKE:
            opt = pick_option(style, r["market"]["odds"], (who, r["id"]))
            steps.append(call(who, "stake", {"colony": r["colony"], "option": opt, "amount": str(REQUEST_STAKE)},
                              by=by))
            room -= REQUEST_STAKE

    # The Burn colony: top up once per burn day, up to the budget.
    day, _, _ = burn_day(now_ms)
    on_burn = sum(int(a) for c, _, a in held if c == BURN_COLONY)
    if burned.get(who) != day and on_burn < BURN_BUDGET and room > 0:
        run = chain.view("burn_run")
        w = Wallet([int(x) for x in chain.view("stake_weights", {"colony": BURN_COLONY, "n_options": BURN_OPTIONS})],
                   room, staked, cap, run["winner_option"] if run and run.get("done") else None)
        p = burn_plan(BURN_STRATEGY[style], w)
        if p is not None:
            amount = min(p[1], BURN_BUDGET - on_burn)
            steps.append(call(who, "stake", {"colony": BURN_COLONY, "option": p[0], "amount": str(amount)}))
            burned[who] = day
    return steps


def pick_market(markets, exclude):
    """`request_forecast` arguments for the first trending market not in
    `exclude`, or None."""
    for m in markets:
        if m["market_id"] not in exclude:
            return {"market_id": m["market_id"]}
    return None


def recruit_steps(chain, who, now_ms, requests, current, recruit_max, gap_ms):
    """Ask the swarm for a forecast on a market nobody has asked about, if
    `who` has asked fewer than `recruit_max` times, none of its requests is
    still open, the last one is `gap_ms` old and it can pay the fee."""
    mine = [r for r in requests if r["requester"] == who]
    if len(mine) >= recruit_max or any(r["phase"] in OPEN_PHASES for r in mine):
        return []
    if mine and now_ms < max(r["created_at_ms"] for r in mine) + gap_ms:
        return []
    fee = int(chain.view("request_config")["fee"])
    have = int(chain.view("ft_balance_of", {"account_id": who}))
    steps = []
    if have < fee and not chain.view("has_claimed", {"account_id": who}):
        steps.append(call(who, "claim_play_tokens"))
        have += int(chain.view("faucet_amount"))
    if have < fee:
        return []
    exclude = sorted({r["market_id"] for r in requests} | set(current))
    return steps + [call(who, "request_forecast", read=("recruit", exclude))]


def recent_requests(chain):
    n = chain.view("forecast_request_count")
    return chain.view("forecast_requests", {"from_id": max(0, n - 50), "limit": 50}) if n else []


class Crew:
    """The persona accounts: `stakers` and `agents` are lists of
    (account, style); `requester` an account or None."""

    def __init__(self, stakers=(), agents=(), requester=None, recruit_max=2, recruit_gap_ms=RECRUIT_GAP_MS):
        self.stakers, self.agents, self.requester = list(stakers), list(agents), requester
        self.recruit_max, self.recruit_gap_ms = recruit_max, recruit_gap_ms
        self.burned = {}

    def __bool__(self):
        return bool(self.stakers or self.agents or self.requester)


def parse_personas(specs, styles, default):
    """["acct:style", "acct"] to [(acct, style)], refusing an unknown style."""
    out = []
    for s in specs or []:
        acct, _, style = s.partition(":")
        style = style or default
        if not acct or style not in styles:
            raise SystemExit("%r: want ACCOUNT[:STYLE] with STYLE in %s" % (s, "/".join(styles)))
        out.append((acct, style))
    return out


def crew_steps(chain, crew, now_ms, log=lambda m: None):
    """The crew's calls due now. One persona's failed read (an RPC hiccup, a
    view the deployed contract doesn't have) skips that persona this tick."""
    chain = chain if isinstance(chain, Memo) else Memo(chain)
    try:
        rs = chain.view("round_status")
        requests = recent_requests(chain)
    except READ_ERRORS as e:
        log("crew: %s" % e)
        return []
    steps = []

    def safe(who, f):
        try:
            steps.extend(f())
        except READ_ERRORS as e:
            log("crew %s: %s" % (who, e))

    for who, style in crew.stakers:
        safe(who, lambda: staker_steps(chain, who, style, now_ms, rs, requests, crew.burned))
    for who, style in crew.agents:
        safe(who, lambda: agent_steps(chain, who, now_ms, rs, requests, style, AGENT_PICKS))
    if crew.requester:
        current = [m["market_id"] for m in (chain.view("forecast_markets") or [])] \
            if rs["markets"] is not None else []
        safe(crew.requester, lambda: recruit_steps(chain, crew.requester, now_ms, requests, current,
                                                   crew.recruit_max, crew.recruit_gap_ms))
    return steps
