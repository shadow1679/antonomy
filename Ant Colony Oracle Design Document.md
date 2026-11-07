# Antonomy ($ANTO): Design Document

Draft v0.1 · 23 October 2026

## 1. Summary

The Ant Colony Oracle turns a public random seed into a verifiable, watchable decision. Digital ants forage across a map with five food sources, and each source stands for a preset option. The source with the strongest pheromone trail at the final tick wins. The simulation is a deterministic function of the seed, so anyone can re-run it and check the result, and the contract computes the result itself by running the simulation on-chain.

The ants add spectacle and a replayable story. They do not add entropy: all randomness comes from the seed source. A working prototype of the simulation is at https://claude.ai/artifact/FL3c2cR32WimU8FmcVPe1F.

**Project name:** Antonomy ($ANTO), autonomy with ants. Tagline: autonomy, but ants. The colony decides, you replay the math. The ticker has not been checked for collisions yet, and the name must be unique across the hackathon. Ant Colony Oracle remains the technical name of the mechanism.

**Main colonies.** Antonomy has two core products, and the forecasts lead (decided 26 October 2026). The **Forecast colonies** read the odds of the top 10 trending markets on Polymarket and publish swarm predictions, and users can add markets of their own. Holders feed the swarm by staking $ANTO on outcomes, which steers each market’s Community colony. The **Burn colony** sets the token’s daily burn size within a hard cap, steered by holder stakes. The other colonies (rewards, treasury mix, daily rule, charity, raffles and the rest of section 14) are optional and not part of the core.

## 2. Goals and non-goals

**Goals**

- A mechanism that is easy to explain in one sentence and fun to watch.
- Results that anyone can verify from the seed.
- Bounded outcomes: the contract caps the worst case of every decision.
- One reusable engine behind several products (treasury actions, tournament seeding, raffles, randomness as a service).

**Non-goals**

- Replacing low-latency VRFs. Results arrive in minutes to hours, not seconds.
- Producing better randomness than the underlying seed source.
- Unbounded governance. The colony picks from preset menus and never sets free-form amounts.
- Real-money wagering in version 1.

## 3. System overview

1. A request opens and commits to a future drand round that nobody can predict.
2. Entries, bets or inputs close before that round is published.
3. The round is published and becomes the seed.
4. The colony runs on-chain, a few ticks per call, and anyone can advance it.
5. After the final tick, the contract computes the winners and the decree hash.
6. Anyone can replay the run in the browser and compare the hash.
7. The contract finalizes the result and executes the capped action.

## 4. Simulation specification

The prototype uses the following parameters. All of them become immutable contract constants.

| Parameter | Prototype value |
| --- | --- |
| Grid | 72 × 48 cells, nest at the centre |
| Food sources | 5, placed 9 to 21 cells from the nest at seed-derived angles |
| Food richness | 0.7 to 1.3, derived from the seed |
| Ants | 150 |
| Ticks | 800 |
| Evaporation | 0.8% of every cell per tick |
| Pheromone cap | 20 per cell |
| Scoring | Sum of pheromone within 6 cells of each source at the final tick |
| Winner | Highest score, with ties broken by the lowest index |

**Ant behaviour.** A searching ant senses pheromone at three headings ahead of it, steers toward the strongest, and adds random wander. On reaching food it switches to returning, heads for the nest and deposits pheromone that weakens by 3% each step, so trails are strongest at the food. Shorter paths complete more round trips and build stronger trails.

**Changes required for production**

- Integer or fixed-point arithmetic only, with an integer PRNG that never converts to a float.
- 16 or 32 discrete headings with a lookup table instead of sine, cosine and atan2.
- Evaporation by shifts, and lazy evaporation (store the last-touched tick per cell and decay on read) so the cost depends on ants, not on grid size.
- A fixed ant update order and a fixed tie-break rule.
- Acceptance test: Rust, JavaScript and Python implementations produce identical result hashes across at least 10,000 seeds.

**Also required for forecasting.** The simulation must support 2 to 5 outcomes and take each outcome’s food richness as an input from the odds snapshot, instead of drawing it at random.

## 5. Map templates and fairness

