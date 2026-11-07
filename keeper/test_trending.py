"""Offline tests for keeper/trending.py (no network).

Run: python3 -I keeper/test_trending.py
"""
import datetime as dt
import json
import os
import sys
import unittest
from decimal import Decimal

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import trending as t  # noqa: E402

NOW = dt.datetime(2026, 11, 3, 12, tzinfo=dt.timezone.utc)


def market(mid, prices, labels=("Yes", "No"), title=None, vol=1000):
    return {
        "id": str(mid), "question": "q%s" % mid, "groupItemTitle": title, "active": True, "closed": False,
        "outcomes": json.dumps(list(labels)), "outcomePrices": json.dumps([str(p) for p in prices]),
        "clobTokenIds": json.dumps(["tok%s-%d" % (mid, i) for i in range(len(labels))]), "volume24hr": vol,
    }


def event(markets, neg=False, **kw):
    e = {
        "id": "77", "title": "Who wins the cup?", "active": True, "closed": False, "negRisk": neg,
        "volume24hr": 500_000, "liquidity": 200_000, "endDate": "2026-11-20T00:00:00Z",
        "tags": [{"label": "Sports"}], "markets": markets,
    }
    e.update(kw)
    return e


def flat_history(price):
    return lambda tok, target: [{"t": target - 60, "p": Decimal(price)}, {"t": target + 60, "p": Decimal("0.99")}]


class Filters(unittest.TestCase):
    def test_floors(self):
        self.assertIsNone(t.floors(event([]), NOW))
        self.assertIn("volume", t.floors(event([], volume24hr=10), NOW))
        self.assertIn("liquidity", t.floors(event([], liquidity=None), NOW))
        self.assertIn("ends in", t.floors(event([], endDate="2026-11-03T18:00:00Z"), NOW))
        self.assertIn("ends in", t.floors(event([], endDate="2027-06-01T00:00:00Z"), NOW))
        self.assertEqual(t.floors(event([], closed=True), NOW), "not open")

    def test_content_filter(self):
        self.assertIsNone(t.blocked(event([market(1, [0.5, 0.5])])))
        self.assertEqual(t.blocked(event([], tags=[{"label": "Geopolitics"}])), "tag geopolitics")
        self.assertIn("word", t.blocked(event([], title="Will X be killed by June?")))
        m = market(1, [0.5, 0.5])
        m["question"] = "Ceasefire before 2027?"
        self.assertIn("word", t.blocked(event([m])))
        # Word boundaries: "Warriors" is not "war".
        self.assertIsNone(t.blocked(event([], title="Warriors vs. Lakers")))


class Posts(unittest.TestCase):
    def test_binary_market(self):
        p = t.build_post(event([market(5, ["0.62", "0.38"])]), NOW, flat_history("0.55"))
        self.assertEqual(p, {"market_id": "77", "outcomes": ["Yes", "No"], "odds": [6200, 3800], "odds_6h": [5500, 5500]})

    def test_props_use_highest_volume_market(self):
        main = market(5, ["0.3", "0.7"], ("Home", "Away"), vol=9000)
        prop = market(6, ["0.5", "0.5"], ("Odd", "Even"), vol=10)
        p = t.build_post(event([prop, main]), NOW, flat_history("0.3"))
        self.assertEqual(p["outcomes"], ["Home", "Away"])

    def test_neg_risk_folds_other_and_orders_by_id(self):
        legs = [market(10 + i, [str(pr), str(1 - pr)], title="P%d" % i)
                for i, pr in enumerate([0.05, 0.40, 0.25, 0.15, 0.10, 0.05])]
        p = t.build_post(event(legs, neg=True), NOW, flat_history("0.2"))
        # Top four by price are P1, P2, P3, P4; kept in market-id order.
        self.assertEqual(p["outcomes"], ["P1", "P2", "P3", "P4", "Other"])
        self.assertEqual(p["odds"], [4000, 2500, 1500, 1000, 1000])
        self.assertEqual(p["odds_6h"], [2000, 2000, 2000, 2000, 2000])

    def test_neg_risk_order_is_stable_under_small_moves(self):
        a = [market(20, ["0.30", "0.70"], title="A"), market(21, ["0.31", "0.69"], title="B")]
        b = [market(20, ["0.32", "0.68"], title="A"), market(21, ["0.31", "0.69"], title="B")]
        pa = t.build_post(event(a, neg=True), NOW, flat_history("0.3"))
        pb = t.build_post(event(b, neg=True), NOW, flat_history("0.3"))
        self.assertEqual(pa["outcomes"], pb["outcomes"])

    def test_rejects_decided_and_missing_history(self):
        self.assertIn("decided", t.build_post(event([market(5, ["0.99", "0.01"])]), NOW, flat_history("0.9")))
        none = lambda tok, target: []
        self.assertIn("history", t.build_post(event([market(5, ["0.6", "0.4"])]), NOW, none))

    def test_price_at_takes_last_point_before_target(self):
        h = [{"t": 100, "p": Decimal("0.1")}, {"t": 200, "p": Decimal("0.2")}, {"t": 300, "p": Decimal("0.3")}]
        self.assertEqual(t.price_at(h, 250), Decimal("0.2"))
        self.assertEqual(t.price_at(h, 50), Decimal("0.1"))
        self.assertIsNone(t.price_at([], 50))

    def test_trending_posts_the_slug_when_the_event_has_one(self):
        e = event([market(5, ["0.62", "0.38"])], slug="fed-decision-in-december")
        p = t.build_post(e, NOW, flat_history("0.55"))
        self.assertEqual(p["market_id"], "fed-decision-in-december")

    def test_bps_rounds_half_even_and_clamps(self):
        self.assertEqual(t.bps("0.00005"), 0)
        self.assertEqual(t.bps("0.00015"), 2)
        self.assertEqual(t.bps("1.2"), 10000)


