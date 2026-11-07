// Add a market, on the Live page's side and first on Recruit's Forecast tab:
// find a Polymarket market by link, ID or search, check it the way a keeper does,
// and pay the request fee from the connected wallet. The search is the one
// read from outside the chain the pages make. `slugOf`, `overlapOf` and
// `payBlock` are pure (web/test_addmarket.mjs); `mountAddMarket` wires the panel.

import { search, readMarket, hit, slugOk, GAMMA } from "./polymarket.mjs";
import { tokens, feeSplitHTML, findRequest, failureOf, recentRequests } from "./recruit.mjs";
import { chain, wallet, ensureTokens } from "./chain.mjs";
import { esc } from "./ui.mjs";

const MAX_HITS = 5;
const PHASE = { odds: "keepers posting", forecasting: "agents posting", running: "cranking", done: "done" };

// A pasted polymarket.com/event/<slug> link, or a bare slug; null for search text.
export function slugOf(q) {
  const m = /polymarket\.com\/(?:[a-z]{2}\/)?event\/([a-z0-9-]+)/i.exec(q);
  const s = (m ? m[1] : q).toLowerCase();
  return m || (/^[a-z0-9-]{8,}$/.test(s) && s.includes("-")) ? s : null;
}

// Where `slug` already runs: a market of this round (`markets` from
// loadRound(), each with marketId, index and key) and the newest request for
// it that wasn't skipped (`requests`, any order).
export function overlapOf(slug, markets = [], requests = []) {
  const m = markets.find((x) => x.marketId === slug);
  const r = [...requests].sort((a, b) => b.id - a.id).find((x) => x.market_id === slug && x.phase !== "skipped");
  return { round: m ? { n: m.index + 1, anchor: `mk-${m.key}` } : null, request: r ?? null };
}

