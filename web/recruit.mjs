// Recruit the swarm, in the browser: anyone pays a $ANTO fee for a forecast
// on a market of their choice, and agents are paid from the fee for work,
// never for being right. Keepers post the market's odds, forecaster agents
// post their own odds (the Agents colony reads their lower median), and
// crankers run the five colonies, one per call. All of that happens on the
// contract; this file is the pure part the pages share: it reads the
// contract's `RequestView` JSON (views `forecast_request`, `forecast_requests`)
// and works out what to show, what is due next, what each party was paid, and
// whether a browser re-run of the five colonies matches the chain's hashes.
// No DOM and no wallet, so Node can test it (web/test_recruit.mjs).
//
// Amounts are yocto (BigInt) here, as on chain; the views carry them as
// decimal strings. The fee size and split come from the `request_config` view.

import { toHex, marketResult, voters, oddsSnapshotHash, KINDS } from "../sim/js/antosim.mjs";
import { marketForecasters, KIND_NAMES } from "./round.mjs";
import { agentSnapshot } from "./agents.mjs";
import { chain, hexToBytes, ZERO_HASH } from "./chain.mjs";
import { walletsFor } from "./roundchain.mjs";

export const ONE = 10n ** 24n;                 // yocto per token
export const CRANK_CALLS = KINDS.length;       // one colony per call
export const REQUEST_COLONY_BASE = 0x8000;     // token/src/request.rs: request id -> colony
const BPS = 10_000n;

export const requestColony = (id) => REQUEST_COLONY_BASE + id;

// Whole tokens for display, with up to `dp` decimals. Takes yocto as a
// BigInt or the decimal string the views return.
export function tokens(yocto, dp = 2) {
  yocto = BigInt(yocto);
  const neg = yocto < 0n, y = neg ? -yocto : yocto;
  const whole = y / ONE, frac = (y % ONE) * 10n ** BigInt(dp) / ONE;
  const f = dp ? `.${frac.toString().padStart(dp, "0")}`.replace(/\.?0+$/, "") : "";
  return `${neg ? "-" : ""}${whole.toLocaleString("en")}${f}`;
}

// ---- config and the fee split ----

// `request_config` view -> BigInt amounts and bps numbers.
export function parseConfig(v) {
  return {
    fee: BigInt(v.fee), keeperBps: BigInt(v.keeper_bps), agentBps: BigInt(v.agent_bps), crankBps: BigInt(v.crank_bps),
    oddsWindowMs: v.odds_window_ms, forecastWindowMs: v.forecast_window_ms,
    agentDeposit: BigInt(v.agent_deposit), crankBounty: BigInt(v.crank_bounty),
  };
}

// The fee split as fixed pools: keepers, agents and crank. Burn is the rest.
export function feePools(cfg) {
  const keepers = (cfg.fee * cfg.keeperBps) / BPS, agents = (cfg.fee * cfg.agentBps) / BPS, crank = (cfg.fee * cfg.crankBps) / BPS;
  return { keepers, agents, crank, burn: cfg.fee - keepers - agents - crank };
}

// ---- reading a request ----

const ms = (x) => (x == null ? null : Number(x));
const big = (x) => BigInt(x ?? 0);

// Colonies cranked so far; the next crank runs KIND_NAMES[cranked(r)].
export const cranked = (r) => r.colony_hashes.length;
export const isOver = (r) => r.phase === "done" || r.phase === "skipped";

// The request colony's frozen stakes: { weights, hash, wallets } (wallets as
// staker-ant rows). Before the first crank freezes them, and on a contract
// older than request stakes, zero weights and a zero hash.
export function stakesOf(r) {
  const n = r.market?.outcomes.length ?? 0, st = r.stakes;
  if (!st) return { weights: new Array(n).fill(0), hash: ZERO_HASH, wallets: [] };
  return { weights: st.weights, hash: st.hash, wallets: walletsFor(st.entries, r.colony, n) };
}

