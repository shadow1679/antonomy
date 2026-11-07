# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Current state

Early implementation. The source of truth is `Ant Colony Oracle Design Document.md` (Draft v0.1, 23 Oct 2026). Code so far is the integer simulation in `sim/` (spec `ANTO-SIM-v1`: besides the seed it takes per-option richness from a stake snapshot or an odds snapshot, and commits both snapshot hashes in the result hash; `burn_run` and `forecast_run` are the entry points, and `forecast_market` runs a market's four forecasters on their own maps via `colony_seed` and returns trail shares, swarm belief and a market hash): `python/antosim.py` is the reference, `js/antosim.mjs` is the port (dependency-free, so it runs in Node and the browser; its `Colony` class steps one tick at a time for replay, and `run()` is a loop over it), `rust/` is the Rust port (dependency-free crate `antosim`, same `Colony`/`run` shape, the base for the contract), `contract/` is the near-sdk 5 contract that wraps `token/` (token views and transfer, staking, colony-gated burn, guardian pause, keeper-posted forecast markets; no `ft_transfer_call`, storage management or on-chain sim run yet; builds with `cargo near build non-reproducible-wasm`), `token/` is the `antotoken` crate (dependency-free apart from `antosim`'s sha256): NEP-141-shaped ledger, capped burn menu, square-root staking, the stake snapshot hash and the forecast market registry (`market.rs`: keeper allow-list, quorum of matching lists, median odds), with no NEAR SDK yet, `keeper/trending.py` is the stdlib-only keeper that picks the trending Polymarket market and prints `post_trending` args, and `tables.json` holds the shared cos/sin lookup tables (regenerate with `python3 -I sim/gen_tables.py`, which also rewrites `rust/src/tables.rs`). There is no contract or git history yet. Rust is installed but `~/.cargo/bin` isn't on PATH in every shell, so use `export PATH="$HOME/.cargo/bin:$PATH"`. NEAR tooling is installed (`cargo-near`, `near`, the `wasm32-unknown-unknown` target); no testnet account is set up yet. Coding before the 1 Nov build window opens is allowed: a NEAR Discord moderator confirmed it. Still disclose the pre-window work in the README.

Commands:
- Run one colony: `python3 -I sim/python/antosim.py <seed_int>`
- Python vs JS vs Rust hash agreement: `python3 -I sim/tests/crosscheck.py [count]`. Python takes about 1.5 s per seed, so for the 10,000-seed gate use `python3 -I sim/tests/crosscheck.py 10000 --no-py` (JS vs Rust only).
- Token logic tests: `cargo test --release --manifest-path token/Cargo.toml`. Stake weights reach the sim as `Staking::sim_weights` (milli sqrt-tokens per option), which `stake_richness` turns into per-option food richness.
- Contract tests: `cargo test --manifest-path contract/Cargo.toml`.
- Keeper: `python3 -I keeper/trending.py [--count N] [--save-raw DIR]` (live Polymarket read). Offline tests: `python3 -I keeper/test_trending.py`.
- Rust unit tests: `cargo test --release --manifest-path sim/rust/Cargo.toml`. One Rust colony: `sim/rust/target/release/dump <first_seed> <count>`.

UI uses the design system in `web/ds/` (plain CSS, dark only; see `docs/DESIGN_SYSTEM.md` for its rules: amber is reserved, options always show their glyph, forecasts carry `.tag-forecast`). Preview with `python3 -I -m http.server -d .` from the repo root and open `/web/ds/showcase.html`. The showcase imports `sim/js/antosim.mjs` directly, so the server must serve the repo root. The sim canvas is drawn by `web/ds/colony-view.mjs`, which only reads `Colony` state. Keep it that way: drawing must never call the sim RNG or change state.

Any change to sim behaviour must change Python and JS together and keep the crosscheck passing. The version string `ANTO-SIM-v1` is part of the hash, so bump it when the algorithm changes.

The project is **Antonomy ($ANTO)**. "Ant Colony Oracle" is the technical name of the mechanism. It targets the NEAR HACKATHON, with a build window of 1 to 14 November 2026 (UTC) on NEAR testnet. A browser prototype of the simulation exists as a Claude artifact (link in section 1 of the design doc). It is not in this directory.

Companion docs: `docs/FEATURES.md` (feature list with tracks and status) and `docs/HACKATHON_ROADMAP.md` (phases, milestone gates, cut order, submission checklist). The day-by-day schedule in the roadmap is a proposal. Only "measure gas on day 2" comes from the design doc.

