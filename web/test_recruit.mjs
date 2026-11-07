// Offline tests for the Recruit page's logic (Recruit the swarm): node web/test_recruit.mjs
// REAL is request #0 on antonomy-oracle.testnet (worlds-2026-winner, one keeper,
// one forecaster agent). Its inputs, seed and payouts are from the live
// contract; the colony hashes, swarm, market hash and crank rows were recomputed
// for three colonies (the testnet contract ran five until it was redeployed).
import assert from "node:assert/strict";
import { forecastMarket } from "../sim/js/antosim.mjs";
import {
  ONE, CRANK_CALLS, tokens, parseConfig, feePools, cranked, isOver, specOf, forecastersOf, countedOf, verifyRequest,
  payoutRows, due, agentsMayPost, timeline, marketOdds, readOdds, recentRequests, findRequest, failureOf,
  commands, requestColony, stakesOf, stakingOpen, stakesLocked,
} from "./recruit.mjs";
import { hexToBytes } from "./chain.mjs";

const REAL = {
  "id": 0,
  "colony": 32768,
  "requester": "requester.antonomy-oracle.testnet",
  "market_id": "worlds-2026-winner",
  "fee": "100000000000000000000000000",
  "phase": "done",
  "created_at_ms": 1793095654722,
  "odds_by_ms": 1793096254722,
  "forecast_by_ms": 1793095830072,
  "keepers_posted": [],
  "market": {
    "colony": 32768,
    "market_id": "worlds-2026-winner",
    "outcomes": [
      "Gen.G",
      "T1",
      "Dplus KIA",
      "Bilibili Gaming",
      "Other"
    ],
    "odds": [
      4350,
      1550,
      1205,
      1150,
      1745
    ],
    "odds_6h": [
      4350,
      1550,
      1095,
      1150,
      1855
    ],
    "odds_hash": "8bfef0c590c502552ed03f49fc9f5f25affc78f9a113970eb07c0922e96a4cb9",
    "raw_hashes": [
      [
        "keeper.antonomy-oracle.testnet",
        "e0c740fd2885c0767ed2d2ad9b63f28cf17ccf188bf214a1117f8fcd4bd69460"
      ]
    ]
  },
  "agents": {
    "odds": [
      4000,
      2000,
      1200,
      1200,
      1600
    ],
    "hash": "7826c3058bca43daae432e7c4b3d5498b1be249e0dadc3cc155bbf86b7f62e6d",
    "posts": [
      [
        "agent.antonomy-oracle.testnet",
        [
          4000,
          2000,
          1200,
          1200,
          1600
        ]
      ]
    ]
  },
  "seed": "2c6896734b408ba1cb0c0b8ff446b088085c1189afcda29ed3d1c6e05c4aaafb",
  "colony_hashes": [
    "72aa20d788ddaeb9632f99d50a3cbe42aaac341196d176eff35a0b88b4019c5b",
    "0d6966e007d9248b95a88384e1b0dbb9b2c166206e73da1e4ea8b0ef64428bd3",
    "ebf761afa0ec53f82d23d2ab8cf504184369fc93e1de90602ba0dfa2079afcbc"
  ],
  "crankers": [
    "cranker.antonomy-oracle.testnet",
    "cranker.antonomy-oracle.testnet",
    "cranker.antonomy-oracle.testnet"
  ],
  "swarm": [
    3409,
    1457,
    2690,
    1702,
    742
  ],
  "market_hash": "ae6c24108df6b4ed00d9e8b47dbd842ddf7e57fe7bd55822260968301c2cc987",
  "paid_keepers": [
    [
      "keeper.antonomy-oracle.testnet",
      "20000000000000000000000000"
    ]
  ],
  "paid_agents": [
    [
      "agent.antonomy-oracle.testnet",
      "30000000000000000000000000"
    ]
  ],
  "paid_cranks": [
    [
      "cranker.antonomy-oracle.testnet",
      "3333333333333333333333333"
    ],
    [
      "cranker.antonomy-oracle.testnet",
      "3333333333333333333333333"
    ],
    [
      "cranker.antonomy-oracle.testnet",
      "3333333333333333333333333"
    ]
  ],
  "to_treasury": "40000000000000000000000001"
};

// request_config as the contract returns it (fee 100, 20/30/10, the treasury gets the rest).
const CFG = parseConfig({
  fee: "100000000000000000000000000", keeper_bps: 2000, agent_bps: 3000, crank_bps: 1000,
  odds_window_ms: 600000, forecast_window_ms: 60000, agent_deposit: "10000000000000000000000000",
  crank_bounty: "3333333333333333333333333",
});
const sum = (rows) => rows.reduce((a, r) => a + r.amount, 0n);

