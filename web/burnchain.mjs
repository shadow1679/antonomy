// The Burn page's chain layer: reads the contract's Burn colony (run, schedule,
// frozen stakes, treasury), re-runs a finished day in the browser to check the
// chain's result hash, writes (stake, unstake, crank_burn, execute_burn) through
// the wallet, and builds the burn history. Network access goes through
// `read(method, args)` (default: chain.mjs view), so Node tests can feed canned
// contract JSON.
//
// History: the contract keeps only the newest run and forgets a day's snapshot
// once it is burned, so there is no on-chain list of past burns. The list of
// execute_burn transactions comes from an indexer (nearblocks testnet API,
// history only, labelled as such on the page); each row's details are then read
// from the contract itself at the block just before that transaction ran, on an
// archival RPC (burn_run, burn_snapshot, the treasury balance and the supply,
// and the same two just after it, which give what it burned and paid). A row
// therefore carries the day's real seed and stake snapshot, and the page re-runs it.

import { view, wallet, contractId, ensureTokens, RPCS, yocto } from "./chain.mjs";
import {
  BURN_COLONY, N_OPTIONS, hexToBytes, snapshotWeights, snapshotHash, snapshotWallets,
  weightsFromSqrtYocto, shownTick, dayOf, dayRunAt,
} from "./burn.mjs";
import { burnColony, rememberBurnDay, knownBurnDay } from "./round.mjs";

export const ARCHIVAL_RPCS = ["https://archival-rpc.testnet.near.org", ...RPCS];
export const INDEXER = "https://api-testnet.nearblocks.io/v1";
export const treasuryId = () => `treasury.${contractId()}`;

const bigs = (a) => a.map((x) => BigInt(x));
const withTimeout = (p, ms) => Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error("timeout")), ms))]);

// Offset (ms) to add to the browser clock to get chain time, from the newest
// block's timestamp. 0 if the RPC can't be reached. The burn clock is the
// block timestamp, so a wrong computer clock must not move the phase.
export async function chainSkew({ rpcs = RPCS, fetchFn = globalThis.fetch, now = Date.now } = {}) {
  for (const rpc of rpcs) {
    try {
      const t0 = now();
      const r = await withTimeout(fetchFn(rpc, {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: "anto", method: "block", params: { finality: "optimistic" } }),
      }), 6000);
      const out = await r.json();
      const ns = out?.result?.header?.timestamp;
      if (ns) return Number(BigInt(ns) / 1_000_000n) - (t0 + now()) / 2;
    } catch { /* try the next RPC */ }
  }
  return 0;
}

// ---- reading the Burn colony ----

