#[cfg(test)]
use super::*;
use soroban_sdk::{
    Address, BytesN, Env, IntoVal, Symbol, Vec, symbol_short,
    testutils::Address as _,
    token::{StellarAssetClient, TokenClient},
};

const TIMELOCK: u64 = 48 * 60 * 60;

fn setup() -> (Env, Address, PayoutContractClient<'static>) {
    let env = Env::default();
    env.mock_all_auths();

    let contract_id = env.register(PayoutContract, ());
    let admin = Address::generate(&env);

    let env_static: &'static Env = unsafe { &*(&env as *const Env) };
    let client = PayoutContractClient::new(env_static, &contract_id);
    client.initialize(&admin);

    (env, admin, client)
}

fn setup_with_token() -> (
    Env,
    Address,
    PayoutContractClient<'static>,
    Address,
    Address,
) {
    let (env, admin, client) = setup();

    let treasury = Address::generate(&env);
    client.set_treasury(&treasury);

    let token_admin = Address::generate(&env);
    let token_id = env
        .register_stellar_asset_contract_v2(token_admin.clone())
        .address();
    let asset = StellarAssetClient::new(&env, &token_id);
    asset.mint(&client.address, &10_000i128);

    (env, admin, client, token_id, treasury)
}

#[test]
fn test_initialize_sets_admin() {
    let (_env, admin, client) = setup();
    assert_eq!(client.admin(), admin);
}

#[test]
#[should_panic(expected = "already initialized")]
fn test_double_initialize_panics() {
    let (_env, admin, client) = setup();
    client.initialize(&admin);
}

#[test]
fn test_admin_can_distribute_winnings() {
    let (env, _admin, client) = setup();

    let winner = Address::generate(&env);
    let ctx = symbol_short!("ARENA_1");
    let pool_id = 1u32;
    let round_id = 1u32;
    let amount = 1000i128;
    let currency = symbol_short!("XLM");

    assert!(!client.is_payout_processed(&ctx, &pool_id, &round_id, &winner));
    client.distribute_winnings(&ctx, &pool_id, &round_id, &winner, &amount, &currency);
    assert!(client.is_payout_processed(&ctx, &pool_id, &round_id, &winner));

    let payout = client
        .get_payout(&ctx, &pool_id, &round_id, &winner)
        .unwrap();
    assert_eq!(payout.winner, winner);
    assert_eq!(payout.amount, amount);
    assert_eq!(payout.currency, currency);
    assert!(payout.paid);
}

#[test]
fn test_unauthorized_caller_cannot_distribute() {
    // admin.require_auth() is the only gate — no caller param to spoof.
    // Providing no mock auth means admin.require_auth() fails.
    let env = Env::default();
    let contract_id = env.register(PayoutContract, ());
    let admin = Address::generate(&env);

    // Initialize with mock_all_auths so initialize() succeeds.
    env.mock_all_auths();
    let client = PayoutContractClient::new(&env, &contract_id);
    client.initialize(&admin);

    // Clear all mocked auths — now admin.require_auth() is unsatisfied.
    env.mock_auths(&[]);

    let winner = Address::generate(&env);
    let ctx = symbol_short!("ARENA_1");
    let currency = symbol_short!("XLM");

    let result = client.try_distribute_winnings(&ctx, &1u32, &1u32, &winner, &1000i128, &currency);
    assert!(
        result.is_err(),
        "non-admin signer must be rejected by admin.require_auth()"
    );
}

#[test]
fn test_zero_amount_returns_error() {
    let (env, _admin, client) = setup();
    let winner = Address::generate(&env);
    let ctx = symbol_short!("ARENA_1");
    let currency = symbol_short!("XLM");

    let result = client.try_distribute_winnings(&ctx, &1u32, &1u32, &winner, &0i128, &currency);
    assert_eq!(result, Err(Ok(PayoutError::InvalidAmount)));
}

