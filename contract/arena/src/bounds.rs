//! Hard caps on storage-heavy collections (participants, per-round submissions).
//!
//! Documented in `contract/BOUNDS.md`. Production limits use the `not(test)` values.
//! Unit tests compile with **lower** caps so boundary cases (N−1, N, N+1) stay fast in CI.

/// Minimum registered survivors needed for a resolvable arena round.
pub const MIN_ARENA_PARTICIPANTS: u32 = 2;

/// Maximum registered survivors (`DataKey::Survivor` entries + `S_COUNT`).
#[cfg(test)]
pub const MAX_ARENA_PARTICIPANTS: u32 = 64;
/// Maximum registered survivors (`DataKey::Survivor` entries + `S_COUNT`).
#[cfg(not(test))]
pub const MAX_ARENA_PARTICIPANTS: u32 = 10_000;

/// Maximum `Submission(round, player)` records for a single round (`RoundState::total_submissions`).
#[cfg(test)]
pub const MAX_SUBMISSIONS_PER_ROUND: u32 = 32;
/// Maximum `Submission(round, player)` records for a single round (`RoundState::total_submissions`).
#[cfg(not(test))]
pub const MAX_SUBMISSIONS_PER_ROUND: u32 = 10_000;

/// Minimum `round_speed_in_ledgers` accepted by `init`.
/// Test value keeps existing property tests (which use speeds as low as 1) passing unchanged.
#[cfg(test)]
pub const MIN_SPEED_LEDGERS: u32 = 1;
/// Minimum `round_speed_in_ledgers` — 10 ledgers ≈ 50 s at mainnet ~5 s/ledger.
#[cfg(not(test))]
pub const MIN_SPEED_LEDGERS: u32 = 10;

/// Maximum `round_speed_in_ledgers` accepted by `init`.
/// Test value covers the 20 000-ledger TTL durability test in `test.rs`.
#[cfg(test)]
pub const MAX_SPEED_LEDGERS: u32 = 100_000;
/// Maximum `round_speed_in_ledgers` — 17 280 ledgers ≈ 1 day at mainnet ~5 s/ledger.
#[cfg(not(test))]
pub const MAX_SPEED_LEDGERS: u32 = 17_280;

/// Minimum `required_stake_amount` accepted by `init`.
/// Matches the factory's `DEFAULT_MIN_STAKE` (10 XLM in stroops) to prevent
/// dust-stake arenas and enforce the same floor regardless of call path.
/// Test value is relaxed to allow existing tests that use small amounts (e.g. 100 stroops).
#[cfg(test)]
pub const MIN_REQUIRED_STAKE: i128 = 1;
/// Minimum `required_stake_amount` — 10_000_000 stroops = 10 XLM.
#[cfg(not(test))]
pub const MIN_REQUIRED_STAKE: i128 = 10_000_000;

/// Default maximum number of rounds before a forced-draw resolution is triggered.
pub const DEFAULT_MAX_ROUNDS: u32 = 20;

/// Minimum configurable value for `max_rounds`. A cap of 1 means the very first
/// round always ends in a forced draw (useful for testing).
pub const MIN_MAX_ROUNDS: u32 = 1;

/// Maximum configurable value for `max_rounds`. Keeps game duration bounded to
/// prevent indefinite fund locking.
pub const MAX_MAX_ROUNDS: u32 = 100;

/// Default grace period (seconds) for late choice submission.
pub const DEFAULT_GRACE_PERIOD_SECONDS: u64 = 10;

/// Maximum grace period (seconds) allowed by admin configuration.
pub const MAX_GRACE_PERIOD_SECONDS: u64 = 30;
