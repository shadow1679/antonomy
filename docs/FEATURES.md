# Antonomy ($ANTO): features

Every feature below is live on NEAR testnet at [`antonomy-oracle.testnet`](https://testnet.nearblocks.io/address/antonomy-oracle.testnet), and each one lists where it lives in the code and how to check it. The [README](../README.md) has the overview, a five-minute tour and the known limits.

| # | Feature | In one line |
| --- | --- | --- |
| 1 | [On-chain colony engine](#1-on-chain-colony-engine) | The contract runs an integer ant-colony simulation itself; Python, JavaScript and Rust produce the same hash |
| 2 | [Seeds nobody can pick](#2-seeds-nobody-can-pick) | Every seed is a future drand round, its BLS signature checked inside the contract |
| 3 | [Forecast colonies](#3-forecast-colonies) | Three colonies read each trending Polymarket market; their weighted trail share is the swarm belief |
| 4 | [Scorebook](#4-scorebook-and-adaptive-weights) | Resolved markets score every source on chain; skill sets the weights, never money |
| 5 | [$ANTO token](#5-anto-token) | NEP-141 play token with `ft_transfer_call`, free NEP-145 storage and a one-time faucet |
| 6 | [Drop sugar](#6-drop-sugar-staking) | Stake $ANTO to make an outcome's food richer, square-root weighted |
| 7 | [Daily pot](#7-the-daily-pot-burn-colony) | Once a day a colony picks how much of the treasury to burn and share, from a capped menu |
| 8 | [Recruit the swarm](#8-recruit-the-swarm) | Pay a fee for a forecast; keepers, AI agents and crankers are paid for the work |
| 9 | [Randomness as a service](#9-randomness-as-a-service) | Any account or contract gets a drand-backed value nobody could pick |
| 10 | [Verify anything](#10-verify-anything) | Re-run any colony, round or pot in a browser or a terminal and compare hashes |
| 11 | [The web app](#11-the-web-app) | Static pages, no build step, every number read from the chain |
| 12 | [Keepers, crankers and bots](#12-keepers-crankers-and-bots) | One daemon makes every call nobody else makes; bots and a demo crew keep testnet busy |

## 1. On-chain colony engine

A deterministic ant-colony simulation (spec `ANTO-SIM-v1`). Ants forage on a 72×48 grid with 2 to 5 food sources, one per option, and lay pheromone on the way home. The trail near each source is summed every 100 ticks and at the last tick, and the option with the most trail wins. The ants are the spectacle; all the entropy is in the seed.

- **Integer only.** An integer PRNG, 16 or 32 headings from a shared cos/sin lookup table (`sim/tables.json`), a fixed ant update order, ties to the lowest index. No floats.
- **Three implementations, one hash.** `sim/python/antosim.py` (reference), `sim/js/antosim.mjs` (browser) and `sim/rust/` (the contract's crate) agree on 10,000 seeds.
- **Gas-shaped.** Lazy evaporation (each cell remembers when it was last touched and decays on read), so cost scales with ants, not grid size. Runs advance a bounded number of ticks per permissionless call under the 300 TGas limit.
- **Fair by measurement.** With no inputs, every option wins close to its fair share over 1,000 seeds per colony type (five options: 18.1% to 22.5%).
- **Immutable parameters.** Grid, ant counts, ticks, evaporation (0.8% a tick), pheromone cap (20) and scoring radius (6 cells) are contract constants.

**Check:** `python3 -I sim/tests/crosscheck.py 10000 --no-py` prints `ALL MATCH`; `cargo run --release --manifest-path sim/rust/Cargo.toml --bin fairness -- --check`.

## 2. Seeds nobody can pick

Inputs close first. The seed then commits to the first drand quicknet round published after the close: seed = hash(drand randomness, request or round ID, contract address). The call that draws it must carry that round's BLS12-381 signature, and the contract verifies it with NEAR's BLS host functions (`contract/src/drand.rs`, through `near-sys`, about 8 TGas). The contract trusts drand's threshold network, not a keeper or the team. Each colony's map comes from the seed plus its index, and the seed also picks which option sits on which food source.

**Check:** `contract/src/drand.rs`; the seed and drand round on any round in History (`/web/replay.html`).

## 3. Forecast colonies

Every ~25 minutes a round starts. Keepers post up to 12 trending Polymarket markets, holders stake for 20 minutes, agents have a 5-minute window to commit and reveal their own odds, then the seed is drawn and each market gets three colonies of 60 ants for 300 ticks on their own maps:

| Colony | Reads | Food richness per outcome | Sits out when |
| --- | --- | --- | --- |
| **Momentum** | Keepers' odds and their 1-, 6- and 24-hour moves | Odds plus a move damped on reversals and choppy paths, scaled to 0 … 1.3 | Never |
| **Community** | $ANTO staked on each outcome | A flat base plus Σ √stake (each wallet scaled ×0.5 … ×2 by its record), scaled to 0.35 … 1.3 | Nobody staked |
| **Agents** | Agents' revealed odds | Skill-weighted median, scaled like Momentum | No agent revealed |

An outcome's **trail share** is its score over the total, in basis points summing to exactly 10,000. The **swarm belief** is the weighted mean of the colonies with input. The **market hash** commits the three colony hashes and the swarm belief. Swarm belief is shown next to the market odds, labelled as a forecast, and never as a probability.

**Which markets.** `keeper/trending.py` reads Polymarket's public Gamma API and keeps the top open events by 24-hour volume that clear its floors ($100,000 volume, $50,000 liquidity, 1 to 90 days to the end, top outcome under 97%) and a content filter (no violence, deaths or private individuals). Neg-risk events keep their four likeliest outcomes and fold the rest into "Other".

**Trusted data, minimised.** Three keepers post independently; the contract accepts a market when 2 agree on it and its outcomes, stores the per-outcome median and a hash of every raw API response. Web pages read these on-chain odds, never Polymarket (the market search in Add a market is the one exception).

**Check:** any card on `/web/live.html` opens `/web/market.html` with a "verified in your browser" table; `node docs/example_market.mjs` replays a real round-4 market offline.

## 4. Scorebook and adaptive weights

Keepers post each market's resolution under the 2-of-3 quorum. Every finished forecast is recorded per market, and when the market resolves `score_market` scores every source (the market's odds, each colony, the swarm, each agent, each wallet) by **skill**: the market's Brier score minus the source's, on the same forecasts. Skill sets each colony's weight in the swarm belief, each agent's weight in the Agents median and each wallet's multiplier in Community, by fixed integer formulas, frozen per round and committed in the hashes. 90 markets are scored so far; the market's own odds lead, and the contract has pushed every colony to the weight floor. Full spec and numbers: [FORECAST_QUALITY.md](FORECAST_QUALITY.md).

**Check:** the track record on `/web/live.html`, or the `score_tally` view.

## 5. $ANTO token

The memecoin. The burn and the staking are its mechanics; the meme is the ants themselves: a swarm on a NEAR contract taking on the market, round after round, with the scorebook keeping the score in public. Every forecast is a map of ants you can watch and re-run, every stake hatches ants in the staker's colour, any ant's life can be followed in History, and the whole project is drawn as one ant nest. [Why $ANTO is a memecoin](../README.md#why-anto-is-a-memecoin) has the full case.

A NEP-141 token with `ft_transfer_call`, and NEP-145 storage management where storage is free. Genesis supply 1,000,000 $ANTO; everything burned since is visible as `1,000,000 − ft_total_supply` in the top bar's $ANTO chip. A once-per-account faucet gives 150 play $ANTO on first use. Testnet only, no mainnet deployment.

| What $ANTO does | Where |
| --- | --- |
| Steers a market's Community colony | Drop sugar (§6) |
| Steers the daily pot, and earns a share of it when its size is picked | Daily pot (§7) |
| Pays for a forecast on request, split among the workers | Recruit the swarm (§8) |
| Is burned as the spam fee on each randomness request | Randomness (§9) |
| Is locked as a refundable deposit to register as an agent | Recruit the swarm (§8) |

## 6. Drop sugar (staking)

Holders lock $ANTO on an outcome of a market (its Community colony), a requested market, or a pot size (the Burn colony).

- **Square-root weight.** Influence is √stake: four times the tokens, twice the weight, so a crowd outweighs one whale.
- **One wallet budget.** A single cap per wallet (100 $ANTO) covers market, request and Burn stakes together.
- **Closes before the seed.** Staking ends before the drand round is published, and the stake snapshot's hash goes into the result hash.
- **Staker ants.** Each wallet's stake hatches ants tinted in its own colour (3 per √token) on the Community and Burn maps; hover a wallet to light up its ants. The tint is cosmetic: the sim reads only the summed weight per option.
- **Refunds and locks.** Market stakes are refunded when the next round starts. Request stakes unlock once the request's third colony has run. Burn stakes are locked until every day they count for has paid (lifted if a pot is a day overdue or the contract is paused).
- **Preview.** The Pot page runs the Burn colony with and without your stake on the same map, so you see how much your sugar moves the scent before you stake.

Nothing pays a market stake for being right.

## 7. The daily pot (Burn colony)

The memecoin's burn: once a UTC day, an ant colony decides how much of the treasury leaves circulation.

| Pot size (of treasury) | Burned | Shared with stakers on that size | Sim handicap |
| ---: | ---: | ---: | ---: |
| ▲ 0.10% | 0.02% | 0.08% | ×1.000 |
| ■ 0.25% | 0.15% | 0.10% | ×0.875 |
| ◆ 0.50% | 0.38% | 0.12% | ×0.750 |
| ● 1.00% | 0.86% | 0.14% | ×0.625 |
| ★ 2.00% | 1.84% | 0.16% | ×0.500 |

- **00:00 to 12:00 UTC:** staking is open on the five sizes.
- **12:00:** stakes freeze into the day's snapshot and the seed is drawn from drand.
- **12:00 to 24:00:** the colony runs 150 ants for 43,200 ticks, one a second, in about 30 permissionless `crank_burn` calls. Anyone can watch it live.
- **From 24:00:** anyone calls `execute_burn`: one transaction burns the burn part and pays the shared part to the stakers on the picked size, pro rata by stake. No claim step. If nobody calls it, the next day's first crank does.

Why it isn't "stake on the biggest pot": the reward barely grows with the pot (0.08% to 0.16%), the sim scales bigger pots' food down (stakes included), and a crowded size splits its reward more ways. With no stakes, the five sizes win about 29, 26, 20, 14 and 11% of days. The colony picks an index from the menu, never an amount, and the 2% cap is checked at compile time (`token/src/burn.rs`).

**Check:** `/web/pot.html` (the day clock, the live run, past pots re-run in your browser); `token/src/burn.rs`, `reward.rs`, `day.rs`, `burnrun.rs`.

## 8. Recruit the swarm

Anyone pays a $ANTO fee for a forecast on a Polymarket market of their choice. Every other role can be an AI agent, and every role is paid for work, never for being right.

1. **Request.** `request_forecast` with the market's event slug; the fee goes into escrow. Slugs with deny-listed words are refused, and keepers apply the full content filter.
2. **Odds.** Keepers post the market's odds under the same quorum and median rule as trending markets. No quorum by the deadline: the request is skipped and the fee refunded.
3. **Agents' window.** Registered agents commit and reveal their own odds; holders can stake on the request's Community colony.
4. **Seed and run.** The first crank carries the drand signature and draws the seed; three `crank_request` calls run the three colonies.
5. **Result.** The swarm belief and market hash are stored, and the fee is paid out.

| Role | Does | Paid from the 100 $ANTO fee |
| --- | --- | --- |
| Keeper | Posts the market's odds | 20%, split among the accepted quorum |
| Forecaster agent | Posts its own odds from any model; registers with a 10 $ANTO refundable deposit | 30%, split among on-time posts |
| Cranker | Runs a colony on chain | 10%, a bounty per crank |
| Treasury | | The remaining 40% |

**Agent tool.** `bots/recruit.py` is a CLI and an MCP server (Python standard library only, MCP over stdio by hand): `ask` / `ask_swarm` requests a forecast and waits for the swarm belief, `register` and `post` / `post_forecast` commit then reveal an agent's odds, `crank` runs the next colony, `verify` re-runs a request with the Python reference sim and compares every hash. Every command is a dry run unless `--send`.

**Check:** `/web/recruit.html#forecast`; `python3 -I bots/recruit.py verify --contract antonomy-oracle.testnet --request 1`.

## 9. Randomness as a service

`request_randomness` burns 1 $ANTO and commits to the next drand round. Once that round is out, anyone proves it with `fulfill_randomness` (the same on-chain BLS check), and each request reads its own value: `sha256("ANTO-RAND-v1", drand randomness, id, requester, contract)`. Latency is seconds; one proof settles every request on that round. About 2 and 10 TGas. A contract can use it with two cross-contract calls, ask then read; the Recruit page shows the consumer code and draws a winner from a list of names.

**Check:** `/web/recruit.html#random`. Deployed on testnet; no request has been made there yet.

## 10. Verify anything

- **In the browser.** Every market page re-runs its three colonies from the chain's inputs and shows each chain hash next to your browser's.
- **Whole rounds.** A receipt is JSON with the round seed and every colony and market hash, requests included. History's Check every hash re-runs the round and marks each match or mismatch; paste someone else's receipt to check it. From a terminal: `node web/receipts.mjs issue > r.json && node web/receipts.mjs check r.json`.
- **History at past blocks.** The contract keeps only the current and previous round and the newest Burn run, so `/web/replay.html` reads older ones from the contract's own state at past blocks on archival RPCs. No server of ours sits in between.
- **Ant autopsy.** Click any ant to follow it: state, cell, heading, deposit, and a log of every trip. Notable-ant picks (busiest forager, first home, lost) and a timeline save guessing. Following an ant never touches the sim RNG, so it can't change a hash.

## 11. The web app

Static HTML and ES modules, no framework, no build step. Each page reads the live contract over JSON-RPC (`web/chain.mjs`) and connects a wallet through `@hot-labs/near-connect`. Add `?contract=<account>` to point any page at another deployment.

| Page | What it shows |
| --- | --- |
| `/web/` (`index.html`) | The landing page: one real market's colony replayed beside the pitch, scrolled tick by tick, with Verify this colony |
| `/web/nest.html` | The nest: the whole system as one cutaway ant base, each chamber (contract, granary, burn pit, well, gallery…) with live numbers and ants carrying each flow |
| `/web/live.html` | Forecasts: the round timeline, a card per market with three mini colonies and the gap to the market odds, the track record, Add a market |
| `/web/market.html?m=m0` | One market: stake, post odds, the three colonies on one stage, the verified table. `?r=<id>` shows a requested forecast |
| `/web/pot.html` | The daily pot: day clock, live colony, menu, your stakes, past pots |
| `/web/recruit.html` | Recruit the swarm: request a forecast, randomness, answer as an agent |
| `/web/replay.html` | History: every past round and pot, replay, ant autopsy, receipts |
| `/web/docs.html` | Every explanation, the agent tool's commands by role, the randomness consumer guide |

The UI follows one design system, "Nest and ledger" ([DESIGN_SYSTEM.md](DESIGN_SYSTEM.md)): the map is the one organic place, everything else is a ledger of tabular numbers and hashes; amber means pheromone and the one primary action, green and red mean match and mismatch only, and every option carries a glyph (▲ ■ ◆ ● ★) so colour is never the only signal.

## 12. Keepers, crankers and bots

- **Keeper daemon** (`keeper/daemon.py`): makes every call nobody else is making: keeper posts, drand proofs, `finalize_markets`, round and request cranks, `start_round`, `crank_burn`, `execute_burn`, resolutions and `score_market`. Dry run unless `--send`; runs as a macOS LaunchAgent on testnet.
- **Demo crew** (`keeper/demo.py`, `keeper/demo_setup.sh`): scripted stakers (follower, contrarian, mixed), extra agents (sharp, flat, noisy) and a Recruit requester, so the testnet deployment stays busy without the team.
- **Burn bot swarm** (`bots/swarm.py`): follower, contrarian, capped heavy staker and echo bots stake on the daily pot.

## Sim inputs

The result is a pure function of the seed, the stake snapshot and the odds snapshot. The richest option is scaled to 1.3 and the rest in proportion.

| Colony | Food weight per outcome |
| --- | --- |
| Momentum | odds + move, move = ⌊(Δ1h + 2·Δ6h + Δ24h)/2⌋, halved on a reversal, scaled by 10000/(10000 + 4·chop); floored at 200 bp. Without the 1 h and 24 h windows: odds + 2 × Δ6h |
| Community, Burn | 2500 + Σ √tokens × 1000 over wallets (a forecast wallet's √ scaled ×0.5 … ×2 by its record); Burn sizes then × their handicap |
| Agents | Skill-weighted lower median of the revealed odds (bp); an even map if no agent revealed |

The result hash commits the sim version, seed, stake snapshot hash, odds snapshot hash, food sources, scores and winner. Each forecast colony runs on its own map from `colony_seed(round seed, colony id, kind)`.

## Contract guarantees

- Simulation parameters are immutable constants.
- Each seed commits to the first drand round published after its inputs close, and the contract checks that round's BLS signature.
- The colony chooses an index from a preset menu, never an amount, and every action has a hard cap.
- Advancing a run is permissionless.
- A missed deadline has a defined outcome: a request without quorum is skipped and refunded, a Burn day not finished before the next one starts is skipped (nothing burns, nothing is paid).
- A guardian can pause staking, cranks and payouts; withdrawals stay open and the Burn lock lifts.
- Events record seed, winner and hash, so pages can rebuild any run.

## Out of scope

NFTs, NEAR Intents payouts, TEE attestation, mainnet deployment, on-chain custom colonies, and an override multisig with a timelock.
