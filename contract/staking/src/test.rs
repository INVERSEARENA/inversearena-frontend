#![cfg(test)]

extern crate std;

use super::*;
use soroban_sdk::{
    Address, BytesN, Env, IntoVal,
    testutils::Address as _,
    token::{self, StellarAssetClient},
};

const TIMELOCK: u64 = 48 * 60 * 60;

// ── helpers ───────────────────────────────────────────────────────────────────

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

// ── Issue #500: initialize() guard tests ─────────────────────────────────────

#[test]
fn initialize_happy_path_stores_admin() {
    let env = Env::default();
    env.mock_all_auths();

    let admin = Address::generate(&env);
    let token_addr = Address::generate(&env);
    let contract_id = env.register(StakingContract, ());
    let client = StakingContractClient::new(&env, &contract_id);

    client.initialize(&admin, &token_addr);
    assert_eq!(client.admin(), admin);
}

#[test]
#[should_panic(expected = "already initialized")]
fn initialize_duplicate_call_panics() {
    let (_env, admin, _staker, client, token_client) = setup();
    // Second call must panic.
    client.initialize(&admin, &token_client.address);
}

#[test]
fn initialize_without_auth_panics() {
    // staking's initialize requires admin.require_auth().
    // Without mock_all_auths the call should fail auth.
    let env = Env::default();
    // No mock_all_auths — auth failures turn into contract aborts.

    let admin = Address::generate(&env);
    let token_addr = Address::generate(&env);
    let contract_id = env.register(StakingContract, ());
    let client = StakingContractClient::new(&env, &contract_id);

    let result = client.try_initialize(&admin, &token_addr);
    // Soroban v22 reports auth failures as contract-level errors (not host aborts).
    assert!(
        result.is_err(),
        "initialize without auth must fail, got: {:?}",
        result
    );
}

#[test]
fn initialize_wrong_caller_cannot_init() {
    // A different address from admin tries to call initialize with admin as arg.
    // Soroban auth checks that the admin address itself signed; providing the
    // admin address as argument but signing as someone else must fail.
    let env = Env::default();
    // mock_auths with an impersonator — admin.require_auth() will not be satisfied
    let admin = Address::generate(&env);
    let impersonator = Address::generate(&env);
    let token_id = Address::generate(&env);
    let contract_id = env.register(StakingContract, ());
    let client = StakingContractClient::new(&env, &contract_id);

    // Only provide auth for impersonator, NOT for admin.
    // admin.require_auth() inside initialize() will fail.
    env.mock_auths(&[soroban_sdk::testutils::MockAuth {
        address: &impersonator,
        invoke: &soroban_sdk::testutils::MockAuthInvoke {
            contract: &contract_id,
            fn_name: "initialize",
            args: soroban_sdk::vec![
                &env,
                admin.clone().into_val(&env),
                token_id.clone().into_val(&env)
            ]
            .into(),
            sub_invokes: &[],
        },
    }]);

    // admin.require_auth() requires admin's own signature, not impersonator's
    let result = client.try_initialize(&admin, &token_id);
    assert!(result.is_err(), "initialize with wrong signer must fail");
    let _ = impersonator; // suppress unused warning
}

#[test]
fn admin_query_returns_correct_address_after_init() {
    let (_env, admin, _staker, client, _token) = setup();
    assert_eq!(client.admin(), admin);
}

// ── token/admin query tests ───────────────────────────────────────────────────

#[test]
fn initialize_sets_token_and_zero_totals() {
    let (_env, _admin, _staker, client, token_client) = setup();

    assert_eq!(client.token(), token_client.address.clone());
    assert_eq!(client.total_staked(), 0);
    assert_eq!(client.total_shares(), 0);
}

// ── stake tests ───────────────────────────────────────────────────────────────

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
    let (_env, _admin, staker, client, _token_client) = setup();

    let amount = 500_000_000i128;
    let minted = client.stake(&staker, &amount);

    assert_eq!(client.total_staked(), amount);
    assert_eq!(client.total_shares(), minted);
    assert_eq!(
        client.get_position(&staker),
        StakePosition {
            amount,
            shares: minted,
        }
    );

    let amount2 = 100_000_000i128;
    let minted2 = client.stake(&staker, &amount2);
    assert_eq!(minted2, amount2);
    assert_eq!(client.total_staked(), amount + amount2);
    assert_eq!(client.total_shares(), minted + minted2);
}

