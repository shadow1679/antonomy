// Shared page helpers: hashes, share bars and the playback player used by the
// Sandbox and Replay pages. The Live page drives its views from the round clock
// instead of a player. Views only read Colony state (see ds/colony-view.mjs).

import { W, H } from "../sim/js/antosim.mjs";
import { ColonyView, leadingSource } from "./ds/colony-view.mjs";
import { GLYPHS } from "./round.mjs";
import { tripAt, deliveredBy } from "./autopsy.mjs";

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

// A copyable hash (design system rule 4).
export const hashHTML = (hex, label) =>
  `<span class="hash"><span class="hash__value" title="${hex}">${short(hex)}</span>` +
  `<button class="hash__copy" type="button" aria-label="Copy ${esc(label)}" data-copy="${hex}"></button></span>`;

export function installCopy() {
  document.addEventListener("click", async (e) => {
    const b = e.target.closest(".hash__copy");
    if (!b) return;
    try { await navigator.clipboard.writeText(b.dataset.copy); } catch { return; }
    const label = b.getAttribute("aria-label");
    b.classList.add("is-copied");
    b.setAttribute("aria-label", "Copied");
    setTimeout(() => { b.classList.remove("is-copied"); b.setAttribute("aria-label", label); }, 1400);
  });
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
export function stakerLegendHTML(stakers, labels = null) {
  if (!stakers || !stakers.total) return "";
  const live = stakers.rows.filter((r) => r.ants > 0);
  const most = Math.max(...live.map((r) => r.ants));
  const on = (r) => labels
    ? " on " + r.stakes.map((t, o) => (t ? `<span class="opt" data-opt="${o}">${esc(labels[o])}</span>` : "")).filter(Boolean).join(" ")
    : " staked";
  const rows = live.map((r) =>
    `<li><button type="button" class="roster__row" data-wallet="${r.i}" aria-pressed="false" style="--wallet-hue: ${r.hue}; --ants: ${(r.ants / most).toFixed(3)}">` +
    `<span class="wallet roster__id">${esc(r.id)}</span>` +
    `<span class="roster__ants num">${r.ants} ant${r.ants === 1 ? "" : "s"}</span>` +
    `<span class="roster__meta">${r.tokens.toLocaleString("en")} tANTO${on(r)}</span>` +
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
      ${row ? `<span class="wallet text-xs" style="--wallet-hue: ${row.hue}">staker ant · ${esc(row.id)}</span>` : `<span class="text-xs text-faint">colony ant</span>`}
      ${close ? `<button class="btn btn--icon btn--sm btn--ghost follow__close" type="button" data-follow="close" aria-label="Stop following">×</button>` : ""}
    </div>
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
    delta.textContent = compact ? pct(Math.abs(d)) : `${pct(Math.abs(d))} pts vs market`;
    if (compact) delta.title = `${pct(Math.abs(d))} pts ${d > 0 ? "above" : d < 0 ? "below" : "level with"} the market's ${pct(odds[o])}%`;
  });
}

const TPS = { 1: 12, 4: 48, 16: 192, 128: 1536 }; // ticks per second for each speed button
const TWEEN_MS = 90;                    // single-step animation
// A Burn run is 43,200 ticks, so the player keeps a copy of the colony
// every KEY_EVERY ticks and seeks from the nearest one at least WARM ticks
// back (the warm-up lets the map's worn roads and trails build up again).
const KEY_EVERY = 2000, WARM = 300;

// Canvas, HUD and playback controls for one colony, built inside `host`.
// load(make, labels) starts a colony at tick 0; onTick(col) runs after the
// tick changes, onDone(col) once the final tick has run, and onSelect(a) when
// a click on the map (or select()) picks the ant to follow.
export class Player {
  constructor(host, { onTick = () => {}, onDone = () => {}, onSelect = () => {} } = {}) {
    host.innerHTML = `
      <div class="player">
        <div class="sim-frame">
          <canvas width="1440" height="960" aria-label="Colony map at the current tick"></canvas>
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
          <button class="btn btn--icon btn--sm btn--ghost" type="button" data-r="step" aria-label="Step one tick">⏭</button>
          <input class="scrubber" type="range" data-r="scrubber" min="0" max="800" value="0" aria-label="Tick">
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
          <span class="playback__keys text-xs text-faint" aria-hidden="true">space · ← →</span>
        </div>
      </div>`;
    const r = (k) => host.querySelector(`[data-r="${k}"]`);
    this.el = Object.fromEntries(["tick", "ticks", "leader", "foraging", "carrying", "delivered", "play", "step", "scrubber"].map((k) => [k, r(k)]));
    this.cv = host.querySelector("canvas");
    this.view = new ColonyView(this.cv, { labels: [], glyphs: GLYPHS });
    this.onTick = onTick;
    this.onDone = onDone;
    this.onSelect = onSelect;
    this.playing = false;
    this.speed = 4;
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
    this.el.ticks.textContent = padTick(this.col.ticks, this.col.ticks);
    this.render();
  }

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

