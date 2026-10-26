#![no_std]
#![cfg_attr(coverage_nightly, feature(coverage_attribute))]
use soroban_sdk::{
    Address, BytesN, Env, Map, Vec, contract, contracterror, contractimpl, contracttype,
    symbol_short,
};

/// On-chain yield rate oracle for InverseArena.
///
/// Stores an admin-updateable yield rate in basis points (bps).
/// The arena contract calls `get_current_yield_bps` once per `resolve_round`
/// to snapshot the current USDY / RWA yield rate.
///
/// Rate changes are bounded and delayed (#1570):
/// - a single update may move the rate by at most `max_delta_bps`,
/// - changes take effect after `activation_delay` seconds as a scheduled
///   rate (`pending_rate`, `effective_at`), so clients and keepers can react,
/// - every change is evented (`rate_sch` / `rate_set` / `rate_appl`,
///   `par_sched` / `par_appl` for params, `zeroed` for emergency zero).
///
/// Each applied rate carries its observation timestamp (#1512): consumers
/// read `get_oracle_reading` for the effective rate plus provenance, and can
/// classify how stale that rate actually is instead of trusting a bare
/// number. `observed_at == 0` means no rate has ever been applied here.
///
/// Multi-reporter median aggregation (#1578): the admin maintains a reporter
/// set (up to `MAX_REPORTERS`). Each reporter submits a rate via
/// `submit_rate`; once `quorum` fresh submissions are present the median is
/// finalized on-chain (persisted as the effective rate, evented, and outlier-
/// filtered within `max_deviation_bps`). `get_current_yield_bps` keeps its
/// bare `u32` signature: it returns the live median of fresh reports when
/// quorum is met, and otherwise the last finalized value; `get_oracle_status`
/// exposes the accompanying staleness flag and report counts for consumers
/// that need the distinction.
///
/// The admin updates the rate before each round closes, sourcing the value
/// from Ondo's off-chain API or an on-chain Band Protocol feed.
/// Future upgrades can replace this contract with a fully autonomous oracle.
#[cfg(test)]
mod auth_tests;

#[contract]
pub struct OracleContract;

const KEY_ADMIN: soroban_sdk::Symbol = symbol_short!("ADMIN");
const KEY_RATE: soroban_sdk::Symbol = symbol_short!("RATE");
const KEY_MAX_RATE: soroban_sdk::Symbol = symbol_short!("MAX_RATE");
const KEY_PENDING_ADMIN: soroban_sdk::Symbol = symbol_short!("P_ADMIN");
// #1570 — scheduled rate + bounded/delayed params.
const KEY_PENDING_RATE: soroban_sdk::Symbol = symbol_short!("P_RATE");
const KEY_RATE_AT: soroban_sdk::Symbol = symbol_short!("P_R_AT");
const KEY_MAX_DELTA: soroban_sdk::Symbol = symbol_short!("MAX_DLT");
const KEY_ACT_DELAY: soroban_sdk::Symbol = symbol_short!("ACT_DLY");
const KEY_P_MAX_RATE: soroban_sdk::Symbol = symbol_short!("P_MRATE");
const KEY_P_MAX_DELTA: soroban_sdk::Symbol = symbol_short!("P_MDLT");
const KEY_P_DELAY: soroban_sdk::Symbol = symbol_short!("P_DLY");
const KEY_P_PARAMS_AT: soroban_sdk::Symbol = symbol_short!("P_P_AT");
/// Ledger timestamp (seconds) at which the currently effective `KEY_RATE`
/// was applied — set on initialize, on an immediate `set_yield_bps`, on
/// emergency zeroing, and when a scheduled rate activates. Absent (reads as
/// `0`) until the first application; callers must treat `observed_at == 0`
/// as "no observation has ever been recorded," i.e. maximally stale.
const KEY_OBSERVED_AT: soroban_sdk::Symbol = symbol_short!("OBS_AT");
// #1578 — multi-reporter median aggregation.
/// Registered reporters, kept as a `Vec<Address>` for ordered iteration.
const KEY_REPORTERS: soroban_sdk::Symbol = symbol_short!("REPS");
/// Latest submission per reporter (`Map<Address, RateSubmission>`).
const KEY_SUBMISSIONS: soroban_sdk::Symbol = symbol_short!("SUBS");
/// Fresh reports required before a median is finalized.
const KEY_QUORUM: soroban_sdk::Symbol = symbol_short!("QUORUM");
/// Maximum age (seconds) of a submission to count as fresh.
const KEY_MAX_AGE: soroban_sdk::Symbol = symbol_short!("M_AGE");
/// Outlier band (bps) around the median; `0` disables outlier rejection.
const KEY_MAX_DEV: soroban_sdk::Symbol = symbol_short!("M_DEV");

pub const DEFAULT_MAX_YIELD_BPS: u32 = 5_000;
pub const MAX_MAX_RATE_BPS: u32 = 10_000;
/// Permissive default so existing deployments keep working; the admin is
/// expected to tighten it (subject to delay) after initialization.
pub const DEFAULT_MAX_DELTA_BPS: u32 = 10_000;
pub const DEFAULT_ACTIVATION_DELAY_SECS: u64 = 0;
/// Hard upper bound for `activation_delay` (7 days).
pub const MAX_ACTIVATION_DELAY_SECS: u64 = 7 * 24 * 3_600;

/// Version of the freshness-metadata shape this deployment exposes via
/// `get_oracle_reading` (#1512). Bumped only if `OracleReading`'s fields
/// change in a way callers must branch on; the plain `get_current_yield_bps`
/// method never changes shape, so it carries no version of its own.
pub const ORACLE_CONTRACT_VERSION: u32 = 1;

// ── multi-reporter median (#1578) ─────────────────────────────────────
/// Hard cap on the reporter set. Small enough that reading every submission
/// in a single `submit_rate`/getter call stays cheap.
pub const MAX_REPORTERS: u32 = 8;
/// A single reporter is a valid quorum, so existing single-admin flows can
/// opt into reporting without changing their operations.
pub const DEFAULT_QUORUM: u32 = 1;
/// Submissions older than one hour stop counting as fresh.
pub const DEFAULT_MAX_AGE_SECS: u64 = 3_600;
/// Default outlier band: reports further than 5% from the median are
/// excluded from the finalized value.
pub const DEFAULT_MAX_DEVIATION_BPS: u32 = 500;

#[contracterror]
#[derive(Copy, Clone, Debug, Eq, PartialEq, PartialOrd, Ord)]
#[repr(u32)]
pub enum OracleError {
    NotInitialized = 1,
    AlreadyInitialized = 2,
    RateTooHigh = 3,
    NoPendingAdmin = 4,
    /// `|new_rate - current_rate| > max_delta_bps`.
    DeltaTooLarge = 5,
    /// `activation_delay` (or a scheduled value) exceeds the hard bound.
    DelayTooLong = 6,
    /// `submit_rate` called by an address that is not in the reporter set.
    NotReporter = 7,
    /// `add_reporter` called with an address already in the set.
    ReporterExists = 8,
    /// `add_reporter` would grow the set beyond `MAX_REPORTERS`.
    ReporterLimitReached = 9,
    /// `set_quorum` with `quorum == 0` or above `MAX_REPORTERS`.
    InvalidQuorum = 10,
}

/// Effective rate schedule, readable by frontends and keepers (#1570).
#[contracttype]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct RateSchedule {
    pub current: u32,
    pub pending: Option<u32>,
    pub effective_at: Option<u64>,
    pub max_delta_bps: u32,
    pub activation_delay: u64,
    pub pending_max_rate: Option<u32>,
    pub pending_max_delta: Option<u32>,
    pub pending_delay: Option<u64>,
    pub params_effective_at: Option<u64>,
}

/// A yield rate reading together with its observation provenance (#1512).
///
/// Additive: exposed via `get_oracle_reading` alongside the unchanged
/// `get_current_yield_bps`, so an older caller that only knows the latter
/// keeps working unmodified. `observed_at` tracks when the effective rate
/// was applied (not when it was merely scheduled).
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct OracleReading {
    pub rate_bps: u32,
    /// Ledger timestamp (seconds) the effective rate was applied at. `0`
    /// means no observation has ever been recorded on this instance.
    pub observed_at: u64,
    /// This deployment's `ORACLE_CONTRACT_VERSION`, so a caller that reads
    /// more than one oracle instance (e.g. across an upgrade) can tell them
    /// apart instead of assuming every instance shares the same shape.
    pub source_version: u32,
}