A handful of map templates keeps the show varied without bloating the verifier: an open field, a wall with a gap, and a river with two crossings. The seed chooses the template and also shuffles which action sits on which food source, so no option is permanently disadvantaged by geometry.

Every template must pass a distribution test before launch: at least 1,000 seeds per template, with each option winning close to its fair share (20% for five options) and no option above roughly 30%. The prototype’s 100-seed test is a smoke test only.

An optional upgrade is to run three independent colonies and take the median of their chosen actions. Because the options are ordered, the median dampens chaotic outliers. Proving cost scales roughly linearly with the number of colonies.

The core runs two kinds of colony: one Burn colony, and a set of Forecast colonies for each market. Every colony has its own personality and its own map derived from the same seed. Every colony needs its own fairness test, since an option that always loses on one map would bias that decision.

### Main colonies

The Burn colony runs once per round. The Forecast colonies run for each market in the round, four forecasters per market (see section 15). Every round ends with one combined result hash.

| Colony | Decision | Menu | Contract cap | Personality |
| --- | --- | --- | --- | --- |
| Burn colony (Fire Ants) | Burn size | 0.10%, 0.25%, 0.50%, 1.00%, 2.00% of the treasury | 2% of the treasury | Wander 0.9, evaporation ×1.25, ants ×1.0 |
| Forecast colonies | Swarm prediction for one market | The market’s outcomes, 2 to 5 | No treasury effect: a forecast only | Four forecasters: Follower, Contrarian, Momentum and Community |

- Each colony’s map comes from the seed plus the colony’s index, so the maps differ but replay identically.
- One result hash per round combines the colony hashes, the stake snapshot and the market snapshot, so one hash identifies the whole round.
- Staking uses one wallet budget across all colonies. Influence grows with the square root of the stake, so spreading it costs influence. Stakes on the Burn colony sway the burn size, and stakes on a market sway only that market’s Community forecaster.
- The contract caps the burn at 2% of the treasury. Forecast colonies have no treasury effect, so the limit on them is the number of markets per round.
- Each colony type needs its own fairness test of at least 1,000 seeds, because map geometry can bias one menu without biasing the others.

## 6. Randomness source and timing

The seed is the hash of the drand round’s randomness, the request ID and the contract address. The round is committed before entries close, so neither the proposer nor the participants can influence it.

Once the round is public, anyone can re-run the simulation and know the result before it executes. This creates a front-running window. Mitigations: close all entries and bets before the round is published, keep the gap between publication and execution short, and cap every action.

## 7. Verification

**On-chain run.** The contract runs the simulation itself, a fixed number of ticks per call, and anyone can pay the gas to advance it. There is no prover, no verifier, no bond and no dispute window. The result is whatever the contract computes, and each colony’s state lives in contract storage between calls.

**What gets checked.** Each run starts from the committed drand round and the stake snapshot. The contract advances every colony through the fixed number of ticks, and only after the final tick does it compute the four winners and the decree hash and execute each capped action.

**Replay.** The browser replay runs the same integer-only code and compares its hash with the one stored on-chain. The contract, the JavaScript replay and a Python reference implementation must produce identical hashes, which is tested across thousands of seeds. In the first test, the JavaScript and Python versions produced identical hashes on all twelve runs, including runs with stakes.

**Gas cost.** In the reference implementation, one colony run (150 ants, 800 ticks) is 120,000 ant-steps, about 290,000 pheromone reads and about 175,000 random draws. The cost per call is not measured yet, because published figures for the cost per instruction disagree by orders of magnitude. Measure on testnet how many ticks fit in one call (the limit is 300 TGas per transaction), then work out the mainnet cost per run. Four colonies cost about four times one colony. On testnet, gas is paid with faucet tokens, so the demo costs nothing.

**Liveness.** The run only advances when someone pays gas to call it. Keep advancing permissionless with a small bounty, and set a deadline after which the contract runs the default action or skips the round.

**Trust.** The contract is the single source of truth, so a bug in it is a bug in the result. Audit the contract, and publish its source and code hash.

**Fallback.** If a full run does not fit in gas at an acceptable cost, shrink the grid, the ants or the ticks, or move to a zero-knowledge proof or an optimistic bond for the same simulation.

