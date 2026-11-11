// Shared page helpers: hashes, share bars and the playback player used by the
// Sandbox and Replay pages. The Live page drives its views from the round clock
// instead of a player. Views only read Colony state (see ds/colony-view.mjs).

import { W, H } from "../sim/js/antosim.mjs";
import { ColonyView, leadingSource } from "./ds/colony-view.mjs";
import { GLYPHS } from "./round.mjs";
import { tripAt, deliveredBy } from "./autopsy.mjs";
import { wallet, contractId, NETWORK } from "./chain.mjs";
import { loadToken, chipText } from "./token.mjs";

export const $ = (id) => document.getElementById(id);
export const short = (hex) => `${hex.slice(0, 8)}…${hex.slice(-8)}`;
export const pad4 = (t) => String(t).padStart(4, "0");
// Tick t padded to the width of the run's last tick (0800, 86400).
export const padTick = (t, ticks) => String(t).padStart(Math.max(4, String(ticks).length), "0");
// Countdown as h:mm:ss.
export const hms = (ms) => {
  const s = Math.max(0, Math.ceil(ms / 1000));
  return `${Math.floor(s / 3600)}:${String(Math.floor(s / 60) % 60).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`;
};
const ESC = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };
export const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ESC[c]);

// A hash in 4-character groups: the first 8 and last 8 by default, all 64
// when `full`. Lowercase hex, so two hashes compare group by group.
const groups = (hex) => hex.toLowerCase().match(/.{1,4}/g).map((g) => `<span class="hash__grp">${g}</span>`).join("");
export const hashGroupsHTML = (hex, full = false) => full || hex.length <= 16 ? groups(hex)
  : `${groups(hex.slice(0, 8))}<span class="hash__gap">…</span>${groups(hex.slice(-8))}`;

// A copyable hash (design system §8.7): the value in groups with the full
// hash as its title, Expand (two lines of 32), and Copy, which always copies
// the full value. `name` adds a visible label ("Seed").
export const hashHTML = (hex, label, { name = "" } = {}) =>
  `<span class="hash">${name ? `<span class="hash__label">${esc(name)}</span>` : ""}` +
  `<span class="hash__value" title="${hex}" data-hex="${hex}">${hashGroupsHTML(hex)}</span>` +
  (hex.length > 16 ? `<button class="hash__expand" type="button" aria-expanded="false" aria-label="Show the full ${esc(label)}">Expand</button>` : "") +
  `<button class="hash__copy" type="button" aria-label="Copy ${esc(label)}" data-copy="${hex}"></button></span>`;

// Chain and Your browser, stacked, every differing group underlined and
// marked ≠, so a mismatch shows without colour.
export function hashCompareHTML(chain, mine) {
  const g = (a, b) => a.toLowerCase().match(/.{1,4}/g).map((x, i) =>
    `<span class="hash__grp${b && b.toLowerCase().slice(i * 4, i * 4 + 4) !== x ? " is-diff" : ""}">${x}</span>`).join("");
  return `<dl class="hash-compare"><dt>Chain</dt><dd>${g(chain, mine)}</dd><dt>Your browser</dt><dd>${g(mine, chain)}</dd></dl>`;
}

// Copy and Expand for every .hash on the page. "Copied" shows for 1.5 s and
// is announced; if the clipboard is denied, the value is selected and the
// hint says to press ⌘C.
export function installCopy() {
  let live = document.getElementById("copy-live");
  if (!live) {
    live = Object.assign(document.createElement("span"), { id: "copy-live", className: "visually-hidden" });
    live.setAttribute("aria-live", "polite");
    document.body.append(live);
  }
  document.addEventListener("click", async (e) => {
    const x = e.target.closest(".hash__expand");
    if (x) {
      const h = x.closest(".hash"), v = h.querySelector(".hash__value"), open = !h.classList.contains("is-expanded");
      h.classList.toggle("is-expanded", open);
      v.innerHTML = hashGroupsHTML(v.dataset.hex, open);
      x.textContent = open ? "Collapse" : "Expand";
      x.setAttribute("aria-expanded", String(open));
      return;
    }
    const b = e.target.closest(".hash__copy");
    if (!b) return;
    try {
      await navigator.clipboard.writeText(b.dataset.copy);
    } catch {
      const v = b.closest(".hash")?.querySelector(".hash__value") ?? b.previousElementSibling;
      if (v) {
        if (v.dataset.hex) v.innerHTML = hashGroupsHTML(v.dataset.hex, true);
        getSelection().selectAllChildren(v);
        if (!b.parentElement.querySelector(".hash__hint")) b.insertAdjacentHTML("afterend", `<span class="hash__hint">Press ${/Mac/.test(navigator.platform) ? "⌘C" : "Ctrl+C"} to copy</span>`);
      }
      return;
    }
    const label = b.getAttribute("aria-label");
    b.classList.add("is-copied");
    b.setAttribute("aria-label", "Copied");
    live.textContent = "Copied";
    setTimeout(() => { b.classList.remove("is-copied"); b.setAttribute("aria-label", label); live.textContent = ""; }, 1500);
  });
}

