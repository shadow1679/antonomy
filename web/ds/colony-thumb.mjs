// A small, cheap view of a running colony for overview cards: trail, food
// piles drawn as their option glyph, the nest and every ant as a dot. No
// scenery, roads or effects; ColonyView is the full map. Pure view, like
// ColonyView: it reads Colony state and never calls the sim RNG.

import { W, H, NEST_X, NEST_Y, CAP } from "../../sim/js/antosim.mjs";
import { walletColor } from "./staker-ants.mjs";

const TAU = Math.PI * 2;
// Read once per page, not once per thumb (each read can force a style recalc).
const TOKENS = new Map();
const tok = (n) => {
  if (!TOKENS.has(n)) TOKENS.set(n, getComputedStyle(document.documentElement).getPropertyValue(n).trim());
  return TOKENS.get(n);
};
const rgb = (hex) => { const v = parseInt(hex.slice(1), 16); return [v >> 16, (v >> 8) & 255, v & 255]; };
const css = ([r, g, b], a = 1) => `rgba(${r | 0},${g | 0},${b | 0},${a})`;

export class ColonyThumb {
  constructor(canvas, { glyphs }) {
    this.cv = canvas;
    this.ctx = canvas.getContext("2d");
    this.S = canvas.width / W; // pixels per cell
    this.glyphs = glyphs;
    this.c = {
      bg: tok("--soil-950"),
      bone: rgb(tok("--bone-100")),
      amberHi: rgb(tok("--amber-300")),
      amberLo: rgb(tok("--amber-600")),
      opt: glyphs.map((_, i) => tok(`--opt-${i}`)),
    };
    this.font = tok("--font-mono");
    this.motion = matchMedia("(prefers-reduced-motion: reduce)");
    this.ph = document.createElement("canvas");
    this.ph.width = W; this.ph.height = H;
    this.phCtx = this.ph.getContext("2d");
    this.phImg = this.phCtx.createImageData(W, H);
    this.phT = -1;
    this.owner = null; // staker ants, as in ColonyView.setStakers
    this.tints = [];
  }

  // Tint staker ants by wallet (see staker-ants.mjs). null clears it.
  setStakers(stakers) {
    this.owner = stakers?.total ? stakers.owner : null;
    this.tints = this.owner ? stakers.rows.map((r) => walletColor(r.hue)) : [];
  }

  // Start tracking a colony, at whatever tick it is on.
  attach(col) {
    this.col = col;
    this.prevX = Int32Array.from(col.ax); this.prevY = Int32Array.from(col.ay);
    this.curX = Int32Array.from(col.ax); this.curY = Int32Array.from(col.ay);
    this.phT = -1;
  }

  // Call after every col.step(), so ants glide from the last tick.
  afterStep() {
    this.prevX.set(this.curX); this.prevY.set(this.curY);
    this.curX.set(this.col.ax); this.curY.set(this.col.ay);
  }

  // Trail changes once a tick, so the image is rebuilt only then.
  paintTrail() {
    const { col, c } = this, d = this.phImg.data;
    for (let i = 0, j = 0; i < W * H; i++, j += 4) {
      const v = col.cell(i);
      if (!v) { d[j + 3] = 0; continue; }
      const k = Math.sqrt(v / CAP);
      d[j] = c.amberLo[0] + (c.amberHi[0] - c.amberLo[0]) * k;
      d[j + 1] = c.amberLo[1] + (c.amberHi[1] - c.amberLo[1]) * k;
      d[j + 2] = c.amberLo[2] + (c.amberHi[2] - c.amberLo[2]) * k;
      d[j + 3] = k * 220;
    }
    this.phCtx.putImageData(this.phImg, 0, 0);
    this.phT = col.t;
  }

  // frac (0..1) places ants between the last two ticks.
  draw(frac = 1) {
    const { ctx, cv, col, S, c } = this;
    if (this.motion.matches) frac = 1;
    if (col.t !== this.phT) this.paintTrail();
    ctx.fillStyle = c.bg;
    ctx.fillRect(0, 0, cv.width, cv.height);
    ctx.imageSmoothingEnabled = true;
    ctx.drawImage(this.ph, 0, 0, cv.width, cv.height);

    ctx.strokeStyle = css(c.bone, 0.35);
    ctx.lineWidth = Math.max(1, S * 0.4);
    ctx.beginPath(); ctx.arc((NEST_X + 0.5) * S, (NEST_Y + 0.5) * S, S * 2, 0, TAU); ctx.stroke();

    // Food piles as their option glyph (design system rule 2), on a dark disc.
    ctx.font = `700 ${Math.round(S * 6)}px ${this.font}`;
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    for (let s = 0; s < col.n; s++) {
      const o = col.perm.indexOf(s), x = (col.sx[s] + 0.5) * S, y = (col.sy[s] + 0.5) * S;
      ctx.fillStyle = "rgba(0,0,0,0.55)";
      ctx.beginPath(); ctx.arc(x, y, S * 4, 0, TAU); ctx.fill();
      ctx.fillStyle = c.opt[o];
      ctx.fillText(this.glyphs[o], x, y + S * 0.3);
    }

    // Ants: loaded ones bright, foragers dimmer, staker ants in their
    // wallet's tint on top.
    const r = Math.max(1, S * 0.6), { owner } = this;
    const at = (a) => [(this.prevX[a] + (this.curX[a] - this.prevX[a]) * frac) / 256 * S,
      (this.prevY[a] + (this.curY[a] - this.prevY[a]) * frac) / 256 * S];
    for (const pass of [0, 1]) {
      ctx.fillStyle = css(c.bone, pass ? 0.95 : 0.55);
      ctx.beginPath();
      for (let a = 0; a < col.ants; a++) {
        if (col.returning[a] !== pass || (owner && owner[a] >= 0)) continue;
        const [x, y] = at(a);
        ctx.moveTo(x + r, y);
        ctx.arc(x, y, r, 0, TAU);
      }
      ctx.fill();
    }
    if (!owner) return;
    for (let a = 0; a < col.ants; a++) {
      if (owner[a] < 0) continue;
      const [x, y] = at(a);
      ctx.fillStyle = this.tints[owner[a]];
      ctx.beginPath(); ctx.arc(x, y, r * 1.25, 0, TAU); ctx.fill();
    }
  }
}
