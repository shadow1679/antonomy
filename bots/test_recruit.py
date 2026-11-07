"""Offline tests for bots/recruit.py, the Recruit the swarm agent tool (no
network, nothing signed). A fake chain answers the contract views from a few
stored requests; the finished one is a real run of the Python reference sim.

Run: python3 -I bots/test_recruit.py
"""
import hashlib
import io
import json
import os
import sys
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
sys.path.insert(0, os.path.join(HERE, "..", "sim", "python"))
import antosim  # noqa: E402
import recruit as r  # noqa: E402

ONE = 10**24
CONFIG = {"fee": str(100 * ONE), "keeper_bps": 2000, "agent_bps": 3000, "crank_bps": 1000,
          "odds_window_ms": 600_000, "forecast_window_ms": 1_800_000,
          "agent_deposit": str(10 * ONE), "crank_bounty": str(2 * ONE)}
MARKET = {"colony": 0x8000, "market_id": "fed-decision-in-december", "outcomes": ["Cut", "Hold", "Hike"],
          "odds": [6000, 2800, 1000], "odds_6h": [5500, 3300, 1200], "odds_hash": "00" * 32, "raw_hashes": []}


def done_request():
    """Request 0, finished: the stored hashes are a real run of the reference sim."""
    seed = hashlib.sha256(b"request-0").digest()
    agent_odds, agent_hash = [4500, 4000, 1500], hashlib.sha256(b"agents").digest()
    # A holder staked 25 on Hike during the agents' window: Community votes.
    weights, stake_hash = [0, 0, 5000], hashlib.sha256(b"stakes").digest()
    res = antosim.forecast_market(seed, 0x8000, MARKET["odds"], MARKET["odds_6h"], weights, stake_hash,
                                  agent_odds, agent_hash)
    return {
        "id": 0, "colony": 0x8000, "requester": "alice.testnet", "market_id": MARKET["market_id"],
        "fee": str(100 * ONE), "phase": "done", "created_at_ms": 0, "odds_by_ms": 600_000,
        "forecast_by_ms": 2_400_000, "keepers_posted": [], "market": MARKET,
        "agents": {"odds": agent_odds, "hash": agent_hash.hex(), "posts": []},
        "stakes": {"hash": stake_hash.hex(), "weights": weights,
                   "entries": [["bob.testnet", 0x8000, 2, str(25 * ONE)]]},
        "seed": seed.hex(), "colony_hashes": [c["hash"] for c in res["colonies"]],
        "crankers": ["c.testnet"] * 3, "swarm": res["swarm"], "market_hash": res["hash"],
        "paid_keepers": [], "paid_agents": [], "paid_cranks": [], "to_treasury": "0",
    }


def open_request(rid, slug, phase, **kw):
    out = {"id": rid, "colony": 0x8000 + rid, "requester": "bob.testnet", "market_id": slug,
           "fee": str(100 * ONE), "phase": phase, "created_at_ms": 0, "odds_by_ms": 600_000,
           "forecast_by_ms": None, "keepers_posted": [], "market": None, "agents": None, "stakes": None,
           "seed": None,
           "colony_hashes": [], "crankers": [], "swarm": None, "market_hash": None,
           "paid_keepers": [], "paid_agents": [], "paid_cranks": [], "to_treasury": "0"}
    out.update(kw)
    return out


DONE = done_request()


class FakeChain:
    """Answers the views recruit.py reads."""

    def __init__(self, requests, agents=(), trending=None):
        self.requests = list(requests)
        self.agents = set(agents)
        self.trending = trending

    def view(self, method, args=None):
        args = args or {}
        if method == "request_config":
            return CONFIG
        if method == "forecast_request_count":
            return len(self.requests)
        if method == "forecast_requests":
            return [q for q in self.requests if q["id"] >= args["from_id"]][: args["limit"]]
        if method == "forecast_request":
            return next((q for q in self.requests if q["id"] == args["request_id"]), None)
        if method == "is_agent":
            return args["account_id"] in self.agents
        if method == "forecast_markets":
            return self.trending
        raise AssertionError("unexpected view %s" % method)


