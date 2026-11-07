// The round, read from the contract. loadRound() turns the contract's
// round_status / last_round (and the stake snapshot and totals) into one
// normalized round that every page draws the same way; verifyMarket() re-runs
// a market's colonies in the browser from the on-chain inputs and compares
// their hashes with the chain's. Pure data, no DOM, so Node can test it with
// canned contract JSON (pass `call` to stub the view calls).
//
// What is real: market ids, odds and their raw-response hashes, stakes, agent
// posts, the seed, every colony hash, the swarm belief and the market hash all
// come from the contract. What is not on chain: a market's title (the contract
// stores only the Polymarket event slug), so titles are derived from the slug.
// The seed is the block's random seed at the first crank, a stand-in for the
// drand commit.

import {
  toHex, marketResult, oddsSnapshotHash, KINDS, EQUAL_WEIGHTS,
} from "../sim/js/antosim.mjs";
import { marketForecasters, KIND_NAMES } from "./round.mjs";
import { view, hexToBytes, ZERO_HASH, ONE } from "./chain.mjs";
import { walletWeights } from "./ds/staker-ants.mjs";

export const PHASES = ["posting", "agents", "ready", "running", "done", "skipped"];

// "fed-decision-in-october-20260617190323537" -> "Fed decision in October",
// "mlb-mil-tb-2026-10-27" -> "MLB MIL TB, 27 Oct 2026". The trailing numeric
// part of an event slug is its id; all-digit ids (an old numeric market id)
// have no words to show. Some slugs end in a random tag with no vowels
// ("…-emergency-byptptpt"), which is dropped.
const UPPER = new Set(["mlb", "nba", "nfl", "nhl", "wta", "atp", "ufc", "epl", "mls", "f1", "btc", "eth", "sol", "xrp",
  "ecb", "boe", "us", "uk", "eu", "un", "gdp", "cpi", "ai", "gop", "nyc"]);
const TEAM_LEAGUES = new Set(["mlb", "nba", "nfl", "nhl"]); // team codes follow: "mil-tb"
const NAME_LEAGUES = new Set(["wta", "atp", "ufc"]);        // player names follow
const MONTHS = ["january", "february", "march", "april", "may", "june", "july", "august", "september", "october", "november", "december"];
const cap = (w) => w[0].toUpperCase() + w.slice(1);

export function slugTitle(slug) {
  const s = String(slug ?? "");
  let words = s.replace(/-?\d{6,}$/, "").split("-").filter(Boolean);
  if (!words.length || /^\d+$/.test(words.join(""))) return `Polymarket event ${s}`;
  const last = words[words.length - 1];
  if (words.length > 1 && /^[a-z]{6,}$/.test(last) && !/[aeiou]/.test(last)) words.pop();
  let date = "";
  const n = words.length;
  if (n >= 4 && /^\d{4}$/.test(words[n - 3]) && /^\d{2}$/.test(words[n - 2]) && /^\d{2}$/.test(words[n - 1]) && +words[n - 2] >= 1 && +words[n - 2] <= 12) {
    date = `${+words[n - 1]} ${cap(MONTHS[+words[n - 2] - 1].slice(0, 3))} ${words[n - 3]}`;
    words = words.slice(0, -3);
  }
  const lg = words[0];
  words = words.map((w, i) => {
    if (UPPER.has(w) || (i > 0 && TEAM_LEAGUES.has(lg) && /^[a-z]{2,3}$/.test(w))) return w.toUpperCase();
    if (MONTHS.includes(w) || (i > 0 && NAME_LEAGUES.has(lg))) return cap(w);
    return w;
  });
  return cap(words.join(" ")) + (date ? `, ${date}` : "");
}

const bytesOrZero = (hex) => hexToBytes(hex && hex.length === 64 ? hex : ZERO_HASH);

// Wallet rows for staker ants from stake snapshot entries
// [[account, colony, option, amount_yocto], ...] on one colony.
export function walletsFor(entries, colony, nOptions) {
  const by = new Map();
  for (const [acct, c, o, amount] of entries ?? []) {
    if (c !== colony || o >= nOptions) continue;
    if (!by.has(acct)) by.set(acct, { id: acct, stakes: new Array(nOptions).fill(0) });
    by.get(acct).stakes[o] += Number(BigInt(amount) / (ONE / 1000n)) / 1000;
  }
  return [...by.values()];
}