// ── unstake tests ─────────────────────────────────────────────────────────────

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

// ── Issue #388: stake/unstake events ─────────────────────────────────────────

#[test]
fn stake_emits_one_event() {
    use soroban_sdk::testutils::Events as _;

    let (env, _admin, staker, client, _token_client) = setup();

    let before = env.events().all().len();
    client.stake(&staker, &100_000_000i128);
    let after = env.events().all().len();

    assert!(after > before, "stake() must emit at least one event");
}

#[test]
fn unstake_emits_one_event() {
    use soroban_sdk::testutils::Events as _;

    let (env, _admin, staker, client, _token_client) = setup();

    let shares = client.stake(&staker, &100_000_000i128);

    let _ = client.total_staked();
    let before = env.events().all().len();
    client.unstake(&staker, &shares);
    let after = env.events().all().len();

    assert!(after > before, "unstake() must emit at least one event");
}

#[test]
fn stake_and_unstake_each_emit_exactly_one_new_event() {
    use soroban_sdk::testutils::Events as _;

    let (env, _admin, staker, client, _token_client) = setup();

    let shares = client.stake(&staker, &100_000_000i128);
    let stake_events = env.events().all().len();

    client.unstake(&staker, &shares);
    let unstake_events = env.events().all().len();

    assert!(stake_events >= 1, "stake() must emit at least one event");
    assert!(
        unstake_events >= 1,
        "unstake() must emit at least one event"
    );
}

// ── Issue #506: emergency pause tests ────────────────────────────────────────

#[test]
fn stake_fails_when_paused() {
    let (_env, _admin, staker, client, _token_client) = setup();

    client.pause();
    assert!(client.is_paused());

    assert_eq!(
        client.try_stake(&staker, &500i128),
        Err(Ok(StakingError::Paused))
    );
}

#[test]
fn unstake_fails_when_paused() {
    let (_env, _admin, staker, client, _token_client) = setup();

    client.stake(&staker, &1_000i128);
    assert_eq!(client.staked_balance(&staker), 1_000i128);

    client.pause();
    assert!(client.is_paused());

    assert_eq!(
        client.try_unstake(&staker, &500i128),
        Err(Ok(StakingError::Paused))
    );

    // Balance unchanged.
    assert_eq!(client.staked_balance(&staker), 1_000i128);
}

#[test]
fn unpause_restores_stake_functionality() {
    let (_env, _admin, staker, client, _token_client) = setup();

    client.pause();
    assert!(client.is_paused());
    assert_eq!(
        client.try_stake(&staker, &500i128),
        Err(Ok(StakingError::Paused))
    );

    client.unpause();
    assert!(!client.is_paused());

    let shares = client.stake(&staker, &500i128);
    assert_eq!(shares, 500i128);
    assert_eq!(client.staked_balance(&staker), 500i128);

    let returned = client.unstake(&staker, &500i128);
    assert_eq!(returned, 500i128);
    assert_eq!(client.staked_balance(&staker), 0i128);
}

#[test]
fn is_paused_returns_false_before_pausing() {
    let (_env, _admin, _staker, client, _token_client) = setup();
    assert!(!client.is_paused());
}

#[test]
fn non_admin_cannot_pause() {
    // Set up a fresh env: mock_auths only for initialize, then try pause with no auth.
    // This avoids the cross-env object-reference pitfall.
    let env = Env::default();
    let contract_id = env.register(StakingContract, ());
    let admin = Address::generate(&env);
    let token_id = Address::generate(&env);

    // Authorize ONLY the initialize call for admin.
    env.mock_auths(&[soroban_sdk::testutils::MockAuth {
        address: &admin,
        invoke: &soroban_sdk::testutils::MockAuthInvoke {
            contract: &contract_id,
            fn_name: "initialize",
            args: soroban_sdk::vec![
                &env,
                admin.clone().into_val(&env),
                token_id.clone().into_val(&env)
            ]
            .into(),
            sub_invokes: &[],
        },
    }]);
    let client = StakingContractClient::new(&env, &contract_id);
    client.initialize(&admin, &token_id);

    // No mock auth remains — admin.require_auth() inside pause() will fail.
    let result = client.try_pause();
    assert!(result.is_err(), "non-admin must not be able to pause");
}

