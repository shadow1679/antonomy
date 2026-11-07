// One requested forecast, followed from the chain: the market page's view of
// a request (market.html?r=<id>). The lifecycle steps,
// what is next (finalize, crank, an agent's post), Feed Community, the three
// colonies re-run here, the swarm belief with verify, what the colonies read
// and who got paid. market.html imports it only for ?r=; `followRequest(id)`
// fills #market and polls the request until it is over.

import { trailShares } from "../sim/js/antosim.mjs";
import { ColonyView } from "./ds/colony-view.mjs";
import { ColonyThumb } from "./ds/colony-thumb.mjs";
import { GLYPHS, KIND_BLURB, KIND_NAMES } from "./round.mjs";
import { walletHue } from "./ds/staker-ants.mjs";
import {
  CRANK_CALLS, tokens, parseConfig, cranked, isOver, forecastersOf, countedOf, verifyRequest, payoutRows,
  due, agentsMayPost, timeline, SHORT, marketOdds, readOdds, failureOf, stakingOpen, stakesLocked, stakesOf,
} from "./recruit.mjs";
import { slugTitle } from "./roundchain.mjs";
import { chain, wallet, ensureTokens, contractId, yocto } from "./chain.mjs";
import { sendForecast, forecastNote } from "./forecastpost.mjs";
import { createAutoCrank } from "./autocrank.mjs";
import { LIVE_TPS, recruitHref, requestHref } from "./lv.mjs";
import { $, esc, pad4, hashHTML, liveShares, shareBars, beliefBoard, stakerRoster } from "./ui.mjs";

