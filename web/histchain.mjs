// History: every past round and pot, read from the contract's own state at
// past blocks. The contract keeps only the current round and `last_round`,
// and only the newest Burn run, so the History page (replay.html) walks back
// through the chain itself on an archival RPC. No indexer: the nearblocks
// testnet index stopped in September 2026, and the chain's state is what the
// rows must match anyway.
//
// Rounds. `start_round` sets the new round's close time to now + stake_ms, so
// a round's own `close_at_ms` less `round_config().stake_ms` is the time the
// round before it ended. The walk reads `round_status` at a block a few
// seconds before that time: the previous round as it ended, with its markets,
// seed and colony hashes (or no markets: skipped). If its run looks
// unfinished there, `last_round` one round later has the finished copy.
// Round ids restart when the contract is redeployed with `new`, so the walk
// stops at round 0 or where the ids stop counting down.
//
// Pots. `last_burn_day` moves to a day when its pot is paid (execute_burn, or
// the next day's first crank). The walk bisects for that block from the day's
// 24:00 UTC, then reads the run, the stake snapshot and the amounts on either
// side of it (burnRow in burnchain.mjs). Days `last_burn_day` jumped over
// were lost.
//
// Requests stay on the chain (`forecast_requests`); each is filed under the
// round that was open when it was made (`fileRequests`).
//
// Network access goes through `call(method, args)` (now), `read(height,
// method, args)` (archival) and `block(height | "final")`, so Node tests feed
// canned JSON (test_history.mjs). Finished rounds and pots never change and
// are cached in localStorage.

import { view, contractId } from "./chain.mjs";
import { ARCHIVAL_RPCS, treasuryId } from "./burnchain.mjs";
import { dayEndAt, potAmounts, potRules, snapshotHash } from "./burn.mjs";
import { rememberBurnDay } from "./round.mjs";

export const BLOCK_MS = 645;        // testnet block time, a first guess; refined from reads
const BEFORE_END_MS = 30_000;       // read a round about this long before the next one started

// Archival nodes only: a pruned node answers UNKNOWN_BLOCK for an old block,
// which would read as a height with no block. They share one per-IP rate
// limit, so reads go one at a time, spaced, and back off on a 429.
export const HISTORY_RPCS = ARCHIVAL_RPCS.filter((u) => u.includes("archival"));
const GAP_MS = 150, BACKOFF_MS = [1500, 4000, 9000, 20000];
const MISSING = /UNKNOWN_BLOCK|DB Not Found/i;
const GONE = /UNKNOWN_ACCOUNT|does not exist/i;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const withTimeout = (p, ms) => Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error("timeout")), ms))]);
let queue = Promise.resolve();

// One archival JSON-RPC call; resolves to `result`. Throws an Error whose
// `missing` is true when the block doesn't exist (a skipped height).
export function archival(method, params, { rpcs = HISTORY_RPCS, fetchFn = globalThis.fetch } = {}) {
  const run = async () => {
    for (let attempt = 0; ; attempt++) {
      let limited = false, last;
      for (const rpc of rpcs) {
        try {
          const r = await withTimeout(fetchFn(rpc, {
            method: "POST", headers: { "content-type": "application/json" },
            body: JSON.stringify({ jsonrpc: "2.0", id: "anto", method, params }),
          }), 15000);
          if (r.status === 429) { limited = true; continue; }
          const out = await r.json();
          const err = out.error ?? out.result?.error;
          if (err) {
            const text = typeof err === "string" ? err : JSON.stringify(err);
            if (err.code === -429 || /rate limit/i.test(text)) { limited = true; continue; }
            const e = new Error(text);
            if (MISSING.test(text)) e.missing = true;
            if (GONE.test(text)) e.gone = true;
            throw e;
          }
          return out.result;
        } catch (e) {
          if (e.missing || e.gone) throw e;
          last = e;
        }
      }
      if (attempt >= BACKOFF_MS.length) throw last ?? new Error("the archival RPCs are rate-limiting this browser; try again in a minute");
      await sleep(limited ? BACKOFF_MS[attempt] : 400);
    }
  };
  const p = queue.then(run);
  queue = p.catch(() => {}).then(() => sleep(fetchFn === globalThis.fetch ? GAP_MS : 0));
  return p;
}

const b64 = (s) => (typeof btoa === "function" ? btoa(s) : Buffer.from(s).toString("base64"));
// A contract view as of block `height`.
export async function readAt(height, method, args = {}, opts = {}) {
  const res = await archival("query", {
    request_type: "call_function", block_id: height, account_id: contractId(), method_name: method, args_base64: b64(JSON.stringify(args)),
  }, opts);
  return JSON.parse(new TextDecoder().decode(Uint8Array.from(res.result)));
}

