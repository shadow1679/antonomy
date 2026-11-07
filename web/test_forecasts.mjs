// Offline tests for the Forecast list (web/forecasts.mjs): node web/test_forecasts.mjs
// A round is built from canned contract JSON, as in test_round_chain.mjs, and
// its colonies' "chain" hashes come from the same sim code.
import assert from "node:assert/strict";
import { forecastMarket, sha256, toHex, oddsSnapshotHash } from "../sim/js/antosim.mjs";
import { agentSnapshot } from "./agents.mjs";
import { buildRound, verifyMarket } from "./roundchain.mjs";

globalThis.location = { search: "?contract=x.testnet" }; // the links keep a ?contract= override
const F = await import("./forecasts.mjs");

const hex = (s) => toHex(sha256(new TextEncoder().encode(s)));
const bytes = (h) => Uint8Array.from(h.match(/../g), (x) => parseInt(x, 16));
const seedHex = hex("forecast-list-seed"), stakeHash = hex("forecast-list-stakes");

const mv = {
  colony: 1, market_id: "fed-decision-in-october-20260617190323537", outcomes: ["Cut", "Hold", "Hike"],
  odds: [6200, 2800, 1000], odds_6h: [5500, 3300, 1200], raw_hashes: [],
};
mv.odds_hash = toHex(oddsSnapshotHash(mv.odds, mv.odds_6h));
const weights = [3000, 0, 12000];
const posts = [{ id: "a.testnet", odds: [5500, 3500, 1000] }, { id: "b.testnet", odds: [6500, 3000, 500] }];
const snap = agentSnapshot(posts, 3);
const agents = { odds: snap.odds, hash: toHex(snap.hash), posts: posts.map((p) => [p.id, p.odds]) };
const truth = forecastMarket(bytes(seedHex), 1, mv.odds, mv.odds_6h, weights, bytes(stakeHash), agents.odds, snap.hash);
const hashes = truth.colonies.map((c) => c.hash);

const run = (n) => ({
  round: 4, seed: seedHex, stake_hash: stakeHash, done: n === 3,
  markets: [{ colony: 1, weights, agents, colony_hashes: hashes.slice(0, n), crankers: [], swarm: n === 3 ? truth.swarm : null, market_hash: n === 3 ? truth.hash : null }],
});
const status = (phase, extra = {}) => ({ round: 4, phase, close_at_ms: Date.UTC(2026, 9, 30, 14, 5), publish_at_ms: Date.UTC(2026, 9, 30, 14, 20), drand_round: 5203117, markets: [mv], run: null, ...extra });

