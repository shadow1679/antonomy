//! The Burn colony's daily run, on-chain. One run per burn day (`day`): the
//! first `crank_burn` from 12:00 UTC draws the day's seed and starts the colony
//! from that day's frozen stake snapshot, and later cranks step it. A run may
//! start late, until the next day's 12:00, and then catches up to the clock,
//! so a day is only lost if nobody calls for a whole day. The colony
//! is clock-gated: tick `t` may run once `t` seconds have passed since 12:00,
//! so the stored run is never ahead of the day and its result (the winning
//! menu index) only exists once the last tick is in, at 24:00 UTC. Cranks step
//! at most `TICKS_PER_CALL` ticks, which keeps a call under the gas limit.
//!
//! This module holds the run's metadata. The colony itself (`antosim::Colony`,
//! about 15 KB) is kept by the caller as bytes, so a call that only reads
//! tokens doesn't load it.
//!
//! Seed: sha256(tag, entropy, day, contract account). The contract passes the
//! randomness of the drand round first published after the day's 12:00, so
//! starting late doesn't let the caller choose it.

use crate::{
    day,
    stake::{burn_weights, Snapshot},
    Error,
};
use antosim::{colony_seed, sha256, stake_richness, Colony, Commit, BURN_COLONY, BURN_TICKS, N_ANTS};

pub const SEED_TAG: &[u8] = b"ANTO-BURN-SEED-v0";
/// Most ticks one crank steps. Measured: 2,000 ticks cost up to 258 TGas, so
/// 1,500 leaves room under the 300 TGas limit.
pub const TICKS_PER_CALL: u32 = 1_500;

#[derive(Debug, Clone, PartialEq, Eq)]
#[cfg_attr(
    feature = "borsh",
    derive(borsh::BorshSerialize, borsh::BorshDeserialize, borsh::BorshSchema)
)]
pub struct BurnResult {
    pub hash: [u8; 32],
    pub winner_option: u8,
    pub winner_source: u8,
    pub scores: Vec<u32>,
    pub perm: Vec<u8>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
#[cfg_attr(
    feature = "borsh",
    derive(borsh::BorshSerialize, borsh::BorshDeserialize, borsh::BorshSchema)
)]
pub struct BurnRun {
    pub day: u64,
    /// The day seed. The colony's map seed is `colony_seed(seed, BURN_COLONY, 0)`.
    pub seed: [u8; 32],
    /// Hash of the day's frozen Burn colony stake snapshot.
    pub stake_hash: [u8; 32],
    /// Ticks run so far.
    pub t: u32,
    /// Set by the call that runs the last tick.
    pub result: Option<BurnResult>,
}

/// What one crank did.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct BurnCrank {
    pub steps: u32,
    pub done: bool,
}

impl BurnRun {
    pub fn is_done(&self) -> bool {
        self.result.is_some()
    }

    /// Draw the day's seed and build the colony at tick 0. `day` must be the
    /// newest drawn day at `now` (from its 12:00 UTC until the next day's);
    /// `snapshot` is that day's frozen Burn colony stakes.
    pub fn start(
        now: u64,
        entropy: [u8; 32],
        contract: &str,
        snapshot: &Snapshot,
        day: u64,
    ) -> Result<(BurnRun, Colony), Error> {
        if day::drawn_day(now) != Some(day) {
            return Err(Error::BurnNotRunning(day));
        }
        let mut buf = SEED_TAG.to_vec();
        buf.extend_from_slice(&entropy);
        buf.extend_from_slice(&day.to_be_bytes());
        buf.extend_from_slice(contract.as_bytes());
        let run = BurnRun {
            day,
            seed: sha256(&buf),
            stake_hash: snapshot.hash,
            t: 0,
            result: None,
        };
        let colony = run.colony(&burn_weights(&snapshot.entries))?;
        Ok((run, colony))
    }

    /// The colony at tick 0 for these stake weights (milli sqrt-tokens).
    pub fn colony(&self, weights: &[u32]) -> Result<Colony, Error> {
        let rich = stake_richness(weights).map_err(|_| Error::BadMarket)?;
        Colony::with_commit(
            &colony_seed(&self.seed, BURN_COLONY, 0),
            5,
            Some(&rich),
            Commit {
                stake_hash: self.stake_hash,
                odds_hash: [0; 32],
            },
            N_ANTS,
            BURN_TICKS,
        )
        .map_err(|_| Error::BadMarket)
    }

    /// Ticks the clock allows by `now`: one per second since the day's 12:00.
    pub fn allowed(&self, now: u64) -> u32 {
        let since = now.saturating_sub(day::run_at(self.day));
        (since / 1000).min(BURN_TICKS as u64) as u32
    }

    /// Step the colony up to the clock and `TICKS_PER_CALL`. Errors if the
    /// run is finished or the clock allows no new tick yet.
    pub fn advance(&mut self, colony: &mut Colony, now: u64) -> Result<BurnCrank, Error> {
        if self.is_done() {
            return Err(Error::NothingToCrank);
        }
        let target = self.allowed(now).min(self.t + TICKS_PER_CALL);
        if target <= self.t || colony.t != self.t {
            return Err(Error::NothingToCrank);
        }
        let steps = target - self.t;
        while colony.t < target {
            colony.step();
        }
        self.t = colony.t;
        if self.t == BURN_TICKS {
            let r = colony
                .result()
                .map_err(|_| Error::BurnNotFinished(self.day))?;
            self.result = Some(BurnResult {
                hash: r.hash,
                winner_option: r.winner_option as u8,
                winner_source: r.winner_source as u8,
                scores: r.scores,
                perm: r.perm,
            });
        }
        Ok(BurnCrank {
            steps,
            done: self.is_done(),
        })
    }

