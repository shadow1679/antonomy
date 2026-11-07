// Replays one real forecast on testnet, offline: market "what-price-will-
// bitcoin-hit-in-october-2026" in round 4 of antonomy-oracle.testnet. The
// inputs below are what the contract held on chain (keepers' median odds, the
// stake weights, the forecaster agents' median odds and the hashes of the
// snapshots), read from the `last_round` view on 2026-10-29. Replaying them
// through the same simulation must give the chain's swarm belief and market
// hash; the script exits 1 if it doesn't.
//
//   node docs/example_market.mjs

import { forecastMarket } from "../sim/js/antosim.mjs";

const hex = (s) => Uint8Array.from(s.match(/../g), (h) => parseInt(h, 16));

const ROUND_SEED = "046eaa516b1971b2da7080c166690ad1add23dfa6dd34e1e445f1c597269b237";
const STAKE_HASH = "e2ac4dc21e0b3b41e8425a524705b2fc9d5cc722a30f512bff5813142d63bf2e";
const AGENT_HASH = "aebafe80945405dd8db37ee22e1c8474fd203c041da68dc448d9b51dd34ba68d";
const COLONY = 4;                         // the market's colony id in round 4
const OUTCOMES = ["Yes", "No"];
const ODDS = [1850, 8150];                // basis points now (keepers' median)
const ODDS_6H = [850, 9150];              // six hours ago
const STAKE_WEIGHTS = [1732, 0];          // sum of sqrt(tokens) x 1000 per outcome (1732 = sqrt(3) x 1000, e.g. one wallet with 3 $ANTO)
const AGENT_ODDS = [1850, 8150];          // forecaster agents' per-outcome median (one agent posted)
const CHAIN_SWARM = [4377, 5623];
const CHAIN_MARKET_HASH = "cb34d8d2a1d10b2699ffdc5af8e1f5da245810ede0b8281d683fce3c316d9c3e";

const res = forecastMarket(hex(ROUND_SEED), COLONY, ODDS, ODDS_6H, STAKE_WEIGHTS, hex(STAKE_HASH), AGENT_ODDS, hex(AGENT_HASH));

const pct = (bp) => `${(bp / 100).toFixed(1)}%`;
const row = (label, vals, note = "") => console.log(`${label.padEnd(30)}${vals.map((v) => String(v).padStart(8)).join("")}  ${note}`);
console.log(`Round 4, ${OUTCOMES.length} outcomes\n`);
row("", OUTCOMES);
row("Polymarket odds now", ODDS.map(pct));
row("Polymarket odds 6 hours ago", ODDS_6H.map(pct));
row("$ANTO stake weight", STAKE_WEIGHTS);
row("Agents' median odds", AGENT_ODDS.map(pct));
console.log("");
["Momentum", "Community", "Agents"].forEach((k, j) => row(`${k} trail share`, res.colonies[j].shares.map(pct), res.colonies[j].counted ? "" : "(sits out)"));
row("Swarm belief (mean)", res.swarm.map(pct));
console.log(`\nmarket hash ${res.hash}`);

const ok = res.swarm.join() === CHAIN_SWARM.join() && res.hash === CHAIN_MARKET_HASH;
console.log(ok ? "matches the chain: swarm belief and market hash" : "MISMATCH with the chain");
process.exit(ok ? 0 : 1);
