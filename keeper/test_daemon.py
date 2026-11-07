"""Offline tests for keeper/daemon.py: a fake chain stands in for the views.
Run: python3 -I keeper/test_daemon.py"""
import os
import sys
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import daemon as op  # noqa: E402

K, C = "keeper.t", "cranker.t"
DAY = 20_000
NOON = DAY * op.DAY_MS + op.STAKING_MS
END = (DAY + 1) * op.DAY_MS
SIG = "ab" * 48


def beacon(rnd):
    """Every drand round is out, signed SIG."""
    return SIG


def no_beacon(rnd):
    return None


class Fake:
    """Canned views. Override any by keyword; defaults are an idle contract."""

    def __init__(self, **views):
        self.v = {
            "round_status": {"phase": "agents", "close_at_ms": 10**15, "publish_at_ms": 10**15 + 1,
                             "markets": [{}], "run": None, "round": 0},
            "keeper_post": None,
            "burn_schedule": {"day": DAY, "phase": "staking", "run_at_ms": NOON, "end_at_ms": END,
                              "drawn_day": DAY - 1, "drand_round": 70},
            "burn_run": None,
            "last_burn_day": DAY - 1,
            "forecast_request_count": 0,
            "keepers": [[K], 1],
            "forecast_requests": [],
        }
        self.v.update(views)

    def view(self, method, args=None):
        v = self.v[method]
        return v(args) if callable(v) else v


A = "agent.t"
ONE = 10**24


class Agent(unittest.TestCase):
    """The optional forecaster agent: join once, post once per open market."""

    MARKET = {"colony": 3, "market_id": "x", "outcomes": ["Yes", "No"], "odds": [7000, 3000]}

    def fake(self, **views):
        v = {
            "round_status": {"phase": "agents", "close_at_ms": 0, "publish_at_ms": 1000, "markets": [{}]},
            "forecast_markets": [self.MARKET],
            "agent_snapshot": {"odds": [0, 0], "hash": "0" * 64, "posts": []},
            "is_agent": True,
            "request_config": {"agent_deposit": str(10 * ONE)},
            "ft_balance_of": str(100 * ONE),
            "has_claimed": True,
            "faucet_amount": str(100 * ONE),
        }
        v.update(views)
        return Fake(**v)

    def plan(self, f, now=500):
        return op.plan(f, K, C, now, agent=A)

    def test_posts_the_chain_odds_on_each_open_market_once(self):
        s = self.plan(self.fake())
        self.assertEqual(methods(s), [(A, "post_forecast")])
        self.assertEqual(s[0]["args"], {"colony": 3, "odds": [7000, 3000]})
        done = {"odds": [7000, 3000], "hash": "0" * 64, "posts": [[A, [7000, 3000]]]}
        self.assertEqual(self.plan(self.fake(agent_snapshot=done)), [])

    def test_no_agent_account_means_no_agent_calls(self):
        self.assertEqual(op.plan(self.fake(), K, C, 500), [])

    def test_the_round_window_closes_at_publish_time(self):
        self.assertEqual(self.plan(self.fake(), now=1000), [])

    def test_joins_first_when_not_registered_and_funded(self):
        s = self.plan(self.fake(is_agent=False))
        self.assertEqual(methods(s), [(A, "register_agent"), (A, "post_forecast")])

    def test_claims_the_faucet_when_it_cannot_afford_the_deposit(self):
        s = self.plan(self.fake(is_agent=False, ft_balance_of="0", has_claimed=False))
        self.assertEqual(methods(s), [(A, "claim_play_tokens"), (A, "register_agent"), (A, "post_forecast")])

    def test_unfunded_and_already_claimed_does_nothing(self):
        self.assertEqual(self.plan(self.fake(is_agent=False, ft_balance_of="0")), [])

    def test_posts_on_a_request_only_while_its_agents_window_is_open(self):
        r = {"id": 4, "colony": 0x8004, "phase": "forecasting", "market_id": "y", "keepers_posted": [],
             "odds_by_ms": 0, "forecast_by_ms": 900, "market": {"odds": [6000, 4000]}}
        f = self.fake(round_status={"phase": "posting", "close_at_ms": 0, "markets": None}, keeper_post=[{}],
                      forecast_request_count=5, forecast_requests=[r])
        s = self.plan(f)
        self.assertEqual(methods(s), [(A, "post_forecast")])
        self.assertEqual(s[0]["args"], {"colony": 0x8004, "odds": [6000, 4000]})
        self.assertEqual(methods(self.plan(f, now=900)), [(C, "crank_request")])

    def test_median_odds_that_miss_10000_are_rescaled_before_posting(self):
        m = dict(self.MARKET, odds=[950, 9075])
        s = self.plan(self.fake(forecast_markets=[m]))
        self.assertEqual(s[0]["args"]["odds"], [948, 9052])
        self.assertEqual(sum(s[0]["args"]["odds"]), 10_000)

    def test_rescaling(self):
        self.assertEqual(op.to_bps([7000, 3000]), [7000, 3000])
        self.assertEqual(op.to_bps([3333, 3333, 3333]), [3334, 3333, 3333])
        self.assertEqual(op.to_bps([0, 0]), [5000, 5000])
        for odds in ([950, 9075], [1, 2, 3, 4, 5], [9999, 9999], [10, 0, 9989]):
            out = op.to_bps(odds)
            self.assertEqual(sum(out), 10_000)
            self.assertTrue(all(abs(o * 10_000 / sum(odds) - b) < 1 for o, b in zip(odds, out)))

    def test_posts_are_sent_before_the_cranks_and_not_once_too_late(self):
        r = {"id": 4, "colony": 0x8004, "phase": "running", "market_id": "y", "keepers_posted": [],
             "odds_by_ms": 0, "forecast_by_ms": 0, "market": {"odds": [6000, 4000]}}
        f = self.fake(forecast_request_count=5, forecast_requests=[r],
                      round_status={"phase": "agents", "close_at_ms": 0, "publish_at_ms": 100_000,
                                    "markets": [{}]})
        clock = [50_000]
        o = op.Operator(f, "c.t", K, C, "testnet", send=True, run=lambda cmd: True,
                        now_ms=lambda: clock[0], log=lambda m: None, agent=A)
        self.assertEqual(o.tick(), [("post_forecast", True), ("crank_request", True)])
        clock[0] = 100_000 - op.DEADLINE_MARGIN_MS
        self.assertEqual(o.tick(), [("crank_request", True)])


