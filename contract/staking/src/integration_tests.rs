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
    assert_eq!(
        token_client.balance(&contract_address),
        amount1 + amount2
    );
}

#[test]
fn integration_unstake_after_yield() {
    let (env, _admin, staker1, staker2, client, token_client) = setup();
    let contract_address = client.address.clone();

    let balance1_before = token_client.balance(&staker1);
    let balance2_before = token_client.balance(&staker2);

    // Both stakers deposit equal amounts.
    let amount1 = 200_000_000i128;
    let amount2 = 200_000_000i128;
    let minted1 = client.stake(&staker1, &amount1);
    let minted2 = client.stake(&staker2, &amount2);

    assert_eq!(minted1, amount1); // first stake: shares == amount
    assert_eq!(minted2, amount2); // equal ratio => same shares

    // Mimic yield accrual: TOTAL_STAKED increases by 100M (50M effective per staker
    // proportional to shares) without minting new shares.
    let yield_amount = 100_000_000i128;
    let new_total_staked = amount1 + amount2 + yield_amount; // 500M

    env.as_contract(&contract_address, || {
        env.storage()
            .instance()
            .set(&TOTAL_STAKED_KEY, &new_total_staked);
    });

    // Also mint yield tokens into the contract so the transfer can succeed.
    let token_admin_client =
        token::StellarAssetClient::new(&env, &client.token());
    token_admin_client.mint(&contract_address, &yield_amount);

    let total_shares_before = client.total_shares(); // 400M

    // Staker1 unstakes ALL shares.
    // Expected token_amount = minted1 * new_total_staked / total_shares
    //                       = 200M * 500M / 400M = 250M
    let returned1 = client.unstake(&staker1, &minted1);
    let expected_returned1 = minted1
        .checked_mul(new_total_staked)
        .and_then(|v| v.checked_div(total_shares_before))
        .expect("math");
    assert_eq!(returned1, expected_returned1);
    assert_eq!(returned1, 250_000_000); // principal 200M + yield 50M

    // Staker1 balance restored with yield.
    assert_eq!(
        token_client.balance(&staker1),
        balance1_before + 50_000_000 // net gain = yield portion
    );

    // Staker1 position fully removed.
    assert_eq!(
        client.get_position(&staker1),
        StakePosition {
            amount: 0,
            shares: 0,
        }
    );

    // Global totals reflect only staker2's remaining position.
    let remaining_staked = new_total_staked - returned1; // 250M
    let remaining_shares = total_shares_before - minted1; // 200M
    assert_eq!(client.total_staked(), remaining_staked);
    assert_eq!(client.total_shares(), remaining_shares);

    // Staker2's position is unchanged (only staker1 unstaked).
    let pos2 = client.get_position(&staker2);
    assert_eq!(pos2.shares, minted2);
    assert_eq!(pos2.amount, amount2);

    // Staker2 partial unstake: half of their shares.
    let half_shares2 = minted2 / 2; // 100M
    // Expected: 100M * 250M / 200M = 125M
    let returned2 = client.unstake(&staker2, &half_shares2);
    let expected_returned2 = half_shares2
        .checked_mul(remaining_staked)
        .and_then(|v| v.checked_div(remaining_shares))
        .expect("math");
    assert_eq!(returned2, expected_returned2);
    assert_eq!(returned2, 125_000_000);

    // Staker2 balance: original - 200M (staked) + 125M (partial unstake)
    assert_eq!(
        token_client.balance(&staker2),
        balance2_before - amount2 + returned2
    );

    // Staker2 position should be halved in shares, amount proportionally reduced.
    let pos2_after = client.get_position(&staker2);
    assert_eq!(pos2_after.shares, half_shares2); // 100M shares remain
    // amount = original_amount * remaining_shares / original_shares = 200M * 100M / 200M = 100M
    let expected_amount2 = amount2
        .checked_mul(half_shares2)
        .and_then(|v| v.checked_div(minted2))
        .expect("math");
    assert_eq!(pos2_after.amount, expected_amount2);

    // Final totals
    assert_eq!(client.total_staked(), remaining_staked - returned2); // 125M
    assert_eq!(client.total_shares(), remaining_shares - half_shares2); // 100M
}