const CONTRACT = contractId();
const POLL_MS = 4000;
const pct = (b) => (b / 100).toFixed(1);
const walletHTML = (id) => `<span class="wallet" style="--wallet-hue: ${walletHue(id)}">${esc(id)}</span>`;
const optHTML = (labels, o) => `<span class="opt" data-opt="${o}">${esc(labels[o])}</span>`;
const mmss = (ms) => { const s = Math.max(0, Math.ceil(ms / 1000)); return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const HTML = `
  <article class="lv-market rq-view" aria-labelledby="run-title">
    <header class="lv-market__head">
      <div>
        <a class="lv-back" id="req-back" href="recruit.html#forecast">← All requests</a>
        <p class="eyebrow">Requested forecast <span class="num" id="req-id"></span> · on its own seed, outside the round</p>
        <h1 id="run-title" tabindex="-1">Reading the request…</h1>
        <p class="lv-meta"><span class="chip" id="req-status">reading the chain</span><span class="rq-view__sub" id="run-sub"></span></p>
      </div>
      <nav class="lv-market__step" aria-label="Other requests" id="req-step"></nav>
    </header>
      <div class="rq-track">
        <ol class="rq-track__steps" id="steps"></ol>
        <p class="rq-track__now" id="now" role="status" aria-live="polite"></p>
      </div>
      <div class="chamber" id="act" hidden style="margin-bottom: var(--space-5)">
        <div class="chamber__header"><h3 class="chamber__title" id="act-title">What is next</h3><span class="eyebrow">anyone can do this</span>
          <label class="text-xs" title="While this tab is open and a wallet is connected, send each finalize and crank as soon as it is due. Your wallet still approves every call; the keeper daemon makes the same calls."><input type="checkbox" id="req-auto"> Auto-crank this request</label></div>
        <div id="act-body"></div>
        <div id="agent-box"></div>
        <div id="posts-box"></div>
        <p class="text-sm" id="tx-run" role="status" aria-live="polite" style="margin: var(--space-3) 0 0"></p>
      </div>
      <div class="chamber" id="stake-card" hidden style="margin-bottom: var(--space-5)">
        <div class="chamber__header"><h3 class="chamber__title">Feed Community</h3><span class="eyebrow" id="stake-when">holders</span></div>
        <div id="stake-body"></div>
        <p class="text-sm" id="tx-stake" role="status" aria-live="polite" style="margin: var(--space-3) 0 0"></p>
      </div>
      <div class="rq-stage">
        <div class="chamber rq-colony" id="colony">
          <div class="rq-thumbs" id="thumbs" role="group" aria-label="The three colonies: pick one to show it large"></div>
          <div class="rq-colony__head">
            <h3 id="col-name">Three colonies</h3>
            <span class="chip" id="col-vote" hidden></span>
            <span class="rq-colony__by" id="col-by"></span>
            <p id="col-blurb"></p>
          </div>
          <div class="sim-frame">
            <canvas width="1440" height="960" id="col-canvas" aria-label="The selected colony's map"></canvas>
            <div class="sim-frame__hud"><span class="sim-frame__tick">tick <strong id="col-tick">0000</strong>/<span id="col-ticks">0300</span></span></div>
            <p class="rq-colony__empty" id="col-empty">Waiting for the first crank.</p>
          </div>
          <div class="cluster" style="margin-top: var(--space-3)"><button class="btn btn--sm btn--ghost" type="button" id="col-replay" hidden>Replay this colony</button><a class="btn btn--sm btn--ghost" id="col-open" hidden>Follow its ants in History ↗</a></div>
          <ul class="share-bars" id="col-bars"></ul>
          <div id="col-roster-box" hidden style="margin-top: var(--space-4)">
            <p class="text-xs text-faint" id="col-roster-note" style="margin: 0 0 var(--space-2)"></p>
            <div id="col-roster"></div>
          </div>
        </div>
        <div class="chamber" id="belief-card">
          <div class="chamber__header">
            <h3 class="chamber__title">Swarm belief</h3>
            <span class="tag-forecast">Forecast · not advice</span>
          </div>
          <div id="belief-body"><p class="text-sm text-muted" style="margin: 0">Appears once the keepers' odds are on chain.</p></div>
        </div>
      </div>
      <div class="rq-after" id="inputs" hidden>
        <div class="chamber">
          <div class="chamber__header"><h3 class="chamber__title">What the colonies read</h3><a class="what" href="docs.html#forecasters">The three forecasters</a></div>
          <div class="table-wrap">
            <table class="table" id="inputs-table">
              <caption>Posted odds, %, as stored on chain. Momentum reads the keepers' odds and their six-hour move; Agents reads the agents' median.</caption>
              <thead></thead>
              <tbody></tbody>
            </table>
          </div>
        </div>
        <div class="chamber">
          <div class="chamber__header"><h3 class="chamber__title">Who got paid</h3><span class="eyebrow">from the fee</span></div>
          <div class="table-wrap">
            <table class="table" id="paid"><caption>$ANTO, for work done. Nobody is paid for being right.</caption><tbody></tbody></table>
          </div>
        </div>
      </div>
  </article>`;

$("market").innerHTML = HTML;
$("req-back").href = recruitHref("#forecast");

// cfg: parseConfig(request_config); keepers and quorum: the allow-list.
const state = { cfg: null, keepers: [], quorum: 1, balance: null, isAgent: false };
// cur: the request being followed. built[k]: colony k re-run in this browser.
let cur = null, built = [], pollTimer = 0, lastSig = "", replay = null;

const showError = (el, e) => {
  el.dataset.state = "bad";
  el.innerHTML = `<span class="notice notice--danger" style="display: inline-block; padding: var(--space-2) var(--space-3)"><strong>Failed:</strong> ${esc(e.message || e)}</span>`;
};
const showNote = (el, html) => { el.dataset.state = ""; el.innerHTML = html; };

// ---- The wallet, and sending ----

async function loadWallet() {
  const a = wallet.accountId;
  state.balance = null; state.isAgent = false;
  if (a) {
    try { [state.balance, state.isAgent] = await Promise.all([chain.balance(a), chain.isAgent(a)]); } catch { /* shown as unknown */ }
  }
  if (cur?.r) { lastSig = ""; renderAct(); stakeSig = ""; renderStake(cur.r); }
}

async function until(test, ms = 30_000, step = 1500) {
  const end = Date.now() + ms;
  for (;;) {
    const v = await test().catch(() => null);
    if (v) return v;
    if (Date.now() > end) return null;
    await sleep(step);
  }
}

async function send(method, args, opts) {
  const out = await wallet.call(method, args, opts);
  const f = failureOf(out);
  if (f) throw new Error(f);
  return out;
}

const AUTO_GAS = { finalize_request_odds: 30, crank_request: 100 };
const auto = createAutoCrank({
  next: () => {
    const step = wallet.accountId && cur?.r && !isOver(cur.r) ? due(cur.r, Date.now(), state.keepers) : null;
    return step in AUTO_GAS ? { method: step, args: { request_id: cur.r.id }, gasTgas: AUTO_GAS[step], label: step.replace(/_/g, " ") } : null;
  },
  send: (s) => send(s.method, s.args, { gasTgas: s.gasTgas }),
  refresh: () => refresh(),
  say: (t) => showNote($("tx-run"), t),
  wait: sleep,
});
$("req-auto").addEventListener("change", async (e) => {
  if (e.target.checked && !wallet.accountId) {
    e.target.checked = false;
    try { await wallet.connect(); } catch (err) { showError($("tx-run"), err); }
    return;
  }
  await auto.set(e.target.checked);
  e.target.checked = auto.on;
});

async function registerAgent(me) {
  if (await ensureTokens(me)) await until(async () => (await chain.balance(me)) > 0n, 20_000);
  const bal = await chain.balance(me);
  if (bal < state.cfg.agentDeposit) throw new Error(`the deposit is ${tokens(state.cfg.agentDeposit)} $ANTO and you have ${tokens(bal)}`);
  await send("register_agent", {}, { gasTgas: 30 });
  await until(async () => (await chain.isAgent(me)) || null, 15_000);
  await loadWallet();
}

async function unregisterAgent(me) {
  await send("unregister_agent", {}, { gasTgas: 30 });
  await until(async () => !(await chain.isAgent(me)) || null, 15_000);
  await loadWallet();
}

// ---- The colonies: one large, all three as thumbnails ----

$("thumbs").innerHTML = KIND_NAMES.map((name, k) =>
  `<button class="rq-thumb" type="button" data-k="${k}" aria-pressed="false" disabled>` +
  `<canvas width="216" height="144" aria-hidden="true"></canvas><b>${name}</b><span data-r="state">crank ${k + 1}</span></button>`).join("");
const thumbs = [...$("thumbs").children].map((btn) => ({
  btn, state: btn.querySelector('[data-r="state"]'),
  view: new ColonyThumb(btn.querySelector("canvas"), { glyphs: GLYPHS }),
}));
const stage = { view: new ColonyView($("col-canvas"), { labels: [], glyphs: GLYPHS }), k: -1, col: null, busy: false, bars: null };
const colRoster = stakerRoster($("col-roster"), (w) => { stage.view.spotlight = w; stage.busy = true; });
stage.view.selected = -1; // no ant followed here

const SITS_OUT = ["", "Nobody staked on this request during the agents' window, so it sits out of the swarm belief.", "No agent posted, so it sits out of the swarm belief."];

function thumbState(k) {
  const t = thumbs[k], b = built[k], r = cur?.r;
  t.btn.disabled = !b;
  t.btn.dataset.state = b ? "done" : "";
  if (!b) { t.state.textContent = r?.phase === "skipped" ? "skipped" : `crank ${k + 1}`; return; }
  const sh = trailShares(b.res), w = b.res.winner_option, out = countedOf(r)[k] ? "" : " · out";
  t.state.innerHTML = `${b.match ? "✓" : "✗"} ${optHTML(r.market.outcomes, w)} ${pct(sh[w])}%${out}`;
}

// Colony k re-run in this browser once the chain has its hash: fast-forward
// to the last tick, keep the result and whether its hash matches the chain's.
function buildColony(r, k, fs) {
  const col = fs[k].make();
  thumbs[k].view.setStakers(fs[k].stakers);
  thumbs[k].view.attach(col);
  while (col.step()) thumbs[k].view.afterStep();
  const res = col.result();
  built[k] = { res, match: res.hash === r.colony_hashes[k] };
  thumbs[k].view.draw(1);
  thumbState(k);
}

function showColony(k) {
  const r = cur.r, f = cur.fs[k];
  stage.k = k; replay = null;
  thumbs.forEach((t, j) => t.btn.setAttribute("aria-pressed", String(j === k)));
  $("col-name").textContent = f.name;
  const counted = countedOf(r)[k];
  $("col-blurb").textContent = `${KIND_BLURB[k]} ${counted ? "" : SITS_OUT[k]}`;
  $("col-by").innerHTML = r.crankers[k] ? `cranked by ${walletHTML(r.crankers[k])}` : "";
  $("col-vote").hidden = false;
  $("col-vote").textContent = counted ? "votes" : "sits out";
  $("col-empty").hidden = true;
  $("col-replay").hidden = false;
  $("col-open").hidden = false;
  $("col-open").href = `replay.html?request=${r.id}&colony=${encodeURIComponent(f.key)}`;
  // Staker ants on Community, agent ants on Agents: tinted on the map, with a
  // roster that lights up one wallet's or agent's ants.
  stage.view.setStakers(f.stakers);
  $("col-roster-box").hidden = !f.stakers?.total;
  $("col-roster-note").innerHTML = f.stakers?.kind === "agent"
    ? "Each agent's ants hatch in its colour, an equal share each, since the median weighs every post the same. Hover an agent to light up its ants."
    : "Each wallet's stake on this request spawns ants in its colour. Hover a wallet to light up its ants.";
  colRoster(f.stakers, r.market.outcomes);
  const c = f.make();
  stage.view.attach(c);
  while (c.step()) stage.view.afterStep(false);
  stage.col = c;
  stage.view.labels = r.market.outcomes;
  stage.bars = shareBars($("col-bars"), r.market.outcomes);
  stage.bars(trailShares(built[k].res).map((x) => x / 100), built[k].res.winner_option);
  $("col-ticks").textContent = pad4(c.ticks);
  $("col-tick").textContent = pad4(c.t);
  stage.busy = true;
}

$("thumbs").addEventListener("click", (e) => {
  const b = e.target.closest(".rq-thumb");
  if (b && !b.disabled) showColony(+b.dataset.k);
});

$("col-replay").addEventListener("click", () => {
  if (stage.k < 0) return;
  const c = cur.fs[stage.k].make();
  stage.view.attach(c);
  stage.col = c;
  stage.bars(new Array(cur.r.market.outcomes.length).fill(0));
  replay = { started: performance.now(), frac: 1 };
  $("col-tick").textContent = pad4(0);
  stage.busy = true;
});

function frame(now) {
  requestAnimationFrame(frame);
  if (!replay || stage.k < 0 || !stage.col) {
    if (stage.busy && stage.col) stage.busy = stage.view.draw(1, now);
    return;
  }
  const c = stage.col, exact = Math.min(c.ticks, ((now - replay.started) / 1000) * LIVE_TPS), target = Math.floor(exact);
  if (c.t < target) {
    while (c.t < target) { c.step(); stage.view.afterStep(true); }
    stage.bars(liveShares(c).pct);
    $("col-tick").textContent = pad4(c.t);
  }
  replay.frac = c.t < c.ticks ? exact - target : 1;
  const busy = stage.view.draw(replay.frac, now);
  if (c.t === c.ticks) {
    const res = c.result();
    stage.bars(trailShares(res).map((x) => x / 100), res.winner_option);
    if (!busy) replay = null;
  }
}

// ---- Following one request ----

function liveSwarm(r) {
  const n = r.market.outcomes.length, counted = countedOf(r);
  const sh = built.map((b, j) => (b && counted[j] ? trailShares(b.res) : null)).filter(Boolean);
  if (!sh.length) return new Array(n).fill(0);
  return Array.from({ length: n }, (_, o) => Math.round(sh.reduce((a, s) => a + s[o], 0) / sh.length));
}

const STATUS = { odds: "keepers posting", forecasting: "agents posting", running: "cranking", done: "✓ done", skipped: "skipped · refunded" };

function renderBelief(r) {
  const labels = r.market?.outcomes;
  if (!labels) return;
  const key = `${r.id}:${labels.join("|")}`;
  if (cur.beliefKey !== key) {
    cur.beliefKey = key;
    $("belief-body").innerHTML = `<ul class="belief" id="belief"></ul>
      <div class="cluster" style="justify-content: space-between; margin-top: var(--space-5)">
        <ul class="belief-key"><li class="belief-key__swarm">swarm belief</li><li class="belief-key__market">market odds on chain</li></ul>
        <span class="chip" id="belief-status"></span>
      </div>
      <div id="result" style="margin-top: var(--space-4)"></div>`;
    cur.board = beliefBoard($("belief"), labels, r.market.odds);
    cur.board(labels.map(() => 0));
  }
  const done = r.phase === "done";
  cur.board(done ? r.swarm : liveSwarm(r));
  $("belief-status").textContent = done ? "✓ final, from the chain" : cranked(r) ? `${cranked(r)} of ${CRANK_CALLS} colonies` : `0 of ${CRANK_CALLS} colonies`;
}

function renderResult(r) {
  const el = $("result");
  if (!el) return;
  if (r.phase !== "done") { el.innerHTML = ""; cur.resultKey = ""; return; }
  if (cur.resultKey === "done") return;
  cur.resultKey = "done";
  el.innerHTML = `<dl class="kv"><dt>Market hash</dt><dd>${hashHTML(r.market_hash, "market hash")}</dd><dt>Seed</dt><dd>${hashHTML(r.seed, "request seed")}</dd></dl>
    <div class="verify-panel__result" style="margin-top: var(--space-4)"><button class="btn btn--sm" type="button" id="verify">Verify from seed</button>
    <span class="verify-badge" data-state="idle" id="badge" role="status" aria-live="polite">Not verified</span></div>
    <p class="text-xs text-faint" style="margin: var(--space-4) 0 0">Verify re-runs all three colonies here from the seed and the odds on chain, and compares each colony hash, the market hash and the swarm belief with the contract's. The seed is the NEAR block's random seed at the first crank, a stand-in for the drand round. Pick any colony above the map to see it again.</p>`;
  $("verify").addEventListener("click", () => {
    const b = $("badge"), id = cur.r.id;
    b.dataset.state = "pending";
    b.textContent = "Re-running three colonies…";
    setTimeout(() => {
      const v = verifyRequest(cur.r);
      if (cur.r.id !== id) return;
      b.dataset.state = v.ok ? "match" : "mismatch";
      b.textContent = v.ok ? "Match: all colony hashes, the market hash and the swarm belief" : `Mismatch: ${[
        ...v.colonies.filter((c) => !c.match).map((c) => `${c.name} hash`),
        ...(v.market && !v.market.match ? ["market hash"] : []), ...(v.swarm === false ? ["swarm belief"] : []),
        ...(!v.oddsHash ? ["odds snapshot hash"] : []), ...(!v.agentsHash ? ["agent snapshot hash"] : []),
      ].join(", ")}`;
    }, 30);
  });
}

function renderInputs(r) {
  const m = r.market;
  $("inputs").hidden = !m;
  if (!m) return;
  const labels = m.outcomes;
  const head = `<tr><th scope="col">Posted by</th>${labels.map((_, o) => `<th scope="col" class="num">${optHTML(labels, o)}</th>`).join("")}</tr>`;
  const line = (who, xs) => `<tr><th scope="row">${who}</th>${xs.map((x) => `<td class="num">${pct(x)}</td>`).join("")}</tr>`;
  const kept = m.raw_hashes.map(([k, h]) =>
    `<tr><th scope="row">${walletHTML(k)}</th><td colspan="${labels.length}" class="text-xs">raw Polymarket response hash ${hashHTML(h, "keeper raw hash")}</td></tr>`).join("");
  const ags = r.agents ?? cur.preview;
  const agentRows = ags?.posts?.length
    ? ags.posts.map(([id, odds]) => line(walletHTML(id), odds)).join("") + line(`<b>Agents colony</b> · agent median${r.agents ? "" : " so far"}`, ags.odds)
    : `<tr><th scope="row"><b>Agents colony</b></th><td colspan="${labels.length}" class="text-xs text-faint">${r.phase === "forecasting" ? "no agent has posted yet" : "no agent posted: an even map, zero snapshot hash"}</td></tr>`;
  $("inputs-table").querySelector("thead").innerHTML = head;
  $("inputs-table").querySelector("tbody").innerHTML = kept +
    line("<b>Market odds</b> · keeper median", m.odds) + line("<b>Six hours earlier</b> · keeper median", m.odds_6h) + agentRows +
    `<tr><th scope="row">Odds snapshot hash</th><td colspan="${labels.length}">${hashHTML(m.odds_hash, "odds snapshot hash")}</td></tr>`;
}

const ROLE = { keeper: "Keeper", agent: "Agent", cranker: "Cranker", treasury: "Treasury", refund: "Refunded to requester" };
function renderPaid(r) {
  const rows = payoutRows(r), tb = $("paid").querySelector("tbody");
  if (!rows.length) { tb.innerHTML = `<tr><td colspan="3" class="text-xs text-faint">Paid once the third colony is cranked.</td></tr>`; return; }
  const by = new Map();
  for (const p of rows) {
    const key = p.role === "treasury" ? "treasury" : `${p.role} ${p.account}`;
    const e = by.get(key) ?? { ...p, amount: 0n, calls: 0 };
    e.amount += p.amount; e.calls += p.role === "cranker" ? 1 : 0;
    by.set(key, e);
  }
  const total = rows.reduce((a, p) => a + p.amount, 0n);
  tb.innerHTML = [...by.values()].map((e) => `<tr><th scope="row">${ROLE[e.role]}${e.calls ? ` · ${e.calls} call${e.calls === 1 ? "" : "s"}` : ""}</th>` +
    `<td>${e.account ? walletHTML(e.account) : "treasury"}</td><td class="num">${tokens(e.amount, 4)}</td></tr>`).join("") +
    `<tr><th scope="row">Total</th><td></td><td class="num"><b>${tokens(total)}</b></td></tr>`;
}

function renderSteps(r) {
  const list = timeline(r, state.cfg, Date.now());
  const sig = list.map((s) => s.state).join(",") + r.keepers_posted.length + r.crankers.join();
  if (sig === cur.stepsSig) return;
  cur.stepsSig = sig;
  const at = Math.max(0, list.findIndex((s) => s.state === "now"));
  $("steps").innerHTML = list.map((s) =>
    `<li data-state="${s.state}" title="${esc(`${s.title}: ${s.text}`)}">` +
    `<span class="rq-track__dot" aria-hidden="true"></span><span>${esc(SHORT[s.key] ?? s.title.replace(/^Crank \d+: /, ""))}</span></li>`).join("");
  const strip = $("steps"), c = strip.children[Math.min(at, list.length - 1)];
  if (c) strip.scrollLeft = c.offsetLeft - (strip.clientWidth - c.offsetWidth) / 2;
}

// The line under the steps, with a live countdown.
function renderNow() {
  if (!cur) return;
  const r = cur.r, now = Date.now(), n = cranked(r);
  let t;
  if (r.phase === "odds") {
    const k = state.keepers.length;
    t = `<b>Waiting for the keepers.</b> ${r.keepers_posted.length} of ${k} keeper${k === 1 ? "" : "s"} posted${r.keepers_posted.length ? "" : " yet"}. The odds are accepted once every keeper has posted or the window closes (${mmss(r.odds_by_ms - now)} left); if too few agree, the request is skipped and refunded.`;
  } else if (r.phase === "forecasting") {
    t = now < r.forecast_by_ms
      ? `<b>Agents' window is open.</b> Registered agents can post their own odds for ${mmss(r.forecast_by_ms - now)} more. The odds are final: ${r.market.outcomes.map((o, i) => `${esc(o)} ${pct(r.market.odds[i])}%`).join(", ")}.`
      : `<b>The window has closed.</b> Next: crank 1 of ${CRANK_CALLS} draws the seed and runs the ${KIND_NAMES[0]} colony.`;
  } else if (r.phase === "running") {
    t = `<b>${n} of ${CRANK_CALLS} colonies have run.</b> Next: crank ${n + 1}, the ${KIND_NAMES[n]} colony.`;
  } else if (r.phase === "done") {
    t = `<b>Done.</b> All three colonies have run on the contract and the swarm belief is stored.`;
  } else {
    t = `<b>Skipped.</b> Too few keepers agreed on this market, so nothing ran. The ${tokens(r.fee)} $ANTO fee went back to ${walletHTML(r.requester)}.`;
  }
  $("now").innerHTML = t;
}

// ---- What is next: finalize, crank, agent form ----

function actionBtn(id, label) { return `<button class="btn btn--primary" type="button" id="${id}">${label}</button>`; }

async function act(el, label, fn, out = $("tx-run")) {
  el.disabled = true;
  try {
    showNote(out, `${label}: approve it in your wallet…`);
    const said = await fn();
    showNote(out, typeof said === "string" ? said : `${label}: sent.`);
    await refresh();
    for (let i = 0; i < 3; i++) { await sleep(2500); await refresh(); }
  } catch (e) {
    showError(out, e);
  } finally {
    el.disabled = false;
  }
}

function renderAct() {
  const r = cur.r, me = wallet.accountId, now = Date.now();
  const step = due(r, now, state.keepers);
  const mayPost = agentsMayPost(r, now);
  const sig = [r.id, r.phase, cranked(r), step, mayPost, me, state.isAgent, r.market?.outcomes.join("|")].join("~");
  $("act").hidden = isOver(r);
  if (isOver(r) || sig === lastSig) return;
  lastSig = sig;
  const body = [];
  if (step === "finalize_request_odds") {
    body.push(`<p class="text-sm">The keepers' window is over (or every keeper has posted). Anyone can accept the odds. The keeper daemon does this too.</p>${me ? actionBtn("do-final", "Finalize the odds") : connectLine()}`);
  } else if (step === "crank_request") {
    const n = cranked(r);
    body.push(`<p class="text-sm"><b>Crank ${n + 1} of ${CRANK_CALLS}:</b> runs the ${KIND_NAMES[n]} colony on the contract${n === 0 ? " and draws the seed" : ""}, and pays the cranker ${tokens(state.cfg.crankBounty)} $ANTO from the fee. The keeper daemon cranks too; the first call to land wins.</p>${me ? actionBtn("do-crank", `Crank ${n + 1}: ${KIND_NAMES[n]}`) : connectLine()}`);
  } else if (r.phase === "odds") {
    body.push(`<p class="text-sm text-muted">Nothing to do yet: keepers are allow-listed accounts. Once the odds are final, registered agents can post theirs.</p>`);
  } else if (mayPost) {
    body.push(`<p class="text-sm text-muted">The agents' window is open. The crank calls begin when it closes.</p>`);
  }
  $("act-body").innerHTML = body.join("");
  $("act-title").textContent = step === "finalize_request_odds" ? "Finalize the odds" : step === "crank_request" ? "Crank the colonies" : r.phase === "forecasting" ? "Post your forecast" : "What is next";
  $("do-final")?.addEventListener("click", (e) => act(e.target, "Finalize", () => send("finalize_request_odds", { request_id: r.id }, { gasTgas: 30 })));
  $("do-crank")?.addEventListener("click", (e) => act(e.target, "Crank", () => send("crank_request", { request_id: r.id }, { gasTgas: 100 })));
  renderAgentBox(r, mayPost);
  $("act").hidden = !body.length && !$("agent-box").innerHTML;
}

const connectLine = () => `<p class="text-sm text-faint">Connect a wallet (top right) to do this yourself.</p>`;

function renderAgentBox(r, mayPost) {
  const box = $("agent-box"), me = wallet.accountId;
  if (r.phase !== "forecasting" || !mayPost) { box.innerHTML = ""; return; }
  const labels = r.market.outcomes;
  if (!me) { box.innerHTML = `<h4 style="margin: var(--space-4) 0 var(--space-2)">Post your own odds</h4><p class="text-sm text-muted">Forecaster agents post their own odds into the Agents colony. Connect a wallet to register as one (a ${tokens(state.cfg.agentDeposit)} $ANTO refundable deposit), or use <a href="docs.html#recruit-tool">the agent tool</a>.</p>`; return; }
  if (!state.isAgent) {
    box.innerHTML = `<h4 style="margin: var(--space-4) 0 var(--space-2)">Post your own odds</h4>
      <p class="text-sm text-muted">Only registered agents' posts reach the Agents colony. Registering locks a ${tokens(state.cfg.agentDeposit)} $ANTO deposit, refundable when you unregister. Posting on time earns a share of the agents' pool; being right earns nothing. <a class="what" href="docs.html#agents-colony">Agents colony</a></p>
      <div class="cluster">${actionBtn("do-reg", `Register as an agent (${tokens(state.cfg.agentDeposit)} $ANTO)`)}</div>`;
    $("do-reg").addEventListener("click", (e) => act(e.target, "Register", () => registerAgent(me)));
    return;
  }
  const mine = (cur.preview?.posts ?? []).find(([id]) => id === me);
  box.innerHTML = `<h4 style="margin: var(--space-4) 0 var(--space-2)">Post your own odds as ${walletHTML(me)}</h4>
    <p class="text-sm text-muted" style="margin: 0 0 var(--space-3)">${mine ? `You posted ${labels.map((o, i) => `${esc(o)} ${pct(mine[1][i])}%`).join(", ")}. Posting again replaces it.` : "Percent per outcome, adding up to 100. Your own model decides; the Agents colony reads the agents' median."}</p>
    <div class="mine-grid" id="mine-grid">${labels.map((o, i) =>
      `<div class="field"><label class="field__label" for="mine-${i}">${optHTML(labels, i)}</label>` +
      `<div class="input-group"><input class="input num" id="mine-${i}" type="number" inputmode="decimal" min="0" max="100" step="0.1" placeholder="–" value="${mine ? mine[1][i] / 100 : ""}">` +
      `<span class="input-group__suffix">%</span></div></div>`).join("")}</div>
    <div class="cluster" style="margin-top: var(--space-3)">
      <button class="btn btn--sm btn--ghost" type="button" id="mine-fill">Start from the market odds</button>
      ${actionBtn("do-post", "Post my forecast")}
      <button class="btn btn--sm btn--ghost" type="button" id="do-unreg">Unregister (refund deposit)</button>
      <span class="mine-sum" id="mine-status" role="status" aria-live="polite"></span>
    </div>`;
  const inputs = () => [...$("mine-grid").querySelectorAll("input")];
  const check = () => {
    const x = readOdds(inputs().map((i) => i.value)), s = $("mine-status");
    s.dataset.state = x.why ? "bad" : x.odds ? "ok" : "";
    s.textContent = x.why ? `! Can't post: ${x.why}.` : x.odds ? "✓ Adds up to 100%." : "";
    $("do-post").disabled = !x.odds;
    return x;
  };
  $("mine-grid").addEventListener("input", check);
  $("mine-fill").addEventListener("click", () => {
    const o = marketOdds(r.market.odds);
    inputs().forEach((x, i) => { x.value = (o[i] / 100).toFixed(2).replace(/\.?0+$/, ""); });
    check();
  });
  $("do-post").addEventListener("click", (e) => {
    const { odds } = check();
    // Commit while the window hides posts, reveal in its last third.
    if (odds) {
      act(e.target, "Forecast", async () => forecastNote(await sendForecast({
        colony: r.colony, odds, account: me, send: (m, a) => send(m, a, { gasTgas: 30 }),
      })));
    }
  });
  $("do-unreg").addEventListener("click", (e) => act(e.target, "Unregister", () => unregisterAgent(me)));
  check();
}

// ---- Feed Community: holders stake on the request's colony ----

let stakeSig = "";
async function renderStake(r) {
  const card = $("stake-card"), me = wallet.accountId, now = Date.now();
  const m = r.market, open = stakingOpen(r, now), locked = stakesLocked(r, now);
  if (!m) { card.hidden = true; return; }
  const n = m.outcomes.length, labels = m.outcomes;
  let totals = new Array(n).fill(0n), mine = [];
  try {
    const [t, s] = await Promise.all([
      chain.stakeTotals(r.colony, n),
      me ? chain.stakesOf(me) : Promise.resolve([]),
    ]);
    totals = t.map(BigInt);
    mine = s.filter(([c]) => c === r.colony).map(([, o, v]) => ({ option: o, amount: BigInt(v) }));
  } catch { /* shown as nothing staked */ }
  if (!cur || cur.r !== r) return;
  const frozen = r.stakes ? stakesOf(r) : null;
  // Nothing to show once the request is over and nobody (or not you) staked.
  card.hidden = !open && !locked && !mine.length && !frozen?.wallets.length;
  if (card.hidden) return;
  const sig = JSON.stringify([r.id, r.phase, open, locked, me, totals.map(String), mine.map((x) => [x.option, String(x.amount)]), frozen?.weights]);
  if (sig === stakeSig) return;
  stakeSig = sig;
  $("stake-when").textContent = open ? `open for ${mmss(r.forecast_by_ms - now)}` : locked ? "locked while the colonies run" : "closed";
  const staked = totals.some((t) => t > 0n);
  const totalLine = staked
    ? `<p class="text-sm" style="margin: 0 0 var(--space-3)">Staked so far: ${labels.map((o, i) => `${optHTML(labels, i)} <b class="num">${tokens(totals[i])}</b>`).join(" · ")} $ANTO.</p>`
    : `<p class="text-sm text-faint" style="margin: 0 0 var(--space-3)">${open ? "Nobody has staked yet: without stakes Community sits out of the swarm belief." : "Nobody staked: Community ran on an even map and sat out of the swarm belief."}</p>`;
  const frozenLine = frozen
    ? `<p class="text-xs text-muted" style="margin: 0 0 var(--space-3)">Frozen at the seed: weights ${frozen.weights.map((w, i) => `${optHTML(labels, i)} ${(w / 1000).toFixed(2)}`).join(" · ")} sqrt-$ANTO from ${frozen.wallets.length} wallet${frozen.wallets.length === 1 ? "" : "s"}${frozen.wallets.length ? `: ${frozen.wallets.map((w) => walletHTML(w.id)).join(" ")}` : ""}. Stake hash ${hashHTML(r.stakes.hash, "stake hash")}</p>`
    : "";
  const intro = `<p class="text-sm text-muted" style="margin: 0 0 var(--space-3)">Holders stake $ANTO on an outcome while the agents' window is open. Community reads the square root of each wallet's stake, so every wallet's ants feed it. Stakes are locked until the third colony has run, then you withdraw them. Nothing pays you for being right. <a class="what" href="docs.html#stakes">How stakes work</a></p>`;
  const mineList = mine.length ? `<ul aria-label="Your stakes on this request" style="list-style: none; padding: 0; margin: var(--space-3) 0 0; display: grid; gap: var(--space-2)">${mine.map((x) =>
    `<li class="cluster">${optHTML(labels, x.option)} <span class="num">${tokens(x.amount)} $ANTO</span>${locked ? "" :
      `<button class="btn btn--sm btn--ghost" type="button" data-unstake="${x.option}" data-amt="${x.amount}">Withdraw</button>`}</li>`).join("")}</ul>` : "";
  let form = "";
  if (open && !me) form = connectLine();
  else if (open) form = `<div class="cluster">
      <div class="field"><label class="field__label" for="st-opt">Outcome</label>
        <select class="input" id="st-opt">${labels.map((o, i) => `<option value="${i}">${GLYPHS[i]} ${esc(o)}</option>`).join("")}</select></div>
      <div class="field"><label class="field__label" for="st-amt">$ANTO</label>
        <input class="input num" id="st-amt" type="number" min="1" step="1" value="10"></div>
      ${actionBtn("do-stake", "Stake on this request")}</div>`;
  const keep = [$("st-opt")?.value, $("st-amt")?.value];
  $("stake-body").innerHTML = (open ? intro : "") + totalLine + frozenLine + form + mineList;
  if (keep[0] != null && $("st-opt")) { $("st-opt").value = keep[0]; $("st-amt").value = keep[1]; }
  $("do-stake")?.addEventListener("click", (e) => stakeAct(e.target, "Stake", async () => {
    const amt = +$("st-amt").value, opt = +$("st-opt").value;
    if (!(amt > 0)) throw new Error("enter an amount above zero");
    if (await ensureTokens(me)) await until(async () => (await chain.balance(me)) > 0n, 20_000);
    await send("stake", { colony: r.colony, option: opt, amount: yocto(amt) }, { gasTgas: 30 });
  }));
  $("stake-body").querySelectorAll("[data-unstake]").forEach((b) => b.addEventListener("click", (e) =>
    stakeAct(e.target, "Withdraw", () => send("unstake", { colony: r.colony, option: +b.dataset.unstake, amount: b.dataset.amt }, { gasTgas: 30 }))));
}

async function stakeAct(el, label, fn) {
  const out = $("tx-stake");
  el.disabled = true;
  try {
    showNote(out, `${label}: approve it in your wallet…`);
    await fn();
    showNote(out, `${label}: sent.`);
    stakeSig = "";
    await sleep(2500);
    if (cur?.r) await renderStake(cur.r);
    await loadWallet();
  } catch (e) {
    showError(out, e);
  } finally {
    el.disabled = false;
  }
}

function renderPosts(r) {
  const ags = r.agents ?? cur.preview;
  const box = $("posts-box");
  if (r.phase !== "forecasting" || !ags) { box.innerHTML = ""; return; }
  box.innerHTML = `<p class="text-xs text-faint" style="margin: var(--space-4) 0 0">${ags.posts.length
    ? `${ags.posts.length} agent${ags.posts.length === 1 ? "" : "s"} posted so far: ${ags.posts.map(([id]) => walletHTML(id)).join(" ")}`
    : "No agent has posted yet."}</p>`;
}

// ---- The request, from the chain ----

async function refresh() {
  if (!cur) return;
  const id = cur.id;
  let r;
  try { r = await chain.request(id); } catch (e) { showError($("tx-run"), e); return; }
  if (!cur || cur.id !== id) return;
  if (!r) {
    $("req-status").textContent = "not found";
    $("run-title").textContent = `Request #${id}`;
    $("run-sub").innerHTML = `There is no request #${id} on <code>${esc(CONTRACT)}</code>. <a href="${esc(recruitHref("#forecast"))}">See every request</a>.`;
    $("act").hidden = true; $("steps").innerHTML = ""; $("now").textContent = "";
    clearTimeout(pollTimer);
    return;
  }
  cur.preview = null;
  if (r.phase === "forecasting" && !r.agents) {
    try { cur.preview = await chain.agentSnapshot(r.colony); } catch { /* shown without the preview */ }
  }
  if (!cur || cur.id !== id) return;
  cur.r = r;
  const sig = JSON.stringify([r.phase, r.colony_hashes, r.keepers_posted, r.swarm, cur.preview?.posts]);
  const changed = sig !== cur.sig;
  cur.sig = sig;
  $("req-status").textContent = STATUS[r.phase] ?? r.phase;
  $("run-title").textContent = slugTitle(r.market_id);
  document.title = `Antonomy · request #${r.id} · ${slugTitle(r.market_id)}`;
  $("run-sub").innerHTML = `<span>Polymarket event <code>${esc(r.market_id)}</code></span><span>requested by ${walletHTML(r.requester)}</span><span>fee ${tokens(r.fee)} $ANTO</span><span>colony <code>${r.colony}</code></span>`;
  renderSteps(r);
  renderNow();
  if (changed) {
    // Colonies the chain has run, re-run here.
    if (r.seed && r.agents) {
      cur.fs = forecastersOf(r);
      for (let k = 0; k < cranked(r); k++) if (!built[k]) buildColony(r, k, cur.fs);
      if (stage.k < 0 && built[0]) showColony(0);
    }
    renderBelief(r);
    renderResult(r);
    renderInputs(r);
    renderPaid(r);
    renderPosts(r);
    if (r.phase === "skipped") { $("colony").hidden = true; }
    $("col-empty").textContent = r.phase === "skipped" ? "Skipped: nothing ran." : "Waiting for the first crank.";
  }
  renderAct();
  renderStake(r);
  auto.poll();
  clearTimeout(pollTimer);
  if (!isOver(r)) pollTimer = setTimeout(refresh, POLL_MS);
}

// Follow request `id`.
function open(id) {
  clearTimeout(pollTimer);
  cur = { id, r: null, fs: null, preview: null, sig: "", stepsSig: "", board: null, beliefKey: "", resultKey: "" };
  built = []; replay = null; lastSig = "";
  stage.k = -1; stage.col = null; stage.bars = null; stage.busy = false;
  $("colony").hidden = false;
  $("req-id").textContent = `#${id}`;
  $("req-status").textContent = "loading";
  $("run-sub").textContent = "";
  $("steps").innerHTML = ""; $("now").textContent = "";
  $("act").hidden = true; $("tx-run").textContent = "";
  $("stake-card").hidden = true; $("tx-stake").textContent = ""; stakeSig = "";
  $("belief-body").innerHTML = `<p class="text-sm text-muted" style="margin: 0">Appears once the keepers' odds are on chain.</p>`;
  $("inputs").hidden = true;
  $("col-name").textContent = "Three colonies";
  $("col-blurb").textContent = "Each crank call runs one colony on the contract, on its own map from the request seed: 60 ants, 300 ticks. Pick one to see it here, re-run from the chain's inputs.";
  $("col-by").textContent = ""; $("col-vote").hidden = true; $("col-replay").hidden = true; $("col-open").hidden = true; $("col-roster-box").hidden = true; stage.view.setStakers(null);
  $("col-empty").hidden = false; $("col-empty").textContent = "Waiting for the first crank.";
  $("col-tick").textContent = "0000"; $("col-bars").innerHTML = "";
  const ctx = stage.view.cv.getContext("2d");
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.clearRect(0, 0, stage.view.cv.width, stage.view.cv.height);
  thumbs.forEach((t, k) => { t.btn.setAttribute("aria-pressed", "false"); t.view.ctx.clearRect(0, 0, t.view.cv.width, t.view.cv.height); thumbState(k); });
  refresh();
}

// Previous and next requests, by id.
async function renderStep(id) {
  let n = 0;
  try { n = await chain.requestCount(); } catch { /* no links */ }
  const link = (k, label) => (k >= 0 && k < n ? `<a class="btn btn--sm btn--ghost" href="${esc(requestHref(k))}">${label}</a>`
    : `<span class="btn btn--sm btn--ghost" aria-disabled="true">${label}</span>`);
  $("req-step").innerHTML = n ? `${link(id - 1, "← Previous")}<span class="lv-market__of num">${id + 1} / ${n}</span>${link(id + 1, "Next →")}` : "";
}

// ---- Start ----

export async function followRequest(id) {
  wallet.onChange(() => loadWallet());
  requestAnimationFrame(frame);
  setInterval(() => { if (cur?.r) { renderNow(); renderSteps(cur.r); renderAct(); } }, 1000);
  document.fonts.ready.then(() => { stage.busy = true; built.forEach((_, k) => built[k] && thumbs[k].view.draw(1)); });
  try {
    const [cfg, keepers] = await Promise.all([chain.requestConfig(), chain.keepers()]);
    state.cfg = parseConfig(cfg);
    [state.keepers, state.quorum] = keepers;
  } catch (e) {
    showError($("tx-run"), e);
  }
  await loadWallet();
  renderStep(id);
  open(id);
}
