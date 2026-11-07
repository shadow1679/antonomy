// Check the receipts: re-run a round's colonies in the browser and compare
// every hash with a receipt. A receipt is what the contract recorded for a
// round: the round seed, one result hash per cranked colony and one market
// hash per finished market. issueReceipt() writes one from the contract's own
// data (round_status / last_round); checkReceipt() re-runs the round from the
// on-chain inputs and compares, so a receipt that was edited, or came from
// somewhere else, fails. The contract only keeps the current and the previous
// finished round.
//
//   node web/receipts.mjs issue [round] [--contract <account>]   print the chain's receipt as JSON
//   node web/receipts.mjs check <file> [--contract <account>]    check a receipt file against a re-run
//
// Colony keys in a receipt are "m<market index>-<forecaster>", the same for a
// round whether it is current or the previous one.

import { toHex, marketResult } from "../sim/js/antosim.mjs";
import { loadRound } from "./roundchain.mjs";

export const SPEC = "ANTO-SIM-v1";
const HEX64 = /^[0-9a-f]{64}$/;
const finish = (col) => { while (col.t < col.ticks) col.step(); return col.result(); };

const colonyKey = (m, spec) => `m${m.index}-${spec.name.toLowerCase()}`;
const label = (m, spec) => `${m.title} · ${spec.name}`;

// The normalized round (from loadRound) with this id: the current round once
// its run has started, or the previous finished one. Null if the chain no
// longer holds it.
export function roundFromChain(loaded, id) {
  if (loaded.hasRun && loaded.id === id) return loaded;
  if (loaded.previous && loaded.previous.id === id) return loaded.previous;
  return null;
}

// Read the chain's receipt for round `id` (default: the newest with a result).
export function issueReceipt(loaded, id = loaded.shown.id, contract = "") {
  const round = roundFromChain(loaded, id);
  if (!round || !round.seed) throw new RangeError(`Round ${id} has no result on the contract: only the current round once it runs, and the previous finished round, can be read`);
  const colonies = [];
  const markets = [];
  for (const m of round.markets) {
    for (const f of m.forecasters ?? []) if (f.chainHash) colonies.push({ key: colonyKey(m, f), hash: f.chainHash });
    if (m.marketHash) markets.push({ market: m.index, hash: m.marketHash });
  }
  return { spec: SPEC, contract, round: round.id, seed: round.seed, colonies, markets };
}

// Re-run every cranked colony of a round. Returns each colony's result keyed
// by receipt key and one market result per finished market (null otherwise).
// `onColony(spec, i, total)` fires before each colony runs; `yieldTo`
// (optional, async) lets a page paint.
export async function rerunRound(round, { onColony, yieldTo } = {}) {
  const results = new Map();
  const todo = round.markets.flatMap((m) => (m.forecasters ?? []).filter((f) => f.chainHash).map((f) => [m, f]));
  for (const [i, [m, spec]] of todo.entries()) {
    onColony?.(spec, i, todo.length);
    if (yieldTo) await yieldTo();
    results.set(colonyKey(m, spec), finish(spec.make()));
  }
  const markets = round.markets.map((m) => {
    const rs = (m.forecasters ?? []).map((f) => results.get(colonyKey(m, f)));
    return rs.length && rs.every(Boolean) ? marketResult(m.colony, rs, m.forecasters.map((f) => f.counted)) : null;
  });
  return { results, markets };
}

// Parse and shape-check a receipt. Throws a RangeError with a message fit for the page.
export function parseReceipt(text) {
  let r;
  try { r = typeof text === "string" ? JSON.parse(text) : text; } catch { throw new RangeError("Not valid JSON"); }
  if (!r || typeof r !== "object" || Array.isArray(r)) throw new RangeError("A receipt is a JSON object");
  if (r.spec !== SPEC) throw new RangeError(`Receipt is for ${String(r.spec)}, this page runs ${SPEC}`);
  if (!Number.isSafeInteger(r.round) || r.round < 0) throw new RangeError("Receipt round must be a non-negative integer");
  if (typeof r.seed !== "string" || !HEX64.test(r.seed.toLowerCase())) throw new RangeError("Receipt seed must be 64 hex characters");
  if (!Array.isArray(r.colonies) || !Array.isArray(r.markets ?? [])) throw new RangeError("Receipt needs colonies and markets lists");
  return { ...r, markets: r.markets ?? [], seed: r.seed.toLowerCase() };
}

