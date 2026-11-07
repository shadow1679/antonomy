"""Offline tests for keeper/demo.py and the daemon's use of it: a fake chain
stands in for the views. Run: python3 -I keeper/test_demo.py"""
import os
import sys
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import daemon as op  # noqa: E402
import demo  # noqa: E402

ONE = demo.ONE
S, T = "sugar.t", "req.t"
K1, K2 = "k1.t", "k2.t"
NOW = 1_000                         # ms; the round closes at 5_000


class Fake:
    def __init__(self, **views):
        self.v = {
            "round_status": {"phase": "posting", "round": 7, "close_at_ms": 5_000, "publish_at_ms": 9_000,
                             "markets": None},
            "keepers": [[K1, K2], 2],
            "keeper_post": lambda a: POSTS[a["account_id"]],
            "stake_config": {"cap_per_wallet": str(100 * ONE)},
            "ft_balance_of": str(100 * ONE),
            "staked_by": "0",
            "stakes_of": [],
            "burn_run": None,
            "stake_weights": ["0"] * 5,
            "forecast_request_count": 0,
            "forecast_requests": [],
            "forecast_markets": None,
            "request_config": {"fee": str(100 * ONE), "agent_deposit": str(10 * ONE)},
            "has_claimed": True,
            "faucet_amount": str(150 * ONE),
        }
        self.v.update(views)

    def view(self, method, args=None):
        v = self.v[method]
        return v(args) if callable(v) else v


def market(slug, odds, outcomes=None):
    return {"market_id": slug, "outcomes": outcomes or ["o%d" % i for i in range(len(odds))], "odds": odds}


POSTS = {
    K1: [market("a", [7000, 3000]), market("b", [500, 1500, 8000]), market("c", [5000, 5000])],
    K2: [market("a", [7400, 2600]), market("b", [700, 1300, 8000]), market("c", [5000, 5000])],
}


def staked_on(steps):
    return {(s["args"]["colony"], s["args"]["option"]) for s in steps if s["method"] == "stake"}


class Shapes(unittest.TestCase):
    def test_every_style_sums_to_exactly_10000(self):
        for style in demo.AGENT_STYLES:
            for odds in ([6000, 4000], [25, 45, 2000, 7750, 250], [0, 0, 0], [3333, 3333, 3334]):
                out = demo.shape(style, odds, ("a", 1, 2))
                self.assertEqual((sum(out), len(out)), (10_000, len(odds)), (style, odds))

    def test_sharp_leans_into_the_favourite_and_flat_hedges(self):
        self.assertGreater(demo.shape("sharp", [7000, 3000], "k")[0], 7000)
        self.assertLess(demo.shape("flat", [7000, 3000], "k")[0], 7000)
        self.assertEqual(demo.shape("baseline", [7000, 3000], "k"), [7000, 3000])

    def test_noisy_is_deterministic(self):
        self.assertEqual(demo.shape("noisy", [6000, 4000], "k"), demo.shape("noisy", [6000, 4000], "k"))

    def test_staker_styles_pick_different_options(self):
        odds = [500, 1500, 8000]
        self.assertEqual(demo.pick_option("follower", odds, "k"), 2)
        self.assertEqual(demo.pick_option("contrarian", odds, "k"), 0)
        self.assertIn(demo.pick_option("mixed", odds, "k"), (0, 1, 2))

    def test_personas_refuse_an_unknown_style(self):
        self.assertEqual(demo.parse_personas(["a:flat", "b"], demo.AGENT_STYLES, "sharp"),
                         [("a", "flat"), ("b", "sharp")])
        with self.assertRaises(SystemExit):
            demo.parse_personas(["a:wild"], demo.AGENT_STYLES, "sharp")


class Agreed(unittest.TestCase):
    def test_median_odds_of_the_quorum_list(self):
        mk = demo.agreed_markets(Fake())
        self.assertEqual([m["market_id"] for m in mk], ["a", "b", "c"])
        self.assertEqual(mk[0]["odds"], [7400, 3000])           # upper median of two, per outcome

    def test_no_list_without_a_quorum(self):
        f = Fake(keeper_post=lambda a: POSTS[K1] if a["account_id"] == K1 else None)
        self.assertIsNone(demo.agreed_markets(f))
        f = Fake(keeper_post=lambda a: POSTS[K1] if a["account_id"] == K1 else [market("z", [5000, 5000])])
        self.assertIsNone(demo.agreed_markets(f))


