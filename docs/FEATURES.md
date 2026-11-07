# Antonomy ($ANTO): Features

Ant colonies forecast trending Polymarket markets on-chain from a public random seed. $ANTO holders drop sugar on outcomes, and anyone can replay any run in a browser and check the hash.

Forecasts are the headline, the Burn colony is the token's daily on-chain action, and the main track is **Memecoins With Mechanics**. Nothing pays anyone for being right, nothing links to betting venues, and every output is labelled a forecast, not advice.

## Features

### 1. Forecast colonies

Each round, keepers post up to 12 trending Polymarket markets. Every market gets three colonies on their own maps:

| Colony | Reads | As food richness |
| --- | --- | --- |
| Momentum | The market odds plus their 1-, 6- and 24-hour moves, damped on reversals and choppy paths | Odds-proportional, 0 to 1.3 |
| Community | $ANTO stakes on each outcome, each wallet scaled by its record | Flat base plus the square root of stake, 0.35 to 1.3 |
| Agents | The agents' skill-weighted median of revealed odds | Odds-proportional, even map with no posts |

A colony's trail share is its per-option score over the total, in basis points. The weighted mean of the colonies that have input is the **swarm belief**, shown next to the market odds; the weights come from each colony's scored record and are equal until 20 markets are scored. A colony with no input (Community without stakes, Agents without posts) still runs but sits out of the mean.

**Scorebook** (docs/FORECAST_QUALITY.md). Keepers post each market's resolution under the 2-of-3 quorum. Every finished forecast is recorded per market, and once the market resolves every source is scored: the market's own odds, each colony, the swarm, each agent and each wallet, by time-averaged Brier score and by skill, the market's Brier minus the source's on the same forecasts. Skill sets the colony, agent and wallet weights by fixed integer formulas; it never moves money. 50-50 markets are counted, not scored. The market hash commits the three colony hashes and the swarm belief. Swarm belief is never shown as a probability.

Markets are the open Polymarket events with the highest 24-hour volume that pass the keeper's floors (volume, liquidity, end date, top outcome under 97%) and a content filter that excludes violence, deaths and private individuals. Neg-risk events keep their four likeliest outcomes and fold the rest into Other.

### 2. Drop sugar (staking)

Holders lock $ANTO to lay pheromone on an outcome of a market (its Community colony) or on a pot size (the Burn colony). Influence is the square root of the stake, with one wallet budget and per-wallet caps. Staking closes before the randomness round is published. Market stakes are refunded when the next round starts. Nothing pays stakers for being right.

On the Burn page, a browser preview runs the Burn colony with and without your stake on the same map, so you can see how much one more stake moves the scent. It stakes nothing.

### 3. Deterministic integer sim

The same seed, stake snapshot and odds snapshot always give the same result, for 2 to 5 outcomes. Python (reference), JavaScript (browser) and Rust (on-chain) agree on result hashes. Integer arithmetic only, an integer PRNG, lookup-table headings and a fixed update order.

### 4. Burn colony (the daily pot)

Once a UTC day the colony picks the size of the daily pot from a fixed menu: 0.10%, 0.25%, 0.50%, 1.00% or 2.00% of the treasury, hard-capped at 2%.

- **00:00 to 12:00 UTC:** staking is open. At 12:00 stakes freeze into that day's snapshot and the day's seed is drawn.
- **12:00 to 24:00 UTC:** the colony runs 43,200 ticks, one a second, and anyone can watch it. The option with the most trail, summed at a checkpoint every 100 ticks, wins.
- **From 24:00:** anyone calls `execute_burn`. Each size has a fixed reward part (0.08% to 0.16% of the treasury) paid to the stakers on the picked size by stake, and the rest of the pot burns. Bigger pots are handicapped in the sim, so staking on the biggest pot does not simply pay more.
- **Lock:** a Burn stake can't be withdrawn until the pot of every day it counts for has paid.

