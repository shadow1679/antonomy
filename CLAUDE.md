# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

**Antonomy ($ANTO)**; "Ant Colony Oracle" is the mechanism's technical name. Ant colonies forecast trending Polymarket markets on-chain from a public random seed, $ANTO holders drop sugar (stake) on outcomes, and anyone can replay any run in a browser and check the hash. It targets the NEAR HACKATHON (build window 19 October to 14 November 2026 UTC, on NEAR testnet; the submission form opens 1 November). The main track is Memecoins With Mechanics.

`README.md` is the public overview, written for the hackathon's AI judges; keep it in step with what is built and with its known limits. `docs/FEATURES.md` is the feature list. `docs/DESIGN_SYSTEM.md` has the UI rules.

Still open before submission: making the repo public (before 14 Nov 2026 23:59 UTC), the team's demo post on X, a mainnet NEAR account for prizes, and a ticker check against the hackathon's other submissions. Re-read https://nearhackathon.com/HACKATHON.md before submitting.

## Layout

- `sim/`: the integer simulation, spec `ANTO-SIM-v1`. `python/antosim.py` is the reference, `js/antosim.mjs` the dependency-free port (its `Colony` steps one tick at a time), `rust/` the dependency-free crate `antosim` the contract builds on. `burn_run` and `forecast_run` are the entry points; `forecast_market` runs a market's three forecasters (Momentum, Community, Agents) on their own maps via `colony_seed`. `tables.json` holds the shared cos/sin tables (regenerate with `python3 -I sim/gen_tables.py`, which also rewrites `rust/src/tables.rs`). `gasbench/` is a bench contract, not the product contract.
- `token/`: the `antotoken` crate, no NEAR SDK. Ledger, daily pot menu (`burn.rs`), square-root staking, stake snapshot hash, forecast market registry (`market.rs`), reward payout (`reward.rs`), Recruit the swarm requests (`request.rs`), forecaster agents (`agents.rs`), the Burn colony's on-chain run (`burnrun.rs`), the round's forecast colonies (`round.rs`), burn-day schedule (`day.rs`), randomness (`random.rs`).
- `contract/`: the near-sdk 5 contract wrapping `token/`. NEP-141 with `ft_transfer_call`, NEP-145 (storage is free), staking, the daily pot, guardian pause, keeper-posted markets, rounds, Recruit the swarm, a once-per-account faucet, drand-checked seeds (`drand.rs`, BLS12-381 host functions through `near-sys`) and the randomness service. `new` is `#[init(ignore_state)] #[private]`. Builds with `cargo near build non-reproducible-wasm`.
- `keeper/`: `daemon.py` makes every call nobody else is making (`--agent <acct>` also claims the faucet and posts the chain's own median odds as a baseline forecaster); `trending.py` picks the trending Polymarket markets (or reads one requested market); `demo.py` plans the demo crew (stakers, extra agents with their own odds, a Recruit requester) that the daemon runs with `--staker`, `--demo-agent` and `--requester`; `demo_setup.sh` creates and funds those accounts.
- `bots/`: `swarm.py` is the Burn-colony bot swarm; `recruit.py` is Recruit the swarm's agent tool (CLI plus an MCP server).
- `web/`: the app, no build step (see below).
- `docs/make_demo.mjs` writes `docs/demo-colony.svg`, the demo colony in the README (seed 42), from the JS sim. If sim behaviour changes, rerun it and update the hash and scores the README quotes (also the one-minute hash in "Try it in five minutes").

## Architecture

A public random seed drives a deterministic ant-colony simulation. Ants forage across a grid with 2 to 5 food sources, and each source stands for a preset option. The source with the most pheromone trail over the run wins: the trail near each source is summed every `SCORE_EVERY` (100) ticks and at the final tick. The ants add spectacle only. All entropy comes from the seed.

Pipeline: commit to a future drand round → close entries and stakes before it is published → seed = hash(drand randomness, request ID, contract address) → the contract runs the sim on-chain, a few ticks per permissionless call → after the final tick it computes winners and the hash and executes the capped action → anyone replays in the browser and compares the hash.

Products, all on one engine:

- **Forecast colonies** (headline): for each Polymarket market, three colonies run on their own maps. Momentum reads a keeper-posted odds snapshot (the odds plus twice their six-hour change), Community reads $ANTO stakes, and Agents reads the forecaster agents' median odds. The average of their trail shares is the swarm belief; a colony with no input sits out of the average. No treasury effect, no payouts.
- **Drop sugar**: staking $ANTO on an outcome or pot size, square-root weighted, with per-wallet caps and one wallet budget.
- **Burn colony**: picks the daily pot size from a fixed menu (0.10% to 2.00% of the treasury, capped at 2%). Part of the pot (0.08% to 0.16% of the treasury) is paid to the stakers on the picked size and the rest burns. The sim handicaps bigger pots (`burn_richness`, `BURN_HANDICAP`). Staking is open 00:00 to 12:00 UTC, the colony runs `BURN_TICKS` (43,200) from 12:00 to 24:00, `execute_burn(day, index)` runs from 24:00. Burn stakes lock until every day they count for has paid.
- **Recruit the swarm**: anyone pays a $ANTO fee for a forecast on a Polymarket market. Keepers post odds, forecaster agents post their own odds into the Agents colony, crankers run the colonies; all are paid from the fee for work, never for being right. Agents use `ask_swarm` / `post_forecast` / `verify`.
- **Randomness as a service**: `request_randomness` burns a small fee and commits to a drand round; anyone proves it with `fulfill_randomness`.

Everything else (raffles, treasury mix, custom colonies, extra ant types, the override multisig and timelock) is out of scope.

## Constraints

- **Determinism is the product.** Rust (on-chain), JavaScript (browser) and Python (reference) must produce identical result hashes across at least 10,000 seeds. Production code is integer or fixed-point only, with an integer PRNG, 16 or 32 discrete headings from a lookup table, no float, sin, cos or atan2, a fixed ant update order and a fixed tie-break (lowest index).
- **Any change to sim behaviour changes Python and JS together and keeps the crosscheck passing.** The version string `ANTO-SIM-v1` is part of the hash. Nothing on testnet depends on old results, so algorithm changes keep `v1` and update the reference values.
- **Gas bounds the design.** Lazy evaporation (last-touched tick per cell, decay on read), so cost scales with ants, not grid size. Limit 300 TGas per transaction.
- **Simulation parameters are immutable contract constants:** 72×48 grid, 150 ants, 800 ticks, 0.8% evaporation per tick, pheromone cap 20, score = pheromone within 6 cells of each source. Stake richness 0.35 to 1.3 with a flat base of 2.5 sqrt-tokens per option; odds richness 0 to 1.3 in proportion. Forecast colonies use 60 ants and 300 ticks. A trail fades to 0 after `FADE_TICKS` (852).
- **The colony chooses an index, never an amount.** Every action maps to a preset menu entry with a hard cap in the contract.
- **Seed → per-colony maps.** Each colony's map derives from the seed plus the colony's index; the seed also picks the map template and shuffles which option sits on which food source.
- **Fairness tests.** Each map template and colony type needs at least 1,000 seeds; every option must win close to its fair share, none above about 30% for five options.
- **Forecast data trust.** Several keepers post independently and the contract takes the per-outcome median under a quorum. Each snapshot stores a hash of the raw API response. Web pages read forecast inputs from the chain, never from outside APIs (the Recruit page's market search is the one exception).
- **Safety and liveness.** Advancing is permissionless with a small bounty. A deadline triggers the default action or a skipped round. A guardian can pause.

## Product rules

- Forecasts are not betting. No payouts for being right, no links to betting venues, and every output is labelled a forecast and not advice. Exclude markets about violence, deaths or private individuals. Trail shares are labelled "swarm belief" and never shown as probabilities.
- Burn rewards use a play token on testnet only. No mainnet deployment.
- The README must state the known limits plainly: seeds wait on drand being reachable (the contract checks drand's signature on-chain, so it trusts drand's network, not a keeper), and a Burn day is lost if nobody cranks it for about a day (the team's daemon does).
- The ticker is $ANTO. Amounts on every page are labelled $ANTO.

## Commands

- Run one colony: `python3 -I sim/python/antosim.py <seed_int>`
- Python vs JS vs Rust hash agreement: `python3 -I sim/tests/crosscheck.py [count]`. Python takes about 1.5 s per seed, so for the 10,000-seed gate use `... 10000 --no-py` (JS vs Rust only). Add `--day` for the Burn colony's daily run (use small counts).
- Fairness harness: `cargo run --release --manifest-path sim/rust/Cargo.toml --bin fairness -- [--check] [--quick] [--seeds N] [--days N] [--first N] [--only TEXT]` (about 2 min for 1,000 seeds and 1,000 Burn days; `--quick` is a smoke test that can fail the Burn gates on noise).
- Rust sim tests: `cargo test --release --manifest-path sim/rust/Cargo.toml`. One Rust colony: `sim/rust/target/release/dump <first_seed> <count>`.
- Token tests: `cargo test --release --manifest-path token/Cargo.toml`.
- Contract tests: `cargo test --manifest-path contract/Cargo.toml`.
- Web tests: `node web/test_<name>.mjs` (offline, canned contract JSON).
- Daemon: `python3 -I keeper/daemon.py --contract <c> --keeper <acct> [--keeper <acct>...] --cranker <acct> [--once] [--interval 60] [--send]` (dry run unless `--send`; offline tests `python3 -I keeper/test_daemon.py`). `--network` repeats as fallbacks. Burn cranks need 300 TGas prepaid and about 0.02 NEAR each, ~30 a day, so keep the cranker funded. `keeper/launchd.sh install|uninstall|status` runs it as a macOS LaunchAgent (log `~/Library/Logs/antonomy-daemon.log`; `ANTO_KEEPERS`, `ANTO_NETWORKS`).
- Demo crew (testnet, unattended): `keeper/demo_setup.sh --send` once creates the persona accounts and funds them (NEAR from the cranker, $ANTO from the treasury; never NEAR from the contract account, which is mostly locked storage). `launchd.sh install` then runs the daemon with `--staker acct[:follower|contrarian|mixed]`, `--demo-agent acct[:sharp|flat|noisy]` and `--requester acct [--recruit-max 2 --recruit-gap MINUTES]`, so stakes, agent posts, cranks and two Recruit requests happen on their own. The personas burn gas (roughly 0.1 to 0.4 NEAR a day each): re-run `demo_setup.sh --send` to top them up, and the requester stops after `--recruit-max` requests. Tests: `python3 -I keeper/test_demo.py`.
- Keeper: `python3 -I keeper/trending.py [--count N] [--save-raw DIR]`; on request: `--request ID --market SLUG`. Tests: `python3 -I keeper/test_trending.py`.
- Bots: `python3 -I bots/swarm.py --contract <c> --bot follower=<acct> --bot contrarian=<acct> --bot heavy=<acct> --bot echo=<acct> [--withdraw] [--send]`. Tests: `python3 -I bots/test_swarm.py`.
- Agent tool: `python3 -I bots/recruit.py ask|register|post|crank|verify|mcp --contract <c> [--account <acct>] [--market SLUG] [--request ID] [--odds 6000,3000,1000] [--wait] [--crank] [--send]`. Tests: `python3 -I bots/test_recruit.py`.
- Gas bench (local NEAR sandbox, separate crate): `cargo near build non-reproducible-wasm --manifest-path sim/gasbench/Cargo.toml`, then `cargo test --release --manifest-path sim/gasbench/runner/Cargo.toml -- --nocapture`. Add `--ignored` for the Burn day run; `--test request|ft|round|random|e2e` run the product contract end to end (build `contract/` first). The Burn colony only runs 12:00 to 24:00 UTC on the real clock, so its gas is measured on testnet.
- Rust is installed but `~/.cargo/bin` isn't on PATH in every shell: `export PATH="$HOME/.cargo/bin:$PATH"`. NEAR tooling (`cargo-near`, `near`, the wasm32 target) is installed.

## Testnet

- The product contract is `antonomy-oracle.testnet` (key in the macOS keychain), with sub-accounts `treasury`, `keeper`, `keeper2`, `keeper3`, `agent`, `requester` and `cranker`. Three keepers at quorum 2; treasury and guardian are `treasury.antonomy-oracle.testnet`. The daemon runs as a LaunchAgent and signs through `testnet-drpc` then `testnet-fastnear` (every near.org and fastnear RPC shares one per-IP rate limit). If the CLI's default `testnet` RPC is down, use `network-config testnet-fastnear`.
- **Redeploying with `new` wipes all state** (rounds, requests, balances; the supply returns to 1,000,000), so do it deliberately, and update `GENESIS_SUPPLY` in `web/token.mjs` (the chip's burned = `GENESIS_SUPPLY` − `ft_total_supply`). Init args are in `/tmp/anto-deploy/init-args.json`.
- A code-only redeploy (`near contract deploy ... without-init-call`) keeps state as long as the `Contract` struct is unchanged. Before one, save the raw `STATE` value from RPC `view_state` to a file and run `ANTO_STATE=<file> cargo test --manifest-path contract/Cargo.toml -- --ignored live_state`, which must decode it and write back the same bytes. Keep a copy of the deployed wasm to roll back (`/tmp/anto-deploy/`).
- The daily pot rewards, handicap and burn-stake lock were deployed on 2026-10-29 at about 06:55 UTC (code-only, state kept) and apply from burn day 20755; `HANDICAP_FROM_DAY` in `web/burn.mjs` is 20755, and earlier days replay with plain `stake_richness`. The wasm from before is `/tmp/anto-deploy/deployed-before-1793256894.wasm`, the new one `deployed-2026-10-29-pot-rewards.wasm`.

## Web app

No build step. Serve the repo root (`python3 -I -m http.server -d .`) and open `/web/`. Every page reads the live contract through `web/chain.mjs` (JSON-RPC `view()`, typed `chain.*` readers, `wallet` = `@hot-labs/near-connect`, `ensureTokens()` claims faucet tokens on first use; `?contract=<account>` overrides the contract id; testnet only). The browser re-runs colonies from the chain's inputs with `sim/js/antosim.mjs` and compares with the chain's hashes. The top bar (`topbar()`, `mountWallet()` in `web/ui.mjs`) carries the wallet button, a status strip and the $ANTO chip (`web/token.mjs`).

- `index.html`: landing page (the current round's market, what the colonies do, a first-five-minutes tour, two ways in).
- `live.html` (own look in `live.css`, scoped to `body.lv`): the main page. A round bar from `round_status`, the round's markets as cards, requested forecasts, today's burn. `market.html?m=<key>` is the market page (`m<i>` this round, `p<i>` the previous). `lv.mjs` holds what both share; `roundchain.mjs` is the round adapter.
- `burn.html`: the Burn page (day strip and colony, daily pot from `daily_pot`, drop-sugar preview in `sugar.mjs`, past pots from the nearblocks indexer, folded token facts). `burn.mjs` is the pure day clock and pot maths, `burnchain.mjs` the loader and wallet writes.
- `recruit.html`: Recruit the swarm (market search in `polymarket.mjs`, the request followed from the chain, `recruit.mjs` pure helpers, `agents.mjs` the agent-odds snapshot).
- `replay.html` (replays a round, burn day or request; ant autopsy in `autopsy.mjs`), `receipts.html`, `random.html` (`random.mjs`), `docs.html`.
- `autocrank.mjs`: an off-by-default box that sends each due crank through the connected wallet. `drand.mjs` adds the committed beacon to seed-drawing cranks. `fixtures.mjs` is for offline tests only.

UI uses the design system in `web/ds/` (plain CSS, dark only; amber is reserved, options always show their glyph, forecasts carry `.tag-forecast`). Preview at `/web/ds/showcase.html`. The sim canvas is drawn by `web/ds/colony-view.mjs`, which only reads `Colony` state: drawing must never call the sim RNG or change state.