class Staker(unittest.TestCase):
    def steps(self, f, now=NOW, style="follower", burned=None):
        rs = f.view("round_status")
        return demo.staker_steps(f, S, style, now, rs, demo.recent_requests(f), {} if burned is None else burned)

    def test_backs_round_markets_while_staking_is_open(self):
        s = [x for x in self.steps(Fake()) if x["args"]["colony"] != 0]
        self.assertTrue(0 < len(s) <= demo.ROUND_PICKS)
        for x in s:
            self.assertEqual((x["account"], x["by"]), (S, 5_000))
            self.assertEqual(x["args"]["amount"], str(demo.ROUND_STAKE))
        favourite = {1: 0, 2: 2, 3: 0}                          # follower backs the favourite
        for colony, option in staked_on(s):
            self.assertEqual(option, favourite[colony])

    def test_the_pick_limit_counts_stakes_it_already_holds(self):
        held = [[c, 0, str(demo.ROUND_STAKE)] for c in range(1, demo.ROUND_PICKS + 1)]
        s = [x for x in self.steps(Fake(stakes_of=held)) if x["args"]["colony"] != 0]
        self.assertEqual(s, [])

    def test_nothing_on_round_markets_once_staking_closed(self):
        s = self.steps(Fake(), now=5_000)
        self.assertEqual([x for x in s if x["args"]["colony"] != 0], [])

    def test_skips_colonies_it_already_holds(self):
        first = self.steps(Fake())
        held = [[x["args"]["colony"], x["args"]["option"], x["args"]["amount"]] for x in first
                if x["args"]["colony"] != 0]
        again = self.steps(Fake(stakes_of=held))
        self.assertEqual([x for x in again if x["args"]["colony"] in {h[0] for h in held}], [])

    def test_does_not_overspend_a_small_balance(self):
        s = [x for x in self.steps(Fake(ft_balance_of=str(4 * ONE))) if x["args"]["colony"] != 0]
        self.assertLessEqual(len(s), 1)

    def test_burn_stake_once_per_burn_day_and_within_budget(self):
        burned = {}
        first = [x for x in self.steps(Fake(), burned=burned) if x["args"]["colony"] == 0]
        self.assertEqual(len(first), 1)
        self.assertLessEqual(int(first[0]["args"]["amount"]), demo.BURN_BUDGET)
        self.assertEqual([x for x in self.steps(Fake(), burned=burned) if x["args"]["colony"] == 0], [])
        full = Fake(stakes_of=[[0, 1, str(demo.BURN_BUDGET)]])
        self.assertEqual([x for x in self.steps(full) if x["args"]["colony"] == 0], [])

    def test_stakes_a_request_only_while_its_agents_window_is_open(self):
        r = {"id": 3, "colony": 0x8003, "phase": "forecasting", "forecast_by_ms": 2_000,
             "market": {"odds": [2000, 8000]}, "requester": "x", "market_id": "r", "created_at_ms": 0}
        f = Fake(round_status={"phase": "done", "round": 7, "close_at_ms": 0, "publish_at_ms": 0, "markets": [{}]},
                 forecast_request_count=4, forecast_requests=[r])
        self.assertIn((0x8003, 1), staked_on(self.steps(f)))
        self.assertNotIn(0x8003, {c for c, _ in staked_on(self.steps(f, now=2_000))})

    def test_withdraws_the_stake_of_a_finished_request(self):
        held = [[0x8001, 1, str(5 * ONE)]]
        f = Fake(stakes_of=held, forecast_request=lambda a: {"phase": "done"})
        s = [x for x in self.steps(f) if x["method"] == "unstake"]
        self.assertEqual([x["args"] for x in s], [{"colony": 0x8001, "option": 1, "amount": str(5 * ONE)}])
        f = Fake(stakes_of=held, forecast_request=lambda a: {"phase": "running"})
        self.assertEqual([x for x in self.steps(f) if x["method"] == "unstake"], [])