The Burn page shows the day clock and the colony, the pot menu, past pots (re-run in the browser and checked against the chain's hash) and, folded away at the bottom, the token's facts and top earners.

### 5. $ANTO token

A NEP-141 play token on NEAR testnet with `ft_transfer_call` and NEP-145 storage management (storage is free). A once-per-account faucet gives new accounts play tokens. Testnet only, no mainnet deployment.

### 6. Live page and market pages

The Live page is the Forecast page (docs/FORECAST_PAGE.md): a persistent "forecast display, not betting" line, the round timeline with the one clock that matters, a widest-gap line, and one card per market, the round's trending markets and the community's requests alike. Each card shows its three colonies as small maps replayed from the on-chain seed, an outcome table (market odds 6h ago → now, swarm belief, and the gap as a bone bar), its status (verified in your browser once the hashes match) and its headline gap. A side column holds the track record (from the scorebook: markets scored and waiting, the market's and the swarm's Brier scores once 20 are scored, and the colonies' current weights) and Add a market, which hands the link to the Recruit page. A card opens the market page: stake or unstake, register as an agent and post odds, then the three colonies on one stage with a "verified in your browser" table (chain hash against the local hash, market hash, swarm belief). Requested forecasts and today's burn sit below.

### 6a. The nest (front page)

The whole project as one cutaway ant base, painted like the colony map: the queen's chamber is the contract (one egg per round, its result hashes), the granary holds the treasury and the staked pool, the burn pit's flame follows the last pot, the nursery holds requested markets and agents' posted odds, the guard post shows the filters and caps with accepted and turned-away requests, the forecast gallery has a cell per market that glows when the swarm's favourite differs from the market's, the well is drand and the randomness service, and the workers' hall is keepers, agents and crankers. Every number is read from the chain. Ants walk the tunnels for each flow, with bursts when the chain changes. A nest log and Check the receipts, which re-runs the round's colonies in the browser and compares every hash.

### 7. History, receipts and ant autopsy

- **History** (`replay.html`): every past round and every daily pot, newest first, read from the contract's own state at past blocks (`web/histchain.mjs`; the contract itself keeps only the current and previous round and the newest Burn run). Each round lists its markets with their result (the outcome the swarm belief leads on, the market's odds for it, the gap), and requested forecasts are listed under the round that was open when they were asked. Opening a round shows every market's result first, outcome by outcome, then lets you scrub any of its colonies tick by tick and compare the hash with the chain's.
- **Receipts:** a receipt is JSON with the round seed, one hash per colony and one per market, and the same for each request made during the round. Under an opened round, Check every hash re-runs the round in the browser and marks each hash match, mismatch or missing; a pasted or edited receipt is checked the same way. `receipts.html` redirects there.
- **Ant autopsy:** click an ant, or step through ant numbers, to see its state, cell, heading and deposit, with a log of every trip it makes. Notable-ant picks and a timeline save guessing.

### 8. Staker ants and agent ants

Each wallet's stake spawns ants tinted in that wallet's colour on the Community and Burn maps (3 ants per square-root token, hue from the account id), with a roster that lights up one wallet's ants. On the Agents map, each agent gets an equal share of ants in its own colour, and the follow card shows its posted odds. The tint is cosmetic; the sim reads only the summed weight per option.

### 9. Recruit the swarm (agents)

Anyone pays a $ANTO fee to commission a forecast on a Polymarket market of their choice. Agents fill every other role and are paid from the fee for work, never for being right.

1. **Request:** `request_forecast` with the market's event slug; the fee goes into escrow. The contract refuses slugs with deny-listed words and the keepers apply the full filter.
2. **Odds:** keepers post the market's odds by a deadline, under the same quorum and median rule as trending markets. No quorum means the request is skipped and the fee refunded.
3. **Agents' window:** registered agents post their own odds; holders can stake on the request's Community colony. The first crank freezes both.
4. **Seed and run:** the first crank carries the signature of the drand round first published after the window closes. Crankers then run the three colonies, one per `crank_request` call.
5. **Result:** the swarm belief and market hash are stored; anyone can re-run them in the browser.

| Role | Does | Paid |
| --- | --- | --- |
| Requester | Pays the fee | |
| Keeper | Posts the market's Polymarket odds | Keeper share |
| Forecaster agent | Posts its own odds from any model; registers with a refundable deposit | Participation share, split equally among on-time posts |
| Cranker | Runs the colonies on-chain | Crank bounty per call |
| Treasury | | The rest of the fee, dust included |

**Agent tool** (`bots/recruit.py`, a CLI and an MCP server): `ask_swarm` requests a forecast, `post_forecast` forecasts an agent's odds (it commits a hash while the window hides posts and reveals in the window's last third), `verify` re-runs a request with the Python reference sim and compares every hash.

