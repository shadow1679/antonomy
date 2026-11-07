// Offline tests for the browser's Polymarket reading: node web/test_polymarket.mjs
// The keeper (keeper/trending.py) is the reference: the same fixture events go
// through both, and the posts and refusals must match.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import {
  bps, blocked, buildPost, requestPost, screen, hit, slugDenied, slugOk, search, readMarket, GAMMA, CLOB,
} from "./polymarket.mjs";

const KEEPER = fileURLToPath(new URL("../keeper", import.meta.url));
const NOW = Date.UTC(2026, 10, 3, 12); // the keeper tests' clock
const TARGET = NOW / 1000 - 6 * 3600;

// Price to basis points: exact on the decimal text, half-even, clamped.
for (const [p, want] of [["0.62", 6200], [0.555, 5550], ["0.00005", 0], ["0.00015", 2], ["0.00025", 2],
  ["1e-05", 0], ["5E-4", 5], ["1", 10000], ["1.2", 10000], ["-0.1", 0], [".5", 5000], ["0.123456", 1235]]) {
  assert.equal(bps(p), want, `bps(${p})`);
}

// Fixtures in the keeper tests' shape.
const market = (mid, prices, labels = ["Yes", "No"], title = null, vol = 1000) => ({
  id: String(mid), question: `q${mid}`, groupItemTitle: title, active: true, closed: false,
  outcomes: JSON.stringify(labels), outcomePrices: JSON.stringify(prices.map(String)),
  clobTokenIds: JSON.stringify(labels.map((_, i) => `tok${mid}-${i}`)), volume24hr: vol,
});
const event = (markets, kw = {}) => ({
  id: "77", slug: "who-wins-the-cup", title: "Who wins the cup?", active: true, closed: false, negRisk: false,
  volume24hr: 500_000, liquidity: 200_000, endDate: "2026-11-20T00:00:00Z",
  tags: [{ label: "Sports" }], markets, ...kw,
});
const legs6 = [0.05, 0.40, 0.25, 0.15, 0.10, 0.05].map((p, i) => market(10 + i, [p, +(1 - p).toFixed(2)], ["Yes", "No"], `P${i}`));
const events = [
  event([market(5, ["0.62", "0.38"])]),
  event([market(6, ["0.5", "0.5"], ["Odd", "Even"], null, 10), market(5, ["0.3", "0.7"], ["Home", "Away"], null, 9000)]),
  event(legs6, { negRisk: true }),
  event([market(5, ["0.985", "0.015"])]),                       // decided
  event([market(5, ["0.5", "0.5"], ["A", "A"])]),                // duplicate labels
  event([market(5, ["0.5", "0.5"])], { tags: [{ label: "Geopolitics" }] }),
  event([market(5, ["0.5", "0.5"])], { title: "Will X be killed by June?" }),
  event([market(5, ["0.5", "0.5"])], { title: "Warriors vs. Lakers" }),
  event([market(5, ["0.5", "0.5"])], { closed: true }),
  event([{ ...market(5, ["0.5", "0.5"]), question: "Ceasefire before 2027?" }]),
  event([market(5, ["0.2", "0.3", "0.1", "0.1", "0.2", "0.1"], ["a", "b", "c", "d", "e", "f"])]),
];
// Price points around the six-hours-back target, one series per token.
const history = {};
for (const e of events) for (const m of e.markets) for (const [i, t] of JSON.parse(m.clobTokenIds).entries()) {
  history[t] = [{ t: TARGET - 600, p: 0.2 + 0.05 * i }, { t: TARGET - 60, p: 0.55 - 0.1 * i }, { t: TARGET + 60, p: 0.99 }];
}
const hist = (tok) => history[tok] ?? [];

