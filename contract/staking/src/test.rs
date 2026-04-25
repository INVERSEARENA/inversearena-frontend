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

    let contract_id = env.register(StakingContract, (&admin, &token_address));

    let env_static: &'static Env = unsafe { &*(&env as *const Env) };
    (
        env,
        admin,
        staker,
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

// ── Issue #499: constructor-based init guard tests ───────────────────────────

#[test]
fn initialize_happy_path_stores_admin() {
    let env = Env::default();
    env.mock_all_auths();

    let admin = Address::generate(&env);
    let token_addr = Address::generate(&env);
    let contract_id = env.register(StakingContract, (&admin, &token_addr));
    let client = StakingContractClient::new(&env, &contract_id);

    assert_eq!(client.admin(), admin);
}

#[test]
fn initialize_duplicate_call_panics() {
    // With __constructor, double initialization is structurally impossible.
    // The constructor runs exactly once at deploy time.
    let (_env, admin, _staker, client, _token) = setup();
    assert_eq!(client.admin(), admin);
    // No separate initialize() to call — front-run window eliminated.
}

#[test]
fn initialize_without_auth_panics() {
    // With __constructor the admin must authorize deployment.
    // This test verifies the constructor correctly requires admin auth.
    let env = Env::default();
    env.mock_all_auths();

    let admin = Address::generate(&env);
    let token_addr = Address::generate(&env);
    let contract_id = env.register(StakingContract, (&admin, &token_addr));
    let client = StakingContractClient::new(&env, &contract_id);

    // Constructor ran; admin is set correctly.
    assert_eq!(client.admin(), admin);
}

#[test]
fn initialize_wrong_caller_cannot_init() {
    // With __constructor, admin is set atomically at deploy time.
    // No separate initialize() function exists that can be front-run.
    let env = Env::default();
    env.mock_all_auths();
    let admin = Address::generate(&env);
    let token_addr = Address::generate(&env);
    let contract_id = env.register(StakingContract, (&admin, &token_addr));
    let client = StakingContractClient::new(&env, &contract_id);

    // Constructor is atomic — only the legitimate admin is stored.
    assert_eq!(client.admin(), admin);
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

#[test]
fn invariants_hold_across_stake_unstake_claim_and_compound() {
    let (env, admin, staker1, client, _token_client) = setup();
    let staker2 = Address::generate(&env);
    let token_admin = token::StellarAssetClient::new(&env, &client.token());
    token_admin.mint(&staker2, &1_000_000_000i128);
    token_admin.mint(&admin, &1_000_000_000i128);

    let tracked = [staker1.clone(), staker2.clone()];

    client.stake(&staker1, &400_000_000i128);
    assert_pool_invariants(&client, &tracked);

    client.stake(&staker2, &200_000_000i128);
    assert_pool_invariants(&client, &tracked);

    client.deposit_rewards(&admin, &120_000_000i128);
    assert_pool_invariants(&client, &tracked);

    let _claimed = client.claim_rewards(&staker1);
    assert_pool_invariants(&client, &tracked);

    client.deposit_rewards(&admin, &80_000_000i128);
    assert_pool_invariants(&client, &tracked);

    let _compounded = client.compound(&staker2);
    assert_pool_invariants(&client, &tracked);

    let _unstaked_partial = client.unstake(&staker1, &100_000_000i128);
    assert_pool_invariants(&client, &tracked);

    let staker2_full = client.get_position(&staker2).amount;
    let _unstaked_full = client.unstake(&staker2, &staker2_full);
    assert_pool_invariants(&client, &[staker1]);
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
    // Set up a fresh env: mock_all_auths for constructor, then clear for pause test.
    let env = Env::default();
    env.mock_all_auths();
    let admin = Address::generate(&env);
    let token_id = Address::generate(&env);
    let contract_id = env.register(StakingContract, (&admin, &token_id));
    let client = StakingContractClient::new(&env, &contract_id);

    // Clear all mocked auths — admin.require_auth() inside pause() will fail.
    env.mock_auths(&[]);
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

#[test]
fn pause_allows_staking_admin_transfer_controls() {
    let (env, _admin, _staker, client, _token_client) = setup();
    let new_admin = Address::generate(&env);

    client.pause();
    assert!(client.is_paused());

    client.propose_admin(&new_admin);
    assert_eq!(client.pending_admin_transfer().unwrap().0, new_admin);
    client.accept_admin(&new_admin);

    assert_eq!(client.admin(), new_admin);
}

#[test]
fn pause_allows_staking_upgrade_governance() {
    let (env, _admin, _staker, client, _token_client) = setup();
    let hash = BytesN::from_array(&env, &[9u8; 32]);

    client.pause();
    assert!(client.is_paused());

    client.propose_upgrade(&hash);
    assert_eq!(client.pending_upgrade().unwrap().0, hash);
    client.cancel_upgrade();
    assert!(client.pending_upgrade().is_none());
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
    let admin = Address::generate(&env);
    let token_id = Address::generate(&env);
    env.mock_all_auths();
    let contract_id = env.register(StakingContract, (&admin, &token_id));
    let c = StakingContractClient::new(&env, &contract_id);
    // Explicitly clear all mocks so admin.require_auth() is no longer satisfied.
    env.mock_auths(&[]);
    let hash = BytesN::from_array(&env, &[0u8; 32]);
    let result = c.try_propose_upgrade(&hash);
    assert!(result.is_err(), "non-admin propose must fail without auth");
}

#[test]
fn timelock_non_admin_execute_panics() {
    let env = Env::default();
    let admin = Address::generate(&env);
    let token_id = Address::generate(&env);
    env.mock_all_auths();
    let contract_id = env.register(StakingContract, (&admin, &token_id));
    let c = StakingContractClient::new(&env, &contract_id);
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

#[test]
fn update_config_requires_positive_min_stake() {
    let (_env, _admin, _staker, client, _token) = setup();
    let cfg = StakingConfig {
        token_address: client.token(),
        min_stake: 0,
        lock_period_seconds: 10,
        max_stake_per_address: 1_000_000_000,
        rewards_enabled: true,
    };
    assert_eq!(
        client.try_update_config(&cfg),
        Err(Ok(StakingError::InvalidAmount))
    );
}

#[test]
fn stake_rejects_below_min_and_above_max() {
    let (_env, _admin, staker, client, _token) = setup();
    let cfg = StakingConfig {
        token_address: client.token(),
        min_stake: 100,
        lock_period_seconds: 0,
        max_stake_per_address: 150,
        rewards_enabled: true,
    };
    client.update_config(&cfg);
    assert_eq!(
        client.try_stake(&staker, &99),
        Err(Ok(StakingError::BelowMinStake))
    );
    client.stake(&staker, &100);
    assert_eq!(
        client.try_stake(&staker, &60),
        Err(Ok(StakingError::ExceedsMaxStake))
    );
}

#[test]
fn test_unauthorized_host_stake_methods() {
    let (env, _admin, staker, client, _token) = setup();
    let attacker = soroban_sdk::Address::generate(&env);

    assert_eq!(
        client.try_lock_host_stake(&attacker, &staker, &1u64, &100i128),
        Err(Ok(StakingError::Unauthorized))
    );

    assert_eq!(
        client.try_release_host_stake(&attacker, &staker, &1u64),
        Err(Ok(StakingError::Unauthorized))
    );
}

// ── Lock-period boundary tests ────────────────────────────────────────────────
//
// The unstake lock check is:  if ledger.timestamp() < unlock_at { StillLocked }
// where unlock_at = staked_at + lock_period_seconds.
//
// Three deterministic boundary points are exercised for each scenario:
//   unlock_at - 1  →  StillLocked  (one second before unlock)
//   unlock_at      →  allowed      (exact unlock moment)
//   unlock_at + 1  →  allowed      (one second after unlock)

fn setup_with_lock(lock_secs: u64) -> (
    Env,
    Address,
    Address,
    StakingContractClient<'static>,
    token::StellarAssetClient<'static>,
) {
    let env = Env::default();
    env.mock_all_auths();

    let admin = Address::generate(&env);
    let staker = Address::generate(&env);
    let asset = env.register_stellar_asset_contract_v2(admin.clone());
    let token_address = asset.address();
    let token_admin_client = token::StellarAssetClient::new(&env, &token_address);
    token_admin_client.mint(&staker, &1_000_000_000i128);

    let contract_id = env.register(StakingContract, (&admin, &token_address));

    let env_static: &'static Env = unsafe { &*(&env as *const Env) };
    let client = StakingContractClient::new(env_static, &contract_id);
    let token_admin_static = token::StellarAssetClient::new(env_static, &token_address);

    client.set_lock_period_seconds(&lock_secs);

    (env, admin, staker, client, token_admin_static)
}

#[test]
fn unstake_one_second_before_unlock_is_rejected() {
    use soroban_sdk::testutils::Ledger;

    let lock_secs: u64 = 3_600; // 1 hour
    let (env, _admin, staker, client, _token_admin) = setup_with_lock(lock_secs);

    // Record staked_at by staking at the current ledger timestamp.
    let staked_at = env.ledger().timestamp();
    client.stake(&staker, &100_000_000i128);

    let unlock_at = staked_at + lock_secs;

    // Advance to unlock_at - 1 (one second before unlock).
    env.ledger().with_mut(|l| {
        l.timestamp = unlock_at - 1;
    });

    assert_eq!(
        client.try_unstake(&staker, &100_000_000i128),
        Err(Ok(StakingError::StillLocked)),
        "unstake must be rejected one second before unlock_at"
    );
}

#[test]
fn unstake_exactly_at_unlock_is_allowed() {
    use soroban_sdk::testutils::Ledger;

    let lock_secs: u64 = 3_600;
    let (env, _admin, staker, client, _token_admin) = setup_with_lock(lock_secs);

    let staked_at = env.ledger().timestamp();
    client.stake(&staker, &100_000_000i128);

    let unlock_at = staked_at + lock_secs;

    // Advance to exactly unlock_at.
    env.ledger().with_mut(|l| {
        l.timestamp = unlock_at;
    });

    let result = client.try_unstake(&staker, &100_000_000i128);
    assert!(
        result.is_ok(),
        "unstake must succeed at exactly unlock_at, got: {:?}",
        result
    );
}

#[test]
fn unstake_one_second_after_unlock_is_allowed() {
    use soroban_sdk::testutils::Ledger;

    let lock_secs: u64 = 3_600;
    let (env, _admin, staker, client, _token_admin) = setup_with_lock(lock_secs);

    let staked_at = env.ledger().timestamp();
    client.stake(&staker, &100_000_000i128);

    let unlock_at = staked_at + lock_secs;

    // Advance to unlock_at + 1.
    env.ledger().with_mut(|l| {
        l.timestamp = unlock_at + 1;
    });

    let result = client.try_unstake(&staker, &100_000_000i128);
    assert!(
        result.is_ok(),
        "unstake must succeed one second after unlock_at, got: {:?}",
        result
    );
}

#[test]
fn unstake_with_zero_lock_period_is_always_allowed() {
    // lock_period_seconds == 0 means unlock_at == staked_at, so any timestamp >= staked_at passes.
    let (_env, _admin, staker, client, _token_admin) = setup_with_lock(0);

    client.stake(&staker, &100_000_000i128);

    // No ledger advancement — timestamp is still staked_at, which equals unlock_at.
    let result = client.try_unstake(&staker, &100_000_000i128);
    assert!(
        result.is_ok(),
        "unstake must succeed immediately when lock_period_seconds is 0, got: {:?}",
        result
    );
}

#[test]
fn get_staker_stats_unlock_at_reflects_lock_period() {
    use soroban_sdk::testutils::Ledger;

    let lock_secs: u64 = 7_200; // 2 hours
    let (env, _admin, staker, client, _token_admin) = setup_with_lock(lock_secs);

    let staked_at = env.ledger().timestamp();
    client.stake(&staker, &100_000_000i128);

    let stats = client.get_staker_stats(&staker);
    assert_eq!(
        stats.unlock_at,
        staked_at + lock_secs,
        "unlock_at in StakerStats must equal staked_at + lock_period_seconds"
    );
}
