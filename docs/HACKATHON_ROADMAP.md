# Antonomy ($ANTO): Hackathon Roadmap

NEAR HACKATHON, build window **1 to 14 November 2026 (UTC)**, testnet only, zero cost. Repo must be public before **14 Nov 2026, 23:59 UTC**. Tracks: Memecoins With Mechanics (main), AI Swarms, Agent Economy, plus Investment Thesis via forecast colonies.

**Positioning (decided 2026-10-26):** forecast colonies are the headline feature. The memecoin pitch is Feed the swarm: $ANTO stakes steer each market's Community forecaster, and stakers get no payouts for being right. The Burn colony stays core as the token's daily on-chain action, on second billing. Details in `docs/FEATURES.md`.

The phase order and the dependencies come from the design doc. The day numbers are a **proposed schedule** for a 14-day window, not something the design doc fixes. The one exception is "measure ticks per call on day 2", which the doc specifies. Adjust once the gas numbers are in.

## Before the window (now to 31 Oct)

**Coding starts now, before 1 Nov.** A NEAR Discord moderator confirmed that earlier prototype work is allowed.

Already started pre-window: the integer reference sim in Python (`sim/python/antosim.py`) and its JS port (`sim/js/antosim.mjs`), checked against each other by `sim/tests/crosscheck.py`. This covers the start of phases 1 and 3.

- [x] Ask in the NEAR Discord whether prototypes that predate the build window are allowed. A moderator confirmed they are.
- [ ] Re-read https://nearhackathon.com/HACKATHON.md for current dates and rules.
- [x] Check the $ANTO ticker for collisions. Web searches on 2026-10-28 found no ANTO token and nothing called Antonomy; kept the ticker.
- [ ] Confirm the project name is unique among the hackathon's submissions (ask in the NEAR Discord).
- [ ] Create the NEAR testnet accounts, and the mainnet NEAR account needed for prizes.
- [x] Add the Agents colony (feature 9) to `forecast_market` in Python, JS and Rust, and keep the crosscheck passing. Done 2026-10-27; JS and Rust agree on 10,000 seeds.
- [x] Build Recruit the swarm (feature 9) ahead of the window: requests, fee split and forecaster agents in `token/` and the contract, keeper on-request mode, the agent tool with an MCP server, and the Recruit page. Done 2026-10-27. Testnet runs stay in phase 9.

## Phases

| Phase | Proposed days | Deliverable | Depends on |
| --- | --- | --- | --- |
| 1. Foundation | 1 | Public repo, testnet accounts, Rust and Python sim skeletons, shared test-vector format | none |
| 2. Gas measurement | 2 | Measured ticks per call (300 TGas limit). Decide ants, ticks and grid for each colony type | Phase 1 skeleton |
| 3. Deterministic core | 2 to 4 | Integer-only Rust sim for 2 to 5 outcomes, lazy evaporation, lookup-table headings, fixed update order. Rust, JS and Python hashes identical across 10,000 seeds | Phase 2 |
| 4. Fairness | 4 to 5 | Harness that runs at least 1,000 seeds per map template and colony type. No option above about 30% for five options | Phase 3 |
| 5. Burn contract and token | 4 to 7 | NEP-141 token, drand commit, request lifecycle, burn menu capped at 2%, permissionless advance with bounty, deadline default, pause | Phase 3 |
| 6. Pheromone staking | 6 to 8 | Stake locking, square-root weighting, per-wallet caps, snapshot hash feeding the seed, staking closes before the round is published | Phase 5 |
| 7. Forecast colonies (headline) | 7 to 10 | Keeper posts Polymarket snapshots, median across keepers, four forecasters per market, start with one market and grow to a few. Staking on market outcomes feeds Community. | Phases 3, 5, 6 |
| 8. Live and replay pages | 8 to 11 | Main page shows every colony of the round live (Burn plus all forecasters) from contract state; secondary replay page with verify-from-seed and backtest. Both already run on a demo clock, so this phase swaps fixtures for contract reads | Phase 3, contract events |
| 9. Bots, rewards and Recruit the swarm | 9 to 11 | Three or four rule-based bots, play-token reward pool, keeper script on free CI. Recruit the swarm: `ft_transfer_call` requests for any market, fee split (burn, keepers, forecaster agents, crank bounty), keeper on-request mode, forecaster agent registration and posts feeding the Agents colony, `ask_swarm` and `post_forecast` tool, Recruit page reworked into the request flow | Phases 5, 6, 7 |
| 10. Also in scope | 11 to 12 | Staker ants (the in-app sandbox is already built) | Phases 6, 8 |
| 11. Stretch | 12 to 13 | Pick from: drop sugar, check the receipts, ant autopsy, agents on the map | Core loop works end to end |
| 12. Submission | 13 to 14 | README for AI judges, X demo post, final live-rules check, submit | everything above |

## Milestone gates

1. **Day 2:** gas numbers known. If a full run doesn't fit in a reasonable number of calls, shrink ants, ticks or grid. Forecast colonies can drop to about 60 ants and 300 ticks.
2. **End of phase 3:** cross-language hash agreement. Nothing on-chain is trusted before this.
3. **End of phase 8:** the core loop works end to end: stake → seed → on-chain run → live page → replay → hash match. Only then start stretch features.
4. **Day 13:** feature freeze. Only README, demo and bug fixes after this.

## If time runs short (cut order)

Cut from the top of this list first.

1. Stretch features
2. Staker ants
3. Bots beyond two strategies
4. Recruit the swarm's agent tool. Agents fall back to the CLI client and direct contract calls.
5. Forecast colonies beyond one or two markets. Run only the Follower and Momentum colonies on more markets, and the others on the top three.
6. Requested markets. Keep forecaster agents and the Agents colony on trending markets.

Never cut: the deterministic sim, the four forecasters on at least one market (with Community fed by real $ANTO stakes), staking, the capped Burn colony, the live colonies page, and replay with hash verification.

## Risks to the schedule

| Risk | Response |
| --- | --- |
| A full run doesn't fit in gas | Shrink the grid, ants or ticks, and stagger markets across rounds. A zero-knowledge or optimistic path is a later fallback, not for the hackathon |
| Hash mismatches between languages | Fix the PRNG and update order first, and compare per-tick state dumps, not just final hashes |
| Fairness test shows biased maps | Adjust templates or rely on the seeded action shuffle. Don't ship a biased menu |
| Polymarket data terms unchecked | Check the terms before display or redistribution. Keep the keeper read-only |
| Keeper or drand fetch fails during the demo | Permissionless advance and the deadline default action. Keep a recorded run as backup |

## Submission checklist

- [ ] Repository is public before 14 Nov 2026, 23:59 UTC. Aim for earlier, because there are no edits after submission.
- [ ] README written for AI judges: what it is, the problem it solves, and do-X-see-Y steps.
- [ ] README states the known limits that seeds wait on drand being reachable and that a Burn day is lost if nobody cranks it for about a day.
- [ ] Forecast outputs labelled as forecasts and not advice, with no links to betting venues.
- [ ] Public demo post on X, written and published by the team, saying it was built at NEAR HACKATHON. Lead with the forecast colonies and Feed the swarm, labelled as forecasts and not advice.
- [ ] One submission per team, with a mainnet NEAR account for prizes.
- [ ] Live HACKATHON.md re-read the day of submission.

## After the hackathon (not in scope now)

Sybil resistance, calibrated forecast shares, more colonies (charity, raffle, fee, risk-dial), guest colonies on-chain, randomness as a service, and legal review. Treat the roadmap in section 11 of the design doc as the source.
