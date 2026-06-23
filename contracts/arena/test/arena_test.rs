#![cfg(test)]

use soroban_sdk::{testutils::Address as _, Address, Env};

use inverse_arena::{InverseArenaContract, InverseArenaContractClient};

fn setup_env() -> (Env, Address, InverseArenaContractClient<'static>) {
    let env = Env::default();
    env.mock_all_auths();
    let contract_id = env.register(InverseArenaContract, ());
    let client = InverseArenaContractClient::new(&env, &contract_id);
    let admin = Address::generate(&env);
    (env, admin, client)
}

#[test]
fn test_initialize() {
    let (env, admin, client) = setup_env();
    let result = client.initialize(&admin, &250u32, &40_000_000i128);
    assert_eq!(result, ());
}

#[test]
#[should_panic(expected = "AlreadyInitialized")]
fn test_double_initialize_fails() {
    let (env, admin, client) = setup_env();
    client.initialize(&admin, &250u32, &40_000_000i128);
    client.initialize(&admin, &250u32, &40_000_000i128); // should panic
}

#[test]
fn test_create_arena() {
    let (env, admin, client) = setup_env();
    client.initialize(&admin, &250u32, &40_000_000i128);

    let creator = Address::generate(&env);
    client.deposit_creator_stake(&creator, &40_000_000i128);

    let arena_id = client.create_arena(
        &creator,
        &10_000_000i128,   // entry fee
        &50u32,            // max players
        &2u32,             // min players
        &60u64,            // round duration
        &(env.ledger().timestamp() + 86400), // start deadline
    );

    assert_eq!(arena_id, 1u64);
    assert_eq!(client.arena_count(), 1u64);
}

#[test]
fn test_join_arena() {
    let (env, admin, client) = setup_env();
    client.initialize(&admin, &250u32, &40_000_000i128);

    let creator = Address::generate(&env);
    client.deposit_creator_stake(&creator, &40_000_000i128);

    let arena_id = client.create_arena(
        &creator,
        &10_000_000i128,
        &50u32,
        &2u32,
        &60u64,
        &(env.ledger().timestamp() + 86400),
    );

    let player = Address::generate(&env);
    client.join_arena(&player, &arena_id);

    let state = client.get_arena_state(&arena_id);
    assert_eq!(state.player_count, 1);
    assert_eq!(state.survivor_count, 1);
}

#[test]
fn test_arena_count_increments() {
    let (env, admin, client) = setup_env();
    client.initialize(&admin, &250u32, &40_000_000i128);

    let creator = Address::generate(&env);
    client.deposit_creator_stake(&creator, &40_000_000i128);

    let deadline = env.ledger().timestamp() + 86400;

    let id1 = client.create_arena(&creator, &10_000_000i128, &50u32, &2u32, &60u64, &deadline);
    let id2 = client.create_arena(&creator, &20_000_000i128, &100u32, &5u32, &120u64, &deadline);

    assert_eq!(id1, 1u64);
    assert_eq!(id2, 2u64);
    assert_eq!(client.arena_count(), 2u64);
}

// TODO: Test submit_choice flow (Issue #XX)
// TODO: Test resolve_round elimination logic (Issue #XX)
// TODO: Test claim_winnings (Issue #XX)
// TODO: Test claim_refund for cancelled arenas (Issue #XX)
// TODO: Test unauthorized access attempts (Issue #XX)
// TODO: Test edge cases (max players, min players, deadline expiry) (Issue #XX)
// TODO: Test creator stake deposit and withdrawal (Issue #XX)
// TODO: Test player profile creation and updates (Issue #XX)