assert.deepEqual(feePools(CFG), { keepers: 20n * ONE, agents: 30n * ONE, crank: 10n * ONE, treasury: 40n * ONE });
// The crank pool doesn't split evenly in three: the dust goes to the treasury.
assert.equal(CFG.crankBounty * BigInt(CRANK_CALLS), feePools(CFG).crank - 1n);
assert.equal(tokens("100000000000000000000000000"), "100");
assert.equal(tokens(20n * ONE / 3n), "6.66");
assert.equal(tokens(40n * ONE + 2n), "40");
assert.equal(requestColony(0), 0x8000);
assert.equal(REAL.colony, requestColony(REAL.id));

// ---- the finished real request ----
assert.equal(cranked(REAL), 3);
assert.ok(isOver(REAL));
// It pays out exactly the fee, and the treasury row is what the contract paid it.
const rows = payoutRows(REAL);
assert.equal(sum(rows), BigInt(REAL.fee));
assert.equal(rows.filter((r) => r.role === "cranker").length, CRANK_CALLS);
assert.equal(rows.find((r) => r.role === "treasury").amount, 40n * ONE + 1n);
assert.ok(!rows.some((r) => r.role === "treasury" && r.account));
// Inputs for the colonies: no stakes (Community abstains), the agents voted.
const spec = specOf(REAL);
assert.deepEqual(spec.weights, [0, 0, 0, 0, 0]);
assert.deepEqual(spec.agentOdds.odds, [4000, 2000, 1200, 1200, 1600]);
assert.deepEqual(countedOf(REAL), [true, false, true]);
assert.equal(forecastersOf(REAL).length, 3);
// The browser re-run matches the chain: every colony hash, the market hash,
// the swarm belief and both snapshot hashes.
const v = verifyRequest(REAL);
assert.ok(v.ok, JSON.stringify(v));
assert.equal(v.colonies.length, 3);
assert.ok(v.colonies.every((c) => c.match));
assert.equal(v.market.replay, REAL.market_hash);
assert.ok(v.swarm && v.oddsHash && v.agentsHash);
// The same through the sim's own entry point.
const ref = forecastMarket(hexToBytes(REAL.seed), REAL.colony, REAL.market.odds, REAL.market.odds_6h, [0, 0, 0, 0, 0],
  new Uint8Array(32), REAL.agents.odds, hexToBytes(REAL.agents.hash));
assert.equal(ref.hash, REAL.market_hash);
assert.deepEqual(ref.swarm, REAL.swarm);

// Tampering shows: a wrong colony hash, a wrong market hash, a wrong swarm, a wrong agent post.
const bad = (f) => verifyRequest(f(structuredClone(REAL)));
const hit = (x) => x.replace(/^./, (c) => (c === "0" ? "1" : "0"));
const t1 = bad((r) => (r.colony_hashes[1] = hit(r.colony_hashes[1]), r));
assert.ok(!t1.ok && !t1.colonies[1].match && t1.colonies[0].match);
assert.ok(!bad((r) => (r.market_hash = hit(r.market_hash), r)).ok);
assert.ok(!bad((r) => (r.swarm[0] += 1, r.swarm[1] -= 1, r)).ok);
assert.ok(!bad((r) => (r.agents.posts[0][1] = [3000, 3000, 1200, 1200, 1600], r)).agentsHash);
assert.ok(!bad((r) => (r.market.odds_hash = hit(r.market.odds_hash), r)).oddsHash);
// A different seed gives different hashes.
assert.ok(!bad((r) => (r.seed = hit(r.seed), r)).ok);

// Holders staked on the request during the agents' window: Community reads
// the frozen weights, every colony commits the stake hash, and Community votes.
const staked = structuredClone(REAL);
staked.stakes = {
  hash: "5a".repeat(32), weights: [0, 3000, 0, 0, 0],
  entries: [["bob.testnet", REAL.colony, 1, String(9n * ONE)], ["bob.testnet", 1, 0, String(ONE)]],
};
const sref = forecastMarket(hexToBytes(staked.seed), staked.colony, staked.market.odds, staked.market.odds_6h,
  staked.stakes.weights, hexToBytes(staked.stakes.hash), staked.agents.odds, hexToBytes(staked.agents.hash));