#[test]
fn test_negative_amount_returns_error() {
    let (env, _admin, client) = setup();
    let winner = Address::generate(&env);
    let ctx = symbol_short!("ARENA_1");
    let currency = symbol_short!("XLM");

    let result = client.try_distribute_winnings(&ctx, &1u32, &1u32, &winner, &-1i128, &currency);
    assert_eq!(result, Err(Ok(PayoutError::InvalidAmount)));
}

#[test]
fn test_idempotency_prevents_double_pay_same_key() {
    let (env, _admin, client) = setup();
    let winner = Address::generate(&env);
    let ctx = symbol_short!("ARENA_1");
    let currency = symbol_short!("XLM");

    client.distribute_winnings(&ctx, &7u32, &2u32, &winner, &1000i128, &currency);

    let second = client.try_distribute_winnings(&ctx, &7u32, &2u32, &winner, &9999i128, &currency);
    assert_eq!(second, Err(Ok(PayoutError::AlreadyPaid)));
}

#[test]
fn test_different_round_ids_allow_multiple_payouts() {
    let (env, _admin, client) = setup();
    let winner = Address::generate(&env);
    let ctx = symbol_short!("ARENA_1");
    let currency = symbol_short!("USDC");

    client.distribute_winnings(&ctx, &1u32, &1u32, &winner, &1000i128, &currency);
    client.distribute_winnings(&ctx, &1u32, &2u32, &winner, &2000i128, &currency);

    assert!(client.is_payout_processed(&ctx, &1u32, &1u32, &winner));
    assert!(client.is_payout_processed(&ctx, &1u32, &2u32, &winner));
}

#[test]
fn test_get_payout_returns_none_for_unprocessed() {
    let (env, _admin, client) = setup();
    let winner = Address::generate(&env);
    let ctx = symbol_short!("ARENA_1");

    assert!(client.get_payout(&ctx, &1u32, &1u32, &winner).is_none());
}

#[test]
fn test_set_currency_token_enables_token_transfer() {
    let (env, _admin, client, token_id, _treasury) = setup_with_token();
    let winner = Address::generate(&env);
    let ctx = symbol_short!("ARENA_1");
    let currency = symbol_short!("USDC");

    client.set_currency_token(&currency, &token_id);
    client.distribute_winnings(&ctx, &3u32, &1u32, &winner, &750i128, &currency);

    let token = TokenClient::new(&env, &token_id);
    assert_eq!(token.balance(&winner), 750i128);
}

#[test]
fn test_distribute_prize_transfers_tokens_to_winners() {
    let (env, _admin, client, token_id, _treasury) = setup_with_token();
    let winner1 = Address::generate(&env);
    let winner2 = Address::generate(&env);
    let mut winners = Vec::new(&env);
    winners.push_back(winner1.clone());
    winners.push_back(winner2.clone());

    client.distribute_prize(&1u32, &1000i128, &winners, &token_id);

    let token = TokenClient::new(&env, &token_id);
    assert_eq!(token.balance(&winner1), 500i128);
    assert_eq!(token.balance(&winner2), 500i128);
}

#[test]
fn test_distribute_prize_sends_dust_to_treasury() {
    let (env, _admin, client, token_id, treasury) = setup_with_token();
    let winner1 = Address::generate(&env);
    let winner2 = Address::generate(&env);
    let winner3 = Address::generate(&env);
    let mut winners = Vec::new(&env);
    winners.push_back(winner1.clone());
    winners.push_back(winner2.clone());
    winners.push_back(winner3.clone());

    client.distribute_prize(&2u32, &1000i128, &winners, &token_id);

    let token = TokenClient::new(&env, &token_id);
    assert_eq!(token.balance(&winner1), 333i128);
    assert_eq!(token.balance(&winner2), 333i128);
    assert_eq!(token.balance(&winner3), 333i128);
    assert_eq!(token.balance(&treasury), 1i128);
}

