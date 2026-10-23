#![no_std]
#![cfg_attr(coverage_nightly, feature(coverage_attribute))]

mod events;
mod snapshot_tests;
mod storage;
pub mod types;

#[cfg(test)]
mod index_tests;

#[cfg(test)]
mod integration_tests;

#[cfg(test)]
mod auth_tests;

use storage::{CreatorStakeRecord, FactoryStorage};
use types::{ArenaMetadata, ArenaStatus, FactoryError, PoolConfig, VaultConfig};

use soroban_sdk::{
    Address, BytesN, Env, Symbol, Vec, contract, contractclient, contractimpl, symbol_short,
    token,
};

/// Must match `arena::MAX_PLAYERS_ALLOWED` (contract/arena/src/lib.rs) exactly
/// — kept as a duplicated local constant, not `use arena::MAX_PLAYERS_ALLOWED`,
/// because depending on the `arena` crate as a real (non-dev) dependency here
/// statically links its `#[contractimpl]` block into factory's own wasm
/// binary, and both contracts export an `unpause` symbol, which collides at
/// link time (see the "Optimize contract WASM" Contract CI step). `arena`
/// stays a dev-dependency for integration tests, which need the real
/// contract. If this drifts from arena's constant, `create_pool` will accept
/// configs arena's own `initialize` then rejects, reverting the transaction.
const MAX_PLAYERS_ALLOWED: u32 = 100;

/// Local stub for the one arena entry point factory calls in production
/// (`initialize`, right after deploying a new arena instance). Deliberately
/// not `use arena::ArenaContractClient` — depending on the full `arena`
/// crate here would statically link its `#[contractimpl]` block into
/// factory's own wasm binary, and both contracts export an `unpause`
/// symbol, which collides at link time. `arena` stays a dev-dependency for
/// integration tests, which need the real contract.
#[contractclient(name = "ArenaClient")]
pub trait ArenaInterface {
    #[allow(clippy::too_many_arguments)]
    fn initialize(
        env: Env,
        admin: Address,
        stake_token: Address,
        yield_vault: Address,
        entry_fee: i128,
        oracle_contract: Address,
        factory: Address,
        pool_id: u32,
        min_players: u32,
        max_players: u32,
        round_duration: u64,
    );
    /// Set right after `initialize`; see arena's `set_start_deadline` (#1579).
    fn set_start_deadline(env: Env, deadline: u64);
}

/// Local stub for the RWA adapter's `config()` read (#1634). Local for the
/// same link-time reason as `ArenaClient` above.
#[contractclient(name = "VaultClient")]
pub trait VaultInterface {
    fn config(env: Env) -> VaultConfig;
}

const MIN_ROUND_DURATION: u64 = 60;
const MAX_ROUND_DURATION: u64 = 604_800;
const MIN_PLAYERS: u32 = 2;
/// The lobby must stay open for at least this long after pool creation, so a
/// host cannot create an arena that is effectively already expired (#1579).
const MIN_START_DELAY_SECONDS: u64 = 300;
/// Upper bound for `PoolConfig.start_deadline` (30 days). A longer window
/// would let entry fees sit locked with no realistic cancellation path.
const MAX_START_DELAY_SECONDS: u64 = 2_592_000;
/// Factory contract ABI/storage version, for client-side capability
/// negotiation across mixed deployment versions (see arena::CONTRACT_VERSION
/// for the sibling contract's own counter — these are independent).
/// Bumped to 2 for #1583: adds `set_global_pause` and `is_globally_paused`.
/// Bumped to 3 for #1572: adds `get_active_pool_count`, a read-only view of
/// a host's current Active-pool count for rematch headroom checks.
const CONTRACT_VERSION: u32 = 3;

/// The decimal precision `min_stake` is denominated in, matching Stellar's
/// native asset (and the staking contract's own `MIN_INITIAL_STAKE`
/// convention). `create_pool` scales it to each `stake_token`'s actual
/// on-chain decimals so the same admin-configured "real-world" minimum
/// applies uniformly regardless of which approved token a creator picks
/// (#1361).
const MIN_STAKE_REFERENCE_DECIMALS: u32 = 7;

/// Factory contract — deploys arena instances and enforces protocol-level rules.
///
/// Architecture overview: see `ARCHITECTURE.md` in the workspace root.
#[contract]
pub struct FactoryContract;

#[contractimpl]
impl FactoryContract {
    pub fn initialize(env: Env, admin: Address, min_stake: i128) -> Result<(), FactoryError> {
        admin.require_auth();
        if FactoryStorage::has_admin(&env) {
            return Err(FactoryError::AlreadyInitialized);
        }
        if min_stake <= 0 {
            return Err(FactoryError::InvalidStakeAmount);
        }

        FactoryStorage::save_admin(&env, &admin);
        FactoryStorage::save_min_stake(&env, min_stake);
        env.events()
            .publish((symbol_short!("INIT"),), (admin, min_stake));
        Ok(())
    }

    /// Return the factory contract ABI/storage version.
    pub fn version(_env: Env) -> u32 {
        CONTRACT_VERSION
    }

    /// Upgrade the factory contract's code to `new_wasm_hash`.
    ///
    /// Admin-gated. Upgrading in place preserves all existing state — admin,
    /// whitelist, pool sequence, and creator stakes — so bug fixes and new
    /// features can ship without redeploying and losing that state.
    pub fn upgrade(env: Env, new_wasm_hash: BytesN<32>) -> Result<(), FactoryError> {
        Self::require_admin(&env)?;
        env.deployer().update_current_contract_wasm(new_wasm_hash);
        env.events().publish((symbol_short!("UPGRADE"),), ());
        Ok(())
    }

    pub fn set_arena_wasm_hash(env: Env, wasm_hash: BytesN<32>) -> Result<(), FactoryError> {
        Self::require_admin(&env)?;
        FactoryStorage::save_arena_wasm_hash(&env, &wasm_hash);
        env.events().publish((symbol_short!("WASM_UP"),), wasm_hash);
        Ok(())
    }

    pub fn add_to_whitelist(env: Env, host: Address) -> Result<(), FactoryError> {
        Self::require_admin(&env)?;
        FactoryStorage::set_whitelisted(&env, &host, true);
        env.events().publish((symbol_short!("WL_ADD"),), host);
        Ok(())
    }

    pub fn remove_from_whitelist(env: Env, host: Address) -> Result<(), FactoryError> {
        Self::require_admin(&env)?;
        FactoryStorage::set_whitelisted(&env, &host, false);
        env.events().publish((symbol_short!("WL_REM"),), host);
        Ok(())
    }

    pub fn is_whitelisted(env: Env, host: Address) -> bool {
        FactoryStorage::is_whitelisted(&env, &host)
    }

    /// Approve `vault` for new pools, registering it together with its
    /// stake token (#1634).
    ///
    /// Reads the vault's `config()` and stores the token, so a later
    /// `create_pool` can detect a vault whose asset has since changed (for
    /// example through an upgrade). Calling it again for an approved vault
    /// re-reads and re-registers the token; that is also how a vault
    /// approved before #1634 is migrated.
    ///
    /// # Errors
    /// - `FactoryError::InvalidVault` if `vault` does not answer `config()`
    ///   (not a contract, not an RWA adapter, or not initialised).
    pub fn add_approved_vault(env: Env, vault: Address) -> Result<(), FactoryError> {
        Self::require_admin(&env)?;
        let vault_config = Self::read_vault_config(&env, &vault)?;
        FactoryStorage::set_approved_vault(&env, &vault, true);
        FactoryStorage::save_approved_vault_token(&env, &vault, &vault_config.stake_token);
        env.events()
            .publish((symbol_short!("VLT_ADD"),), (vault, vault_config.stake_token));
        Ok(())
    }

