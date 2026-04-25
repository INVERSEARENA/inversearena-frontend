#![no_std]

use soroban_sdk::{
    Address, BytesN, Env, IntoVal, String, Symbol, Vec, contract, contracterror, contractimpl,
    contracttype, symbol_short, token, xdr::ToXdr,
};
#[path = "../../shared/admin_transfer.rs"]
mod admin_transfer_utils;
#[path = "../../shared/upgrade.rs"]
mod upgrade_utils;
use admin_transfer_utils::{
    AdminTransferErrors, AdminTransferKeys, accept_admin_transfer as accept_admin_transfer_flow,
    cancel_admin_transfer as cancel_admin_transfer_flow,
    pending_admin_transfer as pending_admin_transfer_flow,
    propose_admin_transfer as propose_admin_transfer_flow,
};
use upgrade_utils::{
    ExecuteTimePolicy, UpgradeErrors, UpgradeKeys, UpgradeTopics,
    cancel_upgrade as cancel_upgrade_flow, execute_upgrade as execute_upgrade_flow,
    pending_upgrade as pending_upgrade_flow, propose_upgrade as propose_upgrade_flow,
};

#[cfg(test)]
use arena::ArenaContract;

// ── Storage keys ─────────────────────────────────────────────────────────────

const ADMIN_KEY: Symbol = symbol_short!("ADMIN");
const PENDING_ADMIN_KEY: Symbol = symbol_short!("P_ADMIN");
const ADMIN_EXPIRY_KEY: Symbol = symbol_short!("A_EXP");
const PENDING_HASH_KEY: Symbol = symbol_short!("P_HASH");
const EXECUTE_AFTER_KEY: Symbol = symbol_short!("P_AFTER");

const ADMIN_TRANSFER_EXPIRY: u64 = 7 * 24 * 60 * 60;
const WHITELIST_PREFIX: Symbol = symbol_short!("WL");
const MIN_STAKE_KEY: Symbol = symbol_short!("MIN_STK");
const ARENA_WASM_HASH_KEY: Symbol = symbol_short!("AR_WASM");
const POOL_COUNT_KEY: Symbol = symbol_short!("P_CNT");
const SCHEMA_VERSION_KEY: Symbol = symbol_short!("S_VER");
const PAUSED_KEY: Symbol = symbol_short!("PAUSED");
const TOKEN_COUNT_KEY: Symbol = symbol_short!("TOK_CNT");
const MAX_PLAYERS_CAP_KEY: Symbol = symbol_short!("MAX_PLR");
const STAKING_CONTRACT_KEY: Symbol = symbol_short!("STAKING");
const MIN_HOST_STAKE_KEY: Symbol = symbol_short!("HST_MIN");

// ── Fee timelock storage keys ─────────────────────────────────────────────────
const WIN_FEE_BPS_KEY: Symbol = symbol_short!("FEE_BPS");
const PENDING_FEE_KEY: Symbol = symbol_short!("P_FEE");
const FEE_AFTER_KEY: Symbol = symbol_short!("F_AFTER");

// ── Arena creation fee config ─────────────────────────────────────────────────
const CREATION_FEE_KEY: Symbol = symbol_short!("CR_FEE");
const CREATION_TOKEN_KEY: Symbol = symbol_short!("CR_TOK");
const CREATION_FEE_ACCUM_KEY: Symbol = symbol_short!("CR_ACC");
const WIN_FEE_ACCUM_KEY: Symbol = symbol_short!("WIN_ACC");

/// Current schema version. Bump this when storage layout changes.
const CURRENT_SCHEMA_VERSION: u32 = 1;

// ── Fee constants ─────────────────────────────────────────────────────────────
/// 24-hour timelock for fee config changes (seconds).
const FEE_TIMELOCK_PERIOD: u64 = 24 * 60 * 60;
/// Default platform win fee: 2% (200 basis points).
pub const DEFAULT_WIN_FEE_BPS: u32 = 200;
/// Maximum allowed win fee: 20% (2000 basis points).
pub const MAX_WIN_FEE_BPS: u32 = 1_000;

#[contracttype]
#[derive(Clone, Debug, PartialEq)]
pub struct ArenaMetadata {
    pub pool_id: u32,
    pub creator: Address,
    pub capacity: u32,
    pub stake_amount: i128,
    /// Platform win fee in basis points, snapshotted at arena creation time.
    /// Payout uses this value, not the current global fee, so fee changes
    /// cannot retroactively affect active arenas.
    pub win_fee_bps: u32,
}

#[contracttype]
#[derive(Clone, Debug, PartialEq)]
pub struct FeeConfig {
    pub creation_fee: i128,
    pub win_fee_bps: u32,
}

#[contracttype]
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum ArenaStatus {
    Pending,
    Active,
    Completed,
    Cancelled,
}

#[contracttype]
#[derive(Clone, Debug, PartialEq)]
pub struct ArenaRef {
    pub contract: Address,
    pub status: ArenaStatus,
    pub host: Address,
}

#[contracttype]
#[derive(Clone, Debug, PartialEq)]
pub struct CreateArenaConfig {
    pub stake_amount: i128,
    pub currency: Address,
    pub round_speed: u32,
    pub capacity: u32,
    pub join_deadline: u64,
}

#[contracttype]
#[derive(Clone, Debug, PartialEq)]
pub struct ArenaSummary {
    pub arena_id: u64,
    pub contract: Address,
    pub status: ArenaStatus,
    pub host: Address,
}

#[contracttype]
#[derive(Clone, Debug, PartialEq)]
pub struct ArenaPage {
    pub items: Vec<ArenaSummary>,
    pub next_cursor: Option<u64>,
    pub has_more: bool,
}

// ── Capacity limits ───────────────────────────────────────────────────────────

const MAX_POOL_CAPACITY: u32 = 256;
const MAX_PAGE_SIZE: u32 = 50;
const MAX_CURSOR_PAGE_SIZE: u32 = 100;

// ── Player-cap (DoS hardening, see issue #495) ────────────────────────────────
//
// `resolve_round()` iterates over every registered player, so an unbounded
// `max_players` lets a malicious host exhaust the Soroban CPU budget and
// permanently lock entry fees. Enforce a protocol-wide hard cap in the factory
// — the host's per-arena `capacity` is always validated against
// `max_players_cap()` before deployment, regardless of what the host or
// downstream arena contract permit.

/// Default value of the configurable player cap (used when storage is unset).
pub const MAX_PLAYERS_HARD_CAP: u32 = 64;
/// Absolute upper bound for `set_max_players_cap` — the admin can never raise
/// the cap above this, even via governance, so the DoS surface stays bounded.
pub const MAX_PLAYERS_ABSOLUTE_CAP: u32 = 128;

#[contracttype]
#[derive(Clone)]
pub enum DataKey {
    SupportedToken(Address),
    Pool(u32),
    ArenaRef(u64),
    ArenaWhitelist(u64, Address),
}

// ── Timelock constant: 48 hours in seconds ────────────────────────────────────

const TIMELOCK_PERIOD: u64 = 48 * 60 * 60;
const REGISTRY_TTL_THRESHOLD: u32 = 100_000;
const REGISTRY_TTL_EXTEND_TO: u32 = 535_680;

// ── Minimum stake: 10 XLM in stroops ──────────────────────────────────────────

const DEFAULT_MIN_STAKE: i128 = 10_000_000;

// ── Event topics ──────────────────────────────────────────────────────────────