// The five colonies' inputs as `marketForecasters` takes them, from what the
// contract stored. Null until the first crank freezes the agents' snapshot
// and the stakes (holders stake on the request during the agents' window)
// and draws the seed.
export function specOf(r) {
  const m = r.market, ag = r.agents;
  if (!m || !ag || !r.seed) return null;
  const st = stakesOf(r);
  return {
    title: r.market_id, outcomes: m.outcomes, odds: m.odds, odds6h: m.odds_6h,
    weights: st.weights, stakeHash: hexToBytes(st.hash), wallets: st.wallets,
    agentOdds: { odds: ag.odds, hash: hexToBytes(ag.hash), posts: ag.posts },
  };
}

// The five forecaster colony specs ({ name, make(), counted, ... }), or null.
export function forecastersOf(r) {
  const spec = specOf(r);
  return spec && marketForecasters(hexToBytes(r.seed), r.colony, spec, `r${r.id}`);
}

// Which colonies vote in the swarm belief: Follower, Contrarian and Momentum
// always; Community only with stakes; Agents with a post.
export const countedOf = (r) => voters(stakesOf(r).weights, r.agents?.odds ?? []);

// Run colony k to its final tick: its result (with `hash`).
export function runColony(spec) {
  const c = spec.make();
  while (c.step());
  return c.result();
}

// Re-run the colonies the chain has cranked (all five once done) from its
// stored inputs and compare. { ok, colonies: [{ kind, name, chain, replay,
// match }], market: { chain, replay, match } | null, swarm: match | null,
// oddsHash, agentsHash } or { ok: false, reason }. `ok` needs every cranked
// colony to match, plus the market hash and swarm belief once done.
export function verifyRequest(r) {
  if (!r) return { ok: false, reason: "no such request" };
  const fs = forecastersOf(r);
  if (!fs) return { ok: false, reason: `nothing to re-run yet (phase ${r.phase})` };
  const runs = fs.slice(0, cranked(r)).map(runColony);
  const colonies = runs.map((x, k) => ({ kind: k, name: KIND_NAMES[k], chain: r.colony_hashes[k], replay: x.hash, match: x.hash === r.colony_hashes[k] }));
  const m = r.market, n = m.outcomes.length;
  // The snapshots the colonies commit: recompute them from the raw posts.
  const oddsHash = toHex(oddsSnapshotHash(m.odds, m.odds_6h)) === m.odds_hash;
  const posts = r.agents.posts.map(([id, odds]) => ({ id, odds }));
  const agentsHash = (posts.length ? toHex(agentSnapshot(posts, n).hash) : ZERO_HASH) === r.agents.hash;
  let market = null, swarm = null;
  if (r.phase === "done" && runs.length === CRANK_CALLS) {
    const res = marketResult(r.colony, runs, countedOf(r));
    market = { chain: r.market_hash, replay: res.hash, match: res.hash === r.market_hash };
    swarm = res.swarm.length === r.swarm.length && res.swarm.every((x, i) => x === r.swarm[i]);
  }
  const ok = colonies.every((c) => c.match) && oddsHash && agentsHash && (r.phase !== "done" || (!!market?.match && swarm));
  return { ok, colonies, market, swarm, oddsHash, agentsHash };
}

// Who was paid what, as rows { role, account, amount } (BigInt), one per
// payment; the burn row has no account. Once the request is done the rows sum
// to the fee exactly; a skipped request refunds the fee to the requester.
export function payoutRows(r) {
  if (r.phase === "skipped") return [{ role: "refund", account: r.requester, amount: big(r.fee) }];
  if (r.phase !== "done") return [];
  const rows = [];
  for (const [account, amount] of r.paid_keepers) rows.push({ role: "keeper", account, amount: big(amount) });
  for (const [account, amount] of r.paid_agents) rows.push({ role: "agent", account, amount: big(amount) });
  r.paid_cranks.forEach(([account, amount], k) => rows.push({ role: "cranker", account, amount: big(amount), call: k + 1 }));
  rows.push({ role: "burn", account: null, amount: big(r.burned) });
  return rows;
}

// ---- what is due ----

