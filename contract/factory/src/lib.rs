#![no_std]
use soroban_sdk::{Address, BytesN, Env, contract, contractimpl, symbol_short, token};

mod storage;
mod types;

use storage::FactoryStorage;
use types::FactoryError;

/// Factory contract — deploys arena instances and enforces protocol-level rules.
///
/// Implementation is open for contribution. See the issue tracker for:
/// - Pool creation with host whitelist enforcement
/// - Arena WASM hash management
/// - Minimum stake validation
/// - Admin and upgrade timelock flow
///
/// Architecture overview: see `ARCHITECTURE.md` in the workspace root.
#[contract]
pub struct FactoryContract;

#[contractimpl]
impl FactoryContract {
    pub fn initialize(
        env: Env,
        admin: Address,
        stake_token: Address,
        min_creator_stake: i128,
    ) -> Result<(), FactoryError> {
        if FactoryStorage::has_admin(&env) {
            return Err(FactoryError::AlreadyInitialized);
        }
        if min_creator_stake < 0 {
            return Err(FactoryError::InvalidStakeAmount);
        }

        admin.require_auth();
        FactoryStorage::save_admin(&env, &admin);
        FactoryStorage::save_stake_token(&env, &stake_token);
        FactoryStorage::save_min_creator_stake(&env, min_creator_stake);
        Ok(())
    }

    pub fn admin(env: Env) -> Result<Address, FactoryError> {
        FactoryStorage::load_admin(&env).ok_or(FactoryError::NotInitialized)
    }

    pub fn set_min_creator_stake(
        env: Env,
        admin: Address,
        min_creator_stake: i128,
    ) -> Result<(), FactoryError> {
        Self::require_admin(&env, &admin)?;
        if min_creator_stake < 0 {
            return Err(FactoryError::InvalidStakeAmount);
        }

        let previous = FactoryStorage::load_min_creator_stake(&env);
        FactoryStorage::save_min_creator_stake(&env, min_creator_stake);
        env.events().publish(
            (symbol_short!("MIN_UP"),),
            (previous, min_creator_stake),
        );
        Ok(())
    }

    pub fn get_min_creator_stake(env: Env) -> i128 {
        FactoryStorage::load_min_creator_stake(&env)
    }

    pub fn deploy_arena(
        env: Env,
        creator: Address,
        creator_stake: i128,
        _entry_fee: i128,
    ) -> Result<Address, FactoryError> {
        if !FactoryStorage::has_admin(&env) {
            return Err(FactoryError::NotInitialized);
        }

        creator.require_auth();

        let min_stake = FactoryStorage::load_min_creator_stake(&env);
        if creator_stake < min_stake {
            return Err(FactoryError::InsufficientCreatorStake);
        }
        if creator_stake <= 0 {
            return Err(FactoryError::InvalidStakeAmount);
        }

        let stake_token = FactoryStorage::load_stake_token(&env)
            .ok_or(FactoryError::NotInitialized)?;
        let token_client = token::Client::new(&env, &stake_token);
        token_client.transfer(
            &creator,
            &env.current_contract_address(),
            &creator_stake,
        );

        let arena_id = Self::derive_arena_address(&env);
        FactoryStorage::save_creator_stake(&env, &arena_id, &creator, creator_stake);
        env.events().publish(
            (symbol_short!("DEPLOYED"), arena_id.clone()),
            (creator.clone(), creator_stake),
        );

        Ok(arena_id)
    }

    pub fn finish_arena(
        env: Env,
        admin: Address,
        arena_id: Address,
    ) -> Result<(), FactoryError> {
        Self::require_admin(&env, &admin)?;

        let stake = FactoryStorage::load_creator_stake(&env, &arena_id)
            .ok_or(FactoryError::ArenaNotFound)?;
        let stake_token = FactoryStorage::load_stake_token(&env)
            .ok_or(FactoryError::NotInitialized)?;

        let token_client = token::Client::new(&env, &stake_token);
        token_client.transfer(
            &env.current_contract_address(),
            &stake.creator,
            &stake.amount,
        );
        FactoryStorage::remove_creator_stake(&env, &arena_id);
        env.events().publish(
            (symbol_short!("FINISHED"), arena_id),
            (stake.creator, stake.amount),
        );
        Ok(())
    }

