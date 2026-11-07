"""Offline tests for bots/swarm.py (no network, nothing signed).

Run: python3 -I bots/test_swarm.py
"""
import contextlib
import io
import json
import math
import os
import sys
import unittest
from types import SimpleNamespace

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import swarm as s  # noqa: E402

ONE = s.ONE
CAP = 100 * ONE


def wallet(weights, balance=1000 * ONE, staked=0, cap=CAP):
    return s.Wallet(weights, balance, staked, cap)


class FakeChain:
    def __init__(self, weights, balances=None, staked=None, close_at_ms=2**62, entries=(), locked=()):
        self.w = list(weights)
        self.locked = set(locked)
        self.balances = balances or {}
        self.staked = staked or {}
        self.close_at_ms = close_at_ms
        self.entries = list(entries)

    def config(self):
        return {"cap_per_wallet": str(CAP), "close_at_ms": self.close_at_ms, "publish_at_ms": self.close_at_ms + 1}

    def wallet(self, account, cap):
        return s.Wallet(list(self.w), self.balances.get(account, 1000 * ONE), self.staked.get(account, 0), cap)

    def view(self, method, args=None):
        if method == "burn_lock":
            return {"day": 20755, "locked": args["account_id"] in self.locked}
        assert method == "stakes_of"
        return [[c, o, amt] for who, c, o, amt in self.entries if who == args["account_id"]]


def run_quiet(fn, *args):
    out, err = io.StringIO(), io.StringIO()
    with contextlib.redirect_stdout(out), contextlib.redirect_stderr(err):
        code = fn(*args)
    return code, [json.loads(l) for l in out.getvalue().splitlines()], err.getvalue()


class Strategies(unittest.TestCase):
    def test_follower_takes_the_heaviest_option(self):
        self.assertEqual(s.plan("follower", wallet([5, 9, 9, 1, 0])), (1, s.FLOW_AMOUNT))

    def test_contrarian_takes_the_lightest_option(self):
        self.assertEqual(s.plan("contrarian", wallet([5, 0, 9, 1, 0])), (1, s.FLOW_AMOUNT))

    def test_ties_go_to_lowest_index(self):
        self.assertEqual(s.plan("follower", wallet([0] * 5))[0], 0)
        self.assertEqual(s.plan("contrarian", wallet([0] * 5))[0], 0)

    def test_heavy_fills_its_cap_on_the_top_burn(self):
        self.assertEqual(s.plan("heavy", wallet([0] * 5, staked=30 * ONE)), (4, 70 * ONE))

    def test_amount_clipped_to_balance_and_cap(self):
        self.assertEqual(s.plan("follower", wallet([1, 0, 0, 0, 0], balance=3 * ONE)), (0, 3 * ONE))
        self.assertEqual(s.plan("follower", wallet([1, 0, 0, 0, 0], staked=95 * ONE)), (0, 5 * ONE))

    def test_echo_feeds_the_last_pick_or_follows(self):
        self.assertEqual(s.plan("echo", s.Wallet([9, 0, 0, 0, 0], 1000 * ONE, 0, CAP, 3)), (3, s.FLOW_AMOUNT))
        self.assertEqual(s.plan("echo", wallet([0, 0, 9, 0, 0])), (2, s.FLOW_AMOUNT), "no finished run yet")

    def test_last_pick_needs_a_finished_run(self):
        class C(s.Chain):
            def __init__(self, run):
                self.run = run

            def view(self, method, args=None):
                assert method == "burn_run"
                return self.run
        self.assertEqual(C({"done": True, "winner_option": 1}).last_pick(), 1)
        self.assertIsNone(C({"done": False, "winner_option": None}).last_pick())
        self.assertIsNone(C(None).last_pick())

    def test_nothing_to_stake_at_cap_or_broke(self):
        self.assertIsNone(s.plan("heavy", wallet([0] * 5, staked=CAP)))
        self.assertIsNone(s.plan("contrarian", wallet([0] * 5, balance=0)))


