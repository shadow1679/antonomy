// Drop sugar: what the Burn colony would do if one more wallet staked on an
// option. Pure data and no DOM, so Node can test it. The sim itself is
// untouched: sugar only changes the summed sqrt weight per option, which
// stakeRichness turns into food richness (the "scent"). Same round seed, same
// map and same ants on both sides, so any difference comes from the extra stake.
// The preview is a short TICKS (800) run, not the day's BURN_TICKS, so it
// finishes in seconds.

import { Colony, colonySeed, stakeRichness, N_ANTS, TICKS, BURN_COLONY } from "../sim/js/antosim.mjs";
import { walletWeights, stakerAnts, stakeWeight } from "./ds/staker-ants.mjs";
import { BURN_WALLETS } from "./round.mjs";

export const YOU = "you.testnet";
export const SUGAR_CAP = 100; // tokens per wallet; a sample value, the contract's cap is a config setting
export const N_OPTIONS = 5;

const ZERO32 = new Uint8Array(32);

// The fixture wallets plus one wallet that dropped `tokens` on `option`.
// With no sugar the wallet list is returned as is.
export function withSugar(wallets, option, tokens) {
  if (!Number.isInteger(option) || option < 0 || option >= N_OPTIONS) throw new RangeError("bad option");
  if (!Number.isInteger(tokens) || tokens < 0 || tokens > SUGAR_CAP) throw new RangeError("bad stake");
  if (tokens === 0) return wallets;
  const stakes = new Array(N_OPTIONS).fill(0);
  stakes[option] = tokens;
  return [...wallets, { id: YOU, stakes }];
}

// One side of a preview: the Burn colony's map for `roundSeed` with these
// wallets' stakes, as a short TICKS run. Also used by the Recruit page.
export function previewSide(roundSeed, wallets) {
  const seed = colonySeed(roundSeed, BURN_COLONY);
  const weights = walletWeights(wallets, N_OPTIONS);
  const richness = stakeRichness(weights);
  return {
    wallets,
    weights,
    richness,
    stakers: stakerAnts(wallets, N_ANTS),
    make: () => new Colony(seed, N_OPTIONS, richness, N_ANTS, TICKS, ZERO32),
  };
}

// Both sides of the comparison for one burn day seed.
export function sugarPreview(roundSeed, option, tokens, wallets = BURN_WALLETS) {
  return {
    weight: stakeWeight(tokens), // milli sqrt-tokens added to `option`
    without: previewSide(roundSeed, wallets),
    with: previewSide(roundSeed, withSugar(wallets, option, tokens)),
  };
}
