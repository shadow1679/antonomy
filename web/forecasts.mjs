// The Forecast list on the Live page (docs/FORECAST_PAGE.md): one card per
// market, the round's trending markets and the community's requests alike.
// Each card holds the three colony maps beside the gap table (design B) and
// ends in its headline gap. Pure: chain data in, HTML strings out, so Node
// can test it (pass `now` where the clock matters).

import { trailShares } from "../sim/js/antosim.mjs";
import { KIND_NAMES } from "./round.mjs";
import { esc } from "./ui.mjs";
import { utc, marketHref, requestHref } from "./lv.mjs";

export const READS = ["Market odds and their 6h move", "$ANTO stakes", "The agents' median odds"];
const SITS = ["", "out · nobody staked", "out · no agent posted"];
const SITS_LONG = ["", "No stakes, so Community sat out of the swarm belief", "No agent posted, so Agents sat out of the swarm belief"];

export const pts = (bps) => Math.round(bps / 100);
export const sign = (g) => (g > 0 ? "+" : g < 0 ? "−" : "±") + Math.abs(g);
const pill = (state, text, title = "") =>
  `<span class="pill" data-state="${state}"${title ? ` title="${esc(title)}"` : ""}>${state === "running" ? `<i class="pill__g" aria-hidden="true"></i>` : ""}${esc(text)}</span>`;

// ---- cards: what the list knows about one market ----

// A market of a round (`rd` from loadRound(), or finished(round.previous)).
export function roundCard(m, rd) {
  const href = marketHref(m.key);
  return {
    id: `mk-${m.key}`, n: String(m.index + 1), m, rd, req: null, mine: false,
    href, colHref: (k) => `${href}&c=${KIND_NAMES[k].toLowerCase()}`,
  };
}

// A requested market. `r` is a ForecastRequestView, `m` its buildMarket()
// (null until the keepers post odds), `me` the connected account.
export function requestCard(r, m, me = null) {
  const href = requestHref(r.id);
  return {
    id: `mk-r${r.id}`, n: `R${r.id}`, m, rd: null, req: r, mine: !!me && r.requester === me,
    href, colHref: () => href,
  };
}

const titleOf = (c) => c.m?.title ?? c.req?.market_id ?? "";
const slugOf = (c) => c.m?.marketId ?? c.req?.market_id ?? "";

// What a card shows once colonies have run, or null before. `v` is the
// market's verifyMarket() result (or null while it runs). A finished market
// uses the chain's swarm belief; a partial one, the mean of its counted
// colonies that ran and matched here, marked "so far". Whole points: swarm
// and market are rounded first, so the gap is their difference as shown.
export function viewOf(m, v) {
  if (!m?.forecasters) return null;
  const fs = m.forecasters;
  const done = fs.map((f) => f.cranked);
  let swarm, partial = false, ran;
  if (m.swarm) {
    swarm = m.swarm;
    ran = fs.filter((f) => f.counted).length;
  } else {
    if (!v?.results) return null;
    const use = fs.map((f, k) => f.counted && f.cranked && !!v.results[k] && v.colonies[k]?.state === "match");
    ran = use.filter(Boolean).length;
    if (!ran) return null;
    const shares = v.results.map((x, k) => (use[k] ? trailShares(x) : null));
    swarm = m.outcomes.map((_, o) => Math.floor(shares.reduce((a, sh) => a + (sh ? sh[o] : 0), 0) / ran));
    partial = true;
  }
  const s = swarm.map(pts), mk = m.odds.map(pts);
  const gap = s.map((x, o) => x - mk[o]);
  // Two outcomes mirror each other, so name the first; otherwise the widest |gap| (lowest index on a tie).
  const lead = m.outcomes.length === 2 ? 0 : gap.reduce((b, g, o) => (Math.abs(g) > Math.abs(gap[b]) ? o : b), 0);
  return {
    done, swarm: s, market: mk, gap, lead, widest: Math.abs(gap[lead]), partial, ran,
    sat: fs.filter((f) => f.cranked && !f.counted).length,
  };
}

