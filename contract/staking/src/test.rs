use super::*;
use soroban_sdk::Vec;
use soroban_sdk::testutils::Address as _;
use soroban_sdk::testutils::Ledger as _;
use soroban_sdk::testutils::storage::Persistent as _;

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
fn initialize_sets_admin_and_token() {
    let (_env, client, admin, token, _staker) = setup();
    assert_eq!(client.admin(), admin);
    assert_eq!(client.token(), token);
}

#[test]
fn version_returns_the_current_contract_version() {
    let (_env, client, _admin, _token, _staker) = setup();
    assert_eq!(client.version(), CONTRACT_VERSION);
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
fn unstake_rejects_when_no_shares_outstanding() {
    let (env, client, _admin, _token, _staker) = setup();
    let contract_id = client.address.clone();
    let staker = mint_staker(&env, &_token, 100_000);

    client.stake(&staker, &100);
    env.as_contract(&contract_id, || {
        env.storage().persistent().set(&TSHARES_KEY, &0i128);
    });

    let result = client.try_unstake(&staker, &50);
    assert_eq!(result, Err(Ok(StakingError::NoSharesOutstanding)));
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
    env.set_auths(&[]);
    assert!(
        client.try_pause().is_err(),
        "pause without the admin's authorization must be rejected"
    );
}

#[test]
fn upgrade_requires_admin_auth() {
    let (env, client, _admin, _token, _staker) = setup();
    env.set_auths(&[]);
    let new_wasm = BytesN::from_array(&env, &[0u8; 32]);
    assert!(
        client.try_upgrade(&new_wasm).is_err(),
        "upgrade without the admin's authorization must be rejected"
    );
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

#[test]
fn get_shares_returns_correct_value() {
    let (_env, client, _admin, _token, staker) = setup();
    client.stake(&staker, &150);
    assert_eq!(client.get_shares(&staker), 150);
}

#[test]
fn distribute_rewards_increases_staked_value() {
    let (env, client, _admin, token, staker) = setup();
    client.stake(&staker, &100);
    let reward_provider = mint_staker(&env, &token, 50_000);
    client.distribute_rewards(&reward_provider, &50);
    assert_eq!(client.total_staked(), 150);
    assert_eq!(client.total_shares(), 100);
    let returned = client.unstake(&staker, &100);
    assert_eq!(returned, 150);
}

#[test]
fn min_initial_stake_is_exposed_to_clients() {
    let (_env, client, _admin, _token, _staker) = setup();
    assert_eq!(client.min_initial_stake(), MIN_INITIAL_STAKE);
}

#[test]
fn dust_initial_deposit_is_rejected() {
    let (_env, client, _admin, _token, staker) = setup();
    assert_eq!(
        client.try_stake(&staker, &1),
        Err(Ok(StakingError::BelowMinimumInitialStake))
    );
    assert_eq!(
        client.try_stake(&staker, &(MIN_INITIAL_STAKE - 1)),
        Err(Ok(StakingError::BelowMinimumInitialStake))
    );
    assert_eq!(client.total_shares(), 0);
}

#[test]
fn initial_deposit_at_the_minimum_is_accepted() {
    let (_env, client, _admin, _token, staker) = setup();
    let shares = client.stake(&staker, &MIN_INITIAL_STAKE);
    assert_eq!(shares, MIN_INITIAL_STAKE);
    assert_eq!(client.total_shares(), MIN_INITIAL_STAKE);
}

#[test]
fn minimum_applies_again_once_the_pool_is_emptied() {
    let (_env, client, _admin, _token, staker) = setup();
    client.stake(&staker, &MIN_INITIAL_STAKE);
    client.unstake(&staker, &MIN_INITIAL_STAKE);
    assert_eq!(client.total_shares(), 0);
    assert_eq!(
        client.try_stake(&staker, &1),
        Err(Ok(StakingError::BelowMinimumInitialStake))
    );
}

#[test]
fn deposit_that_would_mint_zero_shares_is_rejected() {
    let (env, client, _admin, token, _staker) = setup();
    let attacker = mint_staker(&env, &token, 1_000_000 + MIN_INITIAL_STAKE);
    let victim = mint_staker(&env, &token, 1_000);
    client.stake(&attacker, &MIN_INITIAL_STAKE);
    client.distribute_rewards(&attacker, &1_000_000);
    assert_eq!(client.total_shares(), MIN_INITIAL_STAKE);
    assert_eq!(client.total_staked(), 1_000_000 + MIN_INITIAL_STAKE);
    assert_eq!(
        client.try_stake(&victim, &1_000),
        Err(Ok(StakingError::ZeroShares))
    );
    assert_eq!(
        soroban_sdk::token::TokenClient::new(&env, &token).balance(&victim),
        1_000
    );
}

#[test]
fn inflated_pool_still_gives_the_second_depositor_fair_shares() {
    let (env, client, _admin, token, _staker) = setup();
    let token_client = soroban_sdk::token::TokenClient::new(&env, &token);
    let attacker_capital = 1_001_000i128;
    let victim_deposit = 1_000_000i128;
    let attacker = mint_staker(&env, &token, attacker_capital);
    let victim = mint_staker(&env, &token, victim_deposit);
    client.stake(&attacker, &1_000);
    client.distribute_rewards(&attacker, &1_000_000);
    assert_eq!(client.total_shares(), 1_000);
    assert_eq!(client.total_staked(), attacker_capital);
    assert_eq!(token_client.balance(&attacker), 0);
    let victim_shares = client.stake(&victim, &victim_deposit);
    assert_eq!(victim_shares, 999);
    assert!(victim_shares > 0, "deposit must not be diluted to nothing");
    let returned = client.unstake(&victim, &victim_shares);
    assert_eq!(returned, 999_999);
    assert!(
        returned >= victim_deposit - victim_deposit / 1_000,
        "victim recovered {returned} of {victim_deposit}"
    );
    client.unstake(&attacker, &1_000);
    let attacker_final = token_client.balance(&attacker);
    assert!(
        attacker_final <= attacker_capital + victim_deposit / 1_000,
        "attacker walked away with {attacker_final} on {attacker_capital} committed"
    );
}

#[test]
fn honest_pool_splits_value_pro_rata_after_rewards() {
    let (env, client, _admin, token, _staker) = setup();
    let a = mint_staker(&env, &token, 10_000);
    let b = mint_staker(&env, &token, 10_000);
    let funder = mint_staker(&env, &token, 10_000);
    client.stake(&a, &1_000);
    client.stake(&b, &1_000);
    client.distribute_rewards(&funder, &1_000);
    assert_eq!(client.unstake(&a, &1_000), 1_500);
    assert_eq!(client.unstake(&b, &1_000), 1_500);
    assert_eq!(client.total_staked(), 0);
    assert_eq!(client.total_shares(), 0);
}

#[test]
fn propose_and_accept_admin_rotates_admin() {
    let (env, client, _admin, _token, _staker) = setup();
    let new_admin = Address::generate(&env);
    client.propose_admin(&new_admin);
    client.accept_admin();
    assert_eq!(client.admin(), new_admin);
}

#[test]
fn accept_admin_without_proposal_fails() {
    let (env, client, _admin, _token, _staker) = setup();
    env.set_auths(&[]);
    let result = client.try_accept_admin();
    assert!(result.is_err());
}

#[test]
fn propose_admin_requires_current_admin_auth() {
    let (env, client, _admin, _token, _staker) = setup();
    let new_admin = Address::generate(&env);
    env.set_auths(&[]);
    let result = client.try_propose_admin(&new_admin);
    assert!(result.is_err());
}

#[test]
fn second_propose_overwrites_first() {
    let (env, client, _admin, _token, _staker) = setup();
    let addr_a = Address::generate(&env);
    let addr_b = Address::generate(&env);
    client.propose_admin(&addr_a);
    client.propose_admin(&addr_b);
    client.accept_admin();
    assert_eq!(client.admin(), addr_b);
}

#[test]
fn distribute_rewards_rejects_empty_pool() {
    let (env, client, _admin, token, _staker) = setup();
    let reward_provider = mint_staker(&env, &token, 50_000);
    assert_eq!(client.total_shares(), 0);
    let result = client.try_distribute_rewards(&reward_provider, &50);
    assert_eq!(result, Err(Ok(StakingError::NoSharesOutstanding)));
}

#[test]
fn stake_amount_addition_overflow_is_rejected() {
    let (env, client, _admin, token, staker) = setup();
    let contract_id = client.address.clone();
    client.stake(&staker, &100);
    env.as_contract(&contract_id, || {
        env.storage().persistent().set(&TSTAKE_KEY, &(i128::MAX - 1));
        env.storage().persistent().set(&TSHARES_KEY, &(i128::MAX - 1));
    });
    let overflowing_staker = mint_staker(&env, &token, i128::MAX);
    let result = client.try_stake(&overflowing_staker, &2);
    assert_eq!(result, Err(Ok(StakingError::ArithmeticOverflow)));
}

#[test]
fn stake_share_multiplication_overflow_is_rejected() {
    let (env, client, _admin, token, staker) = setup();
    let contract_id = client.address.clone();
    client.stake(&staker, &10);
    env.as_contract(&contract_id, || {
        env.storage().persistent().set(&TSHARES_KEY, &i128::MAX);
    });
    let big_staker = mint_staker(&env, &token, i128::MAX);
    let result = client.try_stake(&big_staker, &(i128::MAX / 2));
    assert_eq!(result, Err(Ok(StakingError::ArithmeticOverflow)));
}

#[test]
fn stake_position_amount_overflow_is_rejected() {
    let (env, client, _admin, token, staker) = setup();
    let contract_id = client.address.clone();
    client.stake(&staker, &100);
    let mut position = client.get_position(&staker);
    position.amount = i128::MAX - 50;
    env.as_contract(&contract_id, || {
        env.storage()
            .persistent()
            .set(&DataKey::Position(staker.clone()), &position);
        env.storage().persistent().set(&TSTAKE_KEY, &(i128::MAX - 50));
        env.storage().persistent().set(&TSHARES_KEY, &(i128::MAX - 50));
    });
    let more = mint_staker(&env, &token, 100);
    let result = client.try_stake(&more, &100);
    assert_eq!(result, Err(Ok(StakingError::ArithmeticOverflow)));
}

#[test]
fn unstake_position_amount_underflow_is_rejected() {
    let (env, client, _admin, _token, staker) = setup();
    let contract_id = client.address.clone();
    client.stake(&staker, &100);
    let mut position = client.get_position(&staker);
    position.amount = i128::MIN;
    env.as_contract(&contract_id, || {
        env.storage()
            .persistent()
            .set(&DataKey::Position(staker.clone()), &position);
    });
    let result = client.try_unstake(&staker, &100);
    assert_eq!(result, Err(Ok(StakingError::ArithmeticOverflow)));
}

#[test]
fn unstake_share_multiplication_overflow_is_rejected() {
    let (env, client, _admin, _token, staker) = setup();
    let contract_id = client.address.clone();
    client.stake(&staker, &100);
    let mut position = client.get_position(&staker);
    position.shares = i128::MAX;
    env.as_contract(&contract_id, || {
        env.storage()
            .persistent()
            .set(&DataKey::Position(staker.clone()), &position);
        env.storage().persistent().set(&TSTAKE_KEY, &i128::MAX);
    });
    let result = client.try_unstake(&staker, &i128::MAX);
    assert_eq!(result, Err(Ok(StakingError::ArithmeticOverflow)));
}

#[test]
fn distribute_rewards_addition_overflow_is_rejected() {
    let (env, client, _admin, token, staker) = setup();
    let contract_id = client.address.clone();
    client.stake(&staker, &100);
    env.as_contract(&contract_id, || {
        env.storage().persistent().set(&TSTAKE_KEY, &i128::MAX);
    });
    let reward_provider = mint_staker(&env, &token, i128::MAX);
    let result = client.try_distribute_rewards(&reward_provider, &1);
    assert_eq!(result, Err(Ok(StakingError::ArithmeticOverflow)));
}

#[test]
fn normal_stake_and_unstake_are_unaffected_by_the_checked_arithmetic_change() {
    let (_env, client, _admin, _token, staker) = setup();
    let shares = client.stake(&staker, &500);
    assert_eq!(shares, 500);
    let tokens = client.unstake(&staker, &200);
    assert_eq!(tokens, 200);
    assert_eq!(client.total_staked(), 300);
    assert_eq!(client.total_shares(), 300);
}

fn admin_ttl(env: &Env, contract: &Address) -> u32 {
    env.as_contract(contract, || env.storage().persistent().get_ttl(&ADMIN_KEY))
}

#[test]
fn renew_storage_extends_when_below_threshold_and_is_idempotent() {
    let (env, client, _admin, _token, _staker) = setup();
    env.as_contract(&client.address, || {
        env.storage().instance().extend_ttl(
            PERSISTENT_TTL_THRESHOLD - 1,
            PERSISTENT_TTL_EXTEND_TO,
        );
    });
    env.ledger().with_mut(|li| {
        li.sequence_number += PERSISTENT_TTL_EXTEND_TO - PERSISTENT_TTL_THRESHOLD + 1;
    });
    let before = admin_ttl(&env, &client.address);
    assert!(before < PERSISTENT_TTL_THRESHOLD);
    client.renew_storage();
    let after = admin_ttl(&env, &client.address);
    assert!(
        after >= PERSISTENT_TTL_EXTEND_TO,
        "renewal must restore headroom to the extend target",
    );
    client.renew_storage();
    assert_eq!(admin_ttl(&env, &client.address), after);
}

#[test]
fn persistent_keys_are_extended_on_read_and_write() {
    let (env, client, _admin, _token, staker) = setup();
    client.stake(&staker, &100);

    let position_ttl = env.as_contract(&client.address, || {
        env.storage().persistent().get_ttl(&DataKey::Position(staker.clone()))
    });
    assert!(position_ttl >= PERSISTENT_TTL_EXTEND_TO);

    env.as_contract(&client.address, || {
        env.storage().instance().extend_ttl(
            PERSISTENT_TTL_THRESHOLD - 1,
            PERSISTENT_TTL_EXTEND_TO,
        );
    });
    env.ledger().with_mut(|li| {
        li.sequence_number += PERSISTENT_TTL_EXTEND_TO - PERSISTENT_TTL_THRESHOLD + 1;
    });
    let before = admin_ttl(&env, &client.address);
    assert!(before < PERSISTENT_TTL_THRESHOLD);

    client.admin();
    let after = admin_ttl(&env, &client.address);
    assert!(after >= PERSISTENT_TTL_EXTEND_TO);
}

#[test]
fn renew_storage_does_not_shorten_ttl_when_already_healthy() {
    let (env, client, _admin, _token, _staker) = setup();
    let before = admin_ttl(&env, &client.address);
    client.renew_storage();
    let after = admin_ttl(&env, &client.address);
    assert!(after >= before, "renewal must never shorten a key's TTL");
}

#[test]
fn renew_storage_refuses_when_contract_identity_is_unset() {
    let env = Env::default();
    env.mock_all_auths();
    let contract_id = env.register(StakingContract, ());
    let client = StakingContractClient::new(&env, &contract_id);
    let result = client.try_renew_storage();
    assert_eq!(result, Err(Ok(StakingError::NotInitialized)));
}

#[test]
fn storage_inventory_reports_absent_keys_before_initialization() {
    let env = Env::default();
    env.mock_all_auths();
    let contract_id = env.register(StakingContract, ());
    let client = StakingContractClient::new(&env, &contract_id);
    let inventory = client.storage_inventory();
    assert_eq!(inventory.len(), 6);
    for row in inventory.iter() {
        assert!(!row.present);
    }
}

#[test]
fn storage_inventory_lists_critical_global_keys_and_not_positions() {
    let (_env, client, _admin, _token, staker) = setup();
    client.stake(&staker, &100);
    let inventory = client.storage_inventory();
    assert_eq!(inventory.len(), 6);
    let mut present = 0;
    let mut admin_seen = false;
    let mut pending_seen = false;
    for row in inventory.iter() {
        if row.present {
            present += 1;
        }
        if row.key == ADMIN_KEY {
            admin_seen = true;
            assert!(row.present);
        }
        if row.key == PENDING_ADMIN_KEY {
            pending_seen = true;
            assert!(!row.present);
        }
    }
    assert_eq!(present, 5);
    assert!(admin_seen && pending_seen);
}