class Recruit(unittest.TestCase):
    def mine(self, **kw):
        return dict({"id": 0, "requester": T, "market_id": "old", "phase": "done", "created_at_ms": 0}, **kw)

    def steps(self, requests, now=10**9, **views):
        f = Fake(**views)
        return demo.recruit_steps(f, T, now, requests, ["in-round"], 2, 1_000)

    def test_asks_for_a_market_outside_the_round_and_past_requests(self):
        s = self.steps([self.mine()])
        self.assertEqual([x["method"] for x in s], ["request_forecast"])
        self.assertEqual(s[0]["read"], ("recruit", ["in-round", "old"]))
        self.assertEqual(demo.pick_market([{"market_id": "old"}, {"market_id": "x"}], {"old"}), {"market_id": "x"})
        self.assertIsNone(demo.pick_market([{"market_id": "old"}], {"old"}))

    def test_stops_at_the_max_waits_for_the_open_one_and_the_gap(self):
        self.assertEqual(self.steps([self.mine(id=0), self.mine(id=1)]), [])
        self.assertEqual(self.steps([self.mine(phase="running")]), [])
        self.assertEqual(self.steps([self.mine(created_at_ms=10**9 - 10)]), [])

    def test_needs_the_fee_and_claims_the_faucet_once(self):
        self.assertEqual(self.steps([], ft_balance_of="0"), [])
        s = self.steps([], ft_balance_of="0", has_claimed=False)
        self.assertEqual([x["method"] for x in s], ["claim_play_tokens", "request_forecast"])

    def test_other_accounts_requests_do_not_count(self):
        self.assertEqual([x["method"] for x in self.steps([self.mine(requester="someone")] * 3)], ["request_forecast"])


class Memoised(unittest.TestCase):
    def test_identical_views_are_read_once(self):
        n = []
        f = Fake(round_status=lambda a: n.append(1) or {"phase": "done", "round": 1, "close_at_ms": 0,
                                                       "publish_at_ms": 0, "markets": [{}]})
        demo.crew_steps(f, demo.Crew(stakers=[(S, "follower"), ("b.t", "mixed")], agents=[("c.t", "sharp")]), NOW)
        self.assertEqual(len(n), 1)


class Crew(unittest.TestCase):
    def test_a_persona_whose_reads_fail_is_skipped_not_fatal(self):
        def boom(a):
            raise RuntimeError("rpc down")
        log = []
        crew = demo.Crew(stakers=[(S, "follower")], agents=[("ag.t", "sharp")])
        f = Fake(ft_balance_of=boom, agent_snapshot={"posts": []}, is_agent=True)
        self.assertEqual(demo.crew_steps(f, crew, NOW, log.append), [])
        self.assertEqual(len(log), 1)                           # the staker; the agent had nothing to post

    def test_an_empty_crew_does_nothing(self):
        self.assertFalse(demo.Crew())
        self.assertEqual(demo.crew_steps(Fake(), demo.Crew(), NOW), [])

    def test_agent_personas_post_their_own_shape(self):
        m = {"colony": 2, "market_id": "x", "outcomes": ["Y", "N"], "odds": [7000, 3000]}
        f = Fake(round_status={"phase": "agents", "round": 1, "close_at_ms": 0, "publish_at_ms": 9_000,
                               "markets": [{}]},
                 forecast_markets=[m], agent_snapshot={"posts": []}, is_agent=True)
        out = demo.crew_steps(f, demo.Crew(agents=[("a.t", "sharp"), ("b.t", "flat")]), NOW)
        odds = {s["account"]: s["args"]["odds"] for s in out}
        self.assertGreater(odds["a.t"][0], 7000)
        self.assertLess(odds["b.t"][0], 7000)


    def test_extra_agents_post_on_a_subset_of_the_rounds_markets(self):
        ms = [{"colony": c, "market_id": "x%d" % c, "outcomes": ["Y", "N"], "odds": [7000, 3000]} for c in range(1, 10)]
        f = Fake(round_status={"phase": "agents", "round": 1, "close_at_ms": 0, "publish_at_ms": 9_000,
                               "markets": [{}]},
                 forecast_markets=ms, agent_snapshot={"posts": []}, is_agent=True)
        out = demo.crew_steps(f, demo.Crew(agents=[("a.t", "sharp")]), NOW)
        self.assertEqual(len(out), demo.AGENT_PICKS)
        self.assertEqual(len({s["args"]["colony"] for s in out}), demo.AGENT_PICKS)
        self.assertEqual(len(demo.agent_steps(f, "base.t", NOW, f.view("round_status"), [])), 9)


