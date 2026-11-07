// Offline tests for web/drand.mjs. Run: node web/test_drand.mjs
import assert from "node:assert/strict";
import { beacon, seedArgs, CHAIN } from "./drand.mjs";

const SIG = "ab".repeat(48);
const reply = (body, ok = true) => ({ ok, json: async () => body });

// The first endpoint down, the second has it: fetched from the second, once.
{
  const urls = [];
  const fetchFn = async (u) => {
    urls.push(u);
    if (u.startsWith("https://a")) throw new Error("down");
    return reply({ round: 7, signature: SIG });
  };
  const opts = { fetchFn, urls: ["https://a", "https://b"] };
  assert.equal(await beacon(7, opts), SIG);
  assert.deepEqual(urls, ["https://a/" + CHAIN + "/public/7", "https://b/" + CHAIN + "/public/7"]);
  assert.equal(await beacon(7, opts), SIG);
  assert.equal(urls.length, 2, "kept after the first fetch");
}
// Not published yet (404), a reply for another round, or a malformed signature: null.
{
  assert.equal(await beacon(8, { fetchFn: async () => reply({}, false), urls: ["https://x"] }), null);
  assert.equal(await beacon(9, { fetchFn: async () => reply({ round: 10, signature: SIG }), urls: ["https://x"] }), null);
  assert.equal(await beacon(11, { fetchFn: async () => reply({ round: 11, signature: "zz" }), urls: ["https://x"] }), null);
}
// Seed-drawing calls read their round from the right view and carry the signature.
{
  const opts = { fetchFn: async (u) => reply({ round: Number(u.split("/").pop()), signature: SIG }), urls: ["https://x"] };
  const reads = [];
  const view = async (m, a) => { reads.push([m, a]); return { drand_round: 21 }; };
  assert.deepEqual(await seedArgs("crank_round", {}, view, opts), { drand_signature: SIG });
  assert.deepEqual(await seedArgs("crank_burn", {}, view, opts), { drand_signature: SIG });
  assert.deepEqual(await seedArgs("crank_request", { request_id: 3 }, view, opts), { request_id: 3, drand_signature: SIG });
  assert.deepEqual(reads, [["round_status", {}], ["burn_schedule", {}], ["forecast_request", { request_id: 3 }]]);
  // Other calls go out as given, with no reads.
  assert.deepEqual(await seedArgs("stake", { colony: 0 }, view, opts), { colony: 0 });
  assert.equal(reads.length, 3);
}
// Proving a round for the randomness service takes its round from the call, with no view read.
{
  const opts = { fetchFn: async (u) => reply({ round: Number(u.split("/").pop()), signature: SIG }), urls: ["https://x"] };
  const view = async () => { throw new Error("no read expected"); };
  assert.deepEqual(await seedArgs("fulfill_randomness", { drand_round: 33 }, view, opts), { drand_round: 33, drand_signature: SIG });
  // A signature already given is kept; a beacon not out yet leaves the call as given.
  assert.deepEqual(await seedArgs("fulfill_randomness", { drand_round: 33, drand_signature: "cd" }, view, opts), { drand_round: 33, drand_signature: "cd" });
  const none = { fetchFn: async () => reply({}, false), urls: ["https://x"] };
  assert.deepEqual(await seedArgs("fulfill_randomness", { drand_round: 34 }, view, none), { drand_round: 34 });
}
// A contract without drand_round, a failed read or a missing beacon: the call goes as given.
{
  const none = { fetchFn: async () => reply({}, false), urls: ["https://x"] };
  assert.deepEqual(await seedArgs("crank_round", {}, async () => ({ phase: "ready" }), none), {});
  assert.deepEqual(await seedArgs("crank_round", {}, async () => { throw new Error("rpc"); }, none), {});
  assert.deepEqual(await seedArgs("crank_round", {}, async () => ({ drand_round: 99 }), none), {});
}
console.log("drand ok");
