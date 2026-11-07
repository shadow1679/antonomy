"""Offline tests for keeper/resolve.py (no network).

Run: python3 -I keeper/test_resolve.py
"""
import hashlib
import json
import os
import sys
import unittest

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import resolve as r  # noqa: E402


def market(mid, prices, labels=("Yes", "No"), title=None, closed=False, uma=None, vol=1000):
    return {
        "id": str(mid), "groupItemTitle": title, "closed": closed, "umaResolutionStatus": uma,
        "outcomes": json.dumps(list(labels)), "outcomePrices": json.dumps([str(p) for p in prices]),
        "volume": vol,
    }


def event(markets, neg=False, slug="cup", **kw):
    e = {"slug": slug, "negRisk": neg, "endDate": "2026-11-20T00:00:00Z", "markets": markets}
    e.update(kw)
    return e


class Resolution(unittest.TestCase):
    def test_single_market_states(self):
        teams = ("Alter Ego", "NEXVOID")
        self.assertEqual(r.resolution(event([market(1, ["0.6", "0.4"], teams)]), []), ("open", ""))
        self.assertEqual(r.resolution(event([market(1, ["0.6", "0.4"], teams, uma="proposed")]), []),
                         ("proposed", ""))
        self.assertEqual(r.resolution(event([market(1, ["0.6", "0.4"], teams, uma="disputed")]), []),
                         ("disputed", ""))
        done = market(1, ["0", "1"], teams, closed=True, uma="resolved")
        self.assertEqual(r.resolution(event([done]), [list(teams)]), ("resolved", "NEXVOID"))
        split = market(1, ["0.5", "0.5"], closed=True, uma="resolved")
        self.assertEqual(r.resolution(event([split]), []), ("fifty_fifty", ""))
        # Closed but not settled yet: still pending.
        self.assertEqual(r.resolution(event([market(1, ["0.6", "0.4"], closed=True)]), []), ("open", ""))

    def test_the_book_labels_pick_the_market(self):
        teams = ("Alter Ego", "NEXVOID")
        map1 = market(1, ["0", "1"], teams, closed=True, vol=18_000)
        match = market(2, ["1", "0"], teams, closed=True, vol=57_000)
        ou = market(3, ["1", "0"], ("Over", "Under"), closed=True, vol=90_000)
        e = event([map1, match, ou])
        # Both winner markets carry the book's labels: the busier one decides.
        self.assertEqual(r.resolution(e, [list(teams)]), ("resolved", "Alter Ego"))
        self.assertEqual(r.resolution(e, []), ("resolved", "Over"))
        self.assertEqual(r.resolution(e, [["Up", "Down"]]), ("open", ""))

    def test_neg_risk_waits_for_a_yes(self):
        legs = [
            market(1, ["0", "1"], title="G2 Esports", closed=True, uma="resolved"),
            market(2, ["0.7", "0.3"], title="T1"),
            market(3, ["0.3", "0.7"], title="Gen.G"),
        ]
        self.assertEqual(r.resolution(event(legs, neg=True), []), ("open", ""))
        legs[1]["umaResolutionStatus"] = "proposed"
        self.assertEqual(r.resolution(event(legs, neg=True), []), ("proposed", ""))
        legs[1].update(closed=True, outcomePrices=json.dumps(["1", "0"]), umaResolutionStatus="resolved")
        self.assertEqual(r.resolution(event(legs, neg=True), []), ("resolved", "T1"))

    def test_read_post_hashes_the_raw_event(self):
        body = json.dumps([event([market(1, ["1", "0"], closed=True)], slug="cup")]).encode()

        class F:
            raw = []

            def get(self, url):
                self.raw.append((url, body))
                return json.loads(body)

        p = r.read_post(F(), "cup", [["Yes", "No"]])
        self.assertEqual(p, {
            "market_id": "cup", "state": "resolved", "winner": "Yes", "end_ms": 1795132800000,
            "raw_hash": hashlib.sha256(body).hexdigest(),
        })
        self.assertIsNone(r.read_post(F(), "other-slug", []))


if __name__ == "__main__":
    unittest.main()
