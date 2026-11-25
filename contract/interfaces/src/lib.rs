//! Shared cross-contract client traits and types for InverseArena (#1603).
//!
//! This crate is the single source of truth for every interface shared
//! between arena, factory, vault (rwa-adapter), and oracle.  Contracts that
//! call each other import the relevant trait here, implement it locally, and
//! the compiler verifies that their signatures haven't drifted.
//!
//! # Design rules
//!
//! 1. **No WASM exports.** The crate-type is `rlib` only, so nothing in here
//!    becomes a Soroban entry-point.  Downstream contracts link it as a library.
//!
//! 2. **No cross-crate implementation imports.** Each contract's `lib.rs`
//!    already uses `#[contractclient]`-derived clients.  The traits here are
//!    the contract-facing interface; implementations live in their own crates.
//!
//! 3. **Shared `#[contracttype]` values live here once.**  `ArenaStatus` and
//!    other cross-contract types are defined below and re-exported so no crate
//!    redefines them independently.

#![no_std]

use soroban_sdk::{contractclient, contracttype, Address, Env};

// ── Shared enum types ─────────────────────────────────────────────────────

/// Lifecycle state of an arena pool.
///
/// Previously duplicated in `contract/factory/src/types.rs`; canonical home
/// is now here.  Factory and Arena implement `update_arena_status` using this
/// type; any divergence is a compile error.
#[contracttype]
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum ArenaStatus {
    Pending,
    Active,
    Finished,
    Cancelled,
}

// ── ArenaFactory trait ────────────────────────────────────────────────────

/// Cross-contract interface the arena calls back into the factory with.
///
/// The factory exposes additional methods not used cross-contract (e.g.
/// `create_pool`); only the subset called from arena belongs here.
#[contractclient(name = "ArenaFactoryClient")]
pub trait ArenaFactoryInterface {
    /// Notify the factory that an arena's lifecycle state has changed.
    fn update_arena_status(env: Env, pool_id: u32, status: ArenaStatus);
}

// ── YieldVault (rwa-adapter) trait ────────────────────────────────────────

/// Cross-contract interface for the RWA-backed yield vault.
#[contractclient(name = "YieldVaultClient")]
pub trait YieldVaultInterface {
    fn deposit(env: Env, from: Address, amount: i128);
    /// Partial withdrawal; returns the amount actually transferred.
    fn withdraw(env: Env, from: Address, amount: i128) -> i128;
    fn withdraw_all(env: Env, from: Address) -> i128;
    fn balance_of(env: Env, user: Address) -> i128;
    fn get_total_deposited(env: Env) -> i128;
}

// ── YieldOracle trait ─────────────────────────────────────────────────────

/// Minimal cross-contract interface for the yield-rate oracle.
#[contractclient(name = "YieldOracleClient")]
pub trait YieldOracleInterface {
    fn get_current_yield_bps(env: Env) -> u32;
}

// ── Arena (subset used cross-contract) ────────────────────────────────────

/// Cross-contract interface exposed by an arena instance, used by the factory
/// for status-polling and administrative operations.
#[contractclient(name = "ArenaClient")]
pub trait ArenaInterface {
    /// Returns the arena's current lifecycle status.
    fn get_status(env: Env) -> ArenaStatus;
}

// ── Tests ─────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::ArenaStatus;

    #[test]
    fn arena_status_variants_are_distinct() {
        assert_ne!(ArenaStatus::Pending, ArenaStatus::Active);
        assert_ne!(ArenaStatus::Active, ArenaStatus::Finished);
        assert_ne!(ArenaStatus::Finished, ArenaStatus::Cancelled);
    }

    #[test]
    fn arena_status_clone_is_equal() {
        let s = ArenaStatus::Active;
        assert_eq!(s.clone(), s);
    }
}
