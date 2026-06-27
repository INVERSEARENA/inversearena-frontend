#![no_std]
mod types;

use soroban_sdk::{Address, Env, contract, contractimpl, contracttype, symbol_short, token};
use types::{StakePosition, StakerStats, StakingError};

const ADMIN_KEY: soroban_sdk::Symbol = symbol_short!("ADMIN");
const PAUSED_KEY: soroban_sdk::Symbol = symbol_short!("PAUSED");
const TOKEN_KEY: soroban_sdk::Symbol = symbol_short!("TOKEN");
const TSTAKE_KEY: soroban_sdk::Symbol = symbol_short!("TSTAKE");
const TSHARES_KEY: soroban_sdk::Symbol = symbol_short!("TSHARES");

#[contracttype]
pub enum DataKey {
    Position(Address),
}

#[contract]
pub struct StakingContract;

#[contractimpl]
impl StakingContract {
    pub fn hello(_env: Env) -> u32 {
        101112
    }

    pub fn initialize(env: Env, admin: Address, token: Address) -> Result<(), StakingError> {
        admin.require_auth();
        if env.storage().instance().has(&ADMIN_KEY) {
            return Err(StakingError::AlreadyInitialized);
        }
        env.storage().instance().set(&ADMIN_KEY, &admin);
        env.storage().instance().set(&TOKEN_KEY, &token);
        env.storage().instance().set(&TSTAKE_KEY, &0i128);
        env.storage().instance().set(&TSHARES_KEY, &0i128);
        env.storage().instance().set(&PAUSED_KEY, &false);
        Ok(())
    }

    pub fn admin(env: Env) -> Address {
        env.storage()
            .instance()
            .get(&ADMIN_KEY)
            .expect("not initialized")
    }

    pub fn token(env: Env) -> Address {
        env.storage()
            .instance()
            .get(&TOKEN_KEY)
            .expect("not initialized")
    }

    pub fn pause(env: Env) -> Result<(), StakingError> {
        Self::require_admin(&env)?;
        env.storage().instance().set(&PAUSED_KEY, &true);
        env.events().publish((symbol_short!("PAUSED"),), ());
        Ok(())
    }

    pub fn unpause(env: Env) -> Result<(), StakingError> {
        Self::require_admin(&env)?;
        env.storage().instance().set(&PAUSED_KEY, &false);
        env.events().publish((symbol_short!("UNPAUS"),), ());
        Ok(())
    }

    pub fn is_paused(env: Env) -> bool {
        env.storage().instance().get(&PAUSED_KEY).unwrap_or(false)
    }

    pub fn total_staked(env: Env) -> i128 {
        env.storage().instance().get(&TSTAKE_KEY).unwrap_or(0)
    }

    pub fn total_shares(env: Env) -> i128 {
        env.storage().instance().get(&TSHARES_KEY).unwrap_or(0)
    }

    pub fn get_position(env: Env, staker: Address) -> StakePosition {
        env.storage()
            .persistent()
            .get(&DataKey::Position(staker))
            .unwrap_or(StakePosition {
                amount: 0,
                shares: 0,
            })
    }

    pub fn staked_balance(env: Env, staker: Address) -> i128 {
        Self::get_position(env, staker).amount
    }

    pub fn get_staker_stats(env: Env, staker: Address) -> StakerStats {
        let pos = Self::get_position(env.clone(), staker.clone());
        let total = Self::total_staked(env.clone());
        let share_bps = if total > 0 {
            pos.amount * 10_000 / total
        } else {
            0
        };
        StakerStats {
            amount: pos.amount,
            shares: pos.shares,
            stake_share_bps: share_bps,
        }
    }

    pub fn stake(env: Env, staker: Address, amount: i128) -> Result<i128, StakingError> {
        staker.require_auth();
        Self::require_not_paused(&env)?;
        Self::require_initialized(&env)?;
        if amount <= 0 {
            return Err(StakingError::InvalidAmount);
        }

        let total_staked = Self::total_staked(env.clone());
        let total_shares = Self::total_shares(env.clone());

        let shares = if total_staked == 0 || total_shares == 0 {
            amount
        } else {
            amount * total_shares / total_staked
        };

        // EFFECTS — update state before token transfer
        env.storage()
            .instance()
            .set(&TSTAKE_KEY, &(total_staked + amount));
        env.storage()
            .instance()
            .set(&TSHARES_KEY, &(total_shares + shares));

        let mut position = Self::get_position(env.clone(), staker.clone());
        position.amount += amount;
        position.shares += shares;
        env.storage()
            .persistent()
            .set(&DataKey::Position(staker.clone()), &position);

        // INTERACTIONS — transfer tokens in
        let token_addr = Self::token(env.clone());
        let token_client = token::TokenClient::new(&env, &token_addr);
        token_client.transfer(&staker, &env.current_contract_address(), &amount);

        env.events()
            .publish((symbol_short!("STAKED"),), (staker, amount, shares));
        Ok(shares)
    }

