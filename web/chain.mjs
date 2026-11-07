// The product's chain layer: contract reads over NEAR JSON-RPC and the wallet.
// Pages read forecast inputs, rounds, burn days and requests from the contract
// only (design doc: web pages never read forecast data from outside APIs; the
// Recruit page's market search is the one exception). Dependency-free for
// reads, so Node tests can import it; the wallet module loads on demand.
//
// Which contract: `?contract=<account>` in the page URL, else CONTRACT below.
// Network is testnet only: this is a play token, no mainnet.

import { seedArgs } from "./drand.mjs";

export const CONTRACT = "antonomy-oracle.testnet";
export const NETWORK = "testnet";
// drpc first: the fastnear and near.org endpoints share one per-IP rate limit
// and answer a page's burst of reads with 429s (measured 2026-10-28: 12
// parallel reads, all 429 there, all answered in 0.5 s on drpc). They stay as
// fallbacks.
export const RPCS = ["https://near-testnet.drpc.org/", "https://test.rpc.fastnear.com", "https://rpc.testnet.near.org", "https://archival-rpc.testnet.near.org"];
export const WALLET_MODULE = "https://esm.sh/@hot-labs/near-connect@0.11.4";
export const ONE = 10n ** 24n; // yocto per token
export const TGAS = 10n ** 12n;

export function contractId() {
  try {
    const q = new URLSearchParams(globalThis.location?.search ?? "").get("contract");
    if (q && /^[a-z0-9._-]{2,64}$/.test(q)) return q;
  } catch { /* not in a browser */ }
  return CONTRACT;
}

const b64 = (s) => (typeof btoa === "function" ? btoa(s) : Buffer.from(s).toString("base64"));

// One view call. The public RPCs rate-limit by IP (a 429 carries no CORS
// header, so the browser reports it as "Failed to fetch"), and a page makes a
// dozen reads, so reads are shared and paced:
//  - an identical read in flight, or answered in the last CACHE_MS, is reused;
//  - at most MAX_PARALLEL reads run at once;
//  - a failed read retries across the endpoints with growing pauses.
// Pass `fresh: true` to skip the cache (after a write, `chain.invalidate()`).
// A custom `fetchFn` (tests) bypasses all of it. Returns the parsed JSON the
// contract method returned.
export const CACHE_MS = 4000;
export const MAX_PARALLEL = 4;
const RETRY_PAUSES_MS = [400, 1200, 3000];
const cache = new Map(); // key -> { at, promise }
let running = 0;
const waiting = [];

export const invalidate = () => cache.clear();

async function slot() {
  if (running >= MAX_PARALLEL) await new Promise((r) => waiting.push(r));
  running++;
}
function release() {
  running--;
  waiting.shift()?.();
}

async function viewOnce(body, rpcs, fetchFn, method) {
  let last;
  for (const rpc of rpcs) {
    try {
      const r = await fetchFn(rpc, { method: "POST", headers: { "content-type": "application/json" }, body });
      const out = await r.json();
      const res = out.result;
      if (out.error || !res || res.error || !res.result) throw new Error(`${method}: ${JSON.stringify(out.error || res?.error || out)}`);
      return JSON.parse(new TextDecoder().decode(Uint8Array.from(res.result)));
    } catch (e) {
      last = e;
    }
  }
  throw last;
}

export async function view(method, args = {}, { contract = contractId(), rpcs = RPCS, fetchFn, fresh = false } = {}) {
  const body = JSON.stringify({
    jsonrpc: "2.0", id: "anto", method: "query",
    params: {
      request_type: "call_function", finality: "final", account_id: contract,
      method_name: method, args_base64: b64(JSON.stringify(args)),
    },
  });
  if (fetchFn) return viewOnce(body, rpcs, fetchFn, method);
  const key = `${contract}|${method}|${JSON.stringify(args)}`;
  const hit = cache.get(key);
  if (!fresh && hit && Date.now() - hit.at < CACHE_MS) return hit.promise;
  const promise = (async () => {
    await slot();
    try {
      let last;
      for (let attempt = 0; attempt <= RETRY_PAUSES_MS.length; attempt++) {
        try {
          return await viewOnce(body, rpcs, globalThis.fetch, method);
        } catch (e) {
          last = e;
          if (attempt < RETRY_PAUSES_MS.length) await new Promise((r) => setTimeout(r, RETRY_PAUSES_MS[attempt]));
        }
      }
      throw last;
    } finally {
      release();
    }
  })();
  cache.set(key, { at: Date.now(), promise });
  // A failed read must not be served again from the cache.
  promise.catch(() => { if (cache.get(key)?.promise === promise) cache.delete(key); });
  return promise;
}