// A status pill (§8.13): running, pending, match, mismatch, paused,
// stalled, default, skipped, done. The glyph comes from the state.
export const pillHTML = (state, text, title = "") =>
  `<span class="pill" data-state="${state}"${title ? ` title="${esc(title)}"` : ""}>${state === "running" ? `<i class="pill__g" aria-hidden="true"></i>` : ""}${esc(text)}</span>`;

// Toasts (§8.12): the result of the user's own action, bottom right. kind is
// pending, sent, confirmed, failed or copied. Returns update(kind, text,
// href), so a pending transaction updates in place. Hover pauses the 5 s
// timer; a failed toast stays until dismissed. System faults are banners.
export function toast(kind, text, href = "") {
  let box = document.querySelector(".toasts");
  if (!box) {
    box = Object.assign(document.createElement("ol"), { className: "toasts" });
    box.setAttribute("aria-live", "polite");
    document.body.append(box);
  }
  const li = document.createElement("li");
  li.className = "toast";
  box.append(li);
  let timer = 0, left = 5000, since = 0;
  const sticky = () => li.dataset.kind === "failed" || li.dataset.kind === "pending";
  const close = () => { clearTimeout(timer); li.remove(); };
  const arm = () => { since = performance.now(); timer = setTimeout(close, left); };
  li.addEventListener("mouseenter", () => { clearTimeout(timer); left -= performance.now() - since; });
  li.addEventListener("mouseleave", () => { if (!sticky()) arm(); });
  const update = (k, t, h = "") => {
    clearTimeout(timer);
    li.dataset.kind = k;
    li.setAttribute("role", k === "failed" ? "alert" : "status");
    li.innerHTML = `<span class="toast__g" aria-hidden="true"></span><p>${esc(t)}${h ? ` <a href="${esc(h)}" target="_blank" rel="noopener">Transaction ↗</a>` : ""}</p>` +
      `<button class="toast__close" type="button" aria-label="Dismiss">✕</button>`;
    li.querySelector(".toast__close").onclick = close;
    left = 5000;
    if (!sticky()) arm();
  };
  update(kind, text, href);
  return update;
}

// Small "What's this?" link into the Docs page, which holds the
// explanations so the other pages can stay short.
export const whatHTML = (anchor, label = "What's this?") =>
  `<a class="what" href="docs.html#${anchor}">${esc(label)}</a>`;

// Roster of staker ants: one row per wallet with its tint, what it staked
// on (when `labels` are given), its ants and a bar of its ants against the
// biggest wallet's. Rows are buttons carrying data-wallet; stakerRoster()
// turns them into a spotlight on the map. Empty string when the colony has
// no stakes (an even map, no staker ants).
// An agent's posted odds, "Cut 60.0% · Hold 30.0% · …".
export function postedHTML(odds, labels = null) {
  return odds.map((x, o) => `${labels ? `<span class="opt" data-opt="${o}">${esc(labels[o])}</span> ` : ""}<span class="num">${(x / 100).toFixed(1)}%</span>`).join(" · ");
}

// Roster rows for staker ants, or agent ants (rows with `agent`: posted odds
// instead of tokens).
export function stakerLegendHTML(stakers, labels = null) {
  if (!stakers || !stakers.total) return "";
  const live = stakers.rows.filter((r) => r.ants > 0);
  const most = Math.max(...live.map((r) => r.ants));
  const on = (r) => labels
    ? " on " + r.stakes.map((t, o) => (t ? `<span class="opt" data-opt="${o}">${esc(labels[o])}</span>` : "")).filter(Boolean).join(" ")
    : " staked";
  const meta = (r) => r.agent ? `posted ${postedHTML(r.odds, labels)}` : `${r.tokens.toLocaleString("en")} $ANTO${on(r)}`;
  const rows = live.map((r) =>
    `<li><button type="button" class="roster__row" data-wallet="${r.i}" aria-pressed="false" style="--wallet-hue: ${r.hue}; --ants: ${(r.ants / most).toFixed(3)}">` +
    `<span class="wallet roster__id">${esc(r.id)}</span>` +
    `<span class="roster__ants num">${r.ants} ant${r.ants === 1 ? "" : "s"}</span>` +
    `<span class="roster__meta">${meta(r)}</span>` +
    `<span class="roster__bar" aria-hidden="true"></span></button></li>`).join("");
  return `<ul class="roster">${rows}</ul>`;
}

