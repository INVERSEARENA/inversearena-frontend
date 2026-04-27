#![cfg(test)]

use super::*;
use soroban_sdk::{
    Address, Env,
    testutils::{Address as _, Ledger as _},
};

fn setup_arena_env() -> (Env, ArenaContractClient<'static>, Address, Address) {
    let env = Env::default();
    env.mock_all_auths();

    let admin = Address::generate(&env);
    let contract_id = env.register(ArenaContract, (&admin,));
    let client = ArenaContractClient::new(&env, &contract_id);

    let token_admin = Address::generate(&env);
    let token_id = env
        .register_stellar_asset_contract_v2(token_admin.clone())
        .address();

    client.set_token(&token_id);

    // SAFETY: env lives for the duration of the test.
    let env_static: &'static Env = unsafe { &*(&env as *const Env) };
    let client = ArenaContractClient::new(env_static, &contract_id);

    (env, client, admin, token_id)
}

#[test]
fn test_expire_arena_before_deadline_fails() {
    let (env, client, _admin, _token) = setup_arena_env();
    let deadline = env.ledger().timestamp() + 7200; // 2 hours from now
    client.init(&10, &100, &deadline);

    // Try to expire immediately — deadline has not been reached yet
    let result = client.try_expire_arena();
    assert_eq!(result, Err(Ok(ArenaError::DeadlineNotReached)));
}

#[test]
fn test_expire_arena_after_deadline_succeeds_and_refunds() {
    let (env, client, _admin, token_id) = setup_arena_env();
    let deadline = env.ledger().timestamp() + 7200; // 2 hours from now
    client.init(&10, &100, &deadline);

    // Mint tokens and have one player join
    let player = Address::generate(&env);
    let token_client = token::StellarAssetClient::new(&env, &token_id);
    token_client.mint(&player, &200);

    client.join(&player, &100);

    // Advance time past the deadline
    env.ledger().with_mut(|l| {
        l.timestamp = deadline + 1;
    });

    // Expire arena — should succeed and refund the player
    client.expire_arena();

    // Verify arena is now cancelled
    assert_eq!(client.state(), ArenaState::Cancelled);
    assert!(client.is_cancelled());
}

#[test]
#[should_panic]
fn test_expire_arena_on_active_arena_panics() {
    let (env, client, _admin, token_id) = setup_arena_env();
    let deadline = env.ledger().timestamp() + 7200;
    client.init(&10, &100, &deadline);

    // Have two players join and start a round to activate the arena
    let player1 = Address::generate(&env);
    let player2 = Address::generate(&env);
    let token_client = token::StellarAssetClient::new(&env, &token_id);
    token_client.mint(&player1, &200);
    token_client.mint(&player2, &200);

    client.join(&player1, &100);
    client.join(&player2, &100);
    client.start_round(); // transitions state to Active

    // Advance time past deadline
    env.ledger().with_mut(|l| {
        l.timestamp = deadline + 1;
    });

    // expire_arena should panic because state is Active, not Pending
    client.expire_arena();
}

#[test]
fn test_deadline_too_soon_rejected() {
    let (env, client, _admin, _token) = setup_arena_env();
    let now = env.ledger().timestamp();
    // 30 minutes — less than the required minimum of 1 hour (3600 seconds)
    let deadline = now + 1800;
    let result = client.try_init(&10, &100, &deadline);
    assert_eq!(result, Err(Ok(ArenaError::DeadlineTooSoon)));
}

#[test]
fn test_deadline_too_far_rejected() {
    let (env, client, _admin, _token) = setup_arena_env();
    let now = env.ledger().timestamp();
    // 700000 seconds — exceeds the maximum of 604800 (1 week)
    let deadline = now + 700_000;
    let result = client.try_init(&10, &100, &deadline);
    assert_eq!(result, Err(Ok(ArenaError::DeadlineTooFar)));
}

#[test]
fn test_expire_arena_emits_correct_arena_id() {
    use soroban_sdk::testutils::Events as _;

    let (env, client, _admin, token_id) = setup_arena_env();
    let deadline = env.ledger().timestamp() + 7200;
    client.init(&10, &100, &deadline);

    // Store a non-zero arena_id so we can verify it is emitted correctly.
    let expected_arena_id: u64 = 42;
    env.as_contract(&client.address, || {
        env.storage()
            .instance()
            .set(&DataKey::ArenaId, &expected_arena_id);
    });

    // Advance past deadline and expire.
    env.ledger().with_mut(|l| {
        l.timestamp = deadline + 1;
    });
    client.expire_arena();

    // The last event must be ArenaExpired with arena_id == 42, not 0.
    let events = env.events().all();
    let (_contract, topics, data) = events.last().unwrap();
    let topic: soroban_sdk::Symbol = topics.get(0).unwrap().into_val(&env);
    assert_eq!(
        topic,
        soroban_sdk::symbol_short!("A_EXP"),
        "last event topic must be A_EXP"
    );
    let expired: ArenaExpired = data.into_val(&env);
    assert_eq!(
        expired.arena_id, expected_arena_id,
        "ArenaExpired must carry the stored arena_id, not 0"
    );
}
