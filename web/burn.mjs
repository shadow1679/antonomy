// The Burn colony's pure data layer: no DOM, no network, so Node can test it.
// The chain holds the day's seed and the frozen stake snapshot; this module
// turns them into what the sim reads, exactly as the contract does
// (token/src/stake.rs burn_weights, token/src/burnrun.rs), and checks the
// snapshot against the hash the run committed to. Reads and writes of the
// contract are in burnchain.mjs.

import { sha256, BURN_TICKS, burnRichness, stakeRichness } from "../sim/js/antosim.mjs";

export const ONE = 10n ** 24n;                       // yocto per token
// The daily pot (token/src/burn.rs): the colony picks a pot size; its reward
// part goes to the stakers on that size and the rest is burned.
export const POT_MENU_BPS = [10, 25, 50, 100, 200];  // 0.10% to 2.00% of the treasury
export const REWARD_MENU_BPS = [8, 10, 12, 14, 16];  // 0.08% to 0.16%
// The sim's handicap on each size (antosim BURN_HANDICAP), per mille.
export { BURN_HANDICAP } from "../sim/js/antosim.mjs";
// How often the colony picked each size with nobody staking, in percent: measured
// over 300 days of 43,200 ticks (+-3 points). Stakes on a size raise its chance.
export const BURN_BASE_PICK_PCT = [24, 22, 22, 15, 17];
export const DAY_MS = 86_400_000;
export const STAKING_MS = DAY_MS - BURN_TICKS * 1000; // 00:00 to 12:00 UTC
export const BURN_COLONY = 0;
export const N_OPTIONS = 5;
const SIM_WEIGHT_DIV = 10n ** 9n;                  // token/src/stake.rs: 1 token has isqrt 10^12
const SNAPSHOT_TAG = new TextEncoder().encode("ANTO-STAKE-v0");

// The pot of menu entry `index` in base units, as pot_amounts in
// token/src/burn.rs: pot and reward each floor(treasury × bps / 10000), the
// burn part the pot less the reward.
export function potAmounts(treasury, index) {
  const bps = POT_MENU_BPS[index];
  if (bps === undefined) throw new RangeError("bad burn index");
  const t = BigInt(treasury);
  const pot = (t * BigInt(bps)) / 10_000n, reward = (t * BigInt(REWARD_MENU_BPS[index])) / 10_000n;
  return { pot, reward, burn: pot - reward };
}
// The burn part alone.
export const burnAmount = (treasury, index) => potAmounts(treasury, index).burn;

// The first burn day run under the daily-pot rules, whose sim handicaps the
// bigger pots (burnRichness). Earlier days ran with plain stakeRichness and
// burned the whole pot. The colony is built at a day's 12:00 UTC, so this is
// the day of the redeploy if it landed before 12:00, else the day after.
export const HANDICAP_FROM_DAY = 20755;
export const potRules = (day) => day >= HANDICAP_FROM_DAY;
// Per-option richness for burn day `day` from its stake weights.
export const burnRichnessFor = (day, weights) => (potRules(day) ? burnRichness(weights) : stakeRichness(weights));

// Whole tokens with thousands separators (rounded down).
export const fmtTokens = (base) => (BigInt(base) / ONE).toLocaleString("en");
// Tokens to two decimals, for amounts that can be small (a stake of 0.5).
export function fmtTokens2(base) {
  const b = BigInt(base), cents = (b * 100n) / ONE;
  const whole = (cents / 100n).toLocaleString("en"), frac = String(cents % 100n).padStart(2, "0");
  return frac === "00" ? whole : `${whole}.${frac.replace(/0$/, "")}`;
}
// yocto -> tokens as a Number, to 6 decimals. For display and staker ants only.
export const toTokens = (base) => Number((BigInt(base) * 1_000_000n) / ONE) / 1_000_000;

export const hexToBytes = (h) => Uint8Array.from(h.match(/../g).map((x) => parseInt(x, 16)));
export const toHexStr = (b) => [...b].map((x) => x.toString(16).padStart(2, "0")).join("");

// ---- the day clock (UTC) ----

export const dayStart = (day) => day * DAY_MS;
export const dayRunAt = (day) => day * DAY_MS + STAKING_MS; // 12:00: stakes freeze, the seed is drawn
export const dayEndAt = (day) => (day + 1) * DAY_MS;        // 24:00: the last tick, then the burn
export const dayOf = (ms) => Math.floor(ms / DAY_MS);
export const dayDate = (day) => new Date(dayStart(day)).toISOString().slice(0, 10);

// The tick the clock allows for `day` at `now`: one a second from 12:00, never
// past the last. The chain never runs ahead of this (BurnRun::allowed).
export const clockTick = (day, now, ticks = BURN_TICKS) =>
  Math.min(ticks, Math.max(0, Math.floor((now - dayRunAt(day)) / 1000)));