    pub fn remove_approved_vault(env: Env, vault: Address) -> Result<(), FactoryError> {
        Self::require_admin(&env)?;
        FactoryStorage::set_approved_vault(&env, &vault, false);
        FactoryStorage::remove_approved_vault_token(&env, &vault);
        env.events().publish((symbol_short!("VLT_REM"),), vault);
        Ok(())
    }

    /// The stake token `vault` was approved with (#1634), or `None` if it is
    /// not approved. Lets clients offer only vault/token pairs that
    /// `create_pool` will accept.
    pub fn get_approved_vault_token(env: Env, vault: Address) -> Option<Address> {
        if !FactoryStorage::is_approved_vault(&env, &vault) {
            return None;
        }
        FactoryStorage::load_approved_vault_token(&env, &vault)
    }

    pub fn add_approved_oracle(env: Env, oracle: Address) -> Result<(), FactoryError> {
        Self::require_admin(&env)?;
        FactoryStorage::set_approved_oracle(&env, &oracle, true);
        env.events().publish((symbol_short!("ORC_ADD"),), oracle);
        Ok(())
    }

    pub fn remove_approved_oracle(env: Env, oracle: Address) -> Result<(), FactoryError> {
        Self::require_admin(&env)?;
        FactoryStorage::set_approved_oracle(&env, &oracle, false);
        env.events().publish((symbol_short!("ORC_REM"),), oracle);
        Ok(())
    }

    pub fn is_approved_vault(env: Env, vault: Address) -> bool {
        FactoryStorage::is_approved_vault(&env, &vault)
    }

    pub fn is_approved_oracle(env: Env, oracle: Address) -> bool {
        FactoryStorage::is_approved_oracle(&env, &oracle)
    }

    pub fn add_supported_token(env: Env, token: Address) -> Result<(), FactoryError> {
        Self::require_admin(&env)?;
        FactoryStorage::set_supported_token(&env, &token, true);
        env.events().publish((symbol_short!("TOK_ADD"),), token);
        Ok(())
    }

    pub fn remove_supported_token(env: Env, token: Address) -> Result<(), FactoryError> {
        Self::require_admin(&env)?;
        FactoryStorage::set_supported_token(&env, &token, false);
        env.events().publish((symbol_short!("TOK_REM"),), token);
        Ok(())
    }

    pub fn is_token_supported(env: Env, token: Address) -> bool {
        FactoryStorage::is_supported_token(&env, &token)
    }

    /// Returns up to 50 supported tokens starting at the requested offset.
    pub fn list_supported_tokens(env: Env, offset: u32, limit: u32) -> Vec<Address> {
        FactoryStorage::list_supported_tokens(&env, offset, limit)
    }

    pub fn get_min_stake(env: Env) -> Result<i128, FactoryError> {
        FactoryStorage::load_min_stake(&env)
    }

    pub fn set_max_active_pools(env: Env, max: u32) -> Result<(), FactoryError> {
        Self::require_admin(&env)?;
        FactoryStorage::save_max_active_pools(&env, max);
        env.events().publish((symbol_short!("MXPLCFG"),), max);
        Ok(())
    }

    pub fn get_max_active_pools(env: Env) -> u32 {
        FactoryStorage::load_max_active_pools(&env)
    }

    /// Return how many Active pools `host` currently has (#1572).
    ///
    /// Read-only. Lets off-chain rematch tooling check the host's
    /// `max_active_pools` headroom before prompting them to create a
    /// rematch pool.
    pub fn get_active_pool_count(env: Env, host: Address) -> u32 {
        FactoryStorage::load_active_pool_count(&env, &host)
    }

    /// Pause the factory, blocking new pool creation.
    pub fn pause(env: Env) -> Result<(), FactoryError> {
        Self::require_admin(&env)?;
        FactoryStorage::set_paused(&env, true);
        env.events().publish((symbol_short!("PAUSED"),), ());
        Ok(())
    }

    /// Unpause the factory, resuming normal operations.
    pub fn unpause(env: Env) -> Result<(), FactoryError> {
        Self::require_admin(&env)?;
        FactoryStorage::set_paused(&env, false);
        env.events().publish((symbol_short!("UNPAUS"),), ());
        Ok(())
    }

    /// Set or clear the protocol-wide emergency pause (#1583).
    ///
    /// While set, every arena deployed by this factory rejects its
    /// fund-moving entry points with `ArenaError::GloballyPaused`, on top of
    /// (not instead of) each arena's own host-controlled pause. Only the
    /// protocol admin may call this. The admin is expected to be a Stellar
    /// multisig account whose medium threshold needs two signers, so the
    /// call carries two-person approval through `require_auth`.
    ///
    /// # Events
    /// Emits `GPAUSE` with `(paused, reason)`.
    pub fn set_global_pause(env: Env, paused: bool, reason: Symbol) -> Result<(), FactoryError> {
        Self::require_admin(&env)?;
        FactoryStorage::set_globally_paused(&env, paused);
        env.events()
            .publish((symbol_short!("GPAUSE"),), (paused, reason));
        Ok(())
    }

    /// Whether the protocol-wide emergency pause is set (#1583). Read by every
    /// arena's fund-moving entry points.
    pub fn is_globally_paused(env: Env) -> bool {
        FactoryStorage::is_globally_paused(&env)
    }

    /// Release an arena from a creator's active pool count.
    ///
    /// Called by the arena contract itself (verified via creator stake record)
    /// when the arena finishes or is cancelled. Decrements the creator's active
    /// pool count, allowing the creator to deploy new arenas.
    /// Deliberately **not** gated on `is_paused` (#1360).
    ///
    /// Pause exists to stop new activity — chiefly `create_pool`. This is the
    /// opposite: a bookkeeping decrement for an arena that has already finished
    /// or cancelled, triggered by that arena's own lifecycle, not by a user
    /// starting something new.
    ///
    /// Gating it caused permanent damage. The arena calls this exactly once, via
    /// `try_release_arena`, with no retry path. If the factory happened to be
    /// paused at that moment the call failed silently, while the neighbouring
    /// `try_reclaim_creator_stake` — which has no pause check — still succeeded
    /// and removed the stake record. Any later retry then fails with
    /// `ArenaNotFound`, so the creator loses one `max_active_pools` slot forever,
    /// for an arena that has already fully completed.
    pub fn release_arena(env: Env, arena: Address) -> Result<(), FactoryError> {
        arena.require_auth();

        // Verify this arena was deployed by the factory
        let record =
            FactoryStorage::load_creator_stake(&env, &arena).ok_or(FactoryError::ArenaNotFound)?;

        FactoryStorage::decrement_active_pool_count(&env, &record.creator);

        env.events()
            .publish((symbol_short!("POOL_RLS"),), record.creator);
        Ok(())
    }

