//! Repository-wide fixture builders for arena protocol domain objects (#1464).
//!
//! Rust has no runtime `Partial<T>` spread, so each builder takes the few
//! values that legitimately vary across tests and derives the rest from
//! deterministic defaults. Every builder returns a valid object; every
//! valid builder has an explicit `*_invalid` sibling in its `invalid` submodule
//! so a test that needs a rejected value says so at the call site.
//!
//! Addresses are derived from a seed rather than `Address::generate`, so a
//! fixture is reproducible and two fixtures never accidentally collide.

#![cfg(test)]
// Builders are intentionally available even when no current test calls them.
#![allow(dead_code)]

extern crate std;

use crate::types::{
    ArenaConfig, GameState, OracleFreshnessPolicy, PlayerState, RoundResult, YieldSnapshot,
    DEFAULT_ORACLE_MAX_AGE_SECS, DEFAULT_ORACLE_WARN_AGE_SECS, FRESHNESS_POLICY_VERSION,
};
use soroban_sdk::xdr::{Hash, ScAddress};
use soroban_sdk::{Address, Env, TryFromVal};

/// A deterministic contract address derived from `seed`.
pub fn address(env: &Env, seed: u8) -> Address {
    let mut arr = [0u8; 32];
    arr[31] = seed;
    Address::try_from_val(env, &ScAddress::Contract(Hash(arr))).expect("valid fixture address")
}

/// A valid, Open `ArenaConfig` with a 10% platform fee and increasing deadlines.
pub fn arena_config(env: &Env, entry_fee: i128) -> ArenaConfig {
    ArenaConfig {
        admin: address(env, 1),
        stake_token: address(env, 2),
        yield_vault: address(env, 3),
        entry_fee,
        state: GameState::Open,
        paused: false,
        player_count: 2,
        active_player_count: 2,
        cumulative_yield: 0,
        commit_deadline: 1_700_000_300,
        reveal_deadline: 1_700_000_600,
        round_count: 0,
        oracle_contract: address(env, 4),
        factory: address(env, 5),
        pool_id: 1,
        platform_fee_bps: 1_000,
        treasury: address(env, 6),
    }
}

/// A valid `ArenaConfig` for an arena whose first round is already active.
pub fn active_arena_config(env: &Env, entry_fee: i128) -> ArenaConfig {
    ArenaConfig {
        state: GameState::Active,
        round_count: 1,
        ..arena_config(env, entry_fee)
    }
}

/// A valid `PlayerState`.
pub fn player_state(active: bool, rounds_survived: u32) -> PlayerState {
    PlayerState {
        active,
        rounds_survived,
    }
}

/// A valid per-round `YieldSnapshot`.
pub fn yield_snapshot(round: u32, rate_bps: u32, accrued: i128) -> YieldSnapshot {
    YieldSnapshot {
        round,
        rate_bps,
        accrued,
    }
}

/// A valid `RoundResult` whose survivor count matches its elimination count.
pub fn round_result(round: u32, eliminated: u32, survivors: u32) -> RoundResult {
    RoundResult {
        round,
        eliminated,
        survivors,
        yield_snapshot: yield_snapshot(round, 500, 1_000),
    }
}

/// The default oracle freshness policy.
pub fn freshness_policy() -> OracleFreshnessPolicy {
    OracleFreshnessPolicy {
        max_age_secs: DEFAULT_ORACLE_MAX_AGE_SECS,
        warn_age_secs: DEFAULT_ORACLE_WARN_AGE_SECS,
        version: FRESHNESS_POLICY_VERSION,
    }
}

/// Explicit invalid-state helpers.
pub mod invalid {
    use super::*;

    /// A config whose commit deadline is *after* its reveal deadline — no real
    /// scheduling path can produce it.
    pub fn arena_config_inverted_deadlines(env: &Env) -> ArenaConfig {
        ArenaConfig {
            commit_deadline: 1_700_000_600,
            reveal_deadline: 1_700_000_300,
            ..arena_config(env, 100)
        }
    }

    /// A config charging more than the 1000 bps hard maximum.
    pub fn arena_config_fee_over_max(env: &Env) -> ArenaConfig {
        ArenaConfig {
            platform_fee_bps: 10_001,
            ..arena_config(env, 100)
        }
    }

    /// A freshness policy whose warning threshold exceeds its max age.
    pub fn freshness_policy_warn_after_max() -> OracleFreshnessPolicy {
        OracleFreshnessPolicy {
            max_age_secs: 1_800,
            warn_age_secs: 3_600,
            version: FRESHNESS_POLICY_VERSION,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::types::{validate_freshness_policy, validate_leaderboard_limit};

    #[test]
    fn valid_fixtures_are_internally_consistent() {
        let env = Env::default();
        let config = arena_config(&env, 100);
        assert_eq!(config.state, GameState::Open);
        assert_eq!(config.commit_deadline, 1_700_000_300);
        assert!(config.commit_deadline < config.reveal_deadline);
        assert!(config.platform_fee_bps <= 1_000);

        let active = active_arena_config(&env, 100);
        assert_eq!(active.state, GameState::Active);
        assert_eq!(active.round_count, 1);
        assert_eq!(active.admin, config.admin);
    }

    #[test]
    fn addresses_are_deterministic_and_distinct() {
        let env = Env::default();
        assert_eq!(address(&env, 1), address(&env, 1));
        assert_ne!(address(&env, 1), address(&env, 2));
    }

    #[test]
    fn valid_freshness_policy_passes_validation() {
        assert!(validate_freshness_policy(&freshness_policy()).is_ok());
    }

    #[test]
    fn invalid_fixtures_are_rejected_by_domain_validators() {
        assert!(validate_freshness_policy(&invalid::freshness_policy_warn_after_max()).is_err());
        assert!(validate_leaderboard_limit(0).is_err());
        assert!(validate_leaderboard_limit(101).is_err());
        assert!(validate_leaderboard_limit(100).is_ok());
    }

    #[test]
    fn invalid_deadline_ordering_is_detectable() {
        let env = Env::default();
        let bad = invalid::arena_config_inverted_deadlines(&env);
        assert!(bad.commit_deadline > bad.reveal_deadline);
    }
}
