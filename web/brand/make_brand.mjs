// Writes the Antonomy brand kit into web/brand/: the ant mark, the app icon
// (also the favicon), the lockup, and PNGs for social posts. The art on the
// cards is a real run of the simulation (seed 42, the README's demo colony),
// so the picture is a trail anyone can replay and hash. See docs/BRAND.md.
//
//   node web/brand/make_brand.mjs [--svg-only]
//
// PNGs are rendered with headless Chrome (set CHROME to its binary if it is
// not in the macOS default place) and need the network for Google Fonts.

import { writeFileSync, readFileSync, mkdtempSync, existsSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { Colony, seedFromInt, W, H, NEST_X, NEST_Y, CAP, TICKS, SIM_VERSION } from "../../sim/js/antosim.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const svgOnly = process.argv.includes("--svg-only");

// Colours from web/ds/tokens.css.
const AMBER = "#f2a541", INK = "#1a1006", BONE = "#efe6d8", MUTED = "#b8aa95",
  SOIL950 = "#0d0a07", SOIL600 = "#3a3026";
const OPT = ["#5eeae5", "#da69b9", "#439bf7", "#92ac18", "#bcb2fd"];
const GLYPH = ["▲", "■", "◆", "●", "★"];
const FONTS = "https://fonts.googleapis.com/css2?family=Fraunces:opsz,wght,SOFT@9..144,400..700,0..100&family=IBM+Plex+Mono:wght@400;500;600&family=IBM+Plex+Sans:wght@400;500;600&display=block";

// ---- The mark: a worker ant seen from above, head up, on a 64-unit grid.
// Three body segments, six legs with one bend, elbowed antennae.
const LEGS = [
  [[28.8, 26], [22.5, 22.5], [20, 17]],     // front: forward
  [[28.6, 29.5], [20, 31], [15.5, 35]],     // middle: out
  [[29.2, 32], [23, 37], [19, 44.5]],       // hind: back
];
const ANTENNA = [[29.6, 13], [27, 8], [22.5, 6.5]];
const mirror = (pts) => pts.map(([x, y]) => [64 - x, y]);
const line = (pts) => "M" + pts.map((p) => p.join(" ")).join(" L");

function ant(fill, stroke = 2.6) {
  const strokes = [...LEGS, ANTENNA].flatMap((l) => [line(l), line(mirror(l))]);
  return `<g fill="${fill}"><path d="${strokes.join(" ")}" fill="none" stroke="${fill}" stroke-width="${stroke}" stroke-linecap="round" stroke-linejoin="round"/>` +
    `<circle cx="32" cy="17" r="5.2"/><ellipse cx="32" cy="28.5" rx="3.8" ry="5.2"/><ellipse cx="32" cy="46" rx="8.2" ry="11"/></g>`;
}

const svg = (w, h, body, title) =>
  `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}"${title ? ` role="img" aria-label="${title}"` : ""}>${body}</svg>\n`;

// Amber ant on any dark ground; no background.
const MARK = ant(AMBER);
// On light ground amber is too faint (2:1 on white), so the light lockup uses
// the pressed amber for the ant and "Anto", and ink for "nomy".
const AMBER_DEEP = "#b8741f";
// App icon and favicon: ink ant on an amber tile.
const ICON = `<rect width="64" height="64" rx="14" fill="${AMBER}"/><g transform="translate(5.12 5.12) scale(.84)">${ant(INK, 2.9)}</g>`;

// ---- The art: seed 42's colony at its final tick, the same run as
// docs/demo-colony.svg (result hash in the caption).
function colonyArt() {
  const colony = new Colony(seedFromInt(42));
  while (colony.step());
  const res = colony.result();
  const levels = [0.1, 0.22, 0.36, 0.52, 0.7, 0.9];
  const buckets = levels.map(() => []);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const v = colony.cell(y * W + x) / CAP;
    if (v > 0.02) buckets[Math.min(levels.length - 1, Math.floor(v * levels.length))].push(`M${x} ${y}h1v1h-1z`);
  }
  const trail = buckets.map((c, b) => c.length ? `<path d="${c.join("")}" fill="${AMBER}" fill-opacity="${levels[b]}"/>` : "").join("");
  const ants = [];
  for (let a = 0; a < colony.ants; a++) ants.push(`<circle cx="${(colony.ax[a] / 256).toFixed(2)}" cy="${(colony.ay[a] / 256).toFixed(2)}" r=".2"/>`);
  const piles = res.sources.map(([sx, sy], src) => {
    const o = res.perm.indexOf(src);
    return `<g transform="translate(${sx + 0.5} ${sy + 0.5})"><circle r="1.6" fill="${SOIL950}" stroke="${OPT[o]}" stroke-width=".22"/>` +
      `<text y=".55" font-size="1.6" text-anchor="middle" fill="${OPT[o]}" font-family="'IBM Plex Mono', monospace">${GLYPH[o]}</text></g>`;
  }).join("");
  const nest = `<circle cx="${NEST_X + 0.5}" cy="${NEST_Y + 0.5}" r="1.6" fill="${SOIL950}" stroke="${BONE}" stroke-width=".22"/>`;
  // A soft copy of the trail under the crisp one, so cells read as a field.
  const body = `<defs><filter id="soft" x="-5%" y="-5%" width="110%" height="110%"><feGaussianBlur stdDeviation=".7"/></filter></defs>` +
    `<g filter="url(#soft)" opacity=".9">${trail}</g><g opacity=".55">${trail}</g>` +
    `<g fill="${BONE}" fill-opacity=".85">${ants.join("")}</g>${nest}${piles}`;
  return { body, hash: res.hash, ticks: TICKS };
}

