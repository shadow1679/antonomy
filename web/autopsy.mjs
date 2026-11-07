// Ant autopsy: every trip each ant makes in one colony run, for the Replay
// page. Pure view data. It steps its own Colony from make() and only reads its
// state, so it can't change a result hash.

import { FOOD_RADIUS_SQ } from "../sim/js/antosim.mjs";

// The sim's pickup rule: first source (lowest index) within the food radius.
function sourceAt(col, cx, cy) {
  for (let s = 0; s < col.n; s++) {
    const dx = cx - col.sx[s], dy = cy - col.sy[s];
    if (dx * dx + dy * dy <= FOOD_RADIUS_SQ) return s;
  }
  return -1;
}

// lives[a] lists ant a's trips in order: { source, opt, pick, home, deposit }.
// pick is the tick it took food, home the tick it reached the nest (null if
// the run ended first), deposit the pheromone it lays on its first step home.
export function antLives(make) {
  const col = make();
  const lives = Array.from({ length: col.ants }, () => []);
  const open = new Array(col.ants).fill(null);
  while (col.step()) {
    for (let a = 0; a < col.ants; a++) {
      if (col.returning[a] && !open[a]) {
        const source = sourceAt(col, col.ax[a] >> 8, col.ay[a] >> 8);
        open[a] = { source, opt: col.perm.indexOf(source), pick: col.t, home: null, deposit: col.strength[a] };
        lives[a].push(open[a]);
      } else if (!col.returning[a] && open[a]) {
        open[a].home = col.t;
        open[a] = null;
      }
    }
  }
  return lives;
}

// Index of the trip the ant is on at tick t (carrying food), or -1 if it is
// searching. An ant is home at tick `home`, so that tick is not on the trip.
export function tripAt(trips, t) {
  return trips.findIndex((x) => x.pick <= t && (x.home === null || t < x.home));
}

// Crumbs this ant has brought home by tick t, per option.
export function deliveredBy(trips, t, nOptions) {
  const out = new Array(nOptions).fill(0);
  for (const x of trips) if (x.home !== null && x.home <= t) out[x.opt]++;
  return out;
}
