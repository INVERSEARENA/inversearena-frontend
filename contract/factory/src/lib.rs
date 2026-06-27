#![no_std]

mod snapshot_tests;
mod storage;
mod types;

#[cfg(test)]
mod integration_tests;

use storage::{CreatorStakeRecord, FactoryStorage};
use types::{ArenaMetadata, ArenaStatus, FactoryError, PoolConfig};

use soroban_sdk::{
    Address, BytesN, Env, IntoVal, Symbol, Vec, contract, contractimpl, symbol_short, vec,
};

const MAX_PAGE_SIZE: u32 = 50;

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

    /// Upgrade the factory contract's code to `new_wasm_hash`.
    ///
    /// Admin-gated. Upgrading in place preserves all existing state — admin,
    /// whitelist, pool sequence, and creator stakes — so bug fixes and new
    /// features can ship without redeploying and losing that state.
    pub fn upgrade(env: Env, new_wasm_hash: BytesN<32>) -> Result<(), FactoryError> {
        Self::require_admin(&env)?;
        env.deployer()
            .update_current_contract_wasm(new_wasm_hash);
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

    pub fn add_approved_vault(env: Env, vault: Address) -> Result<(), FactoryError> {
        Self::require_admin(&env)?;
        FactoryStorage::set_approved_vault(&env, &vault, true);
        env.events().publish((symbol_short!("VLT_ADD"),), vault);
        Ok(())
    }

    pub fn remove_approved_vault(env: Env, vault: Address) -> Result<(), FactoryError> {
        Self::require_admin(&env)?;
        FactoryStorage::set_approved_vault(&env, &vault, false);
        env.events().publish((symbol_short!("VLT_REM"),), vault);
        Ok(())
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

    /// Release an arena from a creator's active pool count.
    ///
    /// Called by the arena contract itself (verified via creator stake record)
    /// when the arena finishes or is cancelled. Decrements the creator's active
    /// pool count, allowing the creator to deploy new arenas.
    pub fn release_arena(env: Env) -> Result<(), FactoryError> {
        if FactoryStorage::is_paused(&env) {
            return Err(FactoryError::ContractPaused);
        }
        let arena = env.current_contract_address();

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
    ) -> Result<Address, FactoryError> {
        if FactoryStorage::is_paused(&env) {
            return Err(FactoryError::ContractPaused);
        }
        host.require_auth();
        FactoryStorage::load_admin(&env)?;

        if !FactoryStorage::is_whitelisted(&env, &host) {
            return Err(FactoryError::HostNotWhitelisted);
        }
        if config.entry_fee <= 0 {
            return Err(FactoryError::InvalidStakeAmount);
        }
        let min_stake = FactoryStorage::load_min_stake(&env)?;
        if config.entry_fee < min_stake {
            return Err(FactoryError::StakeBelowMinimum);
        }
        if !FactoryStorage::is_supported_token(&env, &config.stake_token) {
            return Err(FactoryError::UnsupportedToken);
        }

        // Check active pool limit for this host
        let max_pools = FactoryStorage::load_max_active_pools(&env);
        let active = FactoryStorage::load_active_pool_count(&env, &host);
        if active >= max_pools {
            return Err(FactoryError::MaxActivePoolsReached);
        }

        let wasm_hash = FactoryStorage::load_arena_wasm_hash(&env)?;
        let pool_id = FactoryStorage::next_pool_id(&env)?;
        let arena = env
            .deployer()
            .with_current_contract(Self::salt_for_pool(&env, pool_id))
            .deploy_v2(wasm_hash, ());

        let _: () = env.invoke_contract(
            &arena,
            &Symbol::new(&env, "initialize"),
            vec![
                &env,
                host.clone().into_val(&env),
                config.stake_token.into_val(&env),
                config.yield_vault.into_val(&env),
                config.entry_fee.into_val(&env),
                config.oracle_contract.into_val(&env),
            ],
        );

        FactoryStorage::save_creator_stake(
            &env,
            &arena,
            &CreatorStakeRecord {
                creator: host.clone(),
                amount: config.entry_fee,
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
        };
        FactoryStorage::save_pool(&env, pool_id, &pool_metadata);
        FactoryStorage::increment_pool_count(&env);

        env.events().publish(
            (symbol_short!("POOL_CRE"),),
            (pool_id, host, config.entry_fee, arena.clone()),
        );
        Ok(arena)
    }

    pub fn get_creator_stake(env: Env, arena: Address) -> Option<CreatorStakeRecord> {
        FactoryStorage::load_creator_stake(&env, &arena)
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
        let caller = env.current_contract_address();
        let meta = FactoryStorage::load_pool(&env, pool_id).ok_or(FactoryError::PoolNotFound)?;
        if meta.arena_address != caller {
            return Err(FactoryError::Unauthorized);
        }
        FactoryStorage::update_pool_status(&env, pool_id, &status);
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
        let limit = core::cmp::min(limit, MAX_PAGE_SIZE);
        let mut result: Vec<ArenaMetadata> = Vec::new(&env);
        let start = offset + 1;
        let end = core::cmp::min(total, offset + limit);
        if start <= end {
            for pool_id in start..=end {
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
        }
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
            .try_create_pool(&host, &pool_config(&env, 100))
            .err()
            .expect("unwhitelisted host must error")
            .expect("error must be a contract error");

        assert_eq!(err, FactoryError::HostNotWhitelisted);
    }

    #[test]
    fn paused_factory_rejects_pool_creation() {
        let (env, client, _admin, host) = setup();
        client.add_to_whitelist(&host);

        // Pause the factory.
        client.pause();

        let err = client
            .try_create_pool(&host, &pool_config(&env, 100))
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
            .try_create_pool(&host, &pool_config(&env, 100))
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

        let err = client
            .try_create_pool(&host, &pool_config(&env, 99))
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
        let cfg = pool_config(&env, 100);
        let err = client
            .try_create_pool(&host, &cfg)
            .err()
            .expect("unsupported token must error")
            .expect("error must be a contract error");
        assert_eq!(err, FactoryError::UnsupportedToken);

        // Register the token and confirm it is now accepted (fails further on
        // missing WASM hash, not on token validation).
        client.add_supported_token(&cfg.stake_token);
        let err_after = client
            .try_create_pool(&host, &cfg)
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
    fn supported_token_add_and_remove_controls_token_status() {
        let (env, client, _admin, _host) = setup();
        let token = Address::generate(&env);

        assert!(!client.is_token_supported(&token));
        client.add_supported_token(&token);
        assert!(client.is_token_supported(&token));
        client.remove_supported_token(&token);
        assert!(!client.is_token_supported(&token));
    }
}
