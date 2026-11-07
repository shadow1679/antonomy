"""Offline tests for bots/recruit.py and the example bots/my_ant.py (no
network, nothing signed).

Run: python3 -I bots/test_recruit.py
"""
import contextlib
import io
import json
import math
import os
import sys
import tempfile
import unittest
from types import SimpleNamespace

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import recruit as r  # noqa: E402

ONE = r.ONE
CAP = 100 * ONE
ME = "ant.testnet"


class FakeChain:
    """Answers the contract views recruit.py reads, from raw stake entries."""

    def __init__(self, entries=(), balance=1000 * ONE, pool=10_000 * ONE, close_at_ms=2**62):
        self.entries = list(entries)  # (account, colony, option, amount)
        self.balance, self.pool, self.close_at_ms = balance, pool, close_at_ms

    def view(self, method, args=None):
        args = args or {}
        burn = [e for e in self.entries if e[1] == r.BURN_COLONY]
        n = args.get("n_options", 0)
        if method == "stake_config":
            return {"cap_per_wallet": str(CAP), "close_at_ms": self.close_at_ms, "publish_at_ms": self.close_at_ms + 1}
        if method == "stake_weights":
            return [str(sum(math.isqrt(a) for _, _, o, a in burn if o == k)) for k in range(n)]
        if method == "stake_totals":
            return [str(sum(a for _, _, o, a in burn if o == k)) for k in range(n)]
        if method == "stakes_of":
            return [[c, o, str(a)] for who, c, o, a in sorted(self.entries) if who == args["account_id"]]
        if method == "staked_by":
            return str(sum(a for who, _, _, a in self.entries if who == args["account_id"]))
        if method == "ft_balance_of":
            return str(self.balance)
        if method == "reward_pool":
            return str(self.pool)
        if method == "rewards_earned":
            return "0"
        raise AssertionError(method)


def round_of(chain):
    return r.read_round(chain, ME, 0)


def run_quiet(fn, *args):
    out, err = io.StringIO(), io.StringIO()
    with contextlib.redirect_stdout(out), contextlib.redirect_stderr(err):
        code = fn(*args)
    return code, [json.loads(l) for l in out.getvalue().splitlines()], err.getvalue()


def args(**kw):
    return SimpleNamespace(contract="anto.testnet", account=ME, network="testnet", **kw)


class ReadRound(unittest.TestCase):
    def test_round_reads_weights_totals_and_own_stake(self):
        chain = FakeChain([("bob.testnet", 0, 1, 16 * ONE), (ME, 0, 1, 4 * ONE),
                           (ME, 1, 0, 30 * ONE), ("bob.testnet", 0, 3, 9 * ONE)])
        rd = round_of(chain)
        self.assertEqual(rd.totals, [0, 20 * ONE, 0, 9 * ONE, 0])
        self.assertEqual(rd.weights[1], math.isqrt(16 * ONE) + math.isqrt(4 * ONE))
        self.assertEqual(rd.mine, [0, 4 * ONE, 0, 0, 0])   # the forecast stake is not a Burn stake
        self.assertEqual(rd.staked, 34 * ONE)               # but it uses the same wallet cap
        self.assertEqual(rd.headroom, 66 * ONE)
        self.assertEqual(rd.pot, 1000 * ONE)                # 10% of the pool

    def test_payout_is_by_raw_stake(self):
        rd = round_of(FakeChain([("bob.testnet", 0, 2, 30 * ONE), (ME, 0, 2, 10 * ONE)]))
        self.assertEqual(rd.payout_if_wins(2), 250 * ONE)            # 10 of 40
        self.assertEqual(rd.payout_if_wins(2, 20 * ONE), 500 * ONE)  # 30 of 60
        self.assertEqual(rd.payout_if_wins(0), 0)                    # nobody staked there
        self.assertEqual(rd.payout_if_wins(0, ONE), rd.pot)          # alone on it

    def test_weight_after_counts_own_stake_once(self):
        rd = round_of(FakeChain([("bob.testnet", 0, 2, 16 * ONE), (ME, 0, 2, 4 * ONE)]))
        self.assertEqual(rd.weight_after(2, 5 * ONE), math.isqrt(16 * ONE) + math.isqrt(9 * ONE))
        self.assertEqual(rd.weight_after(2), rd.weights[2])

    def test_food_share_matches_the_sim_unit(self):
        rd = round_of(FakeChain())
        self.assertAlmostEqual(rd.food_share(0), 0.2)
        # 100 tokens is 10 sqrt-tokens = 10000 milli on a 2500 base: 5x the food.
        self.assertAlmostEqual(rd.food_share(0, 100 * ONE), 5 / 9)


