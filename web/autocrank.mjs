// Auto-crank: while the box is ticked and a wallet is connected, a page sends
// the next due permissionless call itself, one at a time, instead of waiting
// for a click. The keeper daemon makes the same calls; this is for a visitor
// who wants the round to move while their tab is open. Each call is still a
// wallet transaction, so a wallet that asks for approval asks every time; it
// stops at the first refusal, or after three failures in a row (a race with
// the daemon is not a failure: the call just isn't due any more). It is off
// on every page load: nothing asks a wallet to sign until the box is ticked.

const MAX_RUN = 80;   // a 12-market round is 60 cranks
const REFUSED = /reject|cancel|denied|declin|closed|user/i;

export const isRefusal = (e) => REFUSED.test(String(e?.message ?? e));

// `next()` -> { method, args, gasTgas, label } | null  (what is due now)
// `send(step)` signs and sends it; `refresh()` re-reads the chain;
// `say(text)` shows progress; `wait(ms)` lets the chain catch up.
export function createAutoCrank({ next, send, refresh, say = () => {}, wait, maxFailures = 3 }) {
  let on = false, busy = false, failures = 0;
  const api = {
    get on() { return on; },
    async set(v) {
      on = !!v;
      failures = 0;
      if (on) await api.poll();
      else say("Auto-crank off.");
    },
    // Send what is due, one call at a time, until nothing is: the page calls
    // this after every refresh. A second call while one runs does nothing.
    async poll() {
      if (!on || busy) return null;
      busy = true;
      let last = null;
      try {
        for (let i = 0; i < MAX_RUN && on; i++) {
          const step = next();
          if (!step) break;
          say(`Auto-crank: ${step.label ?? step.method}…`);
          await send(step);
          failures = 0;
          last = step;
          await wait(2500);
          await refresh();
        }
      } catch (e) {
        failures += 1;
        if (isRefusal(e) || failures >= maxFailures) {
          on = false;
          say(isRefusal(e) ? "Auto-crank stopped: the wallet refused." : `Auto-crank stopped: ${String(e?.message ?? e).slice(0, 120)}`);
        }
      } finally {
        busy = false;
      }
      return last;
    },
  };
  return api;
}