// The status pill: [state, text, title]. `v` as in viewOf().
export function statusOf(c, v, now = Date.now()) {
  const { m, rd, req } = c;
  if (req?.phase === "skipped") return ["skipped", "Skipped · fee refunded", "The keepers didn't agree on the odds, so the fee went back to the requester"];
  if (rd?.phase === "skipped") return ["skipped", "Skipped · no keeper quorum", ""];
  if (m?.forecasters && (m.cranked || m.done)) {
    const bad = v?.colonies.some((x) => x.state === "mismatch") || v?.market?.state === "mismatch";
    if (bad) return ["mismatch", "Hash differs", "A colony re-run here doesn't match the chain's hash; the market page shows which"];
    if (m.done) return v ? ["match", "Verified", "Every colony re-run in this browser matches the chain's hashes"] : ["done", "Done", "Re-running the colonies here to check the hashes"];
    return ["running", `${m.cranked} of ${KIND_NAMES.length} colonies`, "Cranked on chain so far; each crank runs one colony"];
  }
  if (m?.forecasters) return ["pending", "Waiting for a crank", "The seed is drawn; each crank runs one colony"];
  if (req) {
    if (req.phase === "odds" || !m) return ["pending", "Waiting for keepers", "The colonies run once two of three keepers agree on the odds"];
    if (req.phase === "forecasting" && now < req.forecast_by_ms) return ["pending", `Agents post until ${utc(req.forecast_by_ms)}`, ""];
    return ["pending", "Waiting for a crank", "The first crank draws the seed"];
  }
  const p = rd?.phase;
  if (p === "posting") return ["pending", Number.isFinite(rd.closeMs) ? `Staking until ${utc(rd.closeMs)}` : "Staking open", ""];
  if (p === "agents") return ["pending", Number.isFinite(rd.publishMs) ? `Agents post until ${utc(rd.publishMs)}` : "Agents posting", ""];
  return ["pending", "Waiting for the seed", rd?.drandRound ? `drand round #${rd.drandRound}` : ""];
}

// When a market's gap appears: after the seed, or once its colonies run if the seed is drawn.
const seedAt = (c) => (c.m?.forecasters ? "once its colonies run"
  : Number.isFinite(c.rd?.publishMs) && c.rd.phase !== "done" ? `after the seed at ${utc(c.rd.publishMs)}` : "after the seed");

// The card's headline: the outcome with the widest |gap| (the first of two).
export function headGapHTML(c, view) {
  if (c.req?.phase === "skipped") return "";
  if (!c.m) return `<small class="fc-card__later">Gap once the keepers post</small>`;
  if (!view) {
    const why = c.m.cranked ? "gap after the re-run here" : c.m.forecasters ? "gap once it runs" : "gap after the seed";
    return `<span class="num fc-card__none">–</span><small>${why}</small>`;
  }
  const o = view.lead;
  return `<span class="num">${sign(view.gap[o])}<small class="fc-card__unit"> pts${view.partial ? " so far" : ""}</small></span><small title="${esc(c.m.outcomes[o])}"><span class="opt" data-opt="${o}">${esc(c.m.outcomes[o])}</span></small>`;
}

// One colony's line under its map: its leader and share, or why it has none.
// `res` is its verified result (or null).
export function leadHTML(c, k, res) {
  const f = c.m?.forecasters?.[k];
  if (!f) return `<span class="fc-cols__wait">${c.m ? "Scouts waiting for the seed" : "Waiting for the keepers"}</span>`;
  if (!f.cranked) return `<span class="fc-cols__wait">○ not cranked yet</span>`;
  if (!f.counted) return `<span class="fc-cols__wait" title="${SITS_LONG[k]}">○ ${SITS[k]}</span>`;
  if (!res) return `<span class="fc-cols__wait">re-running…</span>`;
  const sh = trailShares(res);
  const o = sh.reduce((b, x, i) => (x > sh[b] ? i : b), 0);
  return `<span class="opt" data-opt="${o}">${esc(c.m.outcomes[o])}</span> <span class="num">${pts(sh[o])}</span>`;
}

// The three colonies, a map each. Every map opens the market page on that colony.
export function colsHTML(c, results = []) {
  const q = esc(titleOf(c));
  return `<ul class="fc-cols" aria-label="The three colonies">${KIND_NAMES.map((name, k) =>
    `<li><a href="${c.colHref(k)}" title="${READS[k]}" aria-label="${name} colony for ${q}${c.req ? ", on the request page" : ", on the market page"}"><canvas width="144" height="96" aria-hidden="true"></canvas><b>${name}</b><span class="fc-cols__lead" data-r="lead-${k}">${leadHTML(c, k, results[k] ?? null)}</span></a></li>`).join("")}</ul>`;
}

const isOther = (m, o) => o === m.outcomes.length - 1 && m.outcomes.length > 2 && /^other$/i.test(m.outcomes[o]);

