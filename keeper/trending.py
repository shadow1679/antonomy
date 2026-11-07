"""Antonomy keeper: pick the round's trending Polymarket markets and print the
`post_trending` arguments for the contract.

Usage: python3 -I keeper/trending.py [--count N] [--save-raw DIR] > args.json

Trending (design doc section 15, decided 2026-10-26): open events from the
public Gamma API sorted by 24-hour volume, kept only if they pass the floors
below and the content filter, first `--count` taken (MAX_TRENDING in the
contract, 1 for now). Several keepers run this independently; the contract
accepts the list only when a quorum posted the same markets and outcomes, and
takes the per-outcome median of the odds. So keepers should run close together
in time, or a volume reshuffle near the cut makes their lists disagree.

Outcomes: a single-market event uses that market's outcomes (usually Yes/No
or two teams). A neg-risk event (mutually exclusive outcomes, one market each)
uses each market's Yes price; with more than five, the four most likely stay
and the rest become "Other" at 10000 minus the four (floored at 0), for both
now and six hours ago. Non-neg-risk events with many markets (game props) use
only their highest-volume market.

Odds six hours ago come from the CLOB price history: the last point at or
before now - 6h. `raw_hash` is sha256 over every raw response the post was
built from, in fetch order; `--save-raw` keeps the bytes so anyone can check it.

Post with the NEAR CLI, for example:
  near contract call-function as-transaction <contract> post_trending \\
    file-args args.json prepaid-gas '100.0 Tgas' attached-deposit '0 NEAR' \\
    sign-as <keeper> network-config testnet sign-with-keychain send

Not checked yet: Polymarket's terms for display and redistribution. Read-only,
no authentication, no links to the market are published.
"""
import argparse
import datetime as dt
import hashlib
import json
import os
import re
import sys
import urllib.parse
import urllib.request
from decimal import ROUND_HALF_EVEN, Decimal

GAMMA = "https://gamma-api.polymarket.com"
CLOB = "https://clob.polymarket.com"
BPS = 10000
MAX_OUTCOMES = 5
SIX_HOURS = 6 * 3600

# Floors. Volume and liquidity are USD.
MIN_VOLUME_24H = 100_000
MIN_LIQUIDITY = 50_000
MIN_DAYS_TO_END = 1            # skip events about to resolve (live games)
MAX_DAYS_TO_END = 90
MAX_TOP_ODDS = 9700            # skip markets that are effectively decided

# Content filter: no violence, deaths or private individuals. A keyword list
# cannot catch everything; anything it misses must be reported and added.
DENY_TAGS = {
    "war", "geopolitics", "military", "terrorism", "crime", "ukraine", "russia-ukraine",
    "israel", "gaza", "middle east", "iran", "mentions", "health",
}
DENY_WORDS = re.compile(
    r"\b(kill\w*|death\w*|dead|die[sd]?|dying|assassinat\w*|murder\w*|shoot\w*|bomb\w*|"
    r"missile\w*|airstrike\w*|strikes? on|invade\w*|invasion|attack\w*|war|ceasefire|"
    r"hostage\w*|terror\w*|nuclear|casualt\w*|arrest\w*|indict\w*|sentenc\w*|pregnan\w*|"
    r"divorce\w*|baby|wedding|tweet\w*|post on x|say .* during)\b",
    re.I,
)


def bps(price):
    """Decimal price (0..1) to basis points, half-even, clamped."""
    v = int((Decimal(price) * BPS).to_integral_value(ROUND_HALF_EVEN))
    return min(max(v, 0), BPS)


def parse_time(s):
    return dt.datetime.fromisoformat(s.replace("Z", "+00:00"))


def jlist(v):
    """Gamma returns some arrays as JSON strings."""
    return json.loads(v, parse_float=Decimal) if isinstance(v, str) else (v or [])