Object.assign(staked, { colony_hashes: sref.colonies.map((c) => c.hash), market_hash: sref.hash, swarm: sref.swarm });
assert.deepEqual(countedOf(staked), [true, true, true]);
assert.deepEqual(stakesOf(staked).wallets, [{ id: "bob.testnet", stakes: [0, 9, 0, 0, 0] }], "other colonies' entries ignored");
assert.ok(verifyRequest(staked).ok, JSON.stringify(verifyRequest(staked)));
assert.notEqual(sref.hash, REAL.market_hash);
// Dropping the stakes (an old contract's view) no longer matches.
assert.ok(!verifyRequest({ ...staked, stakes: undefined }).ok);
// Staking rides the agents' window; withdrawals wait for the third colony.
const win = { ...REAL, phase: "forecasting", forecast_by_ms: 1000 };
assert.ok(stakingOpen(win, 999) && !stakingOpen(win, 1000));
assert.ok(!stakesLocked(win, 999) && stakesLocked(win, 1000));
assert.ok(stakesLocked({ ...REAL, phase: "running" }, 0) && !stakesLocked(REAL, 0));
assert.ok(commands("c.testnet", "a.testnet", "m", 3).signs.stake.includes('"colony":32771'));

// A request part-way through: the colonies the chain has run are checked.
const part = structuredClone(REAL);
Object.assign(part, { phase: "running", colony_hashes: REAL.colony_hashes.slice(0, 2), crankers: REAL.crankers.slice(0, 2),
  swarm: null, market_hash: null, paid_keepers: [], paid_agents: [], paid_cranks: [], to_treasury: "0" });
const vp = verifyRequest(part);
assert.ok(vp.ok && vp.colonies.length === 2 && vp.market === null);
assert.deepEqual(payoutRows(part), []);
// Before the first crank there is nothing to re-run.
const early = structuredClone(part);
Object.assign(early, { phase: "forecasting", colony_hashes: [], agents: null, seed: null });
assert.equal(verifyRequest(early).ok, false);
assert.equal(forecastersOf(early), null);
assert.equal(verifyRequest(null).ok, false);

// No agent posted: the zero snapshot hash still checks out and Agents sits out.
const noAgents = structuredClone(REAL);
noAgents.agents = { odds: [0, 0, 0, 0, 0], hash: "0".repeat(64), posts: [] };
assert.deepEqual(countedOf(noAgents), [true, false, false]);
const vn = verifyRequest(noAgents);
assert.ok(vn.agentsHash);
assert.ok(!vn.ok); // the stored hashes were for the agents' map, so the re-run differs

// ---- what is due, and the timeline ----
const keepers = ["keeper.antonomy-oracle.testnet"];
const T = REAL.created_at_ms;
const odds = { ...REAL, phase: "odds", market: null, agents: null, seed: null, colony_hashes: [], crankers: [], swarm: null,
  market_hash: null, forecast_by_ms: null, keepers_posted: [], paid_keepers: [], paid_agents: [], paid_cranks: [], to_treasury: "0" };
assert.equal(due(odds, T + 1000), null);
assert.equal(due(odds, T + 1000, keepers), null);
assert.equal(due({ ...odds, keepers_posted: keepers }, T + 1000, keepers), "finalize_request_odds"); // all keepers posted
assert.equal(due(odds, odds.odds_by_ms), "finalize_request_odds");                                    // window over
const fc = { ...REAL, phase: "forecasting", colony_hashes: [], agents: null, seed: null, crankers: [], swarm: null, market_hash: null,
  paid_keepers: [], paid_agents: [], paid_cranks: [], to_treasury: "0" };
assert.equal(due(fc, fc.forecast_by_ms - 1), null);
assert.ok(agentsMayPost(fc, fc.forecast_by_ms - 1));
assert.ok(!agentsMayPost(fc, fc.forecast_by_ms));
assert.equal(due(fc, fc.forecast_by_ms), "crank_request");
assert.equal(due(part, 0), "crank_request");
assert.equal(due(REAL, Infinity), null);
assert.ok(!agentsMayPost(REAL, 0));