// The permissionless call request r is waiting for at `nowMs`, or null:
// "finalize_request_odds" once the keepers' window is over (or all of
// `keepers`, if given, have posted), "crank_request" once the agents' window
// is over and until the fifth colony has run. Posting odds is not permissionless
// (keepers) and posting forecasts is for registered agents, so neither is due.
export function due(r, nowMs, keepers = null) {
  if (r.phase === "odds") {
    const all = keepers && keepers.length > 0 && keepers.every((k) => r.keepers_posted.includes(k));
    return nowMs >= r.odds_by_ms || all ? "finalize_request_odds" : null;
  }
  if (r.phase === "forecasting") return nowMs >= r.forecast_by_ms ? "crank_request" : null;
  if (r.phase === "running") return "crank_request";
  return null;
}

// Whether registered agents may post their odds now. Holders may stake on the
// request's colony in the same window.
export const agentsMayPost = (r, nowMs) => r.phase === "forecasting" && nowMs < r.forecast_by_ms;
export const stakingOpen = agentsMayPost;

// Whether stakes on the request's colony can be withdrawn: not from the end
// of the agents' window until the fifth colony has run.
export const stakesLocked = (r, nowMs) => r.phase === "running" || (r.phase === "forecasting" && nowMs >= r.forecast_by_ms);

// The lifecycle as steps with a state: "done", "now" or "" (to come).
// { key, title, text, state }.
export function timeline(r, cfg, nowMs = Date.now()) {
  const phase = r.phase;
  const at = { odds: 1, forecasting: 3, running: 4 + cranked(r), done: 4 + CRANK_CALLS + 1, skipped: 2 }[phase];
  const steps = [
    { key: "request", title: "Request", text: `Fee of ${tokens(r.fee)} tANTO held by the contract` },
    { key: "odds", title: "Keepers post odds", text: `${r.keepers_posted.length} keeper${r.keepers_posted.length === 1 ? "" : "s"} posted so far; the window is ${Math.round(cfg.oddsWindowMs / 60_000)} minutes` },
  ];
  if (phase === "skipped") {
    steps.push({ key: "skip", title: "No quorum", text: "Not enough keepers agreed on the market, so the request was skipped and the fee refunded" });
    return steps.map((s, i) => ({ ...s, state: i < 2 ? "done" : "now" }));
  }
  steps.push({ key: "final", title: "Odds final", text: "The keepers' median odds are on chain" });
  steps.push({ key: "agents", title: "Agents post, holders stake", text: `For ${Math.round(cfg.forecastWindowMs / 1000)} seconds, registered forecaster agents post their own odds and holders stake $ANTO on outcomes for Community` });
  KIND_NAMES.forEach((name, k) => steps.push({ key: `crank-${k}`, title: `Crank ${k + 1}: ${name}`,
    text: `${k === 0 ? "Draws the seed, then runs" : "Runs"} the ${name} colony${r.crankers[k] ? ` · ${r.crankers[k]}` : ""}` }));
  steps.push({ key: "done", title: "Result", text: "Swarm belief and market hash stored, fee paid out" });
  // The step index `at` is the one in progress (or "now"); everything before it is done.
  const cur = phase === "forecasting" && nowMs >= r.forecast_by_ms ? 4 : at;
  return steps.map((s, i) => ({ ...s, state: i < cur || phase === "done" ? "done" : i === cur ? "now" : "" }));
}

// Short labels for the progress strip.
export const SHORT = { request: "Fee held", odds: "Keepers post", final: "Odds final", agents: "Agents post", skip: "Refunded", done: "Result" };

// ---- agents' own odds ----

// The odds an agent's form starts from: the keepers' median, made whole.
export function marketOdds(odds) {
  const o = [...odds];
  const top = o.indexOf(Math.max(...o));
  o[top] += 10_000 - o.reduce((a, b) => a + b, 0);
  return o;
}

