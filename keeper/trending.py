"""Antonomy keeper: pick the round's trending Polymarket markets and print the
`post_trending` arguments for the contract, or read one requested market and
print the `post_request_odds` arguments.

Usage: python3 -I keeper/trending.py [--count N] [--save-raw DIR] > args.json
       python3 -I keeper/trending.py --request ID --market SLUG [--save-raw DIR] > args.json

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
before now - 6h. The same history (one fetch per outcome, the last 26 hours
at 10-minute fidelity) gives the odds 1 hour and 24 hours ago, posted as
`odds_1h` and `odds_24h` for Momentum's three windows
(docs/FORECAST_QUALITY.md §5); a market whose history doesn't reach back a
day is posted without them. `raw_hash` is sha256 over every raw response the
post was built from, in fetch order; `--save-raw` keeps the bytes so anyone
can check it.

On request (Recruit the swarm): someone paid the fee for a forecast on the
Polymarket event with slug SLUG, and the contract gave it request id ID. The
keeper reads that one event (`/events?slug=`), skips the trending floors
(volume, liquidity, end date: the requester chose the market), but still
applies the content filter, the open check and the decided check, and posts
with `market_id` set to the slug, which is what the contract matches on. A
market the filter blocks is not posted (exit status 1); without a keeper
quorum the contract skips the request and refunds the fee.

Post with the NEAR CLI, for example:
  near contract call-function as-transaction <contract> post_trending \\
    file-args args.json prepaid-gas '100.0 Tgas' attached-deposit '0 NEAR' \\
    sign-as <keeper> network-config testnet sign-with-keychain send
(`post_request_odds` the same way for a request.)

Not checked yet: Polymarket's terms for display and redistribution. Read-only,
no authentication, no links to the market are published.
"""
import argparse
import gzip
import http.client
import time
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
ONE_HOUR = 3600
ONE_DAY = 24 * 3600
HISTORY_SPAN = 26 * 3600          # one fetch covers every window, with room before the day
HISTORY_FIDELITY = 10             # minutes between points

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


def group_other(labels, *series):
    """Keep the first four outcomes and fold the rest into "Other", in every
    odds series given (now, six hours ago, ...)."""
    if len(labels) <= MAX_OUTCOMES:
        return (labels,) + series
    k = MAX_OUTCOMES - 1
    rest = lambda xs: max(0, BPS - sum(xs[:k]))
    return (labels[:k] + ["Other"],) + tuple(xs[:k] + [rest(xs)] for xs in series)


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
    ts = int(now.timestamp())
    target = ts - SIX_HOURS
    k = len(legs) if len(legs) <= MAX_OUTCOMES else MAX_OUTCOMES - 1
    labels = [l for l, _, _ in legs]
    odds = [p for _, _, p in legs]
    odds_6h, odds_1h, odds_24h = [], [], []
    for _, tok, _ in legs[:k]:
        p = price_at(history(tok, target), target)
        if p is None:
            return "no price history six hours back"
        odds_6h.append(bps(p))
        for back, out in ((ONE_HOUR, odds_1h), (ONE_DAY, odds_24h)):
            pts = [x for x in history(tok, ts - back) if int(x["t"]) <= ts - back]
            out.append(bps(price_at(pts, ts - back)) if pts else None)
    pad = [0] * (len(legs) - k)  # replaced by the Other fold below
    windows = None not in odds_1h + odds_24h
    if windows:
        labels, odds, odds_6h, odds_1h, odds_24h = group_other(labels, odds, odds_6h + pad, odds_1h + pad, odds_24h + pad)
    else:
        labels, odds, odds_6h = group_other(labels, odds, odds_6h + pad)
    if len(set(labels)) != len(labels):
        return "duplicate outcome labels"
    if max(odds) >= MAX_TOP_ODDS:
        return "effectively decided (top outcome %d bps)" % max(odds)
    if max(odds) == 0 or min(odds) == BPS:
        return "degenerate odds"
    post = {
        # The slug is readable on the pages and links to the event; the id is
        # the fallback for an event without one.
        "market_id": str(event.get("slug") or event["id"]),
        "outcomes": labels,
        "odds": odds,
        "odds_6h": odds_6h,
    }
    if windows:
        post["odds_1h"], post["odds_24h"] = odds_1h, odds_24h
    return post


