# Antonomy ($ANTO): Features

Source: `Ant Colony Oracle Design Document.md` (sections 5, 13, 14, 15). Status values: **Done** (prototype only), **Planned** (hackathon core), **Stretch** (only after the core loop works end to end), **Out of scope**.

**One sentence:** a public random seed drives a deterministic ant colony on-chain, the strongest pheromone trail picks one preset option, and anyone can replay the run in a browser and check the hash.

## Core features (hackathon scope)

| # | Feature | What the user sees or does | Track | Status |
| --- | --- | --- | --- | --- |
| 1 | **Burn colony** | The colony picks the daily burn size from 0.10%, 0.25%, 0.50%, 1.00% or 2.00% of the treasury. The contract caps it at 2%. | Memecoins With Mechanics | Menu and cap done in `token/`; colony wiring pending |
| 2 | **NEP-141 token** | $ANTO test token on NEAR testnet with a hard-capped burn menu. | Memecoins With Mechanics | Logic done in `token/` (no contract yet) |
| 3 | **Pheromone staking** | Holders lock tokens to lay pheromone on an option. Influence grows with the square root of the stake, with per-wallet caps. Staking closes before the randomness round is published. | Memecoins With Mechanics | Logic done in `token/`; read by the sim through `sim_weights` |
| 4 | **Deterministic integer sim (Rust)** | The same seed, stake snapshot and odds snapshot always give the same result. Supports 2 to 5 outcomes. | All | Done in `sim/` (Python, JS, Rust agree; see below) |
| 5 | **Forecast colonies** | For each trending Polymarket market, four colonies (Follower, Contrarian, Momentum, Community) read a keeper-posted odds snapshot. The average of their trail shares is the swarm prediction, shown next to the market odds. | Investment Thesis | Sim, keeper registry and keeper script done (see below); on-chain run waits for the round lifecycle |
| 6 | **Live colonies (main page)** | The landing page (`web/index.html`) shows every colony of the current round running at once: the Burn colony and the four forecasters of each trending market, with live trail shares and the swarm-versus-market table. Every viewer sees the same tick. | All | Page built on a demo clock with fixture snapshots; switches to contract reads once rounds run on testnet |
| 6b | **Replay page** | A secondary page (`web/replay.html`), opened from any live colony. Pick a round and colony, scrub it tick by tick, and verify from seed: the browser re-runs it and compares the hash with the on-chain one. A backtest is still to come. | All | Page built; on-chain hash comparison waits for contract events |
| 7 | **Scripted bots and reward pool** | Three or four rule-based bots (contrarian, follower, capped heavy staker) join every round and earn from a small play-token reward pool. | AI Swarms, Agent Economy | Pool in `token/reward.rs` and the contract (`fund_rewards`; `execute_burn` pays 10% of the pool to Burn stakers on the chosen index, pro rata to stake). Three bots in `bots/swarm.py` (follower, contrarian, heavy staker on the 2.00% burn). Not yet run on testnet; a fourth bot is not built |
| 8 | **Staker ants** | Each wallet's stake spawns ants tinted in that wallet's colour, so square-root weighting and caps are visible on the map. | Memecoins With Mechanics | Planned |
| 9 | **Thief-ant demo** | Shows an attacker splitting stake across wallets and still losing to square-root weighting. States the Sybil weakness openly. | Memecoins With Mechanics | Planned |
| 10 | **In-app colony sandbox** | Anyone names a colony, writes 2 to 5 options, picks a personality and runs it in the browser, with a shareable link (`web/sandbox.html`). No chain involved. | AI Swarms | Built. Personalities reuse sim v1 richness rules: Wild (seed richness), Even, Follower and Contrarian (read per-option weights as odds) |

## Stretch features

Only after the core loop works end to end. All are free to run.

| Feature | Track | The meme | Tech it exposes |
| --- | --- | --- | --- |
| Drop sugar | Memecoins With Mechanics | Holders drop sugar on an option and its scent grows | Square-root weighting, stake snapshot hashed into the seed |
| Smell-o-vision | Memecoins With Mechanics | Toggle that shows the scent the ants follow | Pheromone field, deposit and evaporation rules |
| Check the receipts | Memecoins With Mechanics | One click re-runs the day and compares hashes | Determinism |
| Ant autopsy | AI Swarms | Scrub a run tick by tick and follow one ant | Fixed update order, bit-exact replay |
| Recruit an ant | AI Swarms, Agent Economy | Starter script so any agent joins a round with its own strategy | Bot interface, per-wallet caps, reward accounting |
| Panic button | All | One account can freeze the colony | Pause method and kill switch |

## Sim inputs (feature 4)