const TOPIC_UPGRADE_PROPOSED: Symbol = symbol_short!("UP_PROP");
const TOPIC_UPGRADE_EXECUTED: Symbol = symbol_short!("UP_EXEC");
const TOPIC_UPGRADE_CANCELLED: Symbol = symbol_short!("UP_CANC");
const TOPIC_ADMIN_PROPOSED: Symbol = symbol_short!("AD_PROP");
const TOPIC_ADMIN_ACCEPTED: Symbol = symbol_short!("AD_DONE");
const TOPIC_ADMIN_CANCELLED: Symbol = symbol_short!("AD_CANC");
const TOPIC_POOL_CREATED: Symbol = symbol_short!("POOL_CRE");
const TOPIC_HOST_WHITELISTED: Symbol = symbol_short!("WL_ADD");
const TOPIC_HOST_REMOVED: Symbol = symbol_short!("WL_REM");
const TOPIC_ADMIN_CHANGED: Symbol = symbol_short!("ADM_CHG");
const TOPIC_WASM_UPDATED: Symbol = symbol_short!("WASM_UP");
const TOPIC_TOKEN_ADDED: Symbol = symbol_short!("TOK_ADD");
const TOPIC_TOKEN_REMOVED: Symbol = symbol_short!("TOK_REM");
const TOPIC_TOKEN_WL_UPDATED: Symbol = symbol_short!("TOK_WLUP");
const TOPIC_MIN_STAKE_UPDATED: Symbol = symbol_short!("MIN_UP");
const TOPIC_PAUSED: Symbol = symbol_short!("PAUSED");
const TOPIC_UNPAUSED: Symbol = symbol_short!("UNPAUSED");
const TOPIC_ARENA_WL_ADD: Symbol = symbol_short!("AWL_ADD");
const TOPIC_ARENA_WL_REM: Symbol = symbol_short!("AWL_REM");
const TOPIC_FEE_QUEUED: Symbol = symbol_short!("FEE_Q");
const TOPIC_FEE_EXECUTED: Symbol = symbol_short!("FEE_EX");
const TOPIC_FEE_CANCELLED: Symbol = symbol_short!("FEE_CAN");
const TOPIC_FEE_CONFIG_UPDATED: Symbol = symbol_short!("CRF_UP");
const TOPIC_ARENA_CREATED: Symbol = symbol_short!("ARNA_CRE");
const TOPIC_FEES_WITHDRAWN: Symbol = symbol_short!("FEE_WD");

/// Event payload version. Include in every event data tuple so consumers
/// can detect schema changes without re-deploying indexers.
const EVENT_VERSION: u32 = 1;

// ── Error codes ───────────────────────────────────────────────────────────────
//
// All public write entrypoints return `Result<_, Error>` so callers receive a
// machine-readable error code instead of an opaque panic string. This makes
// client-side error handling deterministic and testable.

#[contracterror]
#[derive(Copy, Clone, Debug, Eq, PartialEq, PartialOrd, Ord)]
#[repr(u32)]
pub enum Error {
    /// Contract has not been initialised yet.
    NotInitialized = 1,
    /// Contract was already initialised; `initialize` may only be called once.
    AlreadyInitialized = 2,
    /// Caller lacks permission for this operation.
    Unauthorized = 3,
    /// `execute_upgrade` or `cancel_upgrade` called without a pending proposal.
    NoPendingUpgrade = 4,
    /// `execute_upgrade` called before the 48-hour timelock has elapsed.
    TimelockNotExpired = 5,
    /// Provided stake is non-zero but below the configured minimum.
    StakeBelowMinimum = 6,
    /// Caller is not on the host whitelist.
    HostNotWhitelisted = 7,
    /// Stake amount is zero or negative.
    InvalidStakeAmount = 8,
    /// A pool with the given `pool_id` was already registered.
    PoolAlreadyExists = 9,
    /// Pool capacity is below 2 or exceeds `MAX_POOL_CAPACITY`.
    InvalidCapacity = 10,
    /// `create_pool` called before `set_arena_wasm_hash` has been called.
    WasmHashNotSet = 11,
    /// Pending upgrade state is only partially present.
    MalformedUpgradeState = 12,
    /// `create_pool` called with a token that has not been added via `add_supported_token`.
    UnsupportedToken = 13,
    /// `propose_upgrade` called while a pending upgrade proposal already exists.
    UpgradeAlreadyPending = 14,
    /// Contract is paused; write operations are disabled.
    Paused = 15,
    /// The requested arena was not found.
    ArenaNotFound = 16,
    /// Provided WASM hash does not match the stored pending hash.
    HashMismatch = 17,
    /// `execute_fee_update` called before the 24-hour fee timelock has elapsed.
    FeeTimelockNotExpired = 18,
    /// `propose_fee_update` called while a pending fee update already exists.
    FeeAlreadyPending = 19,
    /// `execute_fee_update` or `cancel_fee_update` with no pending fee update.
    NoPendingFeeUpdate = 20,
    /// Provided fee exceeds `MAX_WIN_FEE_BPS` (1000).
    FeeTooHigh = 21,
    /// Creation fee amount is negative.
    InvalidCreationFee = 22,
    /// Host does not hold enough `fee_token` to pay the configured creation fee.
    InsufficientCreationFee = 23,
    /// Token is not currently on the allowed whitelist.
    TokenNotAllowed = 24,
    /// Removing the token would leave whitelist empty.
    EmptyTokenWhitelist = 25,
    /// Token address does not expose the expected SAC interface.
    InvalidTokenContract = 26,
    /// Requested `capacity` exceeds the protocol-wide player cap. See issue #495.
    ExceedsPlayerCap = 27,
    /// `set_max_players_cap` called with a value outside `[2, MAX_PLAYERS_ABSOLUTE_CAP]`.
    InvalidPlayerCap = 28,
    /// No pending admin transfer exists.
    NoPendingAdminTransfer = 29,
    /// Pending admin transfer has expired (7-day window elapsed).
    AdminTransferExpired = 30,
    /// Staking contract not set.
    StakingContractNotSet = 31,
    /// Host staked balance below configured minimum host stake.
    HostStakeInsufficient = 32,
    /// Arithmetic overflow in fee calculation/accumulation.
    ArithmeticOverflow = 33,
}

// ── Contract ──────────────────────────────────────────────────────────────────

#[contract]
pub struct FactoryContract;

#[contractimpl]
impl FactoryContract {
    /// Initialise the contract, setting the admin address.
    /// Must be called exactly once after deployment.
    ///
    /// # Arguments
    /// * `env` - The Soroban environment.
    /// * `admin` - Address to designate as the contract administrator.
    ///
    /// # Errors
    /// * [`Error::AlreadyInitialized`] — contract has already been initialised.
    ///
    /// # Authorization
    /// Requires auth from the admin address to prevent front-running.
    pub fn __constructor(env: Env, admin: Address) -> Result<(), Error> {
        admin.require_auth();
        env.storage().instance().set(&ADMIN_KEY, &admin);
        env.storage()
            .instance()
            .set(&MIN_STAKE_KEY, &DEFAULT_MIN_STAKE);
        env.storage()
            .instance()
            .set(&MIN_HOST_STAKE_KEY, &DEFAULT_MIN_STAKE);
        env.storage()
            .instance()
            .set(&WIN_FEE_BPS_KEY, &DEFAULT_WIN_FEE_BPS);
        // Default creation fee is 0 (disabled) with a placeholder token address.
        // Admin should call `set_creation_fee` to configure the actual token.
        env.storage().instance().set(&CREATION_FEE_KEY, &0i128);
        env.storage()
            .instance()
            .set(&CREATION_TOKEN_KEY, &env.current_contract_address());
        env.storage()
            .instance()
            .set(&CREATION_FEE_ACCUM_KEY, &0i128);
        env.storage().instance().set(&WIN_FEE_ACCUM_KEY, &0i128);
        env.storage()
            .instance()
            .set(&SCHEMA_VERSION_KEY, &CURRENT_SCHEMA_VERSION);
        env.storage().instance().set(&TOKEN_COUNT_KEY, &0u32);
        Ok(())
    }

    // ── Schema versioning ────────────────────────────────────────────────────

    /// Return the persisted schema version (0 if never set).
    pub fn schema_version(env: Env) -> u32 {
        env.storage()
            .instance()
            .get(&SCHEMA_VERSION_KEY)
            .unwrap_or(0u32)
    }

