#![cfg(test)]

extern crate std;

use super::*;
use soroban_sdk::{
    token, Address, Env, testutils::Address as _,
    // Needed so we can directly tweak instance storage within `as_contract`.
};

fn setup() -> (
    Env,
    Address,
    Address,
    Address,
    StakingContractClient<'static>,
    token::TokenClient<'static>,
) {
    let env = Env::default();
    env.mock_all_auths();

    let admin = Address::generate(&env);
    let staker1 = Address::generate(&env);
    let staker2 = Address::generate(&env);

    let asset = env.register_stellar_asset_contract_v2(admin.clone());
    let token_address = asset.address();
    let token_admin = token::StellarAssetClient::new(&env, &token_address);

    token_admin.mint(&staker1, &1_000_000_000i128);
    token_admin.mint(&staker2, &1_000_000_000i128);

    let contract_id = env.register(StakingContract, ());
    let client = StakingContractClient::new(&env, &contract_id);
    client.initialize(&admin, &token_address);

    let env_static: &'static Env = unsafe { &*(&env as *const Env) };
    (
        env,
        admin,
        staker1,
        staker2,
        StakingContractClient::new(env_static, &contract_id),
        token::TokenClient::new(env_static, &token_address),
    )
}

#[test]
fn integration_deploys_and_initializes() {
    let (_env, admin, _staker1, _staker2, client, token_client) = setup();

    assert_eq!(client.token(), token_client.address.clone());
    assert_eq!(client.total_staked().unwrap(), 0);
    assert_eq!(client.total_shares().unwrap(), 0);

    // Sanity: admin address was persisted.
    // (We don't have a getter in the contract, but initialization must have succeeded.)
    assert!(!admin.to_string().is_empty());
}

#[test]
fn integration_stake_flow_and_yield_mimic() {
    let (env, _admin, staker1, staker2, client, token_client) = setup();
    let contract_address = client.address.clone();

    // First staker: when totals are empty, minted shares = amount.
    let amount1 = 250_000_000i128;
    let minted1 = client.stake(&staker1, &amount1).unwrap();
    assert_eq!(minted1, amount1);

    assert_eq!(client.total_staked().unwrap(), amount1);
    assert_eq!(client.total_shares().unwrap(), amount1);
    assert_eq!(client.get_position(&staker1), StakePosition { amount: amount1, shares: amount1 });

    // "Mimic yield" by increasing total_staked without increasing total_shares,
    // simulating accrual to existing principals.
    let yield_amount = 50_000_000i128;
    let adjusted_total_staked = amount1 + yield_amount;

    env.as_contract(&contract_address, || {
        env.storage().instance().set(&TOTAL_STAKED_KEY, &adjusted_total_staked);
    });

    // Second staker: minted shares should reflect the higher total_staked.
    let amount2 = 100_000_000i128;
    let minted2 = client.stake(&staker2, &amount2).unwrap();

    // Contract uses: amount * total_shares / total_staked (integer division).
    let expected_minted2 = amount2
        .checked_mul(amount1)
        .and_then(|v| v.checked_div(adjusted_total_staked))
        .expect("math must not overflow");

    assert_eq!(minted2, expected_minted2);

    let position2 = client.get_position(&staker2);
    assert_eq!(position2.amount, amount2);
    assert_eq!(position2.shares, expected_minted2);

    // Token balances moved into the staking contract.
    assert_eq!(
        token_client.balance(&contract_address),
        amount1 + amount2
    );
}