    pub fn create_pool(
        env: Env,
        host: Address,
        config: PoolConfig,
        metadata_hash: BytesN<32>,
    ) -> Result<Address, FactoryError> {
        if FactoryStorage::is_paused(&env) {
            return Err(FactoryError::ContractPaused);
        }
        host.require_auth();
        FactoryStorage::load_admin(&env)?;

        if config.round_duration < MIN_ROUND_DURATION
            || config.round_duration > MAX_ROUND_DURATION
            || config.min_players < MIN_PLAYERS
            || config.min_players > config.max_players
            || config.max_players > MAX_PLAYERS_ALLOWED
        {
            return Err(FactoryError::InvalidConfig);
        }

        // #1579: bound the lobby lifetime relative to creation. Too short and
        // the pool is stillborn; too long and entry fees are locked for an
        // unreasonable period.
        let now = env.ledger().timestamp();
        if config.start_deadline < now.saturating_add(MIN_START_DELAY_SECONDS)
            || config.start_deadline > now.saturating_add(MAX_START_DELAY_SECONDS)
        {
            return Err(FactoryError::InvalidStartDeadline);
        }
        if !FactoryStorage::is_whitelisted(&env, &host) {
            return Err(FactoryError::HostNotWhitelisted);
        }
        if config.entry_fee <= 0 {
            return Err(FactoryError::EntryFeeTooLow);
        }
        if !FactoryStorage::is_supported_token(&env, &config.stake_token) {
            return Err(FactoryError::UnsupportedToken);
        }
        let min_stake = FactoryStorage::load_min_stake(&env)?;
        let effective_min_stake = Self::normalize_min_stake(&env, &config.stake_token, min_stake)?;
        if config.entry_fee < effective_min_stake {
            return Err(FactoryError::StakeBelowMinimum);
        }
        if !FactoryStorage::is_approved_vault(&env, &config.yield_vault) {
            return Err(FactoryError::InvalidVault);
        }
        if !FactoryStorage::is_approved_oracle(&env, &config.oracle_contract) {
            return Err(FactoryError::InvalidOracle);
        }
        Self::check_vault_compatibility(&env, &config)?;

        // Check active pool limit for this host
        let max_pools = FactoryStorage::load_max_active_pools(&env);
        let active = FactoryStorage::load_active_pool_count(&env, &host);
        if active >= max_pools {
            return Err(FactoryError::MaxActivePoolsReached);
        }

        let wasm_hash = FactoryStorage::load_arena_wasm_hash(&env)?;
        let pool_id = FactoryStorage::next_pool_id(&env)?;

        // Collect the creator's stake into the factory *before* deploying, so a
        // host genuinely locks `entry_fee` of skin-in-the-game on-chain rather
        // than the factory merely recording a stake it never held.
        Self::collect_creator_stake(&env, &host, &config.stake_token, config.entry_fee);

        let arena = env
            .deployer()
            .with_current_contract(Self::salt_for_pool(&env, pool_id))
            .deploy_v2(wasm_hash, ());

        ArenaClient::new(&env, &arena).initialize(
            &host,
            &config.stake_token,
            &config.yield_vault,
            &config.entry_fee,
            &config.oracle_contract,
            &env.current_contract_address(),
            &pool_id,
            &config.min_players,
            &config.max_players,
            &config.round_duration,
        );
        ArenaClient::new(&env, &arena).set_start_deadline(&config.start_deadline);

        FactoryStorage::save_creator_stake(
            &env,
            &arena,
            &CreatorStakeRecord {
                creator: host.clone(),
                amount: config.entry_fee,
                stake_token: config.stake_token.clone(),
            },
        );
        FactoryStorage::increment_active_pool_count(&env, &host);

        let pool_metadata = ArenaMetadata {
            arena_address: arena.clone(),
            pool_id,
            host: host.clone(),
            entry_fee: config.entry_fee,
            status: ArenaStatus::Active,
            created_at: env.ledger().timestamp(),
            metadata_hash: metadata_hash.clone(),
        };
        FactoryStorage::save_pool(&env, pool_id, &pool_metadata);
        FactoryStorage::increment_pool_count(&env);

        // #1613: update secondary indexes atomically with pool creation.
        FactoryStorage::index_host_pool(&env, &host, pool_id);
        FactoryStorage::index_pool_status(&env, pool_id, &ArenaStatus::Active);

        // #1607: emit via typed helper with normalized topics + versioned payload.
        events::pool_created(&env, &host, pool_id, &arena, config.entry_fee);
        env.events().publish(
            (symbol_short!("POOL_CRE"),),
            (
                pool_id,
                host.clone(),
                config.entry_fee,
                arena.clone(),
                config.min_players,
                config.max_players,
                config.round_duration,
                metadata_hash,
            ),
        );
        Ok(arena)
    }

    pub fn get_creator_stake(env: Env, arena: Address) -> Option<CreatorStakeRecord> {
        FactoryStorage::load_creator_stake(&env, &arena)
    }

    /// Refund a creator's locked stake once their arena has completed.
    ///
    /// Authorised by the `arena` itself: a deployed arena releases its creator
    /// stake as part of reaching a terminal state, which is the on-chain
    /// "arena completed" gate — a host cannot pull their own stake early. The
    /// recorded amount is transferred from the factory back to the creator and
    /// the stake record is cleared so it cannot be reclaimed twice.
    pub fn reclaim_creator_stake(env: Env, arena: Address) -> Result<(), FactoryError> {
        let record =
            FactoryStorage::load_creator_stake(&env, &arena).ok_or(FactoryError::ArenaNotFound)?;

        // Only the arena contract can authorise releasing its own creator stake.
        arena.require_auth();

        let token_client = token::TokenClient::new(&env, &record.stake_token);
        token_client.transfer(
            &env.current_contract_address(),
            &record.creator,
            &record.amount,
        );

        FactoryStorage::remove_creator_stake(&env, &arena);
        env.events().publish(
            (symbol_short!("STK_RCLM"),),
            (arena, record.creator, record.amount),
        );
        Ok(())
    }

    /// Reject a pool whose vault would hold a different asset, or accrue
    /// yield from a different oracle, than the arena expects (#1634).
    ///
    /// Each check exists because the separate approvals cannot catch it: an
    /// approved vault for token B plus a supported token A passes them all,
    /// and the arena then fails at its first join (or moves the wrong asset).
    /// The vault's live config is read every time, so a vault upgraded to a
    /// different token after approval no longer matches its registered token
    /// and is refused until the admin re-approves it.
    fn check_vault_compatibility(env: &Env, config: &PoolConfig) -> Result<(), FactoryError> {
        // A vault approved before #1634 has no registered token; it must be
        // re-approved (which records one) before it can back new pools.
        let registered_token = FactoryStorage::load_approved_vault_token(env, &config.yield_vault)
            .ok_or(FactoryError::InvalidVault)?;
        let vault_config = Self::read_vault_config(env, &config.yield_vault)?;

        if vault_config.stake_token != registered_token
            || vault_config.stake_token != config.stake_token
        {
            return Err(FactoryError::VaultTokenMismatch);
        }
        if vault_config.oracle != config.oracle_contract {
            return Err(FactoryError::OracleMismatch);
        }
        Ok(())
    }

    /// Read `vault`'s `config()`, mapping any failure — no contract at that
    /// address, a contract without the entry point, or an uninitialised
    /// adapter — to `InvalidVault`.
    fn read_vault_config(env: &Env, vault: &Address) -> Result<VaultConfig, FactoryError> {
        match VaultClient::new(env, vault).try_config() {
            Ok(Ok(vault_config)) => Ok(vault_config),
            _ => Err(FactoryError::InvalidVault),
        }
    }

    /// Transfer `amount` of `stake_token` from the host into the factory.
    /// Separated out so the collection logic can be exercised directly in unit
    /// tests without standing up a full arena deployment.
    fn collect_creator_stake(env: &Env, host: &Address, stake_token: &Address, amount: i128) {
        let token_client = token::TokenClient::new(env, stake_token);
        token_client.transfer(host, &env.current_contract_address(), &amount);
    }

    /// Scale the admin-configured `min_stake` (denominated in
    /// `MIN_STAKE_REFERENCE_DECIMALS`) to `stake_token`'s actual on-chain
    /// decimals, so the effective real-world minimum creator stake is
    /// consistent across every supported token regardless of its precision
    /// (#1361). Reads `decimals()` from the standard token interface, which
    /// every approved token must already implement.
    fn normalize_min_stake(
        env: &Env,
        stake_token: &Address,
        min_stake: i128,
    ) -> Result<i128, FactoryError> {
        let token_decimals = token::TokenClient::new(env, stake_token).decimals();
        if token_decimals == MIN_STAKE_REFERENCE_DECIMALS {
            return Ok(min_stake);
        }
        if token_decimals > MIN_STAKE_REFERENCE_DECIMALS {
            let scale = 10i128
                .checked_pow(token_decimals - MIN_STAKE_REFERENCE_DECIMALS)
                .ok_or(FactoryError::ArithmeticOverflow)?;
            min_stake
                .checked_mul(scale)
                .ok_or(FactoryError::ArithmeticOverflow)
        } else {
            let scale = 10i128
                .checked_pow(MIN_STAKE_REFERENCE_DECIMALS - token_decimals)
                .ok_or(FactoryError::ArithmeticOverflow)?;
            // Round up: a token with fewer decimals than the reference must
            // never let a floor computation round down to a weaker minimum
            // than intended.
            let (quotient, remainder) = (min_stake / scale, min_stake % scale);
            if remainder == 0 {
                Ok(quotient)
            } else {
                quotient
                    .checked_add(1)
                    .ok_or(FactoryError::ArithmeticOverflow)
            }
        }
    }