// Design B: Outcome | Market (6h ago → now) | Swarm belief | Gap, whole points.
export function tableHTML(c, view) {
  const m = c.m;
  if (!m) return `<p class="fc-card__later">The keepers haven't posted odds yet. The colonies run once two of three agree.</p>`;
  const two = m.outcomes.length === 2;
  const rows = m.outcomes.map((label, o) => {
    const lbl = isOther(m, o)
      ? `<span class="opt fc-other" data-opt="${o}" title="The keeper keeps the four most likely outcomes and folds the rest into one food source">Other <small>· the rest, folded</small></span>`
      : `<span class="opt" data-opt="${o}">${esc(label)}</span>`;
    const market = `<td class="num"><span class="fc-out-lbl">Market </span><span class="fc-table__move">${pts(m.odds6h[o])} →</span> ${pts(m.odds[o])}${isOther(m, o) && !m.odds[o] ? " <small>(floored)</small>" : ""}</td>`;
    if (!view) return `<tr><th scope="row">${lbl}</th>${market}<td class="num fc-table__none">–</td><td></td></tr>`;
    const g = view.gap[o];
    const gap = two && o === 1
      ? `<span class="fc-table__mirror">mirrors ${esc(m.outcomes[0])}</span>`
      : `<span class="fc-table__gap"><span class="num">${sign(g)}</span><span class="gap-bar" style="--gap: ${Math.max(-50, Math.min(50, g))}" aria-hidden="true"></span></span>`;
    return `<tr><th scope="row">${lbl}</th>${market}<td class="num fc-table__swarm"><span class="fc-out-lbl">Swarm </span>${view.swarm[o]}</td><td>${gap}</td></tr>`;
  }).join("");
  const note = !view ? (m.cranked ? "swarm belief once the re-run here finishes" : `swarm belief ${seedAt(c)}`)
    : view.partial ? `so far: ${view.ran} of ${KIND_NAMES.length} colonies counted`
    : view.sat ? `mean of ${view.ran} colonies, ${view.sat} sat out` : "";
  return `<table class="fc-table">
    <caption${note ? "" : ' class="visually-hidden"'}><span class="visually-hidden">${esc(titleOf(c))}, whole points. </span>${note}</caption>
    <thead><tr><th scope="col">Outcome</th><th scope="col" class="fc-r">Market<small>6h ago → now</small></th><th scope="col" class="fc-r">Swarm<small>belief</small></th><th scope="col">Gap<small>swarm − market</small></th></tr></thead>
    <tbody>${rows}</tbody></table>`;
}

const outcomesLabel = (m) => {
  const o = m.outcomes;
  if (o.length === 2 && /^yes$/i.test(o[0]) && /^no$/i.test(o[1])) return "Yes or No";
  return `${o.length} outcomes${isOther(m, o.length - 1) ? ", Other grouped" : ""}`;
};

// One card. `v` is the market's verification (or null), `widest` whether it
// carries the page's widest gap, `fee` the request fee in $ANTO (a string).
export function cardHTML(c, v, { widest = false, fee = "", now = Date.now() } = {}) {
  const view = viewOf(c.m, v);
  const skipped = c.req?.phase === "skipped";
  const [st, text, title] = statusOf(c, v, now);
  const meta = [
    widest ? `<span class="fc-flag">Widest gap</span>` : "",
    c.mine ? `<span class="fc-yours">yours</span>` : "",
    c.m ? `<span>${outcomesLabel(c.m)}</span>` : `<span>Requested market</span>`,
    c.req ? `<span>requested by <code>${esc(c.req.requester)}</code></span>` : "",
  ].join("");
  // No per-card "Forecast · not advice" tag: the page's sticky line labels every card in view.
  const foot = `<div class="fc-card__foot"><span>Polymarket · <code>${esc(slugOf(c))}</code></span><a href="${c.href}">${c.req ? "Market page: follow the request ›" : "Market page: stake, follow an ant ›"}</a></div>`;
  const body = skipped
    ? `<p class="fc-card__later">The keepers didn't agree on the odds, so the request was skipped and its ${fee ? `${esc(fee)} $ANTO ` : ""}fee refunded.</p>`
    : `<div class="fc-card__body">${colsHTML(c, v?.results ?? [])}<div data-r="table">${tableHTML(c, view)}</div></div>${foot}`;
  return `<li class="fc-card${skipped ? " is-skipped" : ""}${widest ? " is-widest" : ""}" id="${c.id}">
    <div class="fc-card__head">
      <span class="fc-card__n">${esc(c.n)}</span>
      <div class="fc-card__q"><a href="${c.href}">${esc(titleOf(c))}</a><small>${meta}</small></div>
      <span class="fc-card__status" data-r="status">${pill(st, text, title)}</span>
      <div class="fc-card__gap" data-r="gap">${headGapHTML(c, view)}</div>
    </div>
    ${body}
  </li>`;
}

