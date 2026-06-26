//! RWA (Real-World Asset) adapter contract for Inverse Arena.
//!
//! This contract bridges on-chain yield accounting to real-world asset tokens
//! such as Ondo USDY.  The yield rate is **not** hard-coded; it is stored in
//! [`RwaConfig::rate_bps`] and can be updated by the admin at any time via
//! [`RwaAdapterContract::set_rate`].  This removes the previous `YIELD_BPS =
//! 500` constant that made the yield permanently fixed at 5 % and ignored the
//! oracle entirely.

#![no_std]

use soroban_sdk::{Address, Env, Symbol, contract, contracterror, contractimpl, symbol_short};

pub mod storage;
pub mod types;

use storage::RwaStorage;
use types::RwaConfig;

// ── Event topics ──────────────────────────────────────────────────────────────

const TOPIC_INITIALIZED: Symbol = symbol_short!("INIT");
const TOPIC_RATE_SET: Symbol = symbol_short!("RATE_SET");
const TOPIC_WITHDRAW: Symbol = symbol_short!("WITHDRAW");

// ── Basis-point scale factor ──────────────────────────────────────────────────

/// Denominator for basis-point calculations (10 000 bps = 100 %).
const BPS_DENOM: i128 = 10_000;

// ── Error codes ───────────────────────────────────────────────────────────────

#[contracterror]
#[derive(Copy, Clone, Debug, Eq, PartialEq, PartialOrd, Ord)]
#[repr(u32)]
pub enum RwaError {
    /// Contract has not been initialised yet.
    NotInitialized = 1,
    /// Contract has already been initialised.
    AlreadyInitialized = 2,
    /// Caller is not the admin.
    Unauthorized = 3,
    /// The supplied `rate_bps` value exceeds the allowed ceiling.
    RateTooHigh = 4,
    /// The supplied deposit amount is zero or negative.
    InvalidAmount = 5,
}

// ── Rate ceiling ──────────────────────────────────────────────────────────────

/// Hard upper bound on `rate_bps` (100 % APY = 10 000 bps).
///
/// This prevents a misconfigured or compromised admin from setting an
/// astronomically large rate that would overflow yield calculations.
const MAX_RATE_BPS: u32 = 10_000;

// ── Contract ──────────────────────────────────────────────────────────────────

#[contract]
pub struct RwaAdapterContract;

#[contractimpl]
impl RwaAdapterContract {
    // ── Initialisation ───────────────────────────────────────────────────────

    /// Initialise the adapter.  Must be called exactly once after deployment.
    ///
    /// `initial_rate_bps` is the starting annual yield rate expressed in basis
    /// points (e.g. `500` for 5 % APY).  It can be changed later by the admin
    /// via [`set_rate`].
    ///
    /// # Errors
    /// * [`RwaError::AlreadyInitialized`] — contract was already initialised.
    /// * [`RwaError::RateTooHigh`]        — `initial_rate_bps` > `MAX_RATE_BPS`.
    ///
    /// # Authorization
    /// Requires `admin.require_auth()`.
    pub fn initialize(
        env: Env,
        admin: Address,
        oracle: Address,
        token: Address,
        initial_rate_bps: u32,
    ) -> Result<(), RwaError> {
        if RwaStorage::is_initialized(&env) {
            return Err(RwaError::AlreadyInitialized);
        }
        if initial_rate_bps > MAX_RATE_BPS {
            return Err(RwaError::RateTooHigh);
        }

        admin.require_auth();

        let config = RwaConfig {
            admin: admin.clone(),
            oracle,
            token,
            rate_bps: initial_rate_bps,
        };
        RwaStorage::save_config(&env, &config);

        env.events()
            .publish((TOPIC_INITIALIZED,), (admin, initial_rate_bps));

        Ok(())
    }

    // ── Admin — rate management ───────────────────────────────────────────────