// Everything the Burn page shows, in one call. `read` is view(); `account` the
// connected wallet or null. A reader that fails leaves its field null and adds
// to `errors`; only the schedule is required.
export async function loadBurn({ account = wallet.accountId, read = view, skew = 0 } = {}) {
  const errors = [];
  const soft = async (name, p, dflt = null) => { try { return await p; } catch (e) { errors.push(`${name}: ${e.message ?? e}`); return dflt; } };
  const schedule = await read("burn_schedule");
  const [run, last, totals, sw, cfg, treasury, supply, pot, board] = await Promise.all([
    soft("burn_run", read("burn_run")),
    soft("last_burn_day", read("last_burn_day")),
    soft("stake_totals", read("stake_totals", { colony: BURN_COLONY, n_options: N_OPTIONS })),
    soft("stake_weights", read("stake_weights", { colony: BURN_COLONY, n_options: N_OPTIONS })),
    soft("stake_config", read("stake_config")),
    soft("treasury", read("ft_balance_of", { account_id: treasuryId() })),
    soft("ft_total_supply", read("ft_total_supply")),
    soft("daily_pot", read("daily_pot")),
    soft("reward_leaderboard", read("reward_leaderboard")),
  ]);
  const executed = (d) => last !== null && d <= last; // the contract forgets executed days' snapshots
  const today = schedule.day;
  const running = schedule.phase === "running";

  // Frozen stakes for the days the page may need: today from 12:00, and the
  // newest run if it isn't burned yet (its result still needs checking).
  const wanted = new Set();
  if (running) wanted.add(today);
  if (run && !executed(run.day)) wanted.add(run.day);
  const snaps = {};
  await Promise.all([...wanted].map(async (day) => {
    const s = await soft(`burn_snapshot(${day})`, read("burn_snapshot", { day }));
    if (s) snaps[day] = { day, hash: s.hash, entries: s.entries, ok: snapshotHash(s.entries) === s.hash };
  }));
  // Keep the run's inputs in this browser: the contract forgets them after the burn.
  if (run && snaps[run.day]?.ok && snaps[run.day].hash === run.stake_hash) {
    rememberBurnDay({
      day: run.day, seed: run.seed, stakeHash: run.stake_hash, entries: snaps[run.day].entries,
      winner: run.winner_option ?? undefined, hash: run.result_hash ?? undefined,
    });
  }

  let me = null;
  if (account) {
    const [balance, claimed, staked, mine, earned, lock] = await Promise.all([
      soft("ft_balance_of", read("ft_balance_of", { account_id: account })),
      soft("has_claimed", read("has_claimed", { account_id: account }), false),
      soft("staked_by", read("staked_by", { account_id: account })),
      soft("stakes_of", read("stakes_of", { account_id: account }), []),
      soft("rewards_earned", read("rewards_earned", { account_id: account })),
      soft("burn_lock", read("burn_lock", { account_id: account })),
    ]);
    const stakes = new Array(N_OPTIONS).fill(0n);
    for (const [c, o, v] of mine) if (c === BURN_COLONY && o < N_OPTIONS) stakes[o] += BigInt(v);
    me = {
      account, claimed, stakes,
      balance: balance === null ? null : BigInt(balance),
      staked: staked === null ? null : BigInt(staked),
      earned: earned === null ? null : BigInt(earned),
      // { day, locked }: Burn stakes stay locked until `day`'s pot has paid.
      lock: lock ?? null,
    };
  }
  return {
    at: Date.now(), skew, schedule, run, lastBurnDay: last, today, running,
    totals: totals ? bigs(totals) : null,
    weights: sw ? weightsFromSqrtYocto(sw) : null,
    cap: cfg ? BigInt(cfg.cap_per_wallet) : null,
    treasury: treasury === null ? null : BigInt(treasury),
    supply: supply === null ? null : BigInt(supply),
    // The daily pot menu at today's treasury: [{ pot_bps, reward_bps, burn_bps, burn, reward }].
    pot: pot ? pot.map((p) => ({ ...p, burn: BigInt(p.burn), reward: BigInt(p.reward) })) : null,
    // Lifetime rewards, highest first: [[account, yocto bigint]].
    board: board ? board.map(([a, e]) => [a, BigInt(e)]) : null,
    snaps, me, errors,
  };
}

// What the page should show for a loaded state at chain time `now`:
//  - "staking":  before 12:00, nothing drawn for today;
//  - "waiting":  after 12:00, the first crank hasn't happened (no seed yet);
//  - "running":  today's colony is on chain;
// plus `prev`, the unexecuted run of an earlier day ("done" with a result,
// "unfinished" if the final tick hasn't been cranked in yet).
export function burnView(st, now = Date.now() + (st.skew ?? 0)) {
  const day = dayOf(now), running = now >= dayRunAt(day);
  const run = st.run;
  const todayRun = run && run.day === day ? run : null;
  const executed = (d) => st.lastBurnDay !== null && d <= st.lastBurnDay;
  const prevRun = run && run.day < day && !executed(run.day) ? run : null;
  return {
    day, now,
    phase: !running ? "staking" : todayRun ? "running" : "waiting",
    run: todayRun,
    tick: todayRun ? shownTick(todayRun, now) : null,
    prev: prevRun ? { run: prevRun, state: prevRun.done ? "done" : "unfinished", snap: st.snaps[prevRun.day] ?? null } : null,
    snap: st.snaps[day] ?? null,
  };
}

// The Burn colony of an on-chain run: the sim spec with the day's seed and the
// snapshot's weights. Throws if the snapshot isn't the one the run committed to.
export function runSpec(run, snap, { withAnts = true } = {}) {
  if (!snap || snap.hash !== run.stake_hash || snapshotHash(snap.entries) !== run.stake_hash) {
    throw new Error("The stake snapshot does not match the run's stake hash.");
  }
  return burnColony(hexToBytes(run.seed), {
    day: run.day,
    weights: snapshotWeights(snap.entries),
    stakeHash: hexToBytes(run.stake_hash),
    wallets: withAnts ? snapshotWallets(snap.entries) : [],
  });
}

