//! Unit and integration tests for the RWA adapter contract.
//!
//! Covers:
//! * Successful initialisation with a configurable `rate_bps`.
//! * `set_rate` — admin can update the rate; non-admin is rejected.
//! * `balance_of` — yield calculation uses the stored rate, not a constant.
//! * `withdraw_all` — returns the correct accrued balance using the stored rate.
//! * Rate-change round-trip: updating rate changes future `balance_of` results.

#![cfg(test)]

extern crate std;

use soroban_sdk::{Env, testutils::Address as _};

use crate::{RwaAdapterContract, RwaAdapterContractClient, RwaError};

// ── Helper ────────────────────────────────────────────────────────────────────

/// Deploy the adapter and return `(env, client, admin, oracle, token)`.
fn setup() -> (
    Env,
    RwaAdapterContractClient<'static>,
    soroban_sdk::Address,
    soroban_sdk::Address,
    soroban_sdk::Address,
) {
    let env = Env::default();
    env.mock_all_auths();

    let contract_id = env.register(RwaAdapterContract, ());
    let client = RwaAdapterContractClient::new(&env, &contract_id);

    let admin = soroban_sdk::Address::generate(&env);
    let oracle = soroban_sdk::Address::generate(&env);
    let token = soroban_sdk::Address::generate(&env);

    (env, client, admin, oracle, token)
}

// ── Initialisation ────────────────────────────────────────────────────────────

#[test]
fn test_initialize_stores_rate() {
    let (_, client, admin, oracle, token) = setup();

    client.initialize(&admin, &oracle, &token, &500u32);

    assert_eq!(client.get_rate(), 500u32);
    let config = client.get_config();
    assert_eq!(config.rate_bps, 500u32);
    assert_eq!(config.admin, admin);
}

#[test]
fn test_initialize_rejects_duplicate() {
    let (_, client, admin, oracle, token) = setup();

    client.initialize(&admin, &oracle, &token, &500u32);

    let result = client.try_initialize(&admin, &oracle, &token, &500u32);
    assert_eq!(result, Err(Ok(RwaError::AlreadyInitialized)));
}

#[test]
fn test_initialize_rejects_rate_too_high() {
    let (_, client, admin, oracle, token) = setup();

    let result = client.try_initialize(&admin, &oracle, &token, &10_001u32);
    assert_eq!(result, Err(Ok(RwaError::RateTooHigh)));
}

#[test]
fn test_initialize_accepts_max_rate() {
    let (_, client, admin, oracle, token) = setup();

    // 10 000 bps (100 % APY) is the ceiling — should succeed.
    client.initialize(&admin, &oracle, &token, &10_000u32);
    assert_eq!(client.get_rate(), 10_000u32);
}

// ── set_rate ──────────────────────────────────────────────────────────────────

#[test]
fn test_set_rate_updates_config() {
    let (_, client, admin, oracle, token) = setup();
    client.initialize(&admin, &oracle, &token, &500u32);

    client.set_rate(&750u32);

    assert_eq!(client.get_rate(), 750u32);
}

#[test]
fn test_set_rate_rejects_rate_too_high() {
    let (_, client, admin, oracle, token) = setup();
    client.initialize(&admin, &oracle, &token, &500u32);

    let result = client.try_set_rate(&10_001u32);
    assert_eq!(result, Err(Ok(RwaError::RateTooHigh)));
    // Confirm original rate is unchanged.
    assert_eq!(client.get_rate(), 500u32);
}

#[test]
fn test_set_rate_to_zero_is_allowed() {
    // 0 bps = no yield; valid edge case.
    let (_, client, admin, oracle, token) = setup();
    client.initialize(&admin, &oracle, &token, &500u32);

    client.set_rate(&0u32);
    assert_eq!(client.get_rate(), 0u32);
}

#[test]
fn test_set_rate_before_initialize_fails() {
    let (_, client, _, _, _) = setup();

    let result = client.try_set_rate(&500u32);
    assert_eq!(result, Err(Ok(RwaError::NotInitialized)));
}

// ── balance_of ────────────────────────────────────────────────────────────────

#[test]
fn test_balance_of_uses_stored_rate() {
    let (_, client, admin, oracle, token) = setup();
    // Initialize with 500 bps (5 % APY).
    client.initialize(&admin, &oracle, &token, &500u32);

    let principal: i128 = 10_000;
    let days: u32 = 365;

    // Expected: 10_000 + (10_000 × 500 × 365) / (10_000 × 365) = 10_000 + 500 = 10_500
    let expected: i128 = 10_500;
    assert_eq!(client.balance_of(&principal, &days), expected);
}

