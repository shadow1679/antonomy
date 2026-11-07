// The nest page's pure parts: the whole project as a
// cutaway ant base. Chambers stand for the system's parts, tunnels for its
// flows. This module holds the two layouts (wide and tall, in nest units),
// the tunnel paths and how ants walk them, and turns the contract's reads
// (nestchain.mjs) into each chamber's numbers and what it shows. No DOM;
// test_nest.mjs runs it in Node.

import { fmtAnto, burnedPct } from "./token.mjs";
import { POT_MENU_BPS } from "./burn.mjs";

// ---- what each chamber is

// `go`: links into the app from its panel.
export const CHAMBERS = [
  { id: "entrance", name: "Entrance", is: "Wallets come in here. A NEAR testnet wallet claims play $ANTO from the faucet once, then stakes, asks for a forecast or posts odds as an agent.", go: [["index.html#anto", "Your $ANTO"]] },
  { id: "guard", name: "Guard post", is: "The filters and caps everything passes before the colony takes it. Keepers apply the market filters off-chain; the contract enforces the caps and the keepers' quorum, and refunds a request no quorum agreed on.", go: [["recruit.html#forecast", "Add a market"]] },
  { id: "nursery", name: "Nursery", is: "Work waiting to hatch: requested markets (blue eggs) and agents' posted odds (pink eggs). They hatch into colonies once the next drand seed is drawn.", go: [["recruit.html#forecast", "Recruit the swarm"], ["recruit.html#agents", "Answer as an agent"]] },
  { id: "queen", name: "Queen's chamber", is: "The contract. It lays one egg per round: the round's result hashes, which anyone can re-run in a browser and compare.", go: [["replay.html", "History"]] },
  { id: "granary", name: "Granary", is: "The treasury the daily pot draws on, and the $ANTO the contract holds for others: stakes, request fees in escrow and agents' deposits.", go: [["pot.html#sugar", "Stake on the burn"], ["live.html", "Stake on a market"]] },
  { id: "burn", name: "Burn pit", is: "Every day the Burn colony picks a pot size, 0.10% to 2.00% of the treasury. A small part pays the stakers who backed that size; the rest burns for good.", go: [["pot.html", "The daily pot"]] },
  { id: "gallery", name: "Forecast gallery", is: "The round's markets, one cell each. Three colonies forecast every market; a cell glows when the swarm's favourite differs from the market's.", go: [["live.html", "Forecasts"]] },
  { id: "well", name: "Well", is: "Randomness. Every seed is a drand beacon whose signature the contract checks on-chain, so nobody on the team picks it. Anyone can also draw a random value for a small burned fee.", go: [["recruit.html#random", "Randomness"]] },
  { id: "workers", name: "Workers' hall", is: "Keepers post the markets' odds, agents post their own, crankers run the colonies a few ticks a call. All are paid for work, never for being right.", go: [["recruit.html#agents", "Answer as an agent"]] },
];
export const CHAMBER = Object.fromEntries(CHAMBERS.map((c) => [c.id, c]));

// ---- layouts, in nest units. `ground` is the surface line; chambers are
// ellipses (x, y centre, rx, ry); flows are tunnel waypoints, smoothed.

export const GALLERY_CELLS = 12; // token/src/market.rs MAX_TRENDING