def request_post(event, now, slug, history):
    """The `market` argument of `post_request_odds` for a requested slug, or a
    reason string. No trending floors; filter, open and decided checks apply."""
    if event.get("slug") != slug:
        return "no event with slug %r" % slug
    why = blocked(event)
    if why:
        return why
    if event.get("closed") or not event.get("active"):
        return "not open"
    post = build_post(event, now, history)
    if isinstance(post, str):
        return post
    post["market_id"] = slug
    return post


def seal(post, used, save_raw):
    """Set `raw_hash` over the raw responses `used`, and keep them if asked."""
    h = hashlib.sha256()
    for _, body in used:
        h.update(body)
    post["raw_hash"] = h.hexdigest()
    if save_raw:
        d = os.path.join(save_raw, post["market_id"])
        os.makedirs(d, exist_ok=True)
        for i, (url, body) in enumerate(used):
            with open(os.path.join(d, "%02d.json" % i), "wb") as fh:
                fh.write(body)
        with open(os.path.join(d, "urls.txt"), "w") as fh:
            fh.write("".join(u + "\n" for u, _ in used))


RETRIES = 4
RETRY_PAUSE_S = 1.5


class Fetcher:
    """GET with a record of every raw response, for `raw_hash` and --save-raw."""

    def __init__(self):
        self.raw = []
        self.series = {}

    def get(self, url):
        # Polymarket answers a large page (limit above 50) only to clients that
        # accept gzip (HTTP 406 gzip_required otherwise). The raw record, and so
        # `raw_hash`, is the decompressed body: the same bytes whatever the
        # transport did.
        req = urllib.request.Request(url, headers={"User-Agent": "antonomy-keeper/0", "Accept": "application/json",
                                                   "Accept-Encoding": "gzip"})
        # A dropped connection mid-read is routine; a keeper that crashes on
        # one misses the round, so retry a few times before giving up.
        for attempt in range(RETRIES):
            try:
                with urllib.request.urlopen(req, timeout=20) as r:
                    body = r.read()
                    if r.headers.get("Content-Encoding", "").lower() == "gzip":
                        body = gzip.decompress(body)
                break
            except (OSError, http.client.HTTPException):
                if attempt == RETRIES - 1:
                    raise
                time.sleep(RETRY_PAUSE_S * (attempt + 1))
        self.raw.append((url, body))
        return json.loads(body, parse_float=Decimal)

    def history(self, token, target):
        """The token's price points over the last `HISTORY_SPAN`, fetched once
        and shared by every window (`target` only has to fall inside it)."""
        if token not in self.series:
            end = int(time.time())
            q = urllib.parse.urlencode({"market": token, "startTs": end - HISTORY_SPAN, "endTs": end,
                                        "fidelity": HISTORY_FIDELITY})
            self.series[token] = self.get("%s/prices-history?%s" % (CLOB, q)).get("history") or []
        return self.series[token]


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    ap.add_argument("--count", type=int, default=12, help="markets to post (contract MAX_TRENDING)")
    ap.add_argument("--scan", type=int, default=100, help="events to fetch, by 24h volume")
    ap.add_argument("--save-raw", metavar="DIR", help="write every raw response here")
    ap.add_argument("--request", type=int, metavar="ID", help="requested market: the contract's request id")
    ap.add_argument("--market", metavar="SLUG", help="requested market: the Polymarket event slug it names")
    a = ap.parse_args(argv)
    if (a.request is None) != (a.market is None):
        ap.error("--request and --market go together")

    now = dt.datetime.now(dt.timezone.utc)
    f = Fetcher()
    if a.request is not None:
        found = f.get("%s/events?%s" % (GAMMA, urllib.parse.urlencode({"slug": a.market})))
        e = found[0] if found else {}
        post = request_post(e, now, a.market, f.history)
        if isinstance(post, str):
            print("refuse request %d %r: %s" % (a.request, a.market, post), file=sys.stderr)
            return 1
        seal(post, f.raw, a.save_raw)
        print("take request %d %r" % (a.request, (e.get("title") or "")[:60]), file=sys.stderr)
        print(json.dumps({"request_id": a.request, "market": post}, indent=2))
        return 0

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
        seal(post, [listing] + f.raw[start:], a.save_raw)
        print("take %s %r" % (post["market_id"], (e.get("title") or "")[:60]), file=sys.stderr)
        out.append(post)

    if len(out) < a.count:
        print("only %d of %d markets passed the filters" % (len(out), a.count), file=sys.stderr)
    print(json.dumps({"markets": out}, indent=2))
    return 0 if out else 1


if __name__ == "__main__":
    sys.exit(main())