def methods(steps):
    return [(s["account"], s["method"]) for s in steps]


def burn_run(day=DAY, t=0, done=False):
    return {"day": day, "t": t, "ticks": op.BURN_TICKS, "done": done}


class Round(unittest.TestCase):
    def plan(self, fake, now=0, beacon=beacon):
        return op.plan(fake, K, C, now, beacon=beacon)

    def test_keeper_posts_once_while_the_round_is_open(self):
        f = Fake(round_status={"phase": "posting", "close_at_ms": 5, "markets": None})
        s = self.plan(f)
        self.assertEqual(methods(s), [(K, "post_trending")])
        self.assertEqual(s[0]["read"], ("trending",))
        f.v["keeper_post"] = [{"market_id": "x"}]
        self.assertEqual(self.plan(f), [])

    def test_finalize_only_after_close_and_only_without_markets(self):
        f = Fake(round_status={"phase": "agents", "close_at_ms": 100, "markets": None})
        self.assertEqual(self.plan(f, now=99), [])
        self.assertEqual(methods(self.plan(f, now=100)), [(C, "finalize_markets")])

    def test_a_late_post_is_finalized_not_skipped_until_the_grace_ends(self):
        rs = {"phase": "skipped", "close_at_ms": 100, "publish_at_ms": 200, "markets": None}
        f = Fake(round_status=rs, keeper_post=[{"market_id": "x"}])
        self.assertEqual(methods(self.plan(f, now=200 + 60_000)), [(C, "finalize_markets")])
        self.assertEqual(methods(self.plan(f, now=200 + op.LATE_FINALIZE_MS)), [(C, "start_round")])
        f.v["keeper_post"] = None
        self.assertEqual(methods(self.plan(f, now=300)), [(C, "start_round")])

    def test_crank_until_done_then_start_the_next_round(self):
        for phase, want in [("done", "start_round"), ("skipped", "start_round")]:
            f = Fake(round_status={"phase": phase, "close_at_ms": 0, "markets": [{}]})
            self.assertEqual(methods(self.plan(f)), [(C, want)], phase)

    def test_every_colony_still_due_is_cranked_in_one_tick(self):
        # Five colonies per market, one call each; none run yet in `ready`.
        f = Fake(round_status={"phase": "ready", "close_at_ms": 0, "markets": [{}, {}], "run": None})
        self.assertEqual(methods(self.plan(f)), [(C, "crank_round")] * 10)
        # Seven of ten done: three left.
        run = {"markets": [{"colony_hashes": ["h"] * 5}, {"colony_hashes": ["h"] * 2}]}
        f = Fake(round_status={"phase": "running", "close_at_ms": 0, "markets": [{}, {}], "run": run})
        self.assertEqual(methods(self.plan(f)), [(C, "crank_round")] * 3)
        # Twelve markets is the contract's cap: 60 calls.
        f = Fake(round_status={"phase": "ready", "close_at_ms": 0, "markets": [{}] * 12, "run": None})
        self.assertEqual(len(methods(self.plan(f))), 60)

    def test_only_the_seed_drawing_crank_carries_the_drand_signature(self):
        rs = {"phase": "ready", "close_at_ms": 0, "markets": [{}], "run": None, "drand_round": 42}
        seen = []
        s = self.plan(Fake(round_status=rs), beacon=lambda r: seen.append(r) or SIG)
        self.assertEqual(seen, [42])
        self.assertEqual([st["args"] for st in s], [{"drand_signature": SIG}] + [{}] * 4)
        # Not published yet: no crank at all this tick.
        self.assertEqual(self.plan(Fake(round_status=rs), beacon=no_beacon), [])
        # Already running: the seed is drawn, no beacon needed.
        run = {"markets": [{"colony_hashes": ["h"]}]}
        s = self.plan(Fake(round_status=dict(rs, phase="running", run=run)), beacon=no_beacon)
        self.assertEqual([st["args"] for st in s], [{}] * 4)

    def test_a_contract_without_drand_gets_no_signature(self):
        rs = {"phase": "ready", "close_at_ms": 0, "markets": [{}], "run": None}
        s = self.plan(Fake(round_status=rs), beacon=no_beacon)
        self.assertEqual([st["args"] for st in s], [{}] * 5)


