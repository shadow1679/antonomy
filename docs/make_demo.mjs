// Writes docs/demo-colony.svg: a real run of the simulation (the JavaScript
// port, spec ANTO-SIM-v1) drawn as three snapshots of the pheromone map, plus
// the final scores and the result hash. The README embeds the image, so the
// picture is exactly what `node sim/tests/dump.mjs 42 1` and the contract's
// hash cover. Pure function of the seed: running it twice gives the same file.
//
//   node docs/make_demo.mjs [seed_int] [out.svg]

import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { Colony, seedFromInt, W, H, NEST_X, NEST_Y, CAP, TICKS, N_ANTS, SIM_VERSION } from "../sim/js/antosim.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const seedInt = parseInt(process.argv[2] ?? "42", 10);
const out = process.argv[3] ?? join(here, "demo-colony.svg");
const SNAPS = [100, 300, TICKS];

// Option palette from web/ds/tokens.css; shapes stand in for the glyphs.
const OPT = ["#9bb860", "#cf6e4e", "#5d8dc8", "#e0a9c4", "#efe2b6"];
const NAMES = ["A", "B", "C", "D", "E"];
const AMBER = "#f2a541", BONE = "#efe6d8", MUTED = "#b8aa95", SOIL950 = "#0d0a07", SOIL800 = "#1d1812", SOIL600 = "#3a3026";

const CELL = 4, PW = W * CELL, PH = H * CELL, GAP = 24, PAD = 28;
const LEVELS = [0.14, 0.28, 0.44, 0.62, 0.8, 0.96];
const f1 = (v) => Math.round(v * 10) / 10;

function shape(o, cx, cy, r, extra = "") {
  const c = OPT[o];
  const pts = (arr) => arr.map(([x, y]) => `${f1(cx + x * r)},${f1(cy + y * r)}`).join(" ");
  if (o === 0) return `<polygon points="${pts([[0, -1], [0.95, 0.8], [-0.95, 0.8]])}" fill="${c}" ${extra}/>`;
  if (o === 1) return `<rect x="${f1(cx - r * 0.8)}" y="${f1(cy - r * 0.8)}" width="${f1(r * 1.6)}" height="${f1(r * 1.6)}" fill="${c}" ${extra}/>`;
  if (o === 2) return `<polygon points="${pts([[0, -1], [1, 0], [0, 1], [-1, 0]])}" fill="${c}" ${extra}/>`;
  if (o === 3) return `<circle cx="${f1(cx)}" cy="${f1(cy)}" r="${f1(r * 0.9)}" fill="${c}" ${extra}/>`;
  const star = [];
  for (let k = 0; k < 10; k++) {
    const a = -Math.PI / 2 + (k * Math.PI) / 5, rr = k % 2 ? 0.42 : 1;
    star.push([Math.cos(a) * rr, Math.sin(a) * rr]);
  }
  return `<polygon points="${pts(star)}" fill="${c}" ${extra}/>`;
}

const colony = new Colony(seedFromInt(seedInt));
const snaps = [];
while (colony.step()) {
  if (SNAPS.includes(colony.t)) {
    const buckets = LEVELS.map(() => []);
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        const v = colony.cell(y * W + x) / CAP;
        if (v <= 0.02) continue;
        buckets[Math.min(LEVELS.length - 1, Math.floor(v * LEVELS.length))].push(`M${x * CELL} ${y * CELL}h${CELL}v${CELL}h-${CELL}z`);
      }
    }
    const ants = [];
    for (let a = 0; a < colony.ants; a++) ants.push([f1(colony.ax[a] / 256 * CELL), f1(colony.ay[a] / 256 * CELL)]);
    snaps.push({ t: colony.t, buckets, ants });
  }
}
const res = colony.result();
const optOfSource = (s) => res.perm.indexOf(s);

const width = PAD * 2 + PW * 3 + GAP * 2;
const barsTop = PAD + 44 + PH + 40 + 24;
const height = barsTop + 5 * 26 + 62;
let svg = "";
const add = (s) => { svg += s + "\n"; };

add(`<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" role="img" aria-labelledby="t d">`);
add(`<title id="t">Demo colony: seed ${seedInt}, five options, ${N_ANTS} ants, ${TICKS} ticks</title>`);
add(`<desc id="d">Three snapshots of the pheromone trail at ticks ${SNAPS.join(", ")}, then the final scores. Option ${NAMES[res.winner_option]} wins. Result hash ${res.hash}.</desc>`);
add(`<rect width="${width}" height="${height}" rx="16" fill="${SOIL950}"/>`);
add(`<g font-family="ui-sans-serif, -apple-system, 'Segoe UI', Helvetica, Arial, sans-serif" fill="${BONE}">`);
add(`<text x="${PAD}" y="${PAD + 8}" font-size="18" font-weight="600">Demo colony: seed ${seedInt}</text>`);
add(`<text x="${PAD}" y="${PAD + 28}" font-size="12.5" fill="${MUTED}">${res.sources.length} options on ${res.sources.length} food sources · ${N_ANTS} ants · ${TICKS} ticks · ${SIM_VERSION} · the same integer code in Rust, JavaScript and Python</text>`);