// One block header: { height, ms }. A height with no block (they are skipped
// now and then) gives the nearest block below it.
export async function blockAt(height, opts = {}) {
  for (let h = height, k = 0; k < 12; k++, h--) {
    try {
      const hd = (await archival("block", h === "final" ? { finality: "final" } : { block_id: h }, opts)).header;
      return { height: hd.height, ms: Math.floor(Number(BigInt(hd.timestamp) / 1_000_000n)) };
    } catch (e) { if (!e.missing || h === "final") throw e; }
  }
  throw new Error(`no block near ${height}`);
}

// Block heights for times. Each lookup steps from the last block read along
// the block rate it has measured, so in a walk most lookups take one read.
export class Clock {
  constructor(block, rate = BLOCK_MS) { Object.assign(this, { block, rate, anchor: null }); }
  async head() { return (this.anchor = await this.block("final")); }
  // A block within `tol` ms of `ms`.
  async near(ms, tol = 2 * BLOCK_MS) {
    let a = this.anchor ?? await this.head();
    for (let i = 0; i < 6; i++) {
      const b = await this.block(Math.max(1, Math.round(a.height + (ms - a.ms) / this.rate)));
      if (b.height !== a.height && Math.abs(b.ms - a.ms) > 10 * 60_000) this.rate = (b.ms - a.ms) / (b.height - a.height);
      this.anchor = b;
      if (Math.abs(b.ms - ms) <= tol) return b;
      a = b;
    }
    return a;
  }
}

// ---- cache ----

const store = () => (typeof window === "undefined" ? null : window.localStorage);
function cacheMap(name) {
  const key = `antonomy:${name}:v1:${contractId()}`;
  let m;
  try { m = JSON.parse(store()?.getItem(key) ?? "{}"); } catch { m = {}; }
  return {
    get: (k) => m[k] ?? null,
    set(k, v) { m[k] = v; try { store()?.setItem(key, JSON.stringify(m)); } catch { /* storage full or blocked */ } },
  };
}
export const memCache = () => { const m = new Map(); return { get: (k) => m.get(k) ?? null, set: (k, v) => m.set(k, v) }; };
const defaultCache = (name) => (store() ? cacheMap(name) : memCache());

// ---- rounds ----

// A list row for one round from its round_status as it ended (or now, for
// the current round). Facts only; nothing is re-run here. state: the live
// round's phase, else "done", "skipped" (no quorum, no market) or
// "abandoned" (its colonies never all ran).
export function roundRow({ id, status, startMs, endMs = null, height = null, live = false }) {
  const run = status.run, markets = status.markets ?? [];
  const cranked = run ? run.markets.reduce((n, m) => n + m.colony_hashes.length, 0) : 0;
  const state = live ? status.phase : !status.markets ? "skipped" : run?.done ? "done" : "abandoned";
  return {
    id, startMs, endMs, height, live, state, status,
    markets: markets.map((m) => {
      const rm = run?.markets.find((x) => x.colony === m.colony);
      return { colony: m.colony, marketId: m.market_id, outcomes: m.outcomes, odds: m.odds, swarm: rm?.swarm ?? null, cranked: rm?.colony_hashes.length ?? 0 };
    }),
    seed: run?.seed ?? null, cranked, total: markets.length * 3, requests: [],
  };
}

// A market's result as the lists show it, in whole points: the chain's swarm
// belief (set once all three colonies ran), the outcome it leads on (lowest
// index on a tie), the keepers' odds for it and the gap. Null before a result.
// `m` is { outcomes, odds, swarm } (a row market, or requestMarket()).
export function beliefOf(m) {
  if (!m?.swarm || !m.odds) return null;
  const swarm = m.swarm.map((b) => Math.round(b / 100)), market = m.odds.map((b) => Math.round(b / 100));
  const lead = m.swarm.reduce((b, x, o) => (x > m.swarm[b] ? o : b), 0);
  return { swarm, market, lead, gap: swarm[lead] - market[lead] };
}

// A request (ForecastRequestView) in the shape of a row market.
export const requestMarket = (r) => ({
  colony: r.colony, marketId: r.market_id, outcomes: r.market?.outcomes ?? [], odds: r.market?.odds ?? null,
  swarm: r.swarm ?? null, cranked: r.colony_hashes?.length ?? 0,
});

// One page of a list, `size` rows a page, newest first: { page, from, to,
// newer, older, short }. `more` says the walk can read past the last row, so
// one page past the rows read exists (`short`: it isn't full yet, read more).
export function pageOf(n, page, size, more = false) {
  const last = Math.max(0, Math.ceil(n / size) - 1 + (more && n > 0 ? 1 : 0));
  const p = Math.min(Math.max(0, page), last);
  const from = p * size, to = Math.max(from, Math.min(n, from + size));
  return { page: p, from, to, newer: p > 0, older: p < last && to - from === size, short: more && to - from < size };
}

