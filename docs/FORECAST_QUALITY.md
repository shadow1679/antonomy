# The scorebook: how the swarm learns from results

The ant colonies read a market; the scorebook keeps them honest. When a market resolves, the contract scores every source that forecast it and uses those scores to weight the next forecasts. All of it runs on chain, by fixed integer formulas, and is committed in the result hashes, so a weighted forecast replays exactly like an unweighted one.

Five parts, all deployed on `antonomy-oracle.testnet`:

1. **Resolutions on chain.** Keepers post each market's state and end date under the same 2-of-3 quorum as the odds.
2. **Scorebook.** Every finished forecast is recorded per market. When the market resolves, every source is scored: the market's own odds, each colony, the swarm, each agent and each wallet.
3. **Agents commit, then reveal.** Agents post a hash of their odds first and the odds later, so no agent can copy another. The Agents colony reads a skill-weighted median.
4. **Adaptive colony weights.** The swarm belief is a weighted mean of the colonies' trail shares, with weights derived from the scorebook.
5. **Momentum with three windows.** Odds 1, 6 and 24 hours ago, with reversals and choppy paths damping the move.

## The question it answers

Momentum's food is mostly the market's own odds, agents can copy the market, and a stake is conviction, not skill. An equal average of three correlated colonies has no reason to beat the market. So every source is measured by **skill: the market's Brier score minus the source's, on the same forecasts.** A source that copies the market scores 0. Only information the market didn't already have scores above 0.

## Rules it keeps

- **Everything that weights the swarm is on chain and replayable.** Weights come from on-chain scores by integer formulas, are frozen before the colonies run, and are committed in the hash. Nothing is learned off chain.
- **Equal weights reproduce the unweighted results and hashes.** A weighted mean with equal weights is the floored mean, and the hashes append weights only when they differ, so every past round still verifies.
- **Scores change influence, never money.** Nobody is paid for being right. Agents are paid for posting on time.
- **Stored state keeps its layout.** All scorebook data lives under its own storage keys (`contract/src/book.rs`), so a code-only redeploy keeps every round, stake and balance.

## The record so far

From `score_tally` on 13 November 2026 (Brier summed over outcomes: 0 is perfect, 2 is certain and wrong):

| Source | Markets scored | Mean Brier | Market's Brier on the same markets | Skill |
| --- | ---: | ---: | ---: | ---: |
| Market odds | 166 | 0.342 | 0.342 | 0 |
| Momentum colony | 166 | 0.360 | 0.342 | −0.018 |
| Community colony | 123 | 0.538 | 0.339 | −0.199 |
| Agents colony | 144 | 0.368 | 0.334 | −0.034 |
| **Swarm belief** | 166 | 0.361 | 0.342 | **−0.019** |

Two more markets resolved 50-50 and are counted, not scored. **The market's own odds forecast best so far, and the contract acts on it:** every colony's weight has fallen to the floor of 250, so the three still count equally. On testnet most stakes and agent posts come from the team's scripted demo crew (follower and contrarian stakers; sharp, flat and noisy agents), so the Community and Agents rows mostly score that crew. The point is the mechanism: it is a public, on-chain record that any new signal (a sharper agent, a better-informed staker) has to beat before it gains weight.

Read it yourself:

```sh
near contract call-function as-read-only antonomy-oracle.testnet score_tally json-args {} network-config testnet now
```

## 1. Resolutions

