// The nest page's loader: every read its chambers need, from the contract
// (through chain.mjs: cached, paced, retried) and, for the log and the last
// burn, the nearblocks indexer. A read that fails leaves its field null, so
// one slow endpoint never blanks the whole nest. The shape is what
// deriveNest() and diffEvents() in nest.mjs take.

import { view, contractId, wallet } from "./chain.mjs";
import { loadToken } from "./token.mjs";
import { loadRound } from "./roundchain.mjs";
import { INDEXER, withTimeout, indexerBurns, indexerCrankPayouts, burnRow } from "./burnchain.mjs";

const soft = (p) => Promise.resolve(p).then((x) => x, () => null);
// The ledger accounts the contract holds others' $ANTO in (token/src:
// stake.rs VAULT, request.rs REQUEST_ESCROW, agents.rs AGENT_VAULT).
export const VAULTS = { stakes: "stake-vault.antonomy", fees: "request-escrow.antonomy", deposits: "agent-vault.antonomy" };
const REQUESTS = 50;            // the newest requests the guard and nursery count
const POSTS_MS = 5 * 60_000;    // agents' posts on the round's markets, re-read this often

let posts = { round: null, at: 0, n: null };

// Agents' posts on this round's markets: one agent_snapshot per market, so
// read once per round and every POSTS_MS after.
async function roundPosts(round, read) {
  if (!round?.markets?.length || round.proposed) return null;
  if (posts.round === round.id && Date.now() - posts.at < POSTS_MS) return posts.n;
  const snaps = await Promise.all(round.markets.map((m) => soft(read("agent_snapshot", { colony: m.colony }))));
  const n = snaps.reduce((k, s) => k + (s?.posts?.length ?? 0), 0);
  posts = { round: round.id, at: Date.now(), n };
  return n;
}

export async function loadNest({ read = view, account = wallet.accountId, contract = contractId() } = {}) {
  const count = soft(read("forecast_request_count"));
  const rcount = soft(read("randomness_count"));
  const [token, vaults, round, rcfg, stakeCfg, keepers, agents, paused, pot, schedule] = await Promise.all([
    soft(loadToken({ read, account, contract })),
    soft(Promise.all(Object.values(VAULTS).map((account_id) => read("ft_balance_of", { account_id }).then(BigInt)))
      .then(([stakes, fees, deposits]) => ({ stakes, fees, deposits }))),
    soft(loadRound({ call: read })),
    soft(read("request_config")),
    soft(read("stake_config")),
    soft(read("keepers")),
    soft(read("agents")),
    soft(read("is_paused")),
    soft(read("daily_pot")),
    soft(read("burn_schedule")),
  ]);
  const n = await count, rn = await rcount;
  const [requests, latest, agentPosts] = await Promise.all([
    n == null ? null : n === 0 ? [] : soft(read("forecast_requests", { from_id: Math.max(0, n - REQUESTS), limit: REQUESTS })),
    rn ? soft(read("randomness_request", { id: rn - 1 })) : null,
    soft(roundPosts(round, read)),
  ]);
  const escrow = vaults ? vaults.stakes + vaults.fees + vaults.deposits : null;
  return {
    token, escrow, vaults, round, rcfg, stakeCfg, keepers, agents, paused, pot, schedule,
    requests, requestCount: n, agentPosts,
    randomness: rn == null ? null : { count: rn, latest },
  };
}

// The newest paid burn: the indexer's execute_burn list plus days the next
// day's first crank paid, newest first; the first that ran is read from the
// archive (burnRow caches it). null if the indexer can't be reached.
export async function loadLastBurn() {
  let list;
  try { list = await indexerBurns({ limit: 3 }); } catch { return null; }
  let cranks = [];
  try { cranks = await indexerCrankPayouts({ limit: 60 }); } catch { /* execute_burn rows alone */ }
  const paid = new Set(list.map((x) => x.day));
  list = [...list, ...cranks.filter((x) => !paid.has(x.day))].sort((a, b) => b.day - a.day);
  for (const x of list.slice(0, 4)) {
    const row = await soft(burnRow(x));
    if (row && !row.skipped) return row;
  }
  return null;
}

// The newest contract calls, for the nest log. Throws if the indexer is
// unreachable (the page then logs only what it sees change).
// The indexer's transaction list for an account can come back empty while
// its receipt list has the calls, so an empty list falls back to receipts.
export async function loadLog({ fetchFn = globalThis.fetch, limit = 25, contract = contractId() } = {}) {
  const get = async (what) => {
    const r = await withTimeout(fetchFn(`${INDEXER}/account/${contract}/${what}?per_page=${limit}&order=desc`), 12000);
    if (!r.ok) throw new Error(`indexer ${r.status}`);
    const out = await r.json();
    const list = out.txns ?? out.receipts;
    if (!Array.isArray(list)) throw new Error(out.message ?? "indexer gave no list");
    return list.filter((t) => t.receiver_account_id === contract);
  };
  const txns = await get("txns");
  return txns.length ? txns : get("receipts");
}