// One market: `mv` is a MarketView; `run` is null before the colonies run, else
// { seed: hex, stakeHash: hex, weights, agents: {odds, hash, posts},
// colonyHashes, crankers, swarm, marketHash, colonyWeights }. `extra` can carry stakes
// (raw totals per option) and wallets. `tag` prefixes colony keys.
export function buildMarket(mv, run, { index = 0, tag = "m", stakes = null, wallets = null } = {}) {
  const outcomes = mv.outcomes, n = outcomes.length;
  const odds = mv.odds, odds6h = mv.odds_6h;
  // The odds 1 hour and 24 hours ago, when every agreeing keeper posted them.
  const odds1h = mv.odds_1h ?? null, odds24h = mv.odds_24h ?? null;
  const ext = odds1h && odds24h ? [odds1h, odds24h] : null;
  const m = {
    index, key: `${tag}${index}`,
    colony: mv.colony,
    marketId: mv.market_id,
    title: slugTitle(mv.market_id),
    outcomes, odds, odds6h, odds1h, odds24h,
    oddsHash: mv.odds_hash,
    // The page can check the keepers' median odds against the hash it was given.
    oddsHashOk: toHex(oddsSnapshotHash(odds, odds6h, ext)) === mv.odds_hash,
    rawHashes: mv.raw_hashes ?? [],
    stakes,
    run: null, forecasters: null, swarm: null, marketHash: null, cranked: 0, done: false,
  };
  if (!run) return m;
  const weights = run.weights ?? new Array(n).fill(0);
  const agents = run.agents ?? { odds: new Array(n).fill(0), hash: ZERO_HASH, posts: [] };
  const stakeHash = bytesOrZero(run.stakeHash);
  const seed = hexToBytes(run.seed);
  const ws = wallets ?? [];
  m.run = { seed: run.seed, stakeHash: run.stakeHash, weights, agents, crankers: run.crankers ?? [] };
  m.agents = agents;
  m.weights = weights;
  // The colonies' weights in the swarm belief, frozen at the round's first
  // crank (equal for rounds before the scorebook, and until it has a record).
  m.colonyWeights = run.colonyWeights ?? EQUAL_WEIGHTS;
  const specs = marketForecasters(seed, mv.colony, {
    title: m.title, outcomes, odds, odds6h, odds1h, odds24h, weights, stakeHash,
    wallets: ws, agentOdds: { odds: agents.odds, hash: hexToBytes(agents.hash), posts: agents.posts ?? [] },
  }, m.key);
  const hashes = run.colonyHashes ?? [];
  m.forecasters = specs.map((s, k) => ({
    ...s, chainHash: hashes[k] ?? null, cranker: run.crankers?.[k] ?? null, cranked: !!hashes[k],
  }));
  m.cranked = hashes.length;
  m.swarm = run.swarm ?? null;
  m.marketHash = run.marketHash ?? null;
  m.done = !!(run.swarm && run.marketHash);
  return m;
}

// Normalize the contract's view of one round. `markets` are MarketViews,
// `run` is a RoundRunView or null.
function roundOf({ id, markets, run, tag, totals, snap }) {
  const ms = (markets ?? []).map((mv, i) => {
    const rm = run?.markets.find((x) => x.colony === mv.colony);
    return buildMarket(mv, rm ? {
      seed: run.seed, stakeHash: run.stake_hash, weights: rm.weights, agents: rm.agents,
      colonyHashes: rm.colony_hashes, crankers: rm.crankers, swarm: rm.swarm, marketHash: rm.market_hash,
      colonyWeights: run.colony_weights,
    } : null, {
      index: i, tag,
      stakes: totals?.[i] ?? null,
      wallets: snap ? walletsFor(snap.entries, mv.colony, mv.outcomes.length) : null,
    });
  });
  return {
    id, tag, markets: ms,
    seed: run?.seed ?? null, stakeHash: run?.stake_hash ?? null,
    all: ms.flatMap((m) => m.forecasters ?? []),
  };
}

// status: round_status JSON; last: last_round JSON or null. opts.totals: raw
// stake totals per current market (yocto strings), opts.snap: the stake
// snapshot once staking has closed.
export function buildRound(status, last = null, { totals = null, snap = null } = {}) {
  const cur = roundOf({
    id: status.round, markets: status.markets, run: status.run, tag: "m",
    totals: totals && status.markets ? totals : null, snap,
  });
  const previous = last ? roundOf({ id: last.run.round, markets: last.markets, run: last.run, tag: "p" }) : null;
  const round = {
    ...cur,
    phase: status.phase,
    closeMs: status.close_at_ms,
    publishMs: status.publish_at_ms,
    drandRound: status.drand_round ?? null,
    hasRun: !!status.run,
    previous,
  };
  // The round whose colonies the pages draw: this one once its run starts,
  // else the previous finished round, if there is one.
  round.shown = status.run || !previous ? round : previous;
  return round;
}