// ---- before the seed: market odds, no gap, status by phase
{
  const rd = buildRound(status("posting"));
  assert.equal(rd.drandRound, 5203117);
  const c = F.roundCard(rd.markets[0], rd);
  assert.equal(c.id, "mk-m0");
  assert.equal(c.n, "1");
  assert.equal(c.href, "market.html?m=m0&contract=x.testnet");
  assert.equal(c.colHref(1), "market.html?m=m0&contract=x.testnet&c=community");
  assert.equal(F.viewOf(c.m, null), null);
  assert.deepEqual(F.statusOf(c, null), ["pending", "Staking until 14:05 UTC", ""]);
  const html = F.cardHTML(c, null);
  assert.match(html, /gap after the seed<\/small>/);
  assert.match(html, /swarm belief after the seed at 14:20 UTC/);
  assert.match(html, /55 →<\/span> 62/);                       // 6h ago → now, whole points
  assert.match(html, /Scouts waiting for the seed/);
  assert.doesNotMatch(html, /tag-forecast/);                   // the page's sticky line labels the list, once
  assert.match(html, /Polymarket · <code>fed-decision/);
  assert.doesNotMatch(html, /href="https?:/);                  // never a link off the site
  assert.deepEqual(F.statusOf(F.roundCard(rd.markets[0], buildRound(status("agents"))), null)[1], "Agents post until 14:20 UTC");
  assert.deepEqual(F.statusOf(F.roundCard(rd.markets[0], buildRound(status("ready"))), null), ["pending", "Waiting for the seed", "drand round #5203117"]);
  assert.match(F.roundLine(buildRound(status("ready"))), /drand round #5203117/);
  const steps = F.stepperStepsHTML(buildRound(status("agents")));
  assert.match(steps, /data-state="past"><b>Staking/);
  assert.match(steps, /data-state="now" aria-current="step"><b>Agents post/);
  assert.match(F.stepperStepsHTML(buildRound(status("skipped"))), /data-state="skipped"><b>Skipped/);
}

// ---- partial: the swarm so far comes from the colonies re-run and matched here
{
  const rd = buildRound(status("running", { run: run(2) }));
  const c = F.roundCard(rd.markets[0], rd);
  assert.equal(F.viewOf(c.m, null), null);                     // nothing re-run yet
  assert.deepEqual(F.statusOf(c, null).slice(0, 2), ["running", "2 of 3 colonies"]);
  const v = await verifyMarket(c.m);
  const view = F.viewOf(c.m, v);
  assert.equal(view.partial, true);
  assert.deepEqual(view.done, [true, true, false]);
  assert.match(F.headGapHTML(c, view), /pts so far/);
  assert.match(F.tableHTML(c, view), /so far: \d of 3 colonies counted/);
  assert.match(F.leadHTML(c, 2, null), /not cranked yet/);
  // A partial market never headlines the page.
  assert.equal(F.widestCard([c], () => v), null);
  // Seed drawn, nothing cranked yet: waiting for a crank, not for the seed.
  const r0 = buildRound(status("running", { run: run(0) }));
  const c0 = F.roundCard(r0.markets[0], r0);
  assert.deepEqual(F.statusOf(c0, null).slice(0, 2), ["pending", "Waiting for a crank"]);
  assert.match(F.cardHTML(c0, null), /gap once it runs/);
  assert.match(F.tableHTML(c0, null), /swarm belief once its colonies run/);
}

// ---- done: the chain's swarm belief, the gap in whole points, verified
{
  const rd = buildRound(status("done", { run: run(3) }));
  const c = F.roundCard(rd.markets[0], rd);
  const v = await verifyMarket(c.m);
  assert.equal(v.ok, true);
  const view = F.viewOf(c.m, null);                            // the chain's swarm needs no re-run
  assert.equal(view.partial, false);
  assert.deepEqual(view.swarm, truth.swarm.map((x) => Math.round(x / 100)));
  assert.deepEqual(view.market, [62, 28, 10]);
  view.gap.forEach((g, o) => assert.equal(g, view.swarm[o] - view.market[o]));
  // Three outcomes: the headline names the widest |gap|.
  assert.equal(Math.abs(view.gap[view.lead]), Math.max(...view.gap.map(Math.abs)));
  assert.deepEqual(F.statusOf(c, null)[0], "done");
  assert.deepEqual(F.statusOf(c, v)[0], "match");
  assert.deepEqual(F.statusOf(c, { ...v, colonies: [{ state: "mismatch" }] })[0], "mismatch");
  assert.equal(F.widestCard([c]), c);
  const line = F.widestHTML(c, v);
  assert.match(line, /Widest gap now/);
  assert.match(line, /href="#mk-m0"/);
  assert.match(F.cardHTML(c, v, { widest: true }), /class="fc-card is-widest"[\s\S]*Widest gap/);
  const parts = F.cardParts(c, v);
  assert.equal(parts.leads.length, 3);
  assert.match(parts.status, /Verified/);
}

// ---- two outcomes mirror: the headline names the first, the second row says so
{
  const m = { outcomes: ["Yes", "No"], odds: [6200, 3800], odds6h: [5500, 4500], cranked: 3,
    forecasters: [{ counted: true, cranked: true }, { counted: false, cranked: true }, { counted: true, cranked: true }],
    swarm: [4100, 5900], title: "Will the Fed cut?", marketId: "fed-cut", key: "m1", index: 1 };
  const c = { id: "mk-m1", n: "2", m, rd: { phase: "done" }, req: null, href: "#", colHref: () => "#" };
  const view = F.viewOf(m, null);
  assert.equal(view.lead, 0);
  assert.equal(view.gap[0], -21);
  assert.equal(view.sat, 1);
  assert.match(F.headGapHTML(c, view), /−21/);
  const t = F.tableHTML(c, view);
  assert.match(t, /mirrors Yes/);
  assert.match(t, /mean of 2 colonies, 1 sat out/);
  assert.match(F.leadHTML(c, 1, null), /out · nobody staked/);
  assert.match(F.cardHTML(c, null), /Yes or No/);
}

// ---- grouped Other: last row, folded label, a capped bar
{
  const m = { outcomes: ["A", "B", "C", "D", "Other"], odds: [1800, 1600, 1400, 1200, 4000], odds6h: [1800, 1700, 1300, 1200, 4000], cranked: 3,
    forecasters: [0, 1, 2].map(() => ({ counted: true, cranked: true })), swarm: [9000, 0, 0, 0, 1000], title: "UCL winner", marketId: "ucl", key: "m2", index: 2 };
  const c = { id: "mk-m2", n: "3", m, rd: { phase: "done" }, req: null, href: "#", colHref: () => "#" };
  const t = F.tableHTML(c, F.viewOf(m, null));
  assert.match(t, /Other <small>· the rest, folded/);
  assert.match(t, /--gap: 50"/);                               // +72 pts caps at the full half track
  assert.match(F.cardHTML(c, null), /5 outcomes, Other grouped/);
}

// ---- sorting: widest gap first, no-gap markets last in trending order
{
  const mk = (index, swarm) => ({ m: { index, key: `m${index}`, outcomes: ["Y", "N"], odds: [5000, 5000], forecasters: swarm ? [{ counted: true, cranked: true }] : null, swarm, cranked: swarm ? 3 : 0 } });
  const cards = [mk(0, null), mk(1, [5500, 4500]), mk(2, [8000, 2000]), mk(3, null)];
  assert.deepEqual(F.sortCards(cards, "gap").map((c) => c.m.index), [2, 1, 0, 3]);
  assert.deepEqual(F.sortCards(cards, "rank").map((c) => c.m.index), [0, 1, 2, 3]);
  assert.equal(F.widestCard(cards).m.index, 2);
}

// ---- requests: waiting for keepers, skipped, yours
{
  const r = { id: 12, colony: 0x8000 + 12, requester: "me.testnet", market_id: "eurovision-2027-winner", phase: "odds", forecast_by_ms: 0 };
  const c = F.requestCard(r, null, "me.testnet");
  assert.equal(c.id, "mk-r12");
  assert.equal(c.n, "R12");
  assert.equal(c.href, "market.html?r=12&contract=x.testnet");
  assert.equal(c.mine, true);
  const html = F.cardHTML(c, null);
  assert.match(html, /Waiting for keepers/);
  assert.match(html, /Gap once the keepers post/);
  assert.match(html, /class="fc-yours">yours/);
  assert.match(html, /Market page: follow the request ›/);
  const skipped = F.cardHTML(F.requestCard({ ...r, phase: "skipped" }, null, "other.testnet"), null, { fee: "100" });
  assert.match(skipped, /is-skipped/);
  assert.match(skipped, /100 \$ANTO fee refunded/);
  assert.doesNotMatch(skipped, /yours/);
}

// ---- track record: honest headline, never a fake number
{
  assert.match(F.trackHeadline(null), /Too few markets to compare yet \(0 scored, 20 needed\)/);
  assert.match(F.trackHTML(null), /nothing is scored/);
  assert.doesNotMatch(F.trackHTML(null), /Brier score, lower/);
  const t = { sample: true, from: "Jan 2026", to: "Sep 2026", market: 0.171, swarm: 0.214, scored: 48, waiting: 6, disputed: 2, void: 1 };
  assert.equal(F.trackHeadline(t), "The market's own odds scored better than the swarm.");
  assert.equal(F.trackHeadline({ ...t, market: 0.3 }), "The swarm scored better than the market's own odds.");
  assert.match(F.trackHeadline({ ...t, scored: 19 }), /Too few/);
  const html = F.trackHTML(t);
  assert.match(html, /Sample backtest/);
  assert.match(html, /48 scored · 6 waiting \(2 disputed\) · 1 resolved 50-50/);
  assert.equal(F.trackFull(t), true);
  assert.equal(F.trackFull(null), false);
  assert.equal(F.trackFull({ ...t, scored: 19 }), false);
  assert.match(F.trackLineHTML(null), /0 markets scored so far[\s\S]*after 20/);
}

// ---- product rules: no betting words anywhere the list writes
{
  const rd = buildRound(status("done", { run: run(3) }));
  const c = F.roundCard(rd.markets[0], rd);
  const all = [F.cardHTML(c, await verifyMarket(c.m), { widest: true }), F.widestHTML(c, null), F.trackHTML(null), F.roundLine(rd)].join(" ");
  assert.doesNotMatch(all, /\b(bet|wager|payout|win|wins|edge|profit)\b/i);
  assert.doesNotMatch(all.replace(/not a probability/g, ""), /probabilit/i);
}

// The track record from the scorebook (docs/FORECAST_QUALITY.md §2).
{
  const src = (source, count, brier_sum) => ({ source, count, brier_sum, market_sum: 0, skill_sum: 0 });
  const tally = {
    books: 24, fifty_fifty: 1, void: 1, min_scored: 20, open: ["a", "b", "c"], colony_weights: [250, 1000, 1555],
    sources: [src("market", 24, 24 * 1710), src("momentum", 24, 0), src("community", 3, 0), src("agents", 20, 0), src("swarm", 24, 24 * 2140)],
  };
  const t = F.trackFromTally(tally, [{ resolution: { state: "disputed" } }, { resolution: null }]);
  assert.deepEqual([t.scored, t.waiting, t.disputed, t.void, t.market, t.swarm], [24, 3, 1, 2, 0.171, 0.214]);
  assert.ok(F.trackFull(t));
  assert.match(F.trackHTML(t), /The market's own odds scored better than the swarm/);
  assert.match(F.weightsLine(t), /Momentum ×0\.25 · Community ×1\.00 · Agents ×1\.55/);
  const early = F.trackFromTally({ ...tally, books: 3, colony_weights: [1000, 1000, 1000] });
  assert.ok(!F.trackFull(early));
  assert.match(F.trackLineHTML(early), /3 markets scored so far · 3 waiting/);
  assert.match(F.trackLineHTML(early), /weigh the same in the swarm belief until 20 markets are scored/);
  assert.equal(F.trackFromTally(null), null);
}

console.log("forecasts: ok");