The result is a pure function of the seed, the stake snapshot and the odds snapshot (`ANTO-SIM-v1`). Richness is per option and follows the seeded shuffle of options over food sources. The richest source is scaled to 1.3 and the rest in proportion, so the total doesn't matter.

| Colony | Food weight per outcome |
| --- | --- |
| Follower | odds (bp) |
| Contrarian | (10000 − odds) / 4 |
| Momentum | odds + 2 × (odds − odds six hours ago), floored at 200 |
| Community, Burn | 10000 + sum over wallets of sqrt(tokens staked) × 1000, so no stakes means an even map |

The result hash also commits the stake snapshot hash and a hash of the odds snapshot (both zero when a colony doesn't read them). The base of 10000 and the 200 floor are my choices, since the design doc leaves them open. Because the base is absolute, a single wallet at a 100-token cap moves an option's weight by about a factor of two.

## Contract guarantees (what must hold)

- Simulation parameters are immutable constants, and the code hash is published.
- The drand round is committed before the request closes, so nobody can influence the seed.
- The colony chooses an index from a preset menu and never an amount. Every action has a hard cap in the contract.
- Advancing the run is permissionless, with a small bounty for the caller.
- If no result arrives before the deadline, the contract runs the default action or skips the round.
- A multisig behind a timelock can pause the colony or override a result, and every use is logged.
- Events record seed, template, winner and hash so the live and replay pages can rebuild any run.

## Forecast colonies in detail

| Colony | Reads the odds as | Food richness |
| --- | --- | --- |
| Follower | Trusting the market | Taken directly from the odds |
| Contrarian | The crowd is overconfident | (10000 − odds) / 4, so underdogs are richer |
| Momentum | Follow how the odds moved | Odds plus twice the six-hour change, floored at 2%, renormalised |
| Community | Follow holder stakes | Flat base boosted by the square root of stake per outcome |

- **Market selection (decided 2026-10-26):** open Polymarket events sorted by 24-hour volume, first one that passes the filters (`MAX_TRENDING = 1` until gas is measured; up to 10 later). Floors in `keeper/trending.py`: 24h volume at least $100k, liquidity at least $50k, ends in 1 to 90 days, top outcome under 97%. Content filter: deny-listed tags and words (violence, deaths, private individuals); a keyword list misses things, so report and add. Neg-risk events keep the four most likely outcomes (in market-id order) and fold the rest into Other at 10000 minus the four. Other events use their highest-volume market. User-added slots are not built yet (fee still open).
- **Snapshot trust (decided 2026-10-26):** an allow-list of keepers fixed at contract init, with a strict-majority quorum. A list counts once a quorum posted the same markets with the same outcome labels in the same order; the odds are the lower per-outcome median over those keepers. Each post stores the hash of the raw API responses it was built from (`--save-raw` keeps the bytes). Keepers are still trusted as a group.
- **Maps and seeds:** each forecaster runs on its own map: `colony_seed(round seed, colony id, kind)`, where colony id 0 is Burn and 1 + m is market m (the same id the market's stakes use). 60 ants and 300 ticks per forecaster.
- **Shares and hash:** a forecaster's trail share is its per-option score over the total, in basis points (floored, remainder to the winner). Swarm belief is the floored mean of the four (remainder to the largest sum, lowest index on ties). The market hash commits the four colony hashes and the swarm belief. The crosscheck covers it (keys `hs`, `hy`).
- **Signal check (2026-10-26):** on a 62/28/10 market, mean Follower share over 400 seeds is 38/32/30 at 60×300, and 36/32/32 at 150×800. The direction is right but compressed toward even odds, as section 15 of the design doc warns. Calibration is still needed before any number reads as a probability.
- **Scoring:** after a market resolves, each colony gets a Brier score on a public leaderboard.
- **Honest limitation:** the colonies mostly echo the market with noise. The sample backtest (eight made-up markets) had the market at 0.535, the four colonies at 0.66 to 0.82, and the swarm average at 0.725. Outputs are labelled "swarm belief" until trail shares are calibrated.
- **Rules:** no payouts for being right, no links to betting venues, every output labelled as a forecast and not advice.

## Out of scope for the hackathon

NFTs, NEAR Intents payouts, TEE attestation, randomness as a service, mainnet deployment, and on-chain guest colonies. These stay on the roadmap.

## Known limits (state in the README)

- Splitting stake across wallets to beat the square-root weighting is not solved. Sybil resistance is future work.
- The demo contract trusts the posted drand round. Full on-chain verification is future work.
- The reward pool resembles prediction betting. It uses a play token on testnet, and a real launch needs legal review.
- The prototype, design and early sim code predate the build window. A NEAR Discord moderator confirmed this is allowed. Still disclose it.