// Percent strings from the form -> { odds: basis points } or { why }; an
// empty form is { odds: null }.
export function readOdds(vals) {
  vals = vals.map((v) => String(v).trim());
  if (vals.every((v) => v === "")) return { odds: null };
  if (vals.some((v) => v === "")) return { why: "fill in every outcome" };
  const odds = vals.map((v) => Math.round(Number(v) * 100));
  if (odds.some((o) => !Number.isFinite(o) || o < 0 || o > 10_000)) return { why: "each outcome is 0 to 100%" };
  const sum = odds.reduce((a, b) => a + b, 0);
  if (sum !== 10_000) return { why: `adds up to ${(sum / 100).toFixed(1)}%, not 100%` };
  return { odds };
}

// ---- reading the chain ----

// The newest `n` requests, oldest first. `c` is the chain reader (chain.mjs).
export async function recentRequests(n = 12, c = chain) {
  const count = await c.requestCount();
  const from = Math.max(0, count - n);
  return count ? c.requests(from, Math.min(50, count - from)) : [];
}

// The newest request for this market made by `requester`, from id `from` on:
// how the page finds the id a `request_forecast` call returned.
export async function findRequest(market, requester, from = 0, c = chain) {
  const list = await c.requests(from, 50);
  return [...list].reverse().find((r) => r.market_id === market && (!requester || r.requester === requester)) ?? null;
}

// A transaction outcome from the wallet -> the failure message, or null. A
// contract panic or a failed receipt comes back as an outcome, not a throw.
export function failureOf(outcome) {
  const fail = (s) => (s && typeof s === "object" && s.Failure) || null;
  const text = (f) => {
    const e = f.ActionError?.kind?.FunctionCallError?.ExecutionError ?? f.ActionError?.kind ?? f;
    return typeof e === "string" ? e : JSON.stringify(e);
  };
  const top = outcome?.status && fail(outcome.status);
  if (top) return text(top);
  for (const ro of outcome?.receipts_outcome ?? []) {
    const f = fail(ro.outcome?.status);
    if (f) return text(f);
  }
  return null;
}

// ---- commands ----

// Shell quoting the way the tool prints commands (Python's shlex.join).
const quote = (x) => (/^[\w@%+=:,./-]+$/.test(x) ? x : `'${x.replace(/'/g, `'"'"'`)}'`);
const nearCall = (contract, account, method, args, gas = "30.0 Tgas", network = "testnet") =>
  ["near", "contract", "call-function", "as-transaction", contract, method,
    "json-args", JSON.stringify(args), "prepaid-gas", gas, "attached-deposit", "0 NEAR",
    "sign-as", account, "network-config", network, "sign-with-keychain", "send"].map(quote).join(" ");

// The agent tool's command lines and the NEAR CLI calls they sign. `mine`
// ({ outcomes, odds }) is the asker's own forecast: ask then waits and posts
// it by label once agents may post.
export function commands(contract, account, marketId, id = 0, odds = null, mine = null) {
  const tool = (sub, rest = "") => `python3 -I bots/recruit.py ${sub} --contract ${quote(contract)}${rest}`;
  const acct = ` --account ${quote(account)}`;
  const oddsArg = (odds ?? []).join(",");
  const mineArg = mine ? ` --wait --odds ${quote(mine.outcomes.map((o, i) => `${o}=${mine.odds[i]}`).join(","))}` : "";
  return {
    ask: tool("ask", `${acct} --market ${quote(marketId)}`),
    askSend: tool("ask", `${acct} --market ${quote(marketId)}${mineArg} --send`),
    register: tool("register", `${acct} --send`),
    post: tool("post", `${acct} --request ${id} --odds ${oddsArg} --send`),
    crank: tool("crank", `${acct} --request ${id} --send`),
    verify: tool("verify", ` --request ${id}`),
    mcp: tool("mcp", acct),
    keeper: `python3 -I keeper/trending.py --request ${id} --market ${quote(marketId)}`,
    signs: {
      request: nearCall(contract, account, "request_forecast", { market_id: marketId }),
      post: nearCall(contract, account, "post_forecast", { colony: requestColony(id), odds: odds ?? [] }),
      crank: nearCall(contract, account, "crank_request", { request_id: id }, "100.0 Tgas"),
      stake: nearCall(contract, account, "stake", { colony: requestColony(id), option: 0, amount: String(ONE) }),
    },
  };
}

export { toHex };
