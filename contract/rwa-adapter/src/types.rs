//! Shared types for the RWA adapter contract.

use soroban_sdk::{Address, contracttype};

/// Configuration stored on-chain for the RWA adapter.
///
/// * `admin`     — Address authorised to call admin-only entrypoints.
/// * `oracle`    — Address of the oracle contract that publishes yield rates.
/// * `token`     — Address of the underlying RWA token (e.g. Ondo USDY wrapper).
/// * `rate_bps`  — Current annual yield rate in basis points (1 bps = 0.01 %).
///                 Replaces the old hard-coded `YIELD_BPS = 500` constant.
///                 Can be updated by the admin via `set_rate`.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct RwaConfig {
    pub admin: Address,
    pub oracle: Address,
    pub token: Address,
    /// Annual yield rate in basis points.  500 = 5.00 % APY.
    pub rate_bps: u32,
}
