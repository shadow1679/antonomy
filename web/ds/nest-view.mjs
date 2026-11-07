// The nest cutaway (docs/NEST_PAGE.md): the whole project drawn as one ant
// base, in the colony map's own style. Loam strata, roots and pebbles from
// the shared painters (earth-paint.mjs); chambers and tunnels carved into
// it, lit from the top left; brown ants walking the tunnels for every flow.
// Pure view: it draws a nest model (nest.mjs deriveNest) and never touches
// the sim. Scenery comes from its own fixed PRNG, so the nest looks the same
// on every visit.

import { TAU, BLACK, tok, rgb, css, mix, layer, prng, earthColors, drawAnt, pebble, growRoot, strokeSegs, makeTuft, drawTuft } from "./earth-paint.mjs";
import { LAYOUTS, FLOWS, AMBIENT, pathOf, pointAt } from "../nest.mjs";

const SEED = [0x41, 0x4e, 0x54, 0x4f];   // "ANTO"
const SPEED = 4.2;                        // ant pace in nest units per second
const ANT_K = 0.8;                        // ant size: nest units per body unit
// A faint glow of lit earth under each ant, so brown ants read in the dark bores.
const HALO = "rgba(196,170,132,0.3)";
const TUNNEL = 2.1;                       // tunnel bore in nest units
// Eggs: pale and low-chroma, so they never read as an option colour.
const EGG = { blue: [184, 208, 232], pink: [236, 196, 212], bone: [239, 230, 216] };