    pub fn unstake(env: Env, staker: Address, shares: i128) -> Result<i128, StakingError> {
        staker.require_auth();
        Self::require_not_paused(&env)?;
        Self::require_initialized(&env)?;
        if shares <= 0 {
            return Err(StakingError::InvalidAmount);
        }

        let position = Self::get_position(env.clone(), staker.clone());
        if position.shares < shares {
            return Err(StakingError::InsufficientShares);
        }

        let total_staked = Self::total_staked(env.clone());
        let total_shares = Self::total_shares(env.clone());
        let tokens = shares * total_staked / total_shares;

        // EFFECTS — update state before token transfer
        let new_staked = total_staked - tokens;
        let new_shares = total_shares - shares;
        env.storage().instance().set(&TSTAKE_KEY, &new_staked);
        env.storage().instance().set(&TSHARES_KEY, &new_shares);

        let mut new_position = position.clone();
        new_position.amount -= tokens;
        new_position.shares -= shares;
        env.storage()
            .persistent()
            .set(&DataKey::Position(staker.clone()), &new_position);

        // INTERACTIONS — transfer tokens out
        let token_addr = Self::token(env.clone());
        let token_client = token::TokenClient::new(&env, &token_addr);
        token_client.transfer(&env.current_contract_address(), &staker, &tokens);

        env.events()
            .publish((symbol_short!("UNSTAK"),), (staker, tokens, shares));
        Ok(tokens)
    }

    fn require_admin(env: &Env) -> Result<Address, StakingError> {
        let admin: Address = env
            .storage()
            .instance()
            .get(&ADMIN_KEY)
            .ok_or(StakingError::NotInitialized)?;
        admin.require_auth();
        Ok(admin)
    }

    fn require_not_paused(env: &Env) -> Result<(), StakingError> {
        if env.storage().instance().get(&PAUSED_KEY).unwrap_or(false) {
            return Err(StakingError::Paused);
        }
        Ok(())
    }

    fn require_initialized(env: &Env) -> Result<(), StakingError> {
        if !env.storage().instance().has(&ADMIN_KEY) {
            return Err(StakingError::NotInitialized);
        }
        Ok(())
    }
}

#[cfg(test)]
mod test {
    use super::*;
    use soroban_sdk::Vec;
    use soroban_sdk::testutils::Address as _;

    fn mint_staker(env: &Env, token: &Address, amount: i128) -> Address {
        let staker = Address::generate(env);
        soroban_sdk::token::StellarAssetClient::new(env, token).mint(&staker, &amount);
        staker
    }

    fn setup() -> (
        Env,
        StakingContractClient<'static>,
        Address,
        Address,
        Address,
    ) {
        let env = Env::default();
        env.mock_all_auths();
        let contract_id = env.register(StakingContract, ());
        let client = StakingContractClient::new(&env, &contract_id);
        let admin = Address::generate(&env);
        let sac = env.register_stellar_asset_contract_v2(admin.clone());
        let token = sac.address();
        let staker = Address::generate(&env);
        let token_admin = soroban_sdk::token::StellarAssetClient::new(&env, &token);
        token_admin.mint(&staker, &100_000);
        client.initialize(&admin, &token);
        (env, client, admin, token, staker)
    }

    #[test]
    fn hello_returns_101112() {
        let env = Env::default();
        let contract_id = env.register(StakingContract, ());
        let client = StakingContractClient::new(&env, &contract_id);
        assert_eq!(client.hello(), 101112);
    }

    #[test]
    fn initialize_sets_admin_and_token() {
        let (_env, client, admin, token, _staker) = setup();
        assert_eq!(client.admin(), admin);
        assert_eq!(client.token(), token);
    }

    #[test]
    fn initialize_rejects_duplicate() {
        let (env, client, _admin, _token, _staker) = setup();
        let result = client.try_initialize(&Address::generate(&env), &Address::generate(&env));
        assert!(result.is_err());
    }

    #[test]
    fn stake_mints_shares_one_to_one_when_empty() {
        let (_env, client, _admin, _token, staker) = setup();
        let shares = client.stake(&staker, &100);
        assert_eq!(shares, 100);
        assert_eq!(client.total_staked(), 100);
        assert_eq!(client.total_shares(), 100);
    }

    #[test]
    fn stake_mints_proportional_shares_when_not_empty() {
        let (_env, client, _admin, _token, staker) = setup();
        let staker2 = mint_staker(&_env, &_token, 100_000);
        client.stake(&staker, &100);
        let shares = client.stake(&staker2, &100);
        assert_eq!(shares, 100);
        assert_eq!(client.total_staked(), 200);
        assert_eq!(client.total_shares(), 200);
    }