// Repaint the parts of a card that change when its verification lands.
export function cardParts(c, v, now = Date.now()) {
  const view = viewOf(c.m, v);
  const [st, text, title] = statusOf(c, v, now);
  return {
    status: pill(st, text, title),
    gap: headGapHTML(c, view),
    table: tableHTML(c, view),
    leads: KIND_NAMES.map((_, k) => leadHTML(c, k, v?.results?.[k] ?? null)),
  };
}

// ---- the list ----

const widestOf = (c, v) => viewOf(c.m, v)?.widest ?? -1;
// Gap, widest first (markets with no gap yet last, in trending order); or trending rank.
export function sortCards(cards, by, verOf = () => null) {
  const rank = (c) => (c.req ? 1e6 + c.req.id : c.m.index);
  const cmp = by === "rank" ? (a, b) => rank(a) - rank(b)
    : (a, b) => widestOf(b, verOf(b.m)) - widestOf(a, verOf(a.m)) || rank(a) - rank(b);
  return [...cards].sort(cmp);
}

// The widest gap among finished markets: a partial result never headlines the page.
export function widestCard(cards, verOf = () => null) {
  let best = null, w = -1;
  for (const c of cards) {
    const view = viewOf(c.m, verOf(c.m));
    if (view && !view.partial && view.widest > w) { best = c; w = view.widest; }
  }
  return best;
}

// The panel above the list: what and where on the left, the gap and the jump to
// its card on the right edge, like a card's head. `label` names the round when it isn't this one.
export function widestHTML(c, v, { seedLine = "", label = "Widest gap now" } = {}) {
  if (!c) return `<div class="fc-widest__main"><span class="fc-widest__eyebrow">Widest gap</span><span>No gaps yet this round.${seedLine ? ` ${esc(seedLine)}` : ""}</span></div>`;
  const view = viewOf(c.m, v), o = view.lead, m = c.m;
  return `<div class="fc-widest__main">
      <span class="fc-widest__eyebrow">${esc(label)}</span>
      <span class="fc-widest__q">${esc(m.title)}</span>
      <span class="fc-widest__detail"><span class="opt" data-opt="${o}">${esc(m.outcomes[o])}</span> · market <span class="num">${view.market[o]}</span> · swarm belief <span class="num">${view.swarm[o]}</span></span>
    </div>
    <div class="fc-widest__side">
      <span class="fc-widest__gap">${sign(view.gap[o])}<small> pts</small></span>
      <a href="#${c.id}">See its colonies ↓</a>
    </div>`;
}

// ---- the round timeline (the design system's .stepper) ----

export const STEPS = [["posting", "Staking"], ["agents", "Agents post"], ["ready", "Seed"], ["running", "Colonies run"], ["done", "Result"]];

export function stepperStepsHTML(round) {
  const p = round.phase, skipped = p === "skipped";
  const cur = STEPS.findIndex(([k]) => k === p);
  const at = {
    posting: Number.isFinite(round.closeMs) ? `until ${utc(round.closeMs)}` : "",
    agents: Number.isFinite(round.publishMs) ? `until ${utc(round.publishMs)}` : "",
    ready: round.drandRound ? `drand #${round.drandRound}` : "",
    running: "one colony per call",
    done: "",
  };
  return STEPS.map(([key, label], i) => {
    const st = skipped ? (i === 0 ? "skipped" : "next") : p === "done" || i < cur ? "past" : i === cur ? "now" : "next";
    return `<li data-state="${st}"${st === "now" ? ' aria-current="step"' : ""}><b>${st === "skipped" ? "Skipped" : label}</b><span class="stepper__at">${at[key]}</span></li>`;
  }).join("");
}

// What is happening now, one sentence.
export function roundLine(round) {
  const n = round.markets.length;
  return {
    posting: n ? `Keepers have posted the odds. Stake $ANTO on an outcome to feed the Community colony.${round.proposed ? " The markets are final when staking closes." : ""}` : "The keepers have not posted this round's markets yet.",
    agents: "Staking is closed. Agents post their own odds for the Agents colony.",
    ready: `Inputs are frozen. The seed comes from drand${round.drandRound ? ` round #${round.drandRound}` : ""}, published after they froze; the first crank draws it.`,
    running: "The seed is drawn and checked on chain. Each crank runs one colony.",
    done: "Every colony has run. Your browser re-runs them and checks the hashes.",
    skipped: "No quorum of keepers posted by the publish time, so this round was skipped.",
  }[round.phase] ?? "";
}