## 8. Contract design

- All simulation parameters are immutable, and the contract code hash is published.
- The drand round is committed before the request closes.
- Each food source maps to a preset action with a hard cap in the contract. The colony chooses an index and never an amount.
- Advancing the run is permissionless, with a small bounty for the caller, so a failed keeper cannot stall the system.
- If no valid result arrives before a deadline, the contract runs a default action or skips the round.
- A multisig behind a timelock can pause the colony or override a result in an emergency, and every use is logged.
- Events record the seed, template, winner and hash so the replay page can reconstruct every run.

**Market registry.** The contract keeps the list of markets for each round: the keeper-posted trending list plus community-added slots. Each entry stores the market ID, the outcomes, the odds snapshot and the hash of the raw API response.

## 9. Products built on the engine

Two products are core: the Burn colony and the Forecast colonies. Everything in this section and in section 14 is optional and builds on the same engine.

**Treasury decisions.** Burn size, the mix of burn, buyback and liquidity, a daily reward pool, and a weekly season modifier. All come from bounded menus. Larger decisions such as spending or upgrades stay with a multisig or governance process.

**Tournament seeding.** Teams or players map to food sources. The order in which the colony reaches them gives the bracket for five entrants, and larger brackets use a shuffle derived from the result hash. This is the lowest-risk product and the best first demo.

**Raffles and giveaways.** A Merkle root of the entrant list is committed before the round is known. The winner is the result hash reduced to the number of entrants, using rejection sampling to avoid modulo bias, and anyone can check it with a Merkle proof. The colony can pick the prize tier on screen. If entry costs money this may count as a lottery, so prefer free entry or sponsor-funded prizes.

**Randomness as a service.** Other contracts request a value and read the output when the proof lands. Each request gets its own value by hashing the batch result with the request ID. Latency is hours, so it suits airdrop selection, committee draws and seeding but not interactive use. The security comes entirely from drand and the verification layer, and the colony adds the spectacle. A winner among five options carries only about two bits, so the full hash is the real output.

**Other ideas.** Charity of the day, art generated from the colony’s trail, and a play-money ant-racing game.

## 10. Risks and mitigations

| Risk | Mitigation |
| --- | --- |
| Floating-point differences between machines | Integer port and cross-language hash tests |
| Seed manipulation | Pre-committed drand round |
| Front-running once the seed is public | Close entries first, short execution gap, caps |
| Biased outcomes from map geometry | Per-template fairness tests and seeded action shuffling |
| Whales steering the colony if holders can add pheromone | Not in version 1. If added later, use per-wallet caps and quadratic weighting |
| Keeper failure | Permissionless advancing, deadline and fallback action |
| Regulatory exposure (burns, raffles, betting) | Legal review per jurisdiction, free-entry raffles, play-money betting |
| Calling it an oracle without carrying information | Describe it as a verifiable colony until real data is encoded in the maps |
| Gas overruns | Measure ticks per call first, lazy evaporation, batch requests |

**Forecast colony risks.** A keeper could rank the trending list to favour chosen markets, so several keepers post independently and the lists must match. User-added markets could be spam or abusive, so they pass the same filters, carry a fee and share a fixed number of slots. Market outcomes can be ambiguous or disputed, so the leaderboard scores a market only after its resolution is final. Gas grows with the number of markets, and the data provider’s terms must be checked.

This document is not legal advice. Treasury mechanisms, raffles and betting products need review by a qualified lawyer before launch.

## 11. Roadmap

1. **Prototype (done).** Browser simulation with a seed, a fairness test and re-verification.
2. **Deterministic core.** Integer Rust port with lazy evaporation, plus cross-language hash tests and fairness tests for each map template.
3. **Testnet.** Contract that runs the simulation on-chain, drand commit and the tournament seeding demo with a replay page.
4. **Capped products.** Raffles and treasury actions on bounded menus.
5. **Gas measurement.** Measure how many ticks fit in one call on testnet, tune ants and ticks to fit, and benchmark the mainnet cost per run. Do this as soon as the integer port is done.
6. **Expansion.** Randomness as a service, and real data (volume, price drift, treasury state) encoded in the maps.

