//! Burn days: one Burn colony run per UTC day, in two halves. From 00:00 UTC
//! staking is open; at 12:00 the Burn colony's stakes are frozen for the day
//! (and the seed is drawn); from 12:00 to 24:00 the colony runs `BURN_TICKS`
//! ticks, one a second; at 24:00 the burn executes. The web day clock in
//! `web/round.mjs` uses the same numbers. Times are milliseconds since the
//! Unix epoch (block timestamps); day `d` starts at `d * DAY_MS`.
//!
//! Burn stakes lock for a day (`burn_stake_locked`): a wallet's Burn colony
//! stakes can't be withdrawn until the pot of every day they count for has
//! been paid. A stake counts from `stake_day`, so one placed before 12:00 is
//! locked until that night's pot pays, and one placed after 12:00 until the
//! next day's.

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

/// The first day a Burn stake placed at `now` counts for: today before
/// 12:00 UTC, tomorrow from 12:00.
pub fn stake_day(now: u64) -> u64 {
    drawn_day(now).map_or(0, |d| d + 1)
}

/// True while a wallet's Burn stakes are locked. `paid_to` is the newest day
/// whose pot has been paid, `lock` the newest day the wallet's stakes were
/// placed for (`stake_day` of its last Burn stake). Locked until the pot of
/// the later of that day and the newest drawn day has paid: the drawn day's
/// snapshot holds every stake placed before its 12:00. Escape hatch: once the
/// oldest unpaid pot is a day overdue (24:00 the day after it was due), the
/// stakes unlock anyway, so a stalled or paused colony can't trap them.
pub fn burn_stake_locked(now: u64, paid_to: Option<u64>, lock: Option<u64>) -> bool {
    let Some(need) = drawn_day(now).max(lock) else {
        return false;
    };
    if paid_to.is_some_and(|p| p >= need) {
        return false;
    }
    let oldest_unpaid = paid_to.map_or(lock.unwrap_or(need), |p| p + 1);
    now < end_at(oldest_unpaid) + DAY_MS
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

    #[test]
    fn stakes_count_from_today_before_noon_and_tomorrow_after() {
        let d = 20_745;
        let h = |x: u64| d * DAY_MS + x * 3_600_000;
        assert_eq!(stake_day(h(0)), d);
        assert_eq!(stake_day(h(11)), d);
        assert_eq!(stake_day(h(12)), d + 1);
        assert_eq!(stake_day(h(23)), d + 1);
        assert_eq!(stake_day(0), 0);
    }

    #[test]
    fn burn_stakes_lock_until_their_days_pot_pays() {
        let d = 20_745;
        let h = |x: u64| d * DAY_MS + x * 3_600_000;
        // Staked at 09:00 for today: locked from then, with yesterday paid.
        let lock = Some(d);
        assert!(burn_stake_locked(h(9), Some(d - 1), lock));
        assert!(burn_stake_locked(h(18), Some(d - 1), lock));
        // After 24:00 until today's pot pays.
        assert!(burn_stake_locked(h(25), Some(d - 1), lock));
        assert!(!burn_stake_locked(h(25), Some(d), lock));
        // Old stakes are free in the morning once yesterday's pot has paid ...
        assert!(!burn_stake_locked(h(9), Some(d - 1), Some(d - 5)));
        assert!(burn_stake_locked(h(9), Some(d - 2), Some(d - 5)));
        // ... and locked again from 12:00, when today's snapshot holds them.
        assert!(burn_stake_locked(h(12), Some(d - 1), Some(d - 5)));
        // A stake after 12:00 waits for tomorrow's pot.
        assert!(burn_stake_locked(h(25), Some(d), Some(d + 1)));
        assert!(!burn_stake_locked(h(49), Some(d + 1), Some(d + 1)));
        // Nothing drawn or staked yet: free.
        assert!(!burn_stake_locked(0, None, None));
    }

    #[test]
    fn a_stalled_pot_unlocks_a_day_after_it_was_due() {
        let d = 20_745;
        let h = |x: u64| d * DAY_MS + x * 3_600_000;
        // Today's pot (due at 24:00) never pays: locked until 24:00 tomorrow.
        assert!(burn_stake_locked(h(47), Some(d - 1), Some(d)));
        assert!(!burn_stake_locked(h(48), Some(d - 1), Some(d)));
        // Stays free while the pots stay stalled, though new days are drawn.
        assert!(!burn_stake_locked(h(24 * 6 + 13), Some(d - 1), Some(d)));
        // No pot ever paid: counts from the wallet's own day.
        assert!(burn_stake_locked(h(47), None, Some(d)));
        assert!(!burn_stake_locked(h(48), None, Some(d)));
    }
}