// ---- track record ----

// `t` is the scorer's output, or null until it has run: { sample: bool,
// from, to (dates), market, swarm (Brier scores), scored, waiting, disputed,
// void, weights: [Momentum, Community, Agents] (the colonies' weights in the
// swarm belief, 1000 each = equal) }.
export const TOO_FEW = 20;

// The contract's score_tally view (docs/FORECAST_QUALITY.md §2) as `t`.
// Brier scores come in 1/10000 of Brier, summed per scored market. `open`
// (optional) is the open_markets view, for the disputed count.
export function trackFromTally(tally, open = null) {
  if (!tally) return null;
  const mean = (s) => (s && s.count ? s.brier_sum / s.count / 10000 : null);
  const src = Object.fromEntries((tally.sources ?? []).map((s) => [s.source, s]));
  return {
    sample: false,
    market: mean(src.market), swarm: mean(src.swarm),
    scored: tally.books, waiting: tally.open?.length ?? 0,
    disputed: (open ?? []).filter((m) => m.resolution?.state === "disputed").length,
    void: tally.fifty_fifty + tally.void,
    weights: tally.colony_weights ?? [1000, 1000, 1000],
    minScored: tally.min_scored ?? TOO_FEW,
  };
}

// One line on how the swarm belief weighs the colonies now.
export function weightsLine(t) {
  const w = t?.weights ?? [1000, 1000, 1000];
  if (w.every((x) => x === w[0])) {
    return `Momentum, Community and Agents weigh the same in the swarm belief until ${t?.minScored ?? TOO_FEW} markets are scored; then each colony's weight follows how much it added beyond the market's own odds.`;
  }
  const names = ["Momentum", "Community", "Agents"];
  return `Weights in the swarm belief, from each colony's record against the market's own odds: ${names.map((n, i) => `${n} ×${(w[i] / 1000).toFixed(2)}`).join(" · ")}.`;
}
export function trackHeadline(t) {
  if (!t || t.scored < TOO_FEW) return `Too few markets to compare yet (${t?.scored ?? 0} scored, ${TOO_FEW} needed).`;
  if (t.market < t.swarm) return "The market's own odds scored better than the swarm.";
  if (t.swarm < t.market) return "The swarm scored better than the market's own odds.";
  return "The swarm and the market's own odds scored the same.";
}

export function trackHTML(t) {
  const enough = t && t.scored >= TOO_FEW;
  const max = enough ? Math.max(t.market, t.swarm, 0.25) : 1;
  const bar = (x) => `<span class="track__bar" style="width: ${((x / max) * 100).toFixed(0)}%"></span>`;
  const counts = t
    ? `${t.scored} scored · ${t.waiting} waiting${t.disputed ? ` (${t.disputed} disputed)` : ""}${t.void ? ` · ${t.void} resolved 50-50, not scored` : ""}`
    : "0 scored";
  return `<h2>Track record${t?.sample ? ` <span class="track__sample">Sample backtest</span>` : ""}</h2>
    <p class="track__head">${trackHeadline(t)}</p>
    ${enough ? `<dl>
      <dt class="track__metric">Brier score, lower is better</dt>
      <dt>Market odds</dt><dd>${t.market.toFixed(3)}</dd><dd>${bar(t.market)}</dd>
      <dt>Swarm belief</dt><dd>${t.swarm.toFixed(3)}</dd><dd>${bar(t.swarm)}</dd>
    </dl>` : ""}
    <p class="track__counts">${counts}</p>
    <p class="track__weights">${weightsLine(t)}</p>
    <p>${t?.sample ? `Markets from ${esc(t.from)} to ${esc(t.to)}, replayed with the round rules. ` : ""}A market is scored once its result is final on chain: the market's odds and the swarm belief, both frozen at the seed, against what happened. Scored as if the trail shares were odds, only to compare them. Disputed and 50-50 markets aren't scored.${t ? "" : " Results aren't posted on chain yet, so nothing is scored."}</p>`;
}

// Under the lists while too few markets are scored: one quiet line, not a
// panel. With TOO_FEW or more, the page shows trackHTML() there instead.
export const trackFull = (t) => !!t && t.scored >= TOO_FEW;
export function trackLineHTML(t) {
  const waiting = t?.waiting ? ` · ${t.waiting} waiting for a result` : "";
  return `<b>Track record:</b> ${t?.scored ?? 0} markets scored so far${waiting}. Each market's odds and its swarm belief are scored against the result once it is final on chain, and the comparison shows here after ${TOO_FEW}. ${weightsLine(t)}`;
}