def blocked(event):
    """Reason the content filter rejects the event, or None."""
    tags = {str(t.get("label", "")).lower() for t in event.get("tags") or []}
    hit = tags & DENY_TAGS
    if hit:
        return "tag " + sorted(hit)[0]
    texts = [event.get("title") or ""] + [m.get("question") or "" for m in event.get("markets") or []]
    for t in texts:
        m = DENY_WORDS.search(t)
        if m:
            return "word '%s'" % m.group(0)
    return None


def floors(event, now):
    """Reason the floors reject the event, or None."""
    if event.get("closed") or not event.get("active"):
        return "not open"
    if Decimal(str(event.get("volume24hr") or 0)) < MIN_VOLUME_24H:
        return "24h volume below %d" % MIN_VOLUME_24H
    if Decimal(str(event.get("liquidity") or 0)) < MIN_LIQUIDITY:
        return "liquidity below %d" % MIN_LIQUIDITY
    end = event.get("endDate")
    if not end:
        return "no end date"
    days = (parse_time(end) - now).total_seconds() / 86400
    if not MIN_DAYS_TO_END <= days <= MAX_DAYS_TO_END:
        return "ends in %.1f days" % days
    return None


def outcome_legs(event):
    """[(label, clob token id, current price)] in canonical order, or a reason string.

    Canonical order matters: keepers only agree if their outcome lists match.
    Neg-risk legs: the most likely (ties by market id) are kept in market-id
    order, then the rest, which `group_other` folds into "Other".
    """
    markets = [m for m in event.get("markets") or [] if m.get("active") and not m.get("closed")]
    if not markets:
        return "no open markets"
    if event.get("negRisk") and len(markets) > 1:
        legs = []
        for m in markets:
            label = (m.get("groupItemTitle") or "").strip()
            prices, tokens = jlist(m.get("outcomePrices")), jlist(m.get("clobTokenIds"))
            if not label or not prices or not tokens:
                return "neg-risk leg %s lacks label or prices" % m.get("id")
            legs.append((bps(prices[0]), int(m["id"]), label, tokens[0]))
        legs.sort(key=lambda x: (-x[0], x[1]))
        # The kept outcomes go in market-id order, so two keepers whose prices
        # differ slightly still post the same list; the folded rest follows.
        k = len(legs) if len(legs) <= MAX_OUTCOMES else MAX_OUTCOMES - 1
        legs = sorted(legs[:k], key=lambda x: x[1]) + legs[k:]
        return [(label, tok, p) for p, _, label, tok in legs]
    # One market (or props around a main market): take the highest-volume one.
    m = max(markets, key=lambda m: (Decimal(str(m.get("volume24hr") or 0)), -int(m["id"])))
    labels, prices, tokens = jlist(m.get("outcomes")), jlist(m.get("outcomePrices")), jlist(m.get("clobTokenIds"))
    if not (2 <= len(labels) <= MAX_OUTCOMES and len(prices) == len(labels) == len(tokens)):
        return "market %s has %d outcomes" % (m.get("id"), len(labels))
    return [(str(l).strip(), t, bps(p)) for l, t, p in zip(labels, tokens, prices)]


def group_other(labels, odds, odds_6h):
    """Keep the first four outcomes and fold the rest into "Other"."""
    if len(labels) <= MAX_OUTCOMES:
        return labels, odds, odds_6h
    k = MAX_OUTCOMES - 1
    rest = lambda xs: max(0, BPS - sum(xs[:k]))
    return labels[:k] + ["Other"], odds[:k] + [rest(odds)], odds_6h[:k] + [rest(odds_6h)]


def price_at(history, target):
    """Last price at or before `target` (unix seconds), else the earliest after."""
    pts = sorted((int(p["t"]), p["p"]) for p in history)
    if not pts:
        return None
    before = [p for t, p in pts if t <= target]
    return before[-1] if before else pts[0][1]