// ---- HTML for the rendered pieces. Type follows the design system: Plex Sans
// for the wordmark and copy, Plex Mono for numbers, Fraunces for the headline.
const page = (w, h, css, html) => `<!doctype html><meta charset="utf-8">
<link rel="stylesheet" href="${FONTS}">
<style>
  * { box-sizing: border-box; margin: 0; }
  html, body { width: ${w}px; height: ${h}px; overflow: hidden; background: transparent; }
  body { font-family: "IBM Plex Sans", sans-serif; color: ${BONE}; -webkit-font-smoothing: antialiased; }
  .wm { font-weight: 600; letter-spacing: -0.02em; line-height: 1; white-space: nowrap; }
  .wm b { font-weight: inherit; color: ${AMBER}; }
  .mono { font-family: "IBM Plex Mono", monospace; font-variant-numeric: tabular-nums; }
  .lockup { display: inline-flex; align-items: center; }
  ${css}
</style>
<body>${html}</body>`;

const lockup = (size, light = false) =>
  `<span class="lockup" style="gap:${size * 0.1}px">${svg(size * 1.25, size * 1.25, `<g transform="scale(${size * 1.25 / 64})">${light ? ant(AMBER_DEEP) : MARK}</g>`)}` +
  `<span class="wm" style="font-size:${size}px${light ? `;color:${INK}` : ""}"><b${light ? ` style="color:${AMBER_DEEP}"` : ""}>Anto</b>nomy</span></span>`;

// The lockup as a vector. The wordmark is live text in IBM Plex Sans, which
// the file imports from Google Fonts: it renders right in a browser, but
// design tools need the font installed. The PNGs are safe everywhere.
function lockupSVG(light) {
  const [anto, nomy, mark] = light ? [AMBER_DEEP, INK, ant(AMBER_DEEP)] : [AMBER, BONE, MARK];
  return svg(372, 80, `<style>@import url("${FONTS.replace(/&/g, "&amp;")}");</style>` +
    `<g transform="translate(-10 -2) scale(1.3125)">${mark}</g>` +
    `<text x="72" y="55" font-family="'IBM Plex Sans', 'Helvetica Neue', Arial, sans-serif" font-size="48" font-weight="600" letter-spacing="-0.96" fill="${nomy}"><tspan fill="${anto}">Anto</tspan>nomy</text>`, "Antonomy");
}

// A .ico holding PNG images (Windows Vista and later, every current browser).
function ico(pngs) {
  const head = Buffer.alloc(6 + 16 * pngs.length);
  head.writeUInt16LE(1, 2); head.writeUInt16LE(pngs.length, 4);
  let offset = head.length;
  pngs.forEach(({ size, data }, i) => {
    const e = 6 + 16 * i;
    head[e] = size % 256; head[e + 1] = size % 256;
    head.writeUInt16LE(1, e + 4); head.writeUInt16LE(32, e + 6);
    head.writeUInt32LE(data.length, e + 8); head.writeUInt32LE(offset, e + 12);
    offset += data.length;
  });
  return Buffer.concat([head, ...pngs.map((p) => p.data)]);
}