export class NestView {
  constructor(canvas) {
    this.cv = canvas;
    this.ctx = canvas.getContext("2d");
    this.c = {
      ...earthColors(),
      sky: rgb(tok("--soil-900")), skyLow: rgb(tok("--soil-800")),
      opt: [0, 1, 2, 3, 4].map((i) => rgb(tok(`--opt-${i}`))),
      glyphs: [0, 1, 2, 3, 4].map((i) => tok(`--opt-${i}-glyph`).replace(/"/g, "")),
      ok: rgb(tok("--ok")), fault: rgb(tok("--fault")), hold: rgb(tok("--bone-300")),
    };
    this.font = tok("--font-mono");
    this.motion = matchMedia("(prefers-reduced-motion: reduce)");
    this.model = null;
    this.hover = null;      // chamber id ringed (hover or focus), or null
    this.verify = null;     // "running" | "match" | "mismatch" | null: the queen's newest egg
    this.ants = [];         // ants walking a flow
    this.idle = [];         // ants pottering in a chamber
    this.sparks = [];
    this.nextAt = {};       // flow -> time its next ambient ant sets off
    this.last = 0;
  }

  get still() { return this.motion.matches; }

  // Pick a layout and a scale (pixels per nest unit). Repaints the scenery
  // only when either changes. Returns true if it did.
  setLayout(name, S) {
    if (this.name === name && this.S === S) return false;
    this.name = name; this.S = S; this.L = LAYOUTS[name];
    this.cv.width = this.L.w * S; this.cv.height = this.L.h * S;
    this.paths = Object.fromEntries(Object.entries(this.L.flows).map(([k, pts]) => [k, pathOf(pts)]));
    this.scene = layer(this.cv.width, this.cv.height);
    this.contents = layer(this.cv.width, this.cv.height);
    this.paintScene();
    this.contentsKey = "";
    this.paintContents();
    this.ants = [];
    this.nextAt = {};
    this.idleKey = "";
    this.seedIdle();
    if (this.still) this.placeStill();
    return true;
  }

  setModel(model) {
    this.model = model;
    this.paintContents();
    this.seedIdle();
  }

  // Send n ants down a flow, a little apart.
  burst(flow, n = 3) {
    if (!this.paths?.[flow] || this.still) return;
    for (let i = 0; i < n; i++) this.ants.push(this.mover(flow, -i * 1.8, false));
  }

  // ---------------------------------------------------------------- scenery

  paintScene() {
    const g = this.scene.getContext("2d"), { S, L, c } = this;
    const Wp = this.cv.width, Hp = this.cv.height, G = L.ground * S;
    const r = prng(SEED, this.name === "wide" ? 0x6a09e667 : 0x3c6ef372);

    // Sky: the page's dark, a little warmer at the horizon.
    let gr = g.createLinearGradient(0, 0, 0, G);
    gr.addColorStop(0, css(c.sky));
    gr.addColorStop(1, css(mix(c.skyLow, c.soil[950], 0.3)));
    g.fillStyle = gr;
    g.fillRect(0, 0, Wp, G);

    // Earth: dark topsoil, loam, darker again at depth.
    gr = g.createLinearGradient(0, G, 0, Hp);
    gr.addColorStop(0, css(mix(c.soil[950], BLACK, 0.35)));
    gr.addColorStop(0.1, css(c.soil[950]));
    gr.addColorStop(0.5, css(c.soil[900]));
    gr.addColorStop(1, css(mix(c.soil[950], BLACK, 0.32)));
    g.fillStyle = gr;
    g.fillRect(0, G, Wp, Hp - G);

    g.save();
    g.beginPath(); g.rect(0, G, Wp, Hp - G); g.clip();
    // Strata: soft wavy bands
    for (let i = 0; i < 8; i++) {
      const y = G + ((i + 0.4) / 8) * (Hp - G) + (r() - 0.5) * S * 3;
      const amp = S * (0.5 + r() * 1.3), ph = r() * TAU, f = ((1 + r() * 2) * TAU) / Wp, th = S * (1.4 + r() * 2.6);
      g.beginPath();
      for (let x = 0; x <= Wp + S; x += S) { const yy = y + Math.sin(x * f + ph) * amp; x ? g.lineTo(x, yy) : g.moveTo(x, yy); }
      for (let x = Wp + S; x >= 0; x -= S) g.lineTo(x, y + th + Math.sin(x * f + ph + 0.7) * amp);
      g.closePath();
      g.fillStyle = css(r() < 0.55 ? c.soil[800] : mix(c.soil[950], BLACK, 0.3), 0.16 + r() * 0.14);
      g.fill();
    }
    // Mottle
    for (let i = 0; i < 70; i++) {
      const x = r() * Wp, y = G + r() * (Hp - G), rad = (2 + r() * 7) * S, p = r();
      const tone = p < 0.45 ? c.soil[800] : p < 0.7 ? c.soil[950] : p < 0.8 ? mix(c.grass, c.soil[900], 0.6) : BLACK;
      const m = g.createRadialGradient(x, y, 0, x, y, rad);
      m.addColorStop(0, css(tone, 0.18 + r() * 0.25));
      m.addColorStop(1, css(tone, 0));
      g.fillStyle = m;
      g.fillRect(x - rad, y - rad, rad * 2, rad * 2);
    }
    // Grains
    const grains = [[c.soil[600], 0.35], [c.soil[500], 0.18], [c.bone, 0.06], [BLACK, 0.4]];
    const count = Math.round((14000 * Wp * (Hp - G)) / (1440 * 960));
    for (let i = 0; i < count; i++) {
      const p = r(), [tone, alpha] = grains[p < 0.5 ? 0 : p < 0.75 ? 1 : p < 0.88 ? 2 : 3];
      const sz = 1 + r() * 2;
      g.fillStyle = css(tone, alpha);
      g.fillRect(r() * Wp, G + r() * (Hp - G), sz, sz);
    }
    // Roots from the surface
    for (let i = 0; i < 10; i++) {
      const segs = [];
      growRoot(segs, r, r() * Wp, G + S * 0.3, Math.PI / 2 + (r() - 0.5) * 0.9, 1.2 + r() * 1.8, 12 + Math.floor(r() * 18), 0, S * 0.9, { wander: 0.5, branch: 0.14 });
      const tone = mix(c.leaf, c.soil[500], 0.2 + r() * 0.3);
      strokeSegs(g, segs, [
        [(w) => w + 1, BLACK, 0.3, S * 0.12, S * 0.16],
        [(w) => w, tone, 0.9, 0, 0],
        [(w) => Math.max(0.6, w * 0.35), mix(tone, c.soil[500], 0.5), 0.6, -0.5, -0.6],
      ]);
    }
    // Stones in the earth
    for (let i = 0; i < 46; i++) {
      pebble(g, c, r, r() * Wp, G + S * 2 + r() * (Hp - G - S * 3), (0.3 + r() * r() * 1.5) * S);
    }
    g.restore();

    // Tunnels, the well's shaft, then the chambers, carved into the earth.
    for (const [k, p] of Object.entries(this.paths)) if (k !== "reject") this.carveTunnel(g, p.pts);
    const well = L.chambers.well;
    this.carveTunnel(g, [[well.x, L.ground - 0.4], [well.x, well.y - well.ry * 0.5]], TUNNEL * 0.85);
    for (const [id, ch] of Object.entries(L.chambers)) if (id !== "entrance") this.carveChamber(g, r, ch);

    // The surface: the ground's edge, the mound, the entrance cut open, grass.
    g.fillStyle = css(mix(c.soil[950], BLACK, 0.25));
    g.fillRect(0, G - S * 0.25, Wp, S * 0.7);
    this.paintMound(g, r);
    for (const sd of [-1, 1]) pebble(g, c, r, (well.x + sd * 1.7) * S, G - S * 0.15, S * 0.75);
    this.tufts = [];
    const ent = L.chambers.entrance;
    for (let x = r() * S * 2; x < Wp; x += S * (1.2 + r() * 2.2)) {
      if (Math.abs(x / S - ent.x) < ent.rx * 1.25 || Math.abs(x / S - well.x) < 2.6) continue;
      const t = makeTuft(r, x, G + S * 0.15, (1.1 + r() * 1.6) * S, 0, S, { lean: -Math.PI / 2, fan: 1.4 });
      if (r() < 0.22) this.tufts.push(t); else drawTuft(g, c, S, t, 0);
    }
  }

  // A tunnel bore: a shaded upper lip, a lit lower wall, the dark bore, a floor.
  carveTunnel(g, pts, bore = TUNNEL) {
    const { S, c } = this, w = bore * S;
    const line = (ox, oy) => {
      g.beginPath();
      pts.forEach(([x, y], i) => (i ? g.lineTo(x * S + ox, y * S + oy) : g.moveTo(x * S + ox, y * S + oy)));
    };
    g.lineCap = "round"; g.lineJoin = "round";
    line(S * 0.2, S * 0.25); g.strokeStyle = css(c.soil[500], 0.5); g.lineWidth = w + S * 0.5; g.stroke();
    line(-S * 0.12, -S * 0.16); g.strokeStyle = css(mix(c.soil[950], BLACK, 0.48), 0.9); g.lineWidth = w + S * 0.3; g.stroke();
    line(0, 0); g.strokeStyle = css(mix(c.soil[950], BLACK, 0.4)); g.lineWidth = w; g.stroke();
    line(S * 0.08, S * 0.3); g.strokeStyle = css(mix(c.soil[900], BLACK, 0.26), 0.85); g.lineWidth = w * 0.4; g.stroke();
  }

  // A chamber: the far wall catches the light (bottom right), the near lip
  // sits in shade (top left), a packed floor.
  carveChamber(g, r, ch) {
    const { S, c } = this, x = ch.x * S, y = ch.y * S, rx = ch.rx * S, ry = ch.ry * S;
    const ell = (dx, dy, k = 1) => { g.beginPath(); g.ellipse(x + dx, y + dy, rx * k + (k - 1) * S, ry * k + (k - 1) * S, 0, 0, TAU); };
    ell(S * 0.3, S * 0.35, 1.03); g.fillStyle = css(c.soil[500], 0.5); g.fill();
    ell(-S * 0.18, -S * 0.22, 1.03); g.fillStyle = css(mix(c.soil[950], BLACK, 0.5), 0.95); g.fill();
    ell(0, 0);
    const gr = g.createRadialGradient(x - rx * 0.3, y - ry * 0.45, 0, x, y, Math.max(rx, ry) * 1.05);
    gr.addColorStop(0, css(mix(c.soil[950], BLACK, 0.52)));
    gr.addColorStop(1, css(mix(c.soil[950], BLACK, 0.36)));
    g.fillStyle = gr;
    g.fill();
    g.save();
    ell(0, 0); g.clip();
    const fy = y + ry * 0.3;
    const fl = g.createLinearGradient(0, fy, 0, y + ry);
    fl.addColorStop(0, css(mix(c.soil[950], BLACK, 0.36), 0));
    fl.addColorStop(0.25, css(mix(c.soil[950], BLACK, 0.26)));
    fl.addColorStop(1, css(mix(c.soil[900], BLACK, 0.12)));
    g.fillStyle = fl;
    g.fillRect(x - rx, fy, rx * 2, ry);
    for (let i = 0; i < rx * ry * 0.01; i++) {
      g.fillStyle = css(r() < 0.6 ? c.soil[700] : c.bone, r() < 0.6 ? 0.22 : 0.05);
      g.fillRect(x - rx + r() * rx * 2, fy + r() * ry * 0.75, 1 + r() * 1.5, 1 + r() * 1.5);
    }
    // Shade under the ceiling
    g.strokeStyle = "rgba(0,0,0,0.35)";
    g.lineWidth = S * 0.9;
    ell(S * 0.2, S * 0.6); g.stroke();
    g.restore();
  }

  // The anthill, side on: a dome of excavated subsoil, cut open down the
  // middle to show the passage to the entrance hall below the surface.
  paintMound(g, r) {
    const { S, L, c } = this, ch = L.chambers.entrance, G = L.ground * S;
    const x = ch.x * S, mw = ch.rx * 1.25 * S, mh = (L.ground - ch.y + ch.ry) * S * 0.95;
    const sand = mix(mix(c.soil[600], c.soil[500], 0.5), c.amberLo, 0.05);
    const dome = () => {
      g.beginPath();
      g.moveTo(x - mw, G + S * 0.2);
      g.bezierCurveTo(x - mw * 0.55, G - mh * 0.15, x - mw * 0.35, G - mh, x, G - mh);
      g.bezierCurveTo(x + mw * 0.35, G - mh, x + mw * 0.55, G - mh * 0.15, x + mw, G + S * 0.2);
      g.closePath();
    };
    // Cast shadow to the right
    g.save(); g.translate(S * 0.8, S * 0.3); dome(); g.fillStyle = "rgba(0,0,0,0.35)"; g.fill(); g.restore();
    dome();
    const gr = g.createLinearGradient(x - mw, G - mh, x + mw, G);
    gr.addColorStop(0, css(mix(sand, c.bone, 0.12)));
    gr.addColorStop(0.55, css(sand));
    gr.addColorStop(1, css(mix(sand, BLACK, 0.35)));
    g.fillStyle = gr;
    g.fill();
    g.save(); dome(); g.clip();
    for (let i = 0; i < 2600; i++) {
      const px = x + (r() * 2 - 1) * mw, py = G - r() * mh, lit = (px - x) / mw;
      const tone = lit < 0 ? mix(sand, c.bone, -lit * 0.25) : mix(sand, BLACK, lit * 0.4);
      g.fillStyle = css(mix(tone, c.soil[700], r() * 0.4), 0.85);
      const sz = (0.1 + r() * 0.14) * S;
      g.beginPath(); g.ellipse(px, py, sz, sz * 0.8, r() * TAU, 0, TAU); g.fill();
    }
    g.restore();
    // The entrance hall below the surface, and the passage up through the
    // mound to its crater.
    const hall = { x: ch.x, y: L.ground + 2.2, rx: ch.rx * 0.55, ry: 2.3 };
    this.carveTunnel(g, [[ch.x, L.ground - mh / S + 0.9], [ch.x, L.ground + 1]], TUNNEL * 0.9);
    this.carveChamber(g, r, hall);
    const hole = g.createRadialGradient(x, G - mh + S * 0.6, 0, x, G - mh + S * 0.6, S * 1.8);
    hole.addColorStop(0, "rgba(0,0,0,0.95)");
    hole.addColorStop(1, "rgba(0,0,0,0)");
    g.fillStyle = hole;
    g.beginPath(); g.ellipse(x, G - mh + S * 0.6, S * 1.8, S * 0.8, 0, 0, TAU); g.fill();
    // Thatch the workers dragged onto the mound
    g.lineCap = "round";
    for (let i = 0; i < 22; i++) {
      const a = Math.PI + r() * Math.PI, u = 0.55 + r() * 0.45;
      const px = x + Math.cos(a) * mw * u, py = G + Math.sin(a) * mh * u, len = (0.4 + r() * 0.6) * S, b = r() * TAU;
      g.strokeStyle = css(mix(r() < 0.5 ? c.leaf : c.grass, c.soil[500], 0.2 + r() * 0.3), 0.9);
      g.lineWidth = 1 + r() * 1.2;
      g.beginPath(); g.moveTo(px, py); g.lineTo(px + Math.cos(b) * len, py + Math.sin(b) * len); g.stroke();
    }
  }

  // ---------------------------------------------------------------- contents

  // What the chambers hold, from the model: eggs, piles, the queen, the
  // gallery's cells, the guard's gate. Repainted when the model changes.
  paintContents() {
    if (!this.contents) return;
    const m = this.model;
    const key = JSON.stringify([this.name, this.S, m && [m.nursery?.blue, m.nursery?.pink, m.queen?.eggs, m.granary?.treasuryLevel, m.granary?.escrowLevel, m.gallery?.cells, m.guard?.paused]]);
    if (key === this.contentsKey) return;
    this.contentsKey = key;
    const g = this.contents.getContext("2d"), { S, L, c } = this;
    g.setTransform(1, 0, 0, 1, 0, 0);
    g.clearRect(0, 0, this.cv.width, this.cv.height);
    const r = prng(SEED, 0x510e527f);
    const ch = L.chambers;

    // Well: still water at the bottom of the shaft.
    {
      const w = ch.well, x = w.x * S, y = w.y * S, rx = w.rx * S, ry = w.ry * S;
      g.save(); g.beginPath(); g.ellipse(x, y, rx, ry, 0, 0, TAU); g.clip();
      const wy = y + ry * 0.15;
      const gr = g.createLinearGradient(0, wy, 0, y + ry);
      gr.addColorStop(0, "rgba(40,52,62,0.95)");
      gr.addColorStop(1, "rgba(14,18,22,0.98)");
      g.fillStyle = gr;
      g.fillRect(x - rx, wy, rx * 2, ry);
      g.strokeStyle = css(c.bone, 0.28);
      g.lineWidth = 1;
      for (let i = 0; i < 4; i++) {
        const gy = wy + S * (0.3 + i * 0.55), gx = x - rx * 0.6 + r() * rx * 0.8, gl = rx * (0.15 + r() * 0.3);
        g.beginPath(); g.moveTo(gx, gy); g.lineTo(gx + gl, gy); g.stroke();
      }
      g.restore();
    }

    // Nursery: blue eggs (requests) and pink eggs (agents' posts) heaped on
    // the floor, at most 18 of each drawn.
    {
      const n = ch.nursery, blue = Math.min(18, m?.nursery?.blue ?? 0), pink = Math.min(18, m?.nursery?.pink ?? 0);
      const eggs = [...Array(blue).fill(EGG.blue), ...Array(pink).fill(EGG.pink)];
      this.heap(r, n, eggs.length, (i, ex, ey) => this.egg(g, ex, ey, S * 0.55, S * 0.78, (r() - 0.5) * 1.2, eggs[i]));
    }

    // Queen's chamber: the queen and one egg per round. The newest laid egg
    // with hashes is the one Check the receipts rings.
    {
      const q = ch.queen, eggs = m?.queen?.eggs ?? [];
      const fy = (q.y + q.ry * 0.5) * S;
      this.eggPos = [];
      const x0 = (q.x - q.rx * 0.05) * S, x1 = (q.x + q.rx * 0.78) * S;
      eggs.forEach((e, i) => {
        const ex = eggs.length > 1 ? x0 + ((x1 - x0) * i) / (eggs.length - 1) : (x0 + x1) / 2;
        const ey = fy - S * 0.3 - (i % 2) * S * 0.35;
        const tone = e.state === "skipped" ? mix(EGG.bone, c.soil[700], 0.6) : EGG.bone;
        g.globalAlpha = e.state === "laying" ? 0.55 : 1;
        this.egg(g, ex, ey, S * 0.62, S * 0.88, 0.1, tone);
        g.globalAlpha = 1;
        if (e.state === "skipped") {
          g.strokeStyle = "rgba(0,0,0,0.6)"; g.lineWidth = 1.2;
          g.beginPath(); g.moveTo(ex - S * 0.4, ey - S * 0.1); g.lineTo(ex, ey + S * 0.15); g.lineTo(ex + S * 0.35, ey - S * 0.2); g.stroke();
        }
        this.eggPos.push({ x: ex, y: ey, egg: e });
      });
      drawAnt(g, c, { x: (q.x - q.rx * 0.38) * S, y: fy - S * 0.9, ang: -0.08, phase: 0.6, k: S * 1.9, still: true, gaster: 2, halo: HALO });
      g.setTransform(1, 0, 0, 1, 0, 0);
    }

    // Granary: the treasury's pile of sugar and, beside it, what the
    // contract holds for others. Heights follow their levels.
    {
      const gch = ch.granary, fy = (gch.y + gch.ry * 0.82) * S;
      const pile = (cx, bw, level, tone) => {
        const h = level * gch.ry * 1.35 * S, n = Math.round(30 + level * 220);
        const crumbs = [];
        for (let i = 0; i < n; i++) {
          const u = r() * 2 - 1, top = h * (1 - Math.abs(u) ** 1.6);
          crumbs.push([cx + u * bw, fy - r() * top, r(), r()]);
        }
        crumbs.sort((a, b) => a[1] - b[1]);
        for (const [px, py, k1, k2] of crumbs) {
          g.fillStyle = css(k2 < 0.7 ? mix(tone, BLACK, k1 * 0.3) : mix(tone, [255, 255, 255], 0.3));
          g.beginPath(); g.ellipse(px, py, S * (0.22 + k1 * 0.14), S * (0.16 + k2 * 0.08), k1 * TAU, 0, TAU); g.fill();
        }
      };
      const tl = m?.granary?.treasuryLevel ?? 0, el = m?.granary?.escrowLevel ?? 0;
      if (tl > 0) pile((gch.x - gch.rx * 0.32) * S, gch.rx * 0.5 * S, tl, mix(c.bone, c.amberLo, 0.14));
      if (el > 0) pile((gch.x + gch.rx * 0.48) * S, gch.rx * 0.3 * S, el, mix(c.bone, c.soil[500], 0.45));
    }

    // Burn pit: a bed of embers (the flame itself moves, see drawFlame).
    {
      const b = ch.burn, fy = (b.y + b.ry * 0.78) * S;
      for (let i = 0; i < 40; i++) {
        const u = r() * 2 - 1, px = (b.x + u * b.rx * 0.55) * S, py = fy - r() * S * 0.8 * (1 - Math.abs(u));
        g.fillStyle = css(mix([60, 24, 10], c.amberLo, r() * 0.5));
        g.beginPath(); g.ellipse(px, py, S * (0.3 + r() * 0.25), S * 0.2, r() * TAU, 0, TAU); g.fill();
      }
    }

    // Guard post: two guards at the gate; bars across it while paused.
    {
      const gd = ch.guard;
      drawAnt(g, c, { x: (gd.x + gd.rx * 0.35) * S, y: (gd.y + gd.ry * 0.25) * S, ang: Math.PI - 0.5, phase: 0, k: S * ANT_K * 1.1, still: true, halo: HALO });
      drawAnt(g, c, { x: (gd.x - gd.rx * 0.25) * S, y: (gd.y + gd.ry * 0.4) * S, ang: -0.3, phase: 1, k: S * ANT_K * 1.1, still: true, halo: HALO });
      g.setTransform(1, 0, 0, 1, 0, 0);
      if (m?.guard?.paused) {
        const [gx, gy] = this.L.flows.submit.at(-1);
        g.strokeStyle = css(c.hold, 0.9); g.lineWidth = Math.max(2, S * 0.3); g.lineCap = "round";
        for (const dx of [-0.7, 0, 0.7]) { g.beginPath(); g.moveTo((gx + dx) * S, (gy - 1.4) * S); g.lineTo((gx + dx) * S, (gy + 1.2) * S); g.stroke(); }
      }
    }

    // Forecast gallery: one alcove per market. Its glyph is the swarm's
    // favourite once the market has run, else the market's, dimmed.
    {
      const gl = ch.gallery, cells = m?.gallery?.cells ?? Array(12).fill(null), n = cells.length;
      const step = (gl.rx * 1.76) / n, ax = gl.rx * 0.88, arx = Math.min(step * 0.4, gl.ry * 0.5), ary = gl.ry * 0.5;
      this.cellPos = [];
      g.font = `600 ${Math.round(Math.max(10, arx * S * 1.15))}px ${this.font}`;
      g.textAlign = "center"; g.textBaseline = "middle";
      cells.forEach((cell, i) => {
        const x = (gl.x - ax + step * (i + 0.5)) * S, y = (gl.y + gl.ry * 0.1) * S;
        g.beginPath(); g.ellipse(x + S * 0.12, y + S * 0.15, arx * S * 1.08, ary * S * 1.08, 0, 0, TAU);
        g.fillStyle = css(c.soil[500], 0.25); g.fill();
        g.beginPath(); g.ellipse(x, y, arx * S, ary * S, 0, 0, TAU);
        g.fillStyle = "rgba(0,0,0,0.55)"; g.fill();
        this.cellPos.push({ x, y, rx: arx * S, ry: ary * S, cell });
        if (!cell) return;
        const o = cell.swarmLead ?? cell.marketLead;
        g.globalAlpha = cell.swarmLead === null ? 0.5 : 1;
        g.fillStyle = css(c.opt[o]);
        g.fillText(c.glyphs[o] ?? "", x, y + 1);
        g.globalAlpha = 1;
      });
    }
  }

  // Lay `count` things on a chamber's floor in a low heap; put(i, x, y).
  heap(r, ch, count, put) {
    const { S } = this, fy = (ch.y + ch.ry * 0.62) * S, perRow = Math.max(1, Math.floor(ch.rx * 1.1));
    for (let i = 0; i < count; i++) {
      const row = Math.floor(i / perRow), col = i % perRow, inRow = Math.max(1, perRow - row);
      const span = (inRow - 1) * 1.15;
      const x = (ch.x - span / 2 + (col % inRow) * 1.15 + (r() - 0.5) * 0.3) * S;
      put(i, x, fy - row * S * 1.05 + (r() - 0.5) * S * 0.2);
    }
  }

  egg(g, x, y, rx, ry, ang, tone) {
    g.save();
    g.translate(x, y); g.rotate(ang);
    g.fillStyle = "rgba(0,0,0,0.35)";
    g.beginPath(); g.ellipse(rx * 0.2, ry * 0.25, rx, ry, 0, 0, TAU); g.fill();
    const gr = g.createRadialGradient(-rx * 0.35, -ry * 0.4, 0, 0, 0, ry * 1.1);
    gr.addColorStop(0, css(mix(tone, [255, 255, 255], 0.5)));
    gr.addColorStop(0.6, css(tone));
    gr.addColorStop(1, css(mix(tone, BLACK, 0.3)));
    g.fillStyle = gr;
    g.beginPath(); g.ellipse(0, 0, rx, ry, 0, 0, TAU); g.fill();
    g.restore();
  }

  // ---------------------------------------------------------------- ants

  mover(flow, s, ambient) {
    const cr = FLOWS[flow].crumb, c = this.c;
    const crumb = cr === "sugar" ? mix(c.bone, c.amberLo, 0.14) : cr === "ember" ? c.amberHi : cr === "egg" ? EGG.blue
      : cr === "seed" ? c.bone : cr === "larva" ? mix(c.bone, c.soil[500], 0.2) : null;
    return { flow, s, v: SPEED * (0.85 + Math.random() * 0.3), phase: Math.random() * 6, crumb: flow === "result" ? EGG.bone : crumb, ambient };
  }

  // Chamber ants: workers in the hall, attendants by the queen, a nurse, a
  // granary hand, two in the gallery. They potter on the floor.
  seedIdle() {
    if (!this.L) return;
    const m = this.model, ch = this.L.chambers;
    const want = [
      ["workers", Math.max(5, Math.min(11, 2 * ((m?.workers?.keepers ?? 2) + Math.min(3, m?.workers?.agents ?? 1))))],
      ["queen", 4], ["nursery", 3], ["granary", 4], ["gallery", 4], ["guard", 2],
    ];
    const key = JSON.stringify([this.name, want]);
    if (key === this.idleKey) return;
    this.idleKey = key;
    this.idle = [];
    for (const [id, n] of want) {
      const h = ch[id];
      for (let i = 0; i < n; i++) {
        const u = n > 1 ? i / (n - 1) - 0.5 : 0;
        this.idle.push({ id, x: h.x + u * h.rx * 1.1, y: h.y + h.ry * 0.45, ang: i % 2 ? Math.PI : 0, phase: i * 1.7, wait: (i % 3) * 0.7 });
      }
    }
  }

  // Under reduced motion: ambient ants stand evenly along each tunnel.
  placeStill() {
    this.ants = [];
    for (const [flow, n] of Object.entries(AMBIENT)) {
      const p = this.paths[flow];
      for (let i = 0; i < n; i++) this.ants.push(this.mover(flow, (p.len * (i + 1)) / (n + 1), true));
    }
  }

  step(dt, now) {
    // Ambient traffic
    for (const [flow, n] of Object.entries(AMBIENT)) {
      if (!n) continue;
      const on = this.ants.filter((a) => a.ambient && a.flow === flow).length;
      if (on < n && now >= (this.nextAt[flow] ?? 0)) {
        this.ants.push(this.mover(flow, 0, true));
        this.nextAt[flow] = now + 500 + Math.random() * 1500;
      }
    }
    for (const a of this.ants) { a.s += a.v * dt; a.phase += a.v * dt * Math.PI * 1.3; }
    this.ants = this.ants.filter((a) => {
      if (a.s <= this.paths[a.flow].len) return true;
      if (a.flow === "burn") this.spark(now, a.ambient ? 3 : 10);
      return false;
    });
    // Chamber ants: amble along the floor, pause, turn back at the walls.
    const ch = this.L.chambers;
    for (const a of this.idle) {
      if (a.wait > 0) { a.wait -= dt; continue; }
      const h = ch[a.id], v = 1.4;
      a.x += Math.cos(a.ang) * v * dt; a.phase += v * dt * Math.PI * 1.3;
      a.y = h.y + h.ry * 0.45 + Math.sin(a.phase * 0.15) * h.ry * 0.08;
      if (Math.abs(a.x - h.x) > h.rx * 0.7) { a.x = h.x + Math.sign(a.x - h.x) * h.rx * 0.7; a.ang = Math.PI - a.ang; }
      if (Math.random() < dt * 0.25) { a.wait = 0.6 + Math.random() * 1.8; if (Math.random() < 0.5) a.ang = Math.PI - a.ang; }
    }
    this.sparks = this.sparks.filter((p) => now - p.t0 < p.life);
  }

  spark(now, n) {
    const b = this.L.chambers.burn;
    for (let i = 0; i < n; i++) this.sparks.push({ x: b.x + (Math.random() - 0.5) * b.rx * 0.6, y: b.y + b.ry * 0.5, dx: (Math.random() - 0.5) * 3, dy: -(2 + Math.random() * 4), t0: now, life: 700 + Math.random() * 500 });
  }

  // ---------------------------------------------------------------- frame

  // Draw one frame at time `now` (ms). Returns true while it wants more.
  draw(now = performance.now()) {
    if (!this.L) return false;
    const still = this.still;
    const dt = this.last ? Math.min(0.1, (now - this.last) / 1000) : 0;
    this.last = now;
    if (!still) this.step(dt, now);
    const { ctx, S, c } = this;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.globalAlpha = 1;
    ctx.drawImage(this.scene, 0, 0);
    ctx.drawImage(this.contents, 0, 0);
    this.drawFlame(now, still);
    this.drawGlows(now, still);
    // Ants in the tunnels, then in the chambers.
    for (const a of this.ants) {
      if (a.s < 0) continue;
      const p = pointAt(this.paths[a.flow], a.s);
      drawAnt(ctx, c, { x: p.x * S, y: p.y * S, ang: p.ang, phase: a.phase, k: S * ANT_K, still, crumb: a.crumb, halo: HALO });
    }
    for (const a of this.idle) drawAnt(ctx, c, { x: a.x * S, y: a.y * S, ang: a.ang, phase: a.phase, k: S * ANT_K, still, halo: HALO });
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    // Sparks from the burn pit
    for (const p of this.sparks) {
      const u = (now - p.t0) / p.life;
      ctx.globalAlpha = Math.max(0, 1 - u);
      ctx.fillStyle = css(mix(c.amberHi, c.amberLo, u));
      ctx.beginPath(); ctx.arc((p.x + p.dx * u) * S, (p.y + p.dy * u) * S, Math.max(1, S * 0.18 * (1 - u)), 0, TAU); ctx.fill();
    }
    ctx.globalAlpha = 1;
    // Tall grass over everything, swaying.
    for (const t of this.tufts ?? []) drawTuft(ctx, c, S, t, still ? 0 : Math.sin(now / 1300 + t.phase) * 0.07);
    this.drawHover(now, still);
    return !still;
  }

  // The burn pit's flame: its height follows the last pot's size.
  drawFlame(now, still) {
    const { ctx, S, c } = this, b = this.L.chambers.burn, lv = this.model?.burn?.flame ?? 0.3;
    const x = b.x * S, fy = (b.y + b.ry * 0.7) * S, H = lv * b.ry * 1.45 * S;
    const glow = ctx.createRadialGradient(x, fy - H * 0.3, 0, x, fy - H * 0.3, b.rx * S * 0.9);
    glow.addColorStop(0, css(c.amberLo, 0.35 * lv + 0.1));
    glow.addColorStop(1, css(c.amberLo, 0));
    ctx.fillStyle = glow;
    ctx.beginPath(); ctx.ellipse(b.x * S, b.y * S, b.rx * S, b.ry * S, 0, 0, TAU); ctx.fill();
    for (let i = 0; i < 5; i++) {
      const off = (i - 2) * S * 0.9, k = 1 - Math.abs(i - 2) * 0.22;
      const flick = still ? 1 : 0.8 + 0.2 * Math.sin(now / 140 + i * 1.7) + 0.08 * Math.sin(now / 53 + i);
      const h = H * k * flick, w = S * (1.1 + k * 0.6), sway = still ? 0 : Math.sin(now / 260 + i) * S * 0.35;
      const gr = ctx.createLinearGradient(0, fy, 0, fy - h);
      gr.addColorStop(0, css(c.amberHi, 0.95));
      gr.addColorStop(0.45, css(c.amberLo, 0.85));
      gr.addColorStop(1, css(mix(c.amberLo, [90, 30, 10], 0.5), 0));
      ctx.fillStyle = gr;
      ctx.beginPath();
      ctx.moveTo(x + off - w, fy);
      ctx.quadraticCurveTo(x + off - w * 0.6, fy - h * 0.55, x + off + sway, fy - h);
      ctx.quadraticCurveTo(x + off + w * 0.6, fy - h * 0.55, x + off + w, fy);
      ctx.closePath(); ctx.fill();
    }
  }

  // A gallery cell where the swarm's favourite differs from the market's
  // glows (bone, never amber); the queen's newest egg shows the receipts.
  drawGlows(now, still) {
    const { ctx, S, c } = this;
    const pulse = still ? 0.8 : 0.6 + 0.4 * Math.sin(now / 600);
    for (const p of this.cellPos ?? []) {
      if (!p.cell?.differs) continue;
      ctx.strokeStyle = css(c.bone, 0.55 * pulse + 0.2);
      ctx.lineWidth = Math.max(1.5, S * 0.22);
      ctx.shadowColor = css(c.bone, 0.8); ctx.shadowBlur = S * 1.2 * pulse;
      ctx.beginPath(); ctx.ellipse(p.x, p.y, p.rx * 1.15, p.ry * 1.15, 0, 0, TAU); ctx.stroke();
      ctx.shadowBlur = 0;
    }
    if (!this.verify || !this.eggPos?.length) return;
    const e = [...this.eggPos].reverse().find((q) => q.egg.hashes.length) ?? this.eggPos.at(-1);
    const col = this.verify === "match" ? c.ok : this.verify === "mismatch" ? c.fault : c.hold;
    ctx.strokeStyle = css(col, 0.95);
    ctx.lineWidth = Math.max(2, S * 0.25);
    if (this.verify === "running") { ctx.setLineDash([S * 0.5, S * 0.4]); ctx.lineDashOffset = still ? 0 : -now / 40; }
    ctx.beginPath(); ctx.ellipse(e.x, e.y, S * 1.15, S * 1.4, 0, 0, TAU); ctx.stroke();
    ctx.setLineDash([]);
    if (this.verify !== "running") {
      ctx.font = `700 ${Math.round(Math.max(12, S * 1.4))}px ${this.font}`;
      ctx.textAlign = "center"; ctx.textBaseline = "middle";
      ctx.fillStyle = css(col);
      ctx.fillText(this.verify === "match" ? "✓" : "≠", e.x, e.y - S * 2.3);
    }
  }

  // The chamber under the pointer or focus: a marching bone ring.
  drawHover(now, still) {
    if (!this.hover) return;
    const { ctx, S, c } = this, h = this.L.chambers[this.hover];
    if (!h) return;
    ctx.setLineDash([S * 0.7, S * 0.5]);
    ctx.lineDashOffset = still ? 0 : -now / 50;
    ctx.strokeStyle = css(c.bone, 0.9);
    ctx.lineWidth = Math.max(2, S * 0.22);
    ctx.beginPath(); ctx.ellipse(h.x * S, h.y * S, h.rx * S + S * 0.9, h.ry * S + S * 0.9, 0, 0, TAU); ctx.stroke();
    ctx.setLineDash([]);
  }
}
