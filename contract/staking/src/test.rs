#![cfg(test)]

extern crate std;

use super::*;
use soroban_sdk::{Address, Env, testutils::Address as _, token};

fn setup() -> (
    Env,
    Address,
    Address,
    StakingContractClient<'static>,
    token::TokenClient<'static>,
) {
    let env = Env::default();
    env.mock_all_auths();

    let admin = Address::generate(&env);
    let staker = Address::generate(&env);
    let asset = env.register_stellar_asset_contract_v2(admin.clone());
    let token_address = asset.address();
    let token_admin = token::StellarAssetClient::new(&env, &token_address);
    token_admin.mint(&staker, &1_000_000_000i128);

    let contract_id = env.register(StakingContract, ());
    let client = StakingContractClient::new(&env, &contract_id);
    client.initialize(&admin, &token_address);

    let env_static: &'static Env = unsafe { &*(&env as *const Env) };
    (
        env,
        admin,
        staker,
        StakingContractClient::new(env_static, &contract_id),
        token::TokenClient::new(env_static, &token_address),
    )
}

#[test]
fn initialize_sets_token_and_zero_totals() {
    let (_env, _admin, _staker, client, token_client) = setup();

    assert_eq!(client.token(), token_client.address.clone());
    assert_eq!(client.total_staked(), 0);
    assert_eq!(client.total_shares(), 0);
}

#[test]
fn stake_transfers_tokens_and_records_position() {
    let (_env, _admin, staker, client, token_client) = setup();
    let contract_address = client.address.clone();

    let staker_balance_before = token_client.balance(&staker);
    let contract_balance_before = token_client.balance(&contract_address);

    let minted_shares = client.stake(&staker, &250_000_000i128);

    assert_eq!(minted_shares, 250_000_000);
    assert_eq!(
        token_client.balance(&staker),
        staker_balance_before - 250_000_000
    );
    assert_eq!(
        token_client.balance(&contract_address),
        contract_balance_before + 250_000_000
    );

    assert_eq!(
        client.get_position(&staker),
        StakePosition {
            amount: 250_000_000,
            shares: 250_000_000,
        }
    );
    assert_eq!(client.total_staked(), 250_000_000);
    assert_eq!(client.total_shares(), 250_000_000);
}

#[test]
fn stake_mints_proportional_shares_for_later_stakers() {
    let (env, _admin, first_staker, client, token_client) = setup();
    let second_staker = Address::generate(&env);
    let token_admin = token::StellarAssetClient::new(&env, &client.token());
    token_admin.mint(&second_staker, &1_000_000_000i128);

    client.stake(&first_staker, &200_000_000i128);

    env.as_contract(&client.address, || {
        env.storage()
            .instance()
            .set(&TOTAL_STAKED_KEY, &400_000_000i128);
    });

    let minted_second = client.stake(&second_staker, &100_000_000i128);
    assert_eq!(minted_second, 50_000_000);
    assert_eq!(
        client.get_position(&second_staker),
        StakePosition {
            amount: 100_000_000,
            shares: 50_000_000,
        }
    );
    assert_eq!(token_client.balance(&second_staker), 900_000_000);
}

#[test]
fn stake_rejects_non_positive_amounts() {
    let (_env, _admin, staker, client, _token_client) = setup();

    assert_eq!(
        client.try_stake(&staker, &0),
        Err(Ok(StakingError::InvalidAmount))
    );
    assert_eq!(
        client.try_stake(&staker, &-1),
        Err(Ok(StakingError::InvalidAmount))
    );
}

#[test]
fn test_unstake_full_withdrawal() {
    let (_env, _admin, staker, client, token_client) = setup();
    let contract_address = client.address.clone();

    let balance_before = token_client.balance(&staker);
    let minted = client.stake(&staker, &250_000_000i128);
    assert_eq!(minted, 250_000_000);

    let returned = client.unstake(&staker, &minted);
    assert_eq!(returned, 250_000_000);

    // Token balance fully restored
    assert_eq!(token_client.balance(&staker), balance_before);
    assert_eq!(token_client.balance(&contract_address), 0);

    // Position removed — defaults to (0, 0)
    assert_eq!(
        client.get_position(&staker),
        StakePosition {
            amount: 0,
            shares: 0,
        }
    );

    // Global totals reset
    assert_eq!(client.total_staked(), 0);
    assert_eq!(client.total_shares(), 0);
}

#[test]
fn test_unstake_partial() {
    let (_env, _admin, staker, client, token_client) = setup();
    let contract_address = client.address.clone();

    let balance_before = token_client.balance(&staker);
    let minted = client.stake(&staker, &250_000_000i128);
    let half_shares = minted / 2; // 125_000_000

    let returned = client.unstake(&staker, &half_shares);
    assert_eq!(returned, 125_000_000);

    // Half the tokens returned
    assert_eq!(
        token_client.balance(&staker),
        balance_before - 125_000_000
    );
    assert_eq!(token_client.balance(&contract_address), 125_000_000);

    // Position halved
    let pos = client.get_position(&staker);
    assert_eq!(pos.shares, 125_000_000);
    assert_eq!(pos.amount, 125_000_000);

    // Global totals halved
    assert_eq!(client.total_staked(), 125_000_000);
    assert_eq!(client.total_shares(), 125_000_000);
}

#[test]
fn test_unstake_insufficient_shares() {
    let (_env, _admin, staker, client, _token_client) = setup();

    client.stake(&staker, &100_000_000i128);

    assert_eq!(
        client.try_unstake(&staker, &200_000_000i128),
        Err(Ok(StakingError::InsufficientShares))
    );
}

#[test]
fn test_unstake_zero_shares() {
    let (_env, _admin, staker, client, _token_client) = setup();

    assert_eq!(
        client.try_unstake(&staker, &0i128),
        Err(Ok(StakingError::ZeroShares))
    );

    // Negative shares also rejected
    assert_eq!(
        client.try_unstake(&staker, &-1i128),
        Err(Ok(StakingError::ZeroShares))
    );
}

#[test]
fn test_unstake_no_position() {
    let (_env, _admin, staker, client, _token_client) = setup();

    // Never staked — no position exists
    assert_eq!(
        client.try_unstake(&staker, &100i128),
        Err(Ok(StakingError::InsufficientShares))
    );
}