#[test]
fn read_functions_unaffected_by_pause() {
    let (_env, _admin, staker, client, _token_client) = setup();

    client.stake(&staker, &1_000i128);
    client.pause();

    // Read-only calls must succeed regardless of pause state.
    assert!(client.is_paused());
    assert_eq!(client.total_staked(), 1_000i128);
    assert_eq!(client.total_shares(), 1_000i128);
    assert_eq!(client.staked_balance(&staker), 1_000i128);
    assert!(client.get_position(&staker).shares > 0);
}

// ── Issue #518: upgrade timelock test suite (9 cases) ────────────────────────

#[test]
fn timelock_propose_stores_hash_and_executable_after_and_emits_event() {
    use soroban_sdk::testutils::Ledger as _;

    let (env, _admin, _staker, client, _token) = setup();
    let hash = BytesN::from_array(&env, &[0u8; 32]);

    client.propose_upgrade(&hash);

    let pending = client.pending_upgrade().expect("pending must be set");
    assert_eq!(pending.0, hash);
    assert!(
        pending.1 >= env.ledger().timestamp() + TIMELOCK,
        "executable_after must be at least propose_time + 48h"
    );
}

#[test]
fn timelock_execute_before_delay_returns_timelock_not_expired() {
    use soroban_sdk::testutils::Ledger;

    let (env, _admin, _staker, client, _token) = setup();
    let hash = BytesN::from_array(&env, &[0u8; 32]);
    client.propose_upgrade(&hash);
    env.ledger().with_mut(|l| {
        l.timestamp += TIMELOCK - 1;
    });
    assert_eq!(
        client.try_execute_upgrade(&hash),
        Err(Ok(StakingError::TimelockNotExpired))
    );
}

#[test]
fn timelock_execute_exactly_at_boundary_passes_timelock_check() {
    use soroban_sdk::testutils::Ledger;

    let (env, _admin, _staker, client, _token) = setup();
    let hash = BytesN::from_array(&env, &[0u8; 32]);
    let propose_time = env.ledger().timestamp();
    client.propose_upgrade(&hash);
    env.ledger().with_mut(|l| {
        l.timestamp = propose_time + TIMELOCK;
    });
    let result = client.try_execute_upgrade(&hash);
    assert_ne!(
        result,
        Err(Ok(StakingError::TimelockNotExpired)),
        "timelock must allow execution at timestamp == execute_after"
    );
}

#[test]
fn timelock_execute_after_delay_passes_timelock_check() {
    use soroban_sdk::testutils::Ledger;

    let (env, _admin, _staker, client, _token) = setup();
    let hash = BytesN::from_array(&env, &[0u8; 32]);
    let propose_time = env.ledger().timestamp();
    client.propose_upgrade(&hash);
    env.ledger().with_mut(|l| {
        l.timestamp = propose_time + TIMELOCK + 3600;
    });
    let result = client.try_execute_upgrade(&hash);
    assert_ne!(
        result,
        Err(Ok(StakingError::TimelockNotExpired)),
        "timelock must allow execution after the delay"
    );
}

#[test]
fn timelock_cancel_before_execute_clears_pending_and_execute_panics() {
    use soroban_sdk::testutils::Ledger;

    let (env, _admin, _staker, client, _token) = setup();
    let hash = BytesN::from_array(&env, &[0u8; 32]);
    client.propose_upgrade(&hash);
    client.cancel_upgrade();

    assert!(client.pending_upgrade().is_none());

    env.ledger().with_mut(|l| {
        l.timestamp += TIMELOCK + 1;
    });
    assert_eq!(
        client.try_execute_upgrade(&hash),
        Err(Ok(StakingError::NoPendingUpgrade))
    );
}