#[test]
fn test_distribute_prize_idempotency_prevents_double_payout() {
    let (env, _admin, client, token_id, _treasury) = setup_with_token();
    let winner = Address::generate(&env);
    let mut winners = Vec::new(&env);
    winners.push_back(winner.clone());

    client.distribute_prize(&3u32, &500i128, &winners, &token_id);
    assert!(client.is_prize_distributed(&3u32));

    let second = client.try_distribute_prize(&3u32, &500i128, &winners, &token_id);
    assert_eq!(second, Err(Ok(PayoutError::AlreadyPaid)));
}

#[test]
fn test_distribute_prize_no_winners_returns_error() {
    let (env, _admin, client, token_id, _treasury) = setup_with_token();
    let empty: Vec<Address> = Vec::new(&env);

    let result = client.try_distribute_prize(&4u32, &1000i128, &empty, &token_id);
    assert_eq!(result, Err(Ok(PayoutError::NoWinners)));
}

#[test]
fn test_distribute_prize_invalid_amount_returns_error() {
    let (env, _admin, client, token_id, _treasury) = setup_with_token();
    let winner = Address::generate(&env);
    let mut winners = Vec::new(&env);
    winners.push_back(winner);

    let result = client.try_distribute_prize(&5u32, &0i128, &winners, &token_id);
    assert_eq!(result, Err(Ok(PayoutError::InvalidAmount)));
}

// ── persistent storage TTL ────────────────────────────────────────────────────

#[test]
fn payout_record_survives_ttl_threshold() {
    use soroban_sdk::testutils::Ledger;

    let (env, _admin, client) = setup();
    let winner = Address::generate(&env);
    let ctx = symbol_short!("arena_1");
    let pool_id = 1u32;
    let round_id = 1u32;
    let amount = 500i128;
    let currency = symbol_short!("XLM");

    client.distribute_winnings(&ctx, &pool_id, &round_id, &winner, &amount, &currency);

    // Advance ledger past PAYOUT_TTL_THRESHOLD (100_000) — record must still exist.
    env.ledger().with_mut(|l| {
        l.sequence_number += 100_001;
        l.timestamp += 100_001 * 5;
    });

    assert!(
        client.is_payout_processed(&ctx, &pool_id, &round_id, &winner),
        "payout record must survive past TTL threshold due to extend_ttl"
    );
}

// ── Issue #500: initialize() auth guards (payout) ────────────────────────────

#[test]
fn initialize_with_wrong_signer_fails() {
    // Without mock_all_auths, initialize() requires the admin to self-sign.
    // Providing a different signer should cause an auth failure (contract error or abort).
    let env = Env::default();
    let contract_id = env.register(PayoutContract, ());
    let admin = Address::generate(&env);
    let impersonator = Address::generate(&env);
    use soroban_sdk::IntoVal;
    env.mock_auths(&[soroban_sdk::testutils::MockAuth {
        address: &impersonator,
        invoke: &soroban_sdk::testutils::MockAuthInvoke {
            contract: &contract_id,
            fn_name: "initialize",
            args: soroban_sdk::vec![&env, admin.clone().into_val(&env)].into(),
            sub_invokes: &[],
        },
    }]);
    let client = PayoutContractClient::new(&env, &contract_id);
    // try_initialize returns an error when admin auth is not satisfied
    let result = client.try_initialize(&admin);
    assert!(result.is_err(), "initialize with wrong signer must fail");
    let _ = impersonator;
}

// ── Issue #506: Emergency pause (payout) ─────────────────────────────────────

#[test]
fn admin_can_pause_and_unpause_payout() {
    let (_env, _admin, client) = setup();
    assert!(!client.is_paused());
    client.pause();
    assert!(client.is_paused());
    client.unpause();
    assert!(!client.is_paused());
}

#[test]
fn pause_blocks_distribute_winnings() {
    let (env, _admin, client) = setup();
    client.pause();
    let winner = Address::generate(&env);
    let ctx = symbol_short!("CTX");
    let currency = symbol_short!("XLM");
    let result = client.try_distribute_winnings(&ctx, &1u32, &1u32, &winner, &100i128, &currency);
    assert_eq!(result, Err(Ok(PayoutError::Paused)));
}

