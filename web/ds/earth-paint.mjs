// Painters shared by the colony map (colony-view.mjs) and the nest cutaway
// (nest-view.mjs), so both look like the same piece of ground: the colour
// helpers, scenery props (pebbles, leaves, roots, grass) and the ant itself.
// Canvas only, no sim: nothing here can change a result hash. Randomness
// comes from the caller's own PRNG (`prng`), never the sim's.

export const TAU = Math.PI * 2;
export const LIGHT = [-0.55, -0.6, 0.58]; // scenery is lit from the top left
export const BLACK = [0, 0, 0], WHITE = [255, 255, 255];

// Tokens are read once per page: getComputedStyle right after new markup
// goes in forces a style recalc, and every view would pay it again.
const TOKENS = new Map();
export const tok = (n) => {
  if (!TOKENS.has(n)) TOKENS.set(n, getComputedStyle(document.documentElement).getPropertyValue(n).trim());
  return TOKENS.get(n);
};
export const rgb = (hex) => { const v = parseInt(hex.slice(1), 16); return [v >> 16, (v >> 8) & 255, v & 255]; };
export const css = ([r, g, b], a = 1) => `rgba(${r | 0},${g | 0},${b | 0},${a})`;
export const mix = (p, q, k) => p.map((v, i) => v + (q[i] - v) * k);

export function layer(w, h) {
  const c = document.createElement("canvas");
  c.width = w; c.height = h;
  return c;
}