class Daemon(unittest.TestCase):
    """The daemon sends the crew's calls, and a call that opens an agents'
    window is followed at once by the posts and stakes that window is for."""

    def operator(self, f, **kw):
        sent = []
        return op.Operator(f, "c.t", [K1], "cr.t", ["testnet"], True,
                           run=kw.pop("run", lambda cmd: sent.append(cmd) or True),
                           now_ms=lambda: NOW, log=lambda m: None, **kw)

    def test_a_tick_sends_the_crews_calls(self):
        f = Fake(keepers=[[K1, K2], 2], burn_schedule={"day": 1, "phase": "staking", "run_at_ms": 0, "end_at_ms": 0,
                                                       "drawn_day": None}, last_burn_day=None)
        o = self.operator(f, crew=demo.Crew(stakers=[(S, "follower")]))
        self.assertIn("stake", [m for m, ok in o.tick()])

    def test_split_mode_leaves_the_crew_to_the_fast_loop(self):
        f = Fake(keepers=[[K1, K2], 2], burn_schedule={"day": 1, "phase": "staking", "run_at_ms": 0, "end_at_ms": 0,
                                                       "drawn_day": None}, last_burn_day=None)
        o = self.operator(f, crew=demo.Crew(stakers=[(S, "follower")]), split=True)
        self.assertNotIn("stake", [m for m, ok in o.tick()])
        self.assertIn("stake", [m for m, ok in o.fast_tick()])

    def test_the_fast_loop_runs_each_account_in_its_own_thread(self):
        import threading
        seen = {}

        def run(cmd):
            seen.setdefault(threading.get_ident(), []).append(cmd[cmd.index("sign-as") + 1])
            return True

        f = Fake()
        crew = demo.Crew(stakers=[(S, "follower"), ("two.t", "contrarian")])
        o = self.operator(f, run=run, crew=crew, split=True)
        o.fast_tick()
        accounts = [set(v) for v in seen.values()]
        self.assertEqual(len(accounts), 2)                      # one thread per staker
        self.assertTrue(all(len(a) == 1 for a in accounts))

    def test_a_request_window_opening_is_followed_in_the_same_tick(self):
        req = {"id": 0, "colony": 0x8000, "phase": "odds", "requester": "x", "market_id": "r", "created_at_ms": 0,
               "keepers_posted": [K1], "odds_by_ms": 10**12, "forecast_by_ms": None, "market": None}
        after = dict(req, phase="forecasting", forecast_by_ms=60_000, market={"odds": [6000, 4000]})
        state = {"r": req}
        f = Fake(round_status={"phase": "done", "round": 1, "close_at_ms": 0, "publish_at_ms": 0, "markets": [{}]},
                 forecast_request_count=1, forecast_requests=lambda a: [state["r"]],
                 agent_snapshot={"posts": []}, is_agent=True, keepers=[[K1], 1], keeper_post=None,
                 burn_schedule={"day": 1, "phase": "staking", "run_at_ms": 0, "end_at_ms": 0, "drawn_day": None},
                 last_burn_day=None)

        def run(cmd):
            if "finalize_request_odds" in cmd:
                state["r"] = after
            return True

        crew = demo.Crew(stakers=[(S, "follower")], agents=[("ag.t", "sharp")])
        o = self.operator(f, run=run, agent="base.t", crew=crew)
        done = [m for m, ok in o.tick()]
        self.assertLess(done.index("finalize_request_odds"), done.index("post_forecast"))
        self.assertEqual(done.count("post_forecast"), 2)        # baseline and the sharp persona
        self.assertIn("stake", done)


if __name__ == "__main__":
    unittest.main()
