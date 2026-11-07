// The Randomness section of the Recruit page (it was
// the Random page): ask the contract for a value, follow it until its drand
// round is out and proven, draw a name from a list, and check the value
// against drand's own signature. The pure part is web/random.mjs. Ids carry
// an `rnd-` prefix; `?rnd=<id>` opens a request, `?c=a,b,c` fills the names.

import { chain, wallet, ensureTokens, contractId, tokens } from "./chain.mjs";
import { beacon } from "./drand.mjs";
import {
  newestFirst, parseChoices, pickIndex, publishedAt, returnValueOf, secondsLeft, stage, steps, verifyRequest,
} from "./random.mjs";
import { failureOf } from "./recruit.mjs";
import { GLYPHS } from "./round.mjs";
import { esc, hashHTML, refreshTokenChip } from "./ui.mjs";

const STAGE_TEXT = {
  waiting: "waiting for its drand round",
  unproven: "drand round out · needs proving",
  ready: "ready",
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// drand rounds are minutes to years old: the date only when it isn't today.
function utc(ms) {
  const iso = new Date(ms).toISOString();
  return iso.slice(0, 10) === new Date().toISOString().slice(0, 10) ? `${iso.slice(11, 19)} UTC` : `${iso.slice(0, 16).replace("T", " ")} UTC`;
}

export function mountRandom() {
  const $ = (id) => document.getElementById(`rnd-${id}`);
  const q = new URLSearchParams(location.search);
  const idParam = q.has("rnd") ? Math.max(0, Math.floor(+q.get("rnd") || 0)) : null;
  // `missing` is an id the contract doesn't have (yet), so the card can say so.
  const state = { cfg: null, cur: idParam, latest: false, req: null, missing: null, recent: [] };
  if (q.has("c")) $("choices").value = q.get("c").split(",").join("\n");

  const showNote = (html) => { $("tx").hidden = false; $("tx").innerHTML = html; };
  const showError = (e) => {
    $("tx").hidden = false;
    $("tx").innerHTML = `<span class="notice notice--danger" style="display: inline-block; padding: var(--space-2) var(--space-3)"><strong>Failed:</strong> ${esc(e.message || e)}</span>`;
  };

  async function send(method, args, opts) {
    const out = await wallet.call(method, args, opts);
    const f = failureOf(out);
    if (f) throw new Error(f);
    return out;
  }

  function setBadge(s, text) { $("badge").dataset.state = s; $("badge").textContent = text; }

  // ---- the current request ----
  // The clock repaints every second, but only the parts that change: the steps
  // and the result line are keyed on what they show, and the facts (hashes a
  // reader may be selecting or copying) only when the chain's answer changes.

  const painted = { facts: "", live: "" };

  function resultHTML(r, st, names) {
    if (st === "waiting") {
      const left = secondsLeft(r, Date.now());
      return `<p class="rnd-big num">${left} s</p>
        <p class="text-sm text-muted">until drand publishes round ${r.drand_round}. Nobody, you included, can know the value before then.</p>`;
    }
    if (st === "unproven") {
      return `<p class="rnd-big">Round out</p>
        <p class="text-sm text-muted">drand has published round ${r.drand_round}. It needs one proof on chain, then the value is here.</p>
        <div class="cluster"><button class="btn btn--sm" type="button" id="rnd-prove">Prove the round</button>
        <span class="text-xs text-faint">Anyone can. The keeper daemon does it too; the first proof to land counts.</span></div>`;
    }
    if (names.length < 2) {
      return `<p class="rnd-big">Ready</p>
        <p class="text-sm text-muted">The value is below. Add two or more names to draw a winner from it.</p>`;
    }
    const i = pickIndex(r.value, names.length);
    return `<p class="rnd-big"><span class="glyph" aria-hidden="true">${GLYPHS[i % GLYPHS.length]}</span>${esc(names[i])}</p>
      <p class="text-sm text-muted">Name ${i + 1} of ${names.length}: the value mod ${names.length} is ${i}.</p>`;
  }

  function renderRequest() {
    const r = state.req;
    $("empty").hidden = !!r;
    for (const id of ["steps", "result", "facts"]) $(id).hidden = !r;
    $("note").textContent = r && state.latest ? "newest on the contract" : "";
    if (!r) {
      $("verify-box").hidden = true;
      $("title").textContent = state.missing != null ? `Request #${state.missing}` : "Request";
      $("stage").textContent = state.missing != null ? "not found" : "none yet";
      $("empty").textContent = state.missing != null
        ? `The contract has no request #${state.missing} yet. Pick one from the list below, or ask for a new value.`
        : "Request a value, or open one from the list below. A request is ready a few seconds after its drand round is published and proven.";
      painted.facts = painted.live = "";
      return;
    }
    const now = Date.now();
    const st = stage(r, now);
    const names = parseChoices($("choices").value);

    const live = JSON.stringify([r.id, r.status, r.value, st, st === "waiting" ? secondsLeft(r, now) : 0, names]);
    if (live !== painted.live) {
      painted.live = live;
      $("title").textContent = `Request #${r.id}`;
      $("stage").textContent = STAGE_TEXT[st];
      $("steps").innerHTML = steps(r, now).map((s) => `<li data-state="${s.state}">${esc(s.label)}</li>`).join("");
      if (!$("prove")?.disabled) $("result").innerHTML = resultHTML(r, st, names); // keep a proof in flight on screen
      $("verify-box").hidden = st !== "ready";
    }

    const facts = JSON.stringify([r.id, r.status, r.value]);
    if (facts !== painted.facts) {
      painted.facts = facts;
      $("by").textContent = r.requester + (r.requester === wallet.accountId ? " (you)" : "");
      $("round").innerHTML = `<span class="num">${r.drand_round}</span> <span class="text-xs text-faint">published ${utc(publishedAt(r.drand_round))}</span>`;
      $("rand").innerHTML = r.randomness ? hashHTML(r.randomness, "drand randomness") : `<span class="text-faint">not proven yet</span>`;
      $("value").innerHTML = r.value ? hashHTML(r.value, "value") : `<span class="text-faint">not proven yet</span>`;
    }
  }

  async function loadCurrent() {
    if (state.cur == null) return;
    try {
      const req = await chain.randomness(state.cur);
      state.req = req;
      state.missing = req == null ? state.cur : null;
    } catch { /* keep what we had */ }
    renderRequest();
  }

  function setCurrent(id) {
    state.cur = id;
    state.latest = false;
    state.req = null;
    state.missing = null;
    const url = new URL(location.href);
    url.searchParams.set("rnd", id);
    url.hash = "#random";
    history.replaceState(null, "", url);
    setBadge("idle", "Not checked");
    $("verify-rows").hidden = true;
    return loadCurrent();
  }

  // ---- recent requests ----

  let paintedRows = "";

  async function loadRecent() {
    let n;
    try {
      n = Number(await chain.randomnessCount());
      state.recent = newestFirst(n ? await chain.randomnessRequests(Math.max(0, n - 15), 15) : []);
    } catch (e) {
      paintedRows = "";
      $("rows").innerHTML = `<tr><td colspan="5" class="text-faint">${esc(e.message)}</td></tr>`;
      return;
    }
    $("count").textContent = `${n.toLocaleString("en")} so far`;
    const me = wallet.accountId;
    const now = Date.now();
    const rows = state.recent.map((r) => ({ ...r, st: stage(r, now) }));
    const key = JSON.stringify([me, rows.map((r) => [r.id, r.st, r.value])]);
    if (key === paintedRows) return; // unchanged: leave a reader's selection alone
    paintedRows = key;
    $("rows").innerHTML = rows.length ? rows.map((r) => {
      const mine = r.requester === me;
      return `<tr data-me="${mine ? 1 : 0}"><th scope="row"><a href="?rnd=${r.id}#random" data-id="${r.id}">#${r.id}</a></th>` +
        `<td>${esc(r.requester)}${mine ? ` <span class="text-xs text-faint">you</span>` : ""}</td><td class="num">${r.drand_round}</td>` +
        `<td><span class="chip" data-state="${r.st}">${STAGE_TEXT[r.st]}</span></td>` +
        `<td>${r.value ? hashHTML(r.value, "value") : `<span class="text-faint">–</span>`}</td></tr>`;
    }).join("") : `<tr><td colspan="5" class="text-faint">No request yet. Be the first.</td></tr>`;
  }

  $("rows").addEventListener("click", (e) => {
    const a = e.target.closest("a[data-id]");
    if (!a) return;
    e.preventDefault();
    setCurrent(+a.dataset.id);
    $("title").scrollIntoView({ block: "nearest", behavior: "smooth" });
  });

  // ---- actions ----

  async function until(fn, ms) {
    const end = Date.now() + ms;
    while (Date.now() < end) { if (await fn()) return true; await sleep(1500); }
    return false;
  }

  // The request a `request_randomness` call made: the id it returned, read
  // back once a final block has it; else the caller's newest request after
  // `before` (a wallet that doesn't hand back the outcome).
  async function findMine(out, me, before) {
    const id = returnValueOf(out);
    let mine = null;
    await until(async () => {
      if (Number.isInteger(id)) {
        mine = await chain.randomness(id);
      } else {
        const n = Number(await chain.randomnessCount());
        if (n > before) mine = (await chain.randomnessRequests(before, n - before)).filter((r) => r.requester === me).at(-1) ?? null;
      }
      return !!mine;
    }, 30_000);
    return mine;
  }

  $("ask").addEventListener("click", async () => {
    const btn = $("ask");
    btn.disabled = true;
    try {
      if (!wallet.accountId) await wallet.connect();
      const me = wallet.accountId;
      if (!me) return;
      if (await ensureTokens(me)) {
        showNote("Claimed your free play tokens. Waiting for them to land…");
        await until(async () => (await chain.balance(me)) > 0n, 20_000);
      }
      const before = Number(await chain.randomnessCount());
      showNote(state.cfg.fee ? `Approve the request in your wallet (it burns ${tokens(state.cfg.fee)} $ANTO)…` : "Approve the request in your wallet…");
      const out = await send("request_randomness", {}, { gasTgas: 30 });
      showNote("Sent. Reading your request back…");
      refreshTokenChip();
      const mine = await findMine(out, me, before);
      if (!mine) throw new Error("The request went out but isn't on the chain yet. Check the list below in a moment.");
      showNote(`Request #${mine.id} is in. It commits to drand round ${mine.drand_round}, published ${utc(publishedAt(mine.drand_round))}.`);
      await setCurrent(mine.id);
      await loadRecent();
    } catch (e) {
      showError(e);
    } finally {
      btn.disabled = false;
    }
  });

  // The prove button lives in the result line, which repaints: listen on it.
  $("result").addEventListener("click", async (e) => {
    const btn = e.target.closest("#rnd-prove");
    const r = state.req;
    if (!btn || !r) return;
    btn.disabled = true;
    try {
      if (!wallet.accountId) await wallet.connect();
      if (!wallet.accountId) return;
      showNote(`Approve proving drand round ${r.drand_round} in your wallet…`);
      await send("fulfill_randomness", { drand_round: r.drand_round }, { gasTgas: 30 });
      showNote("Proved. Reading the value…");
      for (let i = 0; i < 6 && state.req?.status !== "ready"; i++) { await sleep(2000); await loadCurrent(); }
      await loadRecent();
    } catch (e) {
      showError(e);
    } finally {
      btn.disabled = false;
      painted.live = ""; // the result line skipped repaints while the proof was in flight
      renderRequest();
    }
  });

  $("verify").addEventListener("click", async () => {
    const r = state.req;
    if (!r || r.status !== "ready") return;
    $("verify").disabled = true;
    setBadge("pending", "Asking drand");
    try {
      const sig = await beacon(r.drand_round);
      const res = verifyRequest(r, contractId(), sig);
      $("vrows").innerHTML = res.rows.map((row) =>
        `<tr><th scope="row">${esc(row.name)}</th><td>${hashHTML(row.expected, "chain")}</td>` +
        `<td>${row.actual ? hashHTML(row.actual, "re-derived") : `<span class="text-faint">drand didn't answer</span>`} ` +
        `<span class="chip" data-state="${row.state}">${row.state === "match" ? "✓ match" : row.state === "missing" ? "○ missing" : "✗ mismatch"}</span></td></tr>`).join("");
      $("verify-rows").hidden = false;
      setBadge(res.ok ? "match" : "mismatch", res.ok ? "Matches drand" : res.rows.some((x) => x.state === "missing") ? "Couldn't reach drand" : "Does not match");
    } catch (e) {
      setBadge("mismatch", e.message);
    } finally {
      $("verify").disabled = false;
    }
  });

  $("share").addEventListener("click", async () => {
    const url = new URL(location.href);
    url.search = "";
    url.hash = "#random";
    if (state.cur != null) url.searchParams.set("rnd", state.cur);
    const names = parseChoices($("choices").value);
    if (names.length) url.searchParams.set("c", names.map((n) => n.replace(/,/g, " ")).join(","));
    try { await navigator.clipboard.writeText(url.toString()); $("share-msg").textContent = "Link copied."; }
    catch { $("share-msg").textContent = url.toString(); }
  });

  $("choices").addEventListener("input", renderRequest);
  wallet.onChange(() => { painted.facts = ""; renderRequest(); loadRecent(); });

  // ---- go ----

  (async () => {
    try {
      state.cfg = await chain.randomnessConfig();
      state.cfg.fee = BigInt(state.cfg.fee);
      $("fee-line").textContent = state.cfg.fee === 0n ? "free" : `${tokens(state.cfg.fee)} $ANTO per request, burned`;
      $("fee-chip").textContent = state.cfg.fee === 0n ? "free" : `${tokens(state.cfg.fee)} $ANTO, burned`;
    } catch (e) {
      $("fee-line").textContent = "contract has no randomness service";
      $("fee-chip").textContent = "not on this contract";
      $("ask").disabled = true;
      $("rows").innerHTML = `<tr><td colspan="5" class="text-faint">This contract has no randomness service yet.</td></tr>`;
      showError(e);
      return;
    }
    await Promise.all([loadCurrent(), loadRecent()]);
    // No ?rnd: show the newest request rather than an empty stage (the URL stays bare).
    if (state.cur == null && state.recent.length) {
      state.cur = state.recent[0].id;
      state.latest = true;
      await loadCurrent();
    }
    setInterval(() => {
      if (document.hidden) return;
      if (state.req?.status !== "ready") loadCurrent();
      loadRecent();
    }, 4000);
    setInterval(() => { if (!document.hidden) renderRequest(); }, 1000);
  })();
}