/// One reporter's latest rate submission (#1578).
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct RateSubmission {
    pub rate_bps: u32,
    pub submitted_at: u64,
}

/// Live status of the reporter set alongside the effective rate (#1578).
///
/// `get_current_yield_bps` keeps its bare `u32` shape; this view is the
/// companion for consumers that need to know *why* the rate is what it is.
/// Consumer policy: `stale == true` means the returned `rate_bps` is the
/// last finalized value (admin-set or a previous median), not a live median
/// of fresh reports — treat it like a stale reading.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct OracleStatus {
    /// Same value `get_current_yield_bps` returns.
    pub rate_bps: u32,
    /// True when fewer than `quorum` fresh reports are available, so
    /// `rate_bps` falls back to the last finalized value.
    pub stale: bool,
    /// Number of submissions within `max_age_secs` right now.
    pub fresh_reports: u32,
    /// Fresh reports required for a live median.
    pub quorum: u32,
    /// Current size of the reporter set.
    pub reporter_count: u32,
    /// When the stored rate was last applied (median finalize, admin set,
    /// scheduled activation, or emergency zero). `0` = never.
    pub finalized_at: u64,
}

fn load_u32(env: &Env, key: &soroban_sdk::Symbol, fallback: u32) -> u32 {
    env.storage().persistent().get(key).unwrap_or(fallback)
}

fn load_u64(env: &Env, key: &soroban_sdk::Symbol, fallback: u64) -> u64 {
    env.storage().persistent().get(key).unwrap_or(fallback)
}

fn abs_diff(a: u32, b: u32) -> u32 {
    if a > b {
        a - b
    } else {
        b - a
    }
}

#[contractimpl]
impl OracleContract {
    pub fn initialize(env: Env, admin: Address, initial_rate_bps: u32) -> Result<(), OracleError> {
        if env.storage().persistent().has(&KEY_ADMIN) {
            return Err(OracleError::AlreadyInitialized);
        }
        if initial_rate_bps > DEFAULT_MAX_YIELD_BPS {
            return Err(OracleError::RateTooHigh);
        }
        admin.require_auth();
        env.storage().persistent().set(&KEY_ADMIN, &admin);
        env.storage().persistent().set(&KEY_RATE, &initial_rate_bps);
        env.storage()
            .persistent()
            .set(&KEY_OBSERVED_AT, &env.ledger().timestamp());
        env.storage()
            .persistent()
            .set(&KEY_MAX_RATE, &DEFAULT_MAX_YIELD_BPS);
        env.storage()
            .persistent()
            .set(&KEY_MAX_DELTA, &DEFAULT_MAX_DELTA_BPS);
        env.storage()
            .persistent()
            .set(&KEY_ACT_DELAY, &DEFAULT_ACTIVATION_DELAY_SECS);
        Ok(())
    }

    /// Schedule (or, when `activation_delay == 0`, apply immediately) a new
    /// yield rate. The move is bounded by `max_delta_bps` against the
    /// currently effective rate. A pending update is overwritten by a newer
    /// one (last wins).
    pub fn set_yield_bps(env: Env, rate_bps: u32) -> Result<(), OracleError> {
        let admin: Address = env
            .storage()
            .persistent()
            .get(&KEY_ADMIN)
            .ok_or(OracleError::NotInitialized)?;
        admin.require_auth();
        Self::settle_due(&env);
        let ceiling: u32 = Self::effective_max_rate(&env);
        if rate_bps > ceiling {
            return Err(OracleError::RateTooHigh);
        }
        let current = Self::effective_rate(&env);
        let max_delta = load_u32(&env, &KEY_MAX_DELTA, DEFAULT_MAX_DELTA_BPS);
        // Emergency zero always goes through `set_rate_to_zero`; here an
        // explicit zero still respects the delta bound like any other rate.
        if abs_diff(rate_bps, current) > max_delta {
            return Err(OracleError::DeltaTooLarge);
        }
        let delay = load_u64(&env, &KEY_ACT_DELAY, DEFAULT_ACTIVATION_DELAY_SECS);
        if delay == 0 {
            let now = env.ledger().timestamp();
            env.storage().persistent().set(&KEY_RATE, &rate_bps);
            env.storage().persistent().remove(&KEY_PENDING_RATE);
            env.storage().persistent().remove(&KEY_RATE_AT);
            env.storage().persistent().set(&KEY_OBSERVED_AT, &now);
            // Unchanged shape (bare rate_bps) for existing consumers.
            env.events().publish((symbol_short!("rate_set"),), rate_bps);
            // Additive (#1512): carries the observation timestamp for
            // consumers that need freshness provenance without re-parsing
            // `rate_set`.
            env.events()
                .publish((symbol_short!("rate_obs"),), (rate_bps, now));
        } else {
            let effective_at = env.ledger().timestamp().saturating_add(delay);
            env.storage()
                .persistent()
                .set(&KEY_PENDING_RATE, &rate_bps);
            env.storage()
                .persistent()
                .set(&KEY_RATE_AT, &effective_at);
            env.events()
                .publish((symbol_short!("rate_sch"),), (rate_bps, effective_at));
        }
        Ok(())
    }

    /// Emergency path: set the rate to zero immediately, bypassing the delta
    /// bound and any activation delay, and clearing any pending rate update.
    /// Explicitly evented (`zeroed`) for incident response (#1570).
    pub fn set_rate_to_zero(env: Env) -> Result<(), OracleError> {
        let admin: Address = env
            .storage()
            .persistent()
            .get(&KEY_ADMIN)
            .ok_or(OracleError::NotInitialized)?;
        admin.require_auth();
        let now = env.ledger().timestamp();
        env.storage().persistent().set(&KEY_RATE, &0u32);
        env.storage().persistent().remove(&KEY_PENDING_RATE);
        env.storage().persistent().remove(&KEY_RATE_AT);
        env.storage().persistent().set(&KEY_OBSERVED_AT, &now);
        env.events().publish((symbol_short!("zeroed"),), 0u32);
        env.events().publish((symbol_short!("rate_obs"),), (0u32, now));
        Ok(())
    }

    /// Admin-configurable per-update bound, itself subject to the activation
    /// delay when one is configured (last wins).
    pub fn set_max_delta_bps(env: Env, max_delta_bps: u32) -> Result<(), OracleError> {
        let admin: Address = env
            .storage()
            .persistent()
            .get(&KEY_ADMIN)
            .ok_or(OracleError::NotInitialized)?;
        admin.require_auth();
        if max_delta_bps > MAX_MAX_RATE_BPS {
            return Err(OracleError::RateTooHigh);
        }
        Self::settle_due(&env);
        let delay = load_u64(&env, &KEY_ACT_DELAY, DEFAULT_ACTIVATION_DELAY_SECS);
        if delay == 0 {
            env.storage()
                .persistent()
                .set(&KEY_MAX_DELTA, &max_delta_bps);
            env.events()
                .publish((symbol_short!("maxd_set"),), max_delta_bps);
        } else {
            let effective_at = env.ledger().timestamp().saturating_add(delay);
            env.storage()
                .persistent()
                .set(&KEY_P_MAX_DELTA, &max_delta_bps);
            env.storage()
                .persistent()
                .set(&KEY_P_PARAMS_AT, &effective_at);
            env.events().publish(
                (symbol_short!("par_sched"),),
                (symbol_short!("max_delta"), max_delta_bps, effective_at),
            );
        }
        Ok(())
    }

    /// Admin-configurable activation delay within the hard bound, itself
    /// subject to the current delay when one is configured (last wins).
    pub fn set_activation_delay(env: Env, delay_secs: u64) -> Result<(), OracleError> {
        let admin: Address = env
            .storage()
            .persistent()
            .get(&KEY_ADMIN)
            .ok_or(OracleError::NotInitialized)?;
        admin.require_auth();
        if delay_secs > MAX_ACTIVATION_DELAY_SECS {
            return Err(OracleError::DelayTooLong);
        }
        Self::settle_due(&env);
        let current_delay = load_u64(&env, &KEY_ACT_DELAY, DEFAULT_ACTIVATION_DELAY_SECS);
        if current_delay == 0 {
            env.storage().persistent().set(&KEY_ACT_DELAY, &delay_secs);
            env.events()
                .publish((symbol_short!("dly_set"),), delay_secs);
        } else {
            let effective_at = env.ledger().timestamp().saturating_add(current_delay);
            env.storage().persistent().set(&KEY_P_DELAY, &delay_secs);
            env.storage()
                .persistent()
                .set(&KEY_P_PARAMS_AT, &effective_at);
            env.events().publish(
                (symbol_short!("par_sched"),),
                (symbol_short!("delay"), delay_secs, effective_at),
            );
        }
        Ok(())
    }