// mulberry32, seeded from the first 4 seed bytes plus a salt per use.
export function prng(seed, salt) {
  let a = (seed[0] | (seed[1] << 8) | (seed[2] << 16) | (seed[3] << 24)) ^ salt;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// The ground's palette. `soil` is the map's earth scale (--earth-*, darkest
// to lightest, the same steps as --soil-*), so scenery code reads one scale.
export function earthColors() {
  return {
    soil: Object.fromEntries([950, 900, 800, 700, 600, 500].map((k) => [k, rgb(tok(`--earth-${k}`))])),
    bone: rgb(tok("--bone-100")),
    boneMuted: rgb(tok("--bone-300")),
    amberHi: rgb(tok("--pher-hi")),
    amberLo: rgb(tok("--pher-lo")),
    grass: rgb(tok("--scene-grass")),
    leaf: rgb(tok("--scene-leaf")),
    antBody: rgb(tok("--ant-body")),
    antLeg: rgb(tok("--ant-leg")),
  };
}

// ---- the ant

// Ant geometry in body units, facing +x.
const HIP = [0.14, 0.04, -0.06], KNEE = [0.36, 0.06, -0.26], FOOT = [0.62, 0.02, -0.62];

// One ant at (x, y) pixels, heading `ang`, `k` pixels per body unit: a soft
// shadow, six legs in a tripod gait, antennae, a brown body. `tint` (a
// wallet colour) washes the gaster and thorax; `crumb` ([r,g,b]) is food in
// its jaws. `gaster` stretches the abdomen (the queen). `halo` (a CSS
// colour) lights the ground under it, for dark tunnels. Leaves the
// transform set; callers reset it.
export function drawAnt(ctx, c, { x, y, ang, phase = 0, k, still = false, crumb = null, tint = null, gaster = 1, halo = null }) {
  const cs = Math.cos(ang) * k, sn = Math.sin(ang) * k, lw = 1.7 / k;
  const swing = still ? 0 : 0.2;
  const gx = -0.58 - (gaster - 1) * 0.42, grx = 0.46 * gaster, gry = 0.32 * (1 + (gaster - 1) * 0.45);
  if (halo) {
    ctx.setTransform(cs, sn, -sn, cs, x, y);
    ctx.fillStyle = halo;
    ctx.beginPath(); ctx.ellipse((gx + 0.5) / 2, 0, (0.5 - gx + grx) / 2 + 0.35, gry + 0.45, 0, 0, TAU); ctx.fill();
  }
  // Shadow, cast away from the light (down and right).
  ctx.setTransform(cs, sn, -sn, cs, x + k * 0.14, y + k * 0.2);
  ctx.fillStyle = "rgba(10,6,3,0.32)";
  ctx.beginPath(); ctx.ellipse(gx * 0.55, 0, 0.5 + grx * 0.9, 0.5 + (gry - 0.32) * 0.8, 0, 0, TAU); ctx.fill();
  ctx.setTransform(cs, sn, -sn, cs, x, y);

  ctx.strokeStyle = css(c.antLeg, 0.95);
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
  const wig = still ? 0 : Math.sin(phase * 0.5) * 0.06;
  for (const sd of [-1, 1]) {
    ctx.moveTo(0.58, sd * 0.06);
    ctx.lineTo(0.82, sd * 0.22);
    ctx.lineTo(1.05, sd * (0.3 + wig));
  }
  ctx.stroke();

  ctx.fillStyle = css(c.antBody);
  ctx.beginPath();
  ctx.moveTo(gx + grx, 0); ctx.ellipse(gx, 0, grx, gry, 0, 0, TAU);          // gaster
  ctx.moveTo(-0.03, 0); ctx.arc(-0.1, 0, 0.07, 0, TAU);                    // petiole
  ctx.moveTo(0.24, 0); ctx.ellipse(0.04, 0, 0.2, 0.12, 0, 0, TAU);         // thorax
  ctx.moveTo(0.65, 0); ctx.ellipse(0.46, 0, 0.19, 0.17, 0, 0, TAU);        // head
  ctx.fill();
  if (tint) {                                                              // staker ant: wallet colour on gaster and thorax
    ctx.fillStyle = tint;
    ctx.beginPath();
    ctx.moveTo(gx + grx, 0); ctx.ellipse(gx, 0, grx, gry, 0, 0, TAU);
    ctx.moveTo(0.24, 0); ctx.ellipse(0.04, 0, 0.2, 0.12, 0, 0, TAU);
    ctx.fill();
  }
  // Sheen on the gaster and head, lit from the top left.
  ctx.fillStyle = "rgba(255,226,190,0.2)";
  ctx.beginPath();
  ctx.ellipse(gx - grx * 0.15, -gry * 0.32, grx * 0.42, gry * 0.3, 0, 0, TAU);
  ctx.moveTo(0.52, -0.06); ctx.ellipse(0.44, -0.06, 0.08, 0.05, 0, 0, TAU);
  ctx.fill();

  if (crumb) {
    ctx.fillStyle = css(crumb);
    ctx.strokeStyle = "rgba(0,0,0,0.55)";
    ctx.lineWidth = lw * 0.8;
    ctx.beginPath(); ctx.arc(0.86, 0, 0.24, 0, TAU); ctx.fill(); ctx.stroke();
  }
}

// ---- scenery props. S: pixels per cell (the map's) or per nest unit.

// A stone: cast shadow, earth body, a highlight from the top left.
export function pebble(g, c, r, x, y, rad) {
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
  g.fillStyle = "rgba(0,0,0,0.45)";
  g.fill();
  path(0, 0);
  const { soil } = c;
  g.fillStyle = css(mix(mix(soil[700], soil[500], r()), BLACK, 0.18));
  g.fill();
  const hl = g.createRadialGradient(x - rad * 0.35, y - rad * 0.4, 0, x, y, rad);
  hl.addColorStop(0, css(c.bone, 0.18));
  hl.addColorStop(1, css(c.bone, 0));
  g.fillStyle = hl;
  g.fill();
  g.strokeStyle = "rgba(0,0,0,0.35)";
  g.lineWidth = 1;
  g.stroke();
}

// A wandering, branching line (twig or root) as segments {x0,y0,x1,y1,w},
// `step` pixels per segment.
export function growRoot(segs, r, x, y, ang, w, steps, depth, step, { wander = 0.45, branch = 0.07 } = {}) {
  for (let i = 0; i < steps; i++) {
    const x1 = x + Math.cos(ang) * step, y1 = y + Math.sin(ang) * step;
    const wi = w * (1 - i / steps) + 0.6;
    segs.push({ x0: x, y0: y, x1, y1, w: wi });
    x = x1; y = y1;
    ang += (r() - 0.5) * wander;
    if (depth < 2 && r() < branch) {
      growRoot(segs, r, x, y, ang + (r() < 0.5 ? -0.9 : 0.9), wi * 0.6, Math.floor((steps - i) * 0.6), depth + 1, step, { wander, branch });
    }
  }
}

// Stroke segments in passes: [width(w), tone, alpha, dx, dy].
export function strokeSegs(g, segs, passes) {
  g.lineCap = "round";
  for (const [width, tone, alpha, ox, oy] of passes) {
    g.strokeStyle = css(tone, alpha);
    for (const sg of segs) {
      g.lineWidth = width(sg.w);
      g.beginPath(); g.moveTo(sg.x0 + ox, sg.y0 + oy); g.lineTo(sg.x1 + ox, sg.y1 + oy); g.stroke();
    }
  }
}

// A dead leaf seen from above: shadow, blade folded along the midrib, veins.
export function leaf(g, c, r, x, y, L, ang) {
  const w = L * (0.2 + r() * 0.1);
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
  shape(); g.fillStyle = "rgba(0,0,0,0.4)"; g.fill();
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

// Grass: blades fan out from a base. lift lightens tufts that stand over the
// ants and pushes their shadow further out. `lean` and `fan` (radians) aim
// the blades; the defaults fan all round, as seen from above.
export function makeTuft(r, x, y, size, lift, S, { lean = r() * TAU, fan = 3.4 } = {}) {
  const blades = [], n = 6 + Math.floor(r() * 6);
  for (let i = 0; i < n; i++) {
    blades.push({
      ang: lean + (r() - 0.5) * fan, len: size * (0.55 + r() * 0.55),
      bend: (r() - 0.5) * 0.9, w: (0.07 + r() * 0.06) * S, k: r(),
    });
  }
  return { x, y, blades, lift, phase: r() * TAU };
}

export function drawTuft(g, c, S, t, sway) {
  const base = mix(mix(c.grass, BLACK, 0.2), c.soil[500], t.lift);
  const tip = mix(c.grass, c.soil[500], 0.3 + t.lift);
  const path = (b, ox, oy) => {
    const a1 = b.ang + b.bend * 0.5 + sway * 0.5, a2 = b.ang + b.bend + sway;
    g.moveTo(t.x + ox, t.y + oy);
    g.quadraticCurveTo(t.x + ox + Math.cos(a1) * b.len * 0.55, t.y + oy + Math.sin(a1) * b.len * 0.55,
      t.x + ox + Math.cos(a2) * b.len, t.y + oy + Math.sin(a2) * b.len);
  };
  g.lineCap = "round";
  g.strokeStyle = "rgba(0,0,0,0.3)";                   // shadow on the ground
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