    /// Migrate storage from the current persisted version to
    /// `CURRENT_SCHEMA_VERSION`. Admin-only.
    ///
    /// Each version bump should have its own migration block inside
    /// this function. The version is written atomically at the end so
    /// a failed transaction leaves the old version in place.
    ///
    /// Calling `migrate` when already at the current version is a no-op.
    pub fn migrate(env: Env) -> Result<(), Error> {
        let admin = require_admin(&env)?;
        admin.require_auth();

        let stored: u32 = env
            .storage()
            .instance()
            .get(&SCHEMA_VERSION_KEY)
            .unwrap_or(0u32);

        if stored >= CURRENT_SCHEMA_VERSION {
            return Ok(()); // already up to date
        }

        // -- v0 -> v1: initial version stamp (no data changes) ------
        // Future migrations go here as sequential if-blocks:
        //   if stored < 2 { /* v1 -> v2 migration logic */ }

        env.storage()
            .instance()
            .set(&SCHEMA_VERSION_KEY, &CURRENT_SCHEMA_VERSION);
        Ok(())
    }

    /// Return the current admin address.
    ///
    /// # Arguments
    /// * `env` - The Soroban environment.
    ///
    /// # Errors
    /// * [`Error::NotInitialized`] — `initialize` has not been called.
    ///
    /// # Authorization
    /// None — read-only, open to any caller.
    pub fn admin(env: Env) -> Result<Address, Error> {
        require_admin(&env)
    }

    /// Set a new admin address. Only the current admin can call this.
    ///
    /// # Errors
    /// * [`Error::NotInitialized`] — contract not initialised.
    pub fn set_admin(env: Env, new_admin: Address) -> Result<(), Error> {
        let admin = require_admin(&env)?;
        admin.require_auth();
        env.storage().instance().set(&ADMIN_KEY, &new_admin);
        env.events()
            .publish((TOPIC_ADMIN_CHANGED,), (EVENT_VERSION, admin, new_admin));
        Ok(())
    }

    /// Set the WASM hash for arena contract deployment. Admin-only.
    ///
    /// # Errors
    /// * [`Error::NotInitialized`] — contract not initialised.
    pub fn set_arena_wasm_hash(env: Env, wasm_hash: BytesN<32>) -> Result<(), Error> {
        let admin = require_admin(&env)?;
        admin.require_auth();
        let previous_hash: Option<BytesN<32>> = env.storage().instance().get(&ARENA_WASM_HASH_KEY);
        env.storage()
            .instance()
            .set(&ARENA_WASM_HASH_KEY, &wasm_hash);
        env.events().publish(
            (TOPIC_WASM_UPDATED,),
            (EVENT_VERSION, previous_hash, wasm_hash),
        );
        Ok(())
    }

    /// Add a host address to the whitelist. Admin-only.
    /// Emits `HostWhitelisted(address)`.
    ///
    /// # Errors
    /// * [`Error::NotInitialized`] — contract not initialised.
    pub fn add_host_to_whitelist(env: Env, host: Address) -> Result<(), Error> {
        let admin = require_admin(&env)?;
        admin.require_auth();
        let key = (WHITELIST_PREFIX, host.clone());
        env.storage().instance().set(&key, &true);
        env.events()
            .publish((TOPIC_HOST_WHITELISTED,), (EVENT_VERSION, host));
        Ok(())
    }

    /// Remove a host address from the whitelist. Admin-only.
    /// Emits `HostRemoved(address)`.
    ///
    /// # Errors
    /// * [`Error::NotInitialized`] — contract not initialised.
    pub fn remove_host_from_whitelist(env: Env, host: Address) -> Result<(), Error> {
        let admin = require_admin(&env)?;
        admin.require_auth();
        let key = (WHITELIST_PREFIX, host.clone());
        env.storage().instance().remove(&key);
        env.events()
            .publish((TOPIC_HOST_REMOVED,), (EVENT_VERSION, host));
        Ok(())
    }

    /// Check if an address is whitelisted.
    ///
    /// # Errors
    /// * [`Error::NotInitialized`] — contract not initialised.
    pub fn is_host_whitelisted(env: Env, host: Address) -> Result<bool, Error> {
        let key = (WHITELIST_PREFIX, host);
        Ok(env.storage().instance().get(&key).unwrap_or(false))
    }

    /// Set the minimum stake amount. Admin-only.
    ///
    /// # Errors
    /// * [`Error::NotInitialized`] — contract not initialised.
    /// * [`Error::InvalidStakeAmount`] — `min_stake` is zero or negative.
    pub fn set_min_stake(env: Env, min_stake: i128) -> Result<(), Error> {
        let admin = require_admin(&env)?;
        require_not_paused(&env)?;
        admin.require_auth();
        if min_stake <= 0 {
            return Err(Error::InvalidStakeAmount);
        }
        let previous_min_stake = Self::get_min_stake(env.clone());
        env.storage().instance().set(&MIN_STAKE_KEY, &min_stake);
        env.events().publish(
            (TOPIC_MIN_STAKE_UPDATED,),
            (EVENT_VERSION, previous_min_stake, min_stake),
        );
        Ok(())
    }

    /// Get the minimum stake amount.
    pub fn get_min_stake(env: Env) -> i128 {
        env.storage()
            .instance()
            .get(&MIN_STAKE_KEY)
            .unwrap_or(DEFAULT_MIN_STAKE)
    }

    /// Admin-only: configure staking contract used for host stake checks.
    pub fn set_staking_contract(env: Env, staking_contract: Address) -> Result<(), Error> {
        let admin = require_admin(&env)?;
        admin.require_auth();
        env.storage()
            .instance()
            .set(&STAKING_CONTRACT_KEY, &staking_contract);
        Ok(())
    }

    pub fn get_staking_contract(env: Env) -> Result<Address, Error> {
        env.storage()
            .instance()
            .get(&STAKING_CONTRACT_KEY)
            .ok_or(Error::StakingContractNotSet)
    }

    /// Admin-only: set minimum host stake required to create arena.
    pub fn set_min_host_stake(env: Env, min_host_stake: i128) -> Result<(), Error> {
        let admin = require_admin(&env)?;
        admin.require_auth();
        if min_host_stake <= 0 {
            return Err(Error::InvalidStakeAmount);
        }
        env.storage()
            .instance()
            .set(&MIN_HOST_STAKE_KEY, &min_host_stake);
        Ok(())
    }

    pub fn get_min_host_stake(env: Env) -> i128 {
        env.storage()
            .instance()
            .get(&MIN_HOST_STAKE_KEY)
            .unwrap_or(DEFAULT_MIN_STAKE)
    }

    // ── Player cap ────────────────────────────────────────────────────────────

    /// Return the protocol-wide cap on `max_players` for new arenas.
    /// Defaults to [`MAX_PLAYERS_HARD_CAP`] (64) until the admin overrides it.
    pub fn max_players_cap(env: Env) -> u32 {
        env.storage()
            .instance()
            .get(&MAX_PLAYERS_CAP_KEY)
            .unwrap_or(MAX_PLAYERS_HARD_CAP)
    }

    /// Update the protocol-wide cap on `max_players`. Admin-only.
    ///
    /// The new value must be in `[2, MAX_PLAYERS_ABSOLUTE_CAP]` so the cap can
    /// never be raised beyond an absolute ceiling that keeps `resolve_round`
    /// well within the Soroban CPU budget.
    ///
    /// # Errors
    /// * [`Error::InvalidPlayerCap`] — `new_cap` is below 2 or above
    ///   [`MAX_PLAYERS_ABSOLUTE_CAP`].
    pub fn set_max_players_cap(env: Env, new_cap: u32) -> Result<(), Error> {
        let admin = require_admin(&env)?;
        require_not_paused(&env)?;
        admin.require_auth();
        if new_cap < 2 || new_cap > MAX_PLAYERS_ABSOLUTE_CAP {
            return Err(Error::InvalidPlayerCap);
        }
        env.storage().instance().set(&MAX_PLAYERS_CAP_KEY, &new_cap);
        Ok(())
    }

    // ── Fee timelock ──────────────────────────────────────────────────────────

    /// Return the current effective platform win fee in basis points.
    /// Defaults to `DEFAULT_WIN_FEE_BPS` (200 = 2%) until first explicit set.
    pub fn current_fee_bps(env: Env) -> u32 {
        env.storage()
            .instance()
            .get(&WIN_FEE_BPS_KEY)
            .unwrap_or(DEFAULT_WIN_FEE_BPS)
    }

