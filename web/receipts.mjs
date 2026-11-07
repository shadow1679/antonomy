// Check the receipts: re-run a whole round and compare every hash with a receipt.
// A receipt is what the contract's events will record for a round: the round
// seed, one result hash per colony and one market hash per market. There is no
// contract yet, so issueReceipt() writes one from this same code; once rounds
// run on testnet, build the receipt from the events instead and keep checkReceipt().
//
//   node web/receipts.mjs issue <round>          print a receipt as JSON
//   node web/receipts.mjs check <round> <file>   check a receipt file against a re-run

import { toHex, marketResult } from "../sim/js/antosim.mjs";
import { roundById } from "./round.mjs";

export const SPEC = "ANTO-SIM-v1";
const HEX64 = /^[0-9a-f]{64}$/;
const finish = (col) => { while (col.t < col.ticks) col.step(); return col.result(); };
const label = (s) => (s.market ? `${s.market} · ${s.name}` : s.name);

// Re-run every colony of a round. Returns each colony's result keyed by
// colony key and one market result per market. `onColony(spec, i, total)`
// fires before each colony runs; `yieldTo` (optional, async) lets a page paint.
export async function rerunRound(round, { onColony, yieldTo } = {}) {
  const results = new Map();
  for (const [i, spec] of round.all.entries()) {
    onColony?.(spec, i, round.all.length);
    if (yieldTo) await yieldTo();
    results.set(spec.key, finish(spec.make()));
  }
  const markets = round.markets.map((m) =>
    marketResult(m.colony, m.forecasters.map((f) => results.get(f.key))));
  return { results, markets };
}

export async function issueReceipt(round, opts) {
  const { results, markets } = await rerunRound(round, opts);
  return {
    spec: SPEC,
    round: round.id,
    seed: toHex(round.seed),
    colonies: round.all.map((s) => ({ key: s.key, hash: results.get(s.key).hash })),
    markets: markets.map((m, i) => ({ market: i, hash: m.hash })),
  };
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

// Compare a parsed receipt with a re-run of its round. Rows are in round
// order (seed, each market's forecasters and market hash); anything the
// receipt lists that the round doesn't have comes last as "extra". state:
// "match" | "mismatch" | "missing" (receipt has no usable hash) | "extra".
// ok is true only when every row matches.
export async function checkReceipt(receipt, opts = {}) {
  const round = roundById(receipt.round);
  const { results, markets } = await rerunRound(round, opts);
  const rows = [];
  const row = (kind, key, name, expected, actual) => rows.push({
    kind, key, name, actual,
    expected: HEX64.test(expected) ? expected : null,
    state: !HEX64.test(expected) ? "missing" : expected === actual ? "match" : "mismatch",
  });

  row("seed", "seed", `Round ${round.id} seed`, hexOf(receipt.seed), toHex(round.seed));

  const byKey = new Map();
  for (const c of receipt.colonies) if (c && typeof c.key === "string") byKey.set(c.key, hexOf(c.hash));
  for (const spec of round.all) {
    row("colony", spec.key, label(spec), byKey.get(spec.key) ?? "", results.get(spec.key).hash);
    byKey.delete(spec.key);
  }
  const byMarket = new Map();
  for (const m of receipt.markets) if (m && Number.isInteger(m.market)) byMarket.set(m.market, hexOf(m.hash));
  round.markets.forEach((m, i) => {
    row("market", `market-${i}`, `${m.title} · market hash`, byMarket.get(i) ?? "", markets[i].hash);
    byMarket.delete(i);
  });
  for (const [key, h] of byKey) rows.push({ kind: "colony", key, name: key, expected: HEX64.test(h) ? h : null, actual: null, state: "extra" });
  for (const [i, h] of byMarket) rows.push({ kind: "market", key: `market-${i}`, name: `Market ${i}`, expected: HEX64.test(h) ? h : null, actual: null, state: "extra" });
  return { round: round.id, ok: rows.every((r) => r.state === "match"), rows };
}

// Command line use.
const argv = globalThis.process?.argv;
if (argv?.[1] && import.meta.url === new URL(`file://${argv[1]}`).href) {
  const [cmd, id, file] = argv.slice(2);
  const round = Number(id);
  if (!Number.isSafeInteger(round) || round < 0 || !["issue", "check"].includes(cmd) || (cmd === "check" && !file)) {
    console.error("usage: node web/receipts.mjs issue <round> | check <round> <receipt.json>");
    process.exit(2);
  }
  if (cmd === "issue") {
    console.log(JSON.stringify(await issueReceipt(roundById(round)), null, 2));
  } else {
    const { readFileSync } = await import("node:fs");
    let receipt;
    try { receipt = parseReceipt(readFileSync(file, "utf8")); } catch (e) { console.error(e.message); process.exit(2); }
    if (receipt.round !== round) { console.error(`receipt is for round ${receipt.round}, not ${round}`); process.exit(2); }
    const res = await checkReceipt(receipt);
    for (const r of res.rows) console.log(`${r.state.padEnd(8)} ${r.name}`);
    console.log(res.ok ? "all receipts match" : "RECEIPT MISMATCH");
    process.exit(res.ok ? 0 : 1);
  }
}
