// Reading a Polymarket market in the browser, for Recruit the swarm's search:
// a JS port of the keeper's market reading (keeper/trending.py: the content
// filter, the outcome legs, the six-hours-back odds and the request post) and
// of the contract's slug rules. Polymarket's read APIs allow any origin, so
// the page can search and read a market directly.
//
// This only picks the market for Recruit the swarm's search and checks that a
// keeper would not refuse it. The forecast itself reads nothing from
// Polymarket in the browser: the keepers post the odds on chain and the
// colonies read those. The functions
// below are pure (the fetches take `fetch` as an argument), so Node tests
// them against the Python keeper (web/test_polymarket.mjs).

import { sha256, toHex } from "../sim/js/antosim.mjs";

export const GAMMA = "https://gamma-api.polymarket.com";
export const CLOB = "https://clob.polymarket.com";
const BPS = 10_000;
export const MAX_OUTCOMES = 5;
const SIX_HOURS = 6 * 3600;
const MAX_TOP_ODDS = 9700; // effectively decided
const MAX_ID_LEN = 128;    // the contract's market id limit

// Content filter, as keeper/trending.py: no violence, deaths or private
// individuals. A keyword list cannot catch everything.
const DENY_TAGS = new Set([
  "war", "geopolitics", "military", "terrorism", "crime", "ukraine", "russia-ukraine",
  "israel", "gaza", "middle east", "iran", "mentions", "health",
]);
const DENY_WORDS = new RegExp(
  String.raw`\b(kill\w*|death\w*|dead|die[sd]?|dying|assassinat\w*|murder\w*|shoot\w*|bomb\w*|` +
  String.raw`missile\w*|airstrike\w*|strikes? on|invade\w*|invasion|attack\w*|war|ceasefire|` +
  String.raw`hostage\w*|terror\w*|nuclear|casualt\w*|arrest\w*|indict\w*|sentenc\w*|pregnan\w*|` +
  String.raw`divorce\w*|baby|wedding|tweet\w*|post on x|say .* during)\b`,
  "i",
);

// The contract's slug deny list (token/src/request.rs): `*` marks a stem.
const SLUG_DENY = ["kill*", "death*", "dead", "die", "dies", "died", "dying", "assassinat*", "murder*",
  "shoot*", "bomb*", "missile*", "airstrike*", "invade*", "invasion", "attack*", "war", "ceasefire",
  "hostage*", "terror*", "nuclear", "casualt*", "arrest*", "indict*", "sentenc*", "pregnan*",
  "divorce*", "baby", "wedding", "tweet*"];

export const slugDenied = (slug) => slug.split("-").some((w) =>
  SLUG_DENY.some((d) => (d.endsWith("*") ? w.startsWith(d.slice(0, -1)) : w === d)));

export const slugOk = (slug) => typeof slug === "string" && slug.length > 0 &&
  slug.length <= MAX_ID_LEN && /^[a-z0-9-]+$/.test(slug);

// Decimal price (0..1, a string or a JSON number) to basis points,
// half-even, clamped. Exact on the decimal text, like the keeper's Decimal.
export function bps(price) {
  const m = /^(-?)(\d*)(?:\.(\d*))?(?:e([+-]?\d+))?$/i.exec(String(price).trim());
  if (!m) throw new RangeError(`not a price: ${price}`);
  const [, sign, int = "", frac = "", exp = "0"] = m;
  const digits = BigInt((int + frac) || "0");
  const scale = frac.length - Number(exp) - 4; // value * 10^4 = digits / 10^scale
  let v;
  if (scale <= 0) v = digits * 10n ** BigInt(-scale);
  else {
    const d = 10n ** BigInt(scale), q = digits / d, r = digits % d;
    v = 2n * r > d || (2n * r === d && q % 2n === 1n) ? q + 1n : q;
  }
  if (sign) v = -v;
  return Number(v < 0n ? 0n : v > BigInt(BPS) ? BigInt(BPS) : v);
}

// Gamma returns some arrays as JSON strings.
const jlist = (v) => (typeof v === "string" ? JSON.parse(v) : v ?? []);
const num = (v) => Number(v ?? 0) || 0;

// Reason the content filter rejects the event, or null.
export function blocked(event) {
  const tags = new Set((event.tags ?? []).map((t) => String(t.label ?? "").toLowerCase()));
  const hit = [...tags].filter((t) => DENY_TAGS.has(t)).sort();
  if (hit.length) return `tag ${hit[0]}`;
  const texts = [event.title ?? "", ...(event.markets ?? []).map((m) => m.question ?? "")];
  for (const t of texts) {
    const m = DENY_WORDS.exec(t);
    if (m) return `word '${m[0]}'`;
  }
  return null;
}