export const LAYOUTS = {
  wide: {
    w: 120, h: 80, ground: 13,
    chambers: {
      entrance: { x: 60, y: 11, rx: 9, ry: 4.6 },
      well: { x: 103, y: 27, rx: 6.5, ry: 4.6, shaft: 13 },
      guard: { x: 44, y: 25, rx: 6.5, ry: 4 },
      workers: { x: 16, y: 31, rx: 10, ry: 5.2 },
      nursery: { x: 23, y: 51, rx: 12, ry: 6 },
      queen: { x: 60, y: 43, rx: 13, ry: 7 },
      granary: { x: 89, y: 43, rx: 11.5, ry: 6.5 },
      burn: { x: 104, y: 63, rx: 9.5, ry: 6 },
      gallery: { x: 58, y: 68, rx: 28, ry: 5.6 },
    },
    flows: {
      stake: [[62, 15], [68, 22], [77, 30], [84, 37]],
      burn: [[96, 48], [101, 53], [103, 58]],
      submit: [[57, 15], [51, 19], [47, 22.5]],
      admit: [[41, 28], [35, 35], [29, 41], [25, 46]],
      reject: [[47, 22.5], [51, 19], [57, 15]],
      crank: [[25, 33], [36, 37], [47, 41]],
      seed: [[98, 29], [86, 30], [76, 34], [70, 38]],
      hatch: [[30, 56], [35, 61], [40, 65]],
      result: [[59, 50], [58, 56], [58, 63]],
    },
  },
  tall: {
    w: 64, h: 116, ground: 13,
    chambers: {
      entrance: { x: 30, y: 11, rx: 8, ry: 4.4 },
      well: { x: 53, y: 26, rx: 5.5, ry: 4.2, shaft: 13 },
      guard: { x: 15, y: 25, rx: 6, ry: 3.8 },
      workers: { x: 11, y: 44, rx: 8, ry: 4.8 },
      queen: { x: 36, y: 44, rx: 12, ry: 6.5 },
      nursery: { x: 15, y: 66, rx: 10, ry: 5.4 },
      granary: { x: 46, y: 66, rx: 10.5, ry: 6 },
      burn: { x: 48, y: 86, rx: 9, ry: 5.6 },
      gallery: { x: 32, y: 104, rx: 28, ry: 5.4 },
    },
    flows: {
      stake: [[34, 15], [44, 24], [49, 38], [48, 52], [46, 60]],
      burn: [[48, 72], [49, 77], [48, 80.5]],
      submit: [[27, 15], [21, 19], [17, 21.5]],
      admit: [[13, 29], [9, 38], [8, 50], [12, 56], [14, 60.5]],
      reject: [[17, 21.5], [21, 19], [27, 15]],
      crank: [[19, 45], [24, 45]],
      seed: [[51, 30], [45, 34], [40, 37.5]],
      hatch: [[17, 71.5], [20, 86], [22, 98.5]],
      result: [[33, 50.5], [30, 70], [31, 98.5]],
    },
  },
};

// Which layout fits a stage `width` px wide.
export const layoutFor = (width) => (width < 720 ? "tall" : "wide");

// Pixels per nest unit: the largest whole number (at least 4) that fits the
// width, so the painted grains stay crisp.
export function nestScale(width, layout) {
  return Math.max(4, Math.min(16, Math.floor(width / LAYOUTS[layout].w)));
}

// ---- tunnel paths: Catmull-Rom through the waypoints, sampled, with the
// arc length at every sample so an ant can walk at an even pace.

export function smoothPath(pts, per = 10) {
  if (pts.length < 2) return pts.slice();
  const P = [pts[0], ...pts, pts[pts.length - 1]], out = [];
  for (let i = 1; i < P.length - 2; i++) {
    const [p0, p1, p2, p3] = [P[i - 1], P[i], P[i + 1], P[i + 2]];
    for (let k = 0; k < per; k++) {
      const t = k / per, t2 = t * t, t3 = t2 * t;
      out.push([0, 1].map((d) => 0.5 * (2 * p1[d] + (-p0[d] + p2[d]) * t + (2 * p0[d] - 5 * p1[d] + 4 * p2[d] - p3[d]) * t2 + (-p0[d] + 3 * p1[d] - 3 * p2[d] + p3[d]) * t3)));
    }
  }
  out.push(pts[pts.length - 1].slice());
  return out;
}

export function pathOf(pts, per = 10) {
  const p = smoothPath(pts, per), cum = [0];
  for (let i = 1; i < p.length; i++) cum.push(cum[i - 1] + Math.hypot(p[i][0] - p[i - 1][0], p[i][1] - p[i - 1][1]));
  return { pts: p, cum, len: cum[cum.length - 1] };
}

