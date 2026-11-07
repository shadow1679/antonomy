"""Antonomy keeper: read how the markets waiting in the scorebook resolved and
print the `post_resolutions` arguments for the contract.

Usage: python3 -I keeper/resolve.py --open open.json [--save-raw DIR] > args.json

`open.json` is the contract's `open_markets` view: a list of
{"market_id": SLUG, "outcomes": [[label, ...], ...]} (the outcome labels of
each of the market's books). For each slug the keeper reads the event from
the public Gamma API and posts its state, the winning outcome's label once
resolved, and the end date (docs/FORECAST_QUALITY.md §1). Several keepers do
this independently; the contract accepts a market's resolution once a quorum
posted the same state, winner and end date.

States:
  resolved     the outcome won, read from the closed market's prices (1 and 0)
  fifty_fifty  the closed market paid every outcome evenly
  proposed     an outcome was proposed to UMA and the challenge period runs
  disputed     the proposal was disputed
  open         otherwise

Which market: a neg-risk event (one market per outcome) resolves when one
leg's Yes settles at 1; that leg's label (`groupItemTitle`) is the winner, and
the contract maps a winner the post folded into "Other" onto "Other". Any
other event resolves with the market whose outcome labels match a book's, the
one with the highest lifetime volume when several match (a "Map 1 Winner" and
a "Match Winner" share labels); with no book labels, the highest-volume market.

`raw_hash` is sha256 over the raw event response; `--save-raw` keeps the bytes.
"""
import argparse
import hashlib
import json
import os
import sys
import urllib.parse
from decimal import Decimal

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
from trending import GAMMA, Fetcher, jlist, parse_time  # noqa: E402

MAX_POSTS = 50   # contract: resolutions per call


def end_ms(event):
    end = event.get("endDate")
    return int(parse_time(end).timestamp() * 1000) if end else 0


def pending_state(markets):
    """open, proposed or disputed, from UMA's status on the given markets."""
    status = " ".join(str(m.get("umaResolutionStatus") or "").lower() for m in markets)
    if "disput" in status or "challeng" in status:
        return "disputed"
    if "propos" in status:
        return "proposed"
    return "open"


def settled(m):
    """The closed market's settlement prices as Decimals, or None."""
    if not m.get("closed"):
        return None
    prices = [Decimal(str(p)) for p in jlist(m.get("outcomePrices"))]
    return prices if prices and sum(prices) == 1 else None


def pick_market(event, label_sets):
    """The event's market whose labels match a book's, else the busiest."""
    markets = event.get("markets") or []
    wanted = {tuple(ls) for ls in label_sets}
    labels = lambda m: tuple(str(x).strip() for x in jlist(m.get("outcomes")))
    matching = [m for m in markets if labels(m) in wanted] if wanted else markets
    if not matching:
        return None
    return max(matching, key=lambda m: (Decimal(str(m.get("volume") or 0)), -int(m["id"])))


def resolution(event, label_sets):
    """(state, winner) for one event."""
    markets = event.get("markets") or []
    if event.get("negRisk") and len(markets) > 1:
        for m in markets:
            p = settled(m)
            if p and p[0] == 1:
                return "resolved", (m.get("groupItemTitle") or "").strip()
        legs = [m for m in markets if settled(m) is not None]
        if legs and len(legs) == len(markets) and all(settled(m)[0] == settled(m)[1] for m in legs):
            return "fifty_fifty", ""
        return pending_state(markets), ""
    m = pick_market(event, label_sets)
    if m is None:
        return "open", ""
    p = settled(m)
    if p is not None:
        if len(set(p)) == 1:
            return "fifty_fifty", ""
        if max(p) == 1:
            labels = [str(x).strip() for x in jlist(m.get("outcomes"))]
            return "resolved", labels[p.index(max(p))]
    return pending_state([m]), ""


def read_post(f, market_id, label_sets, save_raw=None):
    """One `ResolutionPostView`, or None if the event can't be read."""
    start = len(f.raw)
    found = f.get("%s/events?%s" % (GAMMA, urllib.parse.urlencode({"slug": market_id})))
    event = found[0] if found else None
    if not event or event.get("slug") != market_id:
        return None
    state, winner = resolution(event, label_sets)
    used = f.raw[start:]
    if save_raw:
        d = os.path.join(save_raw, "resolve", market_id)
        os.makedirs(d, exist_ok=True)
        for i, (_, body) in enumerate(used):
            with open(os.path.join(d, "%02d.json" % i), "wb") as fh:
                fh.write(body)
    return {
        "market_id": market_id,
        "state": state,
        "winner": winner,
        "end_ms": end_ms(event),
        "raw_hash": hashlib.sha256(b"".join(body for _, body in used)).hexdigest(),
    }


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    ap.add_argument("--open", required=True, metavar="FILE", help="the open_markets view as JSON ('-' for stdin)")
    ap.add_argument("--save-raw", metavar="DIR", help="write every raw response here")
    a = ap.parse_args(argv)
    src = sys.stdin if a.open == "-" else open(a.open)
    todo = json.load(src)[:MAX_POSTS]
    f = Fetcher()
    out = []
    for m in todo:
        try:
            post = read_post(f, m["market_id"], m.get("outcomes") or [], a.save_raw)
        except (OSError, ValueError) as e:
            print("skip %s: %s" % (m["market_id"], e), file=sys.stderr)
            continue
        if post is None:
            print("skip %s: no such event" % m["market_id"], file=sys.stderr)
            continue
        print("read %s: %s %s" % (post["market_id"], post["state"], post["winner"]), file=sys.stderr)
        out.append(post)
    print(json.dumps({"resolutions": out}, indent=2))
    return 0 if out else 1


if __name__ == "__main__":
    sys.exit(main())
