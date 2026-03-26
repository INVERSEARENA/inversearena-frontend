//! Hard caps on storage-heavy collections (participants, per-round submissions).
//!
//! Documented in `contract/BOUNDS.md`. Production limits use the `not(test)` values.
//! Unit tests compile with **lower** caps so boundary cases (N−1, N, N+1) stay fast in CI.

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