    /// Queue a platform fee update. The new fee takes effect only after the
    /// 24-hour timelock via `execute_fee_update`. Admin-only.
    ///
    /// # Errors
    /// * [`Error::FeeAlreadyPending`] — a fee update is already queued.
    /// * [`Error::FeeTooHigh`] — `new_fee_bps` exceeds `MAX_WIN_FEE_BPS`.
    ///
    /// # Events
    /// Emits `FeeUpdateQueued { current_fee, new_fee, effective_at }`.
    pub fn propose_fee_update(env: Env, new_fee_bps: u32) -> Result<(), Error> {
        let admin = require_admin(&env)?;
        admin.require_auth();

        if env.storage().instance().has(&PENDING_FEE_KEY) {
            return Err(Error::FeeAlreadyPending);
        }
        if new_fee_bps > MAX_WIN_FEE_BPS {
            return Err(Error::FeeTooHigh);
        }

        let effective_at: u64 = env.ledger().timestamp() + FEE_TIMELOCK_PERIOD;
        let current_fee = Self::current_fee_bps(env.clone());

        env.storage().instance().set(&PENDING_FEE_KEY, &new_fee_bps);
        env.storage().instance().set(&FEE_AFTER_KEY, &effective_at);

        env.events().publish(
            (TOPIC_FEE_QUEUED,),
            (EVENT_VERSION, current_fee, new_fee_bps, effective_at),
        );
        Ok(())
    }

    /// Apply the queued fee update after the 24-hour timelock. Admin-only.
    ///
    /// # Errors
    /// * [`Error::NoPendingFeeUpdate`] — no fee update is queued.
    /// * [`Error::FeeTimelockNotExpired`] — called before the timelock elapsed.
    pub fn execute_fee_update(env: Env) -> Result<(), Error> {
        let admin = require_admin(&env)?;
        admin.require_auth();

        let new_fee: u32 = env
            .storage()
            .instance()
            .get(&PENDING_FEE_KEY)
            .ok_or(Error::NoPendingFeeUpdate)?;
        let effective_at: u64 = env
            .storage()
            .instance()
            .get(&FEE_AFTER_KEY)
            .ok_or(Error::NoPendingFeeUpdate)?;

        if env.ledger().timestamp() < effective_at {
            return Err(Error::FeeTimelockNotExpired);
        }

        env.storage().instance().remove(&PENDING_FEE_KEY);
        env.storage().instance().remove(&FEE_AFTER_KEY);
        env.storage().instance().set(&WIN_FEE_BPS_KEY, &new_fee);

        env.events()
            .publish((TOPIC_FEE_EXECUTED,), (EVENT_VERSION, new_fee));
        Ok(())
    }

    /// Cancel a queued fee update. Admin-only.
    ///
    /// # Errors
    /// * [`Error::NoPendingFeeUpdate`] — no fee update to cancel.
    pub fn cancel_fee_update(env: Env) -> Result<(), Error> {
        let admin = require_admin(&env)?;
        admin.require_auth();

        if !env.storage().instance().has(&PENDING_FEE_KEY) {
            return Err(Error::NoPendingFeeUpdate);
        }

        env.storage().instance().remove(&PENDING_FEE_KEY);
        env.storage().instance().remove(&FEE_AFTER_KEY);

        env.events()
            .publish((TOPIC_FEE_CANCELLED,), (EVENT_VERSION,));
        Ok(())
    }

    /// Return the pending fee and the timestamp when it becomes effective,
    /// or `None` if no fee update is queued.
    pub fn pending_fee_update(env: Env) -> Option<(u32, u64)> {
        let fee: Option<u32> = env.storage().instance().get(&PENDING_FEE_KEY);
        let after: Option<u64> = env.storage().instance().get(&FEE_AFTER_KEY);
        match (fee, after) {
            (Some(f), Some(a)) => Some((f, a)),
            _ => None,
        }
    }

    // ── Arena creation fee ───────────────────────────────────────────────────

    /// Admin-only: set the flat token fee charged to hosts when creating an arena.
    ///
    /// The fee is transferred from the host to this factory contract during `create_pool`
    /// before any arena deployment occurs.
    pub fn set_creation_fee(env: Env, amount: i128, token: Address) -> Result<(), Error> {
        let admin = require_admin(&env)?;
        admin.require_auth();

        if amount < 0 {
            return Err(Error::InvalidCreationFee);
        }

        let old_fee: i128 = env
            .storage()
            .instance()
            .get(&CREATION_FEE_KEY)
            .unwrap_or(0i128);
        env.storage().instance().set(&CREATION_FEE_KEY, &amount);
        env.storage().instance().set(&CREATION_TOKEN_KEY, &token);

        env.events().publish(
            (TOPIC_FEE_CONFIG_UPDATED,),
            (EVENT_VERSION, old_fee, amount, token),
        );
        Ok(())
    }

    /// Admin-only: update both creation fee and win fee config in one call.
    pub fn set_fee_config(env: Env, config: FeeConfig, token: Address) -> Result<(), Error> {
        let admin = require_admin(&env)?;
        admin.require_auth();
        if config.creation_fee < 0 {
            return Err(Error::InvalidCreationFee);
        }
        if config.win_fee_bps > MAX_WIN_FEE_BPS {
            return Err(Error::FeeTooHigh);
        }
        env.storage()
            .instance()
            .set(&CREATION_FEE_KEY, &config.creation_fee);
        env.storage().instance().set(&CREATION_TOKEN_KEY, &token);
        env.storage()
            .instance()
            .set(&WIN_FEE_BPS_KEY, &config.win_fee_bps);
        Ok(())
    }

    /// Read full fee config.
    pub fn get_fee_config(env: Env) -> FeeConfig {
        FeeConfig {
            creation_fee: env
                .storage()
                .instance()
                .get(&CREATION_FEE_KEY)
                .unwrap_or(0i128),
            win_fee_bps: Self::current_fee_bps(env),
        }
    }

    /// Called by payout contract to record collected win fees.
    pub fn record_win_fee(env: Env, amount: i128) -> Result<(), Error> {
        if amount <= 0 {
            return Ok(());
        }
        let current: i128 = env
            .storage()
            .instance()
            .get(&WIN_FEE_ACCUM_KEY)
            .unwrap_or(0i128);
        let next = current
            .checked_add(amount)
            .ok_or(Error::ArithmeticOverflow)?;
        env.storage().instance().set(&WIN_FEE_ACCUM_KEY, &next);
        Ok(())
    }

    /// Admin-only treasury withdrawal for all accumulated protocol fees.
    pub fn admin_withdraw_fees(env: Env, to: Address) -> Result<i128, Error> {
        let admin = require_admin(&env)?;
        admin.require_auth();
        let creation_fee_accum: i128 = env
            .storage()
            .instance()
            .get(&CREATION_FEE_ACCUM_KEY)
            .unwrap_or(0i128);
        let win_fee_accum: i128 = env
            .storage()
            .instance()
            .get(&WIN_FEE_ACCUM_KEY)
            .unwrap_or(0i128);
        let total = creation_fee_accum
            .checked_add(win_fee_accum)
            .ok_or(Error::ArithmeticOverflow)?;
        if total <= 0 {
            return Ok(0);
        }
        let token: Address = env
            .storage()
            .instance()
            .get(&CREATION_TOKEN_KEY)
            .unwrap_or(env.current_contract_address());
        token::Client::new(&env, &token).transfer(&env.current_contract_address(), &to, &total);
        env.storage()
            .instance()
            .set(&CREATION_FEE_ACCUM_KEY, &0i128);
        env.storage().instance().set(&WIN_FEE_ACCUM_KEY, &0i128);
        env.events()
            .publish((TOPIC_FEES_WITHDRAWN,), (EVENT_VERSION, total, to));
        Ok(total)
    }

    /// Public read: get the configured (creation_fee, fee_token).
    pub fn get_creation_fee(env: Env) -> (i128, Address) {
        let fee: i128 = env
            .storage()
            .instance()
            .get(&CREATION_FEE_KEY)
            .unwrap_or(0i128);
        let tok: Address = env
            .storage()
            .instance()
            .get(&CREATION_TOKEN_KEY)
            .unwrap_or(env.current_contract_address());
        (fee, tok)
    }

