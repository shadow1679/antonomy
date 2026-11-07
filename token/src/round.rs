//! The round's forecast colonies, on-chain. Keepers post the trending market
//! (`market`), staking closes, the agents' window ends at `publish_at`, and
//! then anyone cranks: the first crank freezes the stake snapshot and the
//! agents' posts, draws the round seed, and each crank runs one forecaster
//! colony (Follower, Contrarian, Momentum, Community, Agents) of one market,
//! market by market. After the last colony the swarm belief and the market
//! hash are stored; both are the same functions the browser re-runs.
//!
//! Community reads this round's stakes on the market's colony, Agents the
//! frozen agent-odds snapshot, the other three the keepers' median odds. No
//! payouts: forecasts never pay for being right.
//!
//! Seed: sha256(tag, entropy, round, contract account). The contract passes
//! the randomness of the drand round first published after the round's
//! `publish_at`, checked on-chain (`contract/src/drand.rs`).

use crate::{
    agents::{AgentSnapshot, Agents},
    market::Market,
    request::ColonyRun,
    stake::Staking,
    Error,
};
use antosim::{
    colony_seed, forecast_run, market_result, sha256, voters, FORECAST_ANTS, FORECAST_TICKS, KINDS,
};

pub const SEED_TAG: &[u8] = b"ANTO-ROUND-SEED-v0";
pub const CRANKS_PER_MARKET: usize = KINDS.len();

/// One market of the round, with what its colonies read.
#[derive(Debug, Clone, PartialEq, Eq)]
#[cfg_attr(
    feature = "borsh",
    derive(borsh::BorshSerialize, borsh::BorshDeserialize, borsh::BorshSchema)
)]
pub struct RoundMarket {
    pub colony: u16,
    pub n_outcomes: u8,
    /// Stake weights of the market's colony (milli sqrt-tokens per outcome).
    pub weights: Vec<u32>,
    pub agents: AgentSnapshot,
    /// One per colony cranked so far, in `KINDS` order.
    pub runs: Vec<ColonyRun>,
    pub swarm: Option<Vec<u16>>,
    pub market_hash: Option<[u8; 32]>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
#[cfg_attr(
    feature = "borsh",
    derive(borsh::BorshSerialize, borsh::BorshDeserialize, borsh::BorshSchema)
)]
pub struct RoundRun {
    pub round: u64,
    pub seed: [u8; 32],
    /// Hash of the round's frozen stake snapshot, committed by every colony.
    pub stake_hash: [u8; 32],
    pub markets: Vec<RoundMarket>,
    pub done: bool,
}

/// What one crank did.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RoundCrank {
    pub market: usize,
    /// Index in `KINDS` of the colony this call ran.
    pub kind: usize,
    pub run_hash: [u8; 32],
    pub done: bool,
}

impl RoundRun {
    /// Freeze the round's inputs and draw the seed. `markets` are the
    /// finalized markets; staking must have closed.
    pub fn start(
        round: u64,
        now: u64,
        entropy: [u8; 32],
        contract: &str,
        markets: &[Market],
        staking: &Staking,
        agents: &mut Agents,
    ) -> Result<RoundRun, Error> {
        if markets.is_empty() {
            return Err(Error::NotCrankable);
        }
        let stake_hash = staking.snapshot(now)?.hash;
        let mut buf = SEED_TAG.to_vec();
        buf.extend_from_slice(&entropy);
        buf.extend_from_slice(&round.to_be_bytes());
        buf.extend_from_slice(contract.as_bytes());
        let seed = sha256(&buf);
        let markets = markets
            .iter()
            .map(|m| {
                let n = m.outcomes.len();
                RoundMarket {
                    colony: m.colony,
                    n_outcomes: n as u8,
                    weights: staking.sim_weights(m.colony, n),
                    agents: agents.freeze(m.colony, n),
                    runs: vec![],
                    swarm: None,
                    market_hash: None,
                }
            })
            .collect();
        Ok(RoundRun {
            round,
            seed,
            stake_hash,
            markets,
            done: false,
        })
    }