Forecast colonies slot in after the testnet contract: first one market with four forecasters, then the top 10 trending list, then user-added markets.

## 12. Open questions

- Is the primary goal a daily ritual, variety, or a signal that responds to real conditions?
- Which chain, given verification gas and prover costs?
- Which decision types go live first?
- Who runs the keeper or prover, and who pays for it?
- Which jurisdictions matter for the legal review?

* How exactly do we define trending, and which keepers are allowed to post the list?
* How many markets per round can we afford in gas?
* What fee or deposit should apply when a user adds a market?

## 13. Hackathon plan

Antonomy enters NEAR HACKATHON in three tracks with one project, built on testnet at zero cost during the build window of 1 to 14 November 2026 (UTC).

| Track | Why it fits | Feature that shows it |
| --- | --- | --- |
| Memecoins With Mechanics (main track) | The meme is the mechanic: the ants forecast and $ANTO feeds them. Holders stake on market outcomes to steer the Community forecaster, earn Brier-score reputation (never payouts), and steer the daily burn | Feed the swarm (pheromone staking) on the forecast colonies, then the Burn colony |
| AI Swarms | Many agents with competing preferences produce one collective decision | Scripted bot swarm that joins every round |
| Agent Economy | Agents spend tokens to stake and earn from a reward pool when their option wins | Bots with their own accounts and restricted keys |

The forecasting colonies in section 15 also fit the Investment Thesis track, which is judged on evidence that anyone can re-run.

**Core scope**

1. A NEP-141 token on NEAR testnet and a contract with a hard-capped burn menu for the Burn colony.
2. Pheromone staking: holders lock tokens to lay pheromone, with per-wallet caps and square-root weighting. Staking closes before the randomness round is published.
3. The integer-only Rust sim, supporting 2 to 5 outcomes. Its inputs are the seed, a hash of the stake snapshot and the odds snapshot, so the result is a pure function of all three and anyone can re-run it.
4. Forecast colonies: a keeper posts a snapshot of the top trending Polymarket markets (a few for the demo, up to 10 as gas allows), and four forecasters run on each.
5. A replay page with a verify-from-seed button, a swarm-versus-market table and a backtest.
6. Three or four scripted bots with different strategies (contrarian, follower, capped heavy staker) and a small play-token reward pool.

**Also in scope:** staker ants and the in-app colony sandbox from section 14.

**Stretch features** (only once the core loop works end to end, all free to run)

| Feature | Track | The meme | The tech it exposes |
| --- | --- | --- | --- |
| Drop sugar | Memecoins With Mechanics | Holders drop sugar on an option and its scent grows | Square-root stake weighting, and a stake snapshot hashed into the seed |
| Smell-o-vision | Memecoins With Mechanics | A toggle that shows the scent the ants are following | The pheromone field, deposit and evaporation rules |
| Check the receipts | Memecoins With Mechanics | One click re-runs the day and compares the result hash | Determinism: same seed and stakes, same answer |
| Ant autopsy | AI Swarms | Scrub the run tick by tick and follow any single ant | Fixed update order and bit-exact replay |
| Recruit an ant | AI Swarms, Agent Economy | A starter script so any agent joins a round with its own strategy and earns from the reward pool | The bot interface, per-wallet caps and reward accounting |
| Panic button | All | One account can freeze the colony | The pause method and the kill switch from section 8 |

**Zero-cost setup**

- NEAR testnet accounts and faucet tokens, which have no real value.
- A keeper script run locally or on a free scheduled CI job. It fetches a public drand round, posts it to the contract and advances the run call by call.
- A static replay page on free hosting, running the sim in the browser.
- Rule-based bots, with no paid LLM calls.
- The simulation runs on-chain on testnet, paid for with faucet tokens, so there are no proof or prover fees. Measure how many ticks fit in one call on day 2, and reduce ants or ticks if a full run needs too many calls. No mainnet deployment.

**Out of scope for the hackathon:** NFTs, NEAR Intents payouts, TEE attestation and randomness as a service. They stay on the roadmap.

**Submission checklist**