    /// Create a new pool (arena). Only admin or whitelisted hosts can call this.
    ///
    /// The caller must provide a valid stake amount >= minimum stake and a
    /// capacity in range [2, MAX_POOL_CAPACITY]. `pool_id` must be unique.
    /// The `currency` must have been previously approved via `add_supported_token`.
    /// Emits `PoolCreated(pool_id, creator, capacity, stake_amount)`.
    ///
    /// # Errors
    /// * [`Error::NotInitialized`] — contract not initialised.
    /// * [`Error::UnsupportedToken`] — `currency` has not been added via `add_supported_token`.
    /// * [`Error::Unauthorized`] — `caller` is neither admin nor whitelisted.
    /// * [`Error::InvalidCapacity`] — `capacity` is < 2 or > `MAX_POOL_CAPACITY`.
    /// * [`Error::ExceedsPlayerCap`] — `capacity` exceeds `max_players_cap()`.
    /// * [`Error::InvalidStakeAmount`] — `stake_amount` is zero or negative.
    /// * [`Error::StakeBelowMinimum`] — `stake_amount` is below the configured minimum.
    /// * [`Error::WasmHashNotSet`] — `set_arena_wasm_hash` has not been called yet.
    pub fn create_pool(
        env: Env,
        caller: Address,
        stake: i128,
        currency: Address,
        round_speed: u32,
        capacity: u32,
        join_deadline: u64,
    ) -> Result<Address, Error> {
        let admin = require_admin(&env)?;
        require_not_paused(&env)?;

        // Prevent spoofing: the `caller` address used as `creator` must be
        // the transaction signer (unless Soroban auth is mocked in tests).
        caller.require_auth();

        // Use invoker() for authorization check.
        // For Soroban 20+, env.invoker() is preferred over passing Address.
        let is_admin = caller == admin;
        let is_whitelisted = Self::is_host_whitelisted(env.clone(), caller.clone())?;

        if !is_admin && !is_whitelisted {
            return Err(Error::Unauthorized);
        }

        // Reject any currency that has not been explicitly approved by the admin.
        // This must be checked before deploying any contract to prevent pools
        // backed by malicious or worthless tokens from ever being created.
        if !Self::is_token_supported(env.clone(), currency.clone()) {
            return Err(Error::TokenNotAllowed);
        }

        if capacity < 2 || capacity > MAX_POOL_CAPACITY {
            return Err(Error::InvalidCapacity);
        }
        if capacity > Self::max_players_cap(env.clone()) {
            return Err(Error::ExceedsPlayerCap);
        }

        let min_stake = Self::get_min_stake(env.clone());
        if stake <= 0 {
            return Err(Error::InvalidStakeAmount);
        }
        if stake < min_stake {
            return Err(Error::StakeBelowMinimum);
        }

        // Issue #449: host must have enough stake locked in staking contract.
        let staking_contract = Self::get_staking_contract(env.clone())?;
        let host_stake: i128 = env.invoke_contract(
            &staking_contract,
            &soroban_sdk::Symbol::new(&env, "get_host_stake"),
            soroban_sdk::vec![&env, caller.clone().into_val(&env)],
        );
        if host_stake < Self::get_min_host_stake(env.clone()) {
            return Err(Error::HostStakeInsufficient);
        }

        // ── Arena creation fee (fee-then-deploy) ─────────────────────────────
        let (creation_fee, fee_token) = Self::get_creation_fee(env.clone());
        if creation_fee > 0 {
            let token_client = token::Client::new(&env, &fee_token);
            let balance = token_client.balance(&caller);
            if balance < creation_fee {
                return Err(Error::InsufficientCreationFee);
            }
            token_client.transfer(&caller, &env.current_contract_address(), &creation_fee);

            let prev_acc: i128 = env
                .storage()
                .instance()
                .get(&CREATION_FEE_ACCUM_KEY)
                .unwrap_or(0i128);
            env.storage()
                .instance()
                .set(&CREATION_FEE_ACCUM_KEY, &(prev_acc + creation_fee));
        }

        let wasm_hash: BytesN<32> = env
            .storage()
            .instance()
            .get(&ARENA_WASM_HASH_KEY)
            .ok_or(Error::WasmHashNotSet)?;

        let pool_id: u32 = env
            .storage()
            .instance()
            .get(&POOL_COUNT_KEY)
            .unwrap_or(0u32);

        let metadata = ArenaMetadata {
            pool_id,
            creator: caller.clone(),
            capacity,
            stake_amount: stake,
            win_fee_bps: Self::current_fee_bps(env.clone()),
        };

        // ── Deployment ──────────────────────────────────────────────────────────

        // Create a unique salt for this deployment.
        let mut salt_bin = soroban_sdk::Bytes::new(&env);
        salt_bin.append(&caller.clone().to_xdr(&env));
        salt_bin.append(&pool_id.to_xdr(&env));
        let salt = env.crypto().sha256(&salt_bin);

        // Deploy the contract.
        #[cfg(not(test))]
        let arena_address = env
            .deployer()
            .with_current_contract(salt)
            .deploy_v2(wasm_hash, (env.current_contract_address(),));

        #[cfg(test)]
        let arena_address = {
            let _ = wasm_hash; // consumed via WasmHashNotSet check above; not used in test path
            let addr = env
                .deployer()
                .with_current_contract(salt)
                .deployed_address();
            env.register_at(&addr, ArenaContract, (env.current_contract_address(),));
            addr
        };

        // ── Initialisation ──────────────────────────────────────────────────────
        // Note: __constructor runs at deploy time (deploy_v2/register_at), so
        // there is no separate initialize() call needed here.

        let fee_snapshot = Self::current_fee_bps(env.clone());
        env.invoke_contract::<()>(
            &arena_address,
            &soroban_sdk::Symbol::new(&env, "init_with_fee"),
            soroban_sdk::vec![
                &env,
                round_speed.into_val(&env),
                stake.into_val(&env),
                join_deadline.into_val(&env),
                fee_snapshot.into_val(&env),
            ],
        );

        env.invoke_contract::<()>(
            &arena_address,
            &soroban_sdk::Symbol::new(&env, "init_factory"),
            soroban_sdk::vec![
                &env,
                env.current_contract_address().into_val(&env),
                caller.clone().into_val(&env)
            ],
        );

        env.invoke_contract::<()>(
            &arena_address,
            &soroban_sdk::Symbol::new(&env, "set_token"),
            soroban_sdk::vec![&env, currency.into_val(&env)],
        );

        env.invoke_contract::<()>(
            &arena_address,
            &soroban_sdk::Symbol::new(&env, "set_capacity"),
            soroban_sdk::vec![&env, capacity.into_val(&env)],
        );

        // 3. Transfer admin to the caller after factory-owned initialization is complete.
        env.invoke_contract::<()>(
            &arena_address,
            &soroban_sdk::Symbol::new(&env, "set_admin"),
            soroban_sdk::vec![&env, caller.into_val(&env)],
        );

        // Persist metadata only after deployment and all init calls succeed.
        let pool_key = DataKey::Pool(pool_id);
        env.storage().persistent().set(&pool_key, &metadata);
        env.storage().persistent().extend_ttl(
            &pool_key,
            REGISTRY_TTL_THRESHOLD,
            REGISTRY_TTL_EXTEND_TO,
        );

        let arena_key = DataKey::ArenaRef(pool_id as u64);
        env.storage().persistent().set(
            &arena_key,
            &ArenaRef {
                contract: arena_address.clone(),
                status: ArenaStatus::Pending,
                host: caller.clone(),
            },
        );
        env.storage().persistent().extend_ttl(
            &arena_key,
            REGISTRY_TTL_THRESHOLD,
            REGISTRY_TTL_EXTEND_TO,
        );

        // Increment the pool counter.
        env.storage()
            .instance()
            .set(&POOL_COUNT_KEY, &(pool_id + 1));

        env.events().publish(
            (TOPIC_POOL_CREATED,),
            (
                EVENT_VERSION,
                pool_id,
                caller.clone(),
                capacity,
                stake,
                arena_address.clone(),
            ),
        );

        // Lock host stake against this arena id in staking contract.
        let staking_contract = Self::get_staking_contract(env.clone())?;
        env.invoke_contract::<()>(
            &staking_contract,
            &soroban_sdk::Symbol::new(&env, "lock_host_stake"),
            soroban_sdk::vec![
                &env,
                env.current_contract_address().into_val(&env),
                caller.clone().into_val(&env),
                (pool_id as u64).into_val(&env),
                Self::get_min_host_stake(env.clone()).into_val(&env),
            ],
        );

        Ok(arena_address)
    }