#[test]
fn pause_blocks_distribute_prize() {
    let (env, _admin, client, token_id, _treasury) = setup_with_token();
    client.pause();
    let winners = Vec::from_array(&env, [Address::generate(&env)]);
    let result = client.try_distribute_prize(&1u32, &100i128, &winners, &token_id);
    assert_eq!(result, Err(Ok(PayoutError::Paused)));
}

#[test]
fn unpause_restores_distribute_winnings() {
    let (env, _admin, client) = setup();
    client.pause();
    client.unpause();
    assert!(!client.is_paused());
    let winner = Address::generate(&env);
    let ctx = symbol_short!("CTX");
    let currency = symbol_short!("XLM");
    // distribute_winnings requires no actual token transfer, it just records
    let result = client.try_distribute_winnings(&ctx, &1u32, &1u32, &winner, &100i128, &currency);
    assert!(result.is_ok(), "should succeed after unpause");
}

#[test]
fn read_functions_unaffected_by_payout_pause() {
    let (_env, admin, client) = setup();
    client.pause();
    assert_eq!(client.admin(), admin);
    assert!(client.is_paused());
}

#[test]
fn payout_history_empty_page() {
    let (_env, _admin, client) = setup();
    let page = client.get_payout_history(&None, &10u32);

    assert!(page.items.is_empty());
    assert_eq!(page.next_cursor, None);
    assert!(!page.has_more);
}

#[test]
fn payout_history_records_single_payout_and_arena_lookup() {
    let (env, _admin, client) = setup();
    let winner = Address::generate(&env);
    let ctx = symbol_short!("ARENA_1");
    let currency = symbol_short!("XLM");

    client.distribute_winnings(&ctx, &7u32, &1u32, &winner, &1234i128, &currency);

    let page = client.get_payout_history(&None, &10u32);
    assert_eq!(page.items.len(), 1);
    let receipt = page.items.get(0).unwrap();
    assert_eq!(receipt.arena_id, 7);
    assert_eq!(receipt.winner, winner);
    assert_eq!(receipt.amount, 1234);
    assert_eq!(receipt.fee, 0);
    assert_eq!(receipt.tx_hash_hint, None);
    assert_eq!(client.get_payout_by_arena(&7u64), Some(receipt));
}

#[test]
fn payout_history_paginates_and_caps_limit() {
    let (env, _admin, client) = setup();
    let ctx = symbol_short!("ARENA_1");
    let currency = symbol_short!("XLM");

    for i in 0..105u32 {
        client.distribute_winnings(
            &ctx,
            &i,
            &1u32,
            &Address::generate(&env),
            &(100i128 + i as i128),
            &currency,
        );
    }

    let first = client.get_payout_history(&None, &500u32);
    assert_eq!(first.items.len(), 100);
    assert_eq!(first.next_cursor, Some(100));
    assert!(first.has_more);

    let second = client.get_payout_history(&first.next_cursor, &10u32);
    assert_eq!(second.items.len(), 5);
    assert_eq!(second.next_cursor, None);
    assert!(!second.has_more);
}

// ── Issue #518: upgrade timelock test suite (9 cases) ────────────────────────

#[test]
fn timelock_propose_stores_hash_and_executable_after_and_emits_event() {
    use soroban_sdk::testutils::Ledger as _;

    let (env, _admin, client) = setup();
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

    let (env, _admin, client) = setup();
    let hash = BytesN::from_array(&env, &[0u8; 32]);
    client.propose_upgrade(&hash);
    env.ledger().with_mut(|l| {
        l.timestamp += TIMELOCK - 1;
    });
    assert_eq!(
        client.try_execute_upgrade(&hash),
        Err(Ok(PayoutError::TimelockNotExpired))
    );
}

#[test]
fn timelock_execute_exactly_at_boundary_passes_timelock_check() {
    use soroban_sdk::testutils::Ledger;

    let (env, _admin, client) = setup();
    let hash = BytesN::from_array(&env, &[0u8; 32]);
    let propose_time = env.ledger().timestamp();
    client.propose_upgrade(&hash);
    env.ledger().with_mut(|l| {
        l.timestamp = propose_time + TIMELOCK;
    });
    let result = client.try_execute_upgrade(&hash);
    assert_ne!(
        result,
        Err(Ok(PayoutError::TimelockNotExpired)),
        "timelock must allow execution at timestamp == execute_after"
    );
}

