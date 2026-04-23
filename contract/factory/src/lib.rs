#![no_std]

use soroban_sdk::{
    Address, BytesN, Env, IntoVal, String, Symbol, Vec, contract, contracterror, contractimpl,
    contracttype, symbol_short, xdr::ToXdr,
};

#[cfg(test)]
use arena::ArenaContract;

// ── Storage keys ─────────────────────────────────────────────────────────────

const ADMIN_KEY: Symbol = symbol_short!("ADMIN");
const PENDING_HASH_KEY: Symbol = symbol_short!("P_HASH");
const EXECUTE_AFTER_KEY: Symbol = symbol_short!("P_AFTER");
const WHITELIST_PREFIX: Symbol = symbol_short!("WL");
const MIN_STAKE_KEY: Symbol = symbol_short!("MIN_STK");
const ARENA_WASM_HASH_KEY: Symbol = symbol_short!("AR_WASM");
const POOL_COUNT_KEY: Symbol = symbol_short!("P_CNT");
const SCHEMA_VERSION_KEY: Symbol = symbol_short!("S_VER");
const PAUSED_KEY: Symbol = symbol_short!("PAUSED");

// ── Fee timelock storage keys ─────────────────────────────────────────────────
const WIN_FEE_BPS_KEY: Symbol = symbol_short!("FEE_BPS");
const PENDING_FEE_KEY: Symbol = symbol_short!("P_FEE");
const FEE_AFTER_KEY: Symbol = symbol_short!("F_AFTER");

/// Current schema version. Bump this when storage layout changes.
const CURRENT_SCHEMA_VERSION: u32 = 1;

// ── Fee constants ─────────────────────────────────────────────────────────────
/// 24-hour timelock for fee config changes (seconds).
const FEE_TIMELOCK_PERIOD: u64 = 24 * 60 * 60;
/// Default platform win fee: 2% (200 basis points).
pub const DEFAULT_WIN_FEE_BPS: u32 = 200;
/// Maximum allowed win fee: 20% (2000 basis points).
pub const MAX_WIN_FEE_BPS: u32 = 2_000;

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

// ── Capacity limits ───────────────────────────────────────────────────────────

const MAX_POOL_CAPACITY: u32 = 256;
const MAX_PAGE_SIZE: u32 = 50;

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

// ── Minimum stake: 10 XLM in stroops ──────────────────────────────────────────

const DEFAULT_MIN_STAKE: i128 = 10_000_000;

// ── Event topics ──────────────────────────────────────────────────────────────