// Which tick the page shows. The chain stores the run as far as the last
// crank (a keeper cranks about every 25 minutes), so its `t` lags the clock.
// The page runs the same deterministic colony on from the on-chain seed up to
// the clock tick, so the map never pauses: ticks past `chain` are computed
// here and confirmed by the next crank. `chain` and `clock` are returned so
// the page can say how far ahead it is.
export function shownTick(run, now, { ahead = true } = {}) {
  const clock = clockTick(run.day, now, run.ticks ?? BURN_TICKS);
  const chain = Math.min(run.t, clock);
  return { chain, clock, shown: ahead ? clock : chain, lag: Math.max(0, clock - chain) };
}

// ---- the stake snapshot ----

// floor(sqrt(n)) for a BigInt.
export function isqrt(n) {
  if (n < 0n) throw new RangeError("negative");
  if (n < 2n) return n;
  let x = 1n << BigInt((n.toString(2).length + 1) >> 1);
  for (;;) {
    const y = (x + n / x) >> 1n;
    if (y >= x) return x;
    x = y;
  }
}

// Per-option sim weights (milli sqrt-tokens) of a snapshot: the sum over the
// colony-0 entries of isqrt(amount), then divided once by 10^9 and floored,
// saturating at u32::MAX. The same as token/src/stake.rs burn_weights.
export function snapshotWeights(entries, n = N_OPTIONS) {
  const w = new Array(n).fill(0n);
  for (const [, colony, option, amount] of entries) {
    if (colony === BURN_COLONY && option < n) w[option] += isqrt(BigInt(amount));
  }
  return w.map((x) => { const v = x / SIM_WEIGHT_DIV; return v > 0xffffffffn ? 0xffffffff : Number(v); });
}

// The same weights from per-option sums, for the live totals while staking is
// open: the contract's stake_weights view already sums isqrt(stake) in
// sqrt-yocto, so only the divisor is left.
export const weightsFromSqrtYocto = (w) => w.map((x) => {
  const v = BigInt(x) / SIM_WEIGHT_DIV;
  return v > 0xffffffffn ? 0xffffffff : Number(v);
});

// sha256(tag || count u32 || per entry: len u16, account, colony u16, option u8,
// amount u128), big-endian: token/src/stake.rs hash_entries. Hex.
export function snapshotHash(entries) {
  const enc = new TextEncoder();
  const parts = [SNAPSHOT_TAG, u32(entries.length)];
  for (const [acct, colony, option, amount] of entries) {
    const a = enc.encode(acct);
    parts.push(u16(a.length), a, u16(colony), Uint8Array.of(option), u128(BigInt(amount)));
  }
  const buf = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) { buf.set(p, o); o += p.length; }
  return [...sha256(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}
const u16 = (x) => Uint8Array.of(x >> 8, x & 255);
const u32 = (x) => Uint8Array.of(x >>> 24, (x >> 16) & 255, (x >> 8) & 255, x & 255);
function u128(x) {
  const out = new Uint8Array(16);
  for (let i = 15; i >= 0; i--) { out[i] = Number(x & 255n); x >>= 8n; }
  return out;
}

// Wallets of a snapshot as the staker-ant view reads them: { id, stakes } with
// tokens per option (colony 0 only), sorted as the snapshot is.
export function snapshotWallets(entries, n = N_OPTIONS) {
  const by = new Map();
  for (const [acct, colony, option, amount] of entries) {
    if (colony !== BURN_COLONY || option >= n) continue;
    if (!by.has(acct)) by.set(acct, { id: acct, stakes: new Array(n).fill(0) });
    by.get(acct).stakes[option] += toTokens(amount);
  }
  return [...by.values()];
}

// Raw stake per option of a snapshot (yocto), for the roster and the reward split.
export function snapshotTotals(entries, n = N_OPTIONS) {
  const t = new Array(n).fill(0n);
  for (const [, colony, option, amount] of entries) if (colony === BURN_COLONY && option < n) t[option] += BigInt(amount);
  return t;
}

// ---- burn events (contract logs) ----
// `EVENT burn day=<d> index=<i> amount=<yocto burned> reward=<yocto> stakes=<hash>`
// (no `reward=` before the daily pot),
// `EVENT burn_run_done day=<d> winner=<i> hash=<hash>`,
// `EVENT burn_seed day=<d> seed=<hex> stakes=<hash>`.

const kv = (s) => Object.fromEntries(s.split(/\s+/).map((p) => p.split("=")).filter((p) => p.length === 2));
export function parseBurnLogs(logs) {
  const out = { burn: null, done: null, seed: null };
  for (const line of logs ?? []) {
    const m = /^EVENT (burn|burn_run_done|burn_seed)\s+(.*)$/.exec(line);
    if (!m) continue;
    const f = kv(m[2]);
    const day = Number(f.day);
    if (!Number.isSafeInteger(day)) continue;
    if (m[1] === "burn" && /^\d+$/.test(f.amount ?? "") && /^\d$/.test(f.index ?? "")) {
      out.burn = { day, index: Number(f.index), amount: BigInt(f.amount), reward: /^\d+$/.test(f.reward ?? "") ? BigInt(f.reward) : 0n, stakes: f.stakes ?? null };
    }
    else if (m[1] === "burn_run_done") out.done = { day, winner: Number(f.winner), hash: f.hash ?? null };
    else out.seed = { day, seed: f.seed ?? null, stakes: f.stakes ?? null };
  }
  return out;
}