// Walks back from the current round, newest first. `more(n)` reads up to n
// more rows; `rows` holds them all; `done` once round 0 (or the start of this
// deployment) is reached. The current round is the first row (`live`).
export class RoundWalk {
  constructor({ call = view, read = readAt, block = blockAt, cache = defaultCache("rounds") } = {}) {
    Object.assign(this, { call, read, cache, clock: new Clock(block) });
    this.rows = [];
    this.done = false;
    this.cursor = null;
  }

  async start() {
    const [status, cfg, head] = await Promise.all([this.call("round_status"), this.call("round_config"), this.clock.head()]);
    this.cfg = cfg;
    const startMs = status.close_at_ms - cfg.stake_ms;
    const row = roundRow({ id: status.round, status, startMs, live: true });
    this.rows = [row];
    this.cursor = { id: status.round - 1, endMs: startMs, after: head };
    this.done = status.round === 0;
    return row;
  }

  async step() {
    if (this.done) return null;
    const { id, endMs, after } = this.cursor;
    const key = `${id}@${endMs}`;
    let hit = this.cache.get(key);
    if (!hit) {
      const b = await this.clock.near(endMs - BEFORE_END_MS, 20_000);
      let status;
      try { status = await this.read(b.height, "round_status"); } catch (e) {
        if (e.gone || GONE.test(String(e.message))) { this.done = true; return null; }
        throw e;
      }
      // Not the round expected: the contract was redeployed (ids restarted)
      // and this deployment's history ends here.
      if (status.round !== id) { this.done = true; return null; }
      const cfg = this.cfg; // re-timing rounds is rare; a change shows as a round id that doesn't match
      if (status.markets && status.run && !status.run.done) {
        // Finished in its last seconds? The round after it keeps the result.
        const last = await this.read(after.height, "last_round").catch(() => null);
        if (last?.run.round === id) status = { ...status, phase: "done", markets: last.markets, run: last.run };
      }
      hit = { status, startMs: status.close_at_ms - cfg.stake_ms, height: b.height, ms: b.ms };
      this.cache.set(key, hit);
    }
    const row = roundRow({ id, status: hit.status, startMs: hit.startMs, endMs, height: hit.height });
    this.rows.push(row);
    this.cursor = { id: id - 1, endMs: hit.startMs, after: { height: hit.height, ms: hit.ms } };
    if (id === 0) this.done = true;
    return row;
  }

  async more(n = 12, onRow) {
    if (!this.cursor) { const r = await this.start(); onRow?.(r); n--; }
    const out = [];
    while (n-- > 0 && !this.done) {
      const r = await this.step();
      if (r) { out.push(r); onRow?.(r); }
    }
    return out;
  }

  // Walk until `pred(row)` holds for a listed row (or the walk ends).
  async until(pred, onRow) {
    if (!this.cursor) { const r = await this.start(); onRow?.(r); }
    let hit = this.rows.find(pred);
    while (!hit && !this.done) {
      const r = await this.step();
      if (r) { onRow?.(r); if (pred(r)) hit = r; }
    }
    return hit ?? null;
  }
  find(id, onRow) { return this.until((r) => r.id === id, onRow); }
  // The round that was open at time `ms`.
  findAt(ms, onRow) { return this.until((r) => r.startMs <= ms && (r.endMs === null || ms < r.endMs), onRow); }
}

// File requests (RequestViews) under the rows of the rounds open when they
// were made. Mutates and returns the rows; a request older than every row
// listed so far waits until its round is read.
export function fileRequests(rows, requests) {
  for (const r of rows) r.requests = [];
  for (const q of requests) {
    const row = rows.find((r) => r.startMs <= q.created_at_ms && (r.endMs === null || q.created_at_ms < r.endMs));
    if (row) row.requests.push(q);
  }
  for (const r of rows) r.requests.sort((a, b) => b.id - a.id);
  return rows;
}

// Every request on the contract, oldest first (50 a page).
export async function allRequests(call = view) {
  const n = await call("forecast_request_count");
  const out = [];
  for (let from = 0; from < n; from += 50) out.push(...await call("forecast_requests", { from_id: from, limit: 50 }));
  return out;
}

// ---- pots ----

const STAKES_AT_MS = -5 * 60_000;     // a day's stakes and pot menu: 23:55, before its payout
const RUN_AT_MS = 11.5 * 3600_000;    // its finished run: 11:30 the next day, before the next run replaces it
const NEAR_MS = 3 * 60_000;

