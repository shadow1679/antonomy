# Forecast quality: a smarter swarm on the same sim

Written 2026-10-31. The ant colonies stay as they are. What changes is what they read and how their trail shares are combined. Five steps, in build order:

1. **Resolutions on chain.** Keepers post each market's state and end date under the same quorum as the odds.
2. **Scorebook.** Every finished forecast is recorded per market. When the market resolves, every source is scored: the market's own odds, each colony, the swarm, each agent and each wallet.
3. **Agents: hidden then shown.** Agents commit a hash of their odds, then reveal them after commits close, so nobody can copy another agent. The Agents colony reads a skill-weighted median.
4. **Adaptive colony weights.** The swarm belief is a weighted mean of the colonies' trail shares, with weights the contract derives from the scorebook.
5. **Momentum with three windows.** Odds 1 h, 6 h and 24 h ago, with volatility and reversals damping the move.

## The problem it answers

Momentum's food is mostly the market's own odds, agents can copy the market or each other, and stake is conviction, not skill. An equal average of three correlated colonies has no reason to score better than the market. So every source is measured by **skill: the market's Brier score minus the source's**, on the same forecasts. A source that copies the market scores 0. Only information beyond the market scores above 0.

## Rules this keeps

- **Everything that weights the swarm is on chain and replayable.** Weights come from on-chain scores by fixed integer formulas, are frozen before the colonies run, and are committed in the hash. Nothing is learned off chain.
- **Equal weights reproduce today's results and hashes.** A weighted mean with equal weights is the floored mean, and the hashes append weights only when they are not all equal, so every past round still verifies.
- **No payouts for being right.** Scores change influence, never money. Agents are still paid for posting on time.
- **Stored state keeps its layout.** All new data lives under its own storage keys, so code-only redeploys keep state (`live_state` test first).

## 1. Resolutions

`post_resolutions(list)`, keepers only. Each item: `market_id`, `state` (open, proposed, disputed, resolved, fifty_fifty), `winner` (the winning outcome's label when resolved, else empty), `end_ms`, `raw_hash`. A market's resolution is accepted when `quorum` keepers posted the same (state, winner, end_ms). Once resolved or fifty_fifty is accepted it is final.

Storage: `res-p:<market_id>` holds the keepers' posts and `res:<market_id>` the accepted resolution.

## 2. Scorebook

**Book**: one per (market_id, outcome labels); a market whose labels change (e.g. "Other" regrouped) starts a new book. Key `bk:<sha256(market_id, labels)>`, and `bk-ids:<market_id>` lists the books.

When a market's three colonies finish (a round or a request), the book records, per source, the running sum of p and of p² per outcome, all in basis points normalised to 10000:

| Source | p |
|---|---|
| market | the keepers' median odds, normalised |
| momentum, community, agents | the colony's trail shares (community and agents only when they counted) |
| swarm | the swarm belief |

The book also records, per participant:

- **Agent** (`bk-a:<book><agent>`): sums of the agent's p and p², and of the market's p and p², over the same forecasts.
- **Wallet** (`bk-w:<book><wallet>`): per outcome, A = Σ sqrt-stake and B = Σ sqrt-stake × market odds.

**Time-averaged Brier.** Brier = Σ_o (p_o − y_o)² with y the resolution (10000 on the winner). Averaged over a book's T forecasts it is exact from the sums: Σ_o (Σp²/T − 2·y_o·Σp/T + y_o²). Reported in units of 1/10000 of Brier (0 to 20000). So a book's size stays fixed however many rounds it ran in.

Every source is scored against the market's Brier on the same forecasts (`PairAcc`), since Community and Agents sit out some rounds.

**Scoring** (`score_market(market_id)`, permissionless, after the resolution is final; the daemon calls it). Each book is folded into:

- `sc-tally`: per source, books scored, Σ Brier and Σ skill (market Brier − source Brier, only where the source counted). Also books scored, the fifty_fifty count and the void count (winner not among the labels and no "Other"). 50-50 and void books are counted and set aside, never scored (as decided for the track record in docs/FORECAST_PAGE.md §5).
- `sc-a:<agent>`: markets scored and Σ skill.
- `sc-w:<wallet>`: markets scored and Σ edge, where edge = Σ_o A_o·(y_o − m_o) / Σ_o A_o (in basis points; above 0 when the wallet's sugar leaned towards what happened, beyond the market's price).

## 3. Agents: commit, reveal, skill-weighted median

- `commit_forecast(colony, hash)` while the agents' window is open and before its reveal phase. hash = sha256("ANTO-COMMIT-v0", colony u16, odds u16 each, salt 32 bytes, account bytes). Stored in `cm:<colony><account>`.
- `reveal_forecast(colony, odds, salt)` during the reveal phase, the window's last third (a round's window runs from staking's close to the publish time, a request's for `forecast_window` before its `forecast_by`). The contract checks the hash, then stores the post as before. An unrevealed commit doesn't count. Reveals end when the window ends, before the drand round the seed uses is published, so no one can see the seed and then decide whether to reveal. `agent_window(colony)` says which phase a window is in. `set_request_forecast_window` (contract account only) lengthens the request window, which was 60 s on testnet.
- `post_forecast` is retired (it panics with a pointer to the two calls).
- **Agent weight** w_a = clamp(1000 + 5 × Σskill / (markets + 20), 250, 4000); an agent with no record has 1000. One lucky market (skill +0.14) moves an agent to 1333, not further: per-market skill swings by about ±0.2, so the prior of 20 markets keeps one result from deciding.
- **Weighted lower median** per outcome: sort the posts by value and take the first value where the weight so far, doubled, reaches the total weight. With equal weights this is the lower median.
- The agent snapshot hash appends each post's weight (u16) only when the weights are not all equal. Weights are stored under `agw:<snapshot hash>` and shown in the snapshot view (`weights`).
- Tools: the daemon's agents and `bots/recruit.py post` derive the salt from a local secret ($ANTO_AGENT_SECRET, else `~/.antonomy/agent-secret`), so a restart can still reveal; the web keeps a fresh salt in localStorage (`web/forecastpost.mjs`).

