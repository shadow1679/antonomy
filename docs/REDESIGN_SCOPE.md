# UI redesign: scope and flows

Written 2026-10-29, before the redesign starts, from the pages in `web/` and the contract as deployed. "Step 2" below means the screen inventory.

## 1. Users

| Rank on first screen | User | What the first screen must give them | Wallet | Time they'll give it |
|---|---|---|---|---|
| 1 | **Forecast watcher** | A real market, the swarm belief next to the market odds, and the three colonies | No | 30 to 90 s |
| 2 | **Holder** | Proof the token does something (burned so far, today's pot) and one click to "drop sugar" | Yes, later | Minutes, daily |
| 3 | **Bot builder** | A link to the CLI and MCP tool, and the fact that the fee pays for work | Sometimes | Goes straight to Docs or Recruit |
| (scenario) | **Judge** | Checked against every rank above: no wallet, 3 minutes, may only read the HTML text | No | 3 min |

### Conflicts

- **Judge vs everyone: animation vs text.** The ants are only spectacle, but nearly every claim is filled in by JS. Read as raw HTML, `index.html` shows "Reading the chain…" and "…" placeholders. Its one hard-coded fact is wrong: `index.html:24` says "Forecasters per market 5", but there are 3.
- **Watcher vs product rules.** Watchers want a probability. The rules forbid showing the swarm belief as one, so the layout must let them compare belief and odds without implying they are the same kind of number.
- **Holder vs Watcher on what leads.** The track is *Memecoins With Mechanics*, so the token mechanic is what gets judged. CLAUDE.md makes forecasts the headline. A forecast-only first screen buries the track's core.
- **Holder vs Holder: one budget for everything.** `cap_per_wallet` is 100 $ANTO, and a single `wallet_total` covers market, Burn and request stakes (`token/src/stake.rs`). A locked Burn stake quietly shrinks what you can stake on a market, and the market page says "X of 100 $ANTO **this round**" (`web/market.html`, `stakeBody`).
- **Holder vs Bot builder: the faucet doesn't cover both.** The faucet gives 150 $ANTO once and a Recruit request costs 100. A new user who stakes up to the cap can't afford a request, and there's no second faucet claim.
- **Alignment:** an AI judge and a bot builder want the same thing: copyable text, hashes and commands. Serve one and you serve both.

### Recommendation

Make the first screen a live market result with its verification written out in text, for the Watcher and the Judge scenario. Put a strip with the token's state ($ANTO burned, today's pot, "drop sugar") above the fold for the Holder. Point bot builders to Docs and Recruit with a single link. Everything on the first screen must make sense with JS off.

## 2. Screen inventory

| Screen | User | Purpose | Priority |
|---|---|---|---|
| Landing `index.html` | Watcher, Judge | Say what this is, route to Live | P0 (candidate to merge into Live) |
| Live `live.html` | Watcher | Round bar, market cards, requested forecasts, today's burn | P0 |
| Market `market.html` | Watcher, Holder | Belief vs odds, three colonies, verified table, stake or post odds | P0 |
| Burn `pot.html` | Holder | Day clock, pot menu, stake with a with/without preview, past pots | P0 |
| Top bar (wallet, status strip, $ANTO chip) | Holder | Connect, balance, faucet, chain status | P0 (global) |
| History `replay.html` | Judge, Bot builder | Every past round (with the requests made in it) and pot; open one to scrub ticks, follow an ant and check its hashes (§5) | P1 |
| Recruit `recruit.html` | Bot builder | Request, follow it on chain, payouts | P1 |
| Docs `docs.html` | Bot builder, Judge | How it works, CLI/MCP commands | P1 |
| ~~Receipts `receipts.html`~~ | Judge | Re-check a JSON receipt | Merged into History (§5); the file redirects |
| Random `random.html` | Bot builder | Randomness service | P2 (deployed, not yet tried on testnet) |

P0: on the Judge's 3-minute path or the Holder's core loop.