// Spotlight from a roster: hovering or focusing a wallet lights up its ants,
// a click pins it (another click unpins), leaving goes back to the pinned
// one. onSpot(w) gets the wallet index, or -1 for none. Returns
// render(stakers, labels, empty) to fill `el`; the pin survives a re-render
// while the wallet is still there.
export function stakerRoster(el, onSpot) {
  let pinned = -1;
  const rowOf = (e) => e.target.closest?.(".roster__row");
  const sync = () => el.querySelectorAll(".roster__row").forEach((b) => b.setAttribute("aria-pressed", String(+b.dataset.wallet === pinned)));
  el.addEventListener("pointerover", (e) => { const b = rowOf(e); if (b) onSpot(+b.dataset.wallet); });
  el.addEventListener("pointerleave", () => onSpot(pinned));
  el.addEventListener("focusin", (e) => { const b = rowOf(e); if (b) onSpot(+b.dataset.wallet); });
  el.addEventListener("focusout", (e) => { if (!el.contains(e.relatedTarget)) onSpot(pinned); });
  el.addEventListener("click", (e) => {
    const b = rowOf(e);
    if (!b) return;
    pinned = pinned === +b.dataset.wallet ? -1 : +b.dataset.wallet;
    sync();
    onSpot(pinned);
  });
  return (stakers, labels = null, empty = "") => {
    el.innerHTML = stakerLegendHTML(stakers, labels) || empty;
    if (pinned >= 0 && !el.querySelector(`[data-wallet="${pinned}"]`)) { pinned = -1; onSpot(-1); }
    sync();
  };
}

// Hover and click on a colony canvas: hovering near an ant rings it, a click
// picks the nearest ant. onPick(a) gets the ant; redraw() repaints when the
// hover ring changes and nothing else is animating the canvas.
export function wireMapPick(cv, view, { onPick, redraw }) {
  const toCells = (e) => {
    const b = cv.getBoundingClientRect();
    return [((e.clientX - b.left) / b.width) * W, ((e.clientY - b.top) / b.height) * H];
  };
  cv.style.cursor = "crosshair";
  cv.addEventListener("mousemove", (e) => {
    if (!view.col) return;
    const [idx, d2] = view.nearest(...toCells(e));
    const hover = d2 <= 2.5 ? idx : -1;
    cv.style.cursor = hover >= 0 ? "pointer" : "crosshair";
    if (hover !== view.hover) { view.hover = hover; redraw(); }
  });
  cv.addEventListener("mouseleave", () => { view.hover = -1; redraw(); });
  cv.addEventListener("click", (e) => { if (view.col) onPick(view.nearest(...toCells(e))[0]); });
}

// Agents get a Brier score once a market they posted on resolves (feature 3);
// none has resolved, so there is no history to show yet.
export const BRIER_NOTE = "No Brier history yet: no market it posted on has resolved.";

// Follow card for one ant on a live map: what it is doing now, the crumbs it
// has brought home and its trips so far, with a link into the full autopsy.
// trips come from a TripTracker on the same colony.
export function followHTML({ a, col, trips, labels, stakers = null, href = "", close = true }) {
  const opt = (o) => `<span class="opt" data-opt="${o}">${esc(labels[o])}</span>`;
  const k = tripAt(trips, col.t);
  const got = deliveredBy(trips, col.t, labels.length), home = got.reduce((s, v) => s + v, 0);
  const w = stakers?.owner?.[a] ?? -1, row = w >= 0 ? stakers.rows[w] : null;
  const recent = trips.filter((x) => x.home !== null).slice(-12);
  return `<div class="follow">
    <div class="follow__head">
      <span class="follow__id num">#${a}</span>
      ${row ? `<span class="wallet text-xs" style="--wallet-hue: ${row.hue}">${row.agent ? "agent ant" : "staker ant"} · ${esc(row.id)}</span>` : `<span class="text-xs text-faint">colony ant</span>`}
      ${close ? `<button class="btn btn--icon btn--sm btn--ghost follow__close" type="button" data-follow="close" aria-label="Stop following">×</button>` : ""}
    </div>
    ${row?.agent ? `<p class="text-xs" style="margin: 0">${esc(row.id)} posted ${postedHTML(row.odds, labels)}. ${BRIER_NOTE}</p>` : ""}
    <p class="follow__now"><span class="ant-state" data-state="${k >= 0 ? "returning" : "searching"}">${k >= 0 ? `carrying a crumb from ${opt(trips[k].opt)}` : "searching for food"}</span></p>
    <dl class="follow__stats">
      <div><dt>Crumbs home</dt><dd class="num">${home}</dd></div>
      <div><dt>Trips</dt><dd class="num">${trips.filter((x) => x.pick <= col.t).length}</dd></div>
      <div><dt>Tick</dt><dd class="num">${col.t.toLocaleString("en")}</dd></div>
    </dl>
    <p class="follow__crumbs" aria-label="Crumbs home, oldest first">${recent.length
      ? recent.map((x) => `<span class="follow__crumb" data-opt="${x.opt}" title="${esc(labels[x.opt])}, home at tick ${x.home}"></span>`).join("")
      : `<span class="text-xs text-faint">no crumbs home yet</span>`}</p>
    ${href ? `<a class="btn btn--sm follow__go" href="${href}">Full autopsy in Replay ↗</a>` : ""}
  </div>`;
}