class Round(unittest.TestCase):
    def args(self, send=False):
        return SimpleNamespace(contract="anto.testnet", network="testnet", send=send)

    def test_dry_run_later_bots_see_earlier_stakes(self):
        chain = FakeChain([0, 0, 0, 0, 0])
        bots = [("heavy", "h.testnet"), ("follower", "f.testnet"), ("contrarian", "c.testnet")]
        cmds = []
        code, plans, _ = run_quiet(s.stake_round, chain, bots, self.args(), cmds.append)
        self.assertEqual(code, 0)
        # Heavy puts 100 on option 4; follower follows it; contrarian takes the empty option 0.
        self.assertEqual([(p["strategy"], p["option"]) for p in plans],
                         [("heavy", 4), ("follower", 4), ("contrarian", 0)])
        self.assertEqual(int(plans[1]["weights"][4]), math.isqrt(100 * ONE))
        self.assertEqual(len(cmds), 3)
        self.assertEqual(cmds[0][5], "stake")
        self.assertEqual(json.loads(cmds[0][7]), {"colony": 0, "option": 4, "amount": str(100 * ONE)})
        self.assertEqual(cmds[0][cmds[0].index("sign-as") + 1], "h.testnet")

    def test_stake_during_the_run_counts_from_the_next_day(self):
        cmds = []
        day = 20_745  # 2026-10-19
        code, plans, err = run_quiet(s.stake_round, FakeChain([0] * 5, close_at_ms=0),
                                     [("heavy", "h.testnet")], self.args(), cmds.append,
                                     day * s.DAY_MS + 13 * 3_600_000)
        self.assertEqual((code, len(cmds)), (0, 1))
        self.assertIn("burn day %d (they freeze at 2026-10-20 12:00 UTC)" % (day + 1), err)

    def test_burn_day(self):
        d = 20_745 * s.DAY_MS
        self.assertEqual(s.burn_day(d), (20_745, d + s.STAKING_MS, False))
        self.assertEqual(s.burn_day(d + s.STAKING_MS - 1), (20_745, d + s.STAKING_MS, False))
        self.assertEqual(s.burn_day(d + s.STAKING_MS), (20_746, d + s.DAY_MS + s.STAKING_MS, True))

    def test_bot_with_nothing_to_add_sends_no_call(self):
        chain = FakeChain([0] * 5, staked={"h.testnet": CAP})
        cmds = []
        _, plans, _ = run_quiet(s.stake_round, chain, [("heavy", "h.testnet")], self.args(), cmds.append)
        self.assertIsNone(plans[0]["option"])
        self.assertEqual(cmds, [])

    def test_withdraw_unstakes_only_the_bots_entries(self):
        entries = [["alice.testnet", 0, 2, "5"], ["f.testnet", 0, 4, "7"], ["f.testnet", 1, 0, "3"]]
        cmds = []
        run_quiet(s.withdraw, FakeChain([0] * 5, entries=entries), [("follower", "f.testnet")],
                  self.args(), cmds.append)
        self.assertEqual([json.loads(c[7]) for c in cmds],
                         [{"colony": 0, "option": 4, "amount": "7"}, {"colony": 1, "option": 0, "amount": "3"}])
        self.assertTrue(all(c[5] == "unstake" for c in cmds))

    def test_withdraw_holds_locked_burn_stakes(self):
        cmds = []
        chain = FakeChain([0] * 5, entries=[["f.testnet", 0, 4, "7"], ["f.testnet", 1, 0, "3"]], locked=["f.testnet"])
        code, _, err = run_quiet(s.withdraw, chain, [("follower", "f.testnet")], self.args(), cmds.append)
        self.assertEqual(code, 1)
        self.assertEqual([json.loads(c[7]) for c in cmds], [{"colony": 1, "option": 0, "amount": "3"}])
        self.assertIn("locked until day 20755", err)


class Cli(unittest.TestCase):
    def test_parse_bots(self):
        self.assertEqual(s.parse_bots(["heavy=w.testnet"]), [("heavy", "w.testnet")])
        for bad in ["heavy", "whale=w.testnet", "heavy="]:
            with self.assertRaises(SystemExit):
                s.parse_bots([bad])


if __name__ == "__main__":
    unittest.main()
