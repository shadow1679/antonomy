// An agent's forecast from the browser, hidden then shown
// (docs/FORECAST_QUALITY.md §3). While the colony's agents' window is in its
// commit phase, the first press commits a hash of the odds and a fresh salt,
// and keeps both in this browser's localStorage; once the window reaches its
// last third, the next press reveals them. Only revealed odds count, and a
// reveal needs the same browser (the salt never leaves it).

import { commitHash } from "./agents.mjs";
import { chain, contractId } from "./chain.mjs";

const hex = (b) => [...b].map((x) => x.toString(16).padStart(2, "0")).join("");
const keyOf = (colony, account, byMs) => `anto-commit:${contractId()}:${colony}:${account}:${byMs}`;

function saved(colony, account, byMs) {
  try { return JSON.parse(localStorage.getItem(keyOf(colony, account, byMs)) ?? "null"); } catch { return null; }
}

// Commit or reveal, whichever the window allows now. `send(method, args)`
// signs through the wallet. Returns { step: "committed", revealFromMs, byMs }
// or { step: "revealed", odds }.
export async function sendForecast({ colony, odds, account, send }) {
  const w = await chain.agentWindow(colony);
  if (!w) throw new Error("The agents' window on this market is closed.");
  if (w.phase === "commit") {
    const salt = crypto.getRandomValues(new Uint8Array(32));
    localStorage.setItem(keyOf(colony, account, w.by_ms), JSON.stringify({ odds, salt: hex(salt) }));
    await send("commit_forecast", { colony, hash: commitHash(colony, odds, salt, account) });
    return { step: "committed", revealFromMs: w.reveal_from_ms, byMs: w.by_ms };
  }
  const mine = saved(colony, account, w.by_ms);
  if (!mine || !w.committed.includes(account)) {
    throw new Error("Reveals are open, and this browser holds no commit of yours for this market: too late to forecast here.");
  }
  await send("reveal_forecast", { colony, odds: mine.odds, salt: mine.salt });
  localStorage.removeItem(keyOf(colony, account, w.by_ms));
  return { step: "revealed", odds: mine.odds };
}

const clock = (ms) => new Date(ms).toISOString().slice(11, 19) + " UTC";

// One line for the page after `sendForecast`.
export function forecastNote(out) {
  return out.step === "committed"
    ? `Committed: your odds stay hidden. Press again between ${clock(out.revealFromMs)} and ${clock(out.byMs)} to reveal them; only revealed odds count.`
    : "Revealed: your odds are in the Agents colony's median.";
}
