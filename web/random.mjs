// Randomness as a service: pure helpers for web/random.html and the tests.
//
// A request commits to a drand round (`drand_round`); once someone proved that
// round on chain, the request has its own value:
//   value = sha256("ANTO-RAND-v1", randomness, id u64, requester, contract)
// with a u16 length before each account, all big-endian (token/src/random.rs).
// `randomness` is drand's randomness for the round, sha256 of its signature.
// The page re-derives both from drand's own signature and compares with the
// chain, and turns a value into a draw among a list of names.

import { sha256, toHex } from "../sim/js/antosim.mjs";

export const TAG = "ANTO-RAND-v1";
export const GENESIS_MS = 1_692_803_367_000; // quicknet round 1
export const PERIOD_MS = 3_000;
export const MAX_CHOICES = 100;

const enc = new TextEncoder();
const HEX64 = /^[0-9a-f]{64}$/;

export const hexBytes = (h) => Uint8Array.from(h.match(/../g) ?? [], (x) => parseInt(x, 16));

function account(a) {
  const b = enc.encode(a);
  return [Uint8Array.of(b.length >> 8, b.length & 255), b];
}

// The request's value as hex, from drand's randomness (hex).
export function randomValue(randomness, id, requester, contract) {
  if (!HEX64.test(randomness)) throw new RangeError("randomness must be 64 hex characters");
  const idBytes = new Uint8Array(8);
  new DataView(idBytes.buffer).setBigUint64(0, BigInt(id));
  const parts = [enc.encode(TAG), hexBytes(randomness), idBytes, ...account(requester), ...account(contract)];
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) { out.set(p, at); at += p.length; }
  return toHex(sha256(out));
}

// drand's randomness for a round: sha256 of its signature (hex).
export const randomnessOf = (signature) => toHex(sha256(hexBytes(signature)));

// A value as an index below n: the hash as a big-endian integer, mod n.
export function pickIndex(value, n) {
  if (!HEX64.test(value)) throw new RangeError("value must be 64 hex characters");
  if (!Number.isInteger(n) || n < 1) throw new RangeError("n must be a positive integer");
  return Number(BigInt("0x" + value) % BigInt(n));
}

// When quicknet publishes `round`, in epoch milliseconds.
export const publishedAt = (round) => GENESIS_MS + (round - 1) * PERIOD_MS;

// One name per line or comma, trimmed, empty and repeated entries dropped.
// Order is kept: the draw depends on it, so the same list gives the same pick.
export function parseChoices(text) {
  const seen = new Set();
  const out = [];
  for (const raw of String(text).split(/[\n,]/)) {
    const c = raw.trim().slice(0, 40);
    if (c && !seen.has(c)) { seen.add(c); out.push(c); }
  }
  return out.slice(0, MAX_CHOICES);
}

// Where a request stands, from the chain's RandomnessView and the clock.
// "waiting": its drand round is not out yet. "unproven": the round is out but
// nobody has proved it on chain. "ready": the chain holds the value.
export function stage(req, now) {
  if (req.status === "ready") return "ready";
  return now >= publishedAt(req.drand_round) ? "unproven" : "waiting";
}

// Whole seconds until the request's drand round is out (0 once it is).
export const secondsLeft = (req, now) => Math.max(0, Math.ceil((publishedAt(req.drand_round) - now) / 1000));

// The request's three steps for the page's strip, each "done", "now" or
// "todo": asked on chain, the drand round published, the round proven.
export function steps(req, now) {
  const at = ["waiting", "unproven", "ready"].indexOf(stage(req, now)) + 1;
  const state = (i) => (req.status === "ready" || i < at ? "done" : i === at ? "now" : "todo");
  return [
    { label: "Requested", state: "done" },
    { label: `drand publishes round ${req.drand_round}`, state: state(1) },
    { label: "Proven on chain", state: state(2) },
  ];
}

// What a function call returned, from the wallet's outcome: the JSON in its
// SuccessValue (base64), or null when there is none. `request_randomness`
// returns the new request's id this way.
export function returnValueOf(outcome) {
  const v = outcome?.status?.SuccessValue;
  if (typeof v !== "string" || !v) return null;
  try {
    return JSON.parse(new TextDecoder().decode(Uint8Array.from(atob(v), (c) => c.charCodeAt(0))));
  } catch {
    return null;
  }
}

// Check a request against drand's own signature for its round. `signature` is
// the hex BLS signature fetched from drand (null when it could not be
// fetched). Rows are { name, state, expected, actual } with state "match",
// "mismatch" or "missing", the shape the other pages' verify tables use.
export function verifyRequest(req, contract, signature) {
  const rows = [];
  if (req.status !== "ready") return { ok: false, rows };
  const row = (name, expected, actual) => ({
    name,
    expected,
    actual,
    state: actual == null ? "missing" : actual === expected ? "match" : "mismatch",
  });
  const fromDrand = signature ? randomnessOf(signature) : null;
  rows.push(row("drand randomness for round " + req.drand_round, req.randomness, fromDrand));
  rows.push(row("request value", req.value, randomValue(req.randomness, req.id, req.requester, contract)));
  return { ok: rows.every((r) => r.state === "match"), rows };
}

// What a consumer contract writes to use the service (shown on the page).
export function consumerSnippet(oracle) {
  return `#[ext_contract(ext_oracle)]
trait Oracle {
    fn request_randomness(&mut self) -> u64;
    fn randomness_value(&self, id: u64) -> Option<String>;
}

// Needs $ANTO: the fee is burned from this contract's balance.
ext_oracle::ext("${oracle}".parse().unwrap())
    .with_static_gas(Gas::from_tgas(10))
    .request_randomness()   // keep the id it returns
    .then(Self::ext(env::current_account_id()).on_requested());

// Later, once someone proved the round (seconds, not a round):
ext_oracle::ext("${oracle}".parse().unwrap())
    .with_static_gas(Gas::from_tgas(5))
    .randomness_value(id)   // null until ready, then the 64-hex value
    .then(Self::ext(env::current_account_id()).on_value());`;
}

export const newestFirst = (reqs) => [...reqs].sort((a, b) => b.id - a.id);
