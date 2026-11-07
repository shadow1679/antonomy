# Antonomy ($ANTO): Features

Source: `Ant Colony Oracle Design Document.md` (sections 5, 13, 14, 15). Status values: **Done** (prototype only), **Planned** (hackathon core), **Stretch** (only after the core loop works end to end), **Out of scope**.

**One sentence:** a public random seed drives a deterministic ant colony on-chain, the strongest pheromone trail picks one preset option, and anyone can replay the run in a browser and check the hash.

## Core features (hackathon scope)

| # | Feature | What the user sees or does | Track | Status |
| --- | --- | --- | --- | --- |
| 1 | **Burn colony** | The colony picks the daily burn size from 0.10%, 0.25%, 0.50%, 1.00% or 2.00% of the treasury. The contract caps it at 2%. | Memecoins With Mechanics | Menu and cap done in `token/`; colony wiring pending |
| 2 | **NEP-141 token** | $ANTO test token on NEAR testnet with a hard-capped burn menu. | Memecoins With Mechanics | Logic done in `token/` (no contract yet) |
| 3 | **Pheromone staking** | Holders lock tokens to lay pheromone on an option. Influence grows with the square root of the stake, with per-wallet caps. Staking closes before the randomness round is published. | Memecoins With Mechanics | Logic done in `token/`; not yet read by the sim |
| 4 | **Deterministic integer sim (Rust)** | The same seed, stake snapshot and odds snapshot always give the same result. Supports 2 to 5 outcomes. | All | Planned |
| 5 | **Forecast colonies** | For each trending Polymarket market, four colonies (Follower, Contrarian, Momentum, Community) read a keeper-posted odds snapshot. The average of their trail shares is the swarm prediction, shown next to the market odds. | Investment Thesis | Planned |
| 6 | **Replay page** | A verify-from-seed button re-runs the round in the browser and compares the hash with the on-chain one. It also has a swarm-versus-market table and a backtest. | All | Planned |
| 7 | **Scripted bots and reward pool** | Three or four rule-based bots (contrarian, follower, capped heavy staker) join every round and earn from a small play-token reward pool. | AI Swarms, Agent Economy | Planned |
| 8 | **Staker ants** | Each wallet's stake spawns ants tinted in that wallet's colour, so square-root weighting and caps are visible on the map. | Memecoins With Mechanics | Planned |
| 9 | **Thief-ant demo** | Shows an attacker splitting stake across wallets and still losing to square-root weighting. States the Sybil weakness openly. | Memecoins With Mechanics | Planned |
| 10 | **In-app colony sandbox** | Anyone names a colony, writes five options, picks a personality and runs it in the browser, with a shareable seed link. No chain involved. | AI Swarms | Planned |

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

## Contract guarantees (what must hold)

- Simulation parameters are immutable constants, and the code hash is published.
- The drand round is committed before the request closes, so nobody can influence the seed.
- The colony chooses an index from a preset menu and never an amount. Every action has a hard cap in the contract.
- Advancing the run is permissionless, with a small bounty for the caller.
- If no result arrives before the deadline, the contract runs the default action or skips the round.
- A multisig behind a timelock can pause the colony or override a result, and every use is logged.
- Events record seed, template, winner and hash so the replay page can rebuild any run.

## Forecast colonies in detail

| Colony | Reads the odds as | Food richness |
| --- | --- | --- |
| Follower | Trusting the market | Taken directly from the odds |
| Contrarian | The crowd is overconfident | (10000 − odds) / 4, so underdogs are richer |
| Momentum | Follow how the odds moved | Odds plus twice the six-hour change, floored at 2%, renormalised |
| Community | Follow holder stakes | Flat base boosted by the square root of stake per outcome |

- **Market selection:** top trending markets by 24-hour volume, a few for the demo and up to 10 as gas allows. Filters: no violence, deaths or private individuals, a minimum volume and liquidity, a resolution date within a window, and 2 to 5 outcomes (extra outcomes grouped as Other).
- **Snapshot trust:** several keepers post independently and the contract takes the per-outcome median. Each snapshot stores a hash of the raw API response.
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
