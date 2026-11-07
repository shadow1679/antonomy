// Offline tests for Add a market, the request panel on Recruit and Live, and
// the fee split it shows: node web/test_addmarket.mjs
import assert from "node:assert/strict";
import { slugOf, overlapOf, payBlock } from "./addmarket.mjs";
import { ONE, parseConfig, feeSplitHTML } from "./recruit.mjs";

// ---- slugOf: a link or bare slug is looked up directly; anything else is a search ----

assert.equal(slugOf("https://polymarket.com/event/fed-decision-in-december"), "fed-decision-in-december");
assert.equal(slugOf("polymarket.com/event/fed-decision-in-december?tid=1"), "fed-decision-in-december");
assert.equal(slugOf("https://polymarket.com/fr/event/Fed-Decision-In-December"), "fed-decision-in-december");
assert.equal(slugOf("worlds-2026-winner"), "worlds-2026-winner");
assert.equal(slugOf("bitcoin"), null, "one word is a search");
assert.equal(slugOf("fed rate cut"), null, "words are a search");
assert.equal(slugOf("short-1"), null, "under 8 characters is a search");

// ---- overlapOf: already in the round, or already requested ----

const markets = [
  { marketId: "worlds-2026-winner", index: 0, key: "m0" },
  { marketId: "fed-decision-in-december", index: 3, key: "m3" },
];
const requests = [
  { id: 4, market_id: "ecb-rate", phase: "done" },
  { id: 9, market_id: "ecb-rate", phase: "skipped" },
  { id: 7, market_id: "ecb-rate", phase: "forecasting" },
];
assert.deepEqual(overlapOf("fed-decision-in-december", markets, requests), { round: { n: 4, anchor: "mk-m3" }, request: null });
assert.equal(overlapOf("ecb-rate", markets, requests).round, null);
assert.equal(overlapOf("ecb-rate", markets, requests).request.id, 7, "the newest that wasn't skipped");
assert.deepEqual(overlapOf("nothing-here", markets, requests), { round: null, request: null });
assert.deepEqual(overlapOf("nothing-here"), { round: null, request: null });

// ---- payBlock: only a wallet that has used the faucet can come up short ----

const fee = 100n * ONE;
assert.equal(payBlock(150n * ONE, fee, true), null);
assert.equal(payBlock(100n * ONE, fee, true), null, "exactly the fee is enough");
assert.equal(payBlock(0n, fee, false), null, "the first request claims the faucet");
assert.equal(payBlock(40n * ONE, fee, true), "You have 40 $ANTO; a request costs 100. The faucet is once per account.");
assert.equal(payBlock(null, fee, true), null, "unknown balance blocks nothing");

// ---- feeSplitHTML: the four pools, with or without their notes ----

const cfg = parseConfig({
  fee: String(100n * ONE), keeper_bps: 2000, agent_bps: 3000, crank_bps: 3000, odds_window_ms: 600000,
  forecast_window_ms: 60000, agent_deposit: String(10n * ONE), crank_bounty: String(10n * ONE),
});
const html = feeSplitHTML(cfg);
assert.match(html, /Fee <b class="num">100<\/b> \$ANTO/);
for (const k of ["keepers", "agents", "crank", "treasury"]) assert.match(html, new RegExp(`<span data-fee="${k}" style="--part: \\d+">`));
assert.match(html, /<span data-fee="keepers" style="--part: 200">/);
assert.match(html, /<li data-fee="treasury"><span>Treasury<\/span><span class="num">20<\/span><small>/);
assert.match(html, /10 per call × 3 calls/);
assert.doesNotMatch(feeSplitHTML(cfg, { notes: false }), /<small>/);

console.log("addmarket: ok");
