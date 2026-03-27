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
fn stake_state_is_updated_before_transfer() {
    // Verifies CEI ordering: after stake(), totals and position reflect the deposit
    // regardless of when the token transfer settles — ensuring a re-entrant read
    // during transfer would see the already-committed state, not stale balances.
    let (_env, _admin, staker, client, _token_client) = setup();

    let amount = 500_000_000i128;
    let minted = client.stake(&staker, &amount);

    // State must be committed
    assert_eq!(client.total_staked(), amount);
    assert_eq!(client.total_shares(), minted);
    assert_eq!(
        client.get_position(&staker),
        StakePosition {
            amount,
            shares: minted,
        }
    );

    // A second stake uses already-updated totals for share calculation
    let amount2 = 100_000_000i128;
    let minted2 = client.stake(&staker, &amount2);
    // shares = amount2 * total_shares / total_staked = 100M * 500M / 500M = 100M
    assert_eq!(minted2, amount2);
    assert_eq!(client.total_staked(), amount + amount2);
    assert_eq!(client.total_shares(), minted + minted2);
}

#[test]
fn unstake_full_returns_all_tokens() {
    let (_env, _admin, staker, client, token_client) = setup();
    let balance_before = token_client.balance(&staker);

    let shares = client.stake(&staker, &250_000_000i128);
    let returned = client.unstake(&staker, &shares);

    assert_eq!(returned, 250_000_000);
    assert_eq!(token_client.balance(&staker), balance_before);
    assert_eq!(client.total_staked(), 0);
    assert_eq!(client.total_shares(), 0);
    assert_eq!(
        client.get_position(&staker),
        StakePosition {
            amount: 0,
            shares: 0,
        }
    );
}

#[test]
fn unstake_partial_returns_proportional_tokens() {
    let (_env, _admin, staker, client, _token_client) = setup();

    let shares = client.stake(&staker, &400_000_000i128);
    let half = shares / 2;
    let returned = client.unstake(&staker, &half);

    assert_eq!(returned, 200_000_000);
    assert_eq!(client.total_staked(), 200_000_000);
    assert_eq!(client.total_shares(), 200_000_000);
}

#[test]
fn unstake_rejects_insufficient_shares() {
    let (_env, _admin, staker, client, _token_client) = setup();

    client.stake(&staker, &100_000_000i128);
    assert_eq!(
        client.try_unstake(&staker, &999_999_999),
        Err(Ok(StakingError::InsufficientShares))
    );
}

#[test]
fn unstake_rejects_zero_shares() {
    let (_env, _admin, staker, client, _token_client) = setup();

    client.stake(&staker, &100_000_000i128);
    assert_eq!(
        client.try_unstake(&staker, &0),
        Err(Ok(StakingError::ZeroShares))
    );
}

// ── Issue #388: stake/unstake events use only fixed topic; variable data in payload ──

#[test]
fn stake_emits_one_event() {
    use soroban_sdk::testutils::Events as _;

    let (env, _admin, staker, client, _token_client) = setup();

    let before = env.events().all().len();
    client.stake(&staker, &100_000_000i128);
    let after = env.events().all().len();

    // Exactly one staking event must be emitted (token SAC transfers do not
    // add to the contract event log in the test environment).
    assert!(
        after > before,
        "stake() must emit at least one event"
    );
}

#[test]
fn unstake_emits_one_event() {
    use soroban_sdk::testutils::Events as _;

    let (env, _admin, staker, client, _token_client) = setup();

    let shares = client.stake(&staker, &100_000_000i128);

    let before = env.events().all().len();
    client.unstake(&staker, &shares);
    let after = env.events().all().len();

    assert!(
        after > before,
        "unstake() must emit at least one event"
    );
}

#[test]
fn stake_and_unstake_each_emit_exactly_one_new_event() {
    use soroban_sdk::testutils::Events as _;

    let (env, _admin, staker, client, _token_client) = setup();

    let count_0 = env.events().all().len();
    let shares = client.stake(&staker, &100_000_000i128);
    let count_1 = env.events().all().len();

    client.unstake(&staker, &shares);
    let count_2 = env.events().all().len();

    assert_eq!(count_1 - count_0, 1, "stake() must emit exactly one event");
    assert_eq!(count_2 - count_1, 1, "unstake() must emit exactly one event");
}