  get done() { return this.col.t === this.col.ticks; }

  // Pause and show tick t.
  seek(t) {
    this.stop();
    this.goTo(Math.max(0, Math.min(this.col.ticks, t)));
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
    if (this.playing) {
      this.acc += (Math.min(100, now - this.lastNow) / 1000) * TPS[this.speed];
      while (this.acc >= 1 && col.t < col.ticks) { this.step(true); this.acc -= 1; }
      if (col.t >= col.ticks) { this.acc = 1; this.stop(); }
    }
    this.lastNow = now;
    const frac = this.playing ? this.acc : this.tweenEnd > now ? 1 - (this.tweenEnd - now) / TWEEN_MS : 1;
    const busy = view.draw(frac, now);
    if (col.t !== t0) this.panels();
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
    this.el.play.textContent = "❚❚";
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
    el.scrubber.addEventListener("input", (e) => { this.stop(); this.goTo(+e.target.value); this.render(); });
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
        End: () => this.seek(this.col.ticks),
      };
      if (!keys[e.key]) return;
      e.preventDefault();
      keys[e.key]();
    });
  }
}

const MARK = `<svg width="22" height="22" viewBox="0 0 22 22" aria-hidden="true">
  <circle cx="4" cy="17" r="2" fill="var(--amber-600)"/><circle cx="10" cy="12" r="2.5" fill="var(--amber-400)"/>
  <circle cx="17" cy="6" r="3.5" fill="var(--amber-300)"/></svg>`;

const PAGES = [
  ["index.html", "live", "Live"],
  ["burn.html", "burn", "Burn"],
  ["recruit.html", "recruit", "Recruit"],
  ["sandbox.html", "sandbox", "Sandbox"],
  null,
  ["replay.html", "replay", "Replay"],
  ["receipts.html", "receipts", "Receipts"],
  null,
  ["docs.html", "docs", "Docs"],
];

// Shared header. `page` is "live", "burn", "recruit", "sandbox", "replay",
// "receipts" or "docs". `demo` adds the strip that says there is no contract yet.
export function topbar(page, end = "", { demo = true } = {}) {
  const nav = PAGES.map((p) => p
    ? `<a href="${p[0]}"${p[1] === page ? ' aria-current="page"' : ""}>${p[2]}</a>`
    : `<span class="nav__sep" aria-hidden="true"></span>`).join("");
  return `<header class="topbar"><div class="container topbar__row">
    <a class="brand" href="index.html">${MARK}<b>Anto<span>nomy</span></b></a>
    <nav class="nav" aria-label="Pages">${nav}</nav>
    <div class="topbar__end" id="topbar-end">${end}</div>
  </div></header>` + (demo ? `<div class="demo-strip"><div class="container"><p style="margin: 0">
    <strong>Demo, no contract yet.</strong> Fixture stakes and odds; the sim and hashes are real. ${whatHTML("demo", "More")}</p></div></div>` : "");
}

// Shared footer, with the known limits the README also states.
export function footer() {
  const links = PAGES.filter(Boolean).map((p) => `<li><a href="${p[0]}">${p[2]}</a></li>`).join("");
  return `<footer class="page-foot"><div class="container page-foot__grid">
    <div>
      <a class="brand" href="index.html" style="font-size: var(--text-base)">${MARK}<b>Anto<span>nomy</span></b></a>
      <p style="margin-top: var(--space-3)">Ant Colony Oracle on NEAR testnet · sim ANTO-SIM-v1.</p>
      <p>Forecasts are not advice. Nobody is paid for being right, and nothing here links to a trading venue.</p>
    </div>
    <nav aria-label="Footer"><h2>Pages</h2><ul>${links}</ul></nav>
    <div><h2>Known limits</h2><ul>
      <li>Sybil resistance is unsolved.</li>
      <li>The demo trusts the posted drand round.</li>
      <li>The play-token reward pool resembles betting.</li>
      <li>The prototype predates the build window.</li>
    </ul></div>
  </div></footer>`;
}