def sched(day, phase, drawn, rnd=70):
    return {"day": day, "phase": phase, "drawn_day": drawn, "drand_round": rnd}


class Burn(unittest.TestCase):
    def plan(self, fake, now, beacon=beacon):
        return [s for s in op.plan(fake, K, C, now, beacon=beacon)
                if s["method"] in ("crank_burn", "execute_burn")]

    def test_nothing_before_noon(self):
        self.assertEqual(self.plan(Fake(), NOON - 1), [])

    def test_the_first_call_of_the_day_starts_the_colony_with_heavy_gas(self):
        f = Fake(burn_schedule=sched(DAY, "running", DAY, rnd=91))
        s = self.plan(f, NOON)
        self.assertEqual(methods(s), [(C, "crank_burn")])
        self.assertEqual(s[0]["gas"], op.HEAVY_GAS)
        self.assertEqual(s[0]["args"], {"drand_signature": SIG})
        self.assertEqual(self.plan(f, NOON, beacon=no_beacon), [])

    def test_a_day_nobody_started_can_still_start_the_next_morning(self):
        # Day DAY never ran (the daemon was down 12:00 to 24:00); before the
        # next 12:00 it is still the drawn day, so it starts and catches up.
        f = Fake(burn_schedule=sched(DAY + 1, "staking", DAY), burn_run=burn_run(day=DAY - 1, done=True))
        self.assertEqual(methods(self.plan(f, END + 3_600_000)), [(C, "crank_burn")])
        # ...but not once it has been burned.
        f.v["last_burn_day"] = DAY
        self.assertEqual(self.plan(f, END + 3_600_000), [])

    def test_cranks_in_chunks_not_every_tick(self):
        f = Fake(burn_schedule=sched(DAY, "running", DAY), burn_run=burn_run(t=0))
        self.assertEqual(self.plan(f, NOON + 1_499_000), [])
        self.assertEqual(methods(self.plan(f, NOON + 1_500_000)), [(C, "crank_burn")])

    def test_the_last_tick_after_midnight_still_gets_cranked(self):
        f = Fake(burn_schedule=sched(DAY + 1, "staking", DAY),
                 burn_run=burn_run(t=op.BURN_TICKS - 20))
        self.assertEqual(methods(self.plan(f, END)), [(C, "crank_burn")])

    def test_execute_once_after_the_run_is_done(self):
        f = Fake(burn_schedule=sched(DAY + 1, "staking", DAY),
                 burn_run=burn_run(t=op.BURN_TICKS, done=True))
        s = self.plan(f, END)
        self.assertEqual(methods(s), [(C, "execute_burn")])
        self.assertEqual(s[0]["args"], {"day": DAY})
        f.v["last_burn_day"] = DAY
        self.assertEqual(self.plan(f, END), [])

    def test_catches_up_several_chunks_at_once_but_not_unboundedly(self):
        f = Fake(burn_schedule=sched(DAY, "running", DAY), burn_run=burn_run(t=1500))
        self.assertEqual(len(self.plan(f, NOON + 4_700_000)), 2)      # 4,700 allowed, 3,200 behind
        self.assertEqual(len(self.plan(f, NOON + 40_000_000)), op.MAX_BURN_CATCHUP)

    def test_the_last_partial_chunk_is_cranked_at_midnight(self):
        f = Fake(burn_schedule=sched(DAY + 1, "staking", DAY), burn_run=burn_run(t=op.BURN_TICKS - 20))
        self.assertEqual(len(self.plan(f, END)), 1)

    def test_a_new_day_starts_even_if_yesterday_never_finished(self):
        f = Fake(burn_schedule=sched(DAY + 1, "running", DAY + 1), burn_run=burn_run(t=5))
        self.assertEqual(methods(self.plan(f, END + op.STAKING_MS)), [(C, "crank_burn")])


