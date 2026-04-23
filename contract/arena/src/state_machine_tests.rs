#![cfg(test)]

use super::*;
use soroban_sdk::testutils::{Address as _, Ledger as _};
use soroban_sdk::{Address, Env, token};

fn setup_env() -> (Env, ArenaContractClient<'static>) {
    let env = Env::default();
    env.mock_all_auths();
    let contract_id = env.register(ArenaContract, ());
    let env_static: &'static Env = unsafe { &*(&env as *const Env) };
    let client = ArenaContractClient::new(env_static, &contract_id);
    (env, client)
}

#[test]
fn test_initial_state_is_pending() {
    let (env, client) = setup_env();
    let admin = Address::generate(&env);
    client.initialize(&admin);
    let deadline = env.ledger().timestamp() + 7200;
    client.init(&5, &100, &deadline);
    client.init(&5, &100);
    assert_eq!(client.state(), ArenaState::Pending);
}

#[test]
fn test_transition_pending_to_active() {
    let (env, client) = setup_env();
    let admin = Address::generate(&env);
    client.initialize(&admin);
    let token_admin = Address::generate(&env);
    let token_id = env.register_stellar_asset_contract_v2(token_admin).address();
    client.set_token(&token_id);
    let deadline = env.ledger().timestamp() + 7200;
    client.init(&5, &100, &deadline);

    let p1 = Address::generate(&env);
    let p2 = Address::generate(&env);
    let asset = token::StellarAssetClient::new(&env, &token_id);
    asset.mint(&p1, &100);
    asset.mint(&p2, &100);

    client.join(&p1, &100);
    client.join(&p2, &100);

    client.start_round();
    assert_eq!(client.state(), ArenaState::Active);
}

#[test]
#[should_panic(expected = "Invalid state transition")]
fn test_cannot_join_after_active() {
    let (env, client) = setup_env();
    let admin = Address::generate(&env);
    client.initialize(&admin);
    let token_admin = Address::generate(&env);
    let token_id = env.register_stellar_asset_contract_v2(token_admin).address();
    client.set_token(&token_id);
    let deadline = env.ledger().timestamp() + 7200;
    client.init(&5, &100, &deadline);
    client.init(&5, &100);

    let p1 = Address::generate(&env);
    let p2 = Address::generate(&env);
    let asset = token::StellarAssetClient::new(&env, &token_id);
    asset.mint(&p1, &100);
    asset.mint(&p2, &100);

    client.join(&p1, &100);
    client.join(&p2, &100);

    client.start_round();

    let p3 = Address::generate(&env);
    asset.mint(&p3, &100);
    client.join(&p3, &100);
}

#[test]
fn test_transition_active_to_completed() {
    let (env, client) = setup_env();
    let admin = Address::generate(&env);
    client.initialize(&admin);
    let token_admin = Address::generate(&env);
    let token_id = env.register_stellar_asset_contract_v2(token_admin).address();
    client.set_token(&token_id);
    let deadline = env.ledger().timestamp() + 7200;
    client.init(&5, &100, &deadline);

    let p1 = Address::generate(&env);
    let p2 = Address::generate(&env);
    let asset = token::StellarAssetClient::new(&env, &token_id);
    asset.mint(&p1, &100);
    asset.mint(&p2, &100);

    client.join(&p1, &100);
    client.join(&p2, &100);

    client.start_round();
    client.submit_choice(&p1, &1, &Choice::Heads);
    client.submit_choice(&p2, &1, &Choice::Tails);

    let mut ledger = env.ledger().get();
    ledger.sequence_number += 10;
    env.ledger().set(ledger);

    client.resolve_round();
    assert_eq!(client.state(), ArenaState::Completed);
}

#[test]
fn test_transition_pending_to_cancelled() {
    let (env, client) = setup_env();
    let admin = Address::generate(&env);
    client.initialize(&admin);
    let deadline = env.ledger().timestamp() + 7200;
    client.init(&5, &100, &deadline);

    client.cancel_arena();
    assert_eq!(client.state(), ArenaState::Cancelled);
}

#[test]
#[should_panic(expected = "Invalid state transition")]
fn test_cannot_start_after_completed() {
    let (env, client) = setup_env();
    let admin = Address::generate(&env);
    client.initialize(&admin);
    let token_admin = Address::generate(&env);
    let token_id = env.register_stellar_asset_contract_v2(token_admin).address();
    client.set_token(&token_id);
    let deadline = env.ledger().timestamp() + 7200;
    client.init(&5, &100, &deadline);

    let p1 = Address::generate(&env);
    let p2 = Address::generate(&env);
    let asset = token::StellarAssetClient::new(&env, &token_id);
    asset.mint(&p1, &100);
    asset.mint(&p2, &100);

    client.join(&p1, &100);
    client.join(&p2, &100);

    client.start_round();
    client.submit_choice(&p1, &1, &Choice::Heads);
    client.submit_choice(&p2, &1, &Choice::Tails);

    let mut ledger = env.ledger().get();
    ledger.sequence_number += 10;
    env.ledger().set(ledger);

    client.resolve_round();
    assert_eq!(client.state(), ArenaState::Completed);

    client.start_round();
}