// The keeper on the same fixtures.
const py = spawnSync("python3", ["-I", "-c", `
import json, sys, datetime as dt
from decimal import Decimal
sys.path.insert(0, ${JSON.stringify(KEEPER)})
import trending as t
d = json.loads(sys.stdin.read(), parse_float=Decimal)
now = dt.datetime.fromtimestamp(d["now"], dt.timezone.utc)
h = lambda tok, target: d["history"].get(tok, [])
print(json.dumps([{"blocked": t.blocked(e), "post": t.build_post(e, now, h),
  "request": t.request_post(e, now, e["slug"], h)} for e in d["events"]]))
`], { input: JSON.stringify({ now: NOW / 1000, history, events }), encoding: "utf8" });
assert.equal(py.status, 0, py.stderr);
const want = JSON.parse(py.stdout);
events.forEach((e, i) => {
  assert.deepEqual(blocked(e), want[i].blocked, `blocked #${i}`);
  assert.deepEqual(buildPost(e, NOW, hist), want[i].post, `build_post #${i}`);
  assert.deepEqual(requestPost(e, NOW, e.slug, hist), want[i].request, `request_post #${i}`);
});
// Spot checks, so a shared mistake can't pass.
assert.deepEqual(want[0].post, { market_id: "who-wins-the-cup", outcomes: ["Yes", "No"], odds: [6200, 3800], odds_6h: [5500, 4500] });
assert.deepEqual(want[2].post.outcomes, ["P1", "P2", "P3", "P4", "Other"]);
assert.equal(want[7].blocked, null);
assert.match(want[3].post, /effectively decided/);

// The contract's slug rules (token/src/request.rs).
assert.equal(slugDenied("will-x-be-killed-by-june"), true);
assert.equal(slugDenied("nuclear-deal-2027"), true);
assert.equal(slugDenied("warriors-vs-lakers"), false);
assert.equal(slugDenied("fed-decision-in-december"), false);
assert.equal(slugOk("fed-decision-in-december"), true);
assert.equal(slugOk("Fed_Decision"), false);
assert.equal(slugOk("x".repeat(129)), false);

// Search hits: what would be forecast, and why not.
assert.equal(screen(events[0]), null);
assert.equal(screen(events[3]), "effectively decided");
assert.match(screen(events[5]), /content filter: tag geopolitics/);
assert.equal(screen({ ...events[0], slug: "who-dies-first" }), "refused by the contract's slug filter");
const h1 = hit({ ...events[1], tags: [{ label: "All" }, { label: "Weekly" }, { label: "Sports" }] });
assert.deepEqual([h1.outcomes, h1.question, h1.topic, h1.why], [2, "q5", "Sports", null]);
assert.equal(hit(events[2]).outcomes, 5);
assert.equal(hit(events[2]).question, "");

// The network side with a fake fetch.
function fakeFetch(routes) {
  const seen = [];
  const f = async (url) => {
    seen.push(url);
    const key = Object.keys(routes).find((k) => url.startsWith(k));
    if (!key) return { ok: false, status: 404, text: async () => "" };
    return { ok: true, status: 200, text: async () => routes[key] };
  };
  f.seen = seen;
  return f;
}
const ev = events[0];
const bodies = [JSON.stringify([ev]), JSON.stringify({ history: history["tok5-0"] }), JSON.stringify({ history: history["tok5-1"] })];
const f = fakeFetch({
  [`${GAMMA}/events?slug=who-wins-the-cup`]: bodies[0],
  [`${GAMMA}/events?slug=who-wins`]: "[]", // Gamma's answer for an unknown slug
  [`${CLOB}/prices-history?market=tok5-0&`]: bodies[1],
  [`${CLOB}/prices-history?market=tok5-1&`]: bodies[2],
  [`${GAMMA}/public-search?`]: JSON.stringify({ events: [ev, events[5], { title: "no slug" }] }),
});
const r = await readMarket(f, "who-wins-the-cup", NOW);
assert.deepEqual(r.post, { market_id: "who-wins-the-cup", outcomes: ["Yes", "No"], odds: [6200, 3800], odds_6h: [5500, 4500],
  raw_hash: createHash("sha256").update(bodies.join("")).digest("hex") });
assert.equal(r.hit.title, "Who wins the cup?");
assert.match(f.seen[1], new RegExp(`startTs=${TARGET - 7200}&endTs=${TARGET}`));
assert.deepEqual(await readMarket(f, "who-wins", NOW), { why: "no event with slug 'who-wins'" });
const found = await search(f, "cup");
assert.deepEqual(found.map((x) => [x.slug, x.why]), [["who-wins-the-cup", null], ["who-wins-the-cup", "content filter: tag geopolitics"]]);
assert.match(f.seen.at(-1), /q=cup&limit_per_type=12&events_status=active&keep_closed_markets=0/);
await assert.rejects(search(fakeFetch({}), "x"), /answered 404/);

console.log("polymarket: all tests passed");
