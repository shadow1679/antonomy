// Ant autopsy: every trip each ant makes in one colony run, for the Replay
// page and the follow cards on the Live, Burn and Recruit pages. Pure view
// data. It only reads Colony state, so it can't change a result hash.

import { FOOD_RADIUS_SQ } from "../sim/js/antosim.mjs";

// The sim's pickup rule: first source (lowest index) within the food radius.
function sourceAt(col, cx, cy) {
  for (let s = 0; s < col.n; s++) {
    const dx = cx - col.sx[s], dy = cy - col.sy[s];
    if (dx * dx + dy * dy <= FOOD_RADIUS_SQ) return s;
  }
  return -1;
}

// Logs trips as a colony runs. Make it on a colony at tick 0 and call
// observe(col) after every col.step(). lives[a] lists ant a's trips in order:
// { source, opt, pick, home, deposit }. pick is the tick it took food, home
// the tick it reached the nest (null while it is still out), deposit the
// pheromone it lays on its first step home.
export class TripTracker {
  constructor(col) {
    this.lives = Array.from({ length: col.ants }, () => []);
    this.open = new Array(col.ants).fill(null);
  }

  observe(col) {
    const { lives, open } = this;
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
}

// Every ant's trips over a whole run of make().
export function antLives(make) {
  const col = make();
  const tracker = new TripTracker(col);
  while (col.step()) tracker.observe(col);
  return tracker.lives;
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

// A few ants worth following, so nobody has to guess an ant number:
// the busiest forager, the first ant home, the most loyal one (every crumb
// from one pile, at least LOYAL trips) and a wanderer that never found food
// (or, if every ant did, the one that found it last). Ties go to the lowest
// ant index. Entries are { key, ant, trips, opt? }; a kind with no ant is left out.
const LOYAL = 3;
export function notableAnts(lives) {
  const home = (l) => l.filter((x) => x.home !== null);
  const best = (score) => {
    let ant = -1, top = -Infinity;
    lives.forEach((l, a) => { const s = score(l); if (s !== null && s > top) { top = s; ant = a; } });
    return ant;
  };
  const out = [];
  const add = (key, ant, extra = {}) => { if (ant >= 0) out.push({ key, ant, trips: home(lives[ant]).length, ...extra }); };
  add("busiest", best((l) => (home(l).length ? home(l).length : null)));
  add("first", best((l) => (home(l).length ? -home(l)[0].home : null)));
  const loyal = best((l) => {
    const h = home(l);
    return h.length >= LOYAL && h.every((x) => x.opt === h[0].opt) ? h.length : null;
  });
  add("loyal", loyal, loyal >= 0 ? { opt: home(lives[loyal])[0].opt } : {});
  const lost = lives.findIndex((l) => l.length === 0);
  if (lost >= 0) add("wanderer", lost);
  else add("late", best((l) => l[0].pick));
  return out;
}