## 4. Adaptive colony weights

- Until `MIN_SCORED` (20) books are scored, every colony weighs 1000.
- After that, w_k = clamp(1000 + 5 × Σskill_k / (count_k + 20), 250, 4000) for Momentum, Community and Agents (divisions truncate towards zero).
- Frozen when a round starts (`cw-r:<round>`) or a request starts its colonies (`cw-q:<id>`).
- Swarm belief per option = floor(Σ_k w_k·s_ko / Σ_k w_k) over the counted colonies; the remainder goes to the option with the largest weighted sum (lowest index on ties).
- The market hash appends the three weights (u16) only when the weights are not all equal. Python, JS and Rust change together; the crosscheck covers both cases.

**Community wallets.** A wallet's sqrt-stake is scaled by m = clamp(1000 + Σedge / (2 × (markets + 20)), 500, 2000) / 1000 (one stake at 0.3 that came true gives 1166) before the colony reads it. New wallets keep 1. Square root and the per-wallet cap still limit concentrated wallets. The scaled weights are frozen with the round, as before.

## 5. Momentum with three windows

Keepers also post the odds 1 h and 24 h ago (stored under `mx:` keys, so the stored market keeps its layout). Momentum's food per outcome is p + move, where:

- move = ⌊(Δ1h + 2·Δ6h + Δ24h) / 2⌋, halved (floor) when Δ1h and Δ24h point opposite ways (a reversal);
- the move is scaled by 10000 / (10000 + 4·chop), where chop is how far the path wandered beyond its net 24-hour change (the four prices' range less |Δ24h|), so a choppy path moves the food less.

With all three past odds equal this is the six-hour formula. Keepers read all three windows from one price-history fetch per outcome (the last 26 hours at 10-minute points); a market whose history doesn't reach back a day is posted without them. Staleness isn't modelled: the keepers read the odds when the round's list is posted.

This changes `odds_richness` in the three languages (`momentum_food`) and the odds snapshot hash, which uses the tag "ANTO-ODDS-v1" over all four windows only when the extra windows are present. The crosscheck covers Momentum and a whole market with them. The fairness harness runs markets without them, so its numbers are unchanged.

## Known limits (go in the README)

- Few trending markets resolve before judging (14 Nov 2026), and the colony weights stay equal until 20 books are scored. During judging the swarm runs on the equal prior; the mechanism and its tests are what can be checked.
- The scores are only as honest as the keepers' resolution posts (2 of 3).
- Sybil resistance for agents is still unsolved. Skill weighting limits what a fresh copy can do (weight 1000, the same as any new agent), but a copier of the market is never pushed below 1000 either.