## 3. Flows

### (a) First visit to first understanding, no wallet

1. The visitor arrives from the README, an X post or a judge's link. **Decision:** is JS running?
   - ✗ No JS, or an AI reading HTML: they see the hero text, a wrong "5" and placeholders. They leave with a claim and no evidence.
2. The hero states the claim. "Watch the live colonies" goes to Live.
3. Live reads `round_status`. **Decision by phase:**
   - `posting` (the first 20 min of a ~25 min round): this round has no result yet. Show the last finished round (`round.shown` already falls back to it), labelled as the previous round.
   - `agents`, `ready` or `running`: the colonies animate and the result is still to come.
   - `done`: the result is shown.
   - ✗ `skipped` (no keeper quorum): there are no markets and nothing explains why.
   - ✗ RPC failure or rate limit (every near.org and fastnear endpoint shares one per-IP limit): there is no clear error state, so placeholders stay forever.
4. The visitor opens a market card. The market page shows the swarm belief next to the odds and the three colonies on one stage.
5. **Aha:** the "Verified in your browser" rows turn to ✓ match. Your machine recomputed the hash the contract stored. A second aha is seeing the three lenses disagree.
6. They leave for Replay (watch it tick by tick) or Docs.

### (b) Stake to steer the Burn

1. The holder opens Burn. **Decision on UTC time:**
   - 00:00–12:00: staking is open.
   - 12:00–24:00: the colony runs. A new stake counts **from tomorrow**, and withdrawals are locked.
   - After 24:00, before `execute_burn`: the page waits for the payout.
2. Connect a wallet.
   - ✗ No testnet wallet, wrong network, or the user rejects: they need a clear way back.
3. On first use, `ensureTokens()` claims the 150 $ANTO faucet.
   - ✗ Already claimed and balance 0: dead end. There is no other way to get play tokens.
4. Pick a pot size (glyph, % of treasury, reward part, handicap).
5. Set the amount. The readout shows the stake, √ weight and cap used. **Decision:** the existing `wallet_total` across **all** colonies plus this stake must stay ≤ 100.
   - ✗ Over the cap: the contract's `WalletCap` error fires. The UI must show the remaining budget across colonies, not per page.
   - The square-root rule needs a plain line: 25 → 5, 100 → 10, so 4× the stake gives 2× the weight.
6. Optional preview runs the colony with and without your stake in the browser.
   - **Aha:** your tinted ants shift the scent. It must say that the real seed isn't drawn until 12:00, so the real map will differ.
7. Sign the stake.
   - ✗ Transaction rejected or RPC error.
   - ✗ The clock crossed 12:00 between page load and signing: the stake silently counts from tomorrow, so the confirmation must name the day.
8. At 12:00 the stakes freeze into the day's snapshot. The seed comes from the drand round published after 12:00, carried in by the first crank.
   - ✗ Nobody cranks, or drand is unreachable: the state is "waiting".
9. From 12:00 to 24:00 the colony runs and the leading pot size changes.
10. `execute_burn` runs. **Decision:**
    - Your size won: you get your share of the reward part, and the rest burns.
    - Your size lost: nothing is paid, and the stake keeps counting for later days.
11. Withdraw, only outside 12:00–24:00 and after every day the stake counts for has paid.
    - ✗ A day was lost because nobody cranked for about a day. **Open question:** does the lock ever clear in that case?

On a market the same panel applies, with `close_at` (staking closes) then `publish_at` 5 min later. Market stakes are refunded when the next round starts.

### (c) Follow a round from committed to finalized

1. `start_round` opens round N. Keepers post odds, and `finalize_markets` accepts a market when at least 2 of 3 keepers agree. The phase is `posting` and staking is open.
   - ✗ No quorum by `publish_at`: the phase becomes `skipped`, and the next `start_round` moves on.
