//! Arena round schedule timing and phase calculations (#1836).
//!
//! Replaces scattered timestamp comparisons across arena entry points with a
//! single `RoundSchedule` struct and pure phase predicates.

use soroban_sdk::contracttype;

/// The active timing phase of an arena round.
#[contracttype]
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum Phase {
    /// Commit window is open: commitments can be submitted.
    Commit,
    /// Reveal window is open: committed choices can be revealed.
    Reveal,
    /// Arena round has exceeded the expiry grace period and can be expired.
    Expired,
}

/// Consolidated round schedule stored per round (#1836).
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct RoundSchedule {
    /// Ledger timestamp when the round commenced.
    pub started_at: u64,
    /// Ledger timestamp when the commit phase ends.
    pub commit_deadline: u64,
    /// Ledger timestamp when the reveal phase ends (>= commit_deadline).
    pub reveal_deadline: u64,
    /// Total duration in seconds the round has been paused.
    pub paused_total: u64,
}

/// Delay after `commit_deadline` before `expire_arena` becomes callable (#1627).
pub const EXPIRY_GRACE_SECONDS: u64 = 86_400;

impl RoundSchedule {
    /// Create a new schedule for a round starting at `started_at` with `duration_seconds` commit duration.
    /// In the default single-duration configuration, `reveal_deadline` matches `commit_deadline`.
    pub fn new(started_at: u64, duration_seconds: u64) -> Self {
        let commit_deadline = started_at.saturating_add(duration_seconds);
        Self {
            started_at,
            commit_deadline,
            reveal_deadline: commit_deadline,
            paused_total: 0,
        }
    }

    /// Create a schedule with explicit commit and reveal durations (#1552).
    pub fn with_reveal(started_at: u64, commit_duration: u64, reveal_duration: u64) -> Self {
        let commit_deadline = started_at.saturating_add(commit_duration);
        let reveal_deadline = commit_deadline.saturating_add(reveal_duration);
        Self {
            started_at,
            commit_deadline,
            reveal_deadline,
            paused_total: 0,
        }
    }

    /// Returns `true` if commitments are currently accepted.
    ///
    /// Commitments are strictly valid from `started_at` up until (strictly before) `commit_deadline`.
    pub fn can_commit(&self, now: u64) -> bool {
        now >= self.started_at && now < self.commit_deadline
    }

    /// Returns `true` if reveals are currently accepted.
    ///
    /// Reveals open at `commit_deadline` and remain open until `reveal_deadline` (or expiry if unconfigured).
    pub fn can_reveal(&self, now: u64) -> bool {
        if self.is_expired(now) {
            return false;
        }
        if self.reveal_deadline > self.commit_deadline {
            now >= self.commit_deadline && now <= self.reveal_deadline
        } else {
            now >= self.commit_deadline
        }
    }

    /// Returns `true` if the round can be resolved.
    ///
    /// Resolution is permitted once the commit phase (and reveal window, if configured) has elapsed.
    pub fn can_resolve(&self, now: u64) -> bool {
        if self.reveal_deadline > self.commit_deadline {
            now >= self.reveal_deadline
        } else {
            now >= self.commit_deadline
        }
    }

    /// Returns `true` if the keeper (non-admin) grace period has elapsed, permitting permissionless resolution.
    pub fn can_keeper_resolve(&self, now: u64, host_grace: u64) -> bool {
        let base = if self.reveal_deadline > self.commit_deadline {
            self.reveal_deadline
        } else {
            self.commit_deadline
        };
        now >= base.saturating_add(host_grace)
    }

    /// Returns the timestamp after which the arena can be expired.
    pub fn expiry_at(&self) -> u64 {
        self.commit_deadline.saturating_add(EXPIRY_GRACE_SECONDS)
    }

    /// Returns `true` if the arena has expired past the expiry grace deadline.
    pub fn is_expired(&self, now: u64) -> bool {
        now > self.expiry_at()
    }