class Requests(unittest.TestCase):
    def req(self, **kw):
        r = {"id": 0, "phase": "odds", "market_id": "fed", "keepers_posted": [],
             "odds_by_ms": 1000, "forecast_by_ms": None}
        r.update(kw)
        return r

    def plan(self, reqs, now=0, keepers=([K], 1), refused=(), beacon=beacon):
        f = Fake(forecast_request_count=len(reqs), forecast_requests=reqs, keepers=list(keepers))
        return [s for s in op.plan(f, K, C, now, refused, beacon=beacon) if "request" in s["method"]]

    def test_keeper_posts_odds_for_a_new_request(self):
        s = self.plan([self.req()])
        self.assertEqual(methods(s), [(K, "post_request_odds")])
        self.assertEqual(s[0]["read"], ("request", 0, "fed"))

    def test_finalizes_once_every_keeper_posted_or_the_deadline_passes(self):
        self.assertEqual(methods(self.plan([self.req(keepers_posted=[K])])), [(C, "finalize_request_odds")])
        two = ([K, "k2.t"], 2)
        self.assertEqual(self.plan([self.req(keepers_posted=[K])], keepers=two), [])
        self.assertEqual(methods(self.plan([self.req(keepers_posted=[K])], now=1000, keepers=two)),
                         [(C, "finalize_request_odds")])

    def test_a_refused_market_is_not_retried_but_the_request_still_finalizes(self):
        self.assertEqual(self.plan([self.req()], refused={0}), [])
        self.assertEqual(methods(self.plan([self.req()], now=1000, refused={0})),
                         [(C, "finalize_request_odds")])

    def test_cranks_wait_for_the_agents_window(self):
        r = self.req(phase="forecasting", forecast_by_ms=500)
        self.assertEqual(self.plan([r], now=499), [])
        self.assertEqual(methods(self.plan([r], now=500)), [(C, "crank_request")])
        self.assertEqual(methods(self.plan([self.req(phase="running")])), [(C, "crank_request")])
        self.assertEqual(self.plan([self.req(phase="done")]), [])

    def test_the_first_crank_carries_the_committed_beacon(self):
        r = self.req(phase="forecasting", forecast_by_ms=500, drand_round=9)
        s = self.plan([r], now=500)
        self.assertEqual(s[0]["args"], {"request_id": 0, "drand_signature": SIG})
        self.assertEqual(self.plan([r], now=500, beacon=no_beacon), [])
        s = self.plan([self.req(phase="running", drand_round=9)], beacon=no_beacon)
        self.assertEqual(s[0]["args"], {"request_id": 0})


