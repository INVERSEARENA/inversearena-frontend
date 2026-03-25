#![no_std]

use soroban_sdk::{
    contract, contracterror, contractimpl, contracttype, symbol_short, Address, BytesN, Env, Symbol,
    Vec,
};

// ── Storage keys ─────────────────────────────────────────────────────────────

const ADMIN_KEY: Symbol = symbol_short!("ADMIN");
const PENDING_HASH_KEY: Symbol = symbol_short!("P_HASH");
const EXECUTE_AFTER_KEY: Symbol = symbol_short!("P_AFTER");
const WHITELIST_PREFIX: Symbol = symbol_short!("WL");
const MIN_STAKE_KEY: Symbol = symbol_short!("MIN_STK");
const ARENA_WASM_HASH_KEY: Symbol = symbol_short!("AR_WASM");
const POOL_PREFIX: Symbol = symbol_short!("POOL");
const ALL_POOLS_KEY: Symbol = symbol_short!("ALL_P");
const METADATA_PREFIX: Symbol = symbol_short!("META");
const SCHEMA_VERSION_KEY: Symbol = symbol_short!("S_VER");

/// Current schema version. Bump this when storage layout changes.
const CURRENT_SCHEMA_VERSION: u32 = 1;

#[contracttype]
#[derive(Clone, Debug, PartialEq)]
pub struct ArenaMetadata {
    pub pool_id: u32,
    pub creator: Address,
    pub capacity: u32,
    pub stake_amount: i128,
}


// ── Capacity limits ───────────────────────────────────────────────────────────

