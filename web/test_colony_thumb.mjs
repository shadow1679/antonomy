// Offline tests for the idle scouts drawn before the seed (colony-thumb.mjs).
import assert from "node:assert/strict";
import { W, H, NEST_X, NEST_Y } from "../sim/js/antosim.mjs";
import { idleScout, SCOUTS } from "./ds/colony-thumb.mjs";

// Every scout of every colony stays on the plot, with a cell to spare.
for (let kind = 0; kind < 3; kind++)
  for (let i = 0; i < SCOUTS; i++)
    for (let t = 0; t < 120; t += 0.05) {
      const [dx, dy] = idleScout(kind, i, t);
      const x = NEST_X + 0.5 + dx, y = NEST_Y + 0.5 + dy;
      assert.ok(x >= 1 && x <= W - 1 && y >= 1 && y <= H - 1, `kind ${kind} scout ${i} at t=${t}: ${x},${y}`);
    }

// A pure function of the clock: same inputs, same place.
assert.deepEqual(idleScout(2, 3, 7.25), idleScout(2, 3, 7.25));

// The three colonies idle differently.
const at = (kind) => JSON.stringify(Array.from({ length: SCOUTS }, (_, i) => idleScout(kind, i, 5)));
assert.equal(new Set([0, 1, 2].map(at)).size, 3);

// Scouts move.
assert.notDeepEqual(idleScout(0, 0, 1), idleScout(0, 0, 1.5));

console.log("colony thumb idle scouts: ok");