**Add a market** (Live's side panel): search Polymarket or paste a link, check the market the way a keeper does, pay the fee. **Recruit page** (in the top bar; three tabs): Add a market and the fee split first, then the request history as a list, how to ask from code, randomness, and registering as an agent. **A request's details** are on the market page (`market.html?r=<id>`): keeper odds, agents' window, finalize and crank buttons, result, inline verify and payout tables.

### 10. Randomness as a service

Any account or contract calls `request_randomness`, which burns a small $ANTO fee and commits to a drand round just after the call. Anyone proves that round with `fulfill_randomness` (an on-chain BLS check), and each request then reads its own value, `sha256(tag, drand randomness, id, requester, contract)`. Latency is seconds. The Recruit page's Randomness section requests, proves, draws a winner among a list of names and checks the value against drand in the browser. Deployed to testnet, not yet tried there.

### 11. Bots and keeper daemon

- **Bot swarm** (`bots/swarm.py`): follower, contrarian, capped heavy staker and echo (which feeds the colony's last pick) stake on the Burn colony and earn the pot's reward part when their size wins.
- **Keeper daemon** (`keeper/daemon.py`): makes every call nobody else is making: keeper posts, drand proofs, `finalize_markets`, cranks, `start_round`, `execute_burn`, and request finalize and cranks. Runs as a macOS LaunchAgent on testnet.

## Sim inputs

The result is a pure function of the seed, the stake snapshot and the odds snapshot (`ANTO-SIM-v1`). The richest option is scaled to 1.3 and the rest in proportion. The score is the trail within 6 cells of each source, summed every 100 ticks and at the last tick.

| Colony | Food weight per outcome |
| --- | --- |
| Momentum | odds + 2 × (odds − odds six hours ago), floored at 200; with the 1- and 24-hour windows, odds + move, where move = ⌊(Δ1h + 2·Δ6h + Δ24h)/2⌋, halved when Δ1h and Δ24h point opposite ways, then scaled by 10000/(10000 + 4·chop) (chop: the four prices' range less |Δ24h|) |
| Community, Burn | 2500 + sum over wallets of sqrt(tokens staked) × 1000 (a forecast wallet's sqrt scaled by its record, ×0.5 to ×2), so no stakes means an even map |
| Agents | skill-weighted lower median of the agents' revealed odds (bp), even map if no agent revealed |

The swarm belief is ⌊Σ w·share / Σ w⌋ over the counted colonies, the remainder on the leader. The market hash appends the three colony weights, and the agents' snapshot hash the agents' weights, only when they are not all equal, so a result with equal weights hashes as before.

The result hash also commits the stake snapshot hash and a hash of the odds snapshot (both zero when a colony doesn't read them). Each forecaster runs on its own map from `colony_seed(round seed, colony id, kind)`, with 60 ants and 300 ticks; the Burn colony runs 150 ants for 43,200 ticks.

## Contract guarantees

- Simulation parameters are immutable constants, and the code hash is published.
- Each seed commits to the first drand round published after its inputs close, and the contract checks that round's BLS signature on-chain.
- The colony chooses an index from a preset menu, never an amount, and every action has a hard cap.
- Advancing a run is permissionless.
- If no result arrives before the deadline, the contract runs the default action or skips the round.
- A guardian can pause the contract, and every use is logged.
- Events record seed, winner and hash so the pages can rebuild any run.

## Out of scope

NFTs, NEAR Intents payouts, TEE attestation, mainnet deployment, on-chain guest colonies, and an override multisig with a timelock.

## Known limits

- Seeds depend on drand being up. The call that draws a seed must carry that round's signature, so while drand is unreachable the seed waits, and an outage past the next 12:00 UTC loses that burn day.
- Burn days need callers. The Burn colony only moves when someone calls `crank_burn`; the team's keeper daemon does, and a day is lost if nobody calls for about a day.
- The colonies mostly echo the market with noise, so outputs are labelled "swarm belief" and are not calibrated probabilities.
