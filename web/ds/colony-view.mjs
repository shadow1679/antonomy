// Draws a Colony as a living ant farm: a forest-floor surface, an anthill,
// worn roads, food piles and walking ants. Pure view. It reads Colony state
// and never calls the sim RNG, so nothing here can change a result hash.
// Scenery (soil, leaves, twigs, grass, the mound) comes from its own small
// PRNG keyed by the seed, so a seed always gets the same map. Roads come from
// where the ants actually walked. Effects use Math.random (cosmetic only).

import { W, H, NEST_X, NEST_Y, CAP, FOOD_RADIUS_SQ, SCORE_RADIUS_SQ } from "../../sim/js/antosim.mjs";

const TAU = Math.PI * 2;
const TRAIL = 24;            // ticks of path kept per ant, for the selection trail
const PARTY_MS = 1800;       // winner celebration length
const MAX_PARTICLES = 320;
const LIGHT = [-0.55, -0.6, 0.58]; // scenery is lit from the top left

// Roads: each tick an ant wears its cell (a loaded ant twice as much), and
// wear fades so an abandoned route grows back over a few hundred ticks.
const ROAD_DECAY = 0.994;
const ROAD_LO = 5, ROAD_HI = 26;   // wear that starts / completes a road
const RS = 3, RW = W * RS, RH = H * RS; // road mask resolution (3 px per cell)
const ROAD_SPREAD = [1, 0.95, 0.85, 0, 0.72, 0.6, 0, 0, 0.45]; // by distance² in cells
const MOUND_R = 4.4;               // anthill radius in cells

// Ant geometry in body units (1 unit = ANT_SCALE cells), facing +x.
const ANT_SCALE = 0.62;
const HIP = [0.14, 0.04, -0.06], KNEE = [0.36, 0.06, -0.26], FOOT = [0.62, 0.02, -0.62];

const tok = (n) => getComputedStyle(document.documentElement).getPropertyValue(n).trim();
const rgb = (hex) => { const v = parseInt(hex.slice(1), 16); return [v >> 16, (v >> 8) & 255, v & 255]; };
const css = ([r, g, b], a = 1) => `rgba(${r | 0},${g | 0},${b | 0},${a})`;
const mix = (p, q, k) => p.map((v, i) => v + (q[i] - v) * k);
const BLACK = [0, 0, 0], WHITE = [255, 255, 255];

function layer(w, h) {
  const c = document.createElement("canvas");
  c.width = w; c.height = h;
  return c;
}