// [{ label, token, odds, question }] in canonical order, or a reason string.
// Same order as the keeper, so keepers and this page post the same list:
// neg-risk legs keep the most likely (ties by market id) in market-id order,
// then the rest, which groupOther folds into "Other"; otherwise the
// highest-volume market of the event.
export function outcomeLegs(event) {
  const markets = (event.markets ?? []).filter((m) => m.active && !m.closed);
  if (!markets.length) return "no open markets";
  if (event.negRisk && markets.length > 1) {
    let legs = [];
    for (const m of markets) {
      const label = String(m.groupItemTitle ?? "").trim();
      const prices = jlist(m.outcomePrices), tokens = jlist(m.clobTokenIds);
      if (!label || !prices.length || !tokens.length) return `neg-risk leg ${m.id} lacks label or prices`;
      legs.push({ odds: bps(prices[0]), id: Number(m.id), label, token: tokens[0] });
    }
    legs.sort((a, b) => b.odds - a.odds || a.id - b.id);
    const k = legs.length <= MAX_OUTCOMES ? legs.length : MAX_OUTCOMES - 1;
    legs = [...legs.slice(0, k).sort((a, b) => a.id - b.id), ...legs.slice(k)];
    return legs.map(({ label, token, odds }) => ({ label, token, odds, question: event.title ?? "" }));
  }
  const m = markets.reduce((best, x) => {
    const d = num(x.volume24hr) - num(best.volume24hr);
    return d > 0 || (d === 0 && Number(x.id) < Number(best.id)) ? x : best;
  });
  const labels = jlist(m.outcomes), prices = jlist(m.outcomePrices), tokens = jlist(m.clobTokenIds);
  if (!(labels.length >= 2 && labels.length <= MAX_OUTCOMES && prices.length === labels.length && tokens.length === labels.length)) {
    return `market ${m.id} has ${labels.length} outcomes`;
  }
  return labels.map((l, i) => ({ label: String(l).trim(), token: tokens[i], odds: bps(prices[i]), question: m.question ?? "" }));
}

// Keep the first four outcomes and fold the rest into "Other".
export function groupOther(labels, odds, odds6h) {
  if (labels.length <= MAX_OUTCOMES) return [labels, odds, odds6h];
  const k = MAX_OUTCOMES - 1;
  const rest = (xs) => Math.max(0, BPS - xs.slice(0, k).reduce((a, b) => a + b, 0));
  return [[...labels.slice(0, k), "Other"], [...odds.slice(0, k), rest(odds)], [...odds6h.slice(0, k), rest(odds6h)]];
}

// Last price at or before `target` (unix seconds), else the earliest after.
export function priceAt(history, target) {
  const pts = history.map((p) => [Math.trunc(Number(p.t)), p.p]).sort((a, b) => a[0] - b[0]);
  if (!pts.length) return null;
  const before = pts.filter(([t]) => t <= target);
  return before.length ? before[before.length - 1][1] : pts[0][1];
}

// The keeper's post for an event at `nowMs`, or a reason string. `history(token,
// target)` returns that token's price points ({ t, p }) around `target`.
export function buildPost(event, nowMs, history) {
  const legs = outcomeLegs(event);
  if (typeof legs === "string") return legs;
  const target = Math.floor(nowMs / 1000) - SIX_HOURS;
  const k = legs.length <= MAX_OUTCOMES ? legs.length : MAX_OUTCOMES - 1;
  let labels = legs.map((l) => l.label), odds = legs.map((l) => l.odds), odds6h = [];
  for (const { token } of legs.slice(0, k)) {
    const p = priceAt(history(token, target), target);
    if (p == null) return "no price history six hours back";
    odds6h.push(bps(p));
  }
  while (odds6h.length < legs.length) odds6h.push(0); // replaced by the Other fold
  [labels, odds, odds6h] = groupOther(labels, odds, odds6h);
  if (new Set(labels).size !== labels.length) return "duplicate outcome labels";
  const top = Math.max(...odds);
  if (top >= MAX_TOP_ODDS) return `effectively decided (top outcome ${top} bps)`;
  if (top === 0 || Math.min(...odds) === BPS) return "degenerate odds";
  return { market_id: String(event.slug || event.id), outcomes: labels, odds, odds_6h: odds6h };
}