## Architecture (from the design doc)

A public random seed drives a deterministic ant-colony simulation. Ants forage across a grid with 2 to 5 food sources, and each source stands for a preset option. The source with the strongest pheromone trail at the final tick wins. The ants add spectacle only. All entropy comes from the seed.

Pipeline: commit to a future drand round → close entries/stakes before it is published → seed = hash(drand randomness, request ID, contract address) → the contract runs the sim on-chain, a few ticks per permissionless call → after the final tick it computes winners and the decree hash and executes the capped action → anyone replays in the browser and compares the hash.

Core products, both built on one engine:
- **Burn colony**: picks the daily burn size from a fixed menu (0.10% to 2.00% of the treasury), hard-capped at 2% by the contract. Holder stakes steer it.
- **Forecast colonies**: for each Polymarket market, four colonies (Follower, Contrarian, Momentum, Community) read a keeper-posted odds snapshot as food richness. The average of their trail shares is the "swarm prediction". There is no treasury effect and no payouts.

Everything in sections 9 and 14 (raffles, treasury mix, custom colonies, extra ant types) is optional.

## Constraints that shape any implementation

- **Determinism is the product.** The Rust (on-chain), JavaScript (replay page) and Python (reference) implementations must produce identical result hashes across at least 10,000 seeds. Production code uses integer or fixed-point arithmetic only, with an integer PRNG, 16 or 32 discrete headings from a lookup table, no float, sin, cos or atan2, a fixed ant update order and a fixed tie-break (lowest index).
- **Gas bounds the design.** Use lazy evaporation (store the last-touched tick per cell and decay on read), so cost scales with ants and not with grid size. The per-transaction limit is 300 TGas. Ticks per call are unmeasured and must be measured on testnet first (day 2 of the build). Shrink ants, ticks or grid if a run doesn't fit.
- **Simulation parameters are immutable contract constants.** Prototype values: 72×48 grid, 150 ants, 800 ticks, 0.8% evaporation per tick, pheromone cap 20, score = pheromone within 6 cells of each source. Forecast colonies may shrink to about 60 ants and 300 ticks.
- **The colony chooses an index, never an amount.** Every action maps to a preset menu entry with a hard cap in the contract.
- **Seed → per-colony maps.** Each colony's map derives from the seed plus the colony's index. The seed also picks the map template and shuffles which option sits on which food source.
- **Fairness tests are required.** Each map template and each colony type needs at least 1,000 seeds. Every option must win close to its fair share, and none above about 30% for five options. The prototype's 100-seed test is only a smoke test.
- **Stakes.** One wallet budget across all colonies, square-root weighting, per-wallet caps. Staking closes before the drand round is published. The stake snapshot hash and the odds snapshot are both inputs to the sim, so the result is a pure function of seed, stakes and odds.
- **Forecast data trust.** Several keepers post independently and the contract takes the per-outcome median. Each snapshot stores a hash of the raw API response. The replay page can't call outside APIs and reads snapshots from the chain.
- **Safety and liveness.** Advancing is permissionless with a small bounty. A deadline triggers the default action or a skipped round. A multisig behind a timelock can pause or override, and every use is logged.

## Product rules to preserve

- Forecasts are not betting. No payouts for being right, no links to betting venues, and every output is labelled as a forecast and not advice. Exclude markets about violence, deaths or private individuals.
- The hackathon reward pool uses a play token on testnet only. No mainnet deployment.
- The README must state the known limits plainly: Sybil resistance is unsolved, the demo trusts the posted drand round, the reward pool resembles betting, and the prototype predates the build window.
- Before submission, re-read https://nearhackathon.com/HACKATHON.md, since rules and dates may change. The repo must be public before 14 Nov 2026 23:59 UTC, with a README written for AI judges.

## Open decisions (don't assume answers)

Section 12 of the design doc lists these as unresolved:
- Chain choice. The hackathon plan assumes NEAR.
- Markets per round that the gas budget allows. (For now `MAX_TRENDING = 1`; trending and keeper trust were decided on 2026-10-26, see `docs/FEATURES.md`.)
- The fee or deposit for user-added markets.
- Who runs and pays for the keeper.
- Which jurisdictions matter for the legal review.
- Whether the ticker $ANTO collides with an existing one. This hasn't been checked, and the name must be unique across the hackathon.