    /// Update the annual yield rate stored in config.
    ///
    /// This replaces the old hard-coded `YIELD_BPS = 500` constant and allows
    /// the rate to track the real Ondo USDY yield (or any oracle-supplied value)
    /// without a full contract redeployment.
    ///
    /// # Errors
    /// * [`RwaError::NotInitialized`] — contract has not been initialised.
    /// * [`RwaError::RateTooHigh`]    — `rate_bps` > `MAX_RATE_BPS` (10 000).
    ///
    /// # Authorization
    /// Requires the admin address stored in config to sign the transaction
    /// (`config.admin.require_auth()`).
    pub fn set_rate(env: Env, rate_bps: u32) -> Result<(), RwaError> {
        let mut config = RwaStorage::load_config(&env)?;

        // Auth check: only the stored admin may change the rate.
        config.admin.require_auth();

        if rate_bps > MAX_RATE_BPS {
            return Err(RwaError::RateTooHigh);
        }

        let old_rate = config.rate_bps;
        config.rate_bps = rate_bps;
        RwaStorage::save_config(&env, &config);

        env.events()
            .publish((TOPIC_RATE_SET,), (old_rate, rate_bps));

        Ok(())
    }

    // ── Queries ───────────────────────────────────────────────────────────────

    /// Return the current [`RwaConfig`].
    pub fn get_config(env: Env) -> Result<RwaConfig, RwaError> {
        RwaStorage::load_config(&env)
    }

    /// Return the current annual yield rate in basis points.
    pub fn get_rate(env: Env) -> Result<u32, RwaError> {
        Ok(RwaStorage::load_config(&env)?.rate_bps)
    }

    /// Return the admin address.
    pub fn admin(env: Env) -> Result<Address, RwaError> {
        Ok(RwaStorage::load_config(&env)?.admin)
    }

    /// Calculate the accrued balance for a deposit.
    ///
    /// Uses the yield rate stored in config rather than the old constant:
    ///
    /// ```text
    /// balance = principal + (principal × rate_bps × elapsed_days) / (BPS_DENOM × 365)
    /// ```
    ///
    /// # Arguments
    /// * `principal`    — original deposited amount (in token stroops).
    /// * `elapsed_days` — number of whole days since the deposit was made.
    ///
    /// # Errors
    /// * [`RwaError::NotInitialized`] — contract has not been initialised.
    /// * [`RwaError::InvalidAmount`]  — `principal` is zero or negative.
    pub fn balance_of(env: Env, principal: i128, elapsed_days: u32) -> Result<i128, RwaError> {
        if principal <= 0 {
            return Err(RwaError::InvalidAmount);
        }

        let config = RwaStorage::load_config(&env)?;
        let rate = config.rate_bps as i128;
        let days = elapsed_days as i128;

        // accrued = principal * rate_bps * elapsed_days / (BPS_DENOM * 365)
        let accrued = principal
            .checked_mul(rate)
            .and_then(|v| v.checked_mul(days))
            .and_then(|v| v.checked_div(BPS_DENOM * 365))
            .unwrap_or(0);

        Ok(principal + accrued)
    }

    // ── Withdraw ──────────────────────────────────────────────────────────────

    /// Record a full withdrawal, returning the accrued balance.
    ///
    /// In a production integration this function would trigger a token transfer;
    /// here it computes and returns the accrued amount so the calling contract
    /// can handle the transfer.  The yield calculation reads `rate_bps` from
    /// the stored config rather than any hard-coded constant.
    ///
    /// # Arguments
    /// * `caller`       — address requesting the withdrawal (must be authed).
    /// * `principal`    — original deposited amount (in token stroops).
    /// * `elapsed_days` — number of whole days since the deposit was made.
    ///
    /// # Errors
    /// * [`RwaError::NotInitialized`] — contract has not been initialised.
    /// * [`RwaError::InvalidAmount`]  — `principal` is zero or negative.
    ///
    /// # Authorization
    /// Requires `caller.require_auth()`.
    pub fn withdraw_all(
        env: Env,
        caller: Address,
        principal: i128,
        elapsed_days: u32,
    ) -> Result<i128, RwaError> {
        caller.require_auth();

        if principal <= 0 {
            return Err(RwaError::InvalidAmount);
        }

        let config = RwaStorage::load_config(&env)?;
        let rate = config.rate_bps as i128;
        let days = elapsed_days as i128;

        // accrued = principal * rate_bps * elapsed_days / (BPS_DENOM * 365)
        let accrued = principal
            .checked_mul(rate)
            .and_then(|v| v.checked_mul(days))
            .and_then(|v| v.checked_div(BPS_DENOM * 365))
            .unwrap_or(0);

        let total = principal + accrued;

        env.events()
            .publish((TOPIC_WITHDRAW,), (caller, principal, accrued, total));

        Ok(total)
    }
}

// ── Tests ─────────────────────────────────────────────────────────────────────

#[cfg(test)]
mod test;
