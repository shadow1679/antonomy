// Shared page helpers: hashes, share bars and the playback player used by the
// Sandbox and Replay pages. The Live page drives its views from the round clock
// instead of a player. Views only read Colony state (see ds/colony-view.mjs).

import { W, H } from "../sim/js/antosim.mjs";
import { ColonyView, leadingSource } from "./ds/colony-view.mjs";
import { GLYPHS } from "./round.mjs";

export const $ = (id) => document.getElementById(id);
export const short = (hex) => `${hex.slice(0, 8)}…${hex.slice(-8)}`;
export const pad4 = (t) => String(t).padStart(4, "0");
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

// Legend for staker ants: one row per wallet with its tint, stake and ants.
// Empty string when the colony has no stakes (an even map, no staker ants).
export function stakerLegendHTML(stakers) {
  if (!stakers || !stakers.total) return "";
  const rows = stakers.rows.filter((r) => r.ants > 0).map((r) =>
    `<li><span class="wallet" style="--wallet-hue: ${r.hue}">${esc(r.id)}</span> <span class="text-faint">${r.tokens.toLocaleString("en")} staked · ${r.ants} ants</span></li>`).join("");
  return `<ul class="stack text-xs" style="--stack-gap: var(--space-2); list-style: none; padding: 0; margin: 0">${rows}</ul>
    <p class="text-xs text-faint" style="margin: var(--space-2) 0 0">Staker ants: each wallet's weight is the square root of its stake, and it spawns ants in proportion. The tint is cosmetic. The sim reads only the summed weight per option.</p>`;
}

// Per-option share of the scored pheromone right now, in percent, and the
// leading option (-1 before any trail). For display while a colony runs; the
// exact basis-point shares come from trailShares() once it has finished.
export function liveShares(col) {
  const scores = col.scores();
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

const TPS = { 1: 12, 4: 48, 16: 192 }; // ticks per second for each speed button
const TWEEN_MS = 90;                    // single-step animation

// Canvas, HUD and playback controls for one colony, built inside `host`.
// load(make, labels) starts a colony at tick 0; onTick(col) runs after the
// tick changes, and onDone(col) once the final tick has run.
export class Player {
  constructor(host, { onTick = () => {}, onDone = () => {} } = {}) {
    host.innerHTML = `
      <div class="stack" style="--stack-gap: var(--space-3)">
        <div class="sim-frame">
          <canvas width="1440" height="960" aria-label="Colony map at the current tick" style="cursor: crosshair"></canvas>
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
          </div>
          <div class="seg" role="group" aria-label="Map view">
            <button type="button" aria-pressed="true" data-view="nest">Nest</button>
            <button type="button" aria-pressed="false" data-view="cells">Cells</button>
          </div>
        </div>
      </div>`;
    const r = (k) => host.querySelector(`[data-r="${k}"]`);
    this.el = Object.fromEntries(["tick", "ticks", "leader", "foraging", "carrying", "delivered", "play", "step", "scrubber"].map((k) => [k, r(k)]));
    this.cv = host.querySelector("canvas");
    this.view = new ColonyView(this.cv, { labels: [], glyphs: GLYPHS });
    this.onTick = onTick;
    this.onDone = onDone;
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
    this.view.attach(this.col);
    this.el.scrubber.max = this.col.ticks;
    this.el.ticks.textContent = pad4(this.col.ticks);
    this.render();
  }

  // Jump to tick t. The sim only runs forward, so going back replays from tick 0.
  goTo(t, fx = false) {
    if (t < this.col.t) { this.col = this.make(); this.view.attach(this.col); }
    while (this.col.t < t) { this.col.step(); this.view.afterStep(fx); }
  }

  get done() { return this.col.t === this.col.ticks; }

  panels() {
    const { col, el, view } = this;
    el.tick.textContent = pad4(col.t);
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
      while (this.acc >= 1 && col.t < col.ticks) { col.step(); view.afterStep(true); this.acc -= 1; }
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
    const toCells = (e) => {
      const b = cv.getBoundingClientRect();
      return [((e.clientX - b.left) / b.width) * W, ((e.clientY - b.top) / b.height) * H];
    };
    cv.addEventListener("mousemove", (e) => {
      const [idx, d2] = view.nearest(...toCells(e));
      const hover = d2 <= 2.5 ? idx : -1;
      cv.style.cursor = hover >= 0 ? "pointer" : "crosshair";
      if (hover !== view.hover) { view.hover = hover; if (!this.raf) view.draw(1); }
    });
    cv.addEventListener("mouseleave", () => { view.hover = -1; if (!this.raf) view.draw(1); });
    cv.addEventListener("click", (e) => {
      view.selected = view.nearest(...toCells(e))[0];
      if (!this.raf) view.draw(1);
    });
  }
}

// Shared header. `page` is "live", "sandbox", "sugar" or "replay".
export function topbar(page, end = "") {
  const link = (href, key, label) =>
    `<a href="${href}"${key === page ? ' aria-current="page"' : ""}>${label}</a>`;
  return `<header class="topbar"><div class="container">
    <a class="brand" href="index.html">Anto<span>nomy</span></a>
    <nav class="nav" aria-label="Pages">
      ${link("index.html", "live", "Live colonies")}
      ${link("sandbox.html", "sandbox", "Sandbox")}
      ${link("sugar.html", "sugar", "Drop sugar")}
      ${link("replay.html", "replay", "Replay &amp; verify")}
      ${link("receipts.html", "receipts", "Receipts")}
    </nav>
    <div class="topbar__end" id="topbar-end">${end}</div>
  </div></header>`;
}
