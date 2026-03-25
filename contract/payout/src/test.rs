#[cfg(test)]
use super::*;
use soroban_sdk::{symbol_short, testutils::Address as _, Address, Env};

fn setup() -> (Env, Address, PayoutContractClient<'static>) {
    let env = Env::default();
    env.mock_all_auths();

    let contract_id = env.register(PayoutContract, ());
    let client = PayoutContractClient::new(&env, &contract_id);
    let admin = Address::generate(&env);
    client.initialize(&admin);

    let env_static: &'static Env = unsafe { &*(&env as *const Env) };
    let client = PayoutContractClient::new(env_static, &contract_id);
    (env, admin, client)
}

// ── initialize ────────────────────────────────────────────────────────────────

#[test]
fn test_initialize_sets_admin() {
    let (_env, admin, client) = setup();
    assert_eq!(client.admin(), admin);
}

#[test]
fn test_double_initialize_returns_already_initialized() {
    let (_env, admin, client) = setup();
    let result = client.try_initialize(&admin);
    assert_eq!(result, Err(Ok(PayoutError::AlreadyInitialized)));
}

// ── distribute_winnings ───────────────────────────────────────────────────────

#[test]
fn test_admin_can_distribute_winnings() {
    let (env, admin, client) = setup();
    let winner = Address::generate(&env);
    let ctx = symbol_short!("arena_1");
    let idempotency_key = 1u32;
    let amount = 1000i128;
    let currency = symbol_short!("XLM");

    assert!(!client.is_payout_processed(&ctx, &idempotency_key, &winner));
    client.distribute_winnings(&admin, &ctx, &idempotency_key, &winner, &amount, &currency);
    assert!(client.is_payout_processed(&ctx, &idempotency_key, &winner));

    let payout = client.get_payout(&ctx, &idempotency_key, &winner).unwrap();
    assert_eq!(payout.winner, winner);
    assert_eq!(payout.amount, amount);
    assert!(payout.paid);
}

#[test]
fn test_unauthorized_caller_returns_unauthorized() {
    let (env, _admin, client) = setup();
    let unauthorized = Address::generate(&env);
    let winner = Address::generate(&env);
    let ctx = symbol_short!("arena_1");
    let idempotency_key = 1u32;
    let amount = 1000i128;
    let currency = symbol_short!("XLM");

    let result = client.try_distribute_winnings(
        &unauthorized,
        &ctx,
        &idempotency_key,
        &winner,
        &amount,
        &currency,
    );
    assert_eq!(result, Err(Ok(PayoutError::Unauthorized)));
}

#[test]
fn test_zero_amount_returns_invalid_amount() {
    let (env, admin, client) = setup();
    let winner = Address::generate(&env);
    let ctx = symbol_short!("arena_1");
    let idempotency_key = 1u32;
    let currency = symbol_short!("XLM");

    let result =
        client.try_distribute_winnings(&admin, &ctx, &idempotency_key, &winner, &0, &currency);
    assert_eq!(result, Err(Ok(PayoutError::InvalidAmount)));
}

#[test]
fn test_negative_amount_returns_invalid_amount() {
    let (env, admin, client) = setup();
    let winner = Address::generate(&env);
    let ctx = symbol_short!("arena_1");
    let idempotency_key = 1u32;
    let currency = symbol_short!("XLM");

    let result =
        client.try_distribute_winnings(&admin, &ctx, &idempotency_key, &winner, &-100, &currency);
    assert_eq!(result, Err(Ok(PayoutError::InvalidAmount)));
}

#[test]
fn test_idempotency_prevents_double_pay_returns_already_processed() {
    let (env, admin, client) = setup();
    let winner = Address::generate(&env);
    let ctx = symbol_short!("arena_1");
    let idempotency_key = 1u32;
    let amount = 1000i128;
    let currency = symbol_short!("XLM");

    client.distribute_winnings(&admin, &ctx, &idempotency_key, &winner, &amount, &currency);
    let result =
        client.try_distribute_winnings(&admin, &ctx, &idempotency_key, &winner, &amount, &currency);
    assert_eq!(result, Err(Ok(PayoutError::AlreadyProcessed)));
}

#[test]
fn test_distribute_winnings_when_not_initialized_returns_not_initialized() {
    let env = Env::default();
    env.mock_all_auths();
    let contract_id = env.register(PayoutContract, ());
    let client = PayoutContractClient::new(&env, &contract_id);
    let caller = Address::generate(&env);
    let winner = Address::generate(&env);
    let ctx = symbol_short!("arena_1");
    let currency = symbol_short!("XLM");

    let result = client.try_distribute_winnings(&caller, &ctx, &1u32, &winner, &100, &currency);
    assert_eq!(result, Err(Ok(PayoutError::NotInitialized)));
}