def build_post(event, now, history):
    """One `MarketPostView` for the contract, or a reason string.

    history(token_id, target_ts) -> list of {"t", "p"} points (records raw bytes).
    """
    legs = outcome_legs(event)
    if isinstance(legs, str):
        return legs
    target = int(now.timestamp()) - SIX_HOURS
    k = len(legs) if len(legs) <= MAX_OUTCOMES else MAX_OUTCOMES - 1
    labels = [l for l, _, _ in legs]
    odds = [p for _, _, p in legs]
    odds_6h = []
    for _, tok, _ in legs[:k]:
        p = price_at(history(tok, target), target)
        if p is None:
            return "no price history six hours back"
        odds_6h.append(bps(p))
    odds_6h += [0] * (len(legs) - k)  # replaced by the Other fold below
    labels, odds, odds_6h = group_other(labels, odds, odds_6h)
    if len(set(labels)) != len(labels):
        return "duplicate outcome labels"
    if max(odds) >= MAX_TOP_ODDS:
        return "effectively decided (top outcome %d bps)" % max(odds)
    if max(odds) == 0 or min(odds) == BPS:
        return "degenerate odds"
    return {
        "market_id": str(event["id"]),
        "outcomes": labels,
        "odds": odds,
        "odds_6h": odds_6h,
    }


class Fetcher:
    """GET with a record of every raw response, for `raw_hash` and --save-raw."""

    def __init__(self):
        self.raw = []

    def get(self, url):
        req = urllib.request.Request(url, headers={"User-Agent": "antonomy-keeper/0", "Accept": "application/json"})
        with urllib.request.urlopen(req, timeout=20) as r:
            body = r.read()
        self.raw.append((url, body))
        return json.loads(body, parse_float=Decimal)

    def history(self, token, target):
        q = urllib.parse.urlencode({"market": token, "startTs": target - 7200, "endTs": target, "fidelity": 5})
        return self.get("%s/prices-history?%s" % (CLOB, q)).get("history") or []


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    ap.add_argument("--count", type=int, default=1, help="markets to post (contract MAX_TRENDING)")
    ap.add_argument("--scan", type=int, default=100, help="events to fetch, by 24h volume")
    ap.add_argument("--save-raw", metavar="DIR", help="write every raw response here")
    a = ap.parse_args(argv)

    now = dt.datetime.now(dt.timezone.utc)
    f = Fetcher()
    q = urllib.parse.urlencode({
        "active": "true", "closed": "false", "order": "volume24hr", "ascending": "false", "limit": a.scan,
    })
    events = f.get("%s/events?%s" % (GAMMA, q))
    listing = f.raw[0]

    out = []
    for e in events:
        if len(out) == a.count:
            break
        why = blocked(e) or floors(e, now)
        start = len(f.raw)
        post = why or build_post(e, now, f.history)
        if isinstance(post, str):
            print("skip %s %r: %s" % (e.get("id"), (e.get("title") or "")[:60], post), file=sys.stderr)
            continue
        used = [listing] + f.raw[start:]
        h = hashlib.sha256()
        for _, body in used:
            h.update(body)
        post["raw_hash"] = h.hexdigest()
        if a.save_raw:
            d = os.path.join(a.save_raw, post["market_id"])
            os.makedirs(d, exist_ok=True)
            for i, (url, body) in enumerate(used):
                with open(os.path.join(d, "%02d.json" % i), "wb") as fh:
                    fh.write(body)
            with open(os.path.join(d, "urls.txt"), "w") as fh:
                fh.write("".join(u + "\n" for u, _ in used))
        print("take %s %r" % (post["market_id"], (e.get("title") or "")[:60]), file=sys.stderr)
        out.append(post)

    if len(out) < a.count:
        print("only %d of %d markets passed the filters" % (len(out), a.count), file=sys.stderr)
    print(json.dumps({"markets": out}, indent=2))
    return 0 if out else 1


if __name__ == "__main__":
    sys.exit(main())