// Re-run a finished day from the seed and compare with what the contract
// stored. `col` may be a colony the page already ran to the last tick.
// `yieldTo` (async) runs between chunks so a page can paint.
export async function verifyRun(run, snap, { col = null, yieldTo = null, onProgress = null, chunk = 2000 } = {}) {
  const mismatches = [];
  if (!run.done) return { ok: false, mismatches: ["The run is not finished."], pending: true };
  const stakesOk = !!snap && snapshotHash(snap.entries) === run.stake_hash && snap.hash === run.stake_hash;
  if (!stakesOk) mismatches.push("stake snapshot does not hash to the run's stake hash");
  let c = col;
  if (!c || c.t !== c.ticks) {
    c = runSpec(run, snap, { withAnts: false }).make();
    while (c.t < c.ticks) {
      for (let i = 0; i < chunk && c.step(); i++);
      onProgress?.(c.t, c.ticks);
      if (yieldTo) await yieldTo();
    }
  }
  const r = c.result();
  if (r.hash !== run.result_hash) mismatches.push("result hash differs");
  if (r.winner_option !== run.winner_option) mismatches.push("winner differs");
  if (JSON.stringify(r.scores) !== JSON.stringify(run.scores)) mismatches.push("scores differ");
  if (JSON.stringify(r.perm) !== JSON.stringify(run.perm)) mismatches.push("source order differs");
  const ok = mismatches.length === 0;
  if (ok) rememberBurnDay({ day: run.day, seed: run.seed, stakeHash: run.stake_hash, entries: snap.entries, verified: true, winner: run.winner_option, hash: run.result_hash });
  return { ok, stakesOk, mismatches, hash: r.hash, winner: r.winner_option, scores: r.scores };
}

// A day the browser doesn't know yet: if the contract still holds it (the
// newest run, or the snapshot of today/the unexecuted day), remember it.
// Resolves to burnDay-ready info or null.
export async function ensureBurnDay(day, { read = view } = {}) {
  if (knownBurnDay(day)) return knownBurnDay(day);
  try {
    const run = await read("burn_run");
    if (!run || run.day !== day) return null;
    const s = await read("burn_snapshot", { day });
    if (snapshotHash(s.entries) !== run.stake_hash) return null;
    return rememberBurnDay({
      day, seed: run.seed, stakeHash: run.stake_hash, entries: s.entries,
      winner: run.winner_option ?? undefined, hash: run.result_hash ?? undefined,
    });
  } catch { return null; }
}

// ---- writing ----

// Stake `tokens` (a number) on `option` of the Burn colony. A wallet that has
// never claimed gets its play tokens first (a second approval).
export async function stakeSugar(option, tokens) {
  if (!wallet.accountId) throw new Error("Connect a wallet first.");
  if (!Number.isInteger(option) || option < 0 || option >= N_OPTIONS) throw new RangeError("bad option");
  const claimed = await ensureTokens(wallet.accountId);
  return { claimed, outcome: await wallet.call("stake", { colony: BURN_COLONY, option, amount: yocto(tokens) }, { gasTgas: 60 }) };
}
export const unstakeSugar = (option, tokens) =>
  wallet.call("unstake", { colony: BURN_COLONY, option, amount: typeof tokens === "bigint" ? tokens.toString() : yocto(tokens) }, { gasTgas: 60 });
// One crank steps at most 1,500 ticks (about 190 TGas of the 300 allowed).
export const crankBurn = () => wallet.call("crank_burn", {}, { gasTgas: 300 });
// Runs the day's pot once the colony has run its last tick: burns its burn part
// and pays its reward part to the stakers on the picked size, so give it room.
export const executeBurn = (day) => wallet.call("execute_burn", { day }, { gasTgas: 200 });

// ---- history ----

async function rpcQuery(params, { rpcs = ARCHIVAL_RPCS, fetchFn = globalThis.fetch } = {}) {
  let last;
  for (const rpc of rpcs) {
    try {
      const r = await withTimeout(fetchFn(rpc, {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: "anto", method: "query", params }),
      }), 15000);
      const out = await r.json();
      if (out.error || !out.result || out.result.error || !out.result.result) throw new Error(JSON.stringify(out.error ?? out.result?.error ?? out));
      return JSON.parse(new TextDecoder().decode(Uint8Array.from(out.result.result)));
    } catch (e) { last = e; }
  }
  throw last;
}
const b64 = (s) => (typeof btoa === "function" ? btoa(s) : Buffer.from(s).toString("base64"));
// A view call as of a past block (archival).
export const viewAt = (height, method, args = {}, opts = {}) => rpcQuery({
  request_type: "call_function", block_id: height, account_id: contractId(), method_name: method, args_base64: b64(JSON.stringify(args)),
}, opts);

