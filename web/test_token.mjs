// Offline tests for the $ANTO panels' data: node web/test_token.mjs
import assert from "node:assert/strict";
import { ONE, CONTRACT } from "./chain.mjs";
import { fmtAnto, burnedPct, loadToken, chipText, tokenFacts, nextStep, GENESIS_SUPPLY, treasuryOf } from "./token.mjs";

const T = (n) => BigInt(Math.round(n * 100)) * (ONE / 100n); // tokens -> base units

// Formatting: two decimals at most, rounded down; compact for big totals.
assert.equal(fmtAnto(T(2499.75)), "2,499.75");
assert.equal(fmtAnto(T(150)), "150");
assert.equal(fmtAnto(ONE / 1000n), "0"); // below a cent
assert.equal(fmtAnto(T(997500.25), { compact: true }), "997.5K");
assert.equal(fmtAnto(T(1_000_000), { compact: true }), "1M");
assert.equal(fmtAnto(T(1_234_567), { compact: true }), "1.23M");
assert.equal(fmtAnto(T(9999.99), { compact: true }), "9,999.99"); // too small to shorten
assert.equal(fmtAnto("150000000000000000000000000"), "150"); // a U128 string from the contract

assert.equal(burnedPct(T(2499.75), T(1_000_000)), "0.25%");
assert.equal(burnedPct(T(12_500), T(1_000_000)), "1.25%");
assert.equal(burnedPct(0n, T(1_000_000)), "0%");

// The contract as the testnet answers it on 2026-10-28.
const CHAIN = {
  ft_total_supply: T(997500.25).toString(),
  faucet_amount: T(150).toString(),
  [`ft_balance_of:${treasuryOf(CONTRACT)}`]: T(997400.25).toString(),
  "ft_balance_of:me.testnet": T(142.5).toString(),
  "staked_by:me.testnet": T(7.5).toString(),
  "has_claimed:me.testnet": true,
  "has_claimed:new.testnet": false,
  "ft_balance_of:new.testnet": "0",
  "staked_by:new.testnet": "0",
};
const read = async (m, a = {}) => {
  const k = a.account_id ? `${m}:${a.account_id}` : m;
  if (!(k in CHAIN)) throw new Error(`no ${k}`);
  return CHAIN[k];
};

// No wallet: the token's facts, and the chip shows the burn.
const t = await loadToken({ read, contract: CONTRACT });
assert.equal(GENESIS_SUPPLY[CONTRACT], T(1_000_000));
assert.equal(t.burned, T(2499.75));
assert.equal(t.me, null);
assert.deepEqual(chipText(t), { value: "2,499.75", label: "burned" });
assert.equal(nextStep(t), "connect");
const facts = tokenFacts(t);
assert.deepEqual(facts.map((f) => f[0]), ["Burned since launch", "Supply", "Treasury"]);
assert.equal(facts[0][2], "0.25% of the 1M minted");
assert.equal(facts[2][1], "997.4K");
// 0.10% and 2.00% of the treasury, 0.08% and 0.16% of it to stakers.
assert.equal(facts[2][2], "a day's pot takes 997.4 to 19.9K, of which 797.92 to 1,595.84 goes to stakers and the rest burns");

// A connected wallet that has claimed: its balance in the chip, nothing to do.
const me = await loadToken({ read, contract: CONTRACT, account: "me.testnet" });
assert.deepEqual(me.me, { account: "me.testnet", balance: T(142.5), staked: T(7.5), claimed: true });
assert.deepEqual(chipText(me), { value: "142.5", label: "yours" });
assert.equal(nextStep(me), null);

// A new wallet can claim the faucet.
const fresh = await loadToken({ read, contract: CONTRACT, account: "new.testnet" });
assert.equal(nextStep(fresh), "claim");
assert.deepEqual(chipText(fresh), { value: "0", label: "yours" });

// Another contract has no known starting supply, so no burned figure; failed
// reads leave fields null instead of throwing.
const other = await loadToken({ read: async (m) => (m === "ft_total_supply" ? T(500).toString() : Promise.reject(new Error("down"))), contract: "other.testnet" });
assert.equal(other.burned, null);
assert.equal(other.treasury, null);
assert.deepEqual(chipText(other), { value: "500", label: "supply" });
assert.deepEqual(tokenFacts(other).map((f) => f[0]), ["Supply"]);
assert.equal(chipText({ me: null, burned: null, supply: null }), null);

console.log("token: ok");