// The point `s` units along a path, and the heading there (radians).
export function pointAt(path, s) {
  const { pts, cum, len } = path;
  if (pts.length === 1) return { x: pts[0][0], y: pts[0][1], ang: 0 };
  s = Math.min(len, Math.max(0, s));
  let lo = 0, hi = cum.length - 1;
  while (hi - lo > 1) { const mid = (lo + hi) >> 1; if (cum[mid] <= s) lo = mid; else hi = mid; }
  const seg = cum[hi] - cum[lo] || 1, f = (s - cum[lo]) / seg;
  const [a, b] = [pts[lo], pts[hi]];
  return { x: a[0] + (b[0] - a[0]) * f, y: a[1] + (b[1] - a[1]) * f, ang: Math.atan2(b[1] - a[1], b[0] - a[0]) };
}

// ---- what the flows mean. `crumb` is what an ant on it carries.

export const FLOWS = {
  stake: { from: "entrance", to: "granary", crumb: "sugar", label: "stake" },
  burn: { from: "granary", to: "burn", crumb: "ember", label: "burn" },
  submit: { from: "entrance", to: "guard", crumb: "egg", label: "request" },
  admit: { from: "guard", to: "nursery", crumb: "egg", label: "admitted" },
  reject: { from: "guard", to: "entrance", crumb: "egg", label: "turned away" },
  crank: { from: "workers", to: "queen", crumb: null, label: "crank" },
  seed: { from: "well", to: "queen", crumb: "seed", label: "seed" },
  hatch: { from: "nursery", to: "gallery", crumb: "larva", label: "hatch" },
  result: { from: "queen", to: "gallery", crumb: "egg", label: "result" },
};

// Ambient ants per flow (always walking) when nothing has happened lately.
export const AMBIENT = { stake: 5, burn: 3, submit: 3, admit: 3, reject: 1, crank: 5, seed: 3, hatch: 3, result: 3 };

// ---- formatting

const DASH = "—";
const big = (x) => (x === null || x === undefined ? null : BigInt(x));
export const anto = (x, compact = false) => (x === null || x === undefined ? DASH : `${fmtAnto(x, { compact })} $ANTO`);
export const shortHash = (h) => (h ? `${h.slice(0, 4)}…${h.slice(-4)}` : DASH);
const argmax = (xs) => xs.reduce((w, x, i) => (x > xs[w] ? i : w), 0);
const plural = (n, one, many = `${one}s`) => `${n.toLocaleString("en")} ${n === 1 ? one : many}`;
export const PHASE_WORD = { posting: "staking", agents: "taking agents' odds", ready: "waiting for its seed", running: "running", done: "finished", skipped: "skipped" };

// Heights 0..1 for a share, on a square-root scale so small piles still show.
export function pileLevel(part, whole) {
  part = big(part); whole = big(whole);
  if (part === null || whole === null || whole <= 0n || part <= 0n) return 0;
  const f = Number((part * 10_000n) / whole) / 10_000;
  return Math.min(1, Math.max(0.08, Math.sqrt(f)));
}

// The flame follows the last pot's size on the menu: 0.10% low, 2.00% high.
export const flameLevel = (index) => (Number.isInteger(index) && index >= 0 ? 0.35 + 0.65 * (index / (POT_MENU_BPS.length - 1)) : 0.45);

// Recruit requests by fate: queued (keepers or agents still posting),
// accepted (it ran or is running) and turned away (no quorum: refunded).
export function guardCounts(requests) {
  const out = { queued: 0, accepted: 0, turnedAway: 0 };
  for (const r of requests ?? []) {
    if (r.phase === "odds") out.queued++;
    else if (r.phase === "skipped") out.turnedAway++;
    else out.accepted++;
  }
  return out;
}