    /// Derives the current round phase for a given ledger timestamp.
    pub fn phase(&self, now: u64) -> Phase {
        if self.is_expired(now) {
            Phase::Expired
        } else if self.can_commit(now) {
            Phase::Commit
        } else {
            Phase::Reveal
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_schedule_boundaries_default() {
        let start = 1_000;
        let duration = 60;
        let schedule = RoundSchedule::new(start, duration);

        assert_eq!(schedule.started_at, 1_000);
        assert_eq!(schedule.commit_deadline, 1_060);
        assert_eq!(schedule.reveal_deadline, 1_060);
        assert_eq!(schedule.paused_total, 0);
        assert_eq!(schedule.expiry_at(), 1_060 + 86_400);

        // Before start
        assert!(!schedule.can_commit(999));
        assert!(!schedule.can_reveal(999));
        assert!(!schedule.can_resolve(999));
        assert!(!schedule.is_expired(999));

        // Exactly at start
        assert!(schedule.can_commit(1_000));
        assert!(!schedule.can_reveal(1_000));
        assert!(!schedule.can_resolve(1_000));
        assert_eq!(schedule.phase(1_000), Phase::Commit);

        // Inside commit window
        assert!(schedule.can_commit(1_030));
        assert!(!schedule.can_reveal(1_030));
        assert!(!schedule.can_resolve(1_030));
        assert_eq!(schedule.phase(1_030), Phase::Commit);

        // Exactly one second before commit deadline
        assert!(schedule.can_commit(1_059));
        assert!(!schedule.can_reveal(1_059));
        assert!(!schedule.can_resolve(1_059));
        assert_eq!(schedule.phase(1_059), Phase::Commit);

        // Exactly at commit deadline: commit closes, reveal & resolution open
        assert!(!schedule.can_commit(1_060));
        assert!(schedule.can_reveal(1_060));
        assert!(schedule.can_resolve(1_060));
        assert_eq!(schedule.phase(1_060), Phase::Reveal);

        // During reveal window
        assert!(!schedule.can_commit(1_100));
        assert!(schedule.can_reveal(1_100));
        assert!(schedule.can_resolve(1_100));
        assert_eq!(schedule.phase(1_100), Phase::Reveal);

        // Exactly at expiry boundary
        let expiry = 1_060 + 86_400;
        assert!(!schedule.is_expired(expiry));
        assert!(schedule.can_reveal(expiry));
        assert_eq!(schedule.phase(expiry), Phase::Reveal);

        // 1 second past expiry: expired
        assert!(schedule.is_expired(expiry + 1));
        assert!(!schedule.can_commit(expiry + 1));
        assert!(!schedule.can_reveal(expiry + 1));
        assert_eq!(schedule.phase(expiry + 1), Phase::Expired);
    }

    #[test]
    fn test_schedule_boundaries_with_distinct_reveal_window() {
        let start = 1_000;
        let commit_dur = 60;
        let reveal_dur = 30;
        let schedule = RoundSchedule::with_reveal(start, commit_dur, reveal_dur);

        assert_eq!(schedule.started_at, 1_000);
        assert_eq!(schedule.commit_deadline, 1_060);
        assert_eq!(schedule.reveal_deadline, 1_090);

        // Before commit deadline
        assert!(schedule.can_commit(1_059));
        assert!(!schedule.can_reveal(1_059));
        assert!(!schedule.can_resolve(1_059));

        // In reveal window
        assert!(!schedule.can_commit(1_060));
        assert!(schedule.can_reveal(1_060));
        assert!(!schedule.can_resolve(1_060));

        assert!(schedule.can_reveal(1_089));
        assert!(!schedule.can_resolve(1_089));

        // At end of reveal window
        assert!(schedule.can_reveal(1_090));
        assert!(schedule.can_resolve(1_090));

        // After reveal window
        assert!(!schedule.can_reveal(1_091));
        assert!(schedule.can_resolve(1_091));
    }

    #[test]
    fn test_keeper_grace_resolution() {
        let schedule = RoundSchedule::new(1_000, 60);
        let host_grace = 300;

        assert!(!schedule.can_keeper_resolve(1_060, host_grace));
        assert!(!schedule.can_keeper_resolve(1_060 + 299, host_grace));
        assert!(schedule.can_keeper_resolve(1_060 + 300, host_grace));
        assert!(schedule.can_keeper_resolve(1_060 + 301, host_grace));
    }
}