#[test]
fn test_different_idempotency_keys_allow_multiple_payouts() {
    let (env, admin, client) = setup();
    let winner = Address::generate(&env);
    let ctx = symbol_short!("arena_1");
    let amount = 1000i128;
    let currency = symbol_short!("XLM");

    client.distribute_winnings(&admin, &ctx, &1u32, &winner, &amount, &currency);
    client.distribute_winnings(&admin, &ctx, &2u32, &winner, &amount, &currency);

    assert!(client.is_payout_processed(&ctx, &1u32, &winner));
    assert!(client.is_payout_processed(&ctx, &2u32, &winner));
}

// ── get_payout ────────────────────────────────────────────────────────────────

#[test]
fn test_get_payout_returns_none_for_unprocessed() {
    let env = Env::default();
    let contract_id = env.register(PayoutContract, ());
    let client = PayoutContractClient::new(&env, &contract_id);
    let admin = Address::generate(&env);
    client.initialize(&admin);
    let winner = Address::generate(&env);
    let ctx = symbol_short!("arena_1");
    assert!(client.get_payout(&ctx, &1u32, &winner).is_none());
}

#[test]
fn test_get_payout_returns_data_for_processed() {
    let (env, admin, client) = setup();
    let winner = Address::generate(&env);
    let ctx = symbol_short!("arena_1");
    let idempotency_key = 1u32;
    let amount = 5000i128;
    let currency = symbol_short!("USDC");

    client.distribute_winnings(&admin, &ctx, &idempotency_key, &winner, &amount, &currency);

    let payout = client.get_payout(&ctx, &idempotency_key, &winner).unwrap();
    assert_eq!(payout.winner, winner);
    assert_eq!(payout.amount, amount);
    assert_eq!(payout.currency, currency);
    assert!(payout.paid);
}

// ── admin view ────────────────────────────────────────────────────────────────

#[test]
fn test_admin_returns_not_initialized_when_unset() {
    let env = Env::default();
    let contract_id = env.register(PayoutContract, ());
    let client = PayoutContractClient::new(&env, &contract_id);
    let result = client.try_admin();
    assert_eq!(result, Err(Ok(PayoutError::NotInitialized)));
}

// ── Cross-context collision tests ────────────────────────────────────────────

/// Same idempotency key + winner in different contexts must not collide.
#[test]
fn test_same_key_different_context_no_collision() {
    let (env, admin, client) = setup();
    let winner = Address::generate(&env);
    let key = 42u32;
    let amount = 1000i128;
    let currency = symbol_short!("XLM");

    let ctx_a = symbol_short!("arena_1");
    let ctx_b = symbol_short!("arena_2");

    // Pay in context A
    client.distribute_winnings(&admin, &ctx_a, &key, &winner, &amount, &currency);
    assert!(client.is_payout_processed(&ctx_a, &key, &winner));
    // Context B must NOT be marked as processed
    assert!(!client.is_payout_processed(&ctx_b, &key, &winner));

    // Pay in context B with the same key -- must succeed (not AlreadyProcessed)
    client.distribute_winnings(&admin, &ctx_b, &key, &winner, &amount, &currency);
    assert!(client.is_payout_processed(&ctx_b, &key, &winner));
}

/// Same context + key but different winner must not collide.
#[test]
fn test_same_context_key_different_winner_no_collision() {
    let (env, admin, client) = setup();
    let winner_a = Address::generate(&env);
    let winner_b = Address::generate(&env);
    let ctx = symbol_short!("arena_1");
    let key = 1u32;
    let amount = 500i128;
    let currency = symbol_short!("XLM");

    client.distribute_winnings(&admin, &ctx, &key, &winner_a, &amount, &currency);
    assert!(client.is_payout_processed(&ctx, &key, &winner_a));
    assert!(!client.is_payout_processed(&ctx, &key, &winner_b));

    // Must succeed for winner_b
    client.distribute_winnings(&admin, &ctx, &key, &winner_b, &amount, &currency);
    assert!(client.is_payout_processed(&ctx, &key, &winner_b));
}

/// Duplicate within the same context must still be rejected.
#[test]
fn test_duplicate_within_same_context_rejected() {
    let (env, admin, client) = setup();
    let winner = Address::generate(&env);
    let ctx = symbol_short!("arena_1");
    let key = 1u32;
    let amount = 1000i128;
    let currency = symbol_short!("XLM");

    client.distribute_winnings(&admin, &ctx, &key, &winner, &amount, &currency);
    let result =
        client.try_distribute_winnings(&admin, &ctx, &key, &winner, &amount, &currency);
    assert_eq!(result, Err(Ok(PayoutError::AlreadyProcessed)));
}