    pub fn set_max_rate(env: Env, max_rate_bps: u32) -> Result<(), OracleError> {
        let admin: Address = env
            .storage()
            .persistent()
            .get(&KEY_ADMIN)
            .ok_or(OracleError::NotInitialized)?;
        admin.require_auth();
        if max_rate_bps > MAX_MAX_RATE_BPS {
            return Err(OracleError::RateTooHigh);
        }
        Self::settle_due(&env);
        let delay = load_u64(&env, &KEY_ACT_DELAY, DEFAULT_ACTIVATION_DELAY_SECS);
        if delay == 0 {
            env.storage()
                .persistent()
                .set(&KEY_MAX_RATE, &max_rate_bps);
            env.events()
                .publish((symbol_short!("max_set"),), max_rate_bps);
        } else {
            let effective_at = env.ledger().timestamp().saturating_add(delay);
            env.storage()
                .persistent()
                .set(&KEY_P_MAX_RATE, &max_rate_bps);
            env.storage()
                .persistent()
                .set(&KEY_P_PARAMS_AT, &effective_at);
            env.events().publish(
                (symbol_short!("par_sched"),),
                (symbol_short!("max_rate"), max_rate_bps, effective_at),
            );
        }
        Ok(())
    }

    pub fn get_max_yield_bps(env: Env) -> u32 {
        Self::effective_max_rate(&env)
    }

    pub fn get_max_delta_bps(env: Env) -> u32 {
        Self::effective_max_delta(&env)
    }

    pub fn get_activation_delay(env: Env) -> u64 {
        Self::effective_delay(&env)
    }

    /// Frontend/keeper read of the full schedule (#1570).
    pub fn get_rate_schedule(env: Env) -> RateSchedule {
        RateSchedule {
            current: Self::effective_rate(&env),
            pending: env.storage().persistent().get(&KEY_PENDING_RATE),
            effective_at: env.storage().persistent().get(&KEY_RATE_AT),
            max_delta_bps: Self::effective_max_delta(&env),
            activation_delay: Self::effective_delay(&env),
            pending_max_rate: env.storage().persistent().get(&KEY_P_MAX_RATE),
            pending_max_delta: env.storage().persistent().get(&KEY_P_MAX_DELTA),
            pending_delay: env.storage().persistent().get(&KEY_P_DELAY),
            params_effective_at: env.storage().persistent().get(&KEY_P_PARAMS_AT),
        }
    }

    pub fn propose_admin(env: Env, new_admin: Address) -> Result<(), OracleError> {
        let admin: Address = env
            .storage()
            .persistent()
            .get(&KEY_ADMIN)
            .ok_or(OracleError::NotInitialized)?;
        admin.require_auth();
        env.storage()
            .persistent()
            .set(&KEY_PENDING_ADMIN, &new_admin);
        Ok(())
    }

    pub fn accept_admin(env: Env) -> Result<(), OracleError> {
        let pending_admin: Address = env
            .storage()
            .persistent()
            .get(&KEY_PENDING_ADMIN)
            .ok_or(OracleError::NoPendingAdmin)?;
        pending_admin.require_auth();
        let old_admin: Address = env
            .storage()
            .persistent()
            .get(&KEY_ADMIN)
            .ok_or(OracleError::NotInitialized)?;
        env.storage().persistent().set(&KEY_ADMIN, &pending_admin);
        env.storage().persistent().remove(&KEY_PENDING_ADMIN);
        env.events()
            .publish((symbol_short!("adm_chg"),), (old_admin, pending_admin));
        Ok(())
    }

    pub fn upgrade(env: Env, new_wasm_hash: BytesN<32>) -> Result<(), OracleError> {
        let admin: Address = env
            .storage()
            .persistent()
            .get(&KEY_ADMIN)
            .ok_or(OracleError::NotInitialized)?;
        admin.require_auth();
        env.deployer().update_current_contract_wasm(new_wasm_hash);
        Ok(())
    }

    // ── multi-reporter median (#1578) ─────────────────────────────────

    /// Register a rate reporter. Admin-managed, bounded by `MAX_REPORTERS`;
    /// duplicate registration is rejected. Removing a reporter also drops
    /// their outstanding submission, so rotation during an active round can
    /// never leave a ghost vote in the median.
    pub fn add_reporter(env: Env, reporter: Address) -> Result<(), OracleError> {
        let admin: Address = env
            .storage()
            .persistent()
            .get(&KEY_ADMIN)
            .ok_or(OracleError::NotInitialized)?;
        admin.require_auth();
        let mut reporters: Vec<Address> = env
            .storage()
            .persistent()
            .get(&KEY_REPORTERS)
            .unwrap_or_else(|| Vec::new(&env));
        if reporters.iter().any(|r| r == reporter) {
            return Err(OracleError::ReporterExists);
        }
        if reporters.len() as u32 >= MAX_REPORTERS {
            return Err(OracleError::ReporterLimitReached);
        }
        reporters.push_back(reporter.clone());
        env.storage().persistent().set(&KEY_REPORTERS, &reporters);
        env.events()
            .publish((symbol_short!("rep_add"),), (reporter, reporters.len() as u32));
        Ok(())
    }

    /// Remove a rate reporter and their outstanding submission. If the
    /// removal drops the fresh count below quorum the effective rate stays
    /// at the last finalized value and `get_oracle_status` reports
    /// `stale == true` until quorum recovers.
    pub fn remove_reporter(env: Env, reporter: Address) -> Result<(), OracleError> {
        let admin: Address = env
            .storage()
            .persistent()
            .get(&KEY_ADMIN)
            .ok_or(OracleError::NotInitialized)?;
        admin.require_auth();
        let mut reporters: Vec<Address> = env
            .storage()
            .persistent()
            .get(&KEY_REPORTERS)
            .ok_or(OracleError::NotInitialized)?;
        let Some(idx) = reporters.iter().position(|r| r == reporter) else {
            return Err(OracleError::NotReporter);
        };
        reporters.remove(idx as u32);
        if reporters.is_empty() {
            env.storage().persistent().remove(&KEY_REPORTERS);
        } else {
            env.storage().persistent().set(&KEY_REPORTERS, &reporters);
        }
        let mut subs: Map<Address, RateSubmission> = env
            .storage()
            .persistent()
            .get(&KEY_SUBMISSIONS)
            .unwrap_or_else(|| Map::new(&env));
        if subs.contains_key(reporter.clone()) {
            subs.remove(reporter.clone());
            if subs.is_empty() {
                env.storage().persistent().remove(&KEY_SUBMISSIONS);
            } else {
                env.storage().persistent().set(&KEY_SUBMISSIONS, &subs);
            }
        }
        env.events()
            .publish((symbol_short!("rep_rem"),), (reporter, reporters.len() as u32));
        Ok(())
    }

    /// Fresh reports required before a median is finalized. Valid range is
    /// `1..=MAX_REPORTERS`; setting it above the current reporter count is
    /// allowed (the oracle simply stays stale until enough reporters are
    /// added back), which keeps rotation ordering flexible.
    pub fn set_quorum(env: Env, quorum: u32) -> Result<(), OracleError> {
        let admin: Address = env
            .storage()
            .persistent()
            .get(&KEY_ADMIN)
            .ok_or(OracleError::NotInitialized)?;
        admin.require_auth();
        if quorum == 0 || quorum > MAX_REPORTERS {
            return Err(OracleError::InvalidQuorum);
        }
        env.storage().persistent().set(&KEY_QUORUM, &quorum);
        env.events().publish((symbol_short!("quorum"),), quorum);
        Ok(())
    }

    /// Maximum age (seconds) of a submission to count as fresh.
    pub fn set_max_age_secs(env: Env, max_age_secs: u64) -> Result<(), OracleError> {
        let admin: Address = env
            .storage()
            .persistent()
            .get(&KEY_ADMIN)
            .ok_or(OracleError::NotInitialized)?;
        admin.require_auth();
        env.storage().persistent().set(&KEY_MAX_AGE, &max_age_secs);
        env.events()
            .publish((symbol_short!("mage_set"),), max_age_secs);
        Ok(())
    }