#[test]
fn test_balance_of_reflects_rate_change() {
    let (_, client, admin, oracle, token) = setup();
    client.initialize(&admin, &oracle, &token, &500u32);

    let principal: i128 = 10_000;
    let days: u32 = 365;

    let before = client.balance_of(&principal, &days);

    // Update to 1 000 bps (10 % APY).
    client.set_rate(&1_000u32);
    let after = client.balance_of(&principal, &days);

    // after = 10_000 + (10_000 × 1_000 × 365) / (10_000 × 365) = 10_000 + 1_000 = 11_000
    assert_eq!(before, 10_500i128);
    assert_eq!(after, 11_000i128);
    assert!(after > before, "higher rate should produce higher balance");
}

#[test]
fn test_balance_of_zero_rate_returns_principal() {
    let (_, client, admin, oracle, token) = setup();
    client.initialize(&admin, &oracle, &token, &0u32);

    let principal: i128 = 10_000;
    // With 0 bps yield, balance should equal principal.
    assert_eq!(client.balance_of(&principal, &365u32), principal);
}

#[test]
fn test_balance_of_zero_days_returns_principal() {
    let (_, client, admin, oracle, token) = setup();
    client.initialize(&admin, &oracle, &token, &500u32);

    let principal: i128 = 10_000;
    // Zero elapsed days → no yield accrued yet.
    assert_eq!(client.balance_of(&principal, &0u32), principal);
}

#[test]
fn test_balance_of_rejects_non_positive_principal() {
    let (_, client, admin, oracle, token) = setup();
    client.initialize(&admin, &oracle, &token, &500u32);

    assert_eq!(
        client.try_balance_of(&0i128, &365u32),
        Err(Ok(RwaError::InvalidAmount))
    );
    assert_eq!(
        client.try_balance_of(&(-1i128), &365u32),
        Err(Ok(RwaError::InvalidAmount))
    );
}

#[test]
fn test_balance_of_not_initialized() {
    let (_, client, _, _, _) = setup();
    assert_eq!(
        client.try_balance_of(&1_000i128, &30u32),
        Err(Ok(RwaError::NotInitialized))
    );
}

// ── withdraw_all ──────────────────────────────────────────────────────────────

#[test]
fn test_withdraw_all_uses_stored_rate() {
    let (env, client, admin, oracle, token) = setup();
    client.initialize(&admin, &oracle, &token, &500u32);

    let caller = soroban_sdk::Address::generate(&env);
    let principal: i128 = 10_000;
    let days: u32 = 365;

    // Expected total = principal + accrued = 10_000 + 500 = 10_500
    let total = client.withdraw_all(&caller, &principal, &days);
    assert_eq!(total, 10_500i128);
}

#[test]
fn test_withdraw_all_reflects_rate_change() {
    let (env, client, admin, oracle, token) = setup();
    client.initialize(&admin, &oracle, &token, &500u32);

    // Change rate to 1 000 bps before the withdrawal.
    client.set_rate(&1_000u32);

    let caller = soroban_sdk::Address::generate(&env);
    // Expected total = 10_000 + 1_000 = 11_000
    let total = client.withdraw_all(&caller, &10_000i128, &365u32);
    assert_eq!(total, 11_000i128);
}

#[test]
fn test_withdraw_all_rejects_non_positive_principal() {
    let (env, client, admin, oracle, token) = setup();
    client.initialize(&admin, &oracle, &token, &500u32);

    let caller = soroban_sdk::Address::generate(&env);

    assert_eq!(
        client.try_withdraw_all(&caller, &0i128, &365u32),
        Err(Ok(RwaError::InvalidAmount))
    );
    assert_eq!(
        client.try_withdraw_all(&caller, &(-100i128), &365u32),
        Err(Ok(RwaError::InvalidAmount))
    );
}

#[test]
fn test_withdraw_all_not_initialized() {
    let (env, client, _, _, _) = setup();
    let caller = soroban_sdk::Address::generate(&env);

    assert_eq!(
        client.try_withdraw_all(&caller, &1_000i128, &30u32),
        Err(Ok(RwaError::NotInitialized))
    );
}

// ── Rate-change round-trip ────────────────────────────────────────────────────

#[test]
fn test_rate_change_round_trip() {
    let (env, client, admin, oracle, token) = setup();
    client.initialize(&admin, &oracle, &token, &500u32);

    let caller = soroban_sdk::Address::generate(&env);
    let principal: i128 = 36_500; // chosen so accrued is a round number per day
    let days: u32 = 365;

    // At 500 bps: accrued = 36_500 × 500 × 365 / (10_000 × 365) = 36_500 × 500 / 10_000 = 1_825
    let total_500 = client.withdraw_all(&caller, &principal, &days);

    // Update rate to 1_000 bps (double).
    client.set_rate(&1_000u32);

    // At 1_000 bps: accrued = 36_500 × 1_000 / 10_000 = 3_650
    let total_1000 = client.withdraw_all(&caller, &principal, &days);

    assert_eq!(total_1000 - total_500, 1_825i128); // doubled accrual
    assert_eq!(total_1000, 40_150i128);
}