const TOPIC_UPGRADE_PROPOSED: Symbol = symbol_short!("UP_PROP");
const TOPIC_UPGRADE_EXECUTED: Symbol = symbol_short!("UP_EXEC");
const TOPIC_UPGRADE_CANCELLED: Symbol = symbol_short!("UP_CANC");
const TOPIC_POOL_CREATED: Symbol = symbol_short!("POOL_CRE");
const TOPIC_HOST_WHITELISTED: Symbol = symbol_short!("WL_ADD");
const TOPIC_HOST_REMOVED: Symbol = symbol_short!("WL_REM");
const TOPIC_ADMIN_CHANGED: Symbol = symbol_short!("ADM_CHG");
const TOPIC_WASM_UPDATED: Symbol = symbol_short!("WASM_UP");
const TOPIC_TOKEN_ADDED: Symbol = symbol_short!("TOK_ADD");
const TOPIC_TOKEN_REMOVED: Symbol = symbol_short!("TOK_REM");
const TOPIC_MIN_STAKE_UPDATED: Symbol = symbol_short!("MIN_UP");
const TOPIC_PAUSED: Symbol = symbol_short!("PAUSED");
const TOPIC_UNPAUSED: Symbol = symbol_short!("UNPAUSED");
const TOPIC_FEE_QUEUED: Symbol = symbol_short!("FEE_Q");
const TOPIC_FEE_EXECUTED: Symbol = symbol_short!("FEE_EX");
const TOPIC_FEE_CANCELLED: Symbol = symbol_short!("FEE_CAN");

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
    /// Provided fee exceeds `MAX_WIN_FEE_BPS` (2000).
    FeeTooHigh = 21,
    /// The hash provided to `execute_upgrade` does not match the stored proposal hash.
    HashMismatch = 17,
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
            .set(&WIN_FEE_BPS_KEY, &DEFAULT_WIN_FEE_BPS);
        env.storage()
            .instance()
            .set(&SCHEMA_VERSION_KEY, &CURRENT_SCHEMA_VERSION);
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
        let previous_hash: Option<BytesN<32>> =
            env.storage().instance().get(&ARENA_WASM_HASH_KEY);
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
            return Err(Error::UnsupportedToken);
        }

        if capacity < 2 || capacity > MAX_POOL_CAPACITY {
            return Err(Error::InvalidCapacity);
        }

        let min_stake = Self::get_min_stake(env.clone());
        if stake <= 0 {
            return Err(Error::InvalidStakeAmount);
        }
        if stake < min_stake {
            return Err(Error::StakeBelowMinimum);
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
        let arena_address = env.deployer()
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
        env.storage()
            .persistent()
            .set(&DataKey::Pool(pool_id), &metadata);

        // Increment the pool counter.
        env.storage()
            .instance()
            .set(&POOL_COUNT_KEY, &(pool_id + 1));

        env.events().publish(
            (TOPIC_POOL_CREATED,),
            (
                EVENT_VERSION,
                pool_id,
                caller,
                capacity,
                stake,
                arena_address.clone(),
            ),
        );

        Ok(arena_address)
    }

    /// Set human-readable metadata on a deployed arena contract.
    ///
    /// Forwards to the arena's `set_metadata` entrypoint.  The caller must be
    /// the arena's admin (typically the pool creator who was set as admin during
    /// `create_pool`).
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

        // Store the ArenaRef tracking structure initialized to Pending status.
        let arena_ref = ArenaRef {
            contract: arena_address,
            status: ArenaStatus::Pending,
            host: host.clone(),
        };
        env.storage().persistent().set(&DataKey::ArenaRef(arena_id), &arena_ref);
    }

    /// Retrieve the ArenaRef for a given arena_id.
    pub fn get_arena_ref(env: Env, arena_id: u64) -> Result<ArenaRef, Error> {
        env.storage()
            .persistent()
            .get(&DataKey::ArenaRef(arena_id))
            .ok_or(Error::ArenaNotFound)
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
        let arena_ref: ArenaRef = env
            .storage()
            .persistent()
            .get(&DataKey::ArenaRef(arena_id))
            .ok_or(Error::ArenaNotFound)?;

        // Only the host (pool creator) may manage the whitelist.
        arena_ref.host.require_auth();

        for address in addresses.iter() {
            env.storage()
                .persistent()
                .set(&DataKey::ArenaWhitelist(arena_id, address.clone()), &true);
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
        let arena_ref: ArenaRef = env
            .storage()
            .persistent()
            .get(&DataKey::ArenaRef(arena_id))
            .ok_or(Error::ArenaNotFound)?;

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
        env.storage()
            .persistent()
            .get(&DataKey::ArenaWhitelist(arena_id, player))
            .unwrap_or(false)
    }

    pub fn update_arena_status(env: Env, arena_id: u64, status: ArenaStatus) -> Result<(), Error> {
        let mut arena_ref: ArenaRef = env
            .storage()
            .persistent()
            .get(&DataKey::ArenaRef(arena_id))
            .ok_or(Error::ArenaNotFound)?;

        // Enforce that only the corresponding ArenaContract can update its status.
        arena_ref.contract.require_auth();

        arena_ref.status = status;
        env.storage()
            .persistent()
            .set(&DataKey::ArenaRef(arena_id), &arena_ref);

        Ok(())
    }

    /// Add a token to the supported currency list. Admin-only.
    pub fn add_supported_token(env: Env, token: Address) -> Result<(), Error> {
        let admin = require_admin(&env)?;
        require_not_paused(&env)?;
        admin.require_auth();
        env.storage()
            .instance()
            .set(&DataKey::SupportedToken(token.clone()), &true);
        env.events()
            .publish((TOPIC_TOKEN_ADDED,), (EVENT_VERSION, false, true, token));
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
        env.storage()
            .instance()
            .remove(&DataKey::SupportedToken(token.clone()));
        env.events()
            .publish((TOPIC_TOKEN_REMOVED,), (EVENT_VERSION, token));
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

        if env.storage().instance().has(&PENDING_HASH_KEY) {
            return Err(Error::UpgradeAlreadyPending);
        }

        let execute_after: u64 = env.ledger().timestamp() + TIMELOCK_PERIOD;
        env.storage()
            .instance()
            .set(&PENDING_HASH_KEY, &new_wasm_hash);
        env.storage()
            .instance()
            .set(&EXECUTE_AFTER_KEY, &execute_after);

        env.events().publish(
            (TOPIC_UPGRADE_PROPOSED,),
            (EVENT_VERSION, new_wasm_hash, execute_after),
        );
        Ok(())
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

        let has_pending_hash = env.storage().instance().has(&PENDING_HASH_KEY);
        let has_execute_after = env.storage().instance().has(&EXECUTE_AFTER_KEY);
        match (has_pending_hash, has_execute_after) {
            (false, false) => return Err(Error::NoPendingUpgrade),
            (true, false) | (false, true) => return Err(Error::MalformedUpgradeState),
            (true, true) => {}
        }

        let execute_after: u64 = env
            .storage()
            .instance()
            .get(&EXECUTE_AFTER_KEY)
            .ok_or(Error::MalformedUpgradeState)?;

        if env.ledger().timestamp() < execute_after {
            return Err(Error::TimelockNotExpired);
        }

        let stored_hash: BytesN<32> = env
            .storage()
            .instance()
            .get(&PENDING_HASH_KEY)
            .ok_or(Error::MalformedUpgradeState)?;

        if stored_hash != expected_hash {
            return Err(Error::HashMismatch);
        }

        // Clear pending state before upgrading.
        env.storage().instance().remove(&PENDING_HASH_KEY);
        env.storage().instance().remove(&EXECUTE_AFTER_KEY);

        env.events().publish(
            (TOPIC_UPGRADE_EXECUTED,),
            (EVENT_VERSION, stored_hash.clone()),
        );

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

        if !env.storage().instance().has(&PENDING_HASH_KEY) {
            return Err(Error::NoPendingUpgrade);
        }

        env.storage().instance().remove(&PENDING_HASH_KEY);
        env.storage().instance().remove(&EXECUTE_AFTER_KEY);

        env.events()
            .publish((TOPIC_UPGRADE_CANCELLED,), (EVENT_VERSION,));
        Ok(())
    }

    /// Return the pending WASM hash and the earliest execution timestamp,
    /// or `None` if no upgrade has been proposed.
    ///
    /// # Authorization
    /// None — read-only, open to any caller.
    pub fn pending_upgrade(env: Env) -> Option<(BytesN<32>, u64)> {
        let hash: Option<BytesN<32>> = env.storage().instance().get(&PENDING_HASH_KEY);
        let after: Option<u64> = env.storage().instance().get(&EXECUTE_AFTER_KEY);
        match (hash, after) {
            (Some(h), Some(a)) => Some((h, a)),
            _ => None,
        }
    }

    /// Get metadata for a specific pool.
    pub fn get_arena(env: Env, pool_id: u32) -> Option<ArenaMetadata> {
        env.storage().persistent().get(&DataKey::Pool(pool_id))
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
        env.storage()
            .instance()
            .get(&PAUSED_KEY)
            .unwrap_or(false)
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
    if env
        .storage()
        .instance()
        .get(&PAUSED_KEY)
        .unwrap_or(false)
    {
        return Err(Error::Paused);
    }
    Ok(())
}

#[cfg(test)]
mod test;