def tool(chain, send=False, now=0, account="me.testnet"):
    """A Tool whose `run` records each NEAR CLI command; with send=True it also
    applies request_forecast to the fake chain, as the contract would."""
    calls = []

    def run(cmd):
        calls.append(cmd)
        if send and cmd[5] == "request_forecast":
            slug = json.loads(cmd[cmd.index("json-args") + 1])["market_id"]
            chain.requests.append(open_request(len(chain.requests), slug, "odds", requester=account))
        return send

    t = r.Tool(chain, "anto.testnet", account, "testnet", run, now_ms=lambda: now)
    return t, calls


def method_and_args(cmd):
    return cmd[5], json.loads(cmd[cmd.index("json-args") + 1])


class Verify(unittest.TestCase):
    def test_matches_a_real_run(self):
        out = r.verify(FakeChain([DONE]), 0)
        self.assertTrue(out["ok"], out)
        self.assertEqual([c["kind"] for c in out["colonies"]], list(r.KIND_NAMES))
        self.assertEqual(sum(out["swarm_belief"]), 10000)

    def test_catches_tampered_stakes(self):
        # Community reads the weights; every colony commits the stake hash.
        bad = dict(DONE, stakes=dict(DONE["stakes"], weights=[0, 0, 0]))
        out = r.verify(FakeChain([bad]), 0)
        self.assertEqual([c["match"] for c in out["colonies"]], [True, False, True])
        bad = dict(DONE, stakes=dict(DONE["stakes"], hash="00" * 32))
        out = r.verify(FakeChain([bad]), 0)
        self.assertFalse(out["ok"])
        self.assertEqual([c["match"] for c in out["colonies"]], [False] * 3)

    def test_catches_a_tampered_colony(self):
        bad = dict(DONE, colony_hashes=list(DONE["colony_hashes"]))
        bad["colony_hashes"][2] = "00" * 32
        out = r.verify(FakeChain([bad]), 0)
        self.assertFalse(out["ok"])
        self.assertEqual([c["match"] for c in out["colonies"]], [True] * 2 + [False])

    def test_needs_a_finished_request(self):
        chain = FakeChain([DONE, open_request(1, "x", "running")])
        self.assertIn("not finished", r.verify(chain, 1)["reason"])
        self.assertIn("no such", r.verify(chain, 9)["reason"])


class Ask(unittest.TestCase):
    def test_reads_an_existing_request_without_paying(self):
        t, calls = tool(FakeChain([DONE]))
        out = t.ask_swarm(MARKET["market_id"])
        self.assertEqual(calls, [])
        self.assertEqual(out["swarm_belief"], DONE["swarm"])
        self.assertIn("not advice", out["label"])

    def test_dry_run_prints_the_request_call(self):
        t, calls = tool(FakeChain([DONE]))
        out = t.ask_swarm("ecb-decision-december")
        self.assertFalse(out["sent"])
        self.assertEqual(out["fee"], "100")
        self.assertEqual(method_and_args(calls[0]), ("request_forecast", {"market_id": "ecb-decision-december"}))

    def test_send_finds_the_new_request(self):
        chain = FakeChain([DONE])
        t, _ = tool(chain, send=True)
        out = t.ask_swarm("ecb-decision-december")
        self.assertEqual((out["request_id"], out["phase"], out["sent"]), (1, "odds", True))

    def test_skipped_requests_are_asked_again(self):
        t, calls = tool(FakeChain([open_request(0, "thin-market", "skipped")]))
        t.ask_swarm("thin-market")
        self.assertEqual(method_and_args(calls[0])[0], "request_forecast")