// Per-option share of the score so far (the result if the run ended now), in
// percent, and the leading option (-1 before any trail). For display while a
// colony runs; the exact basis-point shares come from trailShares() once it
// has finished.
export function liveShares(col) {
  const scores = col.standing();
  const sum = scores.reduce((a, b) => a + b, 0);
  const lead = leadingSource(scores);
  return {
    pct: col.perm.map((s) => (sum ? (scores[s] / sum) * 100 : 0)),
    lead: lead < 0 ? -1 : col.perm.indexOf(lead),
  };
}

// Fill a .share-bars list with one bar per label. Returns update(pct, winner).
export function shareBars(ul, labels) {
  ul.innerHTML = labels.map((label, o) =>
    `<li class="share-bar" data-opt="${o}"><span class="opt">${esc(label)}</span>` +
    `<span class="share-bar__track"><span class="share-bar__fill"></span></span>` +
    `<span class="share-bar__value num">0.0%</span></li>`).join("");
  const rows = [...ul.children];
  return (pct, winner = -1) => rows.forEach((li, o) => {
    li.style.setProperty("--share", pct[o].toFixed(2));
    li.lastElementChild.textContent = pct[o].toFixed(1) + "%";
    li.classList.toggle("is-winner", o === winner);
  });
}

export const leaderHTML = (labels, lead, done) => lead < 0 ? "no trail yet"
  : `${done ? "✓ winner" : "leading"}: <span class="opt" data-opt="${lead}">${esc(labels[lead])}</span>`;

// Fill a .belief board: swarm belief per outcome against the market odds
// (basis points). Returns update(swarm) with swarm in basis points.
// compact: one line per outcome (label, track, value, delta), for the
// overview cards on the Live page.
export function beliefBoard(ul, labels, odds, { compact = false } = {}) {
  const pct = (b) => (b / 100).toFixed(1);
  ul.classList.toggle("belief--compact", compact);
  ul.innerHTML = labels.map((label, o) =>
    `<li class="belief__row" data-opt="${o}" style="--market: ${odds[o] / 100}">` +
    `<span class="opt belief__label">${esc(label)}</span>` +
    `<span class="belief__value num">0.0<small>%</small></span>` +
    `<span class="belief__track" aria-hidden="true"><span class="belief__fill"></span><span class="belief__market"></span></span>` +
    `<span class="belief__meta"><span>market ${pct(odds[o])}%</span><span class="delta delta--flat">0.0</span></span></li>`).join("");
  const rows = [...ul.children];
  return (swarm) => rows.forEach((li, o) => {
    const d = swarm[o] - odds[o];
    li.style.setProperty("--share", (swarm[o] / 100).toFixed(2));
    li.querySelector(".belief__value").firstChild.textContent = pct(swarm[o]);
    const delta = li.querySelector(".delta");
    delta.className = `delta ${d > 0 ? "delta--up" : d < 0 ? "delta--down" : "delta--flat"}`;
    delta.textContent = compact ? pct(Math.abs(d)) : `${pct(Math.abs(d))} pp vs market`;
    if (compact) delta.title = `${pct(Math.abs(d))} pp ${d > 0 ? "above" : d < 0 ? "below" : "level with"} the market's ${pct(odds[o])}%`;
  });
}

const TPS = { 1: 12, 4: 48, 16: 192, 128: 1536 }; // ticks per second for each speed button (default 4×)
const TWEEN_MS = 90;                    // single-step animation
const CHECKPOINT = 100;                 // SCORE_EVERY: a scrub mark, and the reduced-motion play step
// Scrub marks: every scoring checkpoint, or every hour on a Burn day (43,200 ticks over 12 h).
const markEvery = (ticks) => (ticks <= 4000 ? CHECKPOINT : ticks / 12);
// A Burn run is 43,200 ticks, so the player keeps a copy of the colony
// every KEY_EVERY ticks and seeks from the nearest one at least WARM ticks
// back (the warm-up lets the map's worn roads and trails build up again).
const KEY_EVERY = 2000, WARM = 300;