// Blue eggs: requests still waiting to run. Pink eggs: agents' posts on
// those requests plus on this round's markets (`roundPosts`).
export function nurseryEggs(requests, roundPosts = 0) {
  const open = (requests ?? []).filter((r) => r.phase === "odds" || r.phase === "forecasting");
  const reqPosts = open.reduce((n, r) => n + (r.agents?.posts?.length ?? 0), 0);
  return { blue: open.length, pink: reqPosts + (roundPosts ?? 0), open };
}

// One egg per round, newest last, at most `max` drawn. The previous round's
// egg (and the current one's, once it has run) carries its market hashes.
export function queenEggs(round, max = 8) {
  if (!round) return [];
  const eggs = [];
  const prev = round.previous;
  const from = Math.max(1, round.id - max + 1);
  for (let id = from; id <= round.id; id++) {
    const src = id === round.id ? round : prev && prev.id === id ? prev : null;
    const hashes = src ? src.markets.map((m) => m.marketHash).filter(Boolean) : [];
    let state = "laid";
    if (id === round.id) state = round.phase === "done" ? "laid" : round.phase === "skipped" ? "skipped" : "laying";
    eggs.push({ round: id, state, hashes, known: !!src });
  }
  return eggs;
}

// The gallery: one cell per market of the round on show, GALLERY_CELLS in
// all. A cell differs when the swarm belief's leader is not the market
// odds' leader (ties to the lowest index, as the sim).
export function galleryCells(src) {
  const ms = src?.markets ?? [];
  return Array.from({ length: GALLERY_CELLS }, (_, i) => {
    const m = ms[i];
    if (!m) return null;
    const marketLead = argmax(m.odds);
    const swarmLead = m.swarm ? argmax(m.swarm) : null;
    return { key: m.key, title: m.title, outcomes: m.outcomes, marketLead, swarmLead, differs: swarmLead !== null && swarmLead !== marketLead, done: m.done, cranked: m.cranked };
  });
}

// ---- the chambers' numbers. `r` is loadNest()'s reads (any field null when
// its read failed). Returns { [id]: { headline, rows: [[label, value]], ... } }.