    /// The menu index the colony picked, once the last tick is in and the day
    /// is over (24:00 UTC).
    pub fn decision(&self, now: u64) -> Result<usize, Error> {
        let r = self
            .result
            .as_ref()
            .ok_or(Error::BurnNotFinished(self.day))?;
        if now < day::end_at(self.day) {
            return Err(Error::BurnDayNotOver(self.day));
        }
        Ok(r.winner_option as usize)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::ledger::{Ledger, ONE};
    use crate::stake::{StakeConfig, Staking};
    use antosim::burn_run;

    const D: u64 = 20_000;
    const NOON: u64 = D * day::DAY_MS + day::STAKING_MS;

    fn snapshot() -> Snapshot {
        // Two wallets on options 1 and 3, as the colony would see them.
        let mut l = Ledger::new("t", 1_000 * ONE);
        for a in ["a.test", "b.test"] {
            l.ft_transfer("t", a, 100 * ONE).unwrap();
        }
        let mut s = Staking::new(StakeConfig {
            cap_per_wallet: 100 * ONE,
            close_at: 10,
            publish_at: 20,
        })
        .unwrap();
        let t = D * day::DAY_MS;
        s.stake(&mut l, t, "a.test", 0, 1, 25 * ONE).unwrap();
        s.stake(&mut l, t, "b.test", 0, 3, 64 * ONE).unwrap();
        s.burn_snapshot(D, NOON).unwrap()
    }

    #[test]
    fn starts_from_noon_until_the_next_noon() {
        let snap = snapshot();
        for now in [NOON - 1, NOON + day::DAY_MS] {
            assert_eq!(
                BurnRun::start(now, [1; 32], "c.test", &snap, D).err(),
                Some(Error::BurnNotRunning(D))
            );
        }
        for now in [NOON, day::end_at(D), NOON + day::DAY_MS - 1] {
            assert!(BurnRun::start(now, [1; 32], "c.test", &snap, D).is_ok());
        }
    }

    #[test]
    fn a_late_start_catches_up_and_finishes() {
        let snap = snapshot();
        // Nobody called all day: started the next morning, every tick is due.
        let late = day::end_at(D) + 3_600_000;
        let (mut run, mut col) = BurnRun::start(late, [1; 32], "c.test", &snap, D).unwrap();
        assert_eq!(run.allowed(late), BURN_TICKS);
        let mut calls = 0;
        while !run.is_done() {
            run.advance(&mut col, late).unwrap();
            calls += 1;
        }
        assert_eq!(calls, BURN_TICKS.div_ceil(TICKS_PER_CALL));
        assert!(run.decision(late).is_ok());
    }

    #[test]
    fn the_clock_gates_the_ticks() {
        let snap = snapshot();
        let (mut run, mut col) = BurnRun::start(NOON, [1; 32], "c.test", &snap, D).unwrap();
        // Nothing to run at 12:00:00.999, one tick a second after.
        assert_eq!(run.advance(&mut col, NOON + 999), Err(Error::NothingToCrank));
        let c = run.advance(&mut col, NOON + 40_000).unwrap();
        assert_eq!((c.steps, run.t, c.done), (40, 40, false));
        // A catch-up call is capped at TICKS_PER_CALL.
        let c = run.advance(&mut col, NOON + 10_000_000).unwrap();
        assert_eq!(c.steps, TICKS_PER_CALL);
        assert_eq!(run.t, 40 + TICKS_PER_CALL);
        // No result, no decision.
        assert_eq!(run.decision(day::end_at(D)), Err(Error::BurnNotFinished(D)));
    }

    #[test]
    fn full_day_matches_the_one_shot_run_and_decides_after_midnight() {
        let snap = snapshot();
        let (mut run, mut col) = BurnRun::start(NOON, [9; 32], "c.test", &snap, D).unwrap();
        let end = day::end_at(D);
        let mut calls = 0;
        while !run.is_done() {
            run.advance(&mut col, end).unwrap();
            calls += 1;
        }
        assert_eq!(calls, BURN_TICKS.div_ceil(TICKS_PER_CALL));
        let native = burn_run(
            &colony_seed(&run.seed, BURN_COLONY, 0),
            &burn_weights(&snap.entries),
            snap.hash,
            N_ANTS,
            BURN_TICKS,
        )
        .unwrap();
        let r = run.result.clone().unwrap();
        assert_eq!(r.hash, native.hash);
        assert_eq!(r.winner_option, native.winner_option as u8);
        assert_eq!(run.decision(end - 1), Err(Error::BurnDayNotOver(D)));
        assert_eq!(run.decision(end), Ok(native.winner_option));
        assert_eq!(run.advance(&mut col, end), Err(Error::NothingToCrank));
    }

    #[test]
    fn the_colony_survives_storage_between_calls() {
        let snap = snapshot();
        let (mut run, mut col) = BurnRun::start(NOON, [3; 32], "c.test", &snap, D).unwrap();
        run.advance(&mut col, NOON + 100_000).unwrap();
        let mut stored = Colony::from_bytes(&col.to_bytes()).unwrap();
        let mut run2 = run.clone();
        run.advance(&mut col, NOON + 300_000).unwrap();
        run2.advance(&mut stored, NOON + 300_000).unwrap();
        assert_eq!(col.to_bytes(), stored.to_bytes());
        assert_eq!(run, run2);
    }
}