// The colony stage (design system §8.2): canvas, overlay and playback bar
// for one colony, built inside `host`. load(make, labels) starts a colony at
// tick 0; onTick(col) runs after the tick changes, onDone(col) once the final
// tick has run, and onSelect(a) when a click on the map (or select()) picks
// the ant to follow. setChain(t) makes it a live run: playing and scrubbing
// stop at the tick the chain has reached. Under prefers-reduced-motion, Play
// steps one scoring checkpoint (100 ticks) a second with no in-between frames.
export class Player {
  constructor(host, { onTick = () => {}, onDone = () => {}, onSelect = () => {} } = {}) {
    host.innerHTML = `
      <div class="player stage">
        <div class="sim-frame" tabindex="0" aria-label="Colony map. Space plays or pauses, arrow keys step, Home and End jump.">
          <canvas width="1440" height="960" aria-hidden="true"></canvas>
          <div class="sim-frame__hud">
            <span class="sim-frame__tick">tick <strong data-r="tick">0000</strong>/<span data-r="ticks">0800</span></span>
            <span class="sim-frame__tick" data-r="leader">no trail yet</span>
          </div>
          <div class="sim-frame__hud sim-frame__hud--bottom">
            <span class="sim-frame__tick">○ <strong data-r="foraging">0</strong> foraging · ● <strong data-r="carrying">0</strong> carrying</span>
            <span class="sim-frame__tick">⌂ <strong data-r="delivered">0</strong> crumbs home</span>
          </div>
        </div>
        <div class="playback">
          <button class="btn btn--icon btn--sm" type="button" data-r="play" aria-label="Play">▶</button>
          <button class="btn btn--icon btn--sm btn--ghost" type="button" data-r="back" aria-label="Step back one tick">←</button>
          <button class="btn btn--icon btn--sm btn--ghost" type="button" data-r="step" aria-label="Step one tick">→</button>
          <button class="btn btn--icon btn--sm btn--ghost" type="button" data-r="end" aria-label="Jump to the end">⇥</button>
          <div class="scrub" data-r="scrub"><input class="scrubber" type="range" data-r="scrubber" min="0" max="800" value="0" aria-label="Tick"><span class="scrub__chain" data-r="chain">chain</span></div>
          <div class="seg" role="group" aria-label="Speed">
            <button type="button" aria-pressed="false" data-speed="1">1×</button>
            <button type="button" aria-pressed="true" data-speed="4">4×</button>
            <button type="button" aria-pressed="false" data-speed="16">16×</button>
            <button type="button" aria-pressed="false" data-speed="128">128×</button>
          </div>
          <div class="seg" role="group" aria-label="Map view">
            <button type="button" aria-pressed="true" data-view="nest">Nest</button>
            <button type="button" aria-pressed="false" data-view="cells">Cells</button>
          </div>
          <span class="playback__keys text-xs text-faint" aria-hidden="true">space · ← → · home end</span>
        </div>
      </div>`;
    const r = (k) => host.querySelector(`[data-r="${k}"]`);
    this.el = Object.fromEntries(["tick", "ticks", "leader", "foraging", "carrying", "delivered", "play", "back", "step", "end", "scrub", "scrubber", "chain"].map((k) => [k, r(k)]));
    this.cv = host.querySelector("canvas");
    this.view = new ColonyView(this.cv, { labels: [], glyphs: GLYPHS });
    this.onTick = onTick;
    this.onDone = onDone;
    this.onSelect = onSelect;
    this.playing = false;
    this.speed = 4;
    this.chainT = null; // live runs: the last tick the chain has reached
    this.raf = 0; this.lastNow = 0; this.acc = 0; this.tweenEnd = 0;
    this.wire(host);
    document.fonts.ready.then(() => { if (this.col && !this.raf) this.view.draw(1); });
  }

  load(make, labels, stakers = null) {
    this.stop();
    this.make = make;
    this.labels = labels;
    this.view.labels = labels;
    this.view.setStakers(stakers);
    this.col = make();
    this.keys = new Map(); // tick -> { col, delivered, carry }
    this.view.attach(this.col);
    if (this.view.selected >= this.col.ants) this.view.selected = 0;
    this.el.scrubber.max = this.col.ticks;
    this.el.scrub.style.setProperty("--marks", this.col.ticks / markEvery(this.col.ticks));
    this.el.ticks.textContent = padTick(this.col.ticks, this.col.ticks);
    this.setChain(this.chainT);
    this.render();
  }

  // Live run: the chain has reached tick t (null for a finished run).
  setChain(t) {
    this.chainT = t;
    const live = t != null && this.col && t < this.col.ticks;
    this.el.scrub.classList.toggle("scrub--live", live);
    if (live) {
      this.el.scrub.style.setProperty("--chain", (t / this.col.ticks) * 100);
      this.el.chain.textContent = `chain ${padTick(t, this.col.ticks)}`;
    }
  }

  // The last tick playing and scrubbing may reach.
  get limit() { return this.chainT == null ? this.col.ticks : Math.min(this.col.ticks, this.chainT); }