    /// Run the next colony. `markets` are the same finalized markets `start` got.
    pub fn crank(&mut self, who: &str, markets: &[Market]) -> Result<RoundCrank, Error> {
        if self.done {
            return Err(Error::NotCrankable);
        }
        let mi = self
            .markets
            .iter()
            .position(|m| m.runs.len() < CRANKS_PER_MARKET)
            .ok_or(Error::NotCrankable)?;
        let (rm, m) = (&mut self.markets[mi], &markets[mi]);
        let k = rm.runs.len();
        let kind = KINDS[k];
        let sim = forecast_run(
            &colony_seed(&self.seed, rm.colony, kind as u8),
            kind,
            &m.odds,
            &m.odds_6h,
            &rm.weights,
            self.stake_hash,
            &rm.agents.odds,
            rm.agents.hash,
            FORECAST_ANTS,
            FORECAST_TICKS,
        )
        .map_err(|_| Error::BadMarket)?;
        let run_hash = sim.hash;
        rm.runs.push(ColonyRun {
            hash: sim.hash,
            scores: sim.scores,
            perm: sim.perm,
            winner_source: sim.winner_source as u8,
            winner_option: sim.winner_option as u8,
            cranker: who.to_string(),
        });
        if rm.runs.len() == CRANKS_PER_MARKET {
            let counted = voters(&rm.weights, &rm.agents.odds);
            let out = market_result(
                rm.colony,
                rm.runs.iter().map(ColonyRun::sim).collect(),
                counted,
            )
            .map_err(|_| Error::BadMarket)?;
            rm.swarm = Some(out.swarm);
            rm.market_hash = Some(out.hash);
        }
        self.done = self.markets.iter().all(|m| m.market_hash.is_some());
        Ok(RoundCrank {
            market: mi,
            kind: k,
            run_hash,
            done: self.done,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::ledger::{Ledger, ONE};
    use crate::market::{MarketPost, Registry};
    use crate::stake::StakeConfig;
    use antosim::forecast_market;

    const CLOSE: u64 = 1_000;
    const PUBLISH: u64 = 2_000;

    fn market() -> Market {
        let post = MarketPost {
            market_id: "fed-decision".into(),
            outcomes: vec!["Cut".into(), "Hold".into(), "Hike".into()],
            odds: vec![6200, 2800, 1000],
            odds_6h: vec![5500, 3300, 1200],
            raw_hash: [7; 32],
        };
        let mut reg = Registry::new(vec!["k1.test".into()], 1, CLOSE).unwrap();
        reg.post(0, "k1.test", vec![post]).unwrap();
        reg.finalize(CLOSE).unwrap().to_vec().remove(0)
    }

    fn setup() -> (Ledger, Staking, Agents) {
        let mut l = Ledger::new("t", 10_000 * ONE);
        for a in ["a.test", "b.test", "ag.test"] {
            l.ft_transfer("t", a, 200 * ONE).unwrap();
        }
        let mut st = Staking::new(StakeConfig {
            cap_per_wallet: 100 * ONE,
            close_at: CLOSE,
            publish_at: PUBLISH,
        })
        .unwrap();
        st.stake(&mut l, 0, "a.test", 1, 2, 36 * ONE).unwrap();
        st.stake(&mut l, 0, "b.test", 1, 0, 9 * ONE).unwrap();
        let mut ag = Agents::default();
        ag.register(&mut l, "ag.test", 10 * ONE).unwrap();
        ag.post("ag.test", 1, 3, vec![2000, 3000, 5000]).unwrap();
        (l, st, ag)
    }

    #[test]
    fn five_cranks_equal_the_native_market() {
        let (_, st, mut ag) = setup();
        let m = market();
        let mut run =
            RoundRun::start(0, PUBLISH, [5; 32], "c.test", &[m.clone()], &st, &mut ag).unwrap();
        for i in 0..CRANKS_PER_MARKET {
            assert!(!run.done);
            let c = run.crank("cr.test", &[m.clone()]).unwrap();
            assert_eq!((c.market, c.kind), (0, i));
        }
        assert!(run.done);
        let rm = &run.markets[0];
        // Inputs: Community read the stakes, Agents the frozen post.
        assert!(rm.weights.iter().any(|&w| w > 0));
        assert_eq!(rm.agents.odds, vec![2000, 3000, 5000]);
        let native = forecast_market(
            &run.seed,
            rm.colony,
            &m.odds,
            &m.odds_6h,
            &rm.weights,
            run.stake_hash,
            &rm.agents.odds,
            rm.agents.hash,
            FORECAST_ANTS,
            FORECAST_TICKS,
        )
        .unwrap();
        assert_eq!(rm.market_hash, Some(native.hash));
        assert_eq!(rm.swarm.as_ref(), Some(&native.swarm));
        assert_eq!(run.crank("cr.test", &[m]), Err(Error::NotCrankable));
    }

    #[test]
    fn needs_staking_closed_and_freezes_agent_posts() {
        let (_, st, mut ag) = setup();
        let m = market();
        assert_eq!(
            RoundRun::start(0, CLOSE - 1, [5; 32], "c.test", &[m.clone()], &st, &mut ag).err(),
            Some(Error::StakingStillOpen)
        );
        RoundRun::start(0, CLOSE, [5; 32], "c.test", &[m], &st, &mut ag).unwrap();
        assert!(ag.posts_of(1).is_empty(), "posts are frozen out of the open set");
    }

    #[test]
    fn a_market_nobody_staked_or_posted_on_abstains() {
        let st = Staking::new(StakeConfig {
            cap_per_wallet: 100 * ONE,
            close_at: CLOSE,
            publish_at: PUBLISH,
        })
        .unwrap();
        let mut ag = Agents::default();
        let m = market();
        let mut run =
            RoundRun::start(3, PUBLISH, [1; 32], "c.test", &[m.clone()], &st, &mut ag).unwrap();
        while !run.done {
            run.crank("cr.test", &[m.clone()]).unwrap();
        }
        let rm = &run.markets[0];
        assert!(rm.weights.iter().all(|&w| w == 0));
        assert!(rm.agents.odds.iter().all(|&o| o == 0));
        assert!(rm.swarm.is_some());
    }

    #[test]
    fn reopen_refunds_forecast_stakes_and_keeps_burn_stakes() {
        let (mut l, mut st, _) = setup();
        let before = l.ft_balance_of("a.test");
        st.stake(&mut l, 0, "a.test", 0, 1, 5 * ONE).unwrap(); // Burn colony
        let refunds = st
            .reopen(
                &mut l,
                StakeConfig {
                    cap_per_wallet: 100 * ONE,
                    close_at: 5_000,
                    publish_at: 6_000,
                },
            )
            .unwrap();
        assert_eq!(
            refunds,
            vec![("a.test".to_string(), 36 * ONE), ("b.test".to_string(), 9 * ONE)]
        );
        assert_eq!(l.ft_balance_of("a.test"), before + 36 * ONE - 5 * ONE);
        assert_eq!(st.staked_by("a.test"), 5 * ONE, "Burn stake stays, counts to the cap");
        assert_eq!(st.staked_by("b.test"), 0);
        assert!(st.stakes_of("a.test").iter().all(|(c, _, _)| *c == 0));
        // The new round accepts stakes again.
        st.stake(&mut l, 5_000 - 1, "b.test", 1, 1, ONE).unwrap();
    }
}