class Clip(unittest.TestCase):
    def test_bad_entries_dropped_and_total_clipped(self):
        rd = round_of(FakeChain([(ME, 1, 0, 70 * ONE)], balance=500 * ONE))  # 30 tokens of headroom
        stakes, notes = r.clip(rd, [(7, ONE), (True, ONE), (0, -1), (1, 2.5), "junk",
                                    (2, 20 * ONE), (3, 20 * ONE), (4, ONE)])
        self.assertEqual(stakes, [(2, 20 * ONE), (3, 10 * ONE)])
        self.assertEqual(len(notes), 7)
        self.assertIn("no balance", notes[-1])

    def test_dict_answers_and_balance_limit(self):
        rd = round_of(FakeChain(balance=3 * ONE))
        self.assertEqual(r.clip(rd, {4: 2 * ONE, 1: 2 * ONE})[0], [(1, 2 * ONE), (4, ONE)])
        self.assertEqual(r.clip(rd, None), ([], []))


class Join(unittest.TestCase):
    def test_dry_run_prints_plan_and_stake_calls(self):
        chain = FakeChain([("bob.testnet", 0, 4, 50 * ONE)])
        cmds = []
        code, out, _ = run_quiet(r.join, chain, lambda rd: [(4, 25 * ONE), (0, 5 * ONE)], args(), cmds.append, 0)
        self.assertEqual(code, 0)
        plan = out[0]["stakes"]
        self.assertEqual([p["option"] for p in plan], [4, 0])
        self.assertEqual(int(plan[0]["payout_if_wins"]), 1000 * ONE // 3)  # 25 of 75
        self.assertEqual(int(plan[1]["payout_if_wins"]), 1000 * ONE)
        self.assertEqual([json.loads(c[7]) for c in cmds],
                         [{"colony": 0, "option": 4, "amount": str(25 * ONE)},
                          {"colony": 0, "option": 0, "amount": str(5 * ONE)}])
        self.assertEqual(cmds[0][cmds[0].index("sign-as") + 1], ME)

    def test_stake_during_the_run_counts_from_the_next_day(self):
        cmds = []
        noon = 20_745 * r.swarm.DAY_MS + r.swarm.STAKING_MS
        code, out, _ = run_quiet(r.join, FakeChain(close_at_ms=5), lambda rd: [(0, ONE)], args(), cmds.append, noon)
        self.assertEqual((code, len(cmds)), (0, 1))
        self.assertEqual((out[0]["counts_from_day"], out[0]["freeze_at_ms"]), (20_746, noon + r.swarm.DAY_MS))

    def test_withdraw_unstakes_every_entry_of_the_account(self):
        chain = FakeChain([("bob.testnet", 0, 2, 5), (ME, 0, 4, 7), (ME, 2, 1, 3)])
        cmds = []
        run_quiet(r.withdraw, chain, args(), cmds.append, 0)
        self.assertEqual([(c[5], json.loads(c[7])) for c in cmds],
                         [("unstake", {"colony": 0, "option": 4, "amount": "7"}),
                          ("unstake", {"colony": 2, "option": 1, "amount": "3"})])
        # Not while the colony runs.
        cmds = []
        code, _, err = run_quiet(r.withdraw, chain, args(), cmds.append, r.swarm.STAKING_MS)
        self.assertEqual((code, cmds), (1, []))
        self.assertIn("locked", err)


class Strategies(unittest.TestCase):
    def test_builtin_strategies_load(self):
        rd = round_of(FakeChain([("bob.testnet", 0, 3, 9 * ONE)]))
        self.assertEqual(r.load_strategy("follower")(rd), [(3, 10 * ONE)])
        self.assertEqual(r.load_strategy("contrarian")(rd), [(0, 10 * ONE)])

    def test_strategy_file_needs_decide(self):
        with tempfile.NamedTemporaryFile("w", suffix=".py", delete=False) as f:
            f.write("x = 1\n")
        try:
            with self.assertRaises(SystemExit):
                r.load_strategy(f.name)
        finally:
            os.unlink(f.name)
        with self.assertRaises(SystemExit):
            r.load_strategy("whale")

    def test_example_ant_prefers_value_and_respects_cap(self):
        decide = r.load_strategy(os.path.join(HERE, "my_ant.py"))
        # Crowded top burn, empty rest: the whole pot beats a slice of it.
        rd = round_of(FakeChain([("whale.testnet", 0, 4, 100 * ONE)]))
        self.assertEqual(decide(rd), [(0, 20 * ONE)])
        # Already at the cap: sit out.
        self.assertEqual(decide(round_of(FakeChain([(ME, 0, 2, CAP)]))), [])
        # Every answer survives the clip unchanged.
        self.assertEqual(r.clip(rd, decide(rd)), (decide(rd), []))


if __name__ == "__main__":
    unittest.main()
