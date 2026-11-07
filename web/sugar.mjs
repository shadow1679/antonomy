// Drop sugar: what the Burn colony would do if one more stake went on an
// option. Pure data and no DOM, so Node can test it. The sim itself is
// untouched: sugar only changes the summed sqrt weight per option, which
// burnRichness turns into food richness (the "scent"). Same map and same ants
// on both sides, so any difference comes from the extra stake.
// The preview is a short TICKS (800) run, not the day's BURN_TICKS, so it
// finishes in seconds. Nothing here is sent anywhere.
//
// Inputs come from the contract: `weights` are all wallets' stake weights per
// option (milli sqrt-tokens: the stake_weights view while staking is open, the
// frozen snapshot's weights after 12:00) and `mine` is the connected wallet's
// own stake per option in tokens (stakes_of). The contract lists no other
// wallets while staking is open, so everyone else is one "other wallets" row
// of ants; the connected wallet is its own tinted row.

import { Colony, colonySeed, burnRichness, sha256, N_ANTS, TICKS, BURN_COLONY } from "../sim/js/antosim.mjs";
import { stakerAnts, stakeWeight } from "./ds/staker-ants.mjs";

export const YOU = "you";
export const OTHERS = "other wallets";
export const SUGAR_CAP = 100; // default tokens per wallet; the contract's cap is a config setting (stake_config)
export const N_OPTIONS = 5;

const ZERO32 = new Uint8Array(32);

// A fixed map for previews before any colony has run on chain. Labelled as a
// sample map on the page; it is not a day seed.
export const SAMPLE_DAY_SEED = sha256(new TextEncoder().encode("antonomy-sugar-preview-map"));

const zeros = () => new Array(N_OPTIONS).fill(0);

// The chain's weights split into the connected wallet's part and everyone
// else's, then with `tokens` more on `option`. A wallet's weight on an option
// is the sqrt of its whole stake there, so extra sugar on top of an existing
// stake adds less than it would alone.
export function withSugar(base, option, tokens, cap = SUGAR_CAP) {
  const { weights = zeros(), mine = zeros(), id = YOU } = base ?? {};
  if (!Number.isInteger(option) || option < 0 || option >= N_OPTIONS) throw new RangeError("bad option");
  if (!Number.isInteger(tokens) || tokens < 0 || tokens > cap) throw new RangeError("bad stake");
  const mineW = mine.map((t) => stakeWeight(t));
  const others = weights.map((w, o) => Math.max(0, w - mineW[o]));
  const after = mine.map((t, o) => (o === option ? t + tokens : t));
  const withW = others.map((w, o) => w + stakeWeight(after[o]));
  return { id, others, mine, after, weights, withWeights: tokens ? withW : weights.slice() };
}

// One side of a preview: the Burn colony's map for `daySeed` with these
// per-option weights, as a short TICKS run. `stakes` are the wallets for the
// staker ants (cosmetic).
export function previewSide(daySeed, weights, wallets) {
  const seed = colonySeed(daySeed, BURN_COLONY);
  const richness = burnRichness(weights);
  return {
    wallets,
    weights,
    richness,
    stakers: stakerAnts(wallets, N_ANTS),
    make: () => new Colony(seed, N_OPTIONS, richness, N_ANTS, TICKS, ZERO32),
  };
}

// "Other wallets" as one row whose weight on each option is exactly `w`
// (stakeWeight floors the sqrt, so aim half a unit above).
export const othersWallet = (w) => ({ id: OTHERS, stakes: w.map((x) => (x > 0 ? ((x + 0.5) / 1000) ** 2 : 0)) });

// Both sides of the comparison for one day seed.
export function sugarPreview(daySeed, option, tokens, base, cap = SUGAR_CAP) {
  const s = withSugar(base, option, tokens, cap);
  const side = (stakes, weights) => previewSide(daySeed, weights,
    [othersWallet(s.others), ...(stakes.some((t) => t > 0) ? [{ id: s.id, stakes }] : [])].filter((w) => w.stakes.some((t) => t > 0)));
  return {
    id: s.id,
    weight: s.withWeights.reduce((a, w, o) => a + w - s.weights[o], 0), // milli sqrt-tokens added by the new sugar
    without: side(s.mine, s.weights),
    with: side(s.after, s.withWeights),
  };
}