    /// Outlier band around the median, in bps. Reports whose rate deviates
    /// from the pre-filter median by more than this are excluded from the
    /// finalized value and evented (`out_rej`). `0` disables rejection.
    pub fn set_max_deviation_bps(env: Env, max_deviation_bps: u32) -> Result<(), OracleError> {
        let admin: Address = env
            .storage()
            .persistent()
            .get(&KEY_ADMIN)
            .ok_or(OracleError::NotInitialized)?;
        admin.require_auth();
        env.storage().persistent().set(&KEY_MAX_DEV, &max_deviation_bps);
        env.events()
            .publish((symbol_short!("mdev_set"),), max_deviation_bps);
        Ok(())
    }

    /// Submit a rate as a registered reporter (#1578). The reporter's
    /// signature is required. Submissions are not subject to the admin
    /// `max_delta_bps` bound (reporters are independent sources), but must
    /// still respect the `max_rate` ceiling. When this submission brings the
    /// fresh count to quorum the median is finalized immediately: outliers
    /// are dropped (`out_rej`), the median is persisted as the effective
    /// rate, any pending scheduled admin rate is superseded, and
    /// `median_set` + `rate_obs` are emitted.
    pub fn submit_rate(env: Env, reporter: Address, rate_bps: u32) -> Result<(), OracleError> {
        reporter.require_auth();
        let reporters: Vec<Address> = env
            .storage()
            .persistent()
            .get(&KEY_REPORTERS)
            .ok_or(OracleError::NotInitialized)?;
        if !reporters.iter().any(|r| r == reporter) {
            return Err(OracleError::NotReporter);
        }
        if rate_bps > Self::effective_max_rate(&env) {
            return Err(OracleError::RateTooHigh);
        }
        let now = env.ledger().timestamp();
        let mut subs: Map<Address, RateSubmission> = env
            .storage()
            .persistent()
            .get(&KEY_SUBMISSIONS)
            .unwrap_or_else(|| Map::new(&env));
        subs.set(
            reporter.clone(),
            RateSubmission {
                rate_bps,
                submitted_at: now,
            },
        );
        env.storage().persistent().set(&KEY_SUBMISSIONS, &subs);
        env.events()
            .publish((symbol_short!("sub_ok"),), (reporter, rate_bps, now));
        // Finalize when this submission reaches quorum. Recomputed from
        // storage so a burst of submissions in the same ledger converges on
        // one median instead of each one racing.
        let fresh = Self::fresh_submissions(&env, now);
        let quorum = Self::effective_quorum(&env);
        if quorum >= 1 && (fresh.len() as u32) >= quorum {
            Self::finalize_median(&env, &fresh, now);
        }
        Ok(())
    }

    /// Registered reporters, in insertion order.
    pub fn get_reporters(env: Env) -> Vec<Address> {
        env.storage()
            .persistent()
            .get(&KEY_REPORTERS)
            .unwrap_or_else(|| Vec::new(&env))
    }

    /// Reporter-set companion to `get_current_yield_bps` (#1578): the same
    /// effective rate plus quorum/staleness provenance. `stale == true`
    /// means fewer than `quorum` fresh reports exist, so `rate_bps` is the
    /// last finalized value rather than a live median.
    pub fn get_oracle_status(env: Env) -> OracleStatus {
        let now = env.ledger().timestamp();
        let fresh = Self::fresh_submissions(&env, now);
        let quorum = Self::effective_quorum(&env);
        let quorum_met = quorum >= 1 && (fresh.len() as u32) >= quorum;
        OracleStatus {
            rate_bps: Self::effective_rate(&env),
            stale: !quorum_met,
            fresh_reports: fresh.len() as u32,
            quorum,
            reporter_count: Self::reporter_count(&env),
            finalized_at: load_u64(&env, &KEY_OBSERVED_AT, 0),
        }
    }

    /// Effective rate at the current ledger time: the pending rate once its
    /// `effective_at` has passed, otherwise the stored rate. Read-only; due
    /// updates are persisted lazily by the next admin write.
    pub fn get_current_yield_bps(env: Env) -> u32 {
        Self::effective_rate(&env)
    }

    /// Rate plus observation provenance (#1512): additive alongside
    /// `get_current_yield_bps`, which keeps returning just the bare rate.
    /// `observed_at == 0` means no rate has ever been applied on this
    /// instance — callers must treat that as maximally stale, not as a
    /// real timestamp.
    pub fn get_oracle_reading(env: Env) -> OracleReading {
        // Mirror `effective_rate`'s laziness: a due-but-unpersisted scheduled
        // rate is already the effective rate, so its observation timestamp is
        // the moment it became effective, not the older persisted one.
        let pending_at: Option<u64> = env.storage().persistent().get(&KEY_RATE_AT);
        let observed_at = match pending_at {
            Some(at) if env.ledger().timestamp() >= at => at,
            _ => load_u64(&env, &KEY_OBSERVED_AT, 0),
        };
        OracleReading {
            rate_bps: Self::effective_rate(&env),
            observed_at,
            source_version: ORACLE_CONTRACT_VERSION,
        }
    }

    // ── internals ────────────────────────────────────────────────────

    fn effective_rate(env: &Env) -> u32 {
        // #1578: a live median of fresh reports takes precedence over the
        // stored rate whenever quorum is met, so a stale finalized fallback
        // never shadows fresher independent reports. With no reporter set
        // (or below quorum) this degenerates to the pre-#1578 behaviour.
        let now = env.ledger().timestamp();
        let quorum = Self::effective_quorum(env);
        if quorum >= 1 {
            let fresh = Self::fresh_submissions(env, now);
            if (fresh.len() as u32) >= quorum {
                return Self::median_with_outliers(env, &fresh);
            }
        }
        let current: u32 = env.storage().persistent().get(&KEY_RATE).unwrap_or(0);
        let pending: Option<u32> = env.storage().persistent().get(&KEY_PENDING_RATE);
        let at: Option<u64> = env.storage().persistent().get(&KEY_RATE_AT);
        match (pending, at) {
            (Some(p), Some(t)) if now >= t => p,
            _ => current,
        }
    }

    fn reporter_count(env: &Env) -> u32 {
        let reporters: Vec<Address> = env.storage().persistent().get(&KEY_REPORTERS).unwrap_or_else(|| Vec::new(env));
        reporters.len() as u32
    }

    fn effective_quorum(env: &Env) -> u32 {
        load_u32(env, &KEY_QUORUM, 0)
    }

    /// Submissions from registered reporters that are no older than
    /// `max_age_secs`. Keyed by reporter address, so a reporter resubmitting
    /// replaces their previous vote rather than adding a second one.
    fn fresh_submissions(env: &Env, now: u64) -> Map<Address, RateSubmission> {
        let max_age = load_u64(env, &KEY_MAX_AGE, DEFAULT_MAX_AGE_SECS);
        let subs: Map<Address, RateSubmission> = env
            .storage()
            .persistent()
            .get(&KEY_SUBMISSIONS)
            .unwrap_or_else(|| Map::new(env));
        let mut fresh = Map::new(env);
        for (reporter, sub) in subs.iter() {
            if now.saturating_sub(sub.submitted_at) <= max_age {
                fresh.set(reporter, sub);
            }
        }
        fresh
    }

    /// Median of the submission rates. Odd counts take the middle value;
    /// even counts average the two middle values (floor), which keeps the
    /// result inside the reported band for integer bps.
    fn median_of(sorted: &Vec<u32>) -> u32 {
        let n = sorted.len();
        if n == 0 {
            return 0;
        }
        let mid = n / 2;
        if n % 2 == 1 {
            sorted.get(mid).unwrap_or(0)
        } else {
            let lo = sorted.get(mid - 1).unwrap_or(0);
            let hi = sorted.get(mid).unwrap_or(0);
            lo + (hi - lo) / 2
        }
    }

    /// Ascending-order copy of a small rate vector. Insertion sort: the
    /// vector holds at most `MAX_REPORTERS` entries, so O(n²) is cheaper
    /// than the allocation a real sort would need in `no_std`.
    fn sorted_rates(rates: &Vec<u32>) -> Vec<u32> {
        let mut out: Vec<u32> = Vec::new(rates.env());
        for v in rates.iter() {
            let mut pos = out.len();
            while pos > 0 && out.get(pos - 1).unwrap_or(0) > v {
                pos -= 1;
            }
            out.insert(pos, v);
        }
        out
    }