    pub fn create_arena(
        env: Env,
        host: Address,
        config: CreateArenaConfig,
        name: String,
        description: Option<String>,
    ) -> Result<(u64, Address), Error> {
        let arena_address = Self::create_pool(
            env.clone(),
            host.clone(),
            config.stake_amount,
            config.currency.clone(),
            config.round_speed,
            config.capacity,
            config.join_deadline,
        )?;

        let arena_id = env
            .storage()
            .instance()
            .get::<_, u32>(&POOL_COUNT_KEY)
            .unwrap_or(0u32)
            .saturating_sub(1) as u64;

        Self::set_arena_metadata(
            env.clone(),
            arena_address.clone(),
            arena_id,
            name,
            description,
            host.clone(),
        );

        env.events().publish(
            (TOPIC_ARENA_CREATED,),
            (EVENT_VERSION, arena_id, host, arena_address.clone(), config),
        );

        Ok((arena_id, arena_address))
    }

    /// Set human-readable metadata on a deployed arena contract.
    ///
    /// Forwards to the arena's `set_metadata` entrypoint.  The caller must be
    /// the arena's admin (typically the pool creator who was set as admin during
    /// `create_pool`).
    ///
    /// The `ArenaRef` entry is written once by `create_pool`; this function only
    /// forwards the display metadata to the arena contract and does not touch
    /// the registry key, keeping the flow idempotent and avoiding redundant
    /// storage writes.
    ///
    /// # Arguments
    /// * `arena_address` — address of the deployed arena contract.
    /// * `arena_id`      — application-level identifier stored inside the metadata.
    /// * `name`          — display name, max 64 bytes.
    /// * `description`   — optional description, max 256 bytes.
    /// * `host`          — host address to record in the metadata.
    pub fn set_arena_metadata(
        env: Env,
        arena_address: Address,
        arena_id: u64,
        name: String,
        description: Option<String>,
        host: Address,
    ) {
        env.invoke_contract::<()>(
            &arena_address,
            &soroban_sdk::Symbol::new(&env, "set_metadata"),
            soroban_sdk::vec![
                &env,
                arena_id.into_val(&env),
                name.into_val(&env),
                description.into_val(&env),
                host.into_val(&env),
            ],
        );
        // ArenaRef is written once in create_pool; no duplicate write here.
    }

    pub fn get_arena_ref(env: Env, arena_id: u64) -> Result<ArenaRef, Error> {
        let key = DataKey::ArenaRef(arena_id);
        let arena_ref = env
            .storage()
            .persistent()
            .get(&key)
            .ok_or(Error::ArenaNotFound)?;
        env.storage()
            .persistent()
            .extend_ttl(&key, REGISTRY_TTL_THRESHOLD, REGISTRY_TTL_EXTEND_TO);
        Ok(arena_ref)
    }

    /// Add addresses to the private arena whitelist. Host-only.
    ///
    /// Only the host (creator) of the arena may call this. Requires auth from
    /// the host address. The arena must have been registered via
    /// `set_arena_metadata` before this can be called.
    ///
    /// # Errors
    /// * [`Error::ArenaNotFound`] — no arena registered for `arena_id`.
    /// * [`Error::Unauthorized`]  — caller is not the arena host.
    pub fn add_to_whitelist(env: Env, arena_id: u64, addresses: Vec<Address>) -> Result<(), Error> {
        let ref_key = DataKey::ArenaRef(arena_id);
        let arena_ref: ArenaRef = env
            .storage()
            .persistent()
            .get(&ref_key)
            .ok_or(Error::ArenaNotFound)?;
        env.storage().persistent().extend_ttl(
            &ref_key,
            REGISTRY_TTL_THRESHOLD,
            REGISTRY_TTL_EXTEND_TO,
        );

        // Only the host (pool creator) may manage the whitelist.
        arena_ref.host.require_auth();

        for address in addresses.iter() {
            let wl_key = DataKey::ArenaWhitelist(arena_id, address.clone());
            env.storage().persistent().set(&wl_key, &true);
            env.storage().persistent().extend_ttl(
                &wl_key,
                REGISTRY_TTL_THRESHOLD,
                REGISTRY_TTL_EXTEND_TO,
            );
        }

        env.events()
            .publish((TOPIC_ARENA_WL_ADD,), (EVENT_VERSION, arena_id));
        Ok(())
    }

    /// Remove addresses from the private arena whitelist. Host-only.
    ///
    /// Only the host (creator) of the arena may call this.
    ///
    /// # Errors
    /// * [`Error::ArenaNotFound`] — no arena registered for `arena_id`.
    /// * [`Error::Unauthorized`]  — caller is not the arena host.
    pub fn remove_from_whitelist(
        env: Env,
        arena_id: u64,
        addresses: Vec<Address>,
    ) -> Result<(), Error> {
        let ref_key = DataKey::ArenaRef(arena_id);
        let arena_ref: ArenaRef = env
            .storage()
            .persistent()
            .get(&ref_key)
            .ok_or(Error::ArenaNotFound)?;
        env.storage().persistent().extend_ttl(
            &ref_key,
            REGISTRY_TTL_THRESHOLD,
            REGISTRY_TTL_EXTEND_TO,
        );

        // Only the host (pool creator) may manage the whitelist.
        arena_ref.host.require_auth();

        for address in addresses.iter() {
            env.storage()
                .persistent()
                .remove(&DataKey::ArenaWhitelist(arena_id, address));
        }

        env.events()
            .publish((TOPIC_ARENA_WL_REM,), (EVENT_VERSION, arena_id));
        Ok(())
    }

    /// Check whether `player` is on the whitelist for `arena_id`.
    ///
    /// Returns `false` if the arena does not exist or the player is not listed.
    /// This is a read-only view — no auth required.
    pub fn is_whitelisted(env: Env, arena_id: u64, player: Address) -> bool {
        let key = DataKey::ArenaWhitelist(arena_id, player);
        let result = env.storage().persistent().get(&key).unwrap_or(false);
        if result {
            env.storage().persistent().extend_ttl(
                &key,
                REGISTRY_TTL_THRESHOLD,
                REGISTRY_TTL_EXTEND_TO,
            );
        }
        result
    }

    pub fn update_arena_status(env: Env, arena_id: u64, status: ArenaStatus) -> Result<(), Error> {
        let ref_key = DataKey::ArenaRef(arena_id);
        let mut arena_ref: ArenaRef = env
            .storage()
            .persistent()
            .get(&ref_key)
            .ok_or(Error::ArenaNotFound)?;

        // Enforce that only the corresponding ArenaContract can update its status.
        arena_ref.contract.require_auth();

        arena_ref.status = status;
        env.storage().persistent().set(&ref_key, &arena_ref);
        env.storage().persistent().extend_ttl(
            &ref_key,
            REGISTRY_TTL_THRESHOLD,
            REGISTRY_TTL_EXTEND_TO,
        );

        // Release host stake when arena reaches terminal status.
        if status == ArenaStatus::Completed || status == ArenaStatus::Cancelled {
            if let Ok(staking_contract) = Self::get_staking_contract(env.clone()) {
                env.invoke_contract::<()>(
                    &staking_contract,
                    &soroban_sdk::Symbol::new(&env, "release_host_stake"),
                    soroban_sdk::vec![
                        &env,
                        env.current_contract_address().into_val(&env),
                        arena_ref.host.into_val(&env),
                        arena_id.into_val(&env),
                    ],
                );
            }
        }

        Ok(())
    }