  // One tick forward, keeping a seek point every KEY_EVERY ticks.
  step(fx) {
    const { col, view } = this;
    col.step();
    view.afterStep(fx);
    if (col.t % KEY_EVERY === 0 && !this.keys.has(col.t)) {
      this.keys.set(col.t, { col: col.clone(), delivered: view.delivered, carry: view.carry.slice() });
    }
  }

  // Jump to tick t. The sim only runs forward, so going back (or far ahead)
  // restarts from the nearest seek point, or from tick 0.
  goTo(t, fx = false) {
    const k = this.keys.get(Math.floor(Math.max(0, t - WARM) / KEY_EVERY) * KEY_EVERY);
    if (t < this.col.t || (k && k.col.t > this.col.t)) {
      this.col = k ? k.col.clone() : this.make();
      this.view.attach(this.col);
      if (k) { this.view.delivered = k.delivered; this.view.carry.set(k.carry); }
    }
    while (this.col.t < t) this.step(fx);
  }

  get done() { return this.col.t >= this.limit; }

  // Pause and show tick t.
  seek(t) {
    this.stop();
    this.goTo(Math.max(0, Math.min(this.limit, t)));
    this.render();
  }

  // Light up wallet w's staker ants (-1 for none).
  spot(w) {
    this.view.spotlight = w;
    if (!this.raf) this.view.draw(1);
  }

  // Follow ant a (clamped to the colony's ants).
  select(a) {
    const view = this.view;
    view.selected = Math.max(0, Math.min(this.col.ants - 1, a));
    if (!this.raf) view.draw(1);
    this.onSelect(view.selected);
  }

  panels() {
    const { col, el, view } = this;
    el.tick.textContent = padTick(col.t, col.ticks);
    el.scrubber.value = col.t;
    el.scrubber.style.setProperty("--progress", (col.t / col.ticks) * 100);
    const carrying = view.carrying();
    el.foraging.textContent = col.ants - carrying;
    el.carrying.textContent = carrying;
    el.delivered.textContent = view.delivered.toLocaleString("en");
    el.leader.innerHTML = leaderHTML(this.labels, liveShares(col).lead, this.done);
    this.onTick(col);
    if (this.done) this.onDone(col);
  }

  render() { this.view.draw(1); this.panels(); }

  loop(now) {
    this.raf = 0;
    const { col, view } = this, t0 = col.t;
    const reduced = view.motion.matches;
    if (this.playing && reduced) {
      // One scoring checkpoint a second, no in-between frames.
      this.acc += Math.min(1000, now - this.lastNow);
      if (this.acc >= 1000) {
        this.acc = 0;
        this.goTo(Math.min(this.limit, (Math.floor(col.t / CHECKPOINT) + 1) * CHECKPOINT));
      }
      if (this.col.t >= this.limit) this.stop();
    } else if (this.playing) {
      this.acc += (Math.min(100, now - this.lastNow) / 1000) * TPS[this.speed];
      while (this.acc >= 1 && col.t < this.limit) { this.step(true); this.acc -= 1; }
      if (col.t >= this.limit) { this.acc = 1; this.stop(); }
    }
    this.lastNow = now;
    const frac = this.playing && !reduced ? this.acc : this.tweenEnd > now ? 1 - (this.tweenEnd - now) / TWEEN_MS : 1;
    const busy = view.draw(frac, now);
    if (this.col.t !== t0) this.panels();
    if (this.playing || busy || this.tweenEnd > now) this.raf = requestAnimationFrame((n) => this.loop(n));
  }

  kick() {
    if (this.raf) return;
    this.lastNow = performance.now();
    this.raf = requestAnimationFrame((n) => this.loop(n));
  }

  play() {
    if (this.done) { this.goTo(0); this.panels(); }
    this.playing = true;
    this.acc = 0;
    this.el.play.textContent = "‖";
    this.el.play.setAttribute("aria-label", "Pause");
    this.kick();
  }

  stop() {
    this.playing = false;
    this.el.play.textContent = "▶";
    this.el.play.setAttribute("aria-label", "Play");
  }