class Retry(unittest.TestCase):
    def test_a_dropped_connection_is_retried_then_succeeds(self):
        import http.client
        import io
        import unittest.mock as mock
        calls = []

        class Resp(io.BytesIO):
            def __enter__(self): return self
            def __exit__(self, *a): return False

        class Flaky(Resp):
            def read(self, *a):
                raise http.client.IncompleteRead(b"")

        def opener(req, timeout=0):
            calls.append(1)
            return Flaky() if len(calls) < 3 else Resp(b'{"ok": 1}')

        with mock.patch.object(t.urllib.request, "urlopen", opener), mock.patch.object(t.time, "sleep"):
            self.assertEqual(t.Fetcher().get("http://x"), {"ok": 1})
        self.assertEqual(len(calls), 3)

    def test_gives_up_after_the_last_attempt(self):
        import unittest.mock as mock

        def opener(req, timeout=0):
            raise OSError("down")

        with mock.patch.object(t.urllib.request, "urlopen", opener), mock.patch.object(t.time, "sleep"):
            with self.assertRaises(OSError):
                t.Fetcher().get("http://x")


class Requested(unittest.TestCase):
    SLUG = "fed-decision-in-december"

    def test_skips_trending_floors_and_posts_under_the_slug(self):
        e = event([market(5, ["0.62", "0.38"])], slug=self.SLUG, volume24hr=10, liquidity=0)
        self.assertIsNotNone(t.floors(e, NOW))
        p = t.request_post(e, NOW, self.SLUG, flat_history("0.55"))
        self.assertEqual(p["market_id"], self.SLUG)
        self.assertEqual(p["odds"], [6200, 3800])

    def test_still_filters_content_and_checks_open_and_slug(self):
        hist = flat_history("0.5")
        bad = event([market(5, ["0.5", "0.5"])], slug=self.SLUG, title="Will X be killed by June?")
        self.assertIn("word", t.request_post(bad, NOW, self.SLUG, hist))
        shut = event([market(5, ["0.5", "0.5"])], slug=self.SLUG, closed=True)
        self.assertEqual(t.request_post(shut, NOW, self.SLUG, hist), "not open")
        self.assertIn("no event", t.request_post({}, NOW, self.SLUG, hist))
        decided = event([market(5, ["0.99", "0.01"])], slug=self.SLUG)
        self.assertIn("decided", t.request_post(decided, NOW, self.SLUG, hist))

    def test_seal_hashes_every_raw_response(self):
        p = {"market_id": self.SLUG}
        t.seal(p, [("u1", b"a"), ("u2", b"b")], None)
        import hashlib
        self.assertEqual(p["raw_hash"], hashlib.sha256(b"ab").hexdigest())


if __name__ == "__main__":
    unittest.main()