class Post(unittest.TestCase):
    def forecasting(self):
        return open_request(1, "ecb-decision-december", "forecasting", forecast_by_ms=5_000,
                            market=dict(MARKET, colony=0x8001))

    def test_posts_on_the_request_colony(self):
        t, calls = tool(FakeChain([DONE, self.forecasting()], agents={"me.testnet"}))
        out = t.post_forecast([5000, 4000, 1000], request_id=1)
        self.assertEqual(method_and_args(calls[0]),
                         ("post_forecast", {"colony": 0x8001, "odds": [5000, 4000, 1000]}))
        self.assertEqual(out["outcomes"], ["Cut", "Hold", "Hike"])

    def test_refuses_what_the_contract_would(self):
        t, calls = tool(FakeChain([DONE, self.forecasting()], agents={"me.testnet"}))
        for odds, why in [([5000, 5000], "3 outcomes"), ([5000, 4000, 999], "exactly 10000"),
                          ([11000, -1000, 0], "0 to 10000")]:
            with self.assertRaises(ValueError) as e:
                t.post_forecast(odds, request_id=1)
            self.assertIn(why, str(e.exception))
        with self.assertRaises(ValueError) as e:
            t.post_forecast([5000, 4000, 1000], request_id=0)
        self.assertIn("phase done", str(e.exception))
        self.assertEqual(calls, [])

    def test_needs_registration(self):
        t, _ = tool(FakeChain([DONE, self.forecasting()]))
        with self.assertRaises(ValueError) as e:
            t.post_forecast([5000, 4000, 1000], request_id=1)
        self.assertIn("register", str(e.exception))

    def test_trending_colony(self):
        trending = [{"colony": 1, "outcomes": ["Yes", "No"]}]
        t, calls = tool(FakeChain([], agents={"me.testnet"}, trending=trending))
        t.post_forecast([7000, 3000], colony=1)
        self.assertEqual(method_and_args(calls[0]), ("post_forecast", {"colony": 1, "odds": [7000, 3000]}))
        with self.assertRaises(ValueError):
            t.post_forecast([7000, 3000], colony=2)

    def test_parse_odds(self):
        self.assertEqual(r.parse_odds("6000, 3000,1000"), [6000, 3000, 1000])
        with self.assertRaises(ValueError):
            r.parse_odds("60%,40%")


class Crank(unittest.TestCase):
    def test_calls_whatever_is_due(self):
        odds = open_request(0, "a", "odds")
        fc = open_request(1, "b", "forecasting", forecast_by_ms=5_000, market=MARKET)
        run = open_request(2, "c", "running", colony_hashes=["00" * 32])
        chain = FakeChain([odds, fc, run])
        early, _ = tool(chain, now=1_000)
        self.assertEqual(early.crank(0)["note"], "nothing due yet")
        self.assertEqual(early.crank(1)["note"], "nothing due yet")
        self.assertEqual(early.crank(2)["called"], "crank_request")
        late, calls = tool(chain, now=600_000)
        self.assertEqual(late.crank(0)["called"], "finalize_request_odds")
        self.assertEqual(late.crank(1)["called"], "crank_request")
        self.assertEqual(method_and_args(calls[0]), ("finalize_request_odds", {"request_id": 0}))

    def test_the_seed_drawing_crank_carries_the_drand_beacon(self):
        fc = open_request(1, "b", "forecasting", forecast_by_ms=5_000, market=MARKET, drand_round=77)
        chain = FakeChain([fc])
        t, calls = tool(chain, now=600_000)
        t.beacon = lambda rnd: None
        self.assertEqual(t.crank(1)["note"], "waiting for drand round 77")
        self.assertEqual(calls, [])
        t.beacon = lambda rnd: "ab" * 48 if rnd == 77 else None
        self.assertEqual(t.crank(1)["called"], "crank_request")
        self.assertEqual(method_and_args(calls[0]),
                         ("crank_request", {"request_id": 1, "drand_signature": "ab" * 48}))

    def test_wait_cranks_until_done(self):
        chain = FakeChain([open_request(0, "a", "running", colony_hashes=[])])
        t, _ = tool(chain, now=0)

        def crank_once(cmd):  # each crank adds a colony; the third finishes
            q = chain.requests[0]
            q["colony_hashes"].append("00" * 32)
            if len(q["colony_hashes"]) == 3:
                chain.requests[0] = dict(DONE, id=0)
            return True

        t.run = crank_once
        out = r.wait(t, 0, crank=True, sleep=lambda s: self.fail("should not sleep"))
        self.assertEqual(out["phase"], "done")


    def test_wait_posts_your_odds_when_agents_may(self):
        fc = open_request(1, "ecb-decision-december", "forecasting", forecast_by_ms=5_000,
                          market=dict(MARKET, colony=0x8001))
        chain = FakeChain([DONE, fc], agents={"me.testnet"})
        t, calls = tool(chain, now=0)
        sent = []

        def run(cmd):
            sent.append(method_and_args(cmd))
            if cmd[5] == "post_forecast":
                chain.requests[1] = dict(DONE, id=1)  # the window closes and the cranks run
            return True

        t.run = run
        out = r.wait(t, 1, crank=False, sleep=lambda s: self.fail("should not sleep"),
                     odds="Hike=1000,Cut=6000,Hold=3000")
        self.assertEqual(sent, [("post_forecast", {"colony": 0x8001, "odds": [6000, 3000, 1000]})])
        self.assertEqual(out["phase"], "done")

    def test_resolve_odds(self):
        outs = ["Cut", "Hold", "Hike"]
        self.assertEqual(r.resolve_odds("6000,3000,1000", outs), [6000, 3000, 1000])
        self.assertEqual(r.resolve_odds("Hold=3000, Cut=6000, Hike=1000", outs), [6000, 3000, 1000])
        for spec, why in [("Raise=1000,Cut=6000,Hold=3000", "no outcome"), ("Cut=6000,Hold=4000", "no odds for Hike"),
                          ("Cut=60%,Hold=30,Hike=10", "whole basis points")]:
            with self.assertRaises(ValueError) as e:
                r.resolve_odds(spec, outs)
            self.assertIn(why, str(e.exception))