// Walks back from the newest Burn run, newest first. Rows: { day, state, ... }
// with state "running" or "unpaid" (the contract's current run, not paid
// yet), "paid" (index, seed, stakeHash, hash, scores, perm, entries, and the
// pot's burn and reward at the day's treasury), "skipped" (its run never
// reached its last tick) or "lost" (no run that day). Three reads a day:
// the stake snapshot and the treasury at 23:55, the run at 11:30 the next day.
export class PotWalk {
  constructor({ call = view, read = readAt, block = blockAt, cache = defaultCache("pots") } = {}) {
    Object.assign(this, { call, read, cache, clock: new Clock(block) });
    this.rows = [];
    this.done = false;
    this.cursor = null;
    this.started = false;
  }

  async start() {
    this.started = true;
    const [last, run, head] = await Promise.all([this.call("last_burn_day"), this.call("burn_run"), this.clock.head()]);
    this.headMs = head.ms;
    this.run = run;
    if (run && (last === null || run.day > last)) {
      this.rows.push({ day: run.day, state: run.done ? "unpaid" : "running", live: true, t: run.t, seed: run.seed, stakeHash: run.stake_hash, hash: run.result_hash ?? null, index: run.winner_option ?? null });
    }
    this.cursor = last === null ? null : { day: last };
    this.done = last === null;
    return this.rows.slice();
  }

  async read1(day) {
    const end = dayEndAt(day);
    const b1 = await this.clock.near(end + STAKES_AT_MS, NEAR_MS);
    const [snap, treasury, prev] = await Promise.all([
      this.read(b1.height, "burn_snapshot", { day }).catch(() => null), // panics for a day it doesn't hold
      this.read(b1.height, "ft_balance_of", { account_id: treasuryId() }),
      this.read(b1.height, "last_burn_day"),
    ]);
    let run;
    if (end + RUN_AT_MS >= this.headMs) run = this.run; // not yet replaced: the contract's run now
    else run = await this.read((await this.clock.near(end + RUN_AT_MS, 20 * 60_000)).height, "burn_run");
    const row = { day, prev, height: b1.height };
    if (!run || run.day !== day) return { ...row, state: "lost" };
    Object.assign(row, { seed: run.seed, stakeHash: run.stake_hash, t: run.t });
    if (!run.done) return { ...row, state: "skipped" };
    const t = BigInt(treasury);
    const { burn, reward } = potRules(day) ? potAmounts(t, run.winner_option) : { burn: potAmounts(t, run.winner_option).pot, reward: 0n };
    return {
      ...row, state: "paid", index: run.winner_option, hash: run.result_hash, scores: run.scores, perm: run.perm,
      treasury: String(t), burned: String(burn), reward: String(reward), after: String(t - burn - reward),
      entries: snap && snapshotHash(snap.entries) === run.stake_hash ? snap.entries : null,
    };
  }

  async step() {
    if (this.done) return [];
    const { day } = this.cursor;
    let hit = this.cache.get(String(day));
    if (!hit) {
      try { hit = await this.read1(day); } catch (e) {
        if (!e.gone && !GONE.test(String(e.message))) throw e;
        this.done = true; // before this deployment
        return [];
      }
      this.cache.set(String(day), hit);
    }
    const row = { ...hit };
    for (const k of ["treasury", "burned", "reward", "after"]) if (row[k] !== undefined) row[k] = BigInt(row[k]);
    if (row.entries) rememberBurnDay({ day, seed: row.seed, stakeHash: row.stakeHash, entries: row.entries, winner: row.index, hash: row.hash });
    const out = [row];
    // Days the payout counter jumped over before this one ended never ran.
    for (let d = day - 1; row.prev !== null && d > row.prev; d--) out.push({ day: d, state: "lost" });
    this.rows.push(...out);
    this.cursor = row.prev === null ? null : { day: row.prev };
    this.done = row.prev === null;
    return out;
  }

  async more(n = 7, onRow) {
    const out = [];
    if (!this.started) for (const r of await this.start()) { out.push(r); onRow?.(r); }
    while (out.length < n && !this.done) for (const r of await this.step()) { out.push(r); onRow?.(r); }
    return out;
  }

  async find(day, onRow) {
    if (!this.started) for (const r of await this.start()) onRow?.(r);
    while (!this.rows.some((r) => r.day === day) && !this.done && this.cursor.day >= day) for (const r of await this.step()) onRow?.(r);
    return this.rows.find((r) => r.day === day) ?? null;
  }
}

// Rows grouped by UTC date, in the order given: [{ date: "2026-10-30", rows }].
export function byDay(rows, msOf) {
  const out = [];
  for (const r of rows) {
    const date = new Date(msOf(r)).toISOString().slice(0, 10);
    if (out.at(-1)?.date !== date) out.push({ date, rows: [] });
    out.at(-1).rows.push(r);
  }
  return out;
}