// Yocto string -> whole tokens (a number, for display).
export const tokens = (yocto) => Number(BigInt(yocto) / (ONE / 1000n)) / 1000;
// Whole tokens -> yocto string.
export const yocto = (t) => (BigInt(Math.round(Number(t) * 1000)) * (ONE / 1000n)).toString();

export const hexToBytes = (h) => Uint8Array.from(h.match(/../g).map((x) => parseInt(x, 16)));
export const ZERO_HASH = "0".repeat(64);

// ---- typed readers: one place that knows the contract's view names ----

export const chain = {
  roundStatus: () => view("round_status"),
  lastRound: () => view("last_round"),
  burnSchedule: () => view("burn_schedule"),
  burnRun: () => view("burn_run"),
  lastBurnDay: () => view("last_burn_day"),
  burnSnapshot: (day) => view("burn_snapshot", { day }),
  stakeTotals: (colony, n) => view("stake_totals", { colony, n_options: n }),
  stakesOf: (account_id) => view("stakes_of", { account_id }),
  stakeConfig: () => view("stake_config"),
  balance: async (account_id) => BigInt(await view("ft_balance_of", { account_id })),
  totalSupply: async () => BigInt(await view("ft_total_supply")),
  hasClaimed: (account_id) => view("has_claimed", { account_id }),
  faucetAmount: () => view("faucet_amount"),
  rewardPool: () => view("reward_pool"),
  rewardsEarned: (account_id) => view("rewards_earned", { account_id }),
  leaderboard: () => view("reward_leaderboard"),
  isAgent: (account_id) => view("is_agent", { account_id }),
  agentSnapshot: (colony) => view("agent_snapshot", { colony }),
  requestConfig: () => view("request_config"),
  requestCount: () => view("forecast_request_count"),
  request: (request_id) => view("forecast_request", { request_id }),
  requests: (from_id, limit = 50) => view("forecast_requests", { from_id, limit }),
  keepers: () => view("keepers"),
  keeperPost: (account_id) => view("keeper_post", { account_id }),
  agents: () => view("agents"),
  paused: () => view("is_paused"),
};

// ---- wallet ----
// Wraps @hot-labs/near-connect (loaded from a pinned esm.sh build on first
// use). Every write goes through call(); a wallet asks the user to approve it.

let connector = null;
let listeners = [];
const state = { accountId: null };

async function load() {
  if (connector) return connector;
  const { NearConnector } = await import(WALLET_MODULE);
  connector = new NearConnector({ network: NETWORK });
  connector.on("wallet:signIn", (t) => {
    state.accountId = t.accounts?.[0]?.accountId ?? null;
    listeners.forEach((f) => f(state.accountId));
  });
  connector.on("wallet:signOut", () => {
    state.accountId = null;
    listeners.forEach((f) => f(null));
  });
  return connector;
}

export const wallet = {
  get accountId() { return state.accountId; },
  onChange(f) { listeners.push(f); return () => { listeners = listeners.filter((x) => x !== f); }; },
  // Restore a previous session without a popup; resolves to the account or null.
  async restore() {
    try {
      const c = await load();
      const { accounts } = await c.getConnectedWallet();
      state.accountId = accounts?.[0]?.accountId ?? null;
    } catch { state.accountId = null; }
    listeners.forEach((f) => f(state.accountId));
    return state.accountId;
  },
  async connect() {
    const c = await load();
    await c.connect();
    return state.accountId;
  },
  async disconnect() {
    const c = await load();
    await c.disconnect();
  },
  // Send one function call to the contract. `deposit` in yocto (default 0),
  // `gasTgas` defaults to 100. Resolves to the wallet's outcome. A crank that
  // may draw a seed gets the committed drand beacon added (drand.mjs).
  async call(method, args = {}, { deposit = "0", gasTgas = 100 } = {}) {
    if (!state.accountId) throw new Error("Connect a wallet first.");
    args = await seedArgs(method, args, (m, a) => view(m, a, { fresh: true }));
    const c = await load();
    const w = await c.wallet();
    try {
      return await w.signAndSendTransaction({
        receiverId: contractId(),
        actions: [{ type: "FunctionCall", params: { methodName: method, args, gas: (BigInt(gasTgas) * TGAS).toString(), deposit } }],
      });
    } finally {
      invalidate(); // the next read must see this write
    }
  },
};

// A wallet that has never claimed gets play tokens first; stake, request and
// register all need a balance.
export async function ensureTokens(account) {
  if (await chain.hasClaimed(account)) return false;
  await wallet.call("claim_play_tokens");
  return true;
}