2. At `close_at` staking closes. The phase is `agents`, and agents post odds for 5 min.
3. At `publish_at` the phase is `ready`. **Committed:** the seed is bound to drand round `round_after(publish_at)`, a value nobody knows yet.
   - ✗ drand is unreachable: the round sits in `ready` (a known limit).
4. The first `crank_round` carries the drand signature. The contract checks the BLS signature, freezes stakes and agent posts, and draws the seed. The phase is `running`.
   - **Aha:** "Seed from drand round #R, signature checked on-chain. Nobody picked it."
5. Each crank runs one colony, 3 per market, up to 36 for 12 markets.
   - ✗ No cranker: progress stalls. The daemon and the autocrank box are the fallback.
6. `done`: the swarm belief and market hash are stored per market. This is finalized.
7. The next round starts and market stakes are refunded.

### (d) Verify from seed

1. **Entry:**
   - Automatically, from the market page's table.
   - Deliberately, from History: pick a row and its colony, or check the whole round, or paste someone else's receipt (§5).
   - Off the page: `bots/recruit.py verify` and `antosim.py 42`.
2. Pick what to check: a round, burn day or request, then a colony.
3. The page loads the inputs from the chain: seed, colony seed, stake snapshot, odds and agent snapshots.
4. The browser runs the sim. A forecast colony is 300 ticks and finishes quickly. A Burn day is 43,200 ticks and needs a progress bar.
5. **Decision: compare the hashes.**
   - **Match:** **Aha:** the browser computed the same 64 hex characters the contract stored. Show them in text, copyable, next to the CLI command.
   - No chain hash yet: this is pending (today "○ not cranked yet"), not a mismatch.
   - **Mismatch:** today the page only shows "✗ mismatch" or "N hashes differ". The likely causes:
     - a pre-handicap Burn day (before day 20755);
     - the wrong `?contract=`;
     - a partial RPC read;
     - a real divergence, which means a bug or tampering.

     None of these is diagnosed today, and there is no "which input differs" view and no way to report it.

### States and screens the flows reveal that step 2 lacks

