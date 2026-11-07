// $ANTO at a glance, read from the contract: supply, how much has burned since
// launch, the treasury the daily pot draws on, and the connected wallet's
// balance, stake and faucet claim. The top bar's chip, the landing page's
// token section and the Live page's strip all use it. Pure data, no DOM.

import { view, contractId, CONTRACT, ONE } from "./chain.mjs";
import { potAmounts } from "./burn.mjs";

// The contract keeps no record of its starting supply, so it is pinned here:
// 1,000,000 $ANTO, read with ft_total_supply on archival RPC at the first
// block where the contract answered (274,982,473, the init on 2026-10-27).
// Another contract (?contract=) has no known start, so no burned figure.
export const GENESIS_SUPPLY = { [CONTRACT]: 1_000_000n * ONE };

export const treasuryOf = (contract) => `treasury.${contract}`;

// Base units -> "2,499.75" (two decimals at most, rounded down), or with
// `compact` "997.5K" for the big totals.
export function fmtAnto(base, { compact = false } = {}) {
  const cents = Number((BigInt(base) * 100n) / ONE) / 100;
  if (compact && cents >= 10_000) {
    const [div, unit] = cents >= 1e6 ? [1e6, "M"] : [1e3, "K"];
    const digits = cents >= 1e6 ? 2 : 1;
    const v = Math.floor((cents / div) * 10 ** digits) / 10 ** digits;
    return `${v.toLocaleString("en", { maximumFractionDigits: digits })}${unit}`;
  }
  return cents.toLocaleString("en", { maximumFractionDigits: 2 });
}

// Share of the starting supply burned, as "0.25%".
export function burnedPct(burned, genesis) {
  const pct = Number((BigInt(burned) * 1_000_000n) / BigInt(genesis)) / 10_000;
  return `${pct.toLocaleString("en", { maximumFractionDigits: pct < 1 ? 3 : 2 })}%`;
}

// Everything the token panels show. A read that fails leaves its field null.
// `account` is the connected wallet or null.
export async function loadToken({ read = view, account = null, contract = contractId() } = {}) {
  const soft = (p) => p.then((x) => x, () => null);
  const big = (p) => soft(p).then((x) => (x === null ? null : BigInt(x)));
  const [supply, treasury, faucet, balance, staked, claimed] = await Promise.all([
    big(read("ft_total_supply")),
    big(read("ft_balance_of", { account_id: treasuryOf(contract) })),
    big(read("faucet_amount")),
    account ? big(read("ft_balance_of", { account_id: account })) : null,
    account ? big(read("staked_by", { account_id: account })) : null,
    account ? soft(read("has_claimed", { account_id: account })) : null,
  ]);
  const genesis = GENESIS_SUPPLY[contract] ?? null;
  const burned = genesis !== null && supply !== null ? genesis - supply : null;
  return { supply, treasury, faucet, genesis, burned, me: account ? { account, balance, staked, claimed } : null };
}

// The top bar's chip: your balance once a wallet is connected, else the burn.
export function chipText(t) {
  if (t.me?.balance != null) return { value: fmtAnto(t.me.balance, { compact: true }), label: "yours" };
  if (t.burned != null) return { value: fmtAnto(t.burned, { compact: true }), label: "burned" };
  if (t.supply != null) return { value: fmtAnto(t.supply, { compact: true }), label: "supply" };
  return null;
}

// The token's public facts, for the strip and the landing section:
// [label, value, note].
export function tokenFacts(t) {
  const rows = [];
  if (t.burned != null) rows.push(["Burned since launch", fmtAnto(t.burned), `${burnedPct(t.burned, t.genesis)} of the ${fmtAnto(t.genesis, { compact: true })} minted`]);
  if (t.supply != null) rows.push(["Supply", fmtAnto(t.supply, { compact: true }), "only goes down"]);
  if (t.treasury != null) {
    const [lo, hi] = [potAmounts(t.treasury, 0), potAmounts(t.treasury, 4)];
    const f = (x) => fmtAnto(x, { compact: true });
    rows.push(["Treasury", f(t.treasury), `a day's pot takes ${f(lo.pot)} to ${f(hi.pot)}, of which ${f(lo.reward)} to ${f(hi.reward)} goes to stakers and the rest burns`]);
  }
  return rows;
}

// What the connected wallet can do next: "connect", "claim" or null.
export function nextStep(t) {
  if (!t.me) return "connect";
  if (t.me.claimed === false) return "claim";
  return null;
}