    /// Add a token to the supported currency list. Admin-only.
    pub fn add_supported_token(env: Env, token: Address) -> Result<(), Error> {
        let admin = require_admin(&env)?;
        require_not_paused(&env)?;
        admin.require_auth();

        // Probe SAC interface so non-token contracts cannot be whitelisted.
        // A valid SAC exposes `decimals()`.
        let decimals = token::Client::new(&env, &token).decimals();
        if decimals > 18 {
            return Err(Error::InvalidTokenContract);
        }

        let key = DataKey::SupportedToken(token.clone());
        let existed = env.storage().instance().has(&key);
        env.storage().instance().set(&key, &true);
        if !existed {
            let count: u32 = env.storage().instance().get(&TOKEN_COUNT_KEY).unwrap_or(0);
            env.storage().instance().set(&TOKEN_COUNT_KEY, &(count + 1));
        }
        env.events()
            .publish((TOPIC_TOKEN_ADDED,), (EVENT_VERSION, false, true, token));
        env.events()
            .publish((TOPIC_TOKEN_WL_UPDATED,), (EVENT_VERSION, true));
        Ok(())
    }

    /// Remove a token from the supported currency list. Admin-only.
    /// Any pools already created with this token are unaffected; only future
    /// `create_pool` calls will be rejected.
    /// Emits `TokenRemoved(token)`.
    pub fn remove_supported_token(env: Env, token: Address) -> Result<(), Error> {
        let admin = require_admin(&env)?;
        require_not_paused(&env)?;
        admin.require_auth();

        let key = DataKey::SupportedToken(token.clone());
        let existed = env.storage().instance().has(&key);
        if existed {
            let count: u32 = env.storage().instance().get(&TOKEN_COUNT_KEY).unwrap_or(0);
            if count <= 1 {
                return Err(Error::EmptyTokenWhitelist);
            }
            env.storage().instance().set(&TOKEN_COUNT_KEY, &(count - 1));
        }
        env.storage().instance().remove(&key);
        env.events()
            .publish((TOPIC_TOKEN_REMOVED,), (EVENT_VERSION, token));
        env.events()
            .publish((TOPIC_TOKEN_WL_UPDATED,), (EVENT_VERSION, false));
        Ok(())
    }

    pub fn update_allowed_tokens(
        env: Env,
        add_tokens: Vec<Address>,
        remove_tokens: Vec<Address>,
    ) -> Result<(), Error> {
        let admin = require_admin(&env)?;
        require_not_paused(&env)?;
        admin.require_auth();

        for token in add_tokens.iter() {
            Self::add_supported_token(env.clone(), token)?;
        }
        for token in remove_tokens.iter() {
            Self::remove_supported_token(env.clone(), token)?;
        }

        Ok(())
    }

    /// Return whether `token` is on the supported currency list.
    pub fn is_token_supported(env: Env, token: Address) -> bool {
        env.storage()
            .instance()
            .get::<_, bool>(&DataKey::SupportedToken(token))
            .unwrap_or(false)
    }

    // ── Upgrade mechanism ────────────────────────────────────────────────────

    /// Propose a WASM upgrade. The new hash is stored together with the
    /// earliest timestamp at which `execute_upgrade` may be called.
    ///
    /// # Arguments
    /// * `env` - The Soroban environment.
    /// * `new_wasm_hash` - 32-byte hash of the new contract WASM to deploy.
    ///
    /// # Errors
    /// * [`Error::NotInitialized`] — contract not initialised.
    ///
    /// # Authorization
    /// Requires admin signature (`admin.require_auth()`).
    ///
    /// # Events
    /// Emits `UpgradeProposed(new_wasm_hash, execute_after)`.
    pub fn propose_upgrade(env: Env, new_wasm_hash: BytesN<32>) -> Result<(), Error> {
        let admin = require_admin(&env)?;
        admin.require_auth();
        propose_upgrade_flow(
            &env,
            UpgradeKeys {
                pending_hash: &PENDING_HASH_KEY,
                execute_after: &EXECUTE_AFTER_KEY,
            },
            UpgradeTopics {
                proposed: &TOPIC_UPGRADE_PROPOSED,
                executed: &TOPIC_UPGRADE_EXECUTED,
                cancelled: &TOPIC_UPGRADE_CANCELLED,
            },
            EVENT_VERSION,
            TIMELOCK_PERIOD,
            &new_wasm_hash,
            Error::UpgradeAlreadyPending,
        )
    }

    /// Execute a previously proposed upgrade after the 48-hour timelock.
    ///
    /// # Arguments
    /// * `env` - The Soroban environment.
    ///
    /// # Errors
    /// * [`Error::NotInitialized`] — contract not initialised.
    /// * [`Error::NoPendingUpgrade`] — no upgrade proposal exists.
    /// * [`Error::TimelockNotExpired`] — called before the timelock has elapsed.
    ///
    /// # Authorization
    /// Requires admin signature (`admin.require_auth()`).
    ///
    /// # Events
    /// Emits `UpgradeExecuted(new_wasm_hash)`.
    pub fn execute_upgrade(env: Env, expected_hash: BytesN<32>) -> Result<(), Error> {
        let admin = require_admin(&env)?;
        admin.require_auth();
        let stored_hash = execute_upgrade_flow(
            &env,
            UpgradeKeys {
                pending_hash: &PENDING_HASH_KEY,
                execute_after: &EXECUTE_AFTER_KEY,
            },
            UpgradeTopics {
                proposed: &TOPIC_UPGRADE_PROPOSED,
                executed: &TOPIC_UPGRADE_EXECUTED,
                cancelled: &TOPIC_UPGRADE_CANCELLED,
            },
            EVENT_VERSION,
            &expected_hash,
            UpgradeErrors {
                no_pending: Error::NoPendingUpgrade,
                timelock_not_expired: Error::TimelockNotExpired,
                hash_mismatch: Error::HashMismatch,
                malformed_state: Some(Error::MalformedUpgradeState),
            },
            ExecuteTimePolicy::AtOrAfter,
        )?;
        env.deployer().update_current_contract_wasm(stored_hash);
        Ok(())
    }

    /// Cancel a pending upgrade proposal. Admin-only.
    ///
    /// # Arguments
    /// * `env` - The Soroban environment.
    ///
    /// # Errors
    /// * [`Error::NotInitialized`] — contract not initialised.
    /// * [`Error::NoPendingUpgrade`] — no proposal to cancel.
    ///
    /// # Authorization
    /// Requires admin signature (`admin.require_auth()`).
    ///
    /// # Events
    /// Emits `UpgradeCancelled`.
    pub fn cancel_upgrade(env: Env) -> Result<(), Error> {
        let admin = require_admin(&env)?;
        admin.require_auth();
        cancel_upgrade_flow(
            &env,
            UpgradeKeys {
                pending_hash: &PENDING_HASH_KEY,
                execute_after: &EXECUTE_AFTER_KEY,
            },
            UpgradeTopics {
                proposed: &TOPIC_UPGRADE_PROPOSED,
                executed: &TOPIC_UPGRADE_EXECUTED,
                cancelled: &TOPIC_UPGRADE_CANCELLED,
            },
            EVENT_VERSION,
            Error::NoPendingUpgrade,
        )
    }

    /// Return the pending WASM hash and the earliest execution timestamp,
    /// or `None` if no upgrade has been proposed.
    ///
    /// # Authorization
    /// None — read-only, open to any caller.
    pub fn pending_upgrade(env: Env) -> Option<(BytesN<32>, u64)> {
        pending_upgrade_flow(
            &env,
            UpgradeKeys {
                pending_hash: &PENDING_HASH_KEY,
                execute_after: &EXECUTE_AFTER_KEY,
            },
        )
    }

    /// Get metadata for a specific pool.
    pub fn get_arena(env: Env, pool_id: u32) -> Option<ArenaMetadata> {
        let key = DataKey::Pool(pool_id);
        let result = env.storage().persistent().get(&key);
        if result.is_some() {
            env.storage().persistent().extend_ttl(
                &key,
                REGISTRY_TTL_THRESHOLD,
                REGISTRY_TTL_EXTEND_TO,
            );
        }
        result
    }