const hexOf = (v) => (typeof v === "string" ? v.trim().toLowerCase().replace(/^0x/, "") : "");

// Compare a parsed receipt with a browser re-run of `round` (a normalized
// round from roundchain, with its on-chain seed and inputs). Rows are in
// round order (seed, each market's forecasters and market hash); anything the
// receipt lists that the round doesn't have comes last as "extra". state:
// "match" | "mismatch" | "missing" (receipt has no usable hash) | "extra".
// ok is true only when every row matches.
export async function checkReceipt(receipt, round, opts = {}) {
  if (!round?.seed) throw new RangeError(`Round ${receipt.round} has no seed on the contract yet`);
  const { results, markets } = await rerunRound(round, opts);
  const rows = [];
  const row = (kind, key, name, expected, actual) => rows.push({
    kind, key, name, actual,
    expected: HEX64.test(expected) ? expected : null,
    state: !HEX64.test(expected) ? "missing" : expected === actual ? "match" : "mismatch",
  });

  row("seed", "seed", `Round ${round.id} seed`, hexOf(receipt.seed), round.seed);

  const byKey = new Map();
  for (const c of receipt.colonies) if (c && typeof c.key === "string") byKey.set(c.key, hexOf(c.hash));
  for (const m of round.markets) {
    for (const spec of m.forecasters ?? []) {
      const key = colonyKey(m, spec);
      if (!results.has(key)) continue; // not cranked yet: nothing to replay
      row("colony", key, label(m, spec), byKey.get(key) ?? "", results.get(key).hash);
      byKey.delete(key);
    }
  }
  const byMarket = new Map();
  for (const m of receipt.markets) if (m && Number.isInteger(m.market)) byMarket.set(m.market, hexOf(m.hash));
  round.markets.forEach((m, i) => {
    if (!markets[i]) return;
    row("market", `market-${m.index}`, `${m.title} · market hash`, byMarket.get(m.index) ?? "", markets[i].hash);
    byMarket.delete(m.index);
  });
  for (const [key, h] of byKey) rows.push({ kind: "colony", key, name: key, expected: HEX64.test(h) ? h : null, actual: null, state: "extra" });
  for (const [i, h] of byMarket) rows.push({ kind: "market", key: `market-${i}`, name: `Market ${i}`, expected: HEX64.test(h) ? h : null, actual: null, state: "extra" });
  return { round: round.id, ok: rows.every((r) => r.state === "match"), rows };
}

// Command line use.
const argv = globalThis.process?.argv;
if (argv?.[1] && import.meta.url === new URL(`file://${argv[1]}`).href) {
  const args = argv.slice(2);
  const ci = args.indexOf("--contract");
  const contract = ci >= 0 ? args.splice(ci, 2)[1] : undefined;
  const [cmd, a] = args;
  const { view, contractId } = await import("./chain.mjs");
  const call = (m, x) => view(m, x, contract ? { contract } : {});
  const usage = () => { console.error("usage: node web/receipts.mjs issue [round] | check <receipt.json>   [--contract <account>]"); process.exit(2); };
  if (!["issue", "check"].includes(cmd) || (cmd === "check" && !a)) usage();
  const loaded = await loadRound({ call });
  if (cmd === "issue") {
    try {
      console.log(JSON.stringify(issueReceipt(loaded, a === undefined ? undefined : Number(a), contract ?? contractId()), null, 2));
    } catch (e) { console.error(e.message); process.exit(1); }
  } else {
    const { readFileSync } = await import("node:fs");
    let receipt, round;
    try {
      receipt = parseReceipt(readFileSync(a, "utf8"));
      round = roundFromChain(loaded, receipt.round);
      if (!round) throw new RangeError(`the contract no longer holds round ${receipt.round}`);
    } catch (e) { console.error(e.message); process.exit(2); }
    const res = await checkReceipt(receipt, round);
    for (const r of res.rows) console.log(`${r.state.padEnd(8)} ${r.name}`);
    console.log(res.ok ? "all receipts match" : "RECEIPT MISMATCH");
    process.exit(res.ok ? 0 : 1);
  }
}