- Repository public before 14 November 2026, 23:59 UTC, with a README written for AI judges: what it is, the problem it solves, and do-X-see-Y steps.
- A public demo post on X, written and published by the team, saying the project was built at NEAR HACKATHON.
- One submission per team, with no edits afterwards. A mainnet NEAR account for prizes, created by the team.
- Re-read the live HACKATHON.md at https://nearhackathon.com/HACKATHON.md before submitting, since dates and rules may change.

**Known limits to state plainly in the README**

- Splitting stake across wallets to beat the quadratic weighting is not solved. Sybil resistance is future work.
- In the demo the contract trusts the posted drand round. Full on-chain verification is future work.
- The reward pool resembles prediction betting. It uses a play token on testnet, and a real launch needs legal review.
- The prototype and this design predate the build window. Ask in the NEAR Discord whether earlier prototypes are allowed, and disclose it in the README either way.

## 14. Colony catalogue, ant types and custom colonies

Every colony and ant type below is part of the design. Each one is a parameter or a preset menu with a cap, so the verification model stays the same.

The two main colonies are in section 5. The colonies from the earlier prototype, Leafcutters (staker rewards), Army Ants (treasury mix) and Weaver Ants (today’s rule), are optional colonies in this catalogue, along with the ones below.

### More colonies

| Colony | Decision | Menu | Why it fits |
| --- | --- | --- | --- |
| Harvester Ants | Grant or charity of the day | A human-vetted shortlist of recipients | The most understandable serious decision. Fits Real-World Money and Social Money |
| Raffle colony | Prize tier or finalist | Entrants fixed before the seed is known | The cleanest use of a verifiable pick. Check gambling rules first |
| Fee colony | Trading fee within a narrow band | A few preset fee levels | A real economic lever with a small cap |
| Risk-dial colony | How aggressive the day is | Conservative, normal, aggressive | Scales the caps of the other colonies. The most interesting design, and it needs strict combined caps |

### New ant types

| Ant type | Behavior | What it exposes |
| --- | --- | --- |
| Staker ants | Each wallet’s stake spawns ants tinted in that wallet’s colour | Square-root weighting and per-wallet caps, visible on the map |
| Agent ants | The bots from the swarm plan get their own coloured ants | The AI Swarms and Agent Economy tracks |
| Scouts and workers | Scouts wander widely and workers follow trails. The mix is the colony’s personality | Explore versus exploit |
| Soldier ants | Lay a repellent trail on options flagged unsafe, a second pheromone type that works as a soft veto | Fits the security angle, but adds rules to the sim and the proof |
| Seeded weather | Rain or drought changes evaporation for a day. An environment effect, not an ant type | The evaporation parameter |

### Custom colonies

**Stage 1: sandbox in the app.** Anyone names a colony, writes five options, picks a personality and runs it in the browser, with a shareable seed link. It is free to build and to run, and no chain is involved.

**Stage 2: guest colonies on-chain.** A creator picks a template, a bounded menu, a cap and a cadence. The engine stays the same verified program and only the parameters change, so the proof is not rebuilt. Guardrails:

- An automated fairness test on at least 1,000 seeds before listing.
- A creator bond and a fee.
- Caps enforced by the contract.
- An allowlist at first.
- No access to the main treasury without governance approval.

Risks: spam menus, biased maps, brand abuse, and the legal exposure of custom raffles or betting.

### Build order

Staker ants and the in-app sandbox come first, for the hackathon. The remaining colonies and ant types are added one at a time, and guest colonies on-chain follow once the sandbox has proven the template.

## 15. Forecasting colonies

A forecasting colony takes the current odds of a prediction market as its map and publishes a swarm prediction. It is a forecast display and not a betting product: nobody stakes money on the outcome through Antonomy, and holders are not paid for being right.

### How it works

1. A keeper reads the market’s odds from the public Polymarket API, whose Gamma market data needs no authentication, and posts a snapshot on-chain at the start of each round. The snapshot holds each outcome’s odds in basis points and the odds from six hours earlier.
2. The snapshot sets each outcome’s food richness, so a likelier outcome is a richer food source.
3. Four colonies run on the same snapshot, each reading it differently (see the table).
4. Each colony’s trail share per outcome is its forecast. The swarm prediction is the average of the four shares, shown next to the market odds.
5. After the market resolves, each colony is scored with a Brier score and the results go on a public leaderboard.