    /// Outlier-filtered median of a fresh report set (#1578): compute the
    /// median of every fresh rate, drop reports further than
    /// `max_deviation_bps` from it, then take the median of the survivors.
    /// When everything is rejected the pre-filter median is returned so a
    /// pathological band cannot zero the rate. `max_deviation_bps == 0`
    /// disables rejection entirely.
    fn median_with_outliers(env: &Env, fresh: &Map<Address, RateSubmission>) -> u32 {
        let mut rates: Vec<u32> = Vec::new(env);
        for (_, sub) in fresh.iter() {
            rates.push_back(sub.rate_bps);
        }
        if rates.is_empty() {
            return 0;
        }
        let sorted = Self::sorted_rates(&rates);
        let pre = Self::median_of(&sorted);
        let max_dev = load_u32(env, &KEY_MAX_DEV, DEFAULT_MAX_DEVIATION_BPS);
        if max_dev == 0 {
            return pre;
        }
        let mut kept: Vec<u32> = Vec::new(env);
        for (_, sub) in fresh.iter() {
            if abs_diff(sub.rate_bps, pre) <= max_dev {
                kept.push_back(sub.rate_bps);
            }
        }
        if kept.is_empty() {
            return pre;
        }
        Self::median_of(&Self::sorted_rates(&kept))
    }

    /// Persist a quorum-reached median as the effective rate (#1578). The
    /// median supersedes any pending scheduled admin rate — the two paths
    /// would otherwise fight over `KEY_RATE` on the next `settle_due` — so
    /// the pending keys are cleared here. Outlier submissions (beyond
    /// `max_deviation_bps` from the pre-filter median) are evented
    /// (`out_rej`) for operator visibility.
    fn finalize_median(env: &Env, fresh: &Map<Address, RateSubmission>, now: u64) {
        let mut rates: Vec<u32> = Vec::new(env);
        for (_, sub) in fresh.iter() {
            rates.push_back(sub.rate_bps);
        }
        let sorted = Self::sorted_rates(&rates);
        let pre = Self::median_of(&sorted);
        let max_dev = load_u32(env, &KEY_MAX_DEV, DEFAULT_MAX_DEVIATION_BPS);
        if max_dev > 0 {
            for (reporter, sub) in fresh.iter() {
                if abs_diff(sub.rate_bps, pre) > max_dev {
                    env.events().publish(
                        (symbol_short!("out_rej"),),
                        (reporter, sub.rate_bps, pre),
                    );
                }
            }
        }
        let median = Self::median_with_outliers(env, fresh);
        env.storage().persistent().set(&KEY_RATE, &median);
        env.storage().persistent().remove(&KEY_PENDING_RATE);
        env.storage().persistent().remove(&KEY_RATE_AT);
        env.storage().persistent().set(&KEY_OBSERVED_AT, &now);
        env.events().publish(
            (symbol_short!("med_set"),),
            (median, fresh.len() as u32, Self::effective_quorum(env)),
        );
        env.events()
            .publish((symbol_short!("rate_obs"),), (median, now));
    }

    fn effective_max_rate(env: &Env) -> u32 {
        let current: u32 = env
            .storage()
            .persistent()
            .get(&KEY_MAX_RATE)
            .unwrap_or(DEFAULT_MAX_YIELD_BPS);
        let pending: Option<u32> = env.storage().persistent().get(&KEY_P_MAX_RATE);
        let at: Option<u64> = env.storage().persistent().get(&KEY_P_PARAMS_AT);
        match (pending, at) {
            (Some(p), Some(t)) if env.ledger().timestamp() >= t => p,
            _ => current,
        }
    }

    fn effective_max_delta(env: &Env) -> u32 {
        let current: u32 = env
            .storage()
            .persistent()
            .get(&KEY_MAX_DELTA)
            .unwrap_or(DEFAULT_MAX_DELTA_BPS);
        let pending: Option<u32> = env.storage().persistent().get(&KEY_P_MAX_DELTA);
        let at: Option<u64> = env.storage().persistent().get(&KEY_P_PARAMS_AT);
        match (pending, at) {
            (Some(p), Some(t)) if env.ledger().timestamp() >= t => p,
            _ => current,
        }
    }

    fn effective_delay(env: &Env) -> u64 {
        let current: u64 = env
            .storage()
            .persistent()
            .get(&KEY_ACT_DELAY)
            .unwrap_or(DEFAULT_ACTIVATION_DELAY_SECS);
        let pending: Option<u64> = env.storage().persistent().get(&KEY_P_DELAY);
        let at: Option<u64> = env.storage().persistent().get(&KEY_P_PARAMS_AT);
        match (pending, at) {
            (Some(p), Some(t)) if env.ledger().timestamp() >= t => p,
            _ => current,
        }
    }

    /// Persist any due scheduled updates. Called at the start of every
    /// admin write so storage converges even though the getters are
    /// read-only.
    fn settle_due(env: &Env) {
        let now = env.ledger().timestamp();
        let rate_at: Option<u64> = env.storage().persistent().get(&KEY_RATE_AT);
        if let Some(at) = rate_at {
            if now >= at {
                if let Some(p) = env
                    .storage()
                    .persistent()
                    .get::<soroban_sdk::Symbol, u32>(&KEY_PENDING_RATE)
                {
                    env.storage().persistent().set(&KEY_RATE, &p);
                    // The observation timestamp is when the scheduled rate
                    // actually became effective (#1512).
                    env.storage().persistent().set(&KEY_OBSERVED_AT, &at);
                    env.events().publish((symbol_short!("rate_appl"),), p);
                    env.events()
                        .publish((symbol_short!("rate_obs"),), (p, at));
                }
                env.storage().persistent().remove(&KEY_PENDING_RATE);
                env.storage().persistent().remove(&KEY_RATE_AT);
            }
        }
        let params_at: Option<u64> = env.storage().persistent().get(&KEY_P_PARAMS_AT);
        if let Some(at) = params_at {
            if now >= at {
                if let Some(p) = env
                    .storage()
                    .persistent()
                    .get::<soroban_sdk::Symbol, u32>(&KEY_P_MAX_RATE)
                {
                    env.storage().persistent().set(&KEY_MAX_RATE, &p);
                }
                if let Some(p) = env
                    .storage()
                    .persistent()
                    .get::<soroban_sdk::Symbol, u32>(&KEY_P_MAX_DELTA)
                {
                    env.storage().persistent().set(&KEY_MAX_DELTA, &p);
                }
                if let Some(p) = env
                    .storage()
                    .persistent()
                    .get::<soroban_sdk::Symbol, u64>(&KEY_P_DELAY)
                {
                    env.storage().persistent().set(&KEY_ACT_DELAY, &p);
                }
                env.events().publish((symbol_short!("par_appl"),), at);
                env.storage().persistent().remove(&KEY_P_MAX_RATE);
                env.storage().persistent().remove(&KEY_P_MAX_DELTA);
                env.storage().persistent().remove(&KEY_P_DELAY);
                env.storage().persistent().remove(&KEY_P_PARAMS_AT);
            }
        }
    }
}

#[cfg(test)]
#[cfg_attr(coverage_nightly, coverage(off))]
mod tests {
    use super::*;
    use soroban_sdk::{Env, testutils::{Address as _, Ledger as _}};

    fn setup(initial_rate: u32) -> (Env, OracleContractClient<'static>) {
        let env = Env::default();
        env.mock_all_auths();
        let contract_id = env.register(OracleContract, ());
        let admin = Address::generate(&env);
        let client = OracleContractClient::new(&env, &contract_id);
        client.initialize(&admin, &initial_rate);
        (env, client)
    }

    #[test]
    fn get_yield_bps_returns_set_rate() {
        let (_env, client) = setup(500);
        assert_eq!(client.get_current_yield_bps(), 500);
    }

    #[test]
    fn initialize_twice_is_rejected() {
        let (env, client) = setup(500);
        let other = Address::generate(&env);
        assert_eq!(
            client.try_initialize(&other, &300),
            Err(Ok(OracleError::AlreadyInitialized))
        );
        assert_eq!(client.get_current_yield_bps(), 500);
    }

    #[test]
    fn set_yield_bps_updates_rate() {
        let (_env, client) = setup(300);
        client.set_yield_bps(&750);
        assert_eq!(client.get_current_yield_bps(), 750);
    }

    #[test]
    fn upgrade_requires_admin_auth() {
        let (env, client) = setup(500);
        env.set_auths(&[]);
        let wasm = soroban_sdk::BytesN::from_array(&env, &[0u8; 32]);
        assert!(client.try_upgrade(&wasm).is_err());
    }