// Read the round from the chain. `call(method, args)` defaults to a contract view.
// The market the keepers have posted so far, as MarketView objects (colony
// 1 + index, the accepted market's colony), taken from the largest group of
// keepers who posted the same market ids and outcomes. Odds are the first
// poster's: the contract takes the per-outcome median at close.
export async function proposalFromKeepers(call = view) {
  const [keepers] = await call("keepers");
  const posts = (await Promise.all(keepers.map(async (k) => [k, await call("keeper_post", { account_id: k })])))
    .filter(([, p]) => p && p.length);
  if (!posts.length) return null;
  const key = ([, p]) => JSON.stringify(p.map((m) => [m.market_id, m.outcomes]));
  const groups = new Map();
  for (const x of posts) groups.set(key(x), [...(groups.get(key(x)) ?? []), x]);
  const group = [...groups.values()].sort((a, b) => b.length - a.length)[0];
  return group[0][1].map((m, i) => ({
    colony: 1 + i,
    market_id: m.market_id,
    outcomes: m.outcomes,
    odds: m.odds,
    odds_6h: m.odds_6h,
    odds_hash: toHex(oddsSnapshotHash(m.odds, m.odds_6h)),
    raw_hashes: group.map(([k, p]) => [k, p[i].raw_hash]),
  }));
}

export async function loadRound({ call = view, now = Date.now() } = {}) {
  let [status, last] = await Promise.all([call("round_status"), call("last_round")]);
  let snap = null, totals = null;
  // While the round is posting the contract has no market yet (it is accepted
  // after staking closes), but the keepers' own posts are readable. Show the
  // proposal so a wallet knows what it would stake on; it is final at close.
  // The same holds after close until someone calls finalize_markets.
  let proposed = false;
  if (!status.markets && (status.phase === "posting" || status.phase === "agents")) {
    try {
      const prop = await proposalFromKeepers(call);
      if (prop) { status = { ...status, markets: prop }; proposed = true; }
    } catch { /* keepers unreadable: show no market */ }
  }
  if (status.markets && now >= status.close_at_ms) {
    try { snap = await call("stake_snapshot"); } catch { /* reopened or still open */ }
  }
  if (status.markets) {
    try {
      totals = await Promise.all(status.markets.map((m) =>
        call("stake_totals", { colony: m.colony, n_options: m.outcomes.length })));
    } catch { /* leave stakes unknown */ }
  }
  const round = buildRound(status, last, { totals, snap });
  round.proposed = proposed;
  return round;
}

// ---- verifying in the browser ----

const finish = (col) => { while (col.t < col.ticks) col.step(); return col.result(); };

// Re-run the cranked colonies of one market from the chain's inputs and
// compare. Returns { colonies: [{spec, state, actual, expected, result}], market:
// null | {state, ...}, ok } where state is "match" | "mismatch" | "pending" (not
// cranked yet). ok means every cranked colony matches and, if the market is
// finished, so do its market hash and swarm belief.
export async function verifyMarket(m, { yieldTo } = {}) {
  const out = { colonies: [], market: null, ok: true, results: new Array(KINDS.length).fill(null) };
  if (!m.forecasters) return { ...out, ok: false };
  for (const [k, spec] of m.forecasters.entries()) {
    if (!spec.chainHash) { out.colonies.push({ spec, state: "pending", expected: null, actual: null }); continue; }
    if (yieldTo) await yieldTo();
    const result = finish(spec.make());
    out.results[k] = result;
    const state = result.hash === spec.chainHash ? "match" : "mismatch";
    out.colonies.push({ spec, state, expected: spec.chainHash, actual: result.hash, result });
    if (state !== "match") out.ok = false;
  }
  if (out.results.every(Boolean)) {
    const counted = m.forecasters.map((f) => f.counted);
    const res = marketResult(m.colony, out.results, counted, m.colonyWeights ?? EQUAL_WEIGHTS);
    const hashOk = !!m.marketHash && res.hash === m.marketHash;
    const swarmOk = !!m.swarm && res.swarm.length === m.swarm.length && res.swarm.every((x, i) => x === m.swarm[i]);
    out.market = { state: hashOk && swarmOk ? "match" : m.marketHash ? "mismatch" : "pending", expected: m.marketHash, actual: res.hash, swarm: res.swarm, hashOk, swarmOk, result: res };
    if (m.marketHash && !(hashOk && swarmOk)) out.ok = false;
  }
  return out;
}

// Verify every market of a round: rows for a receipt-style table.
export async function verifyRound(round, { onColony, yieldTo } = {}) {
  const rows = [], markets = [];
  let total = round.all.length, i = 0, ok = true;
  for (const m of round.markets) {
    const v = await verifyMarket(m, {
      yieldTo: async () => { onColony?.(i++, total); if (yieldTo) await yieldTo(); },
    });
    markets.push(v);
    for (const c of v.colonies) {
      rows.push({ kind: "colony", key: c.spec.key, name: `${m.title} · ${KIND_NAMES[c.spec.kind]}`, expected: c.expected, actual: c.actual, state: c.state });
    }
    if (v.market) rows.push({ kind: "market", key: `${m.key}-market`, name: `${m.title} · market hash`, expected: v.market.expected, actual: v.market.actual, state: v.market.state });
    if (!v.ok) ok = false;
  }
  return { ok, rows, markets };
}