function card(w, h, art, { headline, sub, pad, artBox, logo, small }) {
  const css = `
    body { background: ${SOIL950}; position: relative; }
    .art { position: absolute; ${artBox} }
    .art svg { width: 100%; height: 100%; display: block; }
    .fade { position: absolute; inset: 0; background: linear-gradient(90deg, ${SOIL950} 34%, rgb(13 10 7 / .82) 52%, rgb(13 10 7 / 0) 78%); }
    .copy { position: absolute; left: ${pad}px; top: 0; bottom: 0; display: flex; flex-direction: column; justify-content: center; gap: ${small ? 18 : 26}px; max-width: ${w * 0.5}px; }
    h1 { font-family: "Fraunces", serif; font-variation-settings: "opsz" 144, "SOFT" 30; font-weight: 600; font-size: ${small ? 46 : 60}px; line-height: 1.04; letter-spacing: -0.02em; }
    h1 span { color: ${AMBER}; }
    p { font-size: ${small ? 19 : 23}px; line-height: 1.4; color: ${MUTED}; max-width: 30em; }
    .meta { font-size: ${small ? 15 : 17}px; color: ${MUTED}; display: flex; gap: 14px; }
    .meta b { color: ${AMBER}; font-weight: 600; }
    .cap { position: absolute; right: 32px; bottom: 24px; font-size: 13px; color: ${MUTED}; opacity: .8; }`;
  const html = `<div class="art">${svg(W, H, art.body).replace("<svg ", `<svg preserveAspectRatio="xMidYMid slice" `)}</div><div class="fade"></div>
    <div class="copy">${logo}<h1>${headline}</h1>${sub ? `<p>${sub}</p>` : ""}
    <div class="meta mono"><b>$ANTO</b><span>NEAR testnet</span><span>${SIM_VERSION}</span></div></div>
    <div class="cap mono">seed 42 · tick ${art.ticks} · hash ${art.hash.slice(0, 8)}…${art.hash.slice(-8)}</div>`;
  return page(w, h, css, html);
}

// ---- Write
const out = (name, text) => { writeFileSync(join(here, name), text); console.log("wrote", name); };
out("mark.svg", svg(64, 64, MARK, "Antonomy"));
out("mark-ink.svg", svg(64, 64, ant(INK), "Antonomy"));
out("mark-bone.svg", svg(64, 64, ant(BONE), "Antonomy"));
out("icon.svg", svg(64, 64, ICON, "Antonomy"));
out("lockup.svg", lockupSVG(false));
out("lockup-light.svg", lockupSVG(true));

if (!svgOnly) {
  const chrome = process.env.CHROME ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
  if (!existsSync(chrome)) throw new Error(`no Chrome at ${chrome}; set CHROME or pass --svg-only`);
  const tmp = mkdtempSync(join(tmpdir(), "anto-brand-"));
  const render = (name, w, h, html) => {
    const file = join(tmp, name.replace(/\.png$/, ".html"));
    writeFileSync(file, html);
    execFileSync(chrome, ["--headless", "--disable-gpu", "--hide-scrollbars", "--force-device-scale-factor=1",
      "--default-background-color=00000000", "--virtual-time-budget=10000",
      `--window-size=${w},${h}`, `--screenshot=${join(here, name)}`, `file://${file}`], { stdio: "ignore" });
    console.log("wrote", name);
  };
  const iconPage = (s) => page(s, s, "", svg(s, s, `<g transform="scale(${s / 64})">${ICON}</g>`));
  render("icon-512.png", 512, 512, iconPage(512));
  render("apple-touch-icon.png", 180, 180, iconPage(180));
  // X and Telegram crop avatars to a circle: a full-bleed amber square, ant inside the circle.
  render("avatar-400.png", 400, 400, page(400, 400, `body { background: ${AMBER}; }`,
    svg(400, 400, `<g transform="translate(70 70) scale(${260 / 64})">${ant(INK, 2.9)}</g>`)));
  render("mark-512.png", 512, 512, page(512, 512, "", svg(512, 512, `<g transform="scale(8)">${MARK}</g>`)));
  const tiny = (s) => {
    const name = join(tmp, `icon-${s}.png`);
    execFileSync(chrome, ["--headless", "--disable-gpu", "--hide-scrollbars", "--force-device-scale-factor=1",
      "--default-background-color=00000000", `--window-size=${s},${s}`, `--screenshot=${name}`,
      `data:text/html,${encodeURIComponent(iconPage(s))}`], { stdio: "ignore" });
    return { size: s, data: readFileSync(name) };
  };
  writeFileSync(join(here, "favicon.ico"), ico([tiny(16), tiny(32), tiny(48)]));
  console.log("wrote favicon.ico");
  const lockupCSS = "body { display: flex; align-items: center; padding-left: 24px; }";
  render("lockup.png", 760, 160, page(760, 160, lockupCSS, lockup(84)));
  render("lockup-light.png", 760, 160, page(760, 160, lockupCSS, lockup(84, true)));
  const art = colonyArt();
  render("social-card.png", 1200, 630, card(1200, 630, art, {
    pad: 72, artBox: "left: 300px; right: -40px; top: -40px; bottom: -40px;", logo: lockup(34),
    headline: `The trending market,<br><span>forecast by ants.</span>`,
    sub: "Ant colonies forecast Polymarket on NEAR from one public seed. Every run has a hash you can check in your browser.",
  }));
  // X header: the avatar covers the bottom-left corner, so the copy sits right of it.
  render("x-header.png", 1500, 500, card(1500, 500, art, {
    pad: 300, small: true, artBox: "left: 620px; right: -30px; top: -60px; bottom: -60px;", logo: lockup(28),
    headline: `The trending market, <span>forecast by ants.</span>`, sub: "",
  }));
}
