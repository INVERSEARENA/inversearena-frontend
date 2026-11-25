//! Shared two-step timelocked upgrade helper library (#1600).

use soroban_sdk::{BytesN, Env};

pub struct TimelockedUpgradeHelper;

impl TimelockedUpgradeHelper {
    /// Validates if a proposed timelocked upgrade can be executed.
    pub fn is_timelock_elapsed(now: u64, proposed_at: u64, timelock_seconds: u64) -> bool {
        now >= proposed_at.saturating_add(timelock_seconds)
    }

    /// Computes the execution timestamp for a proposed WASM hash upgrade.
    pub fn execution_timestamp(proposed_at: u64, timelock_seconds: u64) -> u64 {
        proposed_at.saturating_add(timelock_seconds)
    }
}