    /// Update the status of a deployed arena pool.
    ///
    /// Only callable by the arena contract itself. The calling arena's address
    /// must match the recorded arena_address for the given pool_id.
    pub fn update_arena_status(
        env: Env,
        pool_id: u32,
        status: ArenaStatus,
    ) -> Result<(), FactoryError> {
        let meta = FactoryStorage::load_pool(&env, pool_id).ok_or(FactoryError::PoolNotFound)?;
        meta.arena_address.require_auth();
        let old_status = meta.status.clone();
        FactoryStorage::update_pool_status(&env, pool_id, &status);

        // #1613: O(1) swap-remove from old bucket, append to new bucket.
        if old_status != status {
            FactoryStorage::transition_pool_status(&env, pool_id, &old_status, &status);
        }

        // #1607: emit via typed helper with normalized topics + versioned payload.
        events::pool_status_updated(&env, &meta.arena_address, pool_id, FactoryStorage::arena_status_ordinal(&status));
        env.events()
            .publish((symbol_short!("POOL_ST"),), (pool_id, status));
        Ok(())
    }

    /// Get metadata for a specific arena pool by pool_id.
    pub fn get_arena(env: Env, pool_id: u32) -> Option<ArenaMetadata> {
        FactoryStorage::load_pool(&env, pool_id)
    }

    /// Get a paginated list of all arena pools.
    ///
    /// `offset` is the number of pools to skip (0-indexed).
    /// `limit` is the maximum number of pools to return (clamped to 50).
    /// Pools are returned in creation order (pool_id ascending).
    pub fn get_arenas(env: Env, offset: u32, limit: u32) -> Vec<ArenaMetadata> {
        let total = FactoryStorage::pool_count(&env);
        let limit = types::clamp_page_size(limit);
        let mut result: Vec<ArenaMetadata> = Vec::new(&env);
        let start = offset.saturating_add(1);
        let end = core::cmp::min(total, offset.saturating_add(limit));
        if start <= end {
            for pool_id in start..=end {
                if let Some(meta) = FactoryStorage::load_pool(&env, pool_id) {
                    result.push_back(meta);
                }
            }
        }
        result
    }

    /// #1613: Return pools created by `host`, paged by `page` (0-indexed).
    ///
    /// Each page contains up to `HOST_POOLS_PAGE_SIZE` pool IDs.  The caller
    /// iterates pages until an empty page is returned.
    pub fn get_arenas_by_host(env: Env, host: Address, page: u32) -> Vec<ArenaMetadata> {
        let pool_ids = FactoryStorage::get_host_pools_page(&env, &host, page);
        let mut result: Vec<ArenaMetadata> = Vec::new(&env);
        for i in 0..pool_ids.len() {
            if let Some(pool_id) = pool_ids.get(i) {
                if let Some(meta) = FactoryStorage::load_pool(&env, pool_id) {
                    result.push_back(meta);
                }
            }
        }
        result
    }

    /// #1613: Return pools in `status`, paged by `offset` / `limit`.
    ///
    /// Uses the StatusBucket secondary index.  Stable ordering is NOT
    /// guaranteed across status transitions (swap-remove may reorder IDs).
    pub fn get_arenas_by_status(
        env: Env,
        status: ArenaStatus,
        offset: u32,
        limit: u32,
    ) -> Vec<ArenaMetadata> {
        let pool_ids = FactoryStorage::get_pools_by_status(&env, &status, offset, limit);
        let mut result: Vec<ArenaMetadata> = Vec::new(&env);
        for i in 0..pool_ids.len() {
            if let Some(pool_id) = pool_ids.get(i) {
                if let Some(meta) = FactoryStorage::load_pool(&env, pool_id) {
                    result.push_back(meta);
                }
            }
        }
        result
    }

    fn require_admin(env: &Env) -> Result<Address, FactoryError> {
        let admin = FactoryStorage::load_admin(env)?;
        admin.require_auth();
        Ok(admin)
    }

    pub fn propose_admin(env: Env, new_admin: Address) -> Result<(), FactoryError> {
        let admin = FactoryStorage::load_admin(&env)?;
        admin.require_auth();
        FactoryStorage::save_pending_admin(&env, &new_admin);
        env.events()
            .publish((symbol_short!("ADM_PROP"),), (new_admin,));
        Ok(())
    }

    pub fn accept_admin(env: Env) -> Result<(), FactoryError> {
        let pending_admin =
            FactoryStorage::load_pending_admin(&env).ok_or(FactoryError::NoPendingAdmin)?;
        pending_admin.require_auth();
        let old_admin = FactoryStorage::load_admin(&env)?;
        FactoryStorage::save_admin(&env, &pending_admin);
        FactoryStorage::delete_pending_admin(&env);
        env.events()
            .publish((symbol_short!("ADM_CHG"),), (old_admin, pending_admin));
        Ok(())
    }

    fn salt_for_pool(env: &Env, pool_id: u32) -> BytesN<32> {
        let mut salt = [0u8; 32];
        let bytes = pool_id.to_be_bytes();
        salt[28] = bytes[0];
        salt[29] = bytes[1];
        salt[30] = bytes[2];
        salt[31] = bytes[3];
        BytesN::from_array(env, &salt)
    }
}

#[cfg(test)]
#[cfg_attr(coverage_nightly, coverage(off))]
mod test {
    use super::*;
    use soroban_sdk::testutils::Address as _;

    fn setup() -> (Env, FactoryContractClient<'static>, Address, Address) {
        let env = Env::default();
        env.mock_all_auths();
        let contract_id = env.register(FactoryContract, ());
        let client = FactoryContractClient::new(&env, &contract_id);
        let admin = Address::generate(&env);
        let host = Address::generate(&env);
        client.initialize(&admin, &100);
        (env, client, admin, host)
    }

    fn pool_config(env: &Env, entry_fee: i128) -> PoolConfig {
        PoolConfig {
            stake_token: Address::generate(env),
            yield_vault: Address::generate(env),
            entry_fee,
            oracle_contract: Address::generate(env),
            min_players: 2,
            max_players: 10,
            round_duration: 60,
            start_deadline: env.ledger().timestamp() + 86_400,
        }
    }

    fn metadata_hash(env: &Env) -> BytesN<32> {
        BytesN::from_array(env, &[7u8; 32])
    }

    /// A stand-in RWA adapter that only answers `config()` (#1634), with a
    /// stake token and oracle the test can change afterwards — which is how
    /// these tests model a vault upgraded to a different asset.
    mod vault_mock {
        use crate::types::VaultConfig;
        use soroban_sdk::{Address, Env, contract, contractimpl, symbol_short};

        #[contract]
        pub struct MockVault;

        #[contractimpl]
        impl MockVault {
            pub fn set_config(env: Env, stake_token: Address, oracle: Address) {
                env.storage()
                    .instance()
                    .set(&symbol_short!("CFG"), &VaultConfig { stake_token, oracle });
            }

            pub fn config(env: Env) -> VaultConfig {
                env.storage()
                    .instance()
                    .get(&symbol_short!("CFG"))
                    .expect("mock vault not configured")
            }
        }
    }