1. **A text-first, no-JS first screen** with a fixed, checkable example (for instance round 4's market hash from the README).
2. **A global "chain unreachable or rate-limited" state.**
3. **A "skipped round" explanation** and a **"ready: waiting for drand round #R"** state, including drand being down.
4. **A seed commit and draw step** in the round bar. Today it goes Staking → Agents post → Crank → Colonies run → Result, and the seed is never shown as its own moment.
5. **A "Your sugar" view of the wallet:** one budget across market, Burn and request stakes, with what is locked where, when it unlocks or is refunded, and the remaining cap.
6. **Faucet already used, no balance:** a dead-end state.
7. **Burn states:** "counts from tomorrow", "withdraw locked until …", "day lost".
8. **The holder's payout result:** won X $ANTO, Y burned, or your size lost.
9. **Mismatch diagnosis:** which input or hash differs, a CLI command to reproduce it, and how to report it.
10. **Progress for long replays** (a whole Burn day).

## 4. The three decisions that shape the rest

1. **Is the front door a brochure or a live result?** Recommended: the live result. Merge the landing hero into Live, with server-readable text and the token strip above the fold. This decides the navigation, whether `index.html` survives, and how the Judge scenario is met.
2. **Is verification a page, or a property of every result?** Recommended: a property. Every result card carries "✓ verified in your browser · 3/3 hashes" in text, Replay is the single place to drill down (Receipts folds into it), and mismatch gets a real diagnosis state. This shapes every card and table, and how many pages there are.
3. **Is staking per page, or one wallet budget?** Recommended: one "Your sugar" surface, opened from the top bar and shared by Burn, markets and requests. The 100 $ANTO cap is shared and Burn locks reach into market staking, so per-page panels will keep misleading people. This shapes the Holder's whole loop and the top bar.

## 5. History: Replay and Receipts as one page

Decided 2026-10-30. Replay and Receipts merge into one page, and that page is also the history of past rounds and pots. Requested forecasts (Recruit) are listed inside the round they were made in, not on their own. There is no separate History page next to Replay: both would be "list past things, open one, check it".

### Why

- **Receipts adds one thing Replay lacks:** it re-runs every colony of a round at once and compares every hash, after you edit the receipt or paste someone else's. That fits on Replay as a panel.
- **Replay can't reach the past.** It loads the current round and `last_round` only (`roundOf`, `web/replay.html:160`) and today's Burn run only (`load()`: "the chain holds one burn run at a time"). Pot's Receipts link to `replay.html?colony=burn&day=…` for days Replay can't open. A history list is what makes old rounds and days replayable, so the list and the player belong on one page.
- One nav item fewer: Live · Pot · Recruit │ History │ Docs.

### The page

The file stays `replay.html` so existing links keep working. Nav label "History". Title: "Every run, from its seed."

1. **The list**, first. Two tabs: Rounds and Pots (`.tabs`, picked by the hash: `#rounds`, `#pots`). A ledger table, newest first, grouped by UTC day.
   - Round row: round number, time, its markets (titles, glyphs), seed shortened, colonies run (36 / 36), "skipped · no quorum" for a skipped round. Under the markets, the requests made while the round was open: "Request #12 · {market}", with their own status (a request runs on its own clock, so it can still be running after its round ends). A skipped round still lists its requests.
   - Pot row: day, the pot size picked, burned and shared, seed, result hash, or "lost · nobody cranked".
   - Rows show the chain's facts only. A row is checked when it is opened; running every colony of every row on load is too much work (one round is up to 36 colonies of 300 ticks plus 3 per request; one pot is 43,200 ticks).
2. **The workbench**, under the list once a row is open. Today's Replay unchanged: player, trail share, ant autopsy, staker ants. The colony picker lists only the opened row's colonies: for a round, one group per market, then one per request.
3. **Check the whole round** (what Receipts does now), beside the workbench for a round: re-run every colony, the requests' included, compare every hash, ✓ / ✗ counts and time. The receipt JSON gains a `requests` list (id, seed, colony hashes, market hash). Folded under it: "Check someone else's receipt", the JSON textarea, upload and edit.

URLs: `?round=N` and `?day=D` open that row; `?request=ID` opens the round it was made in with that request's colonies picked. All keep `&colony=`, `&ant=` and `&t=` as today. `receipts.html?round=N` redirects to `replay.html?round=N#check`, the way `random.html` redirects to Recruit. `docs.html#receipts` moves to the History section of Docs.

### Where each list comes from

| Rows | What the chain keeps | Past rows from |
|---|---|---|
| Pots | One `burn_run` at a time | `loadHistory` / `burnRow` in `web/burnchain.mjs` (indexer list of `execute_burn` and paying `crank_burn` calls, then archival reads at the block before), as Pot's past pots already do. The row carries seed, stake snapshot and result hash, which is all a replay needs |
| Rounds | The current round and `last_round` only | **New.** The indexer lists `start_round` transactions. A `start_round` that ends a finished round moves it into `last_round`, so `viewAt(height, "last_round")` at its receipt block gives that round's markets and run (`run.round` is its id). After a skipped round `last_round` doesn't change, so dedupe by `run.round`; the missing ids in between are skipped rounds |
| Requests, inside rounds | Every request (`forecast_requests(from_id, limit)`, up to 50 a page) | The chain directly. Each goes under the round open when it was made: `created_at_ms` falls between that round's `start_round` and the next one's (the indexer gives each transaction's time). The current round: from its `start_round` on |

- The indexer returns no logs (see `indexerCrankPayouts`), which is why each round is read from the chain at a block rather than parsed from `EVENT round_market`.
- A round runs about every 25 minutes, about 58 a day. Page the list by UTC day, 50 indexer rows at a time, and read the archive only for rows on screen. Cache each finished round in `localStorage` like burn rows: a finished round never changes.
- Archival reads share the per-IP RPC rate limit. A failed read leaves the row with the indexer's facts and a retry, never a blank page.
- The round loader is the same one the track record's scorer needs for past markets (`docs/FORECAST_PAGE.md` §9), so build it as a module both use (`histchain.mjs`, pure parsing in a tested layer, canned indexer and RPC JSON in `test_history.mjs`).

### What changes elsewhere

- Live: "Previous round" and the timeline's receipts link go to `replay.html?round=N`; "Burn history" goes to `replay.html#pots`.
- Pot: keeps its short Receipts and Your days (last 14 days); "All days" goes to `replay.html#pots`, and its Verify from seed now opens past days.
- Recruit: the request history stays as it is; each row still opens the market page, and the market page's Verify links to `replay.html?request=ID` (its round, request picked).
- README, `docs/FEATURES.md`, CLAUDE.md's web section: Receipts is gone, History is described.

### Build order

1. The round history loader, with requests filed under their rounds, and its tests.
2. Replay opens any round (with its requests) or pot from a history row (past rounds from the loader, past days from `burnRow`).
3. The list with its two tabs.
4. Receipts' whole-round check and paste panel move in; `receipts.html` redirects.
5. Nav, links on Live and Pot, docs.

### Open questions

- How far back the indexer reaches on its free tier, and whether a deep list needs a keeper-written archive instead.
- Name: "History" (what you find there) or "Verify" (what you do there). Going with History.

### As built (2026-10-30)

Built in the order above: `web/histchain.mjs` (tests `web/test_history.mjs`), `replay.html` as History, `receipts.mjs` with requests in the receipt, `receipts.html` redirecting, and the nav, Live, Pot, Landing, Docs and README links. Where it differs from the plan:

- **No indexer.** The nearblocks testnet index stopped in late September 2026 (it lists 0 transactions for the contract), so neither the round list nor Pot's past pots can come from it. History walks the contract's own state at past blocks on archival RPCs instead. A round's `close_at_ms` less `round_config().stake_ms` is when the round before it ended, so that round is read with `round_status` 30 s before then, about 3 reads a round; if its run looks unfinished there, `last_round` one round later has the finished copy. Round ids restart on a redeploy with `new`, so the walk stops where they stop counting down.
- **Pots without the payout block.** Finding the exact `execute_burn` block took 40 or more reads a day by bisection. Instead each day is read at 23:55 UTC (stake snapshot, treasury, `last_burn_day`) and at 11:30 the next day (its finished run), about 5 reads a day. Burned and shared are therefore the menu's amounts at the 23:55 treasury, marked ≈, a few tokens from what the payout used. Days that `last_burn_day` jumped over are listed as lost.
- **Rate limits.** fastnear's and near.org's archival nodes share one per-IP limit (roughly 30 reads a minute). Reads go one at a time, spaced, and back off on a 429; rows appear as they are read, and finished rows are cached in localStorage.
- **Pot** uses the same walk for its last 14 days, its receipts and Your days, with All days linking to `replay.html#pots`.
- The receipt's `requests` entries are `{ id, seed, colonies: [hash…], market }`.
- With nothing asked for, History opens the newest round with a seed, so the workbench is never empty on arrival.
- **Rounds show their results.** A round carries a dozen markets, so the list gives each round a head line and a row per market (and request) with its result: the outcome the chain's swarm belief leads on, the market's odds for it and the gap. Each round folds to its head line (folded by default, except the opened round). The lists page (eight rounds or seven days a page) instead of Show older; Older reads the next page from the archive if it isn't cached. An opened round shows its markets' results first, outcome by outcome, each with buttons to replay its three colonies, then the workbench.

## Known issues to fix along the way

- `web/index.html:24` says "Forecasters per market 5"; there are 3.
- The market page's "Staked X of 100 $ANTO this round" counts Burn and request stakes too.
- Open question: whether a Burn stake's lock clears when a day is lost.
