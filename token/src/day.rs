//! Burn days: one Burn colony run per UTC day, in two halves. From 00:00 UTC
//! staking is open; at 12:00 the Burn colony's stakes are frozen for the day
//! (and the seed is drawn); from 12:00 to 24:00 the colony runs `BURN_TICKS`
//! ticks, one a second; at 24:00 the burn executes. The web day clock in
//! `web/round.mjs` uses the same numbers. Times are milliseconds since the
//! Unix epoch (block timestamps); day `d` starts at `d * DAY_MS`.

use antosim::BURN_TICKS;

pub const DAY_MS: u64 = 86_400_000;
/// 00:00 to 12:00 UTC: the run takes the rest of the day at one tick a second.
pub const STAKING_MS: u64 = DAY_MS - BURN_TICKS as u64 * 1000;

/// When day `day`'s stakes freeze and its colony starts: 12:00 UTC.
pub fn run_at(day: u64) -> u64 {
    day * DAY_MS + STAKING_MS
}

/// When day `day`'s colony finishes and its burn may execute: 24:00 UTC.
pub fn end_at(day: u64) -> u64 {
    (day + 1) * DAY_MS
}

/// The newest day whose stakes have frozen (its 12:00 UTC has passed).
pub fn drawn_day(now: u64) -> Option<u64> {
    now.checked_sub(STAKING_MS).map(|t| t / DAY_MS)
}

/// True from 12:00 to 24:00 UTC, while that day's colony runs. Burn colony
/// stakes can't be withdrawn then; new ones count for the next day.
pub fn running(now: u64) -> bool {
    now % DAY_MS >= STAKING_MS
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn half_day_schedule() {
        assert_eq!(STAKING_MS, DAY_MS / 2);
        let d = 20_745; // 2026-10-19
        let noon = run_at(d);
        assert_eq!(noon, d * DAY_MS + 43_200_000);
        assert_eq!(end_at(d) - noon, BURN_TICKS as u64 * 1000);
        assert_eq!(drawn_day(noon - 1), Some(d - 1));
        assert_eq!(drawn_day(noon), Some(d));
        assert_eq!(drawn_day(end_at(d)), Some(d));
        assert_eq!(drawn_day(STAKING_MS - 1), None);
        assert!(!running(noon - 1) && running(noon) && running(end_at(d) - 1));
        assert!(!running(end_at(d)));
    }
}