class Mcp(unittest.TestCase):
    def roundtrip(self, chain, *msgs):
        t, calls = tool(chain)
        out = io.StringIO()
        r.serve_mcp(t, io.StringIO("".join(json.dumps(m) + "\n" for m in msgs)), out)
        return [json.loads(line) for line in out.getvalue().splitlines()], calls

    def test_handshake_and_tools(self):
        replies, _ = self.roundtrip(
            FakeChain([DONE]),
            {"jsonrpc": "2.0", "id": 1, "method": "initialize", "params": {"protocolVersion": "2025-06-18"}},
            {"jsonrpc": "2.0", "method": "notifications/initialized"},
            {"jsonrpc": "2.0", "id": 2, "method": "tools/list"},
        )
        self.assertEqual(len(replies), 2)  # no reply to the notification
        self.assertEqual(replies[0]["result"]["protocolVersion"], "2025-06-18")
        names = [x["name"] for x in replies[1]["result"]["tools"]]
        self.assertEqual(names, ["ask_swarm", "post_forecast", "verify"])

    def test_calls(self):
        replies, calls = self.roundtrip(
            FakeChain([DONE]),
            {"jsonrpc": "2.0", "id": 1, "method": "tools/call",
             "params": {"name": "ask_swarm", "arguments": {"market": MARKET["market_id"]}}},
            {"jsonrpc": "2.0", "id": 2, "method": "tools/call",
             "params": {"name": "verify", "arguments": {"request_id": 0}}},
            {"jsonrpc": "2.0", "id": 3, "method": "tools/call",
             "params": {"name": "post_forecast", "arguments": {"request_id": 0, "odds": [1, 2, 3]}}},
            {"jsonrpc": "2.0", "id": 4, "method": "nope"},
        )
        self.assertEqual(replies[0]["result"]["structuredContent"]["swarm_belief"], DONE["swarm"])
        self.assertTrue(replies[1]["result"]["structuredContent"]["ok"])
        self.assertTrue(replies[2]["result"]["isError"])
        self.assertEqual(replies[3]["error"]["code"], -32601)
        self.assertEqual(calls, [])


if __name__ == "__main__":
    unittest.main()