#[test]
fn timelock_non_admin_propose_panics() {
    let env = Env::default();
    let contract_id = env.register(StakingContract, ());
    let admin = Address::generate(&env);
    let token_id = Address::generate(&env);
    env.mock_all_auths();
    let c = StakingContractClient::new(&env, &contract_id);
    c.initialize(&admin, &token_id);
    // Explicitly clear all mocks so admin.require_auth() is no longer satisfied.
    env.mock_auths(&[]);
    let hash = BytesN::from_array(&env, &[0u8; 32]);
    let result = c.try_propose_upgrade(&hash);
    assert!(result.is_err(), "non-admin propose must fail without auth");
}

#[test]
fn timelock_non_admin_execute_panics() {
    let env = Env::default();
    let contract_id = env.register(StakingContract, ());
    let admin = Address::generate(&env);
    let token_id = Address::generate(&env);
    env.mock_all_auths();
    let c = StakingContractClient::new(&env, &contract_id);
    c.initialize(&admin, &token_id);
    // Explicitly clear all mocks so admin.require_auth() is no longer satisfied.
    env.mock_auths(&[]);
    let hash = BytesN::from_array(&env, &[0u8; 32]);
    let result = c.try_execute_upgrade(&hash);
    assert!(result.is_err(), "non-admin execute must fail without auth");
}

#[test]
fn timelock_double_propose_returns_upgrade_already_pending() {
    let (env, _admin, _staker, client, _token) = setup();
    let hash1 = BytesN::from_array(&env, &[1u8; 32]);
    let hash2 = BytesN::from_array(&env, &[2u8; 32]);

    client.propose_upgrade(&hash1);
    let result = client.try_propose_upgrade(&hash2);
    assert_eq!(result, Err(Ok(StakingError::UpgradeAlreadyPending)));

    let pending = client.pending_upgrade().unwrap();
    assert_eq!(pending.0, hash1);
}

#[test]
fn timelock_execute_with_wrong_hash_returns_hash_mismatch() {
    use soroban_sdk::testutils::Ledger;

    let (env, _admin, _staker, client, _token) = setup();
    let stored_hash = BytesN::from_array(&env, &[0u8; 32]);
    let wrong_hash = BytesN::from_array(&env, &[0xFFu8; 32]);

    let propose_time = env.ledger().timestamp();
    client.propose_upgrade(&stored_hash);
    env.ledger().with_mut(|l| {
        l.timestamp = propose_time + TIMELOCK;
    });

    assert_eq!(
        client.try_execute_upgrade(&wrong_hash),
        Err(Ok(StakingError::HashMismatch))
    );
}

#[test]
fn get_staker_stats_returns_active_staker_snapshot() {
    let (_env, _admin, staker, client, _token_client) = setup();
    client.stake(&staker, &250_000_000i128);

    let stats = client.get_staker_stats(&staker);

    assert_eq!(stats.staked_amount, 250_000_000);
    assert_eq!(stats.pending_rewards, 0);
    assert_eq!(stats.unlock_at, 0);
    assert_eq!(stats.total_claimed_rewards, 0);
    assert_eq!(stats.stake_share_bps, 10_000);
}

#[test]
fn get_staker_stats_returns_zero_for_unknown_staker() {
    let (env, _admin, _staker, client, _token_client) = setup();
    let unknown = Address::generate(&env);

    assert_eq!(
        client.get_staker_stats(&unknown),
        StakerStats {
            staked_amount: 0,
            pending_rewards: 0,
            unlock_at: 0,
            total_claimed_rewards: 0,
            stake_share_bps: 0,
        }
    );
}

#[test]
fn get_staker_stats_reports_even_pool_share() {
    let (env, _admin, first, client, _token_client) = setup();
    let second = Address::generate(&env);
    let token_admin = token::StellarAssetClient::new(&env, &client.token());
    token_admin.mint(&second, &1_000_000_000i128);

    client.stake(&first, &100_000_000i128);
    client.stake(&second, &100_000_000i128);

    assert_eq!(client.get_staker_stats(&first).stake_share_bps, 5_000);
    assert_eq!(client.get_staker_stats(&second).stake_share_bps, 5_000);
}
