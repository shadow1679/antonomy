// drand quicknet beacons for the calls that draw a seed. The contract fixes
// each seed's drand round by time (the first one published after the inputs
// close), names it in its views (`drand_round`) and checks the signature on
// chain with NEAR's BLS12-381 host functions, so nothing fetched here is
// trusted. It is randomness, not a forecast input: the "forecast inputs from
// the chain only" rule is untouched. `wallet.call` in chain.mjs adds it.

export const CHAIN = "52db9ba70e0cc0f6eaf7803dd07447a1f5477735fd3f661792ba94600c84e971";
export const URLS = ["https://api.drand.sh", "https://api2.drand.sh", "https://api3.drand.sh", "https://drand.cloudflare.com"];

// The calls that may draw a seed, and the view that names their drand round.
export const SEED_VIEWS = {
  crank_round: () => ["round_status", {}],
  crank_burn: () => ["burn_schedule", {}],
  crank_request: (args) => ["forecast_request", { request_id: args.request_id }],
};

const cache = new Map();

// Round `round`'s hex signature, or null while no endpoint has it.
export async function beacon(round, { fetchFn = fetch, urls = URLS } = {}) {
  if (cache.has(round)) return cache.get(round);
  for (const base of urls) {
    try {
      const res = await fetchFn(`${base}/${CHAIN}/public/${round}`);
      if (!res.ok) continue;
      const b = await res.json();
      if (b.round === round && /^[0-9a-f]{96}$/.test(b.signature ?? "")) {
        cache.set(round, b.signature);
        return b.signature;
      }
    } catch { /* try the next endpoint */ }
  }
  return null;
}

// `args` for `method`, plus the committed beacon's signature when the call may
// draw a seed and the beacon is out. A call that doesn't draw ignores it; one
// that does and goes without fails on chain with "signature needed".
// `view(method, args)` reads the contract.
export async function seedArgs(method, args, view, opts) {
  if (args.drand_signature) return args;
  // Proving a round for the randomness service names its round itself.
  if (method === "fulfill_randomness") {
    const sig = await beacon(args.drand_round, opts);
    return sig ? { ...args, drand_signature: sig } : args;
  }
  const pick = SEED_VIEWS[method];
  if (!pick) return args;
  try {
    const [m, a] = pick(args);
    const round = (await view(m, a))?.drand_round;
    if (round == null) return args;
    const sig = await beacon(round, opts);
    return sig ? { ...args, drand_signature: sig } : args;
  } catch {
    return args;
  }
}