    fn mock_vault(env: &Env, stake_token: &Address, oracle: &Address) -> Address {
        let vault = env.register(vault_mock::MockVault, ());
        vault_mock::MockVaultClient::new(env, &vault).set_config(stake_token, oracle);
        vault
    }

    /// A whitelisted host plus a config whose token, vault and oracle are all
    /// approved and mutually consistent, so the only thing `create_pool` can
    /// still object to is whatever a test changes next.
    fn compatible_pool(
        env: &Env,
        client: &FactoryContractClient<'static>,
        host: &Address,
    ) -> PoolConfig {
        client.add_to_whitelist(host);
        let mut cfg = pool_config_with_real_token(env, 100);
        cfg.yield_vault = mock_vault(env, &cfg.stake_token, &cfg.oracle_contract);
        client.add_supported_token(&cfg.stake_token);
        client.add_approved_vault(&cfg.yield_vault);
        client.add_approved_oracle(&cfg.oracle_contract);
        cfg
    }

    fn create_pool_error(
        env: &Env,
        client: &FactoryContractClient<'static>,
        host: &Address,
        cfg: &PoolConfig,
    ) -> FactoryError {
        client
            .try_create_pool(host, cfg, &metadata_hash(env))
            .err()
            .expect("create_pool must be rejected")
            .expect("error must be a contract error")
    }

    /// A `pool_config` whose `stake_token` is a real deployed token contract
    /// (7 decimals, matching `MIN_STAKE_REFERENCE_DECIMALS`) rather than a
    /// bare `Address::generate`. Needed by any test that exercises
    /// `create_pool` past the `is_supported_token` check, since #1361's
    /// `normalize_min_stake` calls the real `decimals()` entry point on
    /// `stake_token` and traps on an address with no contract behind it.
    fn pool_config_with_real_token(env: &Env, entry_fee: i128) -> PoolConfig {
        let mut cfg = pool_config(env, entry_fee);
        let token_admin = Address::generate(env);
        cfg.stake_token = env
            .register_stellar_asset_contract_v2(token_admin)
            .address();
        cfg
    }

    #[test]
    fn version_returns_the_current_contract_version() {
        let (_env, client, _admin, _host) = setup();
        assert_eq!(client.version(), CONTRACT_VERSION);
    }

    #[test]
    fn clamp_page_size_bounds_untrusted_limits() {
        assert_eq!(types::clamp_page_size(0), 0);
        assert_eq!(types::clamp_page_size(types::MAX_ARENAS_PAGE_SIZE - 1), types::MAX_ARENAS_PAGE_SIZE - 1);
        assert_eq!(types::clamp_page_size(types::MAX_ARENAS_PAGE_SIZE), types::MAX_ARENAS_PAGE_SIZE);
        assert_eq!(types::clamp_page_size(types::MAX_ARENAS_PAGE_SIZE + 1), types::MAX_ARENAS_PAGE_SIZE);
        assert_eq!(types::clamp_page_size(u32::MAX), types::MAX_ARENAS_PAGE_SIZE);
    }

    #[test]
    fn get_arenas_with_huge_limit_on_empty_factory_returns_empty() {
        let (_env, client, _admin, _host) = setup();
        assert_eq!(client.get_arenas(&u32::MAX, &u32::MAX).len(), 0);
        assert_eq!(client.get_arenas(&0, &u32::MAX).len(), 0);
    }

    #[test]
    fn whitelist_add_and_remove_controls_host_status() {
        let (_env, client, _admin, host) = setup();

        assert!(!client.is_whitelisted(&host));
        client.add_to_whitelist(&host);
        assert!(client.is_whitelisted(&host));
        client.remove_from_whitelist(&host);
        assert!(!client.is_whitelisted(&host));
    }

    #[test]
    fn create_pool_rejects_unwhitelisted_host() {
        let (env, client, _admin, host) = setup();
        let err = client
            .try_create_pool(&host, &pool_config(&env, 100), &metadata_hash(&env))
            .err()
            .expect("unwhitelisted host must error")
            .expect("error must be a contract error");

        assert_eq!(err, FactoryError::HostNotWhitelisted);
    }

    fn assert_invalid_config(update: impl FnOnce(&mut PoolConfig)) {
        let (env, client, _admin, host) = setup();
        let mut config = pool_config(&env, 100);
        update(&mut config);
        let error = client
            .try_create_pool(&host, &config, &metadata_hash(&env))
            .err()
            .expect("invalid config must be rejected")
            .expect("error must be a contract error");
        assert_eq!(error, FactoryError::InvalidConfig);
    }

    #[test]
    fn create_pool_rejects_round_duration_below_minimum() {
        assert_invalid_config(|config| config.round_duration = 59);
    }

    #[test]
    fn create_pool_rejects_round_duration_above_maximum() {
        assert_invalid_config(|config| {
            config.round_duration = 604_801
        });
    }

    fn assert_invalid_start_deadline(update: impl FnOnce(&mut PoolConfig)) {
        let (env, client, _admin, host) = setup();
        let mut config = pool_config(&env, 100);
        update(&mut config);
        let error = client
            .try_create_pool(&host, &config, &metadata_hash(&env))
            .err()
            .expect("invalid start deadline must be rejected")
            .expect("error must be a contract error");
        assert_eq!(error, FactoryError::InvalidStartDeadline);
    }

    #[test]
    fn create_pool_rejects_start_deadline_below_minimum() {
        assert_invalid_start_deadline(|config| {
            config.start_deadline = MIN_START_DELAY_SECONDS - 1
        });
    }

    #[test]
    fn create_pool_rejects_start_deadline_above_maximum() {
        assert_invalid_start_deadline(|config| {
            config.start_deadline = MAX_START_DELAY_SECONDS + 1
        });
    }

    #[test]
    fn create_pool_rejects_fewer_than_two_players() {
        assert_invalid_config(|config| config.min_players = 1);
    }

    #[test]
    fn create_pool_rejects_min_players_above_max_players() {
        assert_invalid_config(|config| {
            config.min_players = 11
        });
    }

    #[test]
    fn create_pool_rejects_more_than_one_hundred_players() {
        assert_invalid_config(|config| {
            config.max_players = MAX_PLAYERS_ALLOWED + 1
        });
    }

    #[test]
    fn create_pool_rejects_max_players_in_101_to_1000_range() {
        // Regression test: factory once accepted values 101..=1000 which arena
        // would reject, causing transaction reversion. Now both use the same
        // constant, and factory validates early before any deployment attempt.
        let (env, client, _admin, host) = setup();
        client.add_to_whitelist(&host);

        let test_values = [101u32, 200, 500, 999, 1000];
        for max_players in test_values.iter() {
            let mut config = pool_config(&env, 100);
            config.max_players = *max_players;
            let err = client
                .try_create_pool(&host, &config, &metadata_hash(&env))
                .err()
                .expect("max_players > 100 must be rejected")
                .expect("error must be a contract error");
            assert_eq!(
                err,
                FactoryError::InvalidConfig,
                "max_players > 100 must return InvalidConfig, not trap with uninitialized contract"
            );
        }
    }

    #[test]
    fn paused_factory_rejects_pool_creation() {
        let (env, client, _admin, host) = setup();
        client.add_to_whitelist(&host);

        // Pause the factory.
        client.pause();

        let err = client
            .try_create_pool(&host, &pool_config(&env, 100), &metadata_hash(&env))
            .err()
            .expect("paused factory must error")
            .expect("error must be a contract error");

        assert_eq!(
            err,
            FactoryError::ContractPaused,
            "paused factory must return ContractPaused, not any other error"
        );

        // Unpause and verify a different error is returned (pool creation
        // proceeds past the pause check — fails on missing WASM hash).
        client.unpause();
        let err_after = client
            .try_create_pool(&host, &pool_config(&env, 100), &metadata_hash(&env))
            .err()
            .expect("must still error (no wasm hash configured)")
            .expect("error must be a contract error");

        assert_ne!(
            err_after,
            FactoryError::ContractPaused,
            "unpaused factory must not return ContractPaused"
        );
    }