export function deriveNest(r, { contract = "antonomy-oracle.testnet" } = {}) {
  const t = r.token ?? {};
  const out = {};

  out.entrance = {
    headline: t.faucet != null ? `${anto(t.faucet)} free` : "Faucet",
    rows: [
      ["Faucet", t.faucet != null ? `${anto(t.faucet)}, once per testnet account` : DASH],
      ...(t.me ? [["Your balance", anto(t.me.balance)], ["You have staked", anto(t.me.staked)]] : []),
      ["Supply", anto(t.supply)],
      ["Network", "NEAR testnet · play token"],
    ],
  };

  const g = guardCounts(r.requests);
  const [keepers, quorum] = r.keepers ?? [null, null];
  out.guard = {
    headline: r.requests ? `${g.accepted} in · ${g.turnedAway} turned away` : DASH,
    paused: r.paused === true,
    counts: g,
    rows: [
      ["Outcomes", "2 to 5 per market"],
      ["Topics", "none about violence, deaths or private individuals"],
      ["Trending floor", "24 h Polymarket volume of 100,000 USDC or more (keepers)"],
      ["Stake cap", r.stakeCfg ? `${anto(r.stakeCfg.cap_per_wallet)} per wallet` : DASH],
      ["Burn cap", "2.00% of the treasury a day, at most"],
      ["Keepers' quorum", keepers ? `${quorum} of ${keepers.length}` : DASH],
      ["Requests", r.requests ? `${g.accepted} accepted · ${g.turnedAway} turned away and refunded · ${g.queued} at the gate` : DASH],
      ["Guardian", r.paused == null ? DASH : r.paused ? "paused" : "not paused"],
    ],
  };

  const eggs = nurseryEggs(r.requests, r.agentPosts);
  out.nursery = {
    headline: r.requests ? `${plural(eggs.blue, "request")} · ${plural(eggs.pink, "agent post")}` : DASH,
    blue: eggs.blue, pink: eggs.pink,
    rows: [
      ["Requested markets", r.requests ? String(eggs.blue) : DASH],
      ["Agents' posts", r.requests || r.agentPosts != null ? String(eggs.pink) : DASH],
      ...eggs.open.slice(0, 4).map((q) => [`Request #${q.id}`, `${q.market_id} · ${q.phase === "odds" ? "keepers posting" : "agents posting"}`]),
    ],
    open: eggs.open.map((q) => ({ id: q.id, market: q.market_id, phase: q.phase })),
  };

  const round = r.round;
  const qe = queenEggs(round);
  const prev = round?.previous;
  out.queen = {
    headline: round ? `Round ${round.id} · ${PHASE_WORD[round.phase] ?? round.phase}` : DASH,
    eggs: qe,
    rows: [
      ["Contract", contract],
      ["Round", round ? `${round.id}, ${PHASE_WORD[round.phase] ?? round.phase}` : DASH],
      ["Markets this round", round ? String(round.markets.length) : DASH],
      ...(prev ? [[`Round ${prev.id}'s eggs`, prev.markets.map((m) => shortHash(m.marketHash)).join(" · ") || DASH]] : []),
      ["Simulation", "ANTO-SIM-v1 · Rust = JS = Python"],
    ],
  };

  const stakedRound = round?.markets?.reduce((n, m) => n + (m.stakes ?? []).reduce((a, x) => a + BigInt(x), 0n), 0n) ?? null;
  out.granary = {
    headline: t.treasury != null ? `${anto(t.treasury, true)} in the treasury` : DASH,
    treasuryLevel: pileLevel(t.treasury, t.genesis),
    escrowLevel: pileLevel(r.escrow, t.treasury),
    rows: [
      ["Treasury", anto(t.treasury)],
      ["Held for others", anto(r.escrow)],
      ["Stakes", anto(r.vaults?.stakes)],
      ["Request fees in escrow", anto(r.vaults?.fees)],
      ["Agents' deposits", anto(r.vaults?.deposits)],
      ["Staked this round", stakedRound != null && round?.markets?.length ? anto(stakedRound) : DASH],
    ],
  };

  const lb = r.lastBurn;
  const potRange = r.pot?.length ? `${anto(BigInt(r.pot[0].burn) + BigInt(r.pot[0].reward), true)} to ${anto(BigInt(r.pot.at(-1).burn) + BigInt(r.pot.at(-1).reward), true)}` : DASH;
  out.burn = {
    headline: t.burned != null ? `${anto(t.burned, true)} burned` : DASH,
    flame: flameLevel(lb?.index),
    rows: [
      ["Burned since launch", t.burned != null ? `${anto(t.burned)} (${burnedPct(t.burned, t.genesis)})` : DASH],
      ["Last burn", lb ? (lb.burned != null ? `day ${lb.day}: ${anto(lb.burned)}, pot ${(POT_MENU_BPS[lb.index] / 100).toFixed(2)}%` : `day ${lb.day}`) : DASH],
      ["Today's pot", potRange],
      ["Today", r.schedule ? (r.schedule.phase === "staking" ? "staking till 12:00 UTC" : "the Burn colony runs till 24:00 UTC") : DASH],
    ],
  };

  const shown = round?.shown;
  const cells = galleryCells(shown);
  const differ = cells.filter((c) => c?.differs).length;
  const n = cells.filter(Boolean).length;
  out.gallery = {
    headline: n ? `${plural(n, "market")} · the swarm differs on ${differ}` : "No markets yet",
    cells,
    from: shown ? (shown === round ? `Round ${shown.id}` : `Previous round ${shown.id}`) : null,
    rows: [
      ["Showing", shown ? (shown === round ? `round ${shown.id}` : `round ${shown.id}, the last finished`) : DASH],
      ["Markets", String(n)],
      ["Swarm favourite differs", String(differ)],
    ],
  };

  const rnd = r.randomness;
  out.well = {
    headline: round?.drandRound ? `drand #${round.drandRound}` : "drand",
    rows: [
      ["This round's seed", round?.drandRound ? `drand round ${round.drandRound}, signature checked on-chain` : DASH],
      ["Random values drawn", rnd ? String(rnd.count) : DASH],
      ...(rnd?.latest ? [[`Request #${rnd.latest.id}`, `${rnd.latest.status} · drand round ${rnd.latest.drand_round}`]] : []),
    ],
  };

  const cfg = r.rcfg;
  const pct = (b) => `${b / 100}%`;
  out.workers = {
    headline: keepers ? `${plural(keepers.length, "keeper")} · ${plural(r.agents?.length ?? 0, "agent")}` : DASH,
    keepers: keepers?.length ?? 0, agents: r.agents?.length ?? 0,
    rows: [
      ["Keepers", keepers ? `${keepers.length}, quorum ${quorum}` : DASH],
      ["Agents", r.agents ? String(r.agents.length) : DASH],
      ["Request fee", cfg ? anto(cfg.fee) : DASH],
      ["Fee split", cfg ? `keepers ${pct(cfg.keeper_bps)} · agents ${pct(cfg.agent_bps)} · crankers ${pct(cfg.crank_bps)}` : DASH],
      ["Agent deposit", cfg ? `${anto(cfg.agent_deposit)}, refundable` : DASH],
    ],
  };
  return out;
}