// The execute_burn transactions on the contract, newest first, from the
// nearblocks indexer. Only successful calls whose args name a day.
export async function indexerBurns({ fetchFn = globalThis.fetch, limit = 40, contract = contractId() } = {}) {
  const r = await withTimeout(fetchFn(`${INDEXER}/account/${contract}/txns?method=execute_burn&per_page=${limit}`), 12000);
  if (!r.ok) throw new Error(`indexer ${r.status}`);
  const out = await r.json();
  const rows = [];
  for (const t of out.txns ?? []) {
    if (t.outcomes?.status === false || t.receiver_account_id !== contract) continue;
    const a = (t.actions ?? []).find((x) => x.method === "execute_burn");
    let day;
    try { day = Number(JSON.parse(a?.args ?? "{}").day); } catch { continue; }
    if (!Number.isSafeInteger(day)) continue;
    // The receipt's block is where the burn ran; failing that, the transaction's,
    // and the burn ran a block or two later.
    const receipt = t.receipt_block?.block_height != null;
    const height = t.receipt_block?.block_height ?? t.block?.block_height;
    rows.push({ day, tx: t.transaction_hash, signer: t.predecessor_account_id ?? null, height: height ?? null, receipt, ms: Math.floor(Number(BigInt(t.block_timestamp ?? 0) / 1_000_000n)) });
  }
  // One row per day (a later retry is the one that landed), newest first.
  const byDay = new Map();
  for (const x of rows) if (!byDay.has(x.day)) byDay.set(x.day, x);
  return [...byDay.values()].sort((a, b) => b.day - a.day);
}

const HIST_KEY = "antonomy:burn-rows:v2";
const histStore = () => (typeof window === "undefined" ? null : window.localStorage);
function cachedRows() { try { return JSON.parse(histStore()?.getItem(HIST_KEY) ?? "{}"); } catch { return {}; } }
function cacheRow(tx, row) {
  try { histStore()?.setItem(HIST_KEY, JSON.stringify({ ...cachedRows(), [tx]: row })); } catch { /* storage full or blocked */ }
}
const AMOUNTS = ["before", "burned", "reward", "after"];
const jsonRow = (r) => Object.fromEntries(Object.entries(r).map(([k, v]) => [k, AMOUNTS.includes(k) ? String(v) : v]));
const fromJsonRow = (r) => Object.fromEntries(Object.entries(r).map(([k, v]) => [k, AMOUNTS.includes(k) ? BigInt(v) : v]));

// One history row's chain facts, read as of the block before its burn ran:
// the run (seed, stake hash, pick, result hash), the treasury and supply it
// started from and the stake snapshot; then the treasury and supply at the
// burn's block. The supply's fall is what it burned, and the rest of the
// treasury's fall is what it paid the stakers, under whichever rules that day
// ran. Cached after the first read. Resolves to
// { day, tx, ms, index, before, burned, reward, after, seed, stakeHash, hash, scores, perm, entries }
// or, if the archive can't be read, the indexer facts alone (`detail: false`).
export async function burnRow(x, { opts = {}, read = viewAt } = {}) {
  const hit = cachedRows()[x.tx];
  if (hit) return fromJsonRow(hit);
  const base = { day: x.day, tx: x.tx, ms: x.ms, signer: x.signer, detail: false };
  if (!x.height) return base;
  try {
    const h = x.height - 1, hAfter = x.receipt === false ? x.height + 2 : x.height;
    const [run, snap, bal, supply, balAfter, supplyAfter] = await Promise.all([
      read(h, "burn_run", {}, opts),
      read(h, "burn_snapshot", { day: x.day }, opts),
      read(h, "ft_balance_of", { account_id: treasuryId() }, opts),
      read(h, "ft_total_supply", {}, opts),
      read(hAfter, "ft_balance_of", { account_id: treasuryId() }, opts),
      read(hAfter, "ft_total_supply", {}, opts),
    ]);
    if (!run || run.day !== x.day || !run.done) return base;
    const before = BigInt(bal), after = BigInt(balAfter), burned = BigInt(supply) - BigInt(supplyAfter);
    const row = {
      ...base, detail: true, index: run.winner_option, before, burned, reward: before - after - burned, after,
      seed: run.seed, stakeHash: run.stake_hash, hash: run.result_hash, scores: run.scores, perm: run.perm,
      entries: snapshotHash(snap.entries) === run.stake_hash ? snap.entries : null,
    };
    cacheRow(x.tx, jsonRow(row));
    if (row.entries) rememberBurnDay({ day: x.day, seed: run.seed, stakeHash: run.stake_hash, entries: row.entries, winner: run.winner_option, hash: run.result_hash });
    return row;
  } catch (e) {
    return { ...base, error: String(e.message ?? e) };
  }
}

// All of it: the indexer list, then each row's chain facts, newest first.
// `onRow(row, i, n)` fires as rows arrive. Resolves to { rows, indexer: true }
// or { rows: [], indexer: false, error } when the indexer is unreachable.
export async function loadHistory({ onRow, fetchFn, read, opts, limit = 40 } = {}) {
  let list;
  try { list = await indexerBurns({ fetchFn, limit }); } catch (e) { return { rows: [], indexer: false, error: String(e.message ?? e) }; }
  const rows = [];
  for (const [i, x] of list.entries()) {
    const row = await burnRow(x, { read, opts });
    rows.push(row);
    onRow?.(row, i, list.length);
  }
  return { rows, indexer: true };
}