    #[test]
    fn create_pool_enforces_minimum_stake_before_deploying() {
        let (env, client, _admin, host) = setup();
        client.add_to_whitelist(&host);

        let cfg = pool_config_with_real_token(&env, 99);
        client.add_supported_token(&cfg.stake_token);

        let err = client
            .try_create_pool(&host, &cfg, &metadata_hash(&env))
            .err()
            .expect("stake below minimum must error")
            .expect("error must be a contract error");

        assert_eq!(err, FactoryError::StakeBelowMinimum);
    }

    #[test]
    fn create_pool_rejects_unsupported_stake_token() {
        let (env, client, _admin, host) = setup();
        client.add_to_whitelist(&host);

        // No token registered — must be rejected.
        let cfg = pool_config_with_real_token(&env, 100);
        let err = client
            .try_create_pool(&host, &cfg, &metadata_hash(&env))
            .err()
            .expect("unsupported token must error")
            .expect("error must be a contract error");
        assert_eq!(err, FactoryError::UnsupportedToken);

        // Register the token and confirm it is now accepted (fails further on
        // missing WASM hash, not on token validation).
        client.add_supported_token(&cfg.stake_token);
        let err_after = client
            .try_create_pool(&host, &cfg, &metadata_hash(&env))
            .err()
            .expect("must still error (no wasm hash configured)")
            .expect("error must be a contract error");
        assert_ne!(err_after, FactoryError::UnsupportedToken);
    }

    #[test]
    fn upgrade_rejects_non_admin() {
        let (env, client, _admin, _host) = setup();

        // Drop the mocked auths so the admin's signature is genuinely required;
        // a non-admin caller cannot supply it.
        env.set_auths(&[]);

        let new_wasm = BytesN::from_array(&env, &[0u8; 32]);
        let err = client.try_upgrade(&new_wasm);
        assert!(
            err.is_err(),
            "upgrade without the admin's authorization must be rejected"
        );
    }

    #[test]
    fn create_pool_collects_creator_stake_from_host() {
        let env = Env::default();
        env.mock_all_auths_allowing_non_root_auth();
        let factory_id = env.register(FactoryContract, ());

        let token_admin = Address::generate(&env);
        let token_id = env
            .register_stellar_asset_contract_v2(token_admin)
            .address();
        let host = Address::generate(&env);
        soroban_sdk::token::StellarAssetClient::new(&env, &token_id).mint(&host, &1_000);

        let token_client = token::TokenClient::new(&env, &token_id);
        assert_eq!(token_client.balance(&host), 1_000);

        // Exercise the exact stake-collection step create_pool runs before deploy.
        env.as_contract(&factory_id, || {
            FactoryContract::collect_creator_stake(&env, &host, &token_id, 250);
        });

        assert_eq!(
            token_client.balance(&host),
            750,
            "host balance must decrease by the staked amount"
        );
        assert_eq!(
            token_client.balance(&factory_id),
            250,
            "factory must actually hold the locked stake"
        );
    }

    #[test]
    fn reclaim_creator_stake_refunds_the_creator() {
        let env = Env::default();
        env.mock_all_auths();
        let factory_id = env.register(FactoryContract, ());
        let client = FactoryContractClient::new(&env, &factory_id);

        let token_admin = Address::generate(&env);
        let token_id = env
            .register_stellar_asset_contract_v2(token_admin)
            .address();
        let host = Address::generate(&env);
        let arena = Address::generate(&env);

        // Fund the factory as if it had collected the stake, and record it.
        soroban_sdk::token::StellarAssetClient::new(&env, &token_id).mint(&factory_id, &250);
        env.as_contract(&factory_id, || {
            FactoryStorage::save_creator_stake(
                &env,
                &arena,
                &CreatorStakeRecord {
                    creator: host.clone(),
                    amount: 250,
                    stake_token: token_id.clone(),
                },
            );
        });

        let token_client = token::TokenClient::new(&env, &token_id);
        assert_eq!(token_client.balance(&host), 0);

        client.reclaim_creator_stake(&arena);

        assert_eq!(
            token_client.balance(&host),
            250,
            "creator must be refunded the full stake"
        );
        assert_eq!(
            token_client.balance(&factory_id),
            0,
            "factory must release the held stake"
        );
        assert!(
            client.get_creator_stake(&arena).is_none(),
            "stake record must be cleared so it cannot be reclaimed twice"
        );
    }

    #[test]
    fn reclaim_creator_stake_unknown_arena_errors() {
        let (env, client, _admin, _host) = setup();
        let unknown = Address::generate(&env);

        let err = client
            .try_reclaim_creator_stake(&unknown)
            .err()
            .expect("reclaiming an unknown arena must error")
            .expect("error must be a contract error");
        assert_eq!(err, FactoryError::ArenaNotFound);
    }

    #[test]
    fn supported_token_add_and_remove_controls_token_status() {
        let (env, client, _admin, _host) = setup();
        let token = Address::generate(&env);

        assert!(!client.is_token_supported(&token));
        client.add_supported_token(&token);
        assert!(client.is_token_supported(&token));
        client.remove_supported_token(&token);
        assert!(!client.is_token_supported(&token));
    }

    #[test]
    fn approved_vault_and_oracle_add_and_remove_controls_status() {
        let (env, client, _admin, _host) = setup();
        let oracle = Address::generate(&env);
        let vault = mock_vault(&env, &Address::generate(&env), &oracle);

        assert!(!client.is_approved_vault(&vault));
        client.add_approved_vault(&vault);
        assert!(client.is_approved_vault(&vault));
        client.remove_approved_vault(&vault);
        assert!(!client.is_approved_vault(&vault));

        assert!(!client.is_approved_oracle(&oracle));
        client.add_approved_oracle(&oracle);
        assert!(client.is_approved_oracle(&oracle));
        client.remove_approved_oracle(&oracle);
        assert!(!client.is_approved_oracle(&oracle));
    }

    #[test]
    fn create_pool_rejects_unapproved_vault() {
        let (env, client, _admin, host) = setup();
        client.add_to_whitelist(&host);

        let cfg = pool_config_with_real_token(&env, 100);
        client.add_supported_token(&cfg.stake_token);
        client.add_approved_oracle(&cfg.oracle_contract);

        let err = client
            .try_create_pool(&host, &cfg, &metadata_hash(&env))
            .err()
            .expect("unapproved vault must error")
            .expect("error must be a contract error");
        assert_eq!(err, FactoryError::InvalidVault);
    }

    #[test]
    fn create_pool_rejects_unapproved_oracle() {
        let (env, client, _admin, host) = setup();
        client.add_to_whitelist(&host);

        let mut cfg = pool_config_with_real_token(&env, 100);
        cfg.yield_vault = mock_vault(&env, &cfg.stake_token, &cfg.oracle_contract);
        client.add_supported_token(&cfg.stake_token);
        client.add_approved_vault(&cfg.yield_vault);

        let err = client
            .try_create_pool(&host, &cfg, &metadata_hash(&env))
            .err()
            .expect("unapproved oracle must error")
            .expect("error must be a contract error");
        assert_eq!(err, FactoryError::InvalidOracle);
    }
    // ── Regression: pause must not strand a pool slot (#1360) ────────────────
    //
    // release_arena and reclaim_creator_stake are both called exactly once per
    // arena, from the same lifecycle transition, via try_* with no retry. When
    // release_arena was pause-gated, a factory paused at that moment lost the
    // decrement while the stake was still refunded and its record deleted —
    // costing the creator a max_active_pools slot permanently, for an arena that
    // had already completed.