// ---- what changed between two reads: ants to send and log lines.
// Each event is { flow, n (ants), text }.

export function diffEvents(a, b) {
  if (!a || !b) return [];
  const ev = [];
  const esc0 = big(a.escrow), esc1 = big(b.escrow);
  if (esc0 !== null && esc1 !== null && esc1 > esc0) ev.push({ flow: "stake", n: 4, text: `${anto(esc1 - esc0)} came into the granary (a stake or a fee)` });
  const s0 = big(a.token?.supply), s1 = big(b.token?.supply);
  if (s0 !== null && s1 !== null && s1 < s0) ev.push({ flow: "burn", n: 5, text: `${anto(s0 - s1)} burned` });
  const byId = new Map((a.requests ?? []).map((q) => [q.id, q]));
  for (const q of b.requests ?? []) {
    const was = byId.get(q.id);
    if (!was) { if (a.requests) ev.push({ flow: "submit", n: 2, text: `Request #${q.id} came to the gate: ${q.market_id}` }); continue; }
    if (was.phase === q.phase) continue;
    if (q.phase === "skipped") ev.push({ flow: "reject", n: 2, text: `Request #${q.id} turned away: no keeper quorum, fee refunded` });
    else if (was.phase === "odds" && q.phase === "forecasting") ev.push({ flow: "admit", n: 2, text: `Request #${q.id} admitted: keepers agreed on its odds` });
    else if (q.phase === "done") ev.push({ flow: "hatch", n: 3, text: `Request #${q.id} hatched: its forecast is done` });
  }
  const r0 = a.round, r1 = b.round;
  if (r0 && r1) {
    if (r1.id !== r0.id) ev.push({ flow: "result", n: 4, text: `Round ${r0.id} closed; round ${r1.id} began` });
    else {
      const c0 = r0.markets.reduce((n, m) => n + m.cranked, 0), c1 = r1.markets.reduce((n, m) => n + m.cranked, 0);
      if (c1 > c0) ev.push({ flow: "crank", n: Math.min(6, c1 - c0 + 1), text: `${plural(c1 - c0, "colony", "colonies")} cranked in round ${r1.id}` });
      if (!r0.seed && r1.seed) ev.push({ flow: "seed", n: 3, text: `Round ${r1.id}'s seed was drawn from drand` });
    }
  }
  const n0 = a.randomness?.count, n1 = b.randomness?.count;
  if (n0 != null && n1 != null && n1 > n0) ev.push({ flow: "seed", n: 2, text: `${plural(n1 - n0, "random value")} requested` });
  return ev;
}