const states = (r, now) => timeline(r, CFG, now).map((s) => s.state);
assert.equal(timeline(REAL, CFG).length, 4 + 3 + 1);
assert.ok(states(REAL).every((s) => s === "done"));
const s1 = states(odds, T);
assert.deepEqual(s1.slice(0, 3), ["done", "now", ""]);
assert.deepEqual(states(fc, fc.forecast_by_ms - 1).slice(0, 5), ["done", "done", "done", "now", ""]);
assert.deepEqual(states(fc, fc.forecast_by_ms).slice(0, 6), ["done", "done", "done", "done", "now", ""]); // window closed: crank 1 next
const sp = states(part, 0);
assert.deepEqual(sp.slice(3, 8), ["done", "done", "done", "now", ""]); // two cranked: crank 3 is next
const skipped = { ...odds, phase: "skipped" };
const tl = timeline(skipped, CFG);
assert.equal(tl.at(-1).key, "skip");
assert.equal(tl.at(-1).state, "now");
assert.deepEqual(payoutRows(skipped), [{ role: "refund", account: skipped.requester, amount: BigInt(skipped.fee) }]);

// ---- the agent's own odds form ----
assert.deepEqual(marketOdds(REAL.market.odds), REAL.market.odds); // already whole
assert.deepEqual(marketOdds([4300, 1550, 1205, 1150, 1745]), [4350, 1550, 1205, 1150, 1745]); // dust goes to the top outcome
assert.deepEqual(readOdds(["", ""]), { odds: null });
assert.deepEqual(readOdds(["60", "40"]), { odds: [6000, 4000] });
assert.deepEqual(readOdds(["33.33", "66.67"]), { odds: [3333, 6667] });
assert.match(readOdds(["60", ""]).why, /every outcome/);
assert.match(readOdds(["60", "30"]).why, /adds up to 90\.0%/);
assert.match(readOdds(["120", "-20"]).why, /0 to 100/);
assert.match(readOdds(["abc", "50"]).why, /0 to 100/);

// ---- wallet outcomes: contract panics come back as outcomes, not throws ----
assert.equal(failureOf({ status: { SuccessValue: "" }, receipts_outcome: [{ outcome: { status: { SuccessValue: "" } } }] }), null);
assert.equal(failureOf(undefined), null);
assert.equal(failureOf(null), null);
const panic = { ActionError: { index: 0, kind: { FunctionCallError: { ExecutionError: "Smart contract panicked: InsufficientBalance" } } } };
assert.match(failureOf({ status: { Failure: panic } }), /InsufficientBalance/);
assert.match(failureOf({ status: { SuccessValue: "" }, receipts_outcome: [{ outcome: { status: { Failure: panic } } }] }), /InsufficientBalance/);
assert.match(failureOf({ status: { Failure: { ActionError: { kind: "AccountDoesNotExist" } } } }), /AccountDoesNotExist/);

// ---- reading the chain through a fake reader ----
const reqs = Array.from({ length: 7 }, (_, i) => ({ ...REAL, id: i, market_id: i === 5 ? "other-market" : "m", requester: i % 2 ? "a.testnet" : "b.testnet" }));
const fake = {
  requestCount: async () => reqs.length,
  requests: async (from, limit) => reqs.slice(from, from + limit),
};
assert.deepEqual((await recentRequests(3, fake)).map((r) => r.id), [4, 5, 6]);
assert.equal((await recentRequests(50, fake)).length, 7);
assert.deepEqual(await recentRequests(3, { ...fake, requestCount: async () => 0 }), []);
assert.equal((await findRequest("m", "a.testnet", 0, fake)).id, 3);   // newest by that requester
assert.equal((await findRequest("m", "b.testnet", 0, fake)).id, 6);
assert.equal(await findRequest("nope", "a.testnet", 0, fake), null);
assert.equal((await findRequest("other-market", null, 0, fake)).id, 5);

// ---- the agent tool's commands ----
const c = commands("anto.testnet", "me.testnet", "ecb-decision-december", 4, [6000, 3000, 1000]);
assert.equal(c.ask, "python3 -I bots/recruit.py ask --contract anto.testnet --account me.testnet --market ecb-decision-december");
assert.equal(c.verify, "python3 -I bots/recruit.py verify --contract anto.testnet --request 4");
assert.match(c.post, /--odds 6000,3000,1000 --send$/);
assert.match(c.signs.request, /request_forecast json-args '\{"market_id":"ecb-decision-december"\}' prepaid-gas '30.0 Tgas'/);
assert.match(c.signs.post, /"colony":32772/);
assert.match(c.signs.crank, /'100.0 Tgas'/);
assert.match(commands("anto.testnet", "me.testnet", "ecb", 0, null, { outcomes: ["Cut", "Rate hold"], odds: [6000, 4000] }).askSend,
  /--market ecb --wait --odds 'Cut=6000,Rate hold=4000' --send$/);

console.log("recruit: all tests passed");