const MAX_POOL_CAPACITY: u32 = 256;

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
    /// Pool capacity is zero or exceeds `MAX_POOL_CAPACITY`.
    InvalidCapacity = 10,
    /// `create_pool` called before `set_arena_wasm_hash` has been called.
    WasmHashNotSet = 11,
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
    /// None — permissionless; must be called immediately after deploy.
    pub fn initialize(env: Env, admin: Address) -> Result<(), Error> {
        if env.storage().instance().has(&ADMIN_KEY) {
            return Err(Error::AlreadyInitialized);
        }
        env.storage().instance().set(&ADMIN_KEY, &admin);
        env.storage()
            .instance()
            .set(&MIN_STAKE_KEY, &DEFAULT_MIN_STAKE);
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
        Ok(())
    }

    /// Set the WASM hash for arena contract deployment. Admin-only.
    ///
    /// # Errors
    /// * [`Error::NotInitialized`] — contract not initialised.
    pub fn set_arena_wasm_hash(env: Env, wasm_hash: BytesN<32>) -> Result<(), Error> {
        let admin = require_admin(&env)?;
        admin.require_auth();
        env.storage()
            .instance()
            .set(&ARENA_WASM_HASH_KEY, &wasm_hash);
        Ok(())
    }

    /// Add a host address to the whitelist. Admin-only.
    /// Emits `HostWhitelisted(address)`.
    ///
    /// # Errors
    /// * [`Error::NotInitialized`] — contract not initialised.
    pub fn add_to_whitelist(env: Env, host: Address) -> Result<(), Error> {
        let admin = require_admin(&env)?;
        admin.require_auth();
        let key = (WHITELIST_PREFIX, host.clone());
        env.storage().instance().set(&key, &true);
        env.events().publish((TOPIC_HOST_WHITELISTED,), host);
        Ok(())
    }

    /// Remove a host address from the whitelist. Admin-only.
    /// Emits `HostRemoved(address)`.
    ///
    /// # Errors
    /// * [`Error::NotInitialized`] — contract not initialised.
    pub fn remove_from_whitelist(env: Env, host: Address) -> Result<(), Error> {
        let admin = require_admin(&env)?;
        admin.require_auth();
        let key = (WHITELIST_PREFIX, host.clone());
        env.storage().instance().remove(&key);
        env.events().publish((TOPIC_HOST_REMOVED,), host);
        Ok(())
    }

    /// Check if an address is whitelisted.
    ///
    /// # Errors
    /// * [`Error::NotInitialized`] — contract not initialised.
    pub fn is_whitelisted(env: Env, host: Address) -> Result<bool, Error> {
        if !env.storage().instance().has(&ADMIN_KEY) {
            return Err(Error::NotInitialized);
        }
        let key = (WHITELIST_PREFIX, host);
        Ok(env.storage().instance().get(&key).unwrap_or(false))
    }

    /// Set the minimum stake amount. Admin-only.
    ///
    /// # Errors
    /// * [`Error::NotInitialized`] — contract not initialised.
    /// * [`Error::InvalidStakeAmount`] — `min_stake` is negative.
    pub fn set_min_stake(env: Env, min_stake: i128) -> Result<(), Error> {
        let admin = require_admin(&env)?;
        admin.require_auth();
        if min_stake < 0 {
            return Err(Error::InvalidStakeAmount);
        }
        env.storage().instance().set(&MIN_STAKE_KEY, &min_stake);
        Ok(())
    }

    /// Get the minimum stake amount.
    pub fn get_min_stake(env: Env) -> i128 {
        env.storage()
            .instance()
            .get(&MIN_STAKE_KEY)
            .unwrap_or(DEFAULT_MIN_STAKE)
    }

    /// Create a new pool (arena). Only admin or whitelisted hosts can call this.
    ///
    /// The caller must provide a valid stake amount >= minimum stake and a
    /// capacity in range [1, MAX_POOL_CAPACITY]. `pool_id` must be unique.
    /// Emits `PoolCreated(pool_id, creator, capacity, stake_amount)`.
    ///
    /// # Errors
    /// * [`Error::NotInitialized`] — contract not initialised.
    /// * [`Error::Unauthorized`] — `caller` is neither admin nor whitelisted.
    /// * [`Error::PoolAlreadyExists`] — a pool with `pool_id` already exists.
    /// * [`Error::InvalidCapacity`] — `capacity` is 0 or > `MAX_POOL_CAPACITY`.
    /// * [`Error::InvalidStakeAmount`] — `stake_amount` is zero or negative.
    /// * [`Error::StakeBelowMinimum`] — `stake_amount` is below the configured minimum.
    /// * [`Error::WasmHashNotSet`] — `set_arena_wasm_hash` has not been called yet.
    pub fn create_pool(
        env: Env,
        caller: Address,
        creator: Address,
        pool_id: u32,
        capacity: u32,
        stake_amount: i128,
    ) -> Result<(), Error> {
        let admin = require_admin(&env)?;

        let is_admin = caller == admin;
        let is_whitelisted = Self::is_whitelisted(env.clone(), caller.clone())?;

        if !is_admin && !is_whitelisted {
            return Err(Error::Unauthorized);
        }

        let pool_key = (POOL_PREFIX, pool_id);
        if env.storage().instance().has(&pool_key) {
            return Err(Error::PoolAlreadyExists);
        }

        if capacity == 0 || capacity > MAX_POOL_CAPACITY {
            return Err(Error::InvalidCapacity);
        }

        let min_stake = Self::get_min_stake(env.clone());
        if stake_amount <= 0 {
            return Err(Error::InvalidStakeAmount);
        }
        if stake_amount < min_stake {
            return Err(Error::StakeBelowMinimum);
        }

        if !env.storage().instance().has(&ARENA_WASM_HASH_KEY) {
            return Err(Error::WasmHashNotSet);
        }

        env.storage().instance().set(&pool_key, &true);

        let metadata = ArenaMetadata {
            pool_id,
            creator: creator.clone(),
            capacity,
            stake_amount,
        };
        let meta_key = (METADATA_PREFIX, pool_id);
        env.storage().instance().set(&meta_key, &metadata);

        let mut all_pools: soroban_sdk::Vec<u32> = env
            .storage()
            .instance()
            .get(&ALL_POOLS_KEY)
            .unwrap_or_else(|| soroban_sdk::Vec::new(&env));
        all_pools.push_back(pool_id);
        env.storage().instance().set(&ALL_POOLS_KEY, &all_pools);

        env.events()
            .publish((TOPIC_POOL_CREATED,), (pool_id, creator, capacity, stake_amount));

        Ok(())
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

        let execute_after: u64 = env.ledger().timestamp() + TIMELOCK_PERIOD;
        env.storage()
            .instance()
            .set(&PENDING_HASH_KEY, &new_wasm_hash);
        env.storage()
            .instance()
            .set(&EXECUTE_AFTER_KEY, &execute_after);

        env.events()
            .publish((TOPIC_UPGRADE_PROPOSED,), (new_wasm_hash, execute_after));
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
    pub fn execute_upgrade(env: Env) -> Result<(), Error> {
        let admin = require_admin(&env)?;
        admin.require_auth();

        let execute_after: u64 = env
            .storage()
            .instance()
            .get(&EXECUTE_AFTER_KEY)
            .ok_or(Error::NoPendingUpgrade)?;

        if env.ledger().timestamp() < execute_after {
            return Err(Error::TimelockNotExpired);
        }

        let new_wasm_hash: BytesN<32> = env
            .storage()
            .instance()
            .get(&PENDING_HASH_KEY)
            .ok_or(Error::NoPendingUpgrade)?;

        // Clear pending state before upgrading.
        env.storage().instance().remove(&PENDING_HASH_KEY);
        env.storage().instance().remove(&EXECUTE_AFTER_KEY);

        env.events()
            .publish((TOPIC_UPGRADE_EXECUTED,), new_wasm_hash.clone());

        env.deployer().update_current_contract_wasm(new_wasm_hash);
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

        env.events().publish((TOPIC_UPGRADE_CANCELLED,), ());
        Ok(())
    }

    // ── Query methods ─────────────────────────────────────────────────────

    /// Return the metadata for a single arena by `pool_id`, or `None` if
    /// no pool with that id exists.
    pub fn get_arena(env: Env, pool_id: u32) -> Option<ArenaMetadata> {
        let meta_key = (METADATA_PREFIX, pool_id);
        env.storage().instance().get(&meta_key)
    }

    /// Return a page of arena metadata entries.
    ///
    /// * `offset` — number of entries to skip from the beginning.
    /// * `limit`  — maximum number of entries to return.
    pub fn get_arenas(env: Env, offset: u32, limit: u32) -> Vec<ArenaMetadata> {
        let all_pools: Vec<u32> = env
            .storage()
            .instance()
            .get(&ALL_POOLS_KEY)
            .unwrap_or_else(|| Vec::new(&env));

        let mut result = Vec::new(&env);
        let len = all_pools.len();
        let start = offset;
        let end = if offset + limit > len {
            len
        } else {
            offset + limit
        };

        let mut i = start;
        while i < end {
            let pool_id = all_pools.get(i).unwrap();
            let meta_key = (METADATA_PREFIX, pool_id);
            if let Some(meta) = env.storage().instance().get::<_, ArenaMetadata>(&meta_key) {
                result.push_back(meta);
            }
            i += 1;
        }
        result
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
}

// ── Private helpers ───────────────────────────────────────────────────────────

/// Return the stored admin address, or `Error::NotInitialized` if absent.
fn require_admin(env: &Env) -> Result<Address, Error> {
    env.storage()
        .instance()
        .get(&ADMIN_KEY)
        .ok_or(Error::NotInitialized)
}

#[cfg(test)]
mod test;
