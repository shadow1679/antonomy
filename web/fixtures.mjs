// Test-only fixtures: NOT used by any page. The pages read rounds from the
// contract (roundchain.mjs). These canned markets exist so offline tests can
// exercise the colony views and the staker-ant data without a chain. Market 0
// is the one sim/tests/crosscheck.py uses.

import { seedFromInt, marketColony } from "../sim/js/antosim.mjs";
import { walletWeights } from "./ds/staker-ants.mjs";
import { agentSnapshot } from "./agents.mjs";
import { marketForecasters } from "./round.mjs";

export const MARKETS = [
  {
    title: "Fed decision at the next meeting",
    topic: "Macro",
    outcomes: ["Cut", "Hold", "Hike"],
    odds: [6200, 2800, 1000],
    odds6h: [5500, 3300, 1200],
    wallets: [
      { id: "grace.testnet", stakes: [9, 0, 0] },
      { id: "heidi.testnet", stakes: [0, 0, 16] },
      { id: "ivan.testnet", stakes: [0, 0, 16] },
      { id: "judy.testnet", stakes: [0, 0, 16] },
    ],
    agents: [
      { id: "llm-macro.testnet", odds: [5500, 3500, 1000] },
      { id: "base-rates.testnet", odds: [6500, 3000, 500] },
      { id: "news-scout.testnet", odds: [4800, 4000, 1200] },
    ],
  },
  {
    title: "Bitcoin above $150k on 31 December",
    topic: "Crypto",
    outcomes: ["Yes", "No"],
    odds: [2300, 7700],
    odds6h: [2600, 7400],
    wallets: [
      { id: "kim.testnet", stakes: [25, 0] },
      { id: "leo.testnet", stakes: [0, 9] },
      { id: "mia.testnet", stakes: [4, 0] },
    ],
    agents: [
      { id: "llm-macro.testnet", odds: [1800, 8200] },
      { id: "chain-watch.testnet", odds: [3000, 7000] },
      { id: "base-rates.testnet", odds: [1500, 8500] },
    ],
  },
  {
    title: "US inflation for November, year on year",
    topic: "Macro",
    outcomes: ["2.5% or less", "2.6% to 2.9%", "3.0% or more"],
    odds: [1800, 5900, 2300],
    odds6h: [2000, 5600, 2400],
    wallets: [
      { id: "nina.testnet", stakes: [0, 16, 0] },
      { id: "omar.testnet", stakes: [0, 0, 9] },
    ],
    agents: [
      { id: "llm-macro.testnet", odds: [2500, 5500, 2000] },
      { id: "base-rates.testnet", odds: [2000, 6000, 2000] },
      { id: "news-scout.testnet", odds: [1500, 5000, 3500] },
      { id: "chain-watch.testnet", odds: [3000, 5000, 2000] },
    ],
  },
  {
    title: "NEAR price on 30 November",
    topic: "Crypto",
    outcomes: ["Under $2", "$2 to $4", "$4 to $6", "Over $6"],
    odds: [1500, 5200, 2400, 900],
    odds6h: [1200, 5000, 2800, 1000],
    wallets: [
      { id: "pia.testnet", stakes: [0, 0, 16, 0] },
      { id: "quinn.testnet", stakes: [0, 0, 9, 0] },
      { id: "rosa.testnet", stakes: [0, 0, 0, 25] },
      { id: "sam.testnet", stakes: [0, 4, 0, 0] },
    ],
    agents: [
      { id: "chain-watch.testnet", odds: [1000, 4500, 3500, 1000] },
      { id: "llm-macro.testnet", odds: [2000, 5500, 2000, 500] },
      { id: "news-scout.testnet", odds: [1500, 4000, 3000, 1500] },
    ],
  },
  {
    title: "Champions League 2026–27 winner",
    topic: "Sport",
    outcomes: ["Real Madrid", "Man City", "Bayern", "Arsenal", "Other"],
    odds: [1900, 1600, 1400, 1300, 3800],
    odds6h: [2000, 1700, 1300, 1100, 3900],
    wallets: [
      { id: "tom.testnet", stakes: [0, 0, 0, 16, 0] },
      { id: "uma.testnet", stakes: [9, 0, 0, 0, 0] },
      { id: "vic.testnet", stakes: [0, 0, 4, 0, 0] },
    ],
    agents: [
      { id: "base-rates.testnet", odds: [2000, 1500, 1500, 1000, 4000] },
      { id: "news-scout.testnet", odds: [2200, 1800, 1200, 1500, 3300] },
      { id: "llm-macro.testnet", odds: [1700, 1700, 1600, 1200, 3800] },
    ],
  },
  {
    title: "Next Ethereum upgrade live before 1 March",
    topic: "Crypto",
    outcomes: ["Yes", "No"],
    odds: [4100, 5900],
    odds6h: [3500, 6500],
    wallets: [
      { id: "wes.testnet", stakes: [0, 16] },
      { id: "xia.testnet", stakes: [0, 16] },
    ],
    agents: [],
  },
].map((m) => ({
  ...m,
  weights: walletWeights(m.wallets, m.outcomes.length), // market 0: [3000, 0, 12000]
  agentOdds: agentSnapshot(m.agents, m.outcomes.length), // the last market has no posts: an even map
}));

// Each fixture market's five forecasters in KINDS order.
export function roundColonies(roundSeed) {
  const markets = MARKETS.map((m, i) => {
    const colony = marketColony(i);
    const forecasters = marketForecasters(roundSeed, colony, m, `m${i}`);
    return { ...m, index: i, colony, forecasters };
  });
  return { markets, all: markets.flatMap((m) => m.forecasters) };
}

export const fixtureRound = (id) => { const seed = seedFromInt(id); return { id, seed, ...roundColonies(seed) }; };