    /// Register an arena against `creator` as though the factory had deployed it,
    /// and count it towards their active pools.
    fn register_arena_for(env: &Env, factory: &Address, creator: &Address) -> Address {
        let arena = Address::generate(env);

        // A real asset contract, funded so reclaim_creator_stake's transfer can
        // actually settle — otherwise the test would fail on the token, not on
        // the behaviour under test.
        let token_admin = Address::generate(env);
        let token = env.register_stellar_asset_contract_v2(token_admin).address();
        soroban_sdk::token::StellarAssetClient::new(env, &token).mint(factory, &100);

        env.as_contract(factory, || {
            FactoryStorage::save_creator_stake(
                env,
                &arena,
                &CreatorStakeRecord {
                    creator: creator.clone(),
                    amount: 100,
                    stake_token: token,
                },
            );
            FactoryStorage::increment_active_pool_count(env, creator);
        });
        arena
    }

    fn active_pool_count(env: &Env, factory: &Address, creator: &Address) -> u32 {
        env.as_contract(factory, || FactoryStorage::load_active_pool_count(env, creator))
    }

    #[test]
    fn release_arena_succeeds_while_the_factory_is_paused() {
        let (env, client, _admin, creator) = setup();
        let arena = register_arena_for(&env, &client.address, &creator);
        assert_eq!(active_pool_count(&env, &client.address, &creator), 1);

        client.pause();

        assert!(
            client.try_release_arena(&arena).is_ok(),
            "releasing a completed arena is bookkeeping, not new activity — pause must not block it",
        );
        assert_eq!(
            active_pool_count(&env, &client.address, &creator),
            0,
            "the creator's slot must be freed even though the factory was paused",
        );
    }

    #[test]
    fn a_paused_completion_window_does_not_cost_the_creator_a_slot() {
        let (env, client, _admin, creator) = setup();
        let arena = register_arena_for(&env, &client.address, &creator);

        // The arena finishes while the factory happens to be paused: both calls
        // fire together, exactly as resolve_round and expire_arena issue them.
        client.pause();
        let released = client.try_release_arena(&arena);
        let reclaimed = client.try_reclaim_creator_stake(&arena);

        assert!(released.is_ok(), "release must not be refused during pause");
        assert!(reclaimed.is_ok(), "reclaim was never pause-gated");
        assert_eq!(
            active_pool_count(&env, &client.address, &creator),
            0,
            "slot must be released; previously it leaked and could never be recovered",
        );
    }

    #[test]
    fn pause_still_blocks_new_pool_creation() {
        let (env, client, _admin, host) = setup();
        client.add_to_whitelist(&host);
        client.pause();

        // Removing the gate from release_arena must not weaken the pause switch
        // where it actually matters.
        let err = client
            .try_create_pool(&host, &pool_config(&env, 100), &metadata_hash(&env))
            .err()
            .expect("paused factory must still refuse new pools")
            .expect("error must be a contract error");

        assert_eq!(err, FactoryError::ContractPaused);
    }

    #[test]
    fn release_arena_still_rejects_an_unknown_arena() {
        let (env, client, _admin, _creator) = setup();

        let err = client
            .try_release_arena(&Address::generate(&env))
            .err()
            .expect("an arena the factory never deployed must error")
            .expect("error must be a contract error");

        assert_eq!(err, FactoryError::ArenaNotFound);
    }

    // ── #1572: get_active_pool_count view ────────────────────────────────────

    #[test]
    fn get_active_pool_count_is_zero_for_a_host_with_no_pools() {
        let (env, client, _admin, host) = setup();
        assert_eq!(client.get_active_pool_count(&host), 0);
    }

    #[test]
    fn get_active_pool_count_tracks_registered_and_released_pools() {
        let (env, client, _admin, creator) = setup();
        let arena = register_arena_for(&env, &client.address, &creator);
        assert_eq!(client.get_active_pool_count(&creator), 1);

        client.release_arena(&arena);
        assert_eq!(
            client.get_active_pool_count(&creator),
            0,
            "released arena must free the host's slot in the view too"
        );
    }

    #[test]
    fn get_active_pool_count_is_scoped_per_host() {
        let (env, client, _admin, creator) = setup();
        let other = Address::generate(&env);
        register_arena_for(&env, &client.address, &creator);

        assert_eq!(client.get_active_pool_count(&creator), 1);
        assert_eq!(
            client.get_active_pool_count(&other),
            0,
            "one host's pools must not show up under another"
        );
    }

    // ── #1361: min_stake decimal-precision normalization ─────────────────────
    //
    // `register_stellar_asset_contract_v2` always deploys a 7-decimal token
    // (matching MIN_STAKE_REFERENCE_DECIMALS), so exercising the actual
    // scaling math needs a token whose `decimals()` differs from 7. This mock
    // implements only that one SEP-41 entry point — the sole thing
    // `normalize_min_stake` calls on the token before deployment/transfer
    // logic is ever reached.
    mod decimals_mock {
        mod high {
            use soroban_sdk::{Env, contract, contractimpl};

            #[contract]
            pub struct MockDecimalsToken;

            #[contractimpl]
            impl MockDecimalsToken {
                pub fn decimals(_env: Env) -> u32 {
                    18
                }
            }
        }

        mod low {
            use soroban_sdk::{Env, contract, contractimpl};

            #[contract]
            pub struct MockLowDecimalsToken;

            #[contractimpl]
            impl MockLowDecimalsToken {
                pub fn decimals(_env: Env) -> u32 {
                    2
                }
            }
        }

        pub use high::MockDecimalsToken;
        pub use low::MockLowDecimalsToken;
    }

    #[test]
    fn normalize_min_stake_unchanged_when_token_matches_reference_decimals() {
        let (env, client, _admin, host) = setup();
        client.add_to_whitelist(&host);
        let cfg = pool_config_with_real_token(&env, 100);
        client.add_supported_token(&cfg.stake_token);

        let effective = env.as_contract(&client.address, || {
            FactoryContract::normalize_min_stake(&env, &cfg.stake_token, 100)
        });
        assert_eq!(effective, Ok(100));
    }

    #[test]
    fn normalize_min_stake_scales_up_for_higher_decimal_tokens() {
        let env = Env::default();
        let factory_id = env.register(FactoryContract, ());
        let token_id = env.register(decimals_mock::MockDecimalsToken, ());

        // 18-decimal token vs. the 7-decimal reference: scale by 10^11.
        let effective = env.as_contract(&factory_id, || {
            FactoryContract::normalize_min_stake(&env, &token_id, 100)
        });
        assert_eq!(effective, Ok(100 * 10i128.pow(11)));
    }

    #[test]
    fn normalize_min_stake_rounds_up_for_lower_decimal_tokens() {
        let env = Env::default();
        let factory_id = env.register(FactoryContract, ());
        let token_id = env.register(decimals_mock::MockLowDecimalsToken, ());

        // 2-decimal token vs. the 7-decimal reference: divide by 10^5,
        // rounding up so the effective floor never weakens.
        let exact = env.as_contract(&factory_id, || {
            FactoryContract::normalize_min_stake(&env, &token_id, 500_000)
        });
        assert_eq!(exact, Ok(5), "500_000 / 10^5 divides evenly");

        let remainder = env.as_contract(&factory_id, || {
            FactoryContract::normalize_min_stake(&env, &token_id, 500_001)
        });
        assert_eq!(
            remainder,
            Ok(6),
            "a nonzero remainder must round the floor up, never down"
        );
    }

    #[test]
    fn create_pool_applies_effective_minimum_across_differing_token_decimals() {
        let (env, client, _admin, host) = setup();
        client.add_to_whitelist(&host);

        // min_stake is 100 (7-decimal reference units). Against an 18-decimal
        // token that is 100 * 10^11 raw units — an entry_fee of just 100 raw
        // units on that token must still be rejected as below the real-world
        // minimum, not silently accepted because it clears the unscaled
        // integer floor.
        let token_id = env.register(decimals_mock::MockDecimalsToken, ());
        let mut cfg = pool_config(&env, 100);
        cfg.stake_token = token_id.clone();
        client.add_supported_token(&token_id);

        let err = client
            .try_create_pool(&host, &cfg, &metadata_hash(&env))
            .err()
            .expect("entry_fee far below the decimal-scaled minimum must error")
            .expect("error must be a contract error");
        assert_eq!(err, FactoryError::StakeBelowMinimum);
    }