// Why this wallet can't pay the fee, or null. Amounts in yocto (BigInt);
// a wallet that hasn't claimed the faucet gets its play tokens on the first
// request, so only a claimed one can come up short.
export function payBlock(balance, fee, claimed) {
  if (balance == null || fee == null || balance >= fee || !claimed) return null;
  return `You have ${tokens(balance)} $ANTO; a request costs ${tokens(fee)}. The faucet is once per account.`;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(test, ms = 30_000, step = 1500) {
  const end = Date.now() + ms;
  for (;;) {
    const v = await test().catch(() => null);
    if (v) return v;
    if (Date.now() > end) return null;
    await sleep(step);
  }
}

const ends = (iso) => (iso ? new Date(iso).toISOString().slice(0, 10) : "");

// The panel. `cfg()` is parseConfig(request_config) or null, `markets()` this
// round's markets, `followHref(id)` a request's page, `onRequested(r)` runs
// once a new request is on chain, `roundHref(anchor)` links a market of the
// round. Returns { lookup(q), refresh() }.
export function mountAddMarket({ cfg, markets, followHref, onRequested, roundHref = (a) => `#${a}` }) {
  const $ = (id) => document.getElementById(id);
  const HINT = $("add-status").textContent;
  const st = { hits: [], picked: -1, pick: null, overlap: null, balance: null, claimed: true, busy: false };
  let searchAbort = null, readAbort = null, timer = 0;

  const status = (t) => { $("add-status").textContent = t; };
  const say = (html) => { $("add-tx").innerHTML = html; };
  const fail = (e) => say(`<span class="fc-add__fail">✗ ${esc(e.message || e)}</span>`);

  function paintHits() {
    $("add-hits").hidden = !st.hits.length || (st.hits.length === 1 && !!st.pick);
    $("add-hits").innerHTML = st.hits.map((h, i) =>
      `<li><label class="fc-add__hit"><input type="radio" name="add-hit" value="${i}"${i === st.picked ? " checked" : ""}${h.why ? " disabled" : ""}>` +
      `<span class="fc-add__hit-t">${esc(h.title)}</span>` +
      `<span class="fc-add__hit-m">${esc(h.topic)}${h.endDate ? ` · ends ${ends(h.endDate)}` : ""}${h.outcomes ? ` · ${h.outcomes} outcomes` : ""}</span>` +
      (h.why ? `<span class="fc-add__hit-m">✗ ${esc(h.why)}</span>` : "") + `</label></li>`).join("");
  }

  function paintPick() {
    const p = st.pick, o = st.overlap;
    $("add-pick").hidden = !p;
    if (!p) return;
    const lines = [`<p class="fc-add__check"><span class="lv-g">✓</span> Open, allowed topic, not decided: the keepers would take it.</p>`];
    if (o?.round) lines.push(`<p class="fc-add__check"><span class="lv-g">○</span> Already forecast this round as #${o.round.n}. No fee needed. <a href="${esc(roundHref(o.round.anchor))}">Show it</a></p>`);
    else if (o?.request) lines.push(`<p class="fc-add__check"><span class="lv-g">○</span> Already requested as <a href="${esc(followHref(o.request.id))}">#${o.request.id}</a> (${esc(PHASE[o.request.phase] ?? o.request.phase)}). Pay again for a fresh run.</p>`);
    $("add-pick").innerHTML = `<p class="fc-add__title">${esc(p.title)}</p>` +
      `<p class="fc-add__src">Polymarket · <code>${esc(p.slug)}</code>${p.endDate ? ` · ends ${ends(p.endDate)}` : ""}</p>` +
      `<p class="fc-add__outs">${p.outcomes.map((x, i) => `<span class="opt" data-opt="${i}">${esc(x)}</span>`).join(" ")}</p>` + lines.join("");
  }

  function paintCost() {
    const c = cfg(), me = wallet.accountId;
    $("add-split").innerHTML = c ? feeSplitHTML(c, { notes: false }) : "";
    $("add-cost").innerHTML = !c ? "Fee read from the contract…"
      : !me ? `Fee <span class="num">${tokens(c.fee)} $ANTO</span>`
      : st.balance == null ? `Fee <span class="num">${tokens(c.fee)} $ANTO</span> · reading your balance…`
      : `Fee <span class="num">${tokens(c.fee)} $ANTO</span> · you have <span class="num">${tokens(st.balance)} $ANTO</span>` +
        (st.balance < c.fee && !st.claimed ? " · the first request claims your free play tokens" : "");
  }

  function paintGo() {
    const c = cfg(), me = wallet.accountId, go = $("add-go");
    const block = c && me ? payBlock(st.balance, c.fee, st.claimed) : null;
    const ready = !!(c && me && st.pick && !st.overlap?.round && !block && !st.busy);
    go.className = `btn${ready ? " btn--primary" : ""}`;
    go.disabled = st.busy || (!!me && !ready);
    go.textContent = !me ? "Connect a wallet to request" : c ? `Request forecast · ${tokens(c.fee)} $ANTO` : "Request forecast";
    $("add-why").textContent = !me || ready || st.busy ? "" : !c ? "Waiting for the contract's fee." : !st.pick ? "Pick a market first."
      : st.overlap?.round ? "This market is already in the round." : block ?? "";
  }

  function paint() { paintHits(); paintPick(); paintCost(); paintGo(); }

  async function pick(i) {
    const h = st.hits[i];
    if (!h || h.why) return;
    readAbort?.abort();
    readAbort = new AbortController();
    st.picked = i; st.pick = null; st.overlap = null;
    status(`Checking ${h.title} the way a keeper does…`);
    paint();
    try {
      const [r, reqs] = await Promise.all([
        readMarket(fetch, h.slug, Date.now(), { signal: readAbort.signal }),
        recentRequests(20).catch(() => []),
      ]);
      if (r.why) {
        h.why = r.why; st.picked = -1;
        status(`The keepers would refuse it: ${r.why}. Pick another market.`);
      } else {
        st.pick = { slug: h.slug, title: h.title, outcomes: r.post.outcomes, endDate: h.endDate };
        st.overlap = overlapOf(h.slug, markets() ?? [], reqs);
        status(HINT);
      }
    } catch (e) {
      if (e.name === "AbortError") return;
      st.picked = -1;
      status(`Couldn't check ${h.title}: ${e.message}.`);
    }
    paint();
  }

  async function lookup(q) {
    searchAbort?.abort();
    readAbort?.abort();
    st.hits = []; st.picked = -1; st.pick = null; st.overlap = null;
    say("");
    if (q.length < 2) { status(HINT); paint(); return; }
    searchAbort = new AbortController();
    status("Looking it up on Polymarket…");
    paint();
    const slug = slugOf(q);
    try {
      if (slug && slugOk(slug)) {
        const r = await fetch(`${GAMMA}/events?${new URLSearchParams({ slug })}`, { signal: searchAbort.signal });
        const found = r.ok ? await r.json() : [];
        st.hits = found.length ? [hit(found[0])] : [];
      } else {
        st.hits = (await search(fetch, q, { signal: searchAbort.signal })).slice(0, MAX_HITS);
      }
    } catch (e) {
      if (e.name === "AbortError") return;
      status(`Polymarket didn't answer: ${e.message}.`);
      paint();
      return;
    }
    const ok = st.hits.filter((h) => !h.why).length;
    status(!st.hits.length ? "No open market matches." : st.hits.length === 1 && st.hits[0].why ? `Can't request it: ${st.hits[0].why}.`
      : st.hits.length === 1 ? HINT : `${st.hits.length} open markets, ${ok} you can request. Pick one.`);
    paint();
    if (st.hits.length === 1 && ok) pick(0);
  }

  async function refresh() {
    const me = wallet.accountId;
    st.balance = null; st.claimed = true;
    if (me) {
      try { [st.balance, st.claimed] = await Promise.all([chain.balance(me), chain.hasClaimed(me)]); } catch { /* shown as unknown */ }
    }
    paint();
  }

  async function request() {
    const me = wallet.accountId, c = cfg(), p = st.pick;
    st.busy = true; paintGo();
    try {
      if (await chain.paused()) throw new Error("the contract is paused, so it takes no requests until the guardian unpauses it");
      say("Checking your balance…");
      if (await ensureTokens(me)) say("Claimed your free play tokens. Waiting for them to land…");
      const have = await until(async () => ((await chain.balance(me)) >= c.fee ? true : null));
      if (!have) throw new Error(`a request costs ${tokens(c.fee)} $ANTO and you have ${tokens(await chain.balance(me))}`);
      const before = await chain.requestCount();
      say("Approve the request in your wallet…");
      const f = failureOf(await wallet.call("request_forecast", { market_id: p.slug }, { gasTgas: 30 }));
      if (f) throw new Error(f);
      say("Sent. Waiting for the request to show on chain…");
      const r = await until(() => findRequest(p.slug, me, Math.max(0, before - 1)));
      if (!r) throw new Error("the transaction went through but the request isn't visible yet; it will show under Community markets");
      say(`Requested as #${r.id}. <a href="${esc(followHref(r.id))}">Follow it ›</a>`);
      st.overlap = { round: null, request: r };
      onRequested(r);
    } catch (e) {
      fail(e);
    } finally {
      st.busy = false;
      refresh();
    }
  }

  $("add-in").addEventListener("input", (e) => {
    clearTimeout(timer);
    timer = setTimeout(() => lookup(e.target.value.trim()), 350);
  });
  // Enter in the field looks it up now; only the button submits.
  $("add-in").addEventListener("keydown", (e) => {
    if (e.key !== "Enter") return;
    e.preventDefault();
    clearTimeout(timer);
    lookup(e.target.value.trim());
  });
  $("add-hits").addEventListener("change", (e) => { if (e.target.name === "add-hit") pick(+e.target.value); });
  $("add-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    if (st.busy) return;
    if (!wallet.accountId) { try { await wallet.connect(); } catch (err) { fail(err); } return; }
    if (st.pick) request();
  });
  wallet.onChange(refresh);
  refresh();
  return {
    lookup: (q) => { $("add-in").value = q; lookup(q.trim()); },
    // The round's markets changed: re-check the pick against them.
    refresh: () => { if (st.pick) st.overlap = { ...overlapOf(st.pick.slug, markets() ?? []), request: st.overlap?.request ?? null }; paint(); },
  };
}
