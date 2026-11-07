// Forecaster agents' odds as the Agents colony reads them: a JS port of the
// contract's agent-odds snapshot. Each post is { id, odds } with n basis-point
// values summing to exactly 10000. The colony reads the lower median per
// outcome; the result hash commits the snapshot hash. Pure data, no DOM.
//
// Hash = sha256("ANTO-AGENTS-v0" || n u8 || count u16 BE || for each post,
// sorted by account: len u8 || account bytes || n x u16 BE). With no posts
// the median is all zeros (an even map) and the hash is 32 zero bytes.

import { sha256 } from "../sim/js/antosim.mjs";

const enc = new TextEncoder();
const TAG = enc.encode("ANTO-AGENTS-v0");
const BPS = 10_000;

// Lower median: always one of the values.
export const lowerMedian = (xs) => {
  const s = [...xs].sort((a, b) => a - b);
  return s[(s.length - 1) >> 1];
};

// Throws a RangeError unless `odds` is a valid post for an n-outcome market.
export function checkPost(odds, n) {
  if (!Array.isArray(odds) || odds.length !== n) throw new RangeError(`need ${n} odds`);
  if (!odds.every((o) => Number.isInteger(o) && o >= 0 && o <= BPS)) throw new RangeError("odds must be 0 to 10000 bp");
  if (odds.reduce((a, b) => a + b, 0) !== BPS) throw new RangeError("odds must sum to 10000 bp");
}

// { odds: median per outcome, hash: Uint8Array(32), agents: sorted account ids }.
export function agentSnapshot(posts, n) {
  const sorted = [...posts].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  if (!sorted.length) return { odds: new Array(n).fill(0), hash: new Uint8Array(32), agents: [] };
  const parts = [...TAG, n, sorted.length >> 8, sorted.length & 255];
  for (const { id, odds } of sorted) {
    checkPost(odds, n);
    const b = enc.encode(id);
    if (b.length > 255) throw new RangeError("account id too long");
    parts.push(b.length, ...b);
    for (const o of odds) parts.push(o >> 8, o & 255);
  }
  return {
    odds: Array.from({ length: n }, (_, o) => lowerMedian(sorted.map((p) => p.odds[o]))),
    hash: sha256(Uint8Array.from(parts)),
    agents: sorted.map((p) => p.id),
  };
}