// ---- the nest log: contract calls from the indexer as plain lines.

const VERBS = {
  claim_play_tokens: ["entrance", "claimed play $ANTO from the faucet"],
  ft_transfer_call: ["granary", "sent $ANTO to the contract"],
  stake: ["granary", "staked $ANTO"],
  unstake: ["granary", "withdrew a stake"],
  settle: ["granary", "settled stakes"],
  post_trending: ["workers", "posted the trending markets' odds"],
  finalize_markets: ["guard", "closed the round's markets"],
  start_round: ["queen", "started a round"],
  crank_round: ["queen", "cranked a forecast colony"],
  request_forecast: ["guard", "asked the swarm for a forecast"],
  post_request_odds: ["workers", "posted odds for a request"],
  finalize_request_odds: ["guard", "closed a request's odds"],
  crank_request: ["queen", "cranked a requested colony"],
  register_agent: ["workers", "registered as an agent"],
  unregister_agent: ["workers", "left the agents"],
  post_forecast: ["nursery", "posted an agent's odds"],
  commit_forecast: ["nursery", "committed an agent's hidden odds"],
  reveal_forecast: ["nursery", "revealed an agent's odds"],
  crank_burn: ["burn", "cranked the Burn colony"],
  execute_burn: ["burn", "paid and burned the daily pot"],
  set_paused: ["guard", "changed the guardian pause"],
  request_randomness: ["well", "requested a random value"],
};

// A short name for an account: "keeper2" for keeper2.antonomy-oracle.testnet.
export function who(account, contract = "antonomy-oracle.testnet") {
  if (!account) return "someone";
  if (account === contract) return "the contract";
  if (account.endsWith(`.${contract}`)) return account.slice(0, -contract.length - 1);
  return account.length > 24 ? `${account.slice(0, 10)}…${account.slice(-10)}` : account;
}

// One indexer transaction -> { ms, chamber, text, tx } or null (failed, or
// not a call we describe).
export function logLine(t, contract = "antonomy-oracle.testnet") {
  if (t?.outcomes?.status === false) return null;
  const method = (t?.actions ?? []).map((a) => a.method).find((m) => m && VERBS[m]);
  if (!method) return null;
  const [chamber, verb] = VERBS[method];
  const ms = Math.floor(Number(BigInt(t.block_timestamp ?? 0) / 1_000_000n));
  return { ms, chamber, text: `${who(t.predecessor_account_id, contract)} ${verb}`, tx: t.transaction_hash ?? null, method };
}

// Log lines the chain itself dates, for when the indexer lists nothing:
// each request's ask (and its fate so far) and the newest randomness
// request. Keyed so a line is never logged twice.
export function chainLog(r, contract = "antonomy-oracle.testnet") {
  const out = [];
  const FATE = { odds: "keepers posting its odds", forecasting: "agents posting", running: "colonies running", done: "forecast done", skipped: "turned away, fee refunded" };
  for (const q of (r?.requests ?? []).slice(-8)) {
    if (!q.created_at_ms) continue;
    out.push({ key: `req-${q.id}`, ms: q.created_at_ms, chamber: q.phase === "skipped" ? "guard" : "nursery", text: `${who(q.requester, contract)} asked the swarm about ${q.market_id} (request #${q.id}: ${FATE[q.phase] ?? q.phase})` });
  }
  const rl = r?.randomness?.latest;
  if (rl?.requested_at_ms) out.push({ key: `rnd-${rl.id}`, ms: rl.requested_at_ms, chamber: "well", text: `${who(rl.requester, contract)} requested random value #${rl.id} (${rl.status})` });
  return out;
}

// A screen reader's (and reduced motion's) one-paragraph tour of the nest.
export function nestSummary(model) {
  return CHAMBERS.map((c) => `${c.name}: ${model[c.id]?.headline ?? DASH}.`).join(" ");
}