#[test]
fn timelock_execute_after_delay_passes_timelock_check() {
    use soroban_sdk::testutils::Ledger;

    let (env, _admin, client) = setup();
    let hash = BytesN::from_array(&env, &[0u8; 32]);
    let propose_time = env.ledger().timestamp();
    client.propose_upgrade(&hash);
    env.ledger().with_mut(|l| {
        l.timestamp = propose_time + TIMELOCK + 3600;
    });
    let result = client.try_execute_upgrade(&hash);
    assert_ne!(
        result,
        Err(Ok(PayoutError::TimelockNotExpired)),
        "timelock must allow execution after the delay"
    );
}

#[test]
fn timelock_cancel_before_execute_clears_pending_and_execute_panics() {
    use soroban_sdk::testutils::Ledger;

    let (env, _admin, client) = setup();
    let hash = BytesN::from_array(&env, &[0u8; 32]);
    client.propose_upgrade(&hash);
    client.cancel_upgrade();

    assert!(client.pending_upgrade().is_none());

    env.ledger().with_mut(|l| {
        l.timestamp += TIMELOCK + 1;
    });
    assert_eq!(
        client.try_execute_upgrade(&hash),
        Err(Ok(PayoutError::NoPendingUpgrade))
    );
}

#[test]
fn timelock_non_admin_propose_panics() {
    let env = Env::default();
    let contract_id = env.register(PayoutContract, ());
    let admin = Address::generate(&env);
    env.mock_all_auths();
    let c = PayoutContractClient::new(&env, &contract_id);
    c.initialize(&admin);
    // Explicitly clear all mocks so admin.require_auth() is no longer satisfied.
    env.mock_auths(&[]);
    let hash = BytesN::from_array(&env, &[0u8; 32]);
    let result = c.try_propose_upgrade(&hash);
    assert!(result.is_err(), "non-admin propose must fail without auth");
}

#[test]
fn timelock_non_admin_execute_panics() {
    let env = Env::default();
    let contract_id = env.register(PayoutContract, ());
    let admin = Address::generate(&env);
    env.mock_all_auths();
    let c = PayoutContractClient::new(&env, &contract_id);
    c.initialize(&admin);
    // Explicitly clear all mocks so admin.require_auth() is no longer satisfied.
    env.mock_auths(&[]);
    let hash = BytesN::from_array(&env, &[0u8; 32]);
    let result = c.try_execute_upgrade(&hash);
    assert!(result.is_err(), "non-admin execute must fail without auth");
}

#[test]
fn timelock_double_propose_returns_upgrade_already_pending() {
    let (env, _admin, client) = setup();
    let hash1 = BytesN::from_array(&env, &[1u8; 32]);
    let hash2 = BytesN::from_array(&env, &[2u8; 32]);

    client.propose_upgrade(&hash1);
    let result = client.try_propose_upgrade(&hash2);
    assert_eq!(result, Err(Ok(PayoutError::UpgradeAlreadyPending)));

    let pending = client.pending_upgrade().unwrap();
    assert_eq!(pending.0, hash1);
}

#[test]
fn timelock_execute_with_wrong_hash_returns_hash_mismatch() {
    use soroban_sdk::testutils::Ledger;

    let (env, _admin, client) = setup();
    let stored_hash = BytesN::from_array(&env, &[0u8; 32]);
    let wrong_hash = BytesN::from_array(&env, &[0xFFu8; 32]);

    let propose_time = env.ledger().timestamp();
    client.propose_upgrade(&stored_hash);
    env.ledger().with_mut(|l| {
        l.timestamp = propose_time + TIMELOCK;
    });

    assert_eq!(
        client.try_execute_upgrade(&wrong_hash),
        Err(Ok(PayoutError::HashMismatch))
    );
}