| Colony | Reads the odds as | Food richness |
| --- | --- | --- |
| Follower | Trusting the market | Taken directly from the odds |
| Contrarian | The crowd is overconfident | Taken from (10000 − odds) / 4, so underdogs are richer |
| Momentum | Follow how the odds moved | The odds plus twice the change over six hours, floored at 2% and renormalised |
| Community | Follow holder stakes | A flat base boosted by the square root of the stake on each outcome |

### What it adds, honestly

The colonies read the market’s own odds, so they mostly echo the market with noise. In the first sample backtest (eight made-up markets, so the numbers mean nothing yet) the market’s own odds scored best with a Brier score of 0.535. The four colonies scored between 0.66 and 0.82, and the swarm average scored 0.725, against 0.80 for a flat guess. One cause is that trail share is compressed toward even odds. In one example run, the Follower gave a 5% outcome about 17%.

The planned fix is to calibrate trail shares, for example with a power transform fitted on resolved markets, before showing them as probabilities. Until then they are labelled swarm belief. The value of the feature is a transparent, replayable method, a public track record, and the disagreement among the colonies. To carry extra information, the Community colony needs real holder stakes, and other colonies can read other sources, such as the same question on another prediction market.

### Which markets run

- **Top 10 trending.** A keeper lists active markets on Polymarket sorted by 24-hour trading volume, applies the filters below and posts the first 10. Third-party tools commonly define trending this way, sometimes with a minimum volume, so confirm the exact sort parameter in the official docs. Several keepers post independently, and the contract requires their lists to match.
- **Filters.** No markets about violence, deaths or private individuals. A minimum volume and liquidity. A resolution date within a set window. Two to five outcomes, and for events with more, keep the four most likely and group the rest as Other.
- **User-added markets.** Anyone can submit a Polymarket market link or ID for a community slot. It must pass the same filters, the submitter pays the gas to run it, and a small fee or deposit (to be decided) discourages spam. A fixed number of community slots per round, for example five, keeps gas bounded.
- **Cadence.** The top 10 list refreshes on a fixed schedule, to be decided. Markets that fall out of the top 10 stop running, and their scores stay on the leaderboard.

### Scaling on-chain

At the prototype’s size, ten markets with four forecasters each is 40 colony runs of about 120,000 ant-steps, nearly 4.8 million ant-steps per round, plus the Burn colony. The gas cost is not measured yet, but this is likely too heavy to run on-chain every few minutes. Options, in the order to try them:

1. Shrink the forecasting colonies. At 60 ants and 300 ticks a run is about 18,000 ant-steps, roughly 6.7 times fewer, and 40 runs come to about 720,000.
2. Stagger the markets, so a few run each round and the full list rotates.
3. Run only the Follower and Momentum colonies on all ten markets, and the other two on the top three.
4. For forecast colonies only, fall back to the proof or optimistic path described in section 7.

Measure ticks per call first, then pick.

### Outcome counts

The first simulation has a fixed five food sources. Many markets are plain Yes or No questions with two outcomes, and some events have more than five. The simulation must support 2 to 5 outcomes. The leaderboard reads the final result from the market after it resolves.

### Data and trust

- The data comes from read-only public endpoints. The data provider’s terms of use for display and redistribution have not been checked and must be before launch.
- The keeper’s snapshot is a trusted input. Several keepers post independently, the contract takes the median per outcome, and each snapshot stores a hash of the raw API response.
- The published replay page cannot call outside APIs, so it reads each snapshot from the chain.
- Fast-moving markets can re-run every few minutes, with every run committed on-chain.

### Rules

- No payouts for being right. Stakes sway only the Community colony, and rewards are limited to reputation and the leaderboard.
- Do not link to places where people can bet, and label every output as a forecast and not advice.
- Avoid markets about violence, deaths and private individuals.
- Get legal review before launch. A forecast display is a lighter product than a betting market, but it is not risk-free.
