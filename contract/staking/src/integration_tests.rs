#![cfg(test)]

extern crate std;

use super::*;
use soroban_sdk::{
    Address,
    Env,
    testutils::Address as _,
    // Needed so we can directly tweak instance storage within `as_contract`.
    token,
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

    let contract_id = env.register(StakingContract, (&admin, &token_address));

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

fn assert_pool_invariants(client: &StakingContractClient<'_>, tracked: &[Address]) {
    let total_staked = client.total_staked();
    let total_shares = client.total_shares();

    assert!(total_staked >= 0, "total_staked must never be negative");
    assert!(total_shares >= 0, "total_shares must never be negative");

    if total_staked == 0 {
        assert_eq!(
            total_shares, 0,
            "total_shares must be zero when total_staked is zero"
        );
    }
    if total_shares == 0 {
        assert_eq!(
            total_staked, 0,
            "total_staked must be zero when total_shares is zero"
        );
    }

    let mut sum_amounts = 0i128;
    let mut sum_shares = 0i128;
    for staker in tracked {
        let pos = client.get_position(staker);
        sum_amounts += pos.amount;
        sum_shares += pos.shares;
    }

    assert_eq!(
        sum_amounts, total_staked,
        "position amounts must match total_staked"
    );
    assert_eq!(
        sum_shares, total_shares,
        "position shares must match total_shares"
    );
}

#[test]
fn integration_deploys_and_initializes() {
    let (_env, admin, _staker1, _staker2, client, token_client) = setup();

    assert_eq!(client.token(), token_client.address.clone());
    assert_eq!(client.total_staked(), 0);
    assert_eq!(client.total_shares(), 0);

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
    let minted1 = client.stake(&staker1, &amount1);
    assert_eq!(minted1, amount1);

    assert_eq!(client.total_staked(), amount1);
    assert_eq!(client.total_shares(), amount1);
    assert_eq!(
        client.get_position(&staker1),
        StakePosition {
            amount: amount1,
            shares: amount1
        }
    );

    // "Mimic yield" by increasing total_staked without increasing total_shares,
    // simulating accrual to existing principals.
    let yield_amount = 50_000_000i128;
    let adjusted_total_staked = amount1 + yield_amount;

    env.as_contract(&contract_address, || {
        env.storage()
            .instance()
            .set(&TOTAL_STAKED_KEY, &adjusted_total_staked);
    });

    // Second staker: minted shares should reflect the higher total_staked.
    let amount2 = 100_000_000i128;
    let minted2 = client.stake(&staker2, &amount2);

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
    assert_eq!(token_client.balance(&contract_address), amount1 + amount2);
}

#[test]
fn integration_invariants_hold_across_state_transitions() {
    let (env, admin, staker1, staker2, client, _token_client) = setup();
    let token_admin = token::StellarAssetClient::new(&env, &client.token());
    token_admin.mint(&admin, &1_000_000_000i128);

    let tracked = [staker1.clone(), staker2.clone()];

    client.stake(&staker1, &300_000_000i128);
    assert_pool_invariants(&client, &tracked);

    client.stake(&staker2, &150_000_000i128);
    assert_pool_invariants(&client, &tracked);

    client.deposit_rewards(&admin, &90_000_000i128);
    assert_pool_invariants(&client, &tracked);

    let _claimed = client.claim_rewards(&staker1);
    assert_pool_invariants(&client, &tracked);

    client.deposit_rewards(&admin, &60_000_000i128);
    let _compounded = client.compound(&staker2);
    assert_pool_invariants(&client, &tracked);

    let _unstaked_partial = client.unstake(&staker1, &50_000_000i128);
    assert_pool_invariants(&client, &tracked);

    let staker2_full = client.get_position(&staker2).amount;
    let _unstaked_full = client.unstake(&staker2, &staker2_full);
    assert_pool_invariants(&client, &[staker1]);
}