    // ── #1583: protocol-wide emergency pause ─────────────────────────────────

    #[test]
    fn set_global_pause_toggles_the_flag_and_emits_an_event() {
        use soroban_sdk::{IntoVal, testutils::Events as _};

        let (env, client, _admin, _host) = setup();
        assert!(!client.is_globally_paused());

        let reason = Symbol::new(&env, "vault_exploit");
        client.set_global_pause(&true, &reason);
        let (contract, topics, data) = env.events().all().last().unwrap();
        assert_eq!(contract, client.address);
        assert_eq!(topics, (symbol_short!("GPAUSE"),).into_val(&env));
        let data: (bool, Symbol) = data.into_val(&env);
        assert_eq!(data, (true, reason.clone()));
        assert!(client.is_globally_paused());

        client.set_global_pause(&false, &reason);
        assert!(!client.is_globally_paused());
    }

    #[test]
    fn set_global_pause_requires_the_protocol_admin() {
        let (env, client, _admin, _host) = setup();
        env.set_auths(&[]);
        assert!(
            client
                .try_set_global_pause(&true, &Symbol::new(&env, "x"))
                .is_err()
        );
        assert!(!client.is_globally_paused());
    }

    #[test]
    fn global_pause_is_independent_of_the_pool_creation_pause() {
        let (env, client, _admin, _host) = setup();
        client.pause();
        assert!(!client.is_globally_paused());
        client.unpause();
        client.set_global_pause(&true, &Symbol::new(&env, "incident"));
        assert!(client.is_globally_paused());
    }

    #[test]
    fn normalize_min_stake_reports_overflow_instead_of_wrapping() {
        let env = Env::default();
        let factory_id = env.register(FactoryContract, ());
        let token_id = env.register(decimals_mock::MockDecimalsToken, ());

        // i128::MAX scaled by 10^11 overflows i128.
        let result = env.as_contract(&factory_id, || {
            FactoryContract::normalize_min_stake(&env, &token_id, i128::MAX)
        });
        assert_eq!(result, Err(FactoryError::ArithmeticOverflow));
    }

    // ── #1634: vault / token / oracle compatibility ──────────────────────────

    #[test]
    fn add_approved_vault_registers_the_vaults_token() {
        let (env, client, _admin, _host) = setup();
        let token = Address::generate(&env);
        let vault = mock_vault(&env, &token, &Address::generate(&env));

        assert_eq!(client.get_approved_vault_token(&vault), None);
        client.add_approved_vault(&vault);
        assert_eq!(client.get_approved_vault_token(&vault), Some(token));

        client.remove_approved_vault(&vault);
        assert_eq!(client.get_approved_vault_token(&vault), None);
        assert!(!client.is_approved_vault(&vault));
    }

    #[test]
    fn add_approved_vault_rejects_an_address_without_a_vault_config() {
        let (env, client, _admin, _host) = setup();
        let not_a_vault = Address::generate(&env);

        let err = client
            .try_add_approved_vault(&not_a_vault)
            .err()
            .expect("approving a non-vault must error")
            .expect("error must be a contract error");
        assert_eq!(err, FactoryError::InvalidVault);
        assert!(!client.is_approved_vault(&not_a_vault));
    }

    #[test]
    fn create_pool_accepts_a_compatible_vault() {
        let (env, client, _admin, host) = setup();
        let cfg = compatible_pool(&env, &client, &host);

        // Every compatibility check passes; the call only fails later because
        // no arena wasm hash is configured in this unit test.
        assert_eq!(
            create_pool_error(&env, &client, &host, &cfg),
            FactoryError::WasmHashNotSet
        );
    }

    #[test]
    fn create_pool_rejects_a_vault_for_a_different_token() {
        let (env, client, _admin, host) = setup();
        let mut cfg = compatible_pool(&env, &client, &host);

        // An approved vault for token B, with the pool staking supported token A.
        let other_token = pool_config_with_real_token(&env, 100).stake_token;
        let vault_b = mock_vault(&env, &other_token, &cfg.oracle_contract);
        client.add_approved_vault(&vault_b);
        cfg.yield_vault = vault_b;

        assert_eq!(
            create_pool_error(&env, &client, &host, &cfg),
            FactoryError::VaultTokenMismatch
        );
    }

    #[test]
    fn create_pool_rejects_a_vault_using_a_different_oracle() {
        let (env, client, _admin, host) = setup();
        let mut cfg = compatible_pool(&env, &client, &host);

        // Both oracles are approved; the arena would still snapshot yield from
        // one while the vault accrues from the other.
        let other_oracle = Address::generate(&env);
        client.add_approved_oracle(&other_oracle);
        cfg.oracle_contract = other_oracle;

        assert_eq!(
            create_pool_error(&env, &client, &host, &cfg),
            FactoryError::OracleMismatch
        );
    }

    #[test]
    fn create_pool_rejects_a_vault_whose_token_changed_after_approval() {
        let (env, client, _admin, host) = setup();
        let mut cfg = compatible_pool(&env, &client, &host);
        let original_token = cfg.stake_token.clone();

        // The vault is "upgraded" to a different asset, and the host asks for
        // a pool in that new (also supported) asset.
        let new_token = pool_config_with_real_token(&env, 100).stake_token;
        client.add_supported_token(&new_token);
        vault_mock::MockVaultClient::new(&env, &cfg.yield_vault)
            .set_config(&new_token, &cfg.oracle_contract);
        cfg.stake_token = new_token.clone();
        assert_eq!(
            create_pool_error(&env, &client, &host, &cfg),
            FactoryError::VaultTokenMismatch,
            "a vault must not back pools in an asset it was not approved for"
        );

        // The original asset no longer matches what the vault actually holds.
        cfg.stake_token = original_token;
        assert_eq!(
            create_pool_error(&env, &client, &host, &cfg),
            FactoryError::VaultTokenMismatch
        );

        // Re-approving records the new token and makes the new pairing valid.
        client.add_approved_vault(&cfg.yield_vault);
        assert_eq!(client.get_approved_vault_token(&cfg.yield_vault), Some(new_token.clone()));
        cfg.stake_token = new_token;
        assert_eq!(
            create_pool_error(&env, &client, &host, &cfg),
            FactoryError::WasmHashNotSet
        );
    }

    #[test]
    fn create_pool_rejects_a_vault_approved_before_token_registration() {
        let (env, client, _admin, host) = setup();
        let cfg = compatible_pool(&env, &client, &host);

        // Simulate an approval written by the pre-#1634 factory: the flag is
        // set but no token was registered alongside it.
        env.as_contract(&client.address, || {
            FactoryStorage::remove_approved_vault_token(&env, &cfg.yield_vault);
        });

        assert_eq!(
            create_pool_error(&env, &client, &host, &cfg),
            FactoryError::InvalidVault
        );
    }

    #[test]
    fn create_pool_rejects_a_vault_that_stops_answering_config() {
        let (env, client, _admin, host) = setup();
        let mut cfg = compatible_pool(&env, &client, &host);

        // An approved vault whose config read now fails (e.g. upgraded to
        // code without the entry point) must not be trusted.
        let broken = Address::generate(&env);
        env.as_contract(&client.address, || {
            FactoryStorage::set_approved_vault(&env, &broken, true);
            FactoryStorage::save_approved_vault_token(&env, &broken, &cfg.stake_token);
        });
        cfg.yield_vault = broken;

        assert_eq!(
            create_pool_error(&env, &client, &host, &cfg),
            FactoryError::InvalidVault
        );
    }
}