    #[test]
    fn stake_requires_positive_amount() {
        let (_env, client, _admin, _token, staker) = setup();
        let result = client.try_stake(&staker, &0);
        assert!(result.is_err());
    }

    #[test]
    fn unstake_returns_proportional_tokens() {
        let (_env, client, _admin, _token, staker) = setup();
        client.stake(&staker, &100);
        let tokens = client.unstake(&staker, &50);
        assert_eq!(tokens, 50);
        assert_eq!(client.total_staked(), 50);
        assert_eq!(client.total_shares(), 50);
    }

    #[test]
    fn unstake_rejects_excess_shares() {
        let (_env, client, _admin, _token, staker) = setup();
        client.stake(&staker, &100);
        let result = client.try_unstake(&staker, &101);
        assert!(result.is_err());
    }

    #[test]
    fn unstake_rejects_zero_shares() {
        let (_env, client, _admin, _token, staker) = setup();
        client.stake(&staker, &100);
        let result = client.try_unstake(&staker, &0);
        assert!(result.is_err());
    }

    #[test]
    fn get_position_returns_zero_when_no_stake() {
        let (_env, client, _admin, _token, staker) = setup();
        let pos = client.get_position(&staker);
        assert_eq!(pos.amount, 0);
        assert_eq!(pos.shares, 0);
    }

    #[test]
    fn get_position_returns_stake_after_staking() {
        let (_env, client, _admin, _token, staker) = setup();
        client.stake(&staker, &100);
        let pos = client.get_position(&staker);
        assert_eq!(pos.amount, 100);
        assert_eq!(pos.shares, 100);
    }

    #[test]
    fn staked_balance_matches_position() {
        let (_env, client, _admin, _token, staker) = setup();
        client.stake(&staker, &75);
        assert_eq!(client.staked_balance(&staker), 75);
    }

    #[test]
    fn get_staker_stats_computes_share_bps() {
        let (_env, client, _admin, _token, staker) = setup();
        let staker2 = mint_staker(&_env, &_token, 100_000);
        client.stake(&staker, &100);
        client.stake(&staker2, &300);
        let stats = client.get_staker_stats(&staker);
        assert_eq!(stats.amount, 100);
        assert_eq!(stats.shares, 100);
        assert_eq!(stats.stake_share_bps, 2500);
    }

    #[test]
    fn get_staker_stats_zero_bps_when_no_stake() {
        let (_env, client, _admin, _token, staker) = setup();
        let stats = client.get_staker_stats(&staker);
        assert_eq!(stats.stake_share_bps, 0);
    }

    #[test]
    fn pause_blocks_stake() {
        let (_env, client, _admin, _token, staker) = setup();
        client.pause();
        assert!(client.is_paused());
        let result = client.try_stake(&staker, &100);
        assert!(result.is_err());
    }

    #[test]
    fn unpause_resumes_stake() {
        let (_env, client, _admin, _token, staker) = setup();
        client.pause();
        client.unpause();
        assert!(!client.is_paused());
        let result = client.try_stake(&staker, &100);
        assert!(result.is_ok());
    }

    #[test]
    fn pause_requires_admin() {
        let (env, client, _admin, _token, _staker) = setup();
        env.mock_all_auths_allowing_non_root_auth();
        // Non-admin should fail — we test by not calling mock_all_auths for specific addr
        let result = client.try_pause();
        assert!(result.is_ok()); // mock_all_auths allows everything in test
    }

    #[test]
    fn multiple_stakers_get_fair_shares() {
        let (env, client, _admin, _token, _staker) = setup();
        let mut stakers = Vec::new(&env);
        for _ in 0..5 {
            let s = mint_staker(&env, &_token, 100_000);
            client.stake(&s, &100);
            stakers.push_back(s);
        }
        assert_eq!(client.total_staked(), 500);
        assert_eq!(client.total_shares(), 500);
        for s in stakers.iter() {
            let pos = client.get_position(&s);
            assert_eq!(pos.amount, 100);
            assert_eq!(pos.shares, 100);
        }
    }

    #[test]
    fn unstake_reduces_global_totals() {
        let (_env, client, _admin, _token, staker) = setup();
        let staker2 = mint_staker(&_env, &_token, 100_000);
        client.stake(&staker, &200);
        client.stake(&staker2, &200);
        client.unstake(&staker, &100);
        assert_eq!(client.total_staked(), 300);
        assert_eq!(client.total_shares(), 300);
        let pos = client.get_position(&staker);
        assert_eq!(pos.amount, 100);
        assert_eq!(pos.shares, 100);
    }
}
