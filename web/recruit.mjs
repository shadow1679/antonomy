// Recruit an ant, in the browser: the strategies of the recruit kit
// (bots/recruit.py's decide(r) over a Round, bots/my_ant.py and the
// bots/swarm.py built-ins) run against the demo's Burn stakes, so the Recruit
// page can show what an agent would stake and the ants it would hatch. Pure
// data, no DOM, so Node can test it. Amounts here are whole tANTO and weights
// milli sqrt-tokens; the kit itself reads the contract views in yocto. Same
// rules and tie-breaks as the kit, so the same stakes give the same plan.

import { walletWeights, stakeWeight } from "./ds/staker-ants.mjs";
import { burnDay, stakesAt, BURN_WALLETS, STAKING_MS, DAY_MS } from "./round.mjs";
import { previewSide, SUGAR_CAP, N_OPTIONS } from "./sugar.mjs";

export const MENU_BPS = [10, 25, 50, 100, 200]; // token/src/burn.rs
export const ROUND_SHARE_BPS = 1_000;           // token/src/reward.rs: 10% of the pool per burn day
export const COMMUNITY_BASE = 2_500;            // milli sqrt-tokens of food every option starts with
export const POOL = 50_000;                     // demo reward pool, tANTO (a fixture)
export const BALANCE = 100;                     // the demo recruit's balance, tANTO (a sample)
const FLOW_AMOUNT = 10;                         // bots/swarm.py
const HEAVY_FAVOURITE = 4;                      // 2.00%, the top of the menu
const VALUE_STAKE = 20;                         // bots/my_ant.py STAKE_TOKENS
const ONE = 10n ** 24n;                         // yocto per token

// Everything decide() may read, as in bots/recruit.py's Round.
export class Round {
  constructor({ wallets, mine = new Array(N_OPTIONS).fill(0), balance = BALANCE, cap = SUGAR_CAP, pool = POOL }) {
    this.n = N_OPTIONS;
    this.menuBps = MENU_BPS.slice();
    this.weights = walletWeights(wallets, N_OPTIONS);
    this.totals = Array.from({ length: N_OPTIONS }, (_, o) => wallets.reduce((a, w) => a + (w.stakes[o] ?? 0), 0));
    this.mine = mine.slice();
    this.balance = balance;
    this.staked = this.mine.reduce((a, b) => a + b, 0);
    this.cap = cap;
    this.headroom = Math.max(0, cap - this.staked);
    this.pool = pool;
    this.pot = Math.floor((pool * ROUND_SHARE_BPS) / 10_000);
  }

  // Option o's weight if this account adds `extra` tokens on it.
  weightAfter(o, extra = 0) {
    return this.weights[o] - stakeWeight(this.mine[o]) + stakeWeight(this.mine[o] + extra);
  }

  // o's share of food weight in the sim after that: a rough proxy for its chance to win.
  foodShare(o, extra = 0) {
    const food = Array.from({ length: this.n }, (_, k) => COMMUNITY_BASE + this.weightAfter(k, k === o ? extra : 0));
    return food[o] / food.reduce((a, b) => a + b, 0);
  }

  // This account's reward if o wins, at current stakes, split by raw stake.
  payoutIfWins(o, extra = 0) {
    const total = this.totals[o] + extra;
    return total ? (this.pot * (this.mine[o] + extra)) / total : 0;
  }
}

// Highest (lowest) value, ties to the lowest index, like the sim and the kit.
const argmax = (xs) => xs.reduce((b, x, i) => (x > xs[b] ? i : b), 0);
const argmin = (xs) => xs.reduce((b, x, i) => (x < xs[b] ? i : b), 0);

// The kit's strategies. `arg` is what goes after --strategy.
export const STRATEGIES = {
  value: {
    name: "Value seeker", arg: "bots/my_ant.py",
    blurb: "The example file. Weighs each option's chance to win against its reward.",
    decide(r) {
      const amount = Math.min(VALUE_STAKE, r.balance, r.headroom);
      if (amount <= 0) return [];
      const value = Array.from({ length: r.n }, (_, o) => r.foodShare(o, amount) * r.payoutIfWins(o, amount));
      return [[argmax(value), amount]];
    },
  },
  follower: {
    name: "Follower", arg: "follower",
    blurb: "Backs the option with the most weight.",
    decide: (r) => [[argmax(r.weights), FLOW_AMOUNT]],
  },
  contrarian: {
    name: "Contrarian", arg: "contrarian",
    blurb: "Backs the option with the least weight.",
    decide: (r) => [[argmin(r.weights), FLOW_AMOUNT]],
  },
  heavy: {
    name: "Heavy", arg: "heavy",
    blurb: "Puts its whole cap on the biggest burn, 2.00%.",
    decide: (r) => [[HEAVY_FAVOURITE, r.cap - r.staked]],
  },
};