    /// Get a paginated list of arena metadata.
    /// `limit` is clamped to `MAX_PAGE_SIZE` (50) to prevent unbounded storage reads.
    pub fn get_arenas(env: Env, offset: u32, limit: u32) -> soroban_sdk::Vec<ArenaMetadata> {
        let pool_count: u32 = env
            .storage()
            .instance()
            .get(&POOL_COUNT_KEY)
            .unwrap_or(0u32);

        let clamped_limit = limit.min(MAX_PAGE_SIZE);
        let mut results = soroban_sdk::Vec::new(&env);
        let end = core::cmp::min(offset.saturating_add(clamped_limit), pool_count);

        for i in offset..end {
            if let Some(meta) = Self::get_arena(env.clone(), i) {
                results.push_back(meta);
            }
        }
        results
    }

    pub fn list_arenas(env: Env, cursor: Option<u64>, limit: u32) -> ArenaPage {
        list_arenas_filtered(&env, cursor, limit, false, None)
    }

    pub fn list_active_arenas(env: Env, cursor: Option<u64>, limit: u32) -> ArenaPage {
        list_arenas_filtered(&env, cursor, limit, true, None)
    }

    pub fn list_arenas_by_host(
        env: Env,
        host: Address,
        cursor: Option<u64>,
        limit: u32,
    ) -> ArenaPage {
        list_arenas_filtered(&env, cursor, limit, false, Some(host))
    }

    // ── Emergency pause ──────────────────────────────────────────────────────

    /// Pause the contract, disabling all write operations. Admin-only.
    pub fn pause(env: Env) -> Result<(), Error> {
        let admin = require_admin(&env)?;
        admin.require_auth();
        env.storage().instance().set(&PAUSED_KEY, &true);
        env.events().publish((TOPIC_PAUSED,), (EVENT_VERSION,));
        Ok(())
    }

    /// Unpause the contract, re-enabling write operations. Admin-only.
    pub fn unpause(env: Env) -> Result<(), Error> {
        let admin = require_admin(&env)?;
        admin.require_auth();
        env.storage().instance().remove(&PAUSED_KEY);
        env.events().publish((TOPIC_UNPAUSED,), (EVENT_VERSION,));
        Ok(())
    }

    /// Return whether the contract is currently paused.
    pub fn is_paused(env: Env) -> bool {
        env.storage().instance().get(&PAUSED_KEY).unwrap_or(false)
    }

    // ── Two-step admin transfer ───────────────────────────────────────────────

    /// Propose a new admin. The pending admin has 7 days to call `accept_admin`.
    /// Only the current admin may call this.
    pub fn propose_admin(env: Env, new_admin: Address) -> Result<(), Error> {
        let admin = require_admin(&env)?;
        admin.require_auth();
        let expires_at = propose_admin_transfer_flow(
            &env,
            AdminTransferKeys {
                admin: &ADMIN_KEY,
                pending_admin: &PENDING_ADMIN_KEY,
                admin_expiry: &ADMIN_EXPIRY_KEY,
            },
            &new_admin,
            ADMIN_TRANSFER_EXPIRY,
        );
        env.events().publish(
            (TOPIC_ADMIN_PROPOSED,),
            (EVENT_VERSION, admin, new_admin, expires_at),
        );
        Ok(())
    }

    /// Accept a pending admin transfer. Must be called by the proposed new admin
    /// within 7 days of the proposal.
    pub fn accept_admin(env: Env, new_admin: Address) -> Result<(), Error> {
        new_admin.require_auth();
        let old_admin = require_admin(&env)?;
        accept_admin_transfer_flow(
            &env,
            AdminTransferKeys {
                admin: &ADMIN_KEY,
                pending_admin: &PENDING_ADMIN_KEY,
                admin_expiry: &ADMIN_EXPIRY_KEY,
            },
            &new_admin,
            AdminTransferErrors {
                no_pending: Error::NoPendingAdminTransfer,
                unauthorized: Error::Unauthorized,
                expired: Error::AdminTransferExpired,
            },
        )?;
        env.events().publish(
            (TOPIC_ADMIN_ACCEPTED,),
            (EVENT_VERSION, old_admin, new_admin),
        );
        Ok(())
    }

    /// Cancel a pending admin transfer. Only the current admin may call this.
    pub fn cancel_admin_transfer(env: Env) -> Result<(), Error> {
        let admin = require_admin(&env)?;
        admin.require_auth();
        cancel_admin_transfer_flow(
            &env,
            AdminTransferKeys {
                admin: &ADMIN_KEY,
                pending_admin: &PENDING_ADMIN_KEY,
                admin_expiry: &ADMIN_EXPIRY_KEY,
            },
            Error::NoPendingAdminTransfer,
        )?;
        env.events()
            .publish((TOPIC_ADMIN_CANCELLED,), (EVENT_VERSION,));
        Ok(())
    }

    /// Return the pending admin address and expiry timestamp, or `None` if none.
    pub fn pending_admin_transfer(env: Env) -> Option<(Address, u64)> {
        pending_admin_transfer_flow(
            &env,
            AdminTransferKeys {
                admin: &ADMIN_KEY,
                pending_admin: &PENDING_ADMIN_KEY,
                admin_expiry: &ADMIN_EXPIRY_KEY,
            },
        )
    }
}

// ── Private helpers ───────────────────────────────────────────────────────────

/// Return the stored admin address, or `Error::NotInitialized` if absent.
fn require_admin(env: &Env) -> Result<Address, Error> {
    env.storage()
        .instance()
        .get(&ADMIN_KEY)
        .ok_or(Error::NotInitialized)
}

/// Return `Error::Paused` if the contract is currently paused.
fn require_not_paused(env: &Env) -> Result<(), Error> {
    if env.storage().instance().get(&PAUSED_KEY).unwrap_or(false) {
        return Err(Error::Paused);
    }
    Ok(())
}

fn list_arenas_filtered(
    env: &Env,
    cursor: Option<u64>,
    limit: u32,
    only_active: bool,
    host_filter: Option<Address>,
) -> ArenaPage {
    let start_id = cursor.map(|id| id.saturating_add(1)).unwrap_or(0u64);
    let limit = limit.min(MAX_CURSOR_PAGE_SIZE);
    let pool_count = env
        .storage()
        .instance()
        .get(&POOL_COUNT_KEY)
        .unwrap_or(0u32) as u64;

    let mut items = Vec::new(env);
    let mut scanned = start_id;
    let mut last_included: Option<u64> = None;

    while scanned < pool_count && items.len() < limit {
        if let Some(summary) = load_arena_summary(env, scanned) {
            if matches_arena_filter(&summary, only_active, host_filter.as_ref()) {
                items.push_back(summary);
                last_included = Some(scanned);
            }
        }
        scanned = scanned.saturating_add(1);
    }

    let mut has_more = false;
    let mut probe = last_included
        .map(|id| id.saturating_add(1))
        .unwrap_or(start_id);
    while probe < pool_count {
        if let Some(summary) = load_arena_summary(env, probe) {
            if matches_arena_filter(&summary, only_active, host_filter.as_ref()) {
                has_more = true;
                break;
            }
        }
        probe = probe.saturating_add(1);
    }

    ArenaPage {
        items,
        next_cursor: if has_more { last_included } else { None },
        has_more,
    }
}

fn load_arena_summary(env: &Env, arena_id: u64) -> Option<ArenaSummary> {
    let key = DataKey::ArenaRef(arena_id);
    let arena_ref: Option<ArenaRef> = env.storage().persistent().get(&key);
    if arena_ref.is_some() {
        env.storage()
            .persistent()
            .extend_ttl(&key, REGISTRY_TTL_THRESHOLD, REGISTRY_TTL_EXTEND_TO);
    }
    arena_ref.map(|entry| ArenaSummary {
        arena_id,
        contract: entry.contract,
        status: entry.status,
        host: entry.host,
    })
}

fn matches_arena_filter(
    summary: &ArenaSummary,
    only_active: bool,
    host_filter: Option<&Address>,
) -> bool {
    if only_active && summary.status != ArenaStatus::Active {
        return false;
    }
    if let Some(host) = host_filter {
        if summary.host != *host {
            return false;
        }
    }
    true
}

#[cfg(test)]
mod test;

#[cfg(test)]
mod snapshot_test;