    pub fn get_creator_stake(
        env: Env,
        arena_id: Address,
    ) -> Result<i128, FactoryError> {
        let stake = FactoryStorage::load_creator_stake(&env, &arena_id)
            .ok_or(FactoryError::ArenaNotFound)?;
        Ok(stake.amount)
    }

    fn require_admin(env: &Env, admin: &Address) -> Result<(), FactoryError> {
        let stored_admin = FactoryStorage::load_admin(env).ok_or(FactoryError::NotInitialized)?;
        admin.require_auth();
        if *admin != stored_admin {
            return Err(FactoryError::Unauthorized);
        }
        Ok(())
    }

    fn derive_arena_address(env: &Env) -> Address {
        let nonce = FactoryStorage::next_arena_nonce(env);
        let mut salt = BytesN::<32>::from_array(env, &[0; 32]);
        let nonce_bytes = nonce.to_be_bytes();
        let start = 32 - nonce_bytes.len();
        for (index, byte) in nonce_bytes.iter().enumerate() {
            salt.set(start as u32 + index as u32, *byte);
        }
        env.deployer().with_current_contract(salt).deployed_address()
    }
}

#[cfg(test)]
mod test {
    use super::*;
    use soroban_sdk::testutils::Address as _;

    fn setup() -> (
        Env,
        Address,
        FactoryContractClient<'static>,
        Address,
        Address,
        Address,
        token::Client<'static>,
        token::StellarAssetClient<'static>,
    ) {
        let env = Env::default();
        env.mock_all_auths();

        let contract_id = env.register(FactoryContract, ());
        let client = FactoryContractClient::new(&env, &contract_id);

        let admin = Address::generate(&env);
        let creator = Address::generate(&env);
        let token_admin = Address::generate(&env);
        let token_id = env.register_stellar_asset_contract(token_admin.clone());
        let token_client = token::Client::new(&env, &token_id);
        let asset_admin = token::StellarAssetClient::new(&env, &token_id);

        client.initialize(&admin, &token_id, &100);

        (
            env,
            contract_id,
            client,
            admin,
            creator,
            token_id,
            token_client,
            asset_admin,
        )
    }

    #[test]
    fn deploy_arena_requires_sufficient_stake() {
        let (_env, _contract_id, client, _admin, creator, _token_id, _token_client, asset_admin) =
            setup();
        asset_admin.mint(&creator, &1_000);

        let err = client.try_deploy_arena(&creator, &99, &25).unwrap_err();
        assert_eq!(err, Ok(FactoryError::InsufficientCreatorStake));
    }

    #[test]
    fn deploy_arena_holds_creator_stake() {
        let (_env, contract_id, client, _admin, creator, _token_id, token_client, asset_admin) =
            setup();
        asset_admin.mint(&creator, &1_000);

        let arena_id = client.deploy_arena(&creator, &250, &25);

        assert_eq!(token_client.balance(&creator), 750);
        assert_eq!(token_client.balance(&contract_id), 250);
        assert_eq!(client.get_creator_stake(&arena_id), 250);
    }

    #[test]
    fn finish_arena_refunds_creator_stake() {
        let (_env, contract_id, client, admin, creator, _token_id, token_client, asset_admin) =
            setup();
        asset_admin.mint(&creator, &1_000);

        let arena_id = client.deploy_arena(&creator, &250, &25);
        client.finish_arena(&admin, &arena_id);

        assert_eq!(token_client.balance(&creator), 1_000);
        assert_eq!(token_client.balance(&contract_id), 0);
        let err = client.try_get_creator_stake(&arena_id).unwrap_err();
        assert_eq!(err, Ok(FactoryError::ArenaNotFound));
    }

    #[test]
    fn admin_can_update_min_creator_stake() {
        let (_env, _contract_id, client, admin, _creator, _token_id, _token_client, _asset_admin) =
            setup();
        client.set_min_creator_stake(&admin, &500);
        assert_eq!(client.get_min_creator_stake(), 500);
    }
}