// mulberry32, seeded from the first 4 seed bytes plus a salt per use.
function prng(seed, salt) {
  let a = (seed[0] | (seed[1] << 8) | (seed[2] << 16) | (seed[3] << 24)) ^ salt;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const smooth = (lo, hi, v) => { const k = Math.min(1, Math.max(0, (v - lo) / (hi - lo))); return k * k * (3 - 2 * k); };

// 3-tap box blur, horizontal then vertical, edges clamped. Result lands in a.
function blur3(a, tmp, w, h) {
  for (let y = 0; y < h; y++) {
    const r = y * w;
    for (let x = 0; x < w; x++) tmp[r + x] = (a[r + (x ? x - 1 : 0)] + a[r + x] + a[r + (x < w - 1 ? x + 1 : x)]) / 3;
  }
  for (let y = 0; y < h; y++) {
    const u = (y ? y - 1 : 0) * w, c = y * w, d = (y < h - 1 ? y + 1 : y) * w;
    for (let x = 0; x < w; x++) a[c + x] = (tmp[u + x] + tmp[c + x] + tmp[d + x]) / 3;
  }
}

// Same rule as the sim: highest score, ties to the lowest index, -1 if no trail.
export function leadingSource(scores) {
  let w = 0;
  for (let s = 1; s < scores.length; s++) if (scores[s] > scores[w]) w = s;
  return scores[w] > 0 ? w : -1;
}

export class ColonyView {
  constructor(canvas, { labels, glyphs }) {
    this.cv = canvas;
    this.ctx = canvas.getContext("2d");
    this.S = canvas.width / W; // pixels per cell
    this.labels = labels;
    this.glyphs = glyphs;
    this.c = {
      soil: Object.fromEntries([950, 900, 800, 700, 600, 500].map((k) => [k, rgb(tok(`--soil-${k}`))])),
      bone: rgb(tok("--bone-100")),
      boneMuted: rgb(tok("--bone-300")),
      amberHi: rgb(tok("--amber-300")),
      amberLo: rgb(tok("--amber-600")),
      opt: glyphs.map((_, i) => rgb(tok(`--opt-${i}`))),
      grass: rgb(tok("--scene-grass")),
      leaf: rgb(tok("--scene-leaf")),
    };
    this.font = tok("--font-mono");
    this.motion = matchMedia("(prefers-reduced-motion: reduce)");
    this.mode = "nest";      // "nest" = scenery, "cells" = plain grid, one pixel per cell
    this.selected = 37;
    this.hover = -1;
    this.ground = layer(canvas.width, canvas.height);  // under the pheromone
    this.props = layer(canvas.width, canvas.height);   // over it: nest mound, food piles
    this.ph = layer(W, H);
    this.phCtx = this.ph.getContext("2d");
    this.phImg = this.phCtx.createImageData(W, H);
    this.glow = layer(W >> 1, H >> 1);
    this.glowCtx = this.glow.getContext("2d");
    this.particles = [];
    this.party = null;

    // Roads: wear per cell, a blurred alpha mask, and the packed-earth layer.
    this.wear = new Float32Array(W * H);
    this.roadW = new Float32Array(W * H);
    this.roadK = new Float32Array(W * H);
    this.roadA = new Float32Array(RW * RH);
    this.roadTmp = new Float32Array(RW * RH);
    this.roadMask = layer(RW, RH);
    this.roadMaskCtx = this.roadMask.getContext("2d");
    this.roadImg = this.roadMaskCtx.createImageData(RW, RH);
    this.roadTex = layer(canvas.width, canvas.height);
    this.road = layer(canvas.width, canvas.height);
    this.roadCtx = this.road.getContext("2d");
    this.roadT = -1;
    // Roads stop at the foot of the anthill so the mound stays readable.
    this.nestFade = new Float32Array(RW * RH);
    for (let y = 0; y < RH; y++) for (let x = 0; x < RW; x++) {
      const d = Math.hypot((x + 0.5) / RS - NEST_X - 0.5, (y + 0.5) / RS - NEST_Y - 0.5);
      this.nestFade[y * RW + x] = smooth(MOUND_R - 0.6, MOUND_R + 1, d);
    }
    // Pheromone is drawn thinner on the mound top so the anthill stays
    // visible. Only cells under 3 from the nest, which no ring ever scores.
    this.moundFade = new Float32Array(W * H);
    for (let i = 0; i < W * H; i++) {
      this.moundFade[i] = 0.3 + 0.7 * smooth(1.4, 2.9, Math.hypot((i % W) - NEST_X, Math.floor(i / W) - NEST_Y));
    }
    this.tufts = [];         // grass drawn over the ants, swaying while playing
  }

  get still() { return this.motion.matches; }

  // Start tracking a fresh colony (new seed, or a rewind to tick 0).
  attach(col) {
    this.col = col;
    const n = col.ants;
    this.prevX = Int32Array.from(col.ax); this.prevY = Int32Array.from(col.ay); this.prevH = Int32Array.from(col.ah);
    this.curX = Int32Array.from(col.ax); this.curY = Int32Array.from(col.ay); this.curH = Int32Array.from(col.ah);
    this.carry = new Int8Array(n).fill(-1);       // source an ant took food from, -1 if none
    this.gait = Float32Array.from({ length: n }, (_, a) => ((a * 0.618) % 1) * 2);
    this.histX = new Int32Array(n * TRAIL).fill(col.ax[0]);
    this.histY = new Int32Array(n * TRAIL).fill(col.ay[0]);
    this.histLen = 1;
    this.delivered = 0;
    this.particles.length = 0;
    this.party = null;
    this.wear.fill(0);
    this.roadT = -1;
    const key = col.seed.join(",");
    if (key !== this.key) {
      this.key = key;
      this.paintGround();
      this.paintRoadTexture();
      this.paintProps();
    }
  }

  // Call after every col.step(). fx = spawn pickup, delivery and win effects.
  afterStep(fx = false) {
    const { col } = this, t = col.t, fxOn = fx && !this.still;
    this.prevX.set(this.curX); this.prevY.set(this.curY); this.prevH.set(this.curH);
    this.curX.set(col.ax); this.curY.set(col.ay); this.curH.set(col.ah);
    const slot = t % TRAIL, wear = this.wear;
    for (let i = 0; i < wear.length; i++) wear[i] *= ROAD_DECAY;
    for (let a = 0; a < col.ants; a++) {
      wear[(col.ay[a] >> 8) * W + (col.ax[a] >> 8)] += col.returning[a] ? 1 : 0.5;
      if (this.curX[a] !== this.prevX[a] || this.curY[a] !== this.prevY[a]) this.gait[a] += 1;
      this.histX[a * TRAIL + slot] = this.curX[a];
      this.histY[a * TRAIL + slot] = this.curY[a];
      if (col.returning[a] && this.carry[a] < 0) {
        const s = this.sourceAt(col.ax[a] >> 8, col.ay[a] >> 8);
        this.carry[a] = s < 0 ? 0 : s;
        if (fxOn) this.pop(a);
      } else if (!col.returning[a] && this.carry[a] >= 0) {
        if (fxOn) this.sink(a);
        this.carry[a] = -1;
        this.delivered++;
      }
    }
    this.histLen = Math.min(t + 1, TRAIL);
    if (fxOn && t === col.ticks) this.celebrate();
  }

  // The sim's pickup test: first source (lowest index) within the food radius.
  sourceAt(cx, cy) {
    const { sx, sy, n } = this.col;
    for (let s = 0; s < n; s++) {
      const dx = cx - sx[s], dy = cy - sy[s];
      if (dx * dx + dy * dy <= FOOD_RADIUS_SQ) return s;
    }
    return -1;
  }

  optOf(s) { return this.col.perm.indexOf(s); }
  carrying() { let k = 0; for (const r of this.col.returning) k += r; return k; }

  // Ant position in canvas pixels, between the previous and current tick.
  pos(a, frac) {
    const x = this.prevX[a] + (this.curX[a] - this.prevX[a]) * frac;
    const y = this.prevY[a] + (this.curY[a] - this.prevY[a]) * frac;
    return [(x / 256) * this.S, (y / 256) * this.S];
  }

  // Nearest ant to a point given in cells. Returns [index, distance²].
  nearest(gx, gy) {
    let best = Infinity, idx = -1;
    for (let a = 0; a < this.col.ants; a++) {
      const dx = this.curX[a] / 256 - gx, dy = this.curY[a] / 256 - gy, d2 = dx * dx + dy * dy;
      if (d2 < best) { best = d2; idx = a; }
    }
    return [idx, best];
  }

  // ---------------------------------------------------------------- scenery
  // True if a prop of radius rad (cells) at (cx, cy) keeps clear of the
  // anthill and of every food pile.
  clearOf(cx, cy, rad, nestR, srcR) {
    const col = this.col;
    if ((cx - NEST_X - 0.5) ** 2 + (cy - NEST_Y - 0.5) ** 2 < (nestR + rad) ** 2) return false;
    for (let s = 0; s < col.n; s++) {
      if ((cx - col.sx[s] - 0.5) ** 2 + (cy - col.sy[s] - 0.5) ** 2 < (srcR + rad) ** 2) return false;
    }
    return true;
  }

  // Try random spots until `count` props are placed. size() gives a radius in cells.
  scatter(r, count, size, nestR, srcR, put) {
    for (let placed = 0, tries = 0; placed < count && tries < count * 20; tries++) {
      const cx = 1 + r() * (W - 2), cy = 1 + r() * (H - 2), rad = size();
      if (!this.clearOf(cx, cy, rad, nestR, srcR)) continue;
      put(cx, cy, rad);
      placed++;
    }
  }

  // The surface: forest-floor soil with moss, leaf litter, twigs, pebbles and
  // grass, then the anthill. Everything stays dark and low-chroma (soil and
  // --scene-* tokens) so option colours and amber pheromone stay the only
  // bright things on the map.
  paintGround() {
    const g = this.ground.getContext("2d"), { S, c } = this;
    const Wp = this.ground.width, Hp = this.ground.height;
    const r = prng(this.col.seed, 0x6a09e667);
    g.setTransform(1, 0, 0, 1, 0, 0);
    g.fillStyle = css(mix(c.soil[950], c.soil[900], 0.7));
    g.fillRect(0, 0, Wp, Hp);

    // Mottled earth, with a few damp olive patches
    for (let i = 0; i < 80; i++) {
      const x = r() * Wp, y = r() * Hp, rad = (2 + r() * 8) * S, p = r();
      const tone = p < 0.5 ? c.soil[800] : p < 0.7 ? c.soil[900] : p < 0.85 ? mix(c.grass, c.soil[900], 0.5) : BLACK;
      const grad = g.createRadialGradient(x, y, 0, x, y, rad);
      grad.addColorStop(0, css(tone, 0.25 + r() * 0.35));
      grad.addColorStop(1, css(tone, 0));
      g.fillStyle = grad;
      g.fillRect(x - rad, y - rad, rad * 2, rad * 2);
    }

    // Grains
    const grains = [[c.soil[600], 0.35], [c.soil[500], 0.14], [c.bone, 0.05], [BLACK, 0.5]];
    for (let i = 0; i < 13000; i++) {
      const p = r(), [tone, alpha] = grains[p < 0.55 ? 0 : p < 0.8 ? 1 : p < 0.93 ? 2 : 3];
      const sz = 1 + r() * 2.2;
      g.fillStyle = css(tone, alpha);
      g.fillRect(r() * Wp, r() * Hp, sz, sz);
    }

    // Moss cushions: a soft base plus dense stipple, lit from the top left
    const lightAng = Math.atan2(LIGHT[1], LIGHT[0]);
    this.scatter(r, 6, () => 1.6 + r() * 2.2, 6.5, 3.5, (cx, cy, rad) => {
      const x = cx * S, y = cy * S, R = rad * S;
      const base = g.createRadialGradient(x, y, 0, x, y, R);
      base.addColorStop(0, css(c.grass, 0.7));
      base.addColorStop(1, css(c.grass, 0));
      g.fillStyle = base;
      g.fillRect(x - R, y - R, R * 2, R * 2);
      for (let i = 0; i < 650; i++) {
        const a = r() * TAU, d = Math.pow(r(), 0.6) * R;
        const lit = 0.5 + 0.5 * Math.cos(a - lightAng);
        g.fillStyle = css(mix(mix(c.grass, BLACK, 0.5), mix(c.grass, c.soil[500], 0.45), lit * (1 - d / R) * 0.8 + r() * 0.35), 0.9);
        g.beginPath(); g.arc(x + Math.cos(a) * d, y + Math.sin(a) * d, 1 + r() * 1.6, 0, TAU); g.fill();
      }
    });

    // Seed husks and bits of litter
    for (let i = 0; i < 110; i++) {
      const x = r() * Wp, y = r() * Hp, len = (0.12 + r() * 0.2) * S;
      g.fillStyle = css(mix(c.leaf, c.soil[500], r() * 0.6), 0.75);
      g.beginPath(); g.ellipse(x, y, len, len * 0.45, r() * TAU, 0, TAU); g.fill();
    }

    // Twigs: branching sticks with a shadow, bark and a lit edge
    g.lineCap = "round";
    this.scatter(r, 5, () => 2.5, 6.5, 4, (cx, cy) => {
      const segs = [];
      this.growRoot(segs, r, cx * S, cy * S, r() * TAU, 2.2 + r() * 2.4, 9 + Math.floor(r() * 12), 1);
      const bark = mix(c.leaf, c.soil[600], 0.3 + r() * 0.3);
      const passes = [
        [(w) => w + 1, BLACK, 0.45, 3, 4],
        [(w) => w + 1.5, mix(bark, BLACK, 0.5), 1, 0, 0],
        [(w) => w, bark, 1, 0, 0],
        [(w) => Math.max(0.7, w * 0.3), mix(bark, c.soil[500], 0.6), 0.7, -0.6, -0.8],
      ];
      for (const [width, tone, alpha, ox, oy] of passes) {
        g.strokeStyle = css(tone, alpha);
        for (const sg of segs) {
          g.lineWidth = width(sg.w);
          g.beginPath(); g.moveTo(sg.x0 + ox, sg.y0 + oy); g.lineTo(sg.x1 + ox, sg.y1 + oy); g.stroke();
        }
      }
    });

    // Fallen leaves
    this.scatter(r, 9, () => 1.5 + r() * 1.3, 6.5, 4, (cx, cy, rad) => this.leaf(g, r, cx * S, cy * S, rad * 2 * S, r() * TAU));

    // Pebbles
    this.scatter(r, 26, () => 0.35 + Math.pow(r(), 2) * 1.1, 5.5, 3.4, (cx, cy, rad) => this.pebble(g, r, cx * S, cy * S, rad * S));

    // Grass tufts on the ground. A few more are kept to draw over the ants.
    this.scatter(r, 30, () => 0.9, 6, 3.2, (cx, cy) => this.drawTuft(g, this.makeTuft(r, cx * S, cy * S, (0.8 + r() * 0.7) * S, 0), 0));
    this.tufts = [];
    this.scatter(r, 9, () => 1.4, 8, 7.5, (cx, cy) => this.tufts.push(this.makeTuft(r, cx * S, cy * S, (1.3 + r() * 0.9) * S, 0.25)));

    this.paintMound(g, r);

    // Vignette
    const v = g.createRadialGradient(Wp / 2, Hp / 2, Wp * 0.3, Wp / 2, Hp / 2, Wp * 0.72);
    v.addColorStop(0, "rgba(0,0,0,0)");
    v.addColorStop(1, "rgba(0,0,0,0.6)");
    g.fillStyle = v;
    g.fillRect(0, 0, Wp, Hp);
  }

  growRoot(segs, r, x, y, ang, w, steps, depth) {
    const step = this.S * 0.55;
    for (let i = 0; i < steps; i++) {
      const x1 = x + Math.cos(ang) * step, y1 = y + Math.sin(ang) * step;
      const wi = w * (1 - i / steps) + 0.6;
      segs.push({ x0: x, y0: y, x1, y1, w: wi });
      x = x1; y = y1;
      ang += (r() - 0.5) * 0.45;
      if (depth < 2 && r() < 0.07) {
        this.growRoot(segs, r, x, y, ang + (r() < 0.5 ? -0.9 : 0.9), wi * 0.6, Math.floor((steps - i) * 0.6), depth + 1);
      }
    }
  }

  // A dead leaf seen from above: shadow, blade folded along the midrib, veins.
  leaf(g, r, x, y, L, ang) {
    const { c } = this, w = L * (0.2 + r() * 0.1);
    const tone = mix(c.leaf, c.soil[600], r() * 0.45);
    const cs = Math.cos(ang), sn = Math.sin(ang);
    const shape = () => {
      g.beginPath();
      g.moveTo(-L / 2, 0);
      g.bezierCurveTo(-L * 0.2, -w * 1.3, L * 0.25, -w * 0.95, L / 2, 0);
      g.bezierCurveTo(L * 0.25, w * 0.95, -L * 0.2, w * 1.3, -L / 2, 0);
      g.closePath();
    };
    g.save();
    g.setTransform(cs, sn, -sn, cs, x + L * 0.05, y + L * 0.08);
    shape(); g.fillStyle = "rgba(0,0,0,0.5)"; g.fill();
    g.setTransform(cs, sn, -sn, cs, x, y);
    const body = g.createLinearGradient(-L / 2, 0, L / 2, 0);
    body.addColorStop(0, css(mix(tone, BLACK, 0.25)));
    body.addColorStop(0.5, css(mix(tone, c.soil[500], 0.18)));
    body.addColorStop(1, css(tone));
    shape(); g.fillStyle = body; g.fill();
    // Fold: the half facing away from the light sits in shade. The leaf's
    // local -y axis points (sn, -cs) on screen.
    const upLit = sn * LIGHT[0] - cs * LIGHT[1] > 0;
    g.save(); shape(); g.clip();
    g.fillStyle = "rgba(0,0,0,0.22)";
    g.fillRect(-L, upLit ? 0 : -L, L * 2, L);
    g.restore();
    shape(); g.strokeStyle = "rgba(0,0,0,0.45)"; g.lineWidth = 1; g.stroke();
    g.strokeStyle = css(mix(tone, c.soil[500], 0.5), 0.8);
    g.lineWidth = 1.4;
    g.beginPath(); g.moveTo(-L * 0.6, 0); g.lineTo(L * 0.46, 0); g.stroke();   // stem and midrib
    g.lineWidth = 0.8;
    g.beginPath();
    for (let i = 1; i <= 5; i++) {
      const vx = -L / 2 + (i / 6.2) * L, reach = Math.sin((i / 6) * Math.PI) * w * 0.85;
      for (const sd of [-1, 1]) { g.moveTo(vx, 0); g.lineTo(vx + L * 0.11, sd * reach); }
    }
    g.stroke();
    g.restore();
  }

  pebble(g, r, x, y, rad) {
    const pts = [], k = 9;
    for (let i = 0; i < k; i++) {
      const a = (i / k) * TAU, d = rad * (0.78 + r() * 0.3);
      pts.push([x + Math.cos(a) * d, y + Math.sin(a) * d * (0.75 + r() * 0.1)]);
    }
    const path = (dx, dy) => {
      g.beginPath();
      pts.forEach(([px, py], i) => (i ? g.lineTo(px + dx, py + dy) : g.moveTo(px + dx, py + dy)));
      g.closePath();
    };
    path(rad * 0.12, rad * 0.2);
    g.fillStyle = "rgba(0,0,0,0.55)";
    g.fill();
    path(0, 0);
    const { soil } = this.c;
    g.fillStyle = css(mix(soil[700], soil[600], r()));
    g.fill();
    const hl = g.createRadialGradient(x - rad * 0.35, y - rad * 0.4, 0, x, y, rad);
    hl.addColorStop(0, css(this.c.bone, 0.13));
    hl.addColorStop(1, css(this.c.bone, 0));
    g.fillStyle = hl;
    g.fill();
    g.strokeStyle = "rgba(0,0,0,0.35)";
    g.lineWidth = 1;
    g.stroke();
  }

  // Grass seen from above: blades fan out from a base. lift lightens tufts
  // that stand over the ants and pushes their shadow further out.
  makeTuft(r, x, y, size, lift) {
    const blades = [], n = 6 + Math.floor(r() * 6), lean = r() * TAU;
    for (let i = 0; i < n; i++) {
      blades.push({
        ang: lean + (r() - 0.5) * 3.4, len: size * (0.55 + r() * 0.55),
        bend: (r() - 0.5) * 0.9, w: (0.07 + r() * 0.06) * this.S, k: r(),
      });
    }
    return { x, y, blades, lift, phase: r() * TAU };
  }

  drawTuft(g, t, sway) {
    const { c, S } = this, base = mix(mix(c.grass, BLACK, 0.2), c.soil[500], t.lift);
    const tip = mix(c.grass, c.soil[500], 0.3 + t.lift);
    const path = (b, ox, oy) => {
      const a1 = b.ang + b.bend * 0.5 + sway * 0.5, a2 = b.ang + b.bend + sway;
      g.moveTo(t.x + ox, t.y + oy);
      g.quadraticCurveTo(t.x + ox + Math.cos(a1) * b.len * 0.55, t.y + oy + Math.sin(a1) * b.len * 0.55,
        t.x + ox + Math.cos(a2) * b.len, t.y + oy + Math.sin(a2) * b.len);
    };
    g.lineCap = "round";
    g.strokeStyle = "rgba(0,0,0,0.4)";                   // shadow on the ground
    g.lineWidth = S * 0.14;
    g.beginPath();
    for (const b of t.blades) path(b, S * 0.12 * (1 + t.lift * 3), S * 0.18 * (1 + t.lift * 3));
    g.stroke();
    for (const b of t.blades) {
      g.strokeStyle = css(mix(base, tip, b.k));
      g.lineWidth = b.w;
      g.beginPath(); path(b, 0, 0); g.stroke();
    }
  }

  // The anthill: a crater mound of excavated subsoil, lighter than the
  // topsoil, lit from the top left, with a cast shadow and a dark bowl.
  paintMound(g, r) {
    const { S, c } = this, nx = (NEST_X + 0.5) * S, ny = (NEST_Y + 0.5) * S;
    const R = MOUND_R * S, rc = 0.34;                    // crater radius as a share of R
    const sand = mix(mix(c.soil[600], c.soil[500], 0.5), c.amberLo, 0.06);

    let gr = g.createRadialGradient(nx + 0.6 * S, ny + 0.8 * S, R * 0.5, nx + 0.6 * S, ny + 0.8 * S, R * 1.2);
    gr.addColorStop(0, "rgba(0,0,0,0.6)");
    gr.addColorStop(1, "rgba(0,0,0,0)");
    g.fillStyle = gr;
    g.fillRect(nx - 2 * R, ny - 2 * R, 4 * R, 4 * R);

    gr = g.createRadialGradient(nx, ny, 0, nx, ny, R * 1.08);
    gr.addColorStop(0, css(sand, 0.95));
    gr.addColorStop(0.75, css(mix(sand, c.soil[700], 0.3), 0.9));
    gr.addColorStop(1, css(c.soil[700], 0));
    g.fillStyle = gr;
    g.beginPath(); g.arc(nx, ny, R * 1.08, 0, TAU); g.fill();
    gr = g.createLinearGradient(nx - R, ny - R, nx + R, ny + R);
    gr.addColorStop(0, css(c.bone, 0.12));
    gr.addColorStop(0.5, "rgba(0,0,0,0)");
    gr.addColorStop(1, "rgba(0,0,0,0.3)");
    g.fillStyle = gr;
    g.beginPath(); g.arc(nx, ny, R, 0, TAU); g.fill();

    // Height: a bowl inside rc, a dome falling to 0 at the rim. Lambert shading.
    const lightOf = (u, a) => {
      const s = u < rc ? (2 * u) / (rc * rc) : (-2 * (u - rc)) / ((1 - rc) * (1 - rc));
      const nxv = -s * Math.cos(a), nyv = -s * Math.sin(a), len = Math.hypot(nxv, nyv, 1);
      return Math.max(0, (nxv * LIGHT[0] + nyv * LIGHT[1] + LIGHT[2]) / len);
    };
    for (let i = 0; i < 5200; i++) {
      const a = r() * TAU, u = Math.sqrt(r()) * 1.14;
      if (u > 1 && r() < 0.55) continue;                 // spill thins out past the rim
      const lit = lightOf(Math.min(u, 1), a);
      const deep = u < rc ? 0.35 + 0.65 * (u / rc) : 1;
      const soilTone = mix(sand, c.soil[700], r() * 0.45);
      const tone = lit > 0.6 ? mix(soilTone, c.bone, (lit - 0.6) * 0.8) : mix(soilTone, BLACK, (0.6 - lit) * 0.75);
      g.fillStyle = css(mix(tone, BLACK, 1 - deep), 0.92);
      const sz = (0.08 + r() * 0.1) * S;
      g.beginPath(); g.ellipse(nx + Math.cos(a) * u * R, ny + Math.sin(a) * u * R, sz, sz * 0.8, r() * TAU, 0, TAU); g.fill();
    }

    // Bowl shade toward the entrance
    gr = g.createRadialGradient(nx, ny, 0, nx, ny, rc * R * 1.25);
    gr.addColorStop(0, "rgba(0,0,0,0.6)");
    gr.addColorStop(1, "rgba(0,0,0,0)");
    g.fillStyle = gr;
    g.beginPath(); g.arc(nx, ny, rc * R * 1.25, 0, TAU); g.fill();

    // Thatch: bits of plant the workers dragged onto the mound
    g.lineCap = "round";
    for (let i = 0; i < 34; i++) {
      const a = r() * TAU, u = rc + 0.1 + r() * 0.75, len = (0.25 + r() * 0.4) * S, b = r() * TAU;
      const x = nx + Math.cos(a) * u * R, y = ny + Math.sin(a) * u * R;
      g.strokeStyle = css(mix(r() < 0.5 ? c.leaf : c.grass, c.soil[500], 0.2 + r() * 0.3), 0.9);
      g.lineWidth = 1 + r() * 1.2;
      g.beginPath(); g.moveTo(x, y); g.lineTo(x + Math.cos(b) * len, y + Math.sin(b) * len); g.stroke();
    }
  }

  // Packed earth for the roads: smoother and lighter than the topsoil.
  paintRoadTexture() {
    const g = this.roadTex.getContext("2d"), { c, S } = this;
    const Wp = this.roadTex.width, Hp = this.roadTex.height;
    const r = prng(this.col.seed, 0x510e527f);
    g.fillStyle = css(mix(c.soil[600], c.soil[500], 0.26));
    g.fillRect(0, 0, Wp, Hp);
    for (let i = 0; i < 60; i++) {
      const x = r() * Wp, y = r() * Hp, rad = (1 + r() * 4) * S;
      const grad = g.createRadialGradient(x, y, 0, x, y, rad);
      const tone = r() < 0.5 ? c.soil[700] : c.soil[500];
      grad.addColorStop(0, css(tone, 0.25));
      grad.addColorStop(1, css(tone, 0));
      g.fillStyle = grad;
      g.fillRect(x - rad, y - rad, rad * 2, rad * 2);
    }
    // Grit, then small stones the ants walk around
    for (let i = 0; i < 16000; i++) {
      const p = r();
      g.fillStyle = p < 0.5 ? css(c.soil[700], 0.55) : p < 0.8 ? css(BLACK, 0.3) : css(c.bone, 0.08);
      g.fillRect(r() * Wp, r() * Hp, 1 + r() * 1.6, 1 + r() * 1.6);
    }
    for (let i = 0; i < 260; i++) {
      const x = r() * Wp, y = r() * Hp, rad = (0.06 + r() * 0.1) * S;
      g.fillStyle = "rgba(0,0,0,0.4)";
      g.beginPath(); g.arc(x + rad * 0.3, y + rad * 0.45, rad, 0, TAU); g.fill();
      g.fillStyle = css(mix(c.soil[600], c.soil[500], 0.3 + r() * 0.5));
      g.beginPath(); g.arc(x, y, rad, 0, TAU); g.fill();
    }
  }

  // Rebuild the road layer from wear. Runs once per tick, not per frame.
  updateRoads() {
    const { wear, roadA, roadK, nestFade } = this;
    // Widen each road by two cells on either side (5x5 max with falloff) so
    // the packed earth shows past the pheromone glow running down its middle.
    const { roadW } = this;
    for (let i = 0; i < W * H; i++) roadW[i] = smooth(ROAD_LO, ROAD_HI, wear[i]);
    for (let cy = 0; cy < H; cy++) for (let cx = 0; cx < W; cx++) {
      let k = 0;
      for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) {
        const x = cx + dx, y = cy + dy;
        if (x < 0 || x >= W || y < 0 || y >= H) continue;
        const v = roadW[y * W + x] * ROAD_SPREAD[dx * dx + dy * dy];
        if (v > k) k = v;
      }
      roadK[cy * W + cx] = k;
    }
    // Bilinear upsample (cell centres at (i + 0.5) * RS), then blur, so the
    // verges come out as curves rather than cell steps.
    for (let y = 0; y < RH; y++) {
      const fy = Math.min(H - 1, Math.max(0, (y + 0.5) / RS - 0.5)), y0 = Math.floor(fy), y1 = Math.min(H - 1, y0 + 1), ty = fy - y0;
      for (let x = 0; x < RW; x++) {
        const fx = Math.min(W - 1, Math.max(0, (x + 0.5) / RS - 0.5)), x0 = Math.floor(fx), x1 = Math.min(W - 1, x0 + 1), tx = fx - x0;
        const top = roadK[y0 * W + x0] * (1 - tx) + roadK[y0 * W + x1] * tx;
        const bot = roadK[y1 * W + x0] * (1 - tx) + roadK[y1 * W + x1] * tx;
        const p = y * RW + x;
        roadA[p] = (top * (1 - ty) + bot * ty) * nestFade[p];
      }
    }
    for (let i = 0; i < 3; i++) blur3(roadA, this.roadTmp, RW, RH);
    const d = this.roadImg.data;
    // Re-sharpen after the blur: crisp verges read as a path, not a haze.
    for (let p = 0; p < RW * RH; p++) d[p * 4 + 3] = smooth(0.3, 0.62, roadA[p]) * 255;
    this.roadMaskCtx.putImageData(this.roadImg, 0, 0);
    const g = this.roadCtx;
    g.globalCompositeOperation = "copy";
    g.imageSmoothingEnabled = true;
    g.drawImage(this.roadMask, 0, 0, this.road.width, this.road.height);
    g.globalCompositeOperation = "source-in";
    g.drawImage(this.roadTex, 0, 0);
    g.globalCompositeOperation = "source-over";
    this.roadT = this.col.t;
  }

  // A worn path sits a little below the soil: its top-left wall is in shade.
  drawRoads() {
    const { ctx, S, cv } = this;
    if (this.roadT !== this.col.t) this.updateRoads();
    ctx.globalAlpha = 0.5;
    ctx.drawImage(this.roadMask, -0.15 * S, -0.2 * S, cv.width, cv.height);
    ctx.globalAlpha = 0.9;
    ctx.drawImage(this.road, 0, 0);
    ctx.globalAlpha = 1;
  }

  paintProps() {
    const g = this.props.getContext("2d"), { S, c } = this, col = this.col;
    const r = prng(col.seed, 0x3c6ef372);
    g.clearRect(0, 0, this.props.width, this.props.height);

    // Nest entrance, over the pheromone so it always reads as a hole. Its
    // inner wall catches light on the far (bottom-right) side.
    const nx = (NEST_X + 0.5) * S, ny = (NEST_Y + 0.5) * S;
    const hole = g.createRadialGradient(nx - 0.08 * S, ny - 0.1 * S, 0, nx, ny, 0.95 * S);
    hole.addColorStop(0, "#000");
    hole.addColorStop(0.7, "rgba(0,0,0,0.95)");
    hole.addColorStop(1, "rgba(0,0,0,0)");
    g.fillStyle = hole;
    g.beginPath(); g.ellipse(nx, ny, 0.95 * S, 0.85 * S, 0, 0, TAU); g.fill();
    g.strokeStyle = css(mix(c.soil[500], c.bone, 0.3), 0.5);
    g.lineWidth = 2;
    g.beginPath(); g.ellipse(nx, ny, 0.72 * S, 0.62 * S, 0, -0.15 * Math.PI, 0.65 * Math.PI); g.stroke();

    // Food piles: crumbs in the option colour, more crumbs for richer food.
    // The pile covers the pickup radius, so an ant touching it picks up.
    for (let s = 0; s < col.n; s++) {
      const color = c.opt[this.optOf(s)];
      const x = (col.sx[s] + 0.5) * S, y = (col.sy[s] + 0.5) * S;
      const glow = g.createRadialGradient(x, y, 0, x, y, 3.2 * S);
      glow.addColorStop(0, css(color, 0.22));
      glow.addColorStop(1, css(color, 0));
      g.fillStyle = glow;
      g.fillRect(x - 3.2 * S, y - 3.2 * S, 6.4 * S, 6.4 * S);
      g.fillStyle = "rgba(0,0,0,0.45)";
      g.beginPath(); g.ellipse(x + 0.15 * S, y + 0.3 * S, 1.9 * S, 1.45 * S, 0, 0, TAU); g.fill();

      const count = 14 + Math.floor((col.rich[s] - 179) / 8);
      const crumbs = [];
      for (let i = 0; i < count; i++) {
        const a = r() * TAU, d = Math.sqrt(r()) * 1.55 * S;
        crumbs.push([x + Math.cos(a) * d, y + Math.sin(a) * d * 0.85, r(), r(), r()]);
      }
      crumbs.sort((p, q) => p[1] - q[1]);
      for (const [cx, cy, k1, k2, k3] of crumbs) {
        const rx = (0.26 + k1 * 0.16) * S, ry = (0.18 + k2 * 0.1) * S;
        g.fillStyle = css(k3 < 0.75 ? mix(color, BLACK, k3 * 0.45) : mix(color, WHITE, (k3 - 0.75) * 0.6));
        g.beginPath(); g.ellipse(cx, cy, rx, ry, k1 * TAU, 0, TAU); g.fill();
        g.strokeStyle = "rgba(0,0,0,0.35)"; g.lineWidth = 1; g.stroke();
        g.fillStyle = "rgba(255,255,255,0.22)";
        g.beginPath(); g.ellipse(cx - rx * 0.3, cy - ry * 0.35, rx * 0.35, ry * 0.3, 0, 0, TAU); g.fill();
      }
    }
  }

  // ---------------------------------------------------------------- frame
  // Draw one frame. frac (0..1) places ants between the last two ticks.
  // Returns true while effects are still running and want more frames.
  draw(frac = 1, now = performance.now()) {
    const { ctx, col } = this;
    if (this.still) frac = 1;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.globalAlpha = 1;
    ctx.globalCompositeOperation = "source-over";
    const cells = this.mode === "cells";
    if (cells) this.drawGrid(); else { ctx.drawImage(this.ground, 0, 0); this.drawRoads(); }
    this.drawPheromone(cells);
    const lead = leadingSource(col.scores()), done = col.t === col.ticks;
    this.drawRings(now, lead);
    ctx.drawImage(this.props, 0, 0);
    this.drawTrail();
    this.drawAnts(frac);
    if (!cells) this.drawOverGrass(now);
    const busy = this.drawParticles(now);
    this.drawSelection(frac, now);
    const partying = this.drawParty(now);
    this.drawBadges(lead, done);
    return busy || partying;
  }

  drawGrid() {
    const { ctx, S, cv } = this;
    ctx.fillStyle = css(this.c.soil[950]);
    ctx.fillRect(0, 0, cv.width, cv.height);
    ctx.fillStyle = css(this.c.bone, 0.05);
    for (let x = 0; x < W; x++) for (let y = 0; y < H; y++) ctx.fillRect((x + 0.5) * S - 1, (y + 0.5) * S - 1, 2, 2);
  }

  // Strong cells run hot (amber-300), weak ones cool (amber-600).
  drawPheromone(cells) {
    const { ctx, cv, col, c } = this, d = this.phImg.data;
    for (let i = 0, j = 0; i < W * H; i++, j += 4) {
      const v = col.cell(i);
      if (!v) { d[j + 3] = 0; continue; }
      const k = Math.sqrt(v / CAP);
      d[j] = c.amberLo[0] + (c.amberHi[0] - c.amberLo[0]) * k;
      d[j + 1] = c.amberLo[1] + (c.amberHi[1] - c.amberLo[1]) * k;
      d[j + 2] = c.amberLo[2] + (c.amberHi[2] - c.amberLo[2]) * k;
      d[j + 3] = k * (cells ? 235 : 180 * this.moundFade[i]);
    }
    this.phCtx.putImageData(this.phImg, 0, 0);
    ctx.imageSmoothingEnabled = !cells;
    ctx.imageSmoothingQuality = "high";
    ctx.drawImage(this.ph, 0, 0, cv.width, cv.height);
    if (!cells) {
      // Bloom: a half-size copy, scaled up and added on top.
      this.glowCtx.clearRect(0, 0, this.glow.width, this.glow.height);
      this.glowCtx.drawImage(this.ph, 0, 0, this.glow.width, this.glow.height);
      ctx.globalCompositeOperation = "lighter";
      ctx.globalAlpha = 0.26;
      ctx.drawImage(this.glow, 0, 0, cv.width, cv.height);
      ctx.globalCompositeOperation = "source-over";
      ctx.globalAlpha = 1;
    }
    ctx.imageSmoothingEnabled = true;
  }

  // Scoring rings. Dashes march while playing; the leader's ring is brighter.
  drawRings(now, lead) {
    const { ctx, S, col, c } = this, R = Math.sqrt(SCORE_RADIUS_SQ) * S;
    ctx.setLineDash([S * 0.6, S * 0.45]);
    ctx.lineDashOffset = this.still ? 0 : -now / 40;
    for (let s = 0; s < col.n; s++) {
      const color = c.opt[this.optOf(s)];
      const x = (col.sx[s] + 0.5) * S, y = (col.sy[s] + 0.5) * S;
      ctx.fillStyle = css(color, 0.045);
      ctx.strokeStyle = css(color, s === lead ? 0.9 : 0.45);
      ctx.lineWidth = s === lead ? 3 : 2;
      ctx.beginPath(); ctx.arc(x, y, R, 0, TAU); ctx.fill(); ctx.stroke();
    }
    ctx.setLineDash([]);
  }

  // Fading dots along the selected ant's last few ticks.
  drawTrail() {
    const { ctx, S } = this, a = this.selected, n = this.histLen, t = this.col.t;
    if (n < 2 || a < 0) return;
    ctx.fillStyle = css(this.c.bone);
    for (let k = n - 1; k >= 1; k--) {
      const slot = (((t - k) % TRAIL) + TRAIL) % TRAIL;
      ctx.globalAlpha = 0.55 * (1 - k / n);
      ctx.beginPath();
      ctx.arc((this.histX[a * TRAIL + slot] / 256) * S, (this.histY[a * TRAIL + slot] / 256) * S, S * 0.16, 0, TAU);
      ctx.fill();
    }
    ctx.globalAlpha = 1;
  }

  drawAnts(frac) {
    const { col } = this, turn = Math.min(1, frac * 2.5);
    // Foragers first, so ants carrying food draw on top.
    for (const pass of [0, 1]) {
      for (let a = 0; a < col.ants; a++) {
        if (col.returning[a] !== pass) continue;
        const [x, y] = this.pos(a, frac);
        const a0 = (this.prevH[a] * Math.PI) / 8;
        let d = (this.curH[a] * Math.PI) / 8 - a0;
        d = ((d + 3 * Math.PI) % TAU) - Math.PI;
        const moved = this.curX[a] !== this.prevX[a] || this.curY[a] !== this.prevY[a];
        const phase = (this.gait[a] - (moved ? 1 - frac : 0)) * Math.PI;
        this.ant(x, y, a0 + d * turn, phase, pass ? this.c.opt[this.optOf(this.carry[a])] : null);
      }
    }
    this.ctx.setTransform(1, 0, 0, 1, 0, 0);
  }

  // Tall grass at the map edges stands over the ants and sways while playing.
  drawOverGrass(now) {
    for (const t of this.tufts) {
      this.drawTuft(this.ctx, t, this.still ? 0 : Math.sin(now / 1300 + t.phase) * 0.07);
    }
  }

  // One ant: dark halo for contrast, six legs in a tripod gait, antennae,
  // bone body. A returning ant holds a crumb from the pile it visited.
  ant(x, y, ang, phase, crumb) {
    const { ctx } = this, k = this.S * ANT_SCALE;
    const cs = Math.cos(ang) * k, sn = Math.sin(ang) * k, lw = 1.7 / k;
    const swing = this.still ? 0 : 0.2;
    ctx.setTransform(cs, sn, -sn, cs, x, y);

    ctx.fillStyle = "rgba(8,6,4,0.55)";
    ctx.beginPath(); ctx.ellipse(-0.15, 0, 1.15, 0.64, 0, 0, TAU); ctx.fill();

    ctx.strokeStyle = css(this.c.boneMuted, 0.9);
    ctx.lineWidth = lw;
    ctx.lineCap = "round";
    ctx.lineJoin = "round";
    ctx.beginPath();
    for (let i = 0; i < 3; i++) {
      for (const sd of [-1, 1]) {
        const sw = Math.sin(phase + ((i + (sd > 0 ? 1 : 0)) & 1) * Math.PI) * swing;
        ctx.moveTo(HIP[i], sd * 0.08);
        ctx.lineTo(KNEE[i] + sw * 0.5, sd * 0.38);
        ctx.lineTo(FOOT[i] + sw, sd * 0.62);
      }
    }
    const wig = this.still ? 0 : Math.sin(phase * 0.5) * 0.06;
    for (const sd of [-1, 1]) {
      ctx.moveTo(0.58, sd * 0.06);
      ctx.lineTo(0.82, sd * 0.22);
      ctx.lineTo(1.05, sd * (0.3 + wig));
    }
    ctx.stroke();

    ctx.fillStyle = css(this.c.bone, 0.95);
    ctx.beginPath();
    ctx.moveTo(-0.12, 0); ctx.ellipse(-0.58, 0, 0.46, 0.32, 0, 0, TAU);       // gaster
    ctx.moveTo(-0.03, 0); ctx.arc(-0.1, 0, 0.07, 0, TAU);                    // petiole
    ctx.moveTo(0.24, 0); ctx.ellipse(0.04, 0, 0.2, 0.12, 0, 0, TAU);         // thorax
    ctx.moveTo(0.65, 0); ctx.ellipse(0.46, 0, 0.19, 0.17, 0, 0, TAU);        // head
    ctx.fill();
    ctx.fillStyle = "rgba(255,255,255,0.2)";
    ctx.beginPath(); ctx.ellipse(-0.66, -0.1, 0.2, 0.1, 0, 0, TAU); ctx.fill();

    if (crumb) {
      ctx.fillStyle = css(crumb);
      ctx.strokeStyle = "rgba(0,0,0,0.55)";
      ctx.lineWidth = lw * 0.8;
      ctx.beginPath(); ctx.arc(0.86, 0, 0.24, 0, TAU); ctx.fill(); ctx.stroke();
    }
  }

  drawSelection(frac, now) {
    const { ctx, S } = this;
    const pulse = this.still ? 0 : Math.sin(now / 260) * 0.12 * S;
    if (this.hover >= 0 && this.hover !== this.selected) {
      const [hx, hy] = this.pos(this.hover, frac);
      ctx.strokeStyle = css(this.c.bone, 0.4);
      ctx.lineWidth = 2;
      ctx.beginPath(); ctx.arc(hx, hy, 1.2 * S, 0, TAU); ctx.stroke();
    }
    if (this.selected < 0) return; // -1: no ant followed
    const [x, y] = this.pos(this.selected, frac);
    ctx.strokeStyle = css(this.c.bone, 0.95);
    ctx.lineWidth = 3;
    ctx.beginPath(); ctx.arc(x, y, 1.35 * S + pulse, 0, TAU); ctx.stroke();
  }

  // Labels over each pile: glyph and menu value, so the map reads without
  // the legend. The leader gets a full-colour border, the winner a check.
  drawBadges(lead, done) {
    const { ctx, S, col, c, cv } = this;
    ctx.font = `600 ${Math.round(S * 1.4)}px ${this.font}`;
    ctx.textBaseline = "middle";
    ctx.textAlign = "left";
    for (let s = 0; s < col.n; s++) {
      const o = this.optOf(s), color = c.opt[o];
      const won = done && s === lead;
      const text = this.labels[o] + (won ? "  ✓ wins" : "");
      const gw = ctx.measureText(this.glyphs[o] + " ").width;
      const w = gw + ctx.measureText(text).width + S * 1.3, h = S * 2;
      let x = (col.sx[s] + 0.5) * S, y = (col.sy[s] + 0.5) * S - 3.3 * S;
      if (col.sy[s] < 8) y += 6.6 * S;
      x = Math.min(Math.max(x, w / 2 + 6), cv.width - w / 2 - 6);
      ctx.fillStyle = "rgba(13,10,7,0.86)";
      ctx.strokeStyle = css(color, s === lead ? 1 : 0.5);
      ctx.lineWidth = s === lead ? 3 : 1.5;
      if (won) { ctx.shadowColor = css(color, 0.9); ctx.shadowBlur = 18; }
      ctx.beginPath(); ctx.roundRect(x - w / 2, y - h / 2, w, h, h / 2); ctx.fill();
      ctx.shadowBlur = 0;
      ctx.stroke();
      ctx.fillStyle = css(color);
      ctx.fillText(this.glyphs[o], x - w / 2 + S * 0.65, y + 1);
      ctx.fillStyle = css(c.bone);
      ctx.fillText(text, x - w / 2 + S * 0.65 + gw, y + 1);
    }
  }

  // ---------------------------------------------------------------- effects
  pop(a) {
    const [x, y] = this.pos(a, 1), color = this.c.opt[this.optOf(this.carry[a])];
    for (let i = 0; i < 4; i++) {
      const ang = Math.random() * TAU, dist = (0.8 + Math.random()) * this.S;
      this.spawn({ kind: "crumb", x, y, dx: Math.cos(ang) * dist, dy: Math.sin(ang) * dist, life: 450 + Math.random() * 250, color, size: 0.14 * this.S });
    }
  }

  sink(a) {
    const [x, y] = this.pos(a, 1), S = this.S;
    this.spawn({ kind: "sink", x, y, dx: (NEST_X + 0.5) * S - x, dy: (NEST_Y + 0.5) * S - y, life: 420, color: this.c.opt[this.optOf(this.carry[a])], size: 0.24 * S });
  }

  celebrate() {
    const s = leadingSource(this.col.scores());
    if (s < 0) return;
    const S = this.S, x = (this.col.sx[s] + 0.5) * S, y = (this.col.sy[s] + 0.5) * S, o = this.optOf(s);
    this.party = { s, t0: performance.now() };
    for (let i = 0; i < 18; i++) {
      const ang = (i / 18) * TAU + Math.random() * 0.3, dist = (5 + Math.random() * 5) * S;
      this.spawn({ kind: "glyph", x, y, dx: Math.cos(ang) * dist, dy: Math.sin(ang) * dist, life: 1300 + Math.random() * 400, color: this.c.opt[o], size: S * (0.9 + Math.random() * 0.6), text: this.glyphs[o] });
    }
  }

  spawn(p) {
    if (this.particles.length >= MAX_PARTICLES) this.particles.shift();
    p.t0 = performance.now();
    this.particles.push(p);
  }

  drawParticles(now) {
    const { ctx } = this;
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    this.particles = this.particles.filter((p) => now - p.t0 < p.life);
    for (const p of this.particles) {
      const u = Math.max(0, (now - p.t0) / p.life), ease = 1 - (1 - u) * (1 - u);
      const x = p.x + p.dx * ease, y = p.y + p.dy * ease;
      ctx.globalAlpha = p.kind === "sink" ? 1 - u * 0.5 : 1 - u;
      ctx.fillStyle = css(p.color);
      if (p.kind === "glyph") {
        ctx.font = `${Math.round(p.size)}px ${this.font}`;
        ctx.fillText(p.text, x, y);
      } else {
        const r = p.kind === "sink" ? p.size * (1 - u) : p.size * (1 - u * 0.5);
        ctx.beginPath(); ctx.arc(x, y, Math.max(0.5, r), 0, TAU); ctx.fill();
      }
    }
    ctx.globalAlpha = 1;
    return this.particles.length > 0;
  }

  // Winner: three rings ripple out of the winning pile.
  drawParty(now) {
    if (!this.party) return false;
    const u = (now - this.party.t0) / PARTY_MS;
    if (u >= 1) { this.party = null; return false; }
    const { ctx, S, col } = this, s = this.party.s, color = this.c.opt[this.optOf(s)];
    const x = (col.sx[s] + 0.5) * S, y = (col.sy[s] + 0.5) * S;
    for (let j = 0; j < 3; j++) {
      const k = u * 1.5 - j * 0.2;
      if (k <= 0 || k >= 1) continue;
      ctx.strokeStyle = css(color, (1 - k) * 0.85);
      ctx.lineWidth = 6 * (1 - k) + 1;
      ctx.beginPath(); ctx.arc(x, y, (2 + k * 13) * S, 0, TAU); ctx.stroke();
    }
    return true;
  }
}