`post_resolutions(list)`, keepers only. Each item has `market_id`, `state` (open, proposed, disputed, resolved, fifty_fifty), `winner` (the winning outcome's label when resolved, else empty), `end_ms` and `raw_hash` (a hash of the raw Polymarket response). A resolution is accepted when `quorum` keepers post the same (state, winner, end_ms). Once resolved or fifty_fifty is accepted, it is final.

`keeper/resolve.py` reads Polymarket for every market in `open_markets`; the daemon runs it every 30 minutes, posts what changed, then calls `score_market`.

Storage: `res-p:<market_id>` holds the keepers' posts, `res:<market_id>` the accepted resolution.

## 2. Scorebook

**Book:** one per (market id, outcome labels). A market whose labels change (for example "Other" regrouped) starts a new book. Key `bk:<sha256(market_id, labels)>`; `bk-ids:<market_id>` lists the books.

When a market's three colonies finish (in a round or a request), the book adds, per source and outcome, the running sum of p and of p², in basis points normalised to 10,000:

| Source | p |
| --- | --- |
| market | the keepers' median odds |
| momentum, community, agents | the colony's trail shares (Community and Agents only when they counted) |
| swarm | the swarm belief |

And per participant:

- **Agent** (`bk-a:<book><agent>`): sums of the agent's p and p², and of the market's p and p², over the same forecasts.
- **Wallet** (`bk-w:<book><wallet>`): per outcome, A = Σ √stake and B = Σ √stake × market odds.

**Time-averaged Brier.** Brier = Σₒ (pₒ − yₒ)², with y = 10,000 on the winner. Over a book's T forecasts it is exact from the sums: Σₒ (Σp²/T − 2·yₒ·Σp/T + yₒ²), in units of 1/10,000. A book's size stays fixed however many rounds the market ran in.

Each source is compared with the market's Brier **on the same forecasts** (`PairAcc`), because Community and Agents sit out some rounds.

**Scoring.** `score_market(market_id)` is permissionless once the resolution is final. Each book folds into:

- `sc-tally`: per source, books scored, Σ Brier and Σ skill; plus the 50-50 count and the void count (winner not among the labels and no "Other"). 50-50 and void books are counted, never scored.
- `sc-a:<agent>`: markets scored and Σ skill.
- `sc-w:<wallet>`: markets scored and Σ edge, where edge = Σₒ Aₒ·(yₒ − mₒ) / Σₒ Aₒ, above 0 when the wallet's sugar leaned towards what happened, beyond the market's price.

Views: `score_tally`, `agent_scores`, `wallet_score`, `resolution`, `resolutions`, `open_markets`.

## 3. Agents: commit, reveal, skill-weighted median

- `commit_forecast(colony, hash)` in the agents' window, before its reveal phase. hash = sha256("ANTO-COMMIT-v0", colony u16, odds u16 each, salt 32 bytes, account bytes), stored in `cm:<colony><account>`.
- `reveal_forecast(colony, odds, salt)` in the reveal phase, the window's last third. The contract checks the hash and stores the post. An unrevealed commit doesn't count. Reveals close before the drand round the seed uses is published, so nobody can see the seed and then decide whether to reveal. `agent_window(colony)` says which phase a window is in. A round's window runs from staking's close to the publish time; a request's is the 180 s before its `forecast_by`.
- **Agent weight** w = clamp(1000 + 5 × Σskill / (markets + 20), 250, 4000). A new agent has 1000. The prior of 20 markets keeps one lucky result from deciding: per-market skill swings by about ±0.2, so one good market (+0.14) lifts an agent to 1333, no further.
- **Weighted lower median** per outcome: sort the posts by value and take the first value where the weight so far, doubled, reaches the total. With equal weights it is the lower median.
- The agent snapshot hash appends each post's weight only when the weights differ. Weights are stored under `agw:<snapshot hash>` and shown by `agent_snapshot`.
- Tools: the daemon's agents and `bots/recruit.py post` derive the salt from a local secret (`$ANTO_AGENT_SECRET`, else `~/.antonomy/agent-secret`), so a restart can still reveal. The web app keeps a fresh salt in localStorage (`web/forecastpost.mjs`).

## 4. Adaptive colony weights

- Until `MIN_SCORED` (20) books are scored, every colony weighs 1000.
- After that, wₖ = clamp(1000 + 5 × Σskillₖ / (countₖ + 20), 250, 4000) for Momentum, Community and Agents (divisions truncate towards zero).
- Weights freeze when a round starts (`cw-r:<round>`) or a request starts its colonies (`cw-q:<id>`).
- Swarm belief per option = ⌊Σₖ wₖ·sₖₒ / Σₖ wₖ⌋ over the counted colonies; the remainder goes to the option with the largest weighted sum (lowest index on ties).
- The market hash appends the three weights (u16) only when they differ. Python, JavaScript and Rust implement it together, and the crosscheck covers both cases.

**Community wallets.** A wallet's √stake is scaled by m = clamp(1000 + Σedge / (2 × (markets + 20)), 500, 2000) / 1000 before the colony reads it (one stake at 0.3 that came true gives 1.166). New wallets keep 1. The square root and the per-wallet cap still limit concentrated wallets, and the scaled weights freeze with the round.

## 5. Momentum with three windows

Keepers also post the odds 1 h and 24 h ago (under `mx:` keys, so the stored market keeps its layout). Momentum's food per outcome is p + move, where:

- move = ⌊(Δ1h + 2·Δ6h + Δ24h) / 2⌋, halved when Δ1h and Δ24h point opposite ways (a reversal);
- the move is scaled by 10000 / (10000 + 4·chop), where chop is how far the path wandered beyond its net 24-hour change (the four prices' range less |Δ24h|), so a choppy path moves the food less.

With all three past odds equal this is the six-hour formula, odds + 2 × Δ6h, which a market posted without the extra windows uses. Keepers read all three windows from one price-history fetch per outcome (the last 26 hours at 10-minute points).

The odds snapshot hash uses the tag "ANTO-ODDS-v1" over all four windows only when the extra windows are present. The crosscheck covers Momentum and a whole market with them.

## Limits

- **Scores are only as honest as the resolutions.** Keepers post them under a 2-of-3 quorum with a hash of the raw response, so one keeper can't decide a result, but the keepers are trusted.
- **Agents can still withhold.** Commit and reveal stops copying, but an agent can see others' reveals and then not reveal (it then simply doesn't count).
- **Sybil resistance is a deposit only.** Skill weighting limits what a fresh copy can do (weight 1000, like any new agent), but an agent that copies the market is never pushed below 1000 either.
