// Staker ants: each wallet's stake spawns ants tinted in that wallet's colour.
// Agent ants (agentAnts, at the end) do the same for forecaster agents in the
// Agents colony.
// Pure view data. It never touches the sim: the sim only sees per-option
// weights (see walletWeights), and which ant belongs to which wallet is a
// presentation choice, a function of the stakes alone. No RNG, no floats in
// the allocation, so every viewer draws the same colony.
//
// A wallet is { id, stakes: [tokens staked on option 0, 1, ...] } with whole
// tokens. Weight follows the contract: sqrt of each stake, summed per option.

import { sha256 } from "../../sim/js/antosim.mjs";

export const ANTS_PER_SQRT_TOKEN = 3; // staker ants spawned per sqrt-token of weight
const MILLI = 1000;

// floor(sqrt(n)) for a non-negative integer n below 2^53.
function isqrt(n) {
  let r = Math.floor(Math.sqrt(n));
  while (r * r > n) r--;
  while ((r + 1) * (r + 1) <= n) r++;
  return r;
}

// Weight of one stake in milli sqrt-tokens, as the contract's sim_weights does.
export const stakeWeight = (tokens) => isqrt(tokens * MILLI * MILLI);

// Hue of a wallet tint: first two bytes of sha256(account id), big endian, mod 360.
export function walletHue(id) {
  const h = sha256(new TextEncoder().encode(id));
  return ((h[0] << 8) | h[1]) % 360;
}

// oklch(0.74 0.045 h): the --wallet-l and --wallet-c tokens, as the .wallet CSS
// class uses them. Low chroma, so a staker ant never outshines a trail or a pile.
export const walletColor = (hue, alpha = 1) => `oklch(0.74 0.045 ${hue} / ${alpha})`;

// Per-option weights the sim reads (milli sqrt-tokens), from wallet stakes.
export function walletWeights(wallets, nOptions) {
  const w = new Array(nOptions).fill(0);
  for (const { stakes } of wallets) {
    for (let o = 0; o < nOptions; o++) w[o] += stakeWeight(stakes[o] ?? 0);
  }
  return w;
}

// Wallets with their total weight, hue and ant count for a colony of nAnts.
// Ants go by largest remainder on weight, ties to the lowest wallet index.
// With no stakes there are no staker ants. At most nAnts are tinted.
export function stakerAnts(wallets, nAnts) {
  const rows = wallets.map((w, i) => ({
    id: w.id,
    hue: walletHue(w.id),
    stakes: w.stakes,
    tokens: w.stakes.reduce((a, b) => a + b, 0),
    weight: w.stakes.reduce((a, t) => a + stakeWeight(t), 0),
    ants: 0,
    i,
  }));
  const total = rows.reduce((a, r) => a + r.weight, 0);
  const budget = Math.min(nAnts, Math.floor((total * ANTS_PER_SQRT_TOKEN) / MILLI));
  if (total === 0 || budget === 0) return { rows, owner: new Int16Array(nAnts).fill(-1), total };

  // Integer shares: floor(weight * budget / total), then hand out the rest.
  const rem = rows.map((r) => {
    const num = r.weight * budget;
    r.ants = Math.floor(num / total);
    return num % total;
  });
  let left = budget - rows.reduce((a, r) => a + r.ants, 0);
  const order = rows.map((_, i) => i).sort((a, b) => rem[b] - rem[a] || a - b);
  for (const i of order) {
    if (left-- <= 0) break;
    rows[i].ants++;
  }

  // Ants are interchangeable at the nest, so wallets take consecutive indices.
  const owner = new Int16Array(nAnts).fill(-1);
  let a = 0;
  for (const r of rows) for (let k = 0; k < r.ants; k++) owner[a++] = r.i;
  return { rows, owner, total };
}

// Agent ants: in the Agents colony each forecaster agent's ants hatch in its
// colour, like staker ants. That colony follows the agents' lower median, in
// which every post that counted weighs the same, so the whole colony splits
// evenly over the agents: floor(nAnts / agents) each, the rest one apiece to
// the lowest indices. `posts` is the agent snapshot's [[account, odds], ...],
// sorted by account. Same shape as stakerAnts, with kind "agent", each row
// carrying its posted odds and `total` the number of agents.
export function agentAnts(posts, nAnts) {
  const rows = (posts ?? []).map(([id, odds], i) => ({ id, hue: walletHue(id), odds, ants: 0, i, agent: true }));
  const owner = new Int16Array(nAnts).fill(-1);
  if (!rows.length) return { rows, owner, total: 0, kind: "agent" };
  const each = Math.floor(nAnts / rows.length);
  let extra = nAnts - each * rows.length, a = 0;
  for (const r of rows) {
    r.ants = each + (extra-- > 0 ? 1 : 0);
    for (let k = 0; k < r.ants; k++) owner[a++] = r.i;
  }
  return { rows, owner, total: rows.length, kind: "agent" };
}