snaps.forEach((s, i) => {
  const x0 = PAD + i * (PW + GAP), y0 = PAD + 44;
  add(`<g transform="translate(${x0} ${y0})">`);
  add(`<rect width="${PW}" height="${PH}" rx="8" fill="${SOIL800}" stroke="${SOIL600}"/>`);
  s.buckets.forEach((cells, b) => {
    if (cells.length) add(`<path d="${cells.join("")}" fill="${AMBER}" fill-opacity="${LEVELS[b]}"/>`);
  });
  // score zones (6 cells around each source) and food sources
  res.sources.forEach(([sx, sy], src) => {
    const o = optOfSource(src), cx = (sx + 0.5) * CELL, cy = (sy + 0.5) * CELL;
    add(`<circle cx="${cx}" cy="${cy}" r="${6 * CELL}" fill="none" stroke="${OPT[o]}" stroke-opacity="0.7" stroke-dasharray="3 3"/>`);
  });
  for (const [ax, ay] of s.ants) add(`<circle cx="${ax}" cy="${ay}" r="1.3" fill="${BONE}" fill-opacity="0.85"/>`);
  add(`<circle cx="${(NEST_X + 0.5) * CELL}" cy="${(NEST_Y + 0.5) * CELL}" r="11" fill="${SOIL950}" stroke="${BONE}" stroke-width="1.5"/>`);
  add(`<text x="${(NEST_X + 0.5) * CELL}" y="${(NEST_Y + 0.5) * CELL + 3.5}" font-size="8.5" text-anchor="middle" fill="${BONE}">nest</text>`);
  res.sources.forEach(([sx, sy], src) => {
    const o = optOfSource(src), cx = (sx + 0.5) * CELL, cy = (sy + 0.5) * CELL;
    add(`<circle cx="${cx}" cy="${cy}" r="11" fill="${SOIL950}" stroke="${OPT[o]}" stroke-width="1.5"/>`);
    add(shape(o, cx, cy, 6.5));
  });
  add(`</g>`);
  add(`<text x="${x0}" y="${y0 + PH + 20}" font-size="13" font-weight="600">tick ${s.t}</text>`);
  const note = ["ants leave the nest and lay trail", "trail thickens on the routes that pay", "final trail; dashed rings are the score zones"][i];
  add(`<text x="${x0 + 62}" y="${y0 + PH + 20}" font-size="12.5" fill="${MUTED}">${note}</text>`);
});

// final scores per option, in option order
const optScore = Array.from({ length: res.sources.length }, (_, o) => res.scores[res.perm[o]]);
const max = Math.max(...optScore), barX = PAD + 150, barW = width - barX - PAD - 130;
add(`<text x="${PAD}" y="${barsTop - 12}" font-size="13" font-weight="600">Score per option (trail within 6 cells of its source, summed every 100 ticks)</text>`);
optScore.forEach((v, o) => {
  const y = barsTop + o * 26, win = o === res.winner_option;
  add(shape(o, PAD + 9, y + 9, 7));
  add(`<text x="${PAD + 24}" y="${y + 14}" font-size="13" ${win ? 'font-weight="700"' : ""}>Option ${NAMES[o]}</text>`);
  add(`<rect x="${barX}" y="${y + 1}" width="${f1(((barW) * v) / max)}" height="16" rx="3" fill="${win ? AMBER : OPT[o]}" fill-opacity="${win ? 1 : 0.55}"/>`);
  add(`<text x="${barX + f1((barW * v) / max) + 8}" y="${y + 14}" font-size="12.5" fill="${win ? AMBER : MUTED}" font-family="ui-monospace, 'SF Mono', Menlo, Consolas, monospace">${v.toLocaleString("en-US")}${win ? "  winner" : ""}</text>`);
});
add(`<text x="${PAD}" y="${height - 26}" font-size="12.5" fill="${MUTED}">result hash</text>`);
add(`<text x="${PAD + 76}" y="${height - 26}" font-size="12.5" font-family="ui-monospace, 'SF Mono', Menlo, Consolas, monospace" fill="${AMBER}">${res.hash}</text>`);
add(`</g>`);
add(`</svg>`);

writeFileSync(out, svg);
console.log(JSON.stringify({ seed: seedInt, winner_option: NAMES[res.winner_option], scores_by_option: optScore, hash: res.hash }));