// The `market` argument of `post_request_odds` for a requested slug, or a
// reason string. No trending floors; the filter, open and decided checks apply.
export function requestPost(event, nowMs, slug, history) {
  if (event?.slug !== slug) return `no event with slug '${slug}'`;
  const why = blocked(event);
  if (why) return why;
  if (event.closed || !event.active) return "not open";
  const post = buildPost(event, nowMs, history);
  if (typeof post === "string") return post;
  post.market_id = slug;
  return post;
}

// Why a search hit can't be requested, or null: the contract's slug rules,
// the content filter, open, outcomes, and not already decided. Odds six
// hours back are only read once a hit is picked (`readMarket`).
export function screen(event) {
  if (!slugOk(event.slug)) return "slug the contract can't take";
  if (slugDenied(event.slug)) return "refused by the contract's slug filter";
  const why = blocked(event);
  if (why) return `content filter: ${why}`;
  if (event.closed || !event.active) return "not open";
  const legs = outcomeLegs(event);
  if (typeof legs === "string") return legs;
  if (Math.max(...legs.map((l) => l.odds)) >= MAX_TOP_ODDS) return "effectively decided";
  return null;
}

// Tags that say how a market is listed, not what it is about.
const LISTING_TAGS = /^(all|recurring|weekly|monthly|yearly|daily|hide from new|neg risk|multi strikes|hit price)$/i;

// One search hit for the picker: what would be forecast, and why not if not.
export function hit(event) {
  const legs = outcomeLegs(event);
  const ok = typeof legs !== "string";
  const tags = (event.tags ?? []).map((t) => t.label).filter(Boolean);
  return {
    slug: event.slug, title: event.title ?? event.slug, why: screen(event),
    outcomes: ok ? Math.min(legs.length, MAX_OUTCOMES) : 0,
    // Props around a main market: say which question the forecast is about.
    question: ok && !event.negRisk && (event.markets ?? []).length > 1 ? legs[0].question : "",
    topic: tags.find((t) => !LISTING_TAGS.test(t)) ?? "Polymarket",
    endDate: event.endDate ?? null,
  };
}

// ---- Network: `fetch` is passed in so tests run offline ----

async function getText(fetch, url, signal) {
  const r = await fetch(url, { signal, headers: { Accept: "application/json" } });
  if (!r.ok) throw new Error(`Polymarket answered ${r.status}`);
  return r.text();
}

// Open events matching `q`, as picker hits.
export async function search(fetch, q, { limit = 12, signal } = {}) {
  const qs = new URLSearchParams({ q, limit_per_type: limit, events_status: "active", keep_closed_markets: 0 });
  const body = JSON.parse(await getText(fetch, `${GAMMA}/public-search?${qs}`, signal));
  return (body.events ?? []).filter((e) => e.slug).map(hit);
}

// Read one market as a keeper does: the event, then six-hours-back prices
// for each kept outcome. { post, hit } or { why } when refused. The post's
// raw_hash is sha256 over the raw responses, as the keeper's.
export async function readMarket(fetch, slug, nowMs, { signal } = {}) {
  const raw = [];
  const get = async (url) => { const t = await getText(fetch, url, signal); raw.push(t); return JSON.parse(t); };
  const found = await get(`${GAMMA}/events?${new URLSearchParams({ slug })}`);
  const event = found?.[0] ?? {};
  const pre = event.slug === slug ? screen(event) : `no event with slug '${slug}'`;
  if (pre) return { why: pre };
  const legs = outcomeLegs(event);
  const target = Math.floor(nowMs / 1000) - SIX_HOURS;
  const k = legs.length <= MAX_OUTCOMES ? legs.length : MAX_OUTCOMES - 1;
  const hist = new Map();
  for (const { token } of legs.slice(0, k)) {
    const qs = new URLSearchParams({ market: token, startTs: target - 7200, endTs: target, fidelity: 5 });
    hist.set(token, (await get(`${CLOB}/prices-history?${qs}`)).history ?? []);
  }
  const post = requestPost(event, nowMs, slug, (tok) => hist.get(tok) ?? []);
  if (typeof post === "string") return { why: post };
  const bytes = raw.map((t) => new TextEncoder().encode(t));
  const all = new Uint8Array(bytes.reduce((n, b) => n + b.length, 0));
  bytes.reduce((at, b) => (all.set(b, at), at + b.length), 0);
  return { post: { ...post, raw_hash: toHex(sha256(all)) }, hit: hit(event) };
}