// decide()'s answer as stakes the contract will accept: valid options,
// positive whole amounts, in total within the balance and the cap headroom
// (earlier entries first). Same notes as bots/recruit.py's clip().
export function clip(r, wanted) {
  let left = Math.min(r.balance, r.headroom);
  const stakes = [], notes = [];
  for (const item of wanted ?? []) {
    const [o, amt] = Array.isArray(item) ? item : [];
    if (!Number.isInteger(o) || o < 0 || o >= r.n) { notes.push(`dropped option ${o}: the menu has ${r.n} options`); continue; }
    if (!Number.isInteger(amt) || amt <= 0) { notes.push(`dropped amount ${amt} on option ${o}: want a positive whole amount`); continue; }
    if (left === 0) { notes.push(`dropped option ${o}: no balance or wallet cap headroom left`); continue; }
    let a = amt;
    if (a > left) { notes.push(`option ${o}: clipped ${a} to ${left} (balance and wallet cap)`); a = left; }
    stakes.push([o, a]);
    left -= a;
  }
  return { stakes, notes };
}

// The demo's stakes a recruit meets at `now`, and the map its preview runs
// on. Before 12:00 UTC a stake counts today: the stakes so far, on
// yesterday's map (today's seed isn't drawn). From 12:00 it counts tomorrow:
// today's closed stakes, on today's map. Same as the Burn page's drop sugar.
export function recruitDay(now = Date.now()) {
  const today = burnDay(Math.floor(now / DAY_MS));
  const staking = now < today.startMs + STAKING_MS;
  return staking
    ? { staking, countsFor: today, seed: burnDay(today.day - 1).seed, wallets: stakesAt(today, now), map: "yesterday's map" }
    : { staking, countsFor: burnDay(today.day + 1), seed: today.seed, wallets: BURN_WALLETS, map: "today's map" };
}

// One recruit: the strategy's plan against `wallets`, with the kit's
// estimates per line (each including the earlier lines), and the preview
// colony with the recruit's wallet added. `wallet` is its row in
// side.stakers (-1 if it stakes nothing), `ants` how many ants it hatches.
export function recruit(id, key, wallets, seed, opts = {}) {
  const r = new Round({ wallets, ...opts });
  const { stakes, notes } = clip(r, STRATEGIES[key].decide(r));
  const extra = new Array(r.n).fill(0);
  const lines = stakes.map(([o, amount]) => {
    extra[o] += amount;
    return { option: o, bps: r.menuBps[o], amount, weightAfter: r.weightAfter(o, extra[o]),
      foodShare: r.foodShare(o, extra[o]), payoutIfWins: r.payoutIfWins(o, extra[o]) };
  });
  const all = extra.some((x) => x > 0) ? [...wallets, { id, stakes: extra }] : wallets;
  const side = previewSide(seed, all);
  const wallet = side.stakers.rows.findIndex((x) => x.id === id && x.ants > 0);
  return { round: r, lines, notes, wallet, ants: wallet >= 0 ? side.stakers.rows[wallet].ants : 0, side };
}

// The NEAR CLI call the kit signs for one stake (bots/swarm.py near_call),
// quoted the way the kit prints it (Python's shlex.join).
const quote = (x) => (/^[\w@%+=:,./-]+$/.test(x) ? x : `'${x.replace(/'/g, `'"'"'`)}'`);
export function stakeCall(contract, account, option, tokens, network = "testnet") {
  const args = JSON.stringify({ colony: 0, option, amount: (BigInt(tokens) * ONE).toString() });
  return ["near", "contract", "call-function", "as-transaction", contract, "stake",
    "json-args", args, "prepaid-gas", "100.0 Tgas", "attached-deposit", "0 NEAR",
    "sign-as", account, "network-config", network, "sign-with-keychain", "send"].map(quote).join(" ");
}

// The kit's own command lines for this account and strategy. The value
// seeker starts from a copy of bots/my_ant.py named after the account.
export function kitCommands(contract, account, key) {
  const base = `python3 -I bots/recruit.py --contract ${quote(contract)} --account ${quote(account)}`;
  const file = key === "value" ? `bots/${account.replace(/\.[^.]*$/, "").replace(/\W+/g, "_") || "my_ant"}_strategy.py` : null;
  const strategy = file ?? STRATEGIES[key].arg;
  return {
    copy: file ? `cp bots/my_ant.py ${file}` : null,
    dry: `${base} --strategy ${strategy}`,
    send: `${base} --strategy ${strategy} --send`,
    withdraw: `${base} --withdraw --send`,
  };
}