  wire(host) {
    const { el, cv, view } = this;
    el.scrubber.addEventListener("input", (e) => {
      this.stop();
      const t = Math.min(+e.target.value, this.limit);
      e.target.value = t;
      this.goTo(t);
      this.render();
    });
    el.back.addEventListener("click", () => this.seek(this.col.t - 1));
    el.end.addEventListener("click", () => this.seek(this.limit));
    el.step.addEventListener("click", () => {
      this.stop();
      if (this.done) return;
      this.goTo(this.col.t + 1, true);
      this.panels();
      this.tweenEnd = performance.now() + TWEEN_MS;
      this.kick();
    });
    el.play.addEventListener("click", () => (this.playing ? this.stop() : this.play()));
    const group = (attr, set) => {
      const bs = host.querySelectorAll(`[${attr}]`);
      for (const b of bs) b.addEventListener("click", () => {
        bs.forEach((x) => x.setAttribute("aria-pressed", "false"));
        b.setAttribute("aria-pressed", "true");
        set(b.getAttribute(attr));
      });
    };
    group("data-speed", (v) => { this.speed = +v; });
    group("data-view", (v) => { view.mode = v; if (!this.raf) view.draw(1); });
    wireMapPick(cv, view, { onPick: (a) => this.select(a), redraw: () => { if (!this.raf) view.draw(1); } });
    // Keyboard: space plays or pauses, arrows step one tick, Home and End
    // jump to the ends. Ignored while typing in a field.
    document.addEventListener("keydown", (e) => {
      if (!this.col || e.altKey || e.ctrlKey || e.metaKey) return;
      if (e.target.closest?.("input, select, textarea, [contenteditable]")) return;
      if (e.key === " " && e.target.closest?.("button, a, summary")) return; // native activation
      const keys = {
        " ": () => (this.playing ? this.stop() : this.play()),
        ArrowRight: () => el.step.click(),
        ArrowLeft: () => this.seek(this.col.t - 1),
        Home: () => this.seek(0),
        End: () => this.seek(this.limit),
      };
      if (!keys[e.key]) return;
      e.preventDefault();
      keys[e.key]();
    });
  }
}

// The ant mark from web/brand/mark.svg (made by web/brand/make_brand.mjs),
// cropped to the ant. See docs/BRAND.md.
export const MARK = `<svg width="17" height="24" viewBox="12 4 40 56" aria-hidden="true"><g fill="var(--accent)">
  <path d="M28.8 26 L22.5 22.5 L20 17 M35.2 26 L41.5 22.5 L44 17 M28.6 29.5 L20 31 L15.5 35 M35.4 29.5 L44 31 L48.5 35 M29.2 32 L23 37 L19 44.5 M34.8 32 L41 37 L45 44.5 M29.6 13 L27 8 L22.5 6.5 M34.4 13 L37 8 L41.5 6.5" fill="none" stroke="var(--accent)" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"/>
  <circle cx="32" cy="17" r="5.2"/><ellipse cx="32" cy="28.5" rx="3.8" ry="5.2"/><ellipse cx="32" cy="46" rx="8.2" ry="11"/></g></svg>`;

const PAGES = [
  ["live.html", "live", "Live"],
  ["pot.html", "pot", "Pot"],
  ["nest.html", "nest", "Nest"],
  null,
  ["replay.html", "history", "History"],
  null,
  ["docs.html", "docs", "Docs"],
];

// Shared header. `page` is "landing" (index.html, the front page, which the
// brand links to on every page), "nest" (nest.html, the whole project as one
// ant base), "live", "pot", "recruit", "history" (the
// History page, replay.html, which Replay and Receipts became) or "docs". `demo` is kept as the name of the option that shows
// the status strip (testnet, play token, which contract); pages that never
// touch the chain pass `demo: false`. The wallet button sits at the end of the
// bar on every page (`mountWallet` wires it), and every page has the $ANTO
// chip before it (`mountTokenChip`).
export function topbar(page, end = "", { demo = true } = {}) {
  const nav = PAGES.map((p) => p
    ? `<a href="${p[0]}"${p[1] === page ? ' aria-current="page"' : ""}>${p[2]}</a>`
    : `<span class="nav__sep" aria-hidden="true"></span>`).join("");
  // Recruit is the one item that starts something, so it sits at the end of
  // the bar by the wallet as an amber outline, not in the nav with the tabs.
  const cta = `<a class="nav__cta" href="recruit.html" title="Ask the swarm for a forecast"${page === "recruit" ? ' aria-current="page"' : ""}><span aria-hidden="true">+</span> Recruit</a>`;
  const cid = contractId();
  const chip = `<a class="anto-chip" id="anto-chip" href="index.html#anto" title="$ANTO, the play token on NEAR testnet"><b>$ANTO</b><span class="anto-chip__v num">…</span></a>`;
  queueMicrotask(mountWallet);
  queueMicrotask(mountTokenChip);
  queueMicrotask(centerCurrentTab);
  return `<header class="topbar"><div class="container topbar__row">
    <a class="brand" href="index.html">${MARK}<b><span>Anto</span>nomy</b></a>
    <nav class="nav" aria-label="Pages">${nav}</nav>
    <div class="topbar__end" id="topbar-end">${end}${chip}${cta}<button class="btn btn--sm" id="wallet-btn" type="button">Connect wallet</button></div>
  </div></header>` + (demo ? `<div class="demo-strip"><div class="container"><p style="margin: 0">
    <strong>${NETWORK} · play token.</strong> Everything here is read from the contract
    <a href="https://testnet.nearblocks.io/address/${cid}" target="_blank" rel="noopener"><code>${cid}</code></a>;
    the sim and hashes re-run in your browser. ${whatHTML("demo", "More")}</p></div></div>` : "");
}

