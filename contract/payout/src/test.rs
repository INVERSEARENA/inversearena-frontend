#[cfg(test)]
use super::*;
use soroban_sdk::{
    symbol_short,
    testutils::Address as _,
    token::{Client as TokenClient, StellarAssetClient},
    Address, Env,
};

fn setup() -> (Env, Address, PayoutContractClient<'static>) {
    let env = Env::default();
    env.mock_all_auths();

    let contract_id = env.register(PayoutContract, ());
    let client = PayoutContractClient::new(&env, &contract_id);
    let admin = Address::generate(&env);
    client.initialize(&admin);
    let xlm_symbol = symbol_short!("XLM");
    let xlm_token = setup_currency(&env, &admin);
    client.set_currency_token(&xlm_symbol, &xlm_token);
    StellarAssetClient::new(&env, &xlm_token).mint(&client.address, &10_000_000_000i128);

    let env_static: &'static Env = unsafe { &*(&env as *const Env) };
    let client = PayoutContractClient::new(env_static, &contract_id);
    (env, admin, client)
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
    let (env, admin, client) = setup();
    let currency_addr = setup_currency(&env, &admin);
    let token = TokenClient::new(&env, &currency_addr);
    let winner = Address::generate(&env);
    let idempotency_key = 1u32;
    let amount = 1000i128;
    let currency = symbol_short!("XLM");

    assert!(!client.is_payout_processed(&idempotency_key, &winner));
    client.distribute_winnings(&admin, &idempotency_key, &winner, &amount, &currency);
    assert!(client.is_payout_processed(&idempotency_key, &winner));

    let payout = client.get_payout(&idempotency_key, &winner).unwrap();
    assert_eq!(payout.winner, winner);
    assert_eq!(payout.amount, amount);
    assert_eq!(token.balance(&winner), amount);
    assert!(payout.paid);
}

#[test]
fn test_unauthorized_caller_cannot_distribute() {
    let (env, _admin, client) = setup();
    let unauthorized = Address::generate(&env);
    let winner = Address::generate(&env);
    let idempotency_key = 1u32;
    let amount = 1000i128;
    let currency = symbol_short!("XLM");

    let result =
        client.try_distribute_winnings(&unauthorized, &ctx, &pool_id, &round_id, &winner, &amount, &currency);
    assert_eq!(result, Err(Ok(PayoutError::UnauthorizedCaller)));
}

/// Verify that passing the admin address as `caller` without signing
/// the transaction is rejected by `require_auth()`.
#[test]
fn test_admin_spoofing_rejected_without_auth() {
    let env = Env::default();
    // Intentionally do NOT call env.mock_all_auths() — no auth is mocked.
    let contract_id = env.register(PayoutContract, ());
    let client = PayoutContractClient::new(&env, &contract_id);
    let admin = Address::generate(&env);
    client.initialize(&admin);

    let winner = Address::generate(&env);
    let ctx = symbol_short!("arena_1");

    // A spoofed caller passes the real admin address but has not signed.
    // require_auth() must reject this.
    let result = client.try_distribute_winnings(
        &admin, &ctx, &1u32, &1u32, &winner, &1000i128, &symbol_short!("XLM"),
    );
    assert!(result.is_err());
}

#[test]
fn test_zero_amount_panics() {
    let (env, admin, client) = setup();
    let winner = Address::generate(&env);
    let idempotency_key = 1u32;
    let ctx = symbol_short!("arena_1");
    let pool_id = 1u32;
    let round_id = 1u32;
    let amount = 0i128;
    let currency = symbol_short!("XLM");

    let result = client.try_distribute_winnings(&admin, &ctx, &pool_id, &round_id, &winner, &amount, &currency);
    assert_eq!(result, Err(Ok(PayoutError::InvalidAmount)));
}

#[test]
fn test_negative_amount_panics() {
    let (env, admin, client) = setup();
    let winner = Address::generate(&env);
    let idempotency_key = 1u32;
    let ctx = symbol_short!("arena_1");
    let pool_id = 1u32;
    let round_id = 1u32;
    let amount = -500i128;
    let currency = symbol_short!("XLM");

    let result = client.try_distribute_winnings(&admin, &ctx, &pool_id, &round_id, &winner, &amount, &currency);
    assert_eq!(result, Err(Ok(PayoutError::InvalidAmount)));
}

#[test]
fn test_idempotency_prevents_double_pay_same_amount() {
    let (env, admin, client) = setup();
    let winner = Address::generate(&env);
    let idempotency_key = 1u32;
    let amount = 1000i128;
    let currency = symbol_short!("XLM");

    client.distribute_winnings(&admin, &ctx, &pool_id, &round_id, &winner, &amount, &currency);

    let second_attempt =
        client.try_distribute_winnings(&admin, &ctx, &pool_id, &round_id, &winner, &amount, &currency);
    assert_eq!(second_attempt, Err(Ok(PayoutError::AlreadyPaid)));

    // The persisted payout amount must remain unchanged after the failed retry.
    let payout = client.get_payout(&ctx, &pool_id, &round_id, &winner).unwrap();
    assert_eq!(payout.amount, amount);
}

#[test]
fn test_idempotency_prevents_double_pay_different_amount() {
    let (env, admin, client) = setup();
    let winner = Address::generate(&env);
    let ctx = symbol_short!("arena_1");
    let pool_id = 99u32;
    let round_id = 1u32;
    let first_amount = 1000i128;
    let second_amount = 9999i128;
    let currency = symbol_short!("USDC");

    client.distribute_winnings(
        &admin, &ctx, &pool_id, &round_id, &winner, &first_amount, &currency,
    );

    let second_attempt = client.try_distribute_winnings(
        &admin, &ctx, &pool_id, &round_id, &winner, &second_amount, &currency,
    );
    assert_eq!(second_attempt, Err(Ok(PayoutError::AlreadyPaid)));

    // Balance-equivalent assertion: only the original payout record is retained.
    let payout = client.get_payout(&ctx, &pool_id, &round_id, &winner).unwrap();
    assert_eq!(payout.amount, first_amount);
}

#[test]
fn test_different_idempotency_keys_allow_multiple_payouts() {
    let (env, admin, client) = setup();
    let winner = Address::generate(&env);
    let amount = 1000i128;
    let currency = symbol_short!("XLM");

    client.distribute_winnings(&admin, &1u32, &winner, &amount, &currency);
    client.distribute_winnings(&admin, &2u32, &winner, &amount, &currency);

    assert!(client.is_payout_processed(&1u32, &winner));
    assert!(client.is_payout_processed(&2u32, &winner));
}

#[test]
fn test_get_payout_returns_none_for_unprocessed() {
    let env = Env::default();
    env.mock_all_auths();
    let contract_id = env.register(PayoutContract, ());
    let client = PayoutContractClient::new(&env, &contract_id);
    let admin = Address::generate(&env);
    client.initialize(&admin);
    let winner = Address::generate(&env);
    assert!(client.get_payout(&1u32, &winner).is_none());
}

#[test]
fn test_get_payout_returns_data_for_processed() {
    let (env, admin, client) = setup();
    let currency_addr = setup_currency(&env, &admin);
    let winner = Address::generate(&env);
    let idempotency_key = 1u32;
    let amount = 5000i128;
    let currency = symbol_short!("USDC");

    client.distribute_winnings(&admin, &idempotency_key, &winner, &amount, &currency);

    let payout = client.get_payout(&idempotency_key, &winner).unwrap();
    assert_eq!(payout.winner, winner);
    assert_eq!(payout.amount, amount);
    assert_eq!(payout.currency, currency);
    assert!(payout.paid);
}
