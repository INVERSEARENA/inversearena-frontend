#![no_std]

mod snapshot_tests;
mod storage;
mod types;

use storage::{CreatorStakeRecord, FactoryStorage};
use types::{FactoryError, PoolConfig};

use soroban_sdk::{
    Address, BytesN, Env, IntoVal, Symbol, contract, contractimpl, symbol_short, vec,
};

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

    pub fn get_min_stake(env: Env) -> Result<i128, FactoryError> {
        FactoryStorage::load_min_stake(&env)
    }

    pub fn create_pool(
        env: Env,
        host: Address,
        config: PoolConfig,
    ) -> Result<Address, FactoryError> {
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

        let wasm_hash = FactoryStorage::load_arena_wasm_hash(&env)?;
        let pool_id = FactoryStorage::next_pool_id(&env);
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
        env.events().publish(
            (symbol_short!("POOL_CRE"),),
            (pool_id, host, config.entry_fee, arena.clone()),
        );
        Ok(arena)
    }

    pub fn get_creator_stake(env: Env, arena: Address) -> Option<CreatorStakeRecord> {
        FactoryStorage::load_creator_stake(&env, &arena)
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
}