// On a phone the nav is its own scrolling row; bring the current tab into
// view by scrolling the row only, never the page.
function centerCurrentTab() {
  const nav = document.querySelector(".topbar .nav");
  const cur = nav?.querySelector('[aria-current="page"]');
  if (!cur || nav.scrollWidth <= nav.clientWidth) return;
  nav.scrollLeft = cur.offsetLeft - nav.offsetLeft - (nav.clientWidth - cur.offsetWidth) / 2;
}

// Wire the top bar's wallet button: connect, show the account, disconnect on
// a second click. Safe to call twice. Pages listen with wallet.onChange.
export function mountWallet() {
  const btn = document.getElementById("wallet-btn");
  if (!btn || btn.dataset.bound) return;
  btn.dataset.bound = "1";
  const paint = (acct) => {
    btn.textContent = acct ? acct : "Connect wallet";
    btn.title = acct ? "Connected. Click to disconnect." : "Connect a NEAR testnet wallet";
    // Never amber: the page's own action is its one primary.
  };
  wallet.onChange(paint);
  btn.addEventListener("click", async () => {
    btn.disabled = true;
    try {
      if (wallet.accountId) await wallet.disconnect(); else await wallet.connect();
    } catch (e) {
      btn.title = String(e.message || e);
    } finally {
      btn.disabled = false;
    }
  });
  paint(wallet.accountId);
  wallet.restore();
}

// The top bar's $ANTO chip: the connected wallet's balance, else how much has
// burned since launch. Repainted when the wallet changes, every minute, and
// on `refreshTokenChip()` after a page's own write (a stake, a claim).
let paintChip = null;
export const refreshTokenChip = () => paintChip?.();
export function mountTokenChip() {
  const el = document.getElementById("anto-chip");
  if (!el || el.dataset.bound) return;
  el.dataset.bound = "1";
  const v = el.querySelector(".anto-chip__v");
  paintChip = async () => {
    try {
      const c = chipText(await loadToken({ account: wallet.accountId }));
      if (!c) return;
      v.innerHTML = `${esc(c.value)} <small>${c.label}</small>`;
      el.title = c.label === "yours" ? `Your $ANTO balance (${wallet.accountId}). Play token on NEAR testnet.`
        : `$ANTO ${c.label} since launch, read from the contract. Play token on NEAR testnet.`;
    } catch { /* keep the last value */ }
  };
  wallet.onChange(paintChip);
  paintChip();
  setInterval(() => { if (!document.hidden) paintChip(); }, 60_000);
}

// The Recruit page's tabs, which the footer lists as their own group.
const RECRUIT = [
  ["recruit.html#forecast", "Forecast on request"],
  ["recruit.html#random", "Randomness"],
  ["recruit.html#agents", "Answer as an agent"],
];

// Shared footer, with the known limits the README also states. The pages
// come in the nav's groups (the doing pages, then checking and Docs), with
// Recruit's sections as their own group.
export function footer() {
  const groups = [[]];
  for (const p of PAGES) p ? groups[groups.length - 1].push(p) : groups.push([]);
  const list = (ps) => `<ul>${ps.map((p) => `<li><a href="${p[0]}">${p.at(-1)}</a></li>`).join("")}</ul>`;
  const cid = contractId();
  return `<footer class="page-foot"><div class="container">
    <div class="page-foot__grid">
      <div class="page-foot__brand">
        <a class="brand" href="index.html">${MARK}<b><span>Anto</span>nomy</b></a>
        <p>Forecasts by ant colonies, run on-chain from one public seed and re-run in your browser.</p>
        <p>Forecasts are not advice. Nobody is paid for being right, and nothing here links to a trading venue.</p>
      </div>
      <nav class="page-foot__nav" aria-label="Footer">
        <div><h2>Take part</h2>${list(groups[0])}</div>
        <div><h2>Recruit the swarm</h2>${list(RECRUIT)}</div>
        <div><h2>Check &amp; learn</h2>${list(groups.slice(1).flat())}</div>
      </nav>
      <div>
        <h2>Known limits</h2>
        <ul class="page-foot__limits">
          <li>Seeds come from the block's random seed, not the drand round yet.</li>
        </ul>
        ${whatHTML("demo", "What runs where")}
      </div>
    </div>
    <div class="page-foot__base">
      <span>Ant Colony Oracle · ${NETWORK} · play token · sim ANTO-SIM-v1</span>
      <span>Contract <a href="https://testnet.nearblocks.io/address/${cid}" target="_blank" rel="noopener"><code>${cid}</code></a></span>
    </div>
  </div></footer>`;
}