    #[test]
    fn set_yield_bps_above_ceiling_returns_rate_too_high() {
        let (_env, client) = setup(500);
        assert_eq!(
            client.try_set_yield_bps(&(DEFAULT_MAX_YIELD_BPS + 1)),
            Err(Ok(OracleError::RateTooHigh))
        );
        assert_eq!(client.get_current_yield_bps(), 500);
    }

    #[test]
    fn set_yield_bps_u32_max_returns_rate_too_high() {
        let (_env, client) = setup(500);
        assert_eq!(
            client.try_set_yield_bps(&u32::MAX),
            Err(Ok(OracleError::RateTooHigh))
        );
        assert_eq!(client.get_current_yield_bps(), 500);
    }

    #[test]
    fn set_yield_bps_at_ceiling_is_accepted() {
        let (_env, client) = setup(500);
        client.set_yield_bps(&DEFAULT_MAX_YIELD_BPS);
        assert_eq!(client.get_current_yield_bps(), DEFAULT_MAX_YIELD_BPS);
    }

    #[test]
    fn set_max_rate_raises_ceiling_allows_higher_rate() {
        let (_env, client) = setup(500);
        client.set_max_rate(&7_000);
        assert_eq!(client.get_max_yield_bps(), 7_000);
        client.set_yield_bps(&6_000);
        assert_eq!(client.get_current_yield_bps(), 6_000);
    }

    #[test]
    fn set_max_rate_lowers_ceiling_rejects_previously_valid_rate() {
        let (_env, client) = setup(500);
        client.set_max_rate(&1_000);
        assert_eq!(
            client.try_set_yield_bps(&2_000),
            Err(Ok(OracleError::RateTooHigh))
        );
    }

    #[test]
    fn initialize_above_ceiling_returns_rate_too_high() {
        let env = Env::default();
        env.mock_all_auths();
        let contract_id = env.register(OracleContract, ());
        let admin = Address::generate(&env);
        let client = OracleContractClient::new(&env, &contract_id);
        assert_eq!(
            client.try_initialize(&admin, &(DEFAULT_MAX_YIELD_BPS + 1)),
            Err(Ok(OracleError::RateTooHigh))
        );
    }

    #[test]
    fn propose_and_accept_admin_flow() {
        let (env, client) = setup(500);
        let new_admin = Address::generate(&env);

        // Only admin can propose
        env.set_auths(&[]);
        assert!(client.try_propose_admin(&new_admin).is_err());

        env.mock_all_auths();
        client.propose_admin(&new_admin);

        // Only new admin can accept
        env.set_auths(&[]);
        assert!(client.try_accept_admin().is_err());

        env.mock_all_auths();
        client.accept_admin();

        // Verify setting yield bps works (requires new admin auth)
        client.set_yield_bps(&600);
        assert_eq!(client.get_current_yield_bps(), 600);
    }

    #[test]
    fn accept_admin_fails_if_none_pending() {
        let (_env, client) = setup(500);
        assert_eq!(
            client.try_accept_admin(),
            Err(Ok(OracleError::NoPendingAdmin))
        );
    }

    #[test]
    fn set_max_rate_above_hard_ceiling_returns_rate_too_high() {
        let (_env, client) = setup(500);
        assert_eq!(
            client.try_set_max_rate(&(MAX_MAX_RATE_BPS + 1)),
            Err(Ok(OracleError::RateTooHigh))
        );
        assert_eq!(client.get_max_yield_bps(), DEFAULT_MAX_YIELD_BPS);
    }

    #[test]
    fn set_max_rate_at_hard_ceiling_is_accepted() {
        let (_env, client) = setup(500);
        client.set_max_rate(&MAX_MAX_RATE_BPS);
        assert_eq!(client.get_max_yield_bps(), MAX_MAX_RATE_BPS);
    }

    // ── Coverage added for issue #1144 ────────────────────────────────────

    #[test]
    fn set_yield_bps_before_initialize_returns_not_initialized() {
        let env = Env::default();
        env.mock_all_auths();
        let contract_id = env.register(OracleContract, ());
        let client = OracleContractClient::new(&env, &contract_id);

        assert_eq!(
            client.try_set_yield_bps(&500),
            Err(Ok(OracleError::NotInitialized))
        );
    }

    #[test]
    fn set_yield_bps_without_admin_auth_is_rejected() {
        let (env, client) = setup(500);

        // Drop mocked auths so the admin's signature is genuinely required;
        // a non-admin caller cannot supply it.
        env.set_auths(&[]);

        let result = client.try_set_yield_bps(&600);
        assert!(
            result.is_err(),
            "set_yield_bps without the admin's authorization must be rejected"
        );
        assert_eq!(
            client.get_current_yield_bps(),
            500,
            "rate must be unchanged after a rejected call"
        );
    }

    // ── Coverage added for issue #1570 ────────────────────────────────────

    #[test]
    fn delta_violation_is_rejected() {
        let (_env, client) = setup(500);
        client.set_max_delta_bps(&100);
        assert_eq!(
            client.try_set_yield_bps(&700),
            Err(Ok(OracleError::DeltaTooLarge))
        );
        assert_eq!(client.get_current_yield_bps(), 500);
    }

    #[test]
    fn scheduled_rate_applies_at_activation_boundary() {
        let (env, client) = setup(500);
        client.set_max_delta_bps(&1_000);
        client.set_activation_delay(&100);
        env.ledger().with_mut(|li| li.timestamp = 1_000);
        client.set_yield_bps(&900);
        // Before the boundary the old rate is still effective.
        assert_eq!(client.get_current_yield_bps(), 500);
        env.ledger().with_mut(|li| li.timestamp = 1_099);
        assert_eq!(client.get_current_yield_bps(), 500);
        // At exactly effective_at the new rate takes effect.
        env.ledger().with_mut(|li| li.timestamp = 1_100);
        assert_eq!(client.get_current_yield_bps(), 900);
    }

    #[test]
    fn multiple_pending_updates_last_wins() {
        let (env, client) = setup(500);
        client.set_max_delta_bps(&5_000);
        client.set_activation_delay(&100);
        env.ledger().with_mut(|li| li.timestamp = 1_000);
        client.set_yield_bps(&600);
        // A second schedule before activation overwrites the first.
        client.set_yield_bps(&700);
        let schedule = client.get_rate_schedule();
        assert_eq!(schedule.pending, Some(700));
        env.ledger().with_mut(|li| li.timestamp = 1_100);
        assert_eq!(client.get_current_yield_bps(), 700);
    }

    #[test]
    fn emergency_zero_bypasses_delta_and_delay() {
        let (env, client) = setup(500);
        client.set_max_delta_bps(&10);
        client.set_activation_delay(&10_000);
        env.ledger().with_mut(|li| li.timestamp = 1_000);
        // Even a tiny delta would reject a normal move to zero-plus; the
        // emergency path applies immediately and clears the pending update.
        client.set_yield_bps(&505);
        client.set_rate_to_zero();
        assert_eq!(client.get_current_yield_bps(), 0);
        let schedule = client.get_rate_schedule();
        assert_eq!(schedule.pending, None);
    }

    #[test]
    fn param_change_is_delayed_and_readable_via_schedule() {
        let (env, client) = setup(500);
        client.set_activation_delay(&100);
        env.ledger().with_mut(|li| li.timestamp = 2_000);
        client.set_max_delta_bps(&50);
        // Not yet effective.
        assert_eq!(client.get_max_delta_bps(), DEFAULT_MAX_DELTA_BPS);
        let schedule = client.get_rate_schedule();
        assert_eq!(schedule.pending_max_delta, Some(50));
        env.ledger().with_mut(|li| li.timestamp = 2_100);
        assert_eq!(client.get_max_delta_bps(), 50);
    }

    #[test]
    fn delay_above_hard_bound_is_rejected() {
        let (_env, client) = setup(500);
        assert_eq!(
            client.try_set_activation_delay(&(MAX_ACTIVATION_DELAY_SECS + 1)),
            Err(Ok(OracleError::DelayTooLong))
        );
    }

    // ── Freshness metadata (#1512, carried over upstream) ──────────────────

    #[test]
    fn initialize_records_observed_at() {
        let env = Env::default();
        env.mock_all_auths();
        env.ledger().with_mut(|li| li.timestamp = 1_000);
        let contract_id = env.register(OracleContract, ());
        let admin = Address::generate(&env);
        let client = OracleContractClient::new(&env, &contract_id);
        client.initialize(&admin, &500);

        let reading = client.get_oracle_reading();
        assert_eq!(reading.rate_bps, 500);
        assert_eq!(reading.observed_at, 1_000);
        assert_eq!(reading.source_version, ORACLE_CONTRACT_VERSION);
    }

