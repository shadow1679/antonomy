// Offline tests for the Recruit page's logic: node web/test_recruit.mjs
// Also checks every strategy's pick against bots/recruit.py itself, on the
// same stakes, when python3 is on the PATH.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { Round, STRATEGIES, clip, recruit, recruitDay, stakeCall, kitCommands, POOL } from "./recruit.mjs";
import { BURN_WALLETS, DAY_MS, STAKING_MS } from "./round.mjs";
import { seedFromInt, N_ANTS } from "../sim/js/antosim.mjs";

const r = new Round({ wallets: BURN_WALLETS }); // weights [0, 4000, 9000, 2000, 0]
assert.deepEqual(r.weights, [0, 4000, 9000, 2000, 0]);
assert.deepEqual(r.totals, [0, 8, 27, 4, 0]);
assert.equal(r.pot, POOL / 10);
assert.equal(r.weightAfter(2, 16), 13000);
assert.ok(Math.abs([0, 1, 2, 3, 4].reduce((a, o) => a + r.foodShare(o), 0) - 1) < 1e-12);
assert.equal(r.payoutIfWins(0, 10), r.pot, "alone on an option takes the whole pot");

// Built-ins: ties go to the lowest index.
assert.deepEqual(STRATEGIES.follower.decide(r), [[2, 10]]);
assert.deepEqual(STRATEGIES.contrarian.decide(r), [[0, 10]]);
assert.deepEqual(STRATEGIES.heavy.decide(r), [[4, 100]]);

// clip: bad options and amounts dropped, the total kept within balance and cap.
const small = new Round({ wallets: [], balance: 30 });
const c = clip(small, [[7, 5], [1, -2], [1, 20], [2, 20], [3, 5], "x"]);
assert.deepEqual(c.stakes, [[1, 20], [2, 10]]);
assert.equal(c.notes.length, 5);

// A recruit hatches ants in its own colour, and only when it stakes.
const seed = seedFromInt(5);
const rec = recruit("bot.testnet", "follower", BURN_WALLETS, seed);
assert.equal(rec.lines.length, 1);
assert.ok(rec.wallet >= 0 && rec.ants > 0);
assert.equal(rec.side.stakers.owner.filter((o) => o === rec.wallet).length, rec.ants);
assert.equal(rec.side.stakers.owner.length, N_ANTS);
const broke = recruit("broke.testnet", "value", BURN_WALLETS, seed, { balance: 0 });
assert.equal(broke.lines.length, 0);
assert.equal(broke.wallet, -1);

// The day: before 12:00 UTC a stake counts today, after it tomorrow.
const day = 20_400;
const am = recruitDay(day * DAY_MS + 3_600_000), pm = recruitDay(day * DAY_MS + STAKING_MS + 1);
assert.equal(am.staking, true);
assert.equal(am.countsFor.day, day);
assert.equal(pm.staking, false);
assert.equal(pm.countsFor.day, day + 1);
assert.equal(am.wallets.length, 1, "one fixture wallet by 01:00");

// Commands match the kit's shapes.
assert.equal(stakeCall("c.testnet", "me.testnet", 2, 20),
  `near contract call-function as-transaction c.testnet stake json-args '{"colony":0,"option":2,"amount":"20000000000000000000000000"}' ` +
  `prepaid-gas '100.0 Tgas' attached-deposit '0 NEAR' sign-as me.testnet network-config testnet sign-with-keychain send`);
const k = kitCommands("c.testnet", "my-ant.testnet", "value");
assert.equal(k.copy, "cp bots/my_ant.py bots/my_ant_strategy.py");
assert.ok(k.send.endsWith("--strategy bots/my_ant_strategy.py --send"));
assert.equal(kitCommands("c.testnet", "a.testnet", "heavy").copy, null);

// Same stakes, same pick as the Python kit (amounts in yocto there).
const PY = `
import json, sys
sys.path.insert(0, "bots")
import recruit, importlib.util
cases = json.loads(sys.argv[1])
spec = importlib.util.spec_from_file_location("my_ant", "bots/my_ant.py")
my_ant = importlib.util.module_from_spec(spec); spec.loader.exec_module(my_ant)
one = 10**24
out = []
for c in cases:
    weights = [sum(recruit.math.isqrt(w[o] * one) for w in c["stakes"]) for o in range(5)]
    totals = [sum(w[o] for w in c["stakes"]) * one for o in range(5)]
    r = recruit.Round(weights=weights, totals=totals, mine=[0]*5, balance=c["balance"]*one,
                      staked=0, cap=100*one, pool=c["pool"]*one, now_ms=0)
    picks = {}
    for k in ["follower", "contrarian", "heavy"]:
        picks[k] = [[o, a // one] for o, a in recruit.clip(r, recruit.load_strategy(k)(r))[0]]
    picks["value"] = [[o, a // one] for o, a in recruit.clip(r, my_ant.decide(r))[0]]
    out.append(picks)
print(json.dumps(out))
`;
const cases = [
  { stakes: BURN_WALLETS.map((w) => w.stakes), balance: 100, pool: POOL },
  { stakes: [[0, 0, 0, 0, 0]], balance: 100, pool: POOL },
  { stakes: [[50, 1, 0, 0, 3], [2, 2, 2, 2, 2]], balance: 15, pool: 1000 },
  { stakes: [[0, 9, 9, 0, 0], [16, 0, 0, 0, 25]], balance: 100, pool: POOL },
];
let py = null;
try {
  py = JSON.parse(execFileSync("python3", ["-I", "-c", PY, JSON.stringify(cases)], { cwd: new URL("..", import.meta.url) }).toString());
} catch (e) {
  console.log(`skipped the Python check: ${e.message.split("\n")[0]}`);
}
if (py) {
  cases.forEach((cs, i) => {
    const wallets = cs.stakes.map((stakes, j) => ({ id: `w${j}`, stakes }));
    for (const key of Object.keys(STRATEGIES)) {
      const rr = new Round({ wallets, balance: cs.balance, pool: cs.pool });
      assert.deepEqual(clip(rr, STRATEGIES[key].decide(rr)).stakes, py[i][key], `case ${i} ${key}`);
    }
  });
  console.log(`matches bots/recruit.py on ${cases.length} cases`);
}
console.log("recruit ok");
