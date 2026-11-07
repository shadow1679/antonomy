// Forecaster agents' odds as the Agents colony reads them: a JS port of the
// contract's agent-odds snapshot (token/src/agents.rs). Each post is { id, odds }
// with n basis-point values summing to exactly 10000. The colony reads the
// skill-weighted lower median per outcome; the result hash commits the
// snapshot hash. Pure data, no DOM.
//
// Hash = sha256("ANTO-AGENTS-v0" || n u8 || count u16 BE || for each post,
// sorted by account: len u8 || account bytes || n x u16 BE || then each post's
// weight u16 BE, only when the weights are not all equal). With no posts the
// median is all zeros (an even map) and the hash is 32 zero bytes. With equal
// weights (every agent without a scored record) it is the plain lower median.
//
// Agents post in two steps (docs/FORECAST_QUALITY.md §3): commitHash() while
// the window hides posts, then the odds and salt in its last third.

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

// Weighted lower median: the values sorted, then the first one where the
// weight so far, doubled, reaches the total. Equal weights: the lower median.
export function weightedMedian(values, weights) {
  const vw = values.map((v, i) => [v, weights[i]]).sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const total = vw.reduce((a, [, w]) => a + w, 0);
  let seen = 0;
  for (const [v, w] of vw) {
    seen += w;
    if (2 * seen >= total) return v;
  }
  return vw[vw.length - 1][0];
}

const allEqual = (ws) => ws.every((w) => w === ws[0]);

// sha256("ANTO-COMMIT-v0" || colony u16 BE || n u8 || odds u16 BE each ||
// salt (32 bytes) || account bytes), as hex: what commit_forecast takes.
export function commitHash(colony, odds, salt, who) {
  if (!(salt instanceof Uint8Array) || salt.length !== 32) throw new RangeError("salt: 32 bytes");
  const parts = [...enc.encode("ANTO-COMMIT-v0"), colony >> 8, colony & 255, odds.length];
  for (const o of odds) parts.push(o >> 8, o & 255);
  parts.push(...salt, ...enc.encode(who));
  return [...sha256(Uint8Array.from(parts))].map((b) => b.toString(16).padStart(2, "0")).join("");
}

// { odds: median per outcome, hash: Uint8Array(32), agents: sorted account ids }.
// `weights`: each post's weight, in the sorted (account) order, as the chain
// lists them (AgentSnapshotView.weights); omitted or null means all equal.
export function agentSnapshot(posts, n, weights = null) {
  const sorted = [...posts].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  if (!sorted.length) return { odds: new Array(n).fill(0), hash: new Uint8Array(32), agents: [] };
  const ws = weights ?? sorted.map(() => 1000);
  if (ws.length !== sorted.length || !ws.every((w) => Number.isInteger(w) && w >= 0 && w <= 0xffff)) {
    throw new RangeError("one weight (0 to 65535) per post");
  }
  const parts = [...TAG, n, sorted.length >> 8, sorted.length & 255];
  for (const { id, odds } of sorted) {
    checkPost(odds, n);
    const b = enc.encode(id);
    if (b.length > 255) throw new RangeError("account id too long");
    parts.push(b.length, ...b);
    for (const o of odds) parts.push(o >> 8, o & 255);
  }
  const equal = allEqual(ws);
  if (!equal) for (const w of ws) parts.push(w >> 8, w & 255);
  return {
    odds: Array.from({ length: n }, (_, o) => (equal ? lowerMedian : (vs) => weightedMedian(vs, ws))(sorted.map((p) => p.odds[o]))),
    hash: sha256(Uint8Array.from(parts)),
    agents: sorted.map((p) => p.id),
  };
}