    #[test]
    fn set_yield_bps_updates_observed_at() {
        let env = Env::default();
        env.mock_all_auths();
        env.ledger().with_mut(|li| li.timestamp = 1_000);
        let contract_id = env.register(OracleContract, ());
        let admin = Address::generate(&env);
        let client = OracleContractClient::new(&env, &contract_id);
        client.initialize(&admin, &500);

        env.ledger().with_mut(|li| li.timestamp = 2_500);
        client.set_yield_bps(&750);

        let reading = client.get_oracle_reading();
        assert_eq!(reading.rate_bps, 750);
        assert_eq!(reading.observed_at, 2_500);
    }

    #[test]
    fn get_oracle_reading_before_initialize_reports_no_observation() {
        let env = Env::default();
        env.mock_all_auths();
        let contract_id = env.register(OracleContract, ());
        let client = OracleContractClient::new(&env, &contract_id);

        let reading = client.get_oracle_reading();
        assert_eq!(reading.rate_bps, 0);
        assert_eq!(
            reading.observed_at, 0,
            "no set_yield_bps/initialize call has ever landed — observed_at must read as 0, not a real timestamp"
        );
    }

    #[test]
    fn set_yield_bps_rejected_above_ceiling_leaves_observed_at_unchanged() {
        let env = Env::default();
        env.mock_all_auths();
        env.ledger().with_mut(|li| li.timestamp = 1_000);
        let contract_id = env.register(OracleContract, ());
        let admin = Address::generate(&env);
        let client = OracleContractClient::new(&env, &contract_id);
        client.initialize(&admin, &500);

        env.ledger().with_mut(|li| li.timestamp = 9_999);
        let _ = client.try_set_yield_bps(&(DEFAULT_MAX_YIELD_BPS + 1));

        let reading = client.get_oracle_reading();
        assert_eq!(
            reading.observed_at, 1_000,
            "a rejected update must not move the observation timestamp"
        );
    }

    #[test]
    fn delayed_rate_reports_observed_at_at_activation() {
        let (env, client) = setup(500);
        env.ledger().with_mut(|li| li.timestamp = 1_000);
        client.set_activation_delay(&100);
        // A param change is not a rate observation — observed_at is still
        // whatever initialize recorded.
        assert_eq!(client.get_oracle_reading().observed_at, 0);

        env.ledger().with_mut(|li| li.timestamp = 2_000);
        client.set_yield_bps(&600);
        // Scheduled, not yet effective: still the older observation.
        let reading = client.get_oracle_reading();
        assert_eq!(reading.rate_bps, 500);
        assert_eq!(reading.observed_at, 0);

        env.ledger().with_mut(|li| li.timestamp = 2_100);
        let reading = client.get_oracle_reading();
        assert_eq!(reading.rate_bps, 600);
        assert_eq!(
            reading.observed_at, 2_100,
            "a due scheduled rate's observation timestamp is its activation time"
        );
    }

    #[test]
    fn emergency_zero_records_observed_at() {
        let (env, client) = setup(500);
        env.ledger().with_mut(|li| li.timestamp = 5_000);
        client.set_rate_to_zero();
        let reading = client.get_oracle_reading();
        assert_eq!(reading.rate_bps, 0);
        assert_eq!(reading.observed_at, 5_000);
    }

    // ── Multi-reporter median aggregation (#1578) ────────────────────────

    /// Fixture with `n` reporters added and quorum set to `quorum`.
    fn reporter_setup(
        initial_rate: u32,
        n: u32,
        quorum: u32,
    ) -> (Env, OracleContractClient<'static>, Address, Vec<Address>) {
        let (env, client) = setup(initial_rate);
        client.set_quorum(&quorum);
        let mut reporters = Vec::new(&env);
        for _ in 0..n {
            let r = Address::generate(&env);
            client.add_reporter(&r);
            reporters.push_back(r);
        }
        let first = client.get_reporters().get(0).unwrap();
        (env, client, first, reporters)
    }

    #[test]
    fn add_and_remove_reporter_updates_set() {
        let (env, client) = setup(500);
        let r1 = Address::generate(&env);
        let r2 = Address::generate(&env);
        client.add_reporter(&r1);
        client.add_reporter(&r2);
        assert_eq!(client.get_reporters().len(), 2);
        client.remove_reporter(&r1);
        let remaining = client.get_reporters();
        assert_eq!(remaining.len(), 1);
        assert_eq!(remaining.get(0).unwrap(), r2);
    }

    #[test]
    fn add_duplicate_reporter_is_rejected() {
        let (env, client) = setup(500);
        let r = Address::generate(&env);
        client.add_reporter(&r);
        assert_eq!(
            client.try_add_reporter(&r),
            Err(Ok(OracleError::ReporterExists))
        );
    }

    #[test]
    fn reporter_set_is_bounded() {
        let (env, client) = setup(500);
        for _ in 0..MAX_REPORTERS {
            client.add_reporter(&Address::generate(&env));
        }
        assert_eq!(
            client.try_add_reporter(&Address::generate(&env)),
            Err(Ok(OracleError::ReporterLimitReached))
        );
    }

    #[test]
    fn remove_unknown_reporter_is_rejected() {
        let (env, client) = setup(500);
        assert_eq!(
            client.try_remove_reporter(&Address::generate(&env)),
            Err(Ok(OracleError::NotInitialized))
        );
    }

    #[test]
    fn quorum_bounds_are_enforced() {
        let (_env, client) = setup(500);
        assert_eq!(client.try_set_quorum(&0), Err(Ok(OracleError::InvalidQuorum)));
        assert_eq!(
            client.try_set_quorum(&(MAX_REPORTERS + 1)),
            Err(Ok(OracleError::InvalidQuorum))
        );
        client.set_quorum(&MAX_REPORTERS);
    }

    #[test]
    fn submit_by_non_reporter_is_rejected() {
        let (env, client) = setup(500);
        client.set_quorum(&1);
        let registered = Address::generate(&env);
        client.add_reporter(&registered);
        let outsider = Address::generate(&env);
        assert_eq!(
            client.try_submit_rate(&outsider, &400),
            Err(Ok(OracleError::NotReporter))
        );
        // Also with no reporter set configured at all.
        let (env2, client2) = setup(500);
        assert_eq!(
            client2.try_submit_rate(&Address::generate(&env2), &400),
            Err(Ok(OracleError::NotInitialized))
        );
    }

    #[test]
    fn submit_above_ceiling_is_rejected() {
        let (env, client) = setup(500);
        client.set_quorum(&1);
        let r = Address::generate(&env);
        client.add_reporter(&r);
        assert_eq!(
            client.try_submit_rate(&r, &(DEFAULT_MAX_YIELD_BPS + 1)),
            Err(Ok(OracleError::RateTooHigh))
        );
    }

    #[test]
    fn odd_quorum_finalizes_median() {
        let (env, client, _, reporters) = reporter_setup(500, 3, 3);
        env.ledger().with_mut(|li| li.timestamp = 1_000);
        client.submit_rate(&reporters.get(0).unwrap(), &300);
        // Below quorum: still the admin-initialized rate, flagged stale.
        assert_eq!(client.get_current_yield_bps(), 500);
        let status = client.get_oracle_status();
        assert!(status.stale);
        assert_eq!(status.fresh_reports, 1);

        client.submit_rate(&reporters.get(1).unwrap(), &500);
        client.submit_rate(&reporters.get(2).unwrap(), &700);
        // Median of {300, 500, 700} is 500 — and quorum is met.
        assert_eq!(client.get_current_yield_bps(), 500);
        let status = client.get_oracle_status();
        assert!(!status.stale);
        assert_eq!(status.fresh_reports, 3);
        assert_eq!(status.finalized_at, 1_000);
        // The finalized median was persisted.
        let schedule = client.get_rate_schedule();
        assert_eq!(schedule.current, 500);
    }

    #[test]
    fn even_quorum_averages_two_middle_values() {
        let (env, client, _, reporters) = reporter_setup(500, 4, 4);
        client.submit_rate(&reporters.get(0).unwrap(), &100);
        client.submit_rate(&reporters.get(1).unwrap(), &200);
        client.submit_rate(&reporters.get(2).unwrap(), &800);
        client.submit_rate(&reporters.get(3).unwrap(), &900);
        // Median of {100, 200, 800, 900} = (200 + 800) / 2 = 500.
        assert_eq!(client.get_current_yield_bps(), 500);
    }