class Fallback(unittest.TestCase):
    def test_a_rate_limited_endpoint_falls_through_to_the_next(self):
        class Bad:
            def view(self, m, a=None):
                raise OSError("HTTP Error 429: Too Many Requests")

        class Good:
            def view(self, m, a=None):
                return {"ok": m}

        mc = op.MultiChain([], "c.t")
        mc.chains = [Bad(), Good()]
        self.assertEqual(mc.view("round_status"), {"ok": "round_status"})
        mc.chains = [Bad(), Bad()]
        with self.assertRaises(OSError):
            mc.view("round_status")


class Order(unittest.TestCase):
    def test_slow_reads_run_after_the_cheap_calls(self):
        f = Fake(round_status={"phase": "posting", "close_at_ms": 5, "markets": None},
                 burn_schedule=sched(DAY, "running", DAY), burn_run=burn_run(t=0))
        sent = []
        o = op.Operator(f, "c.t", K, C, "testnet", send=True, run=lambda cmd: sent.append(cmd) or True,
                        now_ms=lambda: NOON + 5_000_000, log=lambda m: None,
                        readers={"trending": lambda: {"markets": []}, "request": lambda *a: None})
        order = [m for m, _ in o.tick()]
        self.assertEqual(order[-1], "post_trending")
        self.assertIn("crank_burn", order[:-1])


class Tick(unittest.TestCase):
    def test_reader_refusal_is_remembered_and_accepted_odds_are_sent_as_read(self):
        f = Fake(forecast_request_count=1, keepers=[[K], 1],
                 forecast_requests=[{"id": 3, "phase": "odds", "market_id": "bad", "keepers_posted": [],
                                     "odds_by_ms": 10**15, "forecast_by_ms": None}])
        sent, logs = [], []
        o = op.Operator(f, "c.t", K, C, "testnet", send=True, run=lambda cmd: sent.append(cmd) or True,
                        now_ms=lambda: 0, log=logs.append,
                        readers={"trending": lambda: {"markets": []}, "request": lambda rid, slug: None})
        self.assertEqual(o.tick(), [])
        self.assertEqual(sent, [])
        self.assertEqual(o.refused, {3})
        o.refused.clear()
        o.readers["request"] = lambda rid, slug: {"request_id": rid, "market": {"market_id": slug}}
        self.assertEqual(o.tick(), [("post_request_odds", True)])
        cmd = sent[0]
        self.assertEqual(cmd[cmd.index("sign-as") + 1], K)
        self.assertIn('"request_id":3', cmd[cmd.index("json-args") + 1])

    def test_a_failed_send_is_reported_and_retried_next_tick(self):
        f = Fake(round_status={"phase": "ready", "close_at_ms": 0, "markets": [{}]})
        o = op.Operator(f, "c.t", K, C, "testnet", send=True, run=lambda cmd: False,
                        now_ms=lambda: 0, log=lambda m: None)
        self.assertEqual(o.tick(), [("crank_round", False)] * 5)
        self.assertEqual(o.tick(), [("crank_round", False)] * 5)

    def test_a_beacon_is_fetched_once_and_sent_with_the_seed_drawing_call(self):
        f = Fake(round_status={"phase": "ready", "close_at_ms": 0, "markets": [{}], "drand_round": 7})
        fetched, sent, logs = [], [], []
        replies = iter([None, SIG])
        o = op.Operator(f, "c.t", K, C, "testnet", send=True, run=lambda cmd: sent.append(cmd) or True,
                        now_ms=lambda: 0, log=logs.append, fetch=lambda r: fetched.append(r) or next(replies))
        self.assertEqual(o.tick(), [])
        self.assertIn("waiting for drand round 7", logs)
        self.assertEqual(len(o.tick()), 5)
        self.assertIn('"drand_signature":"%s"' % SIG, sent[0][sent[0].index("json-args") + 1])
        o.tick()
        self.assertEqual(fetched, [7, 7])


class Beacon(unittest.TestCase):
    def test_no_endpoint_means_no_beacon(self):
        self.assertIsNone(op.fetch_beacon(5, urls=["http://127.0.0.1:9"], timeout=1))


if __name__ == "__main__":
    unittest.main()