    #[test]
    fn outlier_is_excluded_from_finalized_median() {
        let (env, client, _, reporters) = reporter_setup(500, 3, 3);
        client.set_max_deviation_bps(&100);
        // Pre-filter median of {480, 500, 900} is 500; 900 is 400 away.
        client.submit_rate(&reporters.get(0).unwrap(), &480);
        client.submit_rate(&reporters.get(1).unwrap(), &500);
        client.submit_rate(&reporters.get(2).unwrap(), &900);
        // Median of the survivors {480, 500} is 490, not dragged by 900.
        assert_eq!(client.get_current_yield_bps(), 490);
    }

    #[test]
    fn zero_max_deviation_disables_outlier_rejection() {
        let (env, client, _, reporters) = reporter_setup(500, 3, 3);
        client.set_max_deviation_bps(&0);
        client.set_max_rate(&10_000);
        client.submit_rate(&reporters.get(0).unwrap(), &100);
        client.submit_rate(&reporters.get(1).unwrap(), &500);
        client.submit_rate(&reporters.get(2).unwrap(), &9_000);
        // Nothing is rejected: median of {100, 500, 9000} is 500, and the
        // far-flung 9000 participated in the computation (with rejection
        // enabled at a tight band it would have been dropped instead).
        assert_eq!(client.get_current_yield_bps(), 500);
        // Control: with a 400 bps band the far-flung 9000 is excluded and
        // the median of the survivors {100, 500} is 300.
        client.set_max_deviation_bps(&400);
        client.submit_rate(&reporters.get(0).unwrap(), &100);
        client.submit_rate(&reporters.get(1).unwrap(), &500);
        client.submit_rate(&reporters.get(2).unwrap(), &9_000);
        assert_eq!(client.get_current_yield_bps(), 300);
    }

    #[test]
    fn stale_submissions_fall_back_to_last_finalized() {
        let (env, client, _, reporters) = reporter_setup(500, 2, 2);
        client.set_max_age_secs(&100);
        client.submit_rate(&reporters.get(0).unwrap(), &600);
        client.submit_rate(&reporters.get(1).unwrap(), &700);
        // Median of {600, 700} = 650, finalized.
        assert_eq!(client.get_current_yield_bps(), 650);

        // Past max_age everything is stale: fall back to the finalized 650.
        env.ledger().with_mut(|li| li.timestamp = 500);
        assert_eq!(client.get_current_yield_bps(), 650);
        let status = client.get_oracle_status();
        assert!(status.stale);
        assert_eq!(status.fresh_reports, 0);
        assert_eq!(status.rate_bps, 650);
    }

    #[test]
    fn all_reporters_stale_is_flagged_stale() {
        let (env, client, _, reporters) = reporter_setup(500, 3, 2);
        client.set_max_age_secs(&60);
        client.submit_rate(&reporters.get(0).unwrap(), &510);
        client.submit_rate(&reporters.get(1).unwrap(), &520);
        assert!(!client.get_oracle_status().stale);
        env.ledger().with_mut(|li| li.timestamp = 1_000_000);
        let status = client.get_oracle_status();
        assert!(status.stale);
        assert_eq!(status.fresh_reports, 0);
    }

    #[test]
    fn reporter_removal_drops_their_submission() {
        let (env, client, _, reporters) = reporter_setup(500, 3, 3);
        client.submit_rate(&reporters.get(0).unwrap(), &400);
        client.submit_rate(&reporters.get(1).unwrap(), &500);
        client.submit_rate(&reporters.get(2).unwrap(), &600);
        assert_eq!(client.get_current_yield_bps(), 500);

        // Removing the middle reporter drops their vote; the fresh count
        // falls below quorum so the rate freezes at the last finalized 500.
        client.remove_reporter(&reporters.get(1).unwrap());
        let status = client.get_oracle_status();
        assert!(status.stale);
        assert_eq!(status.fresh_reports, 2);
        assert_eq!(client.get_current_yield_bps(), 500);

        // The removed reporter can no longer submit.
        assert_eq!(
            client.try_submit_rate(&reporters.get(1).unwrap(), &500),
            Err(Ok(OracleError::NotReporter))
        );
    }

    #[test]
    fn reporter_rotation_mid_round_leaves_no_ghost_vote() {
        let (env, client, _, reporters) = reporter_setup(500, 2, 2);
        client.set_max_deviation_bps(&0);
        client.submit_rate(&reporters.get(0).unwrap(), &400);
        // Rotate: remove reporter 0 (dropping their 400), add reporter 2.
        client.remove_reporter(&reporters.get(0).unwrap());
        let fresh_reporter = Address::generate(&env);
        client.add_reporter(&fresh_reporter);
        // Only reporter 1's 600 is live: below quorum, stale, rate unchanged.
        client.submit_rate(&reporters.get(1).unwrap(), &600);
        assert!(client.get_oracle_status().stale);
        // New reporter completes quorum; median is {600, 700}, not {400,...}.
        client.submit_rate(&fresh_reporter, &700);
        assert_eq!(client.get_current_yield_bps(), 650);
    }

    #[test]
    fn resubmission_replaces_previous_vote() {
        let (env, client, _, reporters) = reporter_setup(500, 2, 2);
        client.set_max_deviation_bps(&0);
        client.submit_rate(&reporters.get(0).unwrap(), &100);
        client.submit_rate(&reporters.get(0).unwrap(), &700);
        client.submit_rate(&reporters.get(1).unwrap(), &500);
        // The 100 was replaced by 700: median of {500, 700} is 600.
        assert_eq!(client.get_current_yield_bps(), 600);
        let status = client.get_oracle_status();
        assert_eq!(status.fresh_reports, 2);
    }

    #[test]
    fn median_supersedes_pending_scheduled_admin_rate() {
        let (env, client, _, reporters) = reporter_setup(500, 2, 2);
        client.set_max_deviation_bps(&0);
        client.set_activation_delay(&100);
        env.ledger().with_mut(|li| li.timestamp = 1_000);
        client.set_yield_bps(&900); // scheduled, not yet effective
        client.submit_rate(&reporters.get(0).unwrap(), &400);
        client.submit_rate(&reporters.get(1).unwrap(), &400);
        // Median 400 finalized and persisted; the pending 900 is cleared so
        // a later settle_due cannot resurrect it over the median.
        assert_eq!(client.get_current_yield_bps(), 400);
        let schedule = client.get_rate_schedule();
        assert_eq!(schedule.pending, None);
        env.ledger().with_mut(|li| li.timestamp = 2_000);
        assert_eq!(client.get_current_yield_bps(), 400);
    }

    #[test]
    fn reporter_mode_inactive_keeps_legacy_behaviour() {
        // No reporters, no quorum: everything behaves exactly as before
        // #1578, including the admin schedule and delta bound.
        let (env, client) = setup(500);
        assert_eq!(client.get_oracle_status().stale, true);
        assert_eq!(client.get_oracle_status().reporter_count, 0);
        client.set_max_delta_bps(&100);
        assert_eq!(
            client.try_set_yield_bps(&700),
            Err(Ok(OracleError::DeltaTooLarge))
        );
        client.set_yield_bps(&600);
        assert_eq!(client.get_current_yield_bps(), 600);
    }

    #[test]
    fn single_reporter_quorum_works() {
        let (env, client, _, reporters) = reporter_setup(500, 1, 1);
        client.submit_rate(&reporters.get(0).unwrap(), &420);
        assert_eq!(client.get_current_yield_bps(), 420);
        assert!(!client.get_oracle_status().stale);
    }

    #[test]
    fn quorum_above_reporter_count_stays_stale() {
        let (env, client, _, reporters) = reporter_setup(500, 2, 3);
        client.submit_rate(&reporters.get(0).unwrap(), &400);
        client.submit_rate(&reporters.get(1).unwrap(), &400);
        assert!(client.get_oracle_status().stale);
        assert_eq!(client.get_current_yield_bps(), 500);
    }

    #[test]
    fn submit_rate_requires_reporter_auth() {
        let (env, client) = setup(500);
        client.set_quorum(&1);
        let r = Address::generate(&env);
        client.add_reporter(&r);
        env.set_auths(&[]);
        assert!(client.try_submit_rate(&r, &400).is_err());
    }
}
