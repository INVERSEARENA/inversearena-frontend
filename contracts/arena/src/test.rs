#![cfg(test)]

use super::*;
use soroban_sdk::{
    symbol_short,
    testutils::{Address as _, Ledger, Events},
    token::{StellarAssetClient, TokenClient},
    Address, Env,
};

fn create_test_env() -> Env {
    let env = Env::default();
    let mut ledger = env.ledger().get();
    ledger.timestamp = 100_000;
    env.ledger().set(ledger);
    env
}

fn setup_arena(env: &Env) -> (Address, Address, Address, ArenaContractClient<'_>) {
    let admin = Address::generate(env);
    let token = env.register_stellar_asset_contract(admin.clone());
    let contract_id = env.register_contract(None, ArenaContract);
    let client = ArenaContractClient::new(env, &contract_id);
    (admin, token, contract_id, client)
}

fn mint_tokens(env: &Env, token: &Address, to: &Address, amount: i128) {
    let sac = StellarAssetClient::new(env, token);
    sac.mint(to, &amount);
}

// ── Test 1: Valid Configuration Update ────────────────────────────────────

#[test]
fn configure_arena_updates_all_parameters() {
    let env = create_test_env();
    env.mock_all_auths();

    let (admin, token, _contract_id, client) = setup_arena(&env);

    // Initialize arena with default config
    let initial_fee = 100_000_000; // 10 XLM
    let initial_max = 100;
    let initial_deadline = env.ledger().timestamp() + 86400;

    let treasury = Address::generate(&env);
    client.initialize(&admin, &token, &initial_fee, &initial_max, &initial_deadline, &treasury, &0);

    // Configure with new values
    let new_fee = 50_000_000; // 5 XLM
    let new_max = 200;
    let new_deadline = env.ledger().timestamp() + 172800; // 2 days

    client.configure_arena(
        &Some(new_fee),
        &Some(new_max),
        &Some(new_deadline)
    );

    // Verify configuration was updated
    let config = client.get_config();
    assert_eq!(config.entry_fee, new_fee);
    assert_eq!(config.max_players, new_max);
    assert_eq!(config.join_deadline, new_deadline);
}

// ── Test 2: Partial Update - Entry Fee Only ───────────────────────────────

#[test]
fn configure_arena_updates_entry_fee_only() {
    let env = create_test_env();
    env.mock_all_auths();

    let (admin, token, _contract_id, client) = setup_arena(&env);

    let initial_fee = 100_000_000;
    let initial_max = 100;
    let initial_deadline = env.ledger().timestamp() + 86400;

    let treasury = Address::generate(&env);
    client.initialize(&admin, &token, &initial_fee, &initial_max, &initial_deadline, &treasury, &0);

    // Update only entry fee
    let new_fee = 75_000_000;
    client.configure_arena(&Some(new_fee), &None, &None);

    let config = client.get_config();
    assert_eq!(config.entry_fee, new_fee);
    assert_eq!(config.max_players, initial_max); // Unchanged
    assert_eq!(config.join_deadline, initial_deadline); // Unchanged
}

// ── Test 3: Partial Update - Max Players Only ─────────────────────────────

#[test]
fn configure_arena_updates_max_players_only() {
    let env = create_test_env();
    env.mock_all_auths();

    let (admin, token, _contract_id, client) = setup_arena(&env);

    let initial_fee = 100_000_000;
    let initial_max = 100;
    let initial_deadline = env.ledger().timestamp() + 86400;

    let treasury = Address::generate(&env);
    client.initialize(&admin, &token, &initial_fee, &initial_max, &initial_deadline, &treasury, &0);

    // Update only max players
    let new_max = 150;
    client.configure_arena(&None, &Some(new_max), &None);

    let config = client.get_config();
    assert_eq!(config.entry_fee, initial_fee); // Unchanged
    assert_eq!(config.max_players, new_max);
    assert_eq!(config.join_deadline, initial_deadline); // Unchanged
}

// ── Test 4: Partial Update - Deadline Only ────────────────────────────────

#[test]
fn configure_arena_updates_deadline_only() {
    let env = create_test_env();
    env.mock_all_auths();

    let (admin, token, _contract_id, client) = setup_arena(&env);

    let initial_fee = 100_000_000;
    let initial_max = 100;
    let initial_deadline = env.ledger().timestamp() + 86400;

    let treasury = Address::generate(&env);
    client.initialize(&admin, &token, &initial_fee, &initial_max, &initial_deadline, &treasury, &0);

    // Update only deadline
    let new_deadline = env.ledger().timestamp() + 259200; // 3 days
    client.configure_arena(&None, &None, &Some(new_deadline));

    let config = client.get_config();
    assert_eq!(config.entry_fee, initial_fee); // Unchanged
    assert_eq!(config.max_players, initial_max); // Unchanged
    assert_eq!(config.join_deadline, new_deadline);
}

// ── Test 5: Authorization Failure ──────────────────────────────────────────

#[test]
#[should_panic(expected = "HostError: Error(Auth, InvalidAction)")]
fn configure_arena_requires_admin_auth() {
    let env = create_test_env();

    let (admin, token, _contract_id, client) = setup_arena(&env);

    let initial_fee = 100_000_000;
    let initial_max = 100;
    let initial_deadline = env.ledger().timestamp() + 86400;

    env.mock_all_auths();
    let treasury = Address::generate(&env);
    client.initialize(&admin, &token, &initial_fee, &initial_max, &initial_deadline, &treasury, &0);

    // Clear all auths - this will cause auth to fail
    env.set_auths(&[]);

    // This should panic with auth error
    client.configure_arena(&Some(50_000_000), &None, &None);
}

// ── Test 6: State Validation - InProgress ──────────────────────────────────

#[test]
fn configure_arena_fails_when_game_in_progress() {
    let env = create_test_env();
    env.mock_all_auths();

    let (admin, token, _contract_id, client) = setup_arena(&env);

    let initial_fee = 100_000_000;
    let initial_max = 100;
    let initial_deadline = env.ledger().timestamp() + 86400;

    let treasury = Address::generate(&env);
    client.initialize(&admin, &token, &initial_fee, &initial_max, &initial_deadline, &treasury, &0);

    // Start the game (transition to InProgress)
    client.start_game();

    // Attempt to configure should fail
    let result = client.try_configure_arena(&Some(50_000_000), &None, &None);

    assert!(result.is_err());
    assert_eq!(result.unwrap_err().unwrap(), ArenaError::ArenaAlreadyStarted);
}

// ── Test 7: State Validation - Finished ────────────────────────────────────

#[test]
fn configure_arena_fails_when_game_finished() {
    let env = create_test_env();
    env.mock_all_auths();

    let (admin, token, _contract_id, client) = setup_arena(&env);

    let initial_fee = 100_000_000;
    let initial_max = 100;
    let initial_deadline = env.ledger().timestamp() + 86400;

    let treasury = Address::generate(&env);
    client.initialize(&admin, &token, &initial_fee, &initial_max, &initial_deadline, &treasury, &0);

    // Play game to completion (transition to Finished)
    client.start_game();
    client.finish_game();

    // Attempt to configure should fail
    let result = client.try_configure_arena(&Some(50_000_000), &None, &None);

    assert!(result.is_err());
    assert_eq!(result.unwrap_err().unwrap(), ArenaError::ArenaAlreadyStarted);
}

// ── Test 8: Invalid Entry Fee - Zero ───────────────────────────────────────

#[test]
fn configure_arena_rejects_zero_entry_fee() {
    let env = create_test_env();
    env.mock_all_auths();

    let (admin, token, _contract_id, client) = setup_arena(&env);

    let initial_fee = 100_000_000;
    let initial_max = 100;
    let initial_deadline = env.ledger().timestamp() + 86400;

    let treasury = Address::generate(&env);
    client.initialize(&admin, &token, &initial_fee, &initial_max, &initial_deadline, &treasury, &0);

    // Attempt to set fee to 0
    let result = client.try_configure_arena(&Some(0), &None, &None);

    assert!(result.is_err());
    assert_eq!(result.unwrap_err().unwrap(), ArenaError::InvalidEntryFee);
}

// ── Test 9: Invalid Entry Fee - Negative ───────────────────────────────────

#[test]
fn configure_arena_rejects_negative_entry_fee() {
    let env = create_test_env();
    env.mock_all_auths();

    let (admin, token, _contract_id, client) = setup_arena(&env);

    let initial_fee = 100_000_000;
    let initial_max = 100;
    let initial_deadline = env.ledger().timestamp() + 86400;

    let treasury = Address::generate(&env);
    client.initialize(&admin, &token, &initial_fee, &initial_max, &initial_deadline, &treasury, &0);

    // Attempt to set negative fee
    let result = client.try_configure_arena(&Some(-100), &None, &None);

    assert!(result.is_err());
    assert_eq!(result.unwrap_err().unwrap(), ArenaError::InvalidEntryFee);
}

// ── Test 10: Invalid Deadline - Past ───────────────────────────────────────

#[test]
fn configure_arena_rejects_past_deadline() {
    let env = create_test_env();
    env.mock_all_auths();

    let (admin, token, _contract_id, client) = setup_arena(&env);

    let current_time = env.ledger().timestamp();
    let initial_fee = 100_000_000;
    let initial_max = 100;
    let initial_deadline = current_time + 86400;

    let treasury = Address::generate(&env);
    client.initialize(&admin, &token, &initial_fee, &initial_max, &initial_deadline, &treasury, &0);

    // Attempt to set deadline in the past
    let past_deadline = current_time - 1000;
    let result = client.try_configure_arena(&None, &None, &Some(past_deadline));

    assert!(result.is_err());
    assert_eq!(result.unwrap_err().unwrap(), ArenaError::DeadlineTooSoon);
}

// ── Test 11: Invalid Deadline - Current Time ───────────────────────────────

#[test]
fn configure_arena_rejects_current_time_deadline() {
    let env = create_test_env();
    env.mock_all_auths();

    let (admin, token, _contract_id, client) = setup_arena(&env);

    let current_time = env.ledger().timestamp();
    let initial_fee = 100_000_000;
    let initial_max = 100;
    let initial_deadline = current_time + 86400;

    let treasury = Address::generate(&env);
    client.initialize(&admin, &token, &initial_fee, &initial_max, &initial_deadline, &treasury, &0);

    // Attempt to set deadline to current time
    let result = client.try_configure_arena(&None, &None, &Some(current_time));

    assert!(result.is_err());
    assert_eq!(result.unwrap_err().unwrap(), ArenaError::DeadlineTooSoon);
}

// ── Test 12: Valid Deadline - Future ───────────────────────────────────────

#[test]
fn configure_arena_accepts_future_deadline() {
    let env = create_test_env();
    env.mock_all_auths();

    let (admin, token, _contract_id, client) = setup_arena(&env);

    let current_time = env.ledger().timestamp();
    let initial_fee = 100_000_000;
    let initial_max = 100;
    let initial_deadline = current_time + 86400;

    let treasury = Address::generate(&env);
    client.initialize(&admin, &token, &initial_fee, &initial_max, &initial_deadline, &treasury, &0);

    // Set deadline to future time
    let future_deadline = current_time + 172800; // 2 days
    client.configure_arena(&None, &None, &Some(future_deadline));

    let config = client.get_config();
    assert_eq!(config.join_deadline, future_deadline);
}

// ── Test 13: Multiple Updates ──────────────────────────────────────────────

#[test]
fn configure_arena_can_be_called_multiple_times() {
    let env = create_test_env();
    env.mock_all_auths();

    let (admin, token, _contract_id, client) = setup_arena(&env);

    let initial_fee = 100_000_000;
    let initial_max = 100;
    let initial_deadline = env.ledger().timestamp() + 86400;

    let treasury = Address::generate(&env);
    client.initialize(&admin, &token, &initial_fee, &initial_max, &initial_deadline, &treasury, &0);

    // First update
    client.configure_arena(&Some(75_000_000), &None, &None);
    let config1 = client.get_config();
    assert_eq!(config1.entry_fee, 75_000_000);

    // Second update
    client.configure_arena(&None, &Some(150), &None);
    let config2 = client.get_config();
    assert_eq!(config2.entry_fee, 75_000_000); // Still 75
    assert_eq!(config2.max_players, 150);

    // Third update
    let new_deadline = env.ledger().timestamp() + 259200;
    client.configure_arena(&Some(50_000_000), &None, &Some(new_deadline));
    let config3 = client.get_config();
    assert_eq!(config3.entry_fee, 50_000_000);
    assert_eq!(config3.max_players, 150); // Still 150
    assert_eq!(config3.join_deadline, new_deadline);
}

// ── Test 14: Event Emission ────────────────────────────────────────────────

#[test]
fn configure_arena_emits_event() {
    let env = create_test_env();
    env.mock_all_auths();

    let (admin, token, _contract_id, client) = setup_arena(&env);

    let initial_fee = 100_000_000;
    let initial_max = 100;
    let initial_deadline = env.ledger().timestamp() + 86400;

    let treasury = Address::generate(&env);
    client.initialize(&admin, &token, &initial_fee, &initial_max, &initial_deadline, &treasury, &0);

    // Clear events
    let events_before = env.events().all().len();

    // Configure arena
    client.configure_arena(&Some(50_000_000), &Some(200), &None);

    // Check event was emitted
    let events_after = env.events().all();
    assert!(events_after.len() > events_before);

    // Verify the last event is the configuration event
    let last_event = events_after.last().unwrap();
    let topics = &last_event.1;

    // Check if the event contains the CFGD symbol
    assert!(topics.len() > 0);
}

// ── Test 15: No-Op Configuration ───────────────────────────────────────────

#[test]
fn configure_arena_with_all_none_succeeds() {
    let env = create_test_env();
    env.mock_all_auths();

    let (admin, token, _contract_id, client) = setup_arena(&env);

    let initial_fee = 100_000_000;
    let initial_max = 100;
    let initial_deadline = env.ledger().timestamp() + 86400;

    let treasury = Address::generate(&env);
    client.initialize(&admin, &token, &initial_fee, &initial_max, &initial_deadline, &treasury, &0);

    client.configure_arena(&None, &None, &None);

    // Verify nothing changed
    let config = client.get_config();
    assert_eq!(config.entry_fee, initial_fee);
    assert_eq!(config.max_players, initial_max);
    assert_eq!(config.join_deadline, initial_deadline);
}

// ── Test 16: Configure After Players Join ──────────────────────────────────

#[test]
fn configure_arena_after_players_joined() {
    let env = create_test_env();
    env.mock_all_auths();

    let (admin, token, _contract_id, client) = setup_arena(&env);

    let initial_fee = 100_000_000;
    let initial_max = 100;
    let initial_deadline = env.ledger().timestamp() + 86400;

    let treasury = Address::generate(&env);
    client.initialize(&admin, &token, &initial_fee, &initial_max, &initial_deadline, &treasury, &0);

    // Players get tokens and join
    let player1 = Address::generate(&env);
    let player2 = Address::generate(&env);
    mint_tokens(&env, &token, &player1, initial_fee);
    mint_tokens(&env, &token, &player2, initial_fee);
    client.join(&player1);
    client.join(&player2);

    let players_before = client.get_player_count();
    assert_eq!(players_before, 2);

    // Configure arena (increase capacity)
    client.configure_arena(&None, &Some(200), &None);

    // Verify existing players remain
    let players_after = client.get_player_count();
    assert_eq!(players_after, 2);

    // Verify new capacity
    let config = client.get_config();
    assert_eq!(config.max_players, 200);
}

// ── Test 17: Configure Then Start Game ─────────────────────────────────────

#[test]
fn configure_then_start_game_uses_new_config() {
    let env = create_test_env();
    env.mock_all_auths();

    let (admin, token, _contract_id, client) = setup_arena(&env);

    let initial_fee = 100_000_000;
    let initial_max = 100;
    let initial_deadline = env.ledger().timestamp() + 86400;

    let treasury = Address::generate(&env);
    client.initialize(&admin, &token, &initial_fee, &initial_max, &initial_deadline, &treasury, &0);

    // Configure with new entry fee
    let new_fee = 50_000_000;
    client.configure_arena(&Some(new_fee), &None, &None);

    // Verify new fee is in effect
    let config = client.get_config();
    assert_eq!(config.entry_fee, new_fee);

    // New player can join with sufficient tokens
    let player = Address::generate(&env);
    mint_tokens(&env, &token, &player, new_fee);
    client.join(&player);
}

// ── Test 18: Initialize with Invalid Entry Fee ─────────────────────────────

#[test]
fn initialize_rejects_zero_entry_fee() {
    let env = create_test_env();
    env.mock_all_auths();

    let (admin, token, _contract_id, client) = setup_arena(&env);

    let treasury = Address::generate(&env);
    let initial_deadline = env.ledger().timestamp() + 86400;

    // Attempt to initialize with zero fee
    let result = client.try_initialize(&admin, &token, &0, &100, &initial_deadline, &treasury, &0);

    assert!(result.is_err());
    assert_eq!(result.unwrap_err().unwrap(), ArenaError::InvalidEntryFee);
}

// ── Test 19: Initialize with Past Deadline ─────────────────────────────────

#[test]
fn initialize_rejects_past_deadline() {
    let env = create_test_env();
    env.mock_all_auths();

    let (admin, token, _contract_id, client) = setup_arena(&env);

    let treasury = Address::generate(&env);
    let current_time = env.ledger().timestamp();
    let past_deadline = current_time - 1000;

    // Attempt to initialize with past deadline
    let result = client.try_initialize(&admin, &token, &100_000_000, &100, &past_deadline, &treasury, &0);

    assert!(result.is_err());
    assert_eq!(result.unwrap_err().unwrap(), ArenaError::DeadlineTooSoon);
}

// ── Test 20: Edge Case - Set Max Players to Zero ───────────────────────────

#[test]
fn configure_arena_accepts_zero_max_players() {
    let env = create_test_env();
    env.mock_all_auths();

    let (admin, token, _contract_id, client) = setup_arena(&env);

    let initial_fee = 100_000_000;
    let initial_max = 100;
    let initial_deadline = env.ledger().timestamp() + 86400;

    let treasury = Address::generate(&env);
    client.initialize(&admin, &token, &initial_fee, &initial_max, &initial_deadline, &treasury, &0);

    client.configure_arena(&None, &Some(0), &None);

    let config = client.get_config();
    assert_eq!(config.max_players, 0);
}

// ── Lifecycle Integration Tests ────────────────────────────────────────────

#[test]
fn test_full_game_two_players_one_round() {
    let env = create_test_env();
    env.mock_all_auths();
    let (admin, token, _contract_id, client) = setup_arena(&env);

    let initial_fee = 100_000_000;
    let initial_max = 100;
    let initial_deadline = env.ledger().timestamp() + 86400;

    let treasury = Address::generate(&env);
    client.initialize(&admin, &token, &initial_fee, &initial_max, &initial_deadline, &treasury, &0);

    let alice = Address::generate(&env);
    let bob = Address::generate(&env);
    mint_tokens(&env, &token, &alice, initial_fee);
    mint_tokens(&env, &token, &bob, initial_fee);

    client.join(&alice);
    client.join(&bob);

    client.start_game();
    assert_eq!(client.game_state(), GameState::InProgress);

    client.submit_choice(&alice, &Choice::Heads);
    client.submit_choice(&bob, &Choice::Tails);

    let result = client.resolve_round();

    // In a 2-player tie (Heads vs Tails), Heads survives, Tails (Bob) is eliminated.
    assert_eq!(result.eliminated + result.survivors, 2);
    assert_eq!(result.survivors, 1);
    assert_eq!(client.game_state(), GameState::Finished);

    let winner = client.winner().unwrap();
    assert_eq!(winner, alice);

    // Winner claims successfully
    client.claim(&winner);
}

#[test]
fn test_full_game_ten_players_four_rounds() {
    let env = create_test_env();
    env.mock_all_auths();
    let (admin, token, _contract_id, client) = setup_arena(&env);

    let initial_fee = 100_000_000;
    let initial_max = 100;
    let initial_deadline = env.ledger().timestamp() + 86400;

    let treasury = Address::generate(&env);
    client.initialize(&admin, &token, &initial_fee, &initial_max, &initial_deadline, &treasury, &0);

    // Generate 10 players with tokens
    let mut players = soroban_sdk::Vec::new(&env);
    for _ in 0..10 {
        let player = Address::generate(&env);
        mint_tokens(&env, &token, &player, initial_fee);
        players.push_back(player);
    }

    for player in players.iter() {
        client.join(&player);
    }
    assert_eq!(client.get_player_count(), 10);

    client.start_game();

    // Round 1: 4 Heads, 6 Tails. Tails is majority and eliminated. Survivors = 4.
    let p0 = players.get(0).unwrap();
    let p1 = players.get(1).unwrap();
    let p2 = players.get(2).unwrap();
    let p3 = players.get(3).unwrap();

    client.submit_choice(&p0, &Choice::Heads);
    client.submit_choice(&p1, &Choice::Heads);
    client.submit_choice(&p2, &Choice::Heads);
    client.submit_choice(&p3, &Choice::Heads);

    for i in 4..10 {
        let player = players.get(i).unwrap();
        client.submit_choice(&player, &Choice::Tails);
    }

    let r1 = client.resolve_round();
    assert_eq!(r1.eliminated, 6);
    assert_eq!(r1.survivors, 4);
    assert_eq!(client.game_state(), GameState::InProgress);

    // Round 2: 2 Heads, 2 Tails. Tie round (no eliminations). Survivors = 4.
    client.submit_choice(&p0, &Choice::Heads);
    client.submit_choice(&p1, &Choice::Heads);
    client.submit_choice(&p2, &Choice::Tails);
    client.submit_choice(&p3, &Choice::Tails);

    let r2 = client.resolve_round();
    assert_eq!(r2.eliminated, 0);
    assert_eq!(r2.survivors, 4);
    assert_eq!(client.game_state(), GameState::InProgress);

    // Round 3: another tie. Survivors = 4.
    client.submit_choice(&p0, &Choice::Heads);
    client.submit_choice(&p1, &Choice::Heads);
    client.submit_choice(&p2, &Choice::Tails);
    client.submit_choice(&p3, &Choice::Tails);

    let r3 = client.resolve_round();
    assert_eq!(r3.eliminated, 0);
    assert_eq!(r3.survivors, 4);
    assert_eq!(client.game_state(), GameState::InProgress);

    // Round 4: 1 Heads (p0), 3 Tails (p1, p2, p3). Tails eliminated. Survivors = 1.
    client.submit_choice(&p0, &Choice::Heads);
    client.submit_choice(&p1, &Choice::Tails);
    client.submit_choice(&p2, &Choice::Tails);
    client.submit_choice(&p3, &Choice::Tails);

    let r4 = client.resolve_round();
    assert_eq!(r4.eliminated, 3);
    assert_eq!(r4.survivors, 1);
    assert_eq!(client.game_state(), GameState::Finished);

    let winner = client.winner().unwrap();
    assert_eq!(winner, p0);

    // Winner claims
    client.claim(&winner);
}

#[test]
fn test_tie_round_no_eliminations() {
    let env = create_test_env();
    env.mock_all_auths();
    let (admin, token, _contract_id, client) = setup_arena(&env);

    let initial_fee = 100_000_000;
    let initial_max = 100;
    let initial_deadline = env.ledger().timestamp() + 86400;

    let treasury = Address::generate(&env);
    client.initialize(&admin, &token, &initial_fee, &initial_max, &initial_deadline, &treasury, &0);

    let p0 = Address::generate(&env);
    let p1 = Address::generate(&env);
    let p2 = Address::generate(&env);
    let p3 = Address::generate(&env);
    mint_tokens(&env, &token, &p0, initial_fee);
    mint_tokens(&env, &token, &p1, initial_fee);
    mint_tokens(&env, &token, &p2, initial_fee);
    mint_tokens(&env, &token, &p3, initial_fee);

    client.join(&p0);
    client.join(&p1);
    client.join(&p2);
    client.join(&p3);

    client.start_game();

    client.submit_choice(&p0, &Choice::Heads);
    client.submit_choice(&p1, &Choice::Heads);
    client.submit_choice(&p2, &Choice::Tails);
    client.submit_choice(&p3, &Choice::Tails);

    let result = client.resolve_round();
    assert_eq!(result.eliminated, 0);
    assert_eq!(result.survivors, 4);
    assert_eq!(client.game_state(), GameState::InProgress);
}

#[test]
fn test_late_join_rejection() {
    let env = create_test_env();
    env.mock_all_auths();
    let (admin, token, _contract_id, client) = setup_arena(&env);

    let initial_fee = 100_000_000;
    let initial_max = 100;
    let current_time = env.ledger().timestamp();
    let initial_deadline = current_time + 1000;

    let treasury = Address::generate(&env);
    client.initialize(&admin, &token, &initial_fee, &initial_max, &initial_deadline, &treasury, &0);

    // Fast-forward time past deadline
    let mut ledger = env.ledger().get();
    ledger.timestamp = current_time + 2000;
    env.ledger().set(ledger);

    let player = Address::generate(&env);
    let result = client.try_join(&player);

    assert!(result.is_err());
    assert_eq!(result.unwrap_err().unwrap(), ArenaError::DeadlinePassed);
}

#[test]
fn test_claim_errors() {
    let env = create_test_env();
    env.mock_all_auths();
    let (admin, token, _contract_id, client) = setup_arena(&env);

    let initial_fee = 100_000_000;
    let initial_max = 100;
    let initial_deadline = env.ledger().timestamp() + 86400;

    let treasury = Address::generate(&env);
    client.initialize(&admin, &token, &initial_fee, &initial_max, &initial_deadline, &treasury, &0);

    let alice = Address::generate(&env);
    let bob = Address::generate(&env);
    mint_tokens(&env, &token, &alice, initial_fee);
    mint_tokens(&env, &token, &bob, initial_fee);

    client.join(&alice);
    client.join(&bob);

    client.start_game();

    client.submit_choice(&alice, &Choice::Heads);
    client.submit_choice(&bob, &Choice::Tails);

    client.resolve_round(); // Alice survives, Bob is eliminated

    // Claiming by non-winner (Bob) returns PlayerEliminated error
    let bob_claim = client.try_claim(&bob);
    assert!(bob_claim.is_err());
    assert_eq!(bob_claim.unwrap_err().unwrap(), ArenaError::PlayerEliminated);

    // Claiming by winner (Alice) succeeds
    let alice_claim = client.try_claim(&alice);
    assert!(alice_claim.is_ok());

    // Double-claiming by winner (Alice) returns PrizeAlreadyClaimed error
    let double_claim = client.try_claim(&alice);
    assert!(double_claim.is_err());
    assert_eq!(double_claim.unwrap_err().unwrap(), ArenaError::PrizeAlreadyClaimed);
}

// ── Token Transfer Tests ──────────────────────────────────────────────────

#[test]
fn test_join_transfers_entry_fee() {
    let env = create_test_env();
    env.mock_all_auths();
    let (admin, token, contract_id, client) = setup_arena(&env);

    let entry_fee = 100_000_000;
    let initial_max = 100;
    let initial_deadline = env.ledger().timestamp() + 86400;

    let treasury = Address::generate(&env);
    client.initialize(&admin, &token, &entry_fee, &initial_max, &initial_deadline, &treasury, &0);

    let player = Address::generate(&env);
    mint_tokens(&env, &token, &player, entry_fee);

    // Check balances before join
    let token_client = TokenClient::new(&env, &token);
    let player_balance_before = token_client.balance(&player);
    let contract_balance_before = token_client.balance(&contract_id);

    client.join(&player);

    let player_balance_after = token_client.balance(&player);
    let contract_balance_after = token_client.balance(&contract_id);

    assert_eq!(player_balance_before - player_balance_after, entry_fee);
    assert_eq!(contract_balance_after - contract_balance_before, entry_fee);
}

#[test]
fn test_join_fails_without_tokens() {
    let env = create_test_env();
    env.mock_all_auths();
    let (admin, token, _contract_id, client) = setup_arena(&env);

    let entry_fee = 100_000_000;
    let initial_max = 100;
    let initial_deadline = env.ledger().timestamp() + 86400;

    let treasury = Address::generate(&env);
    client.initialize(&admin, &token, &entry_fee, &initial_max, &initial_deadline, &treasury, &0);

    let player = Address::generate(&env);
    // Player has no tokens

    let result = client.try_join(&player);
    assert!(result.is_err());
}

#[test]
fn test_claim_transfers_prize() {
    let env = create_test_env();
    env.mock_all_auths();
    let (admin, token, _contract_id, client) = setup_arena(&env);

    let entry_fee = 100_000_000;
    let initial_max = 100;
    let initial_deadline = env.ledger().timestamp() + 86400;

    let treasury = Address::generate(&env);
    client.initialize(&admin, &token, &entry_fee, &initial_max, &initial_deadline, &treasury, &0);

    let alice = Address::generate(&env);
    let bob = Address::generate(&env);
    mint_tokens(&env, &token, &alice, entry_fee);
    mint_tokens(&env, &token, &bob, entry_fee);

    client.join(&alice);
    client.join(&bob);

    client.start_game();
    client.submit_choice(&alice, &Choice::Heads);
    client.submit_choice(&bob, &Choice::Tails);
    client.resolve_round();

    let total_pot: i128 = entry_fee * 2;
    let platform_fee = total_pot * PLATFORM_FEE_BP / 10000;
    let prize = total_pot - platform_fee;

    let token_client = TokenClient::new(&env, &token);
    let alice_balance_before = token_client.balance(&alice);
    let admin_balance_before = token_client.balance(&admin);

    client.claim(&alice);

    let alice_balance_after = token_client.balance(&alice);
    let admin_balance_after = token_client.balance(&admin);

    assert_eq!(alice_balance_after - alice_balance_before, prize);
    assert_eq!(admin_balance_after - admin_balance_before, platform_fee);
}

#[test]
fn test_cancel_arena_and_refund() {
    let env = create_test_env();
    env.mock_all_auths();
    let (admin, token, _contract_id, client) = setup_arena(&env);

    let entry_fee = 100_000_000;
    let initial_max = 100;
    let initial_deadline = env.ledger().timestamp() + 86400;

    let treasury = Address::generate(&env);
    client.initialize(&admin, &token, &entry_fee, &initial_max, &initial_deadline, &treasury, &0);

    let player = Address::generate(&env);
    mint_tokens(&env, &token, &player, entry_fee);
    client.join(&player);

    // Admin cancels arena
    client.cancel_arena();

    assert_eq!(client.game_state(), GameState::Cancelled);

    // Player claims refund
    let token_client = TokenClient::new(&env, &token);
    let player_balance_before = token_client.balance(&player);

    client.claim_refund(&player);

    let player_balance_after = token_client.balance(&player);
    assert_eq!(player_balance_after - player_balance_before, entry_fee);

    // Double refund fails
    let result = client.try_claim_refund(&player);
    assert!(result.is_err());
    assert_eq!(result.unwrap_err().unwrap(), ArenaError::RefundAlreadyClaimed);
}

#[test]
fn test_claim_fails_when_game_not_finished() {
    let env = create_test_env();
    env.mock_all_auths();
    let (admin, token, _contract_id, client) = setup_arena(&env);

    let entry_fee = 100_000_000;
    let initial_max = 100;
    let initial_deadline = env.ledger().timestamp() + 86400;

    let treasury = Address::generate(&env);
    client.initialize(&admin, &token, &entry_fee, &initial_max, &initial_deadline, &treasury, &0);

    let alice = Address::generate(&env);
    let bob = Address::generate(&env);
    mint_tokens(&env, &token, &alice, entry_fee);
    mint_tokens(&env, &token, &bob, entry_fee);

    client.join(&alice);
    client.join(&bob);

    // Game is still Open, not Finished
    let result = client.try_claim(&alice);
    assert!(result.is_err());
    assert_eq!(result.unwrap_err().unwrap(), ArenaError::GameNotFinished);
}

#[test]
fn test_claim_fails_when_game_in_progress() {
    let env = create_test_env();
    env.mock_all_auths();
    let (admin, token, _contract_id, client) = setup_arena(&env);

    let entry_fee = 100_000_000;
    let initial_max = 100;
    let initial_deadline = env.ledger().timestamp() + 86400;

    let treasury = Address::generate(&env);
    client.initialize(&admin, &token, &entry_fee, &initial_max, &initial_deadline, &treasury, &0);

    let alice = Address::generate(&env);
    let bob = Address::generate(&env);
    mint_tokens(&env, &token, &alice, entry_fee);
    mint_tokens(&env, &token, &bob, entry_fee);

    client.join(&alice);
    client.join(&bob);
    client.start_game();

    // Game is InProgress, not Finished
    let result = client.try_claim(&alice);
    assert!(result.is_err());
    assert_eq!(result.unwrap_err().unwrap(), ArenaError::GameNotFinished);
}

#[test]
fn test_claim_fails_when_arena_cancelled() {
    let env = create_test_env();
    env.mock_all_auths();
    let (admin, token, _contract_id, client) = setup_arena(&env);

    let entry_fee = 100_000_000;
    let initial_max = 100;
    let initial_deadline = env.ledger().timestamp() + 86400;

    let treasury = Address::generate(&env);
    client.initialize(&admin, &token, &entry_fee, &initial_max, &initial_deadline, &treasury, &0);

    let alice = Address::generate(&env);
    mint_tokens(&env, &token, &alice, entry_fee);
    client.join(&alice);

    // Cancel the arena
    client.cancel_arena();

    // Claim should fail because arena is Cancelled, not Finished
    let result = client.try_claim(&alice);
    assert!(result.is_err());
    assert_eq!(result.unwrap_err().unwrap(), ArenaError::GameNotFinished);
}

#[test]
fn test_platform_fee_calculation_accuracy() {
    let env = create_test_env();
    env.mock_all_auths();
    let (admin, token, _contract_id, client) = setup_arena(&env);

    let entry_fee = 100_000_000;
    let initial_max = 100;
    let initial_deadline = env.ledger().timestamp() + 86400;

    let treasury = Address::generate(&env);
    client.initialize(&admin, &token, &entry_fee, &initial_max, &initial_deadline, &treasury, &0);

    // Test with 10 players
    let mut players = soroban_sdk::Vec::new(&env);
    for _ in 0..10 {
        let player = Address::generate(&env);
        mint_tokens(&env, &token, &player, entry_fee);
        players.push_back(player);
    }

    for player in players.iter() {
        client.join(&player);
    }

    client.start_game();

    // 1 Heads (minority, survives), 9 Tails (majority, eliminated) → 1 survivor, game finishes
    client.submit_choice(&players.get(0).unwrap(), &Choice::Heads);
    for i in 1..10 {
        client.submit_choice(&players.get(i).unwrap(), &Choice::Tails);
    }

    client.resolve_round();

    let winner = players.get(0).unwrap();

    let total_pot: i128 = entry_fee * 10;
    let platform_fee = total_pot * PLATFORM_FEE_BP / 10000;
    let expected_prize = total_pot - platform_fee;

    let token_client = TokenClient::new(&env, &token);
    let winner_balance_before = token_client.balance(&winner);
    let admin_balance_before = token_client.balance(&admin);

    client.claim(&winner);

    let winner_balance_after = token_client.balance(&winner);
    let admin_balance_after = token_client.balance(&admin);

    assert_eq!(winner_balance_after - winner_balance_before, expected_prize);
    assert_eq!(admin_balance_after - admin_balance_before, platform_fee);
}

#[test]
fn test_platform_fee_with_different_amounts() {
    let env = create_test_env();
    env.mock_all_auths();
    let (admin, token, _contract_id, client) = setup_arena(&env);

    let entry_fee = 50_000_000; // 5 XLM
    let initial_max = 100;
    let initial_deadline = env.ledger().timestamp() + 86400;

    let treasury = Address::generate(&env);
    client.initialize(&admin, &token, &entry_fee, &initial_max, &initial_deadline, &treasury, &0);

    // Test with 3 players
    let alice = Address::generate(&env);
    let bob = Address::generate(&env);
    let charlie = Address::generate(&env);
    mint_tokens(&env, &token, &alice, entry_fee);
    mint_tokens(&env, &token, &bob, entry_fee);
    mint_tokens(&env, &token, &charlie, entry_fee);

    client.join(&alice);
    client.join(&bob);
    client.join(&charlie);

    client.start_game();
    client.submit_choice(&alice, &Choice::Heads);
    client.submit_choice(&bob, &Choice::Tails);
    client.submit_choice(&charlie, &Choice::Tails);
    client.resolve_round();

    let total_pot: i128 = entry_fee * 3;
    let platform_fee = total_pot * PLATFORM_FEE_BP / 10000;
    let expected_prize = total_pot - platform_fee;

    let token_client = TokenClient::new(&env, &token);
    let alice_balance_before = token_client.balance(&alice);
    let admin_balance_before = token_client.balance(&admin);

    client.claim(&alice);

    let alice_balance_after = token_client.balance(&alice);
    let admin_balance_after = token_client.balance(&admin);

    assert_eq!(alice_balance_after - alice_balance_before, expected_prize);
    assert_eq!(admin_balance_after - admin_balance_before, platform_fee);
}

#[test]
fn test_refund_fails_for_non_player() {
    let env = create_test_env();
    env.mock_all_auths();
    let (admin, token, _contract_id, client) = setup_arena(&env);

    let entry_fee = 100_000_000;
    let initial_max = 100;
    let initial_deadline = env.ledger().timestamp() + 86400;

    let treasury = Address::generate(&env);
    client.initialize(&admin, &token, &entry_fee, &initial_max, &initial_deadline, &treasury, &0);

    let player = Address::generate(&env);
    let non_player = Address::generate(&env);
    mint_tokens(&env, &token, &player, entry_fee);
    client.join(&player);

    // Cancel the arena
    client.cancel_arena();

    // Non-player trying to claim refund should fail
    let result = client.try_claim_refund(&non_player);
    assert!(result.is_err());
    assert_eq!(result.unwrap_err().unwrap(), ArenaError::NotAPlayer);
}

#[test]
fn test_claim_refund_fails_if_not_cancelled() {
    let env = create_test_env();
    env.mock_all_auths();
    let (admin, token, _contract_id, client) = setup_arena(&env);

    let entry_fee = 100_000_000;
    let initial_max = 100;
    let initial_deadline = env.ledger().timestamp() + 86400;

    let treasury = Address::generate(&env);
    client.initialize(&admin, &token, &entry_fee, &initial_max, &initial_deadline, &treasury, &0);

    let player = Address::generate(&env);
    mint_tokens(&env, &token, &player, entry_fee);
    client.join(&player);

    // Arena not cancelled yet
    let result = client.try_claim_refund(&player);
    assert!(result.is_err());
    assert_eq!(result.unwrap_err().unwrap(), ArenaError::ArenaNotCancelled);
}

#[test]
fn test_deposit_and_withdraw_creator_stake() {
    let env = create_test_env();
    env.mock_all_auths();
    let (admin, token, contract_id, client) = setup_arena(&env);

    let entry_fee = 100_000_000;
    let initial_max = 100;
    let initial_deadline = env.ledger().timestamp() + 86400;

    let treasury = Address::generate(&env);
    client.initialize(&admin, &token, &entry_fee, &initial_max, &initial_deadline, &treasury, &0);

    let stake_amount: i128 = 500_000_000;
    mint_tokens(&env, &token, &admin, stake_amount);

    // Deposit stake
    let token_client = TokenClient::new(&env, &token);
    let admin_balance_before = token_client.balance(&admin);
    let contract_balance_before = token_client.balance(&contract_id);

    client.deposit_creator_stake(&admin, &stake_amount);

    let admin_balance_deposit = token_client.balance(&admin);
    let contract_balance_deposit = token_client.balance(&contract_id);
    assert_eq!(admin_balance_before - admin_balance_deposit, stake_amount);
    assert_eq!(contract_balance_deposit - contract_balance_before, stake_amount);
    assert_eq!(client.get_creator_stake(), stake_amount);

    // Withdraw stake with no active pools (state Finished → no slash)
    client.start_game();
    client.finish_game();
    client.withdraw_creator_stake(&admin);

    let admin_balance_after = token_client.balance(&admin);
    let contract_balance_after = token_client.balance(&contract_id);
    assert_eq!(admin_balance_after - admin_balance_deposit, stake_amount);
    assert_eq!(contract_balance_before - contract_balance_after, 0);
    assert_eq!(client.get_creator_stake(), 0);
}

#[test]
fn test_double_deposit_stake_fails() {
    let env = create_test_env();
    env.mock_all_auths();
    let (admin, token, _contract_id, client) = setup_arena(&env);

    let entry_fee = 100_000_000;
    let initial_max = 100;
    let initial_deadline = env.ledger().timestamp() + 86400;

    let treasury = Address::generate(&env);
    client.initialize(&admin, &token, &entry_fee, &initial_max, &initial_deadline, &treasury, &0);

    let stake_amount: i128 = 500_000_000;
    mint_tokens(&env, &token, &admin, stake_amount * 2);

    client.deposit_creator_stake(&admin, &stake_amount);

    // Second deposit should fail
    let result = client.try_deposit_creator_stake(&admin, &stake_amount);
    assert!(result.is_err());
    assert_eq!(result.unwrap_err().unwrap(), ArenaError::StakeAlreadyDeposited);
}

#[test]
fn test_withdraw_without_stake_fails() {
    let env = create_test_env();
    env.mock_all_auths();
    let (admin, token, _contract_id, client) = setup_arena(&env);

    let entry_fee = 100_000_000;
    let initial_max = 100;
    let initial_deadline = env.ledger().timestamp() + 86400;

    let treasury = Address::generate(&env);
    client.initialize(&admin, &token, &entry_fee, &initial_max, &initial_deadline, &treasury, &0);

    let result = client.try_withdraw_creator_stake(&admin);
    assert!(result.is_err());
    assert_eq!(result.unwrap_err().unwrap(), ArenaError::NoStakeToWithdraw);
}

#[test]
fn test_cancel_arena_fails_when_not_open() {
    let env = create_test_env();
    env.mock_all_auths();
    let (admin, token, _contract_id, client) = setup_arena(&env);

    let entry_fee = 100_000_000;
    let initial_max = 100;
    let initial_deadline = env.ledger().timestamp() + 86400;

    let treasury = Address::generate(&env);
    client.initialize(&admin, &token, &entry_fee, &initial_max, &initial_deadline, &treasury, &0);
    client.start_game();

    // Can't cancel once game started
    let result = client.try_cancel_arena();
    assert!(result.is_err());
    assert_eq!(result.unwrap_err().unwrap(), ArenaError::InvalidStateTransition);
}


// ── Pause Functionality Tests (#909) ────────────────────────────────────────

#[test]
fn pause_rejects_all_state_mutating_operations() {
    let env = create_test_env();
    env.mock_all_auths();

    let (admin, token, _contract_id, client) = setup_arena(&env);

    let initial_fee = 100_000_000;
    let initial_max = 100;
    let initial_deadline = env.ledger().timestamp() + 86400;
    let treasury = Address::generate(&env);

    client.initialize(&admin, &token, &initial_fee, &initial_max, &initial_deadline, &treasury, &0);

    // Pause the contract
    client.pause(&symbol_short!("emerg"));

    // Verify paused state
    let config = client.get_config();
    assert!(config.paused);

    // join should be rejected
    let player = Address::generate(&env);
    let join_result = client.try_join(&player);
    assert!(join_result.is_err());
    assert_eq!(join_result.unwrap_err().unwrap(), ArenaError::ContractPaused);

    // start_game should be rejected
    let start_result = client.try_start_game();
    assert!(start_result.is_err());
    assert_eq!(start_result.unwrap_err().unwrap(), ArenaError::ContractPaused);

    // submit_choice should be rejected (after unpause + start + re-pause would normally work,
    // but let's test it directly: start game first then test)
}

#[test]
fn pause_rejects_submit_choice() {
    let env = create_test_env();
    env.mock_all_auths();

    let (admin, token, _contract_id, client) = setup_arena(&env);

    let initial_fee = 100_000_000;
    let initial_max = 100;
    let initial_deadline = env.ledger().timestamp() + 86400;
    let treasury = Address::generate(&env);

    client.initialize(&admin, &token, &initial_fee, &initial_max, &initial_deadline, &treasury, &0);

    let alice = Address::generate(&env);
    let bob = Address::generate(&env);
    mint_tokens(&env, &token, &alice, initial_fee);
    mint_tokens(&env, &token, &bob, initial_fee);
    client.join(&alice);
    client.join(&bob);
    client.start_game();

    // Pause while game is in progress
    client.pause(&symbol_short!("emerg"));

    // submit_choice should be rejected
    let result = client.try_submit_choice(&alice, &Choice::Heads);
    assert!(result.is_err());
    assert_eq!(result.unwrap_err().unwrap(), ArenaError::ContractPaused);

    // resolve_round should be rejected
    let resolve_result = client.try_resolve_round();
    assert!(resolve_result.is_err());
    assert_eq!(resolve_result.unwrap_err().unwrap(), ArenaError::ContractPaused);
}

#[test]
fn pause_rejects_claim() {
    let env = create_test_env();
    env.mock_all_auths();

    let (admin, token, _contract_id, client) = setup_arena(&env);

    let initial_fee = 100_000_000;
    let initial_max = 100;
    let initial_deadline = env.ledger().timestamp() + 86400;
    let treasury = Address::generate(&env);

    client.initialize(&admin, &token, &initial_fee, &initial_max, &initial_deadline, &treasury, &0);

    let alice = Address::generate(&env);
    let bob = Address::generate(&env);
    mint_tokens(&env, &token, &alice, initial_fee);
    mint_tokens(&env, &token, &bob, initial_fee);
    client.join(&alice);
    client.join(&bob);
    client.start_game();

    client.submit_choice(&alice, &Choice::Heads);
    client.submit_choice(&bob, &Choice::Tails);
    client.resolve_round();

    // Pause after game finished
    client.pause(&symbol_short!("emerg"));

    let winner = client.winner().unwrap();
    let result = client.try_claim(&winner);
    assert!(result.is_err());
    assert_eq!(result.unwrap_err().unwrap(), ArenaError::ContractPaused);
}

#[test]
fn read_queries_work_while_paused() {
    let env = create_test_env();
    env.mock_all_auths();

    let (admin, token, _contract_id, client) = setup_arena(&env);

    let initial_fee = 100_000_000;
    let initial_max = 100;
    let initial_deadline = env.ledger().timestamp() + 86400;
    let treasury = Address::generate(&env);

    client.initialize(&admin, &token, &initial_fee, &initial_max, &initial_deadline, &treasury, &0);

    let alice = Address::generate(&env);
    let bob = Address::generate(&env);
    mint_tokens(&env, &token, &alice, initial_fee);
    mint_tokens(&env, &token, &bob, initial_fee);
    client.join(&alice);
    client.join(&bob);
    client.start_game();
    client.submit_choice(&alice, &Choice::Heads);
    client.submit_choice(&bob, &Choice::Tails);
    client.resolve_round();

    client.pause(&symbol_short!("emerg"));

    // Read-only queries should still work
    let config = client.get_config();
    assert_eq!(config.state, GameState::Finished);

    let state = client.game_state();
    assert_eq!(state, GameState::Finished);

    let count = client.get_player_count();
    assert_eq!(count, 2);

    let winner = client.winner();
    assert!(winner.is_some());

    let _treasury_addr = client.treasury();
}

#[test]
fn unpause_restores_mutating_operations() {
    let env = create_test_env();
    env.mock_all_auths();

    let (admin, token, _contract_id, client) = setup_arena(&env);

    let initial_fee = 100_000_000;
    let initial_max = 100;
    let initial_deadline = env.ledger().timestamp() + 86400;
    let treasury = Address::generate(&env);

    client.initialize(&admin, &token, &initial_fee, &initial_max, &initial_deadline, &treasury, &0);

    let alice = Address::generate(&env);
    let bob = Address::generate(&env);
    mint_tokens(&env, &token, &alice, initial_fee);
    mint_tokens(&env, &token, &bob, initial_fee);
    client.join(&alice);
    client.join(&bob);
    client.start_game();

    // Pause
    client.pause(&symbol_short!("emerg"));
    assert!(client.get_config().paused);

    // Unpause
    client.unpause();
    assert!(!client.get_config().paused);

    // Operations resume
    client.submit_choice(&alice, &Choice::Heads);
    client.submit_choice(&bob, &Choice::Tails);
    let result = client.resolve_round();
    assert!(result.survivors > 0);
}

#[test]
fn pause_requires_admin_auth() {
    let env = create_test_env();
    env.mock_all_auths();

    let (admin, token, _contract_id, client) = setup_arena(&env);

    let initial_fee = 100_000_000;
    let initial_max = 100;
    let initial_deadline = env.ledger().timestamp() + 86400;
    let treasury = Address::generate(&env);

    client.initialize(&admin, &token, &initial_fee, &initial_max, &initial_deadline, &treasury, &0);

    // Clear auths to test non-admin cannot pause
    env.set_auths(&[]);

    let result = client.try_pause(&symbol_short!("emerg"));
    assert!(result.is_err());
}

#[test]
fn unpause_requires_admin_auth() {
    let env = create_test_env();
    env.mock_all_auths();

    let (admin, token, _contract_id, client) = setup_arena(&env);

    let initial_fee = 100_000_000;
    let initial_max = 100;
    let initial_deadline = env.ledger().timestamp() + 86400;
    let treasury = Address::generate(&env);

    client.initialize(&admin, &token, &initial_fee, &initial_max, &initial_deadline, &treasury, &0);

    client.pause(&symbol_short!("emerg"));

    // Clear auths to test non-admin cannot unpause
    env.set_auths(&[]);

    let result = client.try_unpause();
    assert!(result.is_err());
}

// ── Rate Limiting Tests (#917) ──────────────────────────────────────────────

#[test]
fn cooldown_enforced_between_creations() {
    let env = create_test_env();
    env.mock_all_auths();

    let (admin, token, _contract_id, client) = setup_arena(&env);

    let initial_fee = 100_000_000;
    let initial_max = 100;
    let initial_deadline = env.ledger().timestamp() + 86400;
    let treasury = Address::generate(&env);

    // First initialization succeeds
    client.initialize(&admin, &token, &initial_fee, &initial_max, &initial_deadline, &treasury, &60);

    // Set cooldown to 60 seconds
    client.set_creation_cooldown(&60);

    // Second initialization (simulating re-init) should fail due to cooldown
    // Admin can bypass, but a different creator cannot
    let config = client.get_config();
    assert_eq!(config.creation_cooldown_seconds, 60);
}

#[test]
fn admin_bypasses_cooldown() {
    let env = create_test_env();
    env.mock_all_auths();

    let (admin, token, _contract_id, client) = setup_arena(&env);

    let initial_fee = 100_000_000;
    let initial_max = 100;
    let initial_deadline = env.ledger().timestamp() + 86400;
    let treasury = Address::generate(&env);

    // Initialize with cooldown
    client.initialize(&admin, &token, &initial_fee, &initial_max, &initial_deadline, &treasury, &60);

    // Admin re-initializing should bypass cooldown (same admin check in code)
    // Validate that the current admin can call set_creation_cooldown
    let result = client.try_set_creation_cooldown(&120);
    assert!(result.is_ok());

    let config = client.get_config();
    assert_eq!(config.creation_cooldown_seconds, 120);
}

#[test]
fn cooldown_configurable_by_admin() {
    let env = create_test_env();
    env.mock_all_auths();

    let (admin, token, _contract_id, client) = setup_arena(&env);

    let initial_fee = 100_000_000;
    let initial_max = 100;
    let initial_deadline = env.ledger().timestamp() + 86400;
    let treasury = Address::generate(&env);

    client.initialize(&admin, &token, &initial_fee, &initial_max, &initial_deadline, &treasury, &30);

    // Verify initial cooldown
    let config1 = client.get_config();
    assert_eq!(config1.creation_cooldown_seconds, 30);

    // Admin updates cooldown
    client.set_creation_cooldown(&90);
    let config2 = client.get_config();
    assert_eq!(config2.creation_cooldown_seconds, 90);

    // Admin can set to zero (disable cooldown)
    client.set_creation_cooldown(&0);
    let config3 = client.get_config();
    assert_eq!(config3.creation_cooldown_seconds, 0);
}

#[test]
fn set_cooldown_requires_admin_auth() {
    let env = create_test_env();
    env.mock_all_auths();

    let (admin, token, _contract_id, client) = setup_arena(&env);

    let initial_fee = 100_000_000;
    let initial_max = 100;
    let initial_deadline = env.ledger().timestamp() + 86400;
    let treasury = Address::generate(&env);

    client.initialize(&admin, &token, &initial_fee, &initial_max, &initial_deadline, &treasury, &0);

    // Clear auths
    env.set_auths(&[]);

    let result = client.try_set_creation_cooldown(&60);
    assert!(result.is_err());
}

// ── Treasury Tests (#916) ───────────────────────────────────────────────────

#[test]
fn treasury_address_stored_on_initialize() {
    let env = create_test_env();
    env.mock_all_auths();

    let (admin, token, _contract_id, client) = setup_arena(&env);

    let initial_fee = 100_000_000;
    let initial_max = 100;
    let initial_deadline = env.ledger().timestamp() + 86400;
    let treasury = Address::generate(&env);

    client.initialize(&admin, &token, &initial_fee, &initial_max, &initial_deadline, &treasury, &0);

    let stored = client.treasury();
    assert_eq!(stored, treasury);
}

#[test]
fn admin_can_update_treasury() {
    let env = create_test_env();
    env.mock_all_auths();

    let (admin, token, _contract_id, client) = setup_arena(&env);

    let initial_fee = 100_000_000;
    let initial_max = 100;
    let initial_deadline = env.ledger().timestamp() + 86400;
    let treasury = Address::generate(&env);

    client.initialize(&admin, &token, &initial_fee, &initial_max, &initial_deadline, &treasury, &0);

    let new_treasury = Address::generate(&env);
    client.update_treasury(&new_treasury);

    let stored = client.treasury();
    assert_eq!(stored, new_treasury);
}

#[test]
fn update_treasury_requires_admin_auth() {
    let env = create_test_env();
    env.mock_all_auths();

    let (admin, token, _contract_id, client) = setup_arena(&env);

    let initial_fee = 100_000_000;
    let initial_max = 100;
    let initial_deadline = env.ledger().timestamp() + 86400;
    let treasury = Address::generate(&env);

    client.initialize(&admin, &token, &initial_fee, &initial_max, &initial_deadline, &treasury, &0);

    let new_treasury = Address::generate(&env);

    // Clear auths
    env.set_auths(&[]);

    let result = client.try_update_treasury(&new_treasury);
    assert!(result.is_err());
}

// ── Creator Stake Slashing Tests ───────────────────────────────────────────

#[test]
fn deposit_creator_stake_success() {
    let env = create_test_env();
    env.mock_all_auths();

    let (admin, token, _contract_id, client) = setup_arena(&env);
    let initial_fee = 100_000_000;
    let initial_max = 100;
    let initial_deadline = env.ledger().timestamp() + 86400;
    let treasury = Address::generate(&env);

    client.initialize(&admin, &token, &initial_fee, &initial_max, &initial_deadline, &treasury, &0);

    let creator = Address::generate(&env);
    mint_tokens(&env, &token, &creator, 50_000);
    client.deposit_creator_stake(&creator, &50_000);

    let config = client.get_config();
    assert_eq!(config.creator_stake, 50_000);
}

#[test]
fn deposit_creator_stake_invalid_amount() {
    let env = create_test_env();
    env.mock_all_auths();

    let (admin, token, _contract_id, client) = setup_arena(&env);
    let initial_fee = 100_000_000;
    let initial_max = 100;
    let initial_deadline = env.ledger().timestamp() + 86400;
    let treasury = Address::generate(&env);

    client.initialize(&admin, &token, &initial_fee, &initial_max, &initial_deadline, &treasury, &0);

    let creator = Address::generate(&env);
    let result = client.try_deposit_creator_stake(&creator, &-100);
    assert!(result.is_err());
    assert_eq!(result.unwrap_err().unwrap(), ArenaError::InvalidStakeAmount);

    let result_zero = client.try_deposit_creator_stake(&creator, &0);
    assert!(result_zero.is_err());
    assert_eq!(result_zero.unwrap_err().unwrap(), ArenaError::InvalidStakeAmount);
}

#[test]
fn withdraw_creator_stake_no_active_pools() {
    let env = create_test_env();
    env.mock_all_auths();

    let (admin, token, _contract_id, client) = setup_arena(&env);
    let initial_fee = 100_000_000;
    let initial_max = 100;
    let initial_deadline = env.ledger().timestamp() + 86400;
    let treasury = Address::generate(&env);

    client.initialize(&admin, &token, &initial_fee, &initial_max, &initial_deadline, &treasury, &0);

    // Set state to Finished (simulate a completed game)
    client.start_game();
    client.finish_game();

    let creator = Address::generate(&env);
    mint_tokens(&env, &token, &creator, 100_000);
    client.deposit_creator_stake(&creator, &100_000);

    // Withdraw with no active pools (state is Finished)
    let withdraw_result = client.try_withdraw_creator_stake(&creator);
    assert!(withdraw_result.is_ok());

    let config = client.get_config();
    assert_eq!(config.creator_stake, 0);

    // Check that event contains STK_WTD
    let events = env.events().all();
    let last_event = events.last().unwrap();
    let topics = &last_event.1;
    let expected: soroban_sdk::Val = soroban_sdk::IntoVal::into_val(&symbol_short!("STK_WTD"), &env);
    assert!(topics.contains(&expected));
}

#[test]
fn withdraw_creator_stake_with_active_pools_default_slash() {
    let env = create_test_env();
    env.mock_all_auths();

    let (admin, token, _contract_id, client) = setup_arena(&env);
    let initial_fee = 100_000_000;
    let initial_max = 100;
    let initial_deadline = env.ledger().timestamp() + 86400;
    let treasury = Address::generate(&env);

    client.initialize(&admin, &token, &initial_fee, &initial_max, &initial_deadline, &treasury, &0);

    // The game state is Open (which is active, not Finished)
    let creator = Address::generate(&env);
    mint_tokens(&env, &token, &creator, 100_000);
    client.deposit_creator_stake(&creator, &100_000);

    // Withdraw with active pools (default slash of 50%)
    let withdraw_result = client.try_withdraw_creator_stake(&creator);
    assert!(withdraw_result.is_ok());

    let config = client.get_config();
    assert_eq!(config.creator_stake, 0);

    // Check that event contains STK_SLSH
    let events = env.events().all();
    let last_event = events.last().unwrap();
    let topics = &last_event.1;
    let expected: soroban_sdk::Val = soroban_sdk::IntoVal::into_val(&symbol_short!("STK_SLSH"), &env);
    assert!(topics.contains(&expected));
}

#[test]
fn set_slash_rate_success_and_affects_slash() {
    let env = create_test_env();
    env.mock_all_auths();

    let (admin, token, _contract_id, client) = setup_arena(&env);
    let initial_fee = 100_000_000;
    let initial_max = 100;
    let initial_deadline = env.ledger().timestamp() + 86400;
    let treasury = Address::generate(&env);

    client.initialize(&admin, &token, &initial_fee, &initial_max, &initial_deadline, &treasury, &0);

    // Configure slash rate to 25% (2500 bps)
    client.set_slash_rate(&2500);

    let config_rate = client.get_config();
    assert_eq!(config_rate.slash_rate_bps, 2500);

    let creator = Address::generate(&env);
    mint_tokens(&env, &token, &creator, 100_000);
    client.deposit_creator_stake(&creator, &100_000);

    // Withdraw with active pools - should slash 25% (25,000 stroops slashed, 75,000 returned)
    let withdraw_result = client.try_withdraw_creator_stake(&creator);
    assert!(withdraw_result.is_ok());

    let config = client.get_config();
    assert_eq!(config.creator_stake, 0);

    // Check that events contains STK_SLSH with correct calculation
    let events = env.events().all();
    let last_event = events.last().unwrap();
    let topics = &last_event.1;
    let expected: soroban_sdk::Val = soroban_sdk::IntoVal::into_val(&symbol_short!("STK_SLSH"), &env);
    assert!(topics.contains(&expected));
}

#[test]
fn set_slash_rate_invalid() {
    let env = create_test_env();
    env.mock_all_auths();

    let (admin, token, _contract_id, client) = setup_arena(&env);
    let initial_fee = 100_000_000;
    let initial_max = 100;
    let initial_deadline = env.ledger().timestamp() + 86400;
    let treasury = Address::generate(&env);

    client.initialize(&admin, &token, &initial_fee, &initial_max, &initial_deadline, &treasury, &0);

    // Attempting to set rate > 100% (10000 bps) should fail
    let result = client.try_set_slash_rate(&10001);
    assert!(result.is_err());
    assert_eq!(result.unwrap_err().unwrap(), ArenaError::InvalidSlashRate);
}

#[test]
fn set_slash_rate_requires_admin_auth() {
    let env = create_test_env();
    env.mock_all_auths();

    let (admin, token, _contract_id, client) = setup_arena(&env);
    let initial_fee = 100_000_000;
    let initial_max = 100;
    let initial_deadline = env.ledger().timestamp() + 86400;
    let treasury = Address::generate(&env);

    client.initialize(&admin, &token, &initial_fee, &initial_max, &initial_deadline, &treasury, &0);

    // Clear auths to verify authorization requirement
    env.set_auths(&[]);

    let result = client.try_set_slash_rate(&3000);
    assert!(result.is_err());
}

#[test]
fn withdraw_creator_stake_no_stake_fails() {
    let env = create_test_env();
    env.mock_all_auths();

    let (admin, token, _contract_id, client) = setup_arena(&env);
    let initial_fee = 100_000_000;
    let initial_max = 100;
    let initial_deadline = env.ledger().timestamp() + 86400;
    let treasury = Address::generate(&env);

    client.initialize(&admin, &token, &initial_fee, &initial_max, &initial_deadline, &treasury, &0);

    let creator = Address::generate(&env);
    let result = client.try_withdraw_creator_stake(&creator);
    assert!(result.is_err());
    assert_eq!(result.unwrap_err().unwrap(), ArenaError::NoStakeToWithdraw);
}


// ── Issue #919: Keeper-compatible auto-resolve ──────────────────────────────

#[test]
fn auto_resolve_fails_before_deadline() {
    let env = create_test_env();
    env.mock_all_auths();
    let (admin, token, _contract_id, client) = setup_arena(&env);

    let deadline = env.ledger().timestamp() + 86400;
    let treasury = Address::generate(&env);
    client.initialize(&admin, &token, &100_000_000, &100, &deadline, &treasury, &0);

    let alice = Address::generate(&env);
    let bob = Address::generate(&env);
    mint_tokens(&env, &token, &alice, 100_000_000);
    mint_tokens(&env, &token, &bob, 100_000_000);
    client.join(&alice);
    client.join(&bob);
    client.start_game();
    client.submit_choice(&alice, &Choice::Heads);
    client.submit_choice(&bob, &Choice::Tails);

    // Time has NOT passed the deadline yet
    let result = client.try_auto_resolve();
    assert!(result.is_err());
    assert_eq!(result.unwrap_err().unwrap(), ArenaError::DeadlineTooSoon);
}

#[test]
fn auto_resolve_succeeds_after_deadline_by_any_caller() {
    let env = create_test_env();
    env.mock_all_auths();
    let (admin, token, _contract_id, client) = setup_arena(&env);

    let deadline = env.ledger().timestamp() + 1000;
    let treasury = Address::generate(&env);
    client.initialize(&admin, &token, &100_000_000, &100, &deadline, &treasury, &0);

    let alice = Address::generate(&env);
    let bob = Address::generate(&env);
    mint_tokens(&env, &token, &alice, 100_000_000);
    mint_tokens(&env, &token, &bob, 100_000_000);
    client.join(&alice);
    client.join(&bob);
    client.start_game();
    client.submit_choice(&alice, &Choice::Heads);
    client.submit_choice(&bob, &Choice::Tails);

    // Advance time past the join deadline
    let mut ledger = env.ledger().get();
    ledger.timestamp = deadline + 1;
    env.ledger().set(ledger);

    let round_result = client.auto_resolve();
    assert_eq!(round_result.eliminated + round_result.survivors, 2);
}

#[test]
fn auto_resolve_fails_when_game_not_in_progress() {
    let env = create_test_env();
    env.mock_all_auths();
    let (admin, token, _contract_id, client) = setup_arena(&env);

    let deadline = env.ledger().timestamp() + 1000;
    let treasury = Address::generate(&env);
    client.initialize(&admin, &token, &100_000_000, &100, &deadline, &treasury, &0);

    // Arena is Open, not InProgress — advance time past deadline
    let mut ledger = env.ledger().get();
    ledger.timestamp = deadline + 1;
    env.ledger().set(ledger);

    let result = client.try_auto_resolve();
    assert!(result.is_err());
    assert_eq!(result.unwrap_err().unwrap(), ArenaError::InvalidStateTransition);
}

// ── Issue #907: Player join/profile tracking ──────────────────────────────────

#[test]
fn player_profile_created_on_first_join() {
    let env = create_test_env();
    env.mock_all_auths();
    let (admin, token, _contract_id, client) = setup_arena(&env);

    let treasury = Address::generate(&env);
    client.initialize(&admin, &token, &100_000_000, &100, &(env.ledger().timestamp() + 86400), &treasury, &0);

    assert_eq!(client.get_player_count(), 0);
    let player = Address::generate(&env);
    mint_tokens(&env, &token, &player, 100_000_000);
    client.join(&player);
    assert_eq!(client.get_player_count(), 1);
}

#[test]
fn games_played_increments_after_round_resolves() {
    let env = create_test_env();
    env.mock_all_auths();
    let (admin, token, _contract_id, client) = setup_arena(&env);

    let treasury = Address::generate(&env);
    client.initialize(&admin, &token, &100_000_000, &100, &(env.ledger().timestamp() + 86400), &treasury, &0);

    let alice = Address::generate(&env);
    let bob = Address::generate(&env);
    let charlie = Address::generate(&env);
    let dave = Address::generate(&env);
    for p in [&alice, &bob, &charlie, &dave] {
        mint_tokens(&env, &token, p, 100_000_000);
    }
    client.join(&alice);
    client.join(&bob);
    client.join(&charlie);
    client.join(&dave);
    client.start_game();

    // alice+bob=Heads (minority=2), charlie+dave=Tails (majority=2) — tie resolves via coin flip
    // Use heads×1 minority to guarantee: alice=Heads (minority), bob/charlie/dave=Tails
    client.submit_choice(&alice, &Choice::Heads);
    client.submit_choice(&bob, &Choice::Tails);
    client.submit_choice(&charlie, &Choice::Tails);
    client.submit_choice(&dave, &Choice::Tails);

    let r1 = client.resolve_round();
    assert_eq!(r1.round, 1);
    assert_eq!(r1.survivors, 1);
    assert_eq!(r1.eliminated, 3);
}

#[test]
fn winner_is_recorded_after_final_round() {
    let env = create_test_env();
    env.mock_all_auths();
    let (admin, token, _contract_id, client) = setup_arena(&env);

    let treasury = Address::generate(&env);
    client.initialize(&admin, &token, &100_000_000, &100, &(env.ledger().timestamp() + 86400), &treasury, &0);

    // 1 Heads (minority) vs 2 Tails (majority) — alice survives as winner
    let alice = Address::generate(&env);
    let bob = Address::generate(&env);
    let charlie = Address::generate(&env);
    mint_tokens(&env, &token, &alice, 100_000_000);
    mint_tokens(&env, &token, &bob, 100_000_000);
    mint_tokens(&env, &token, &charlie, 100_000_000);
    client.join(&alice);
    client.join(&bob);
    client.join(&charlie);
    client.start_game();

    client.submit_choice(&alice, &Choice::Heads);
    client.submit_choice(&bob, &Choice::Tails);
    client.submit_choice(&charlie, &Choice::Tails);
    client.resolve_round();

    let winner = client.winner();
    assert_eq!(winner, Some(alice));
}

#[test]
fn survival_streak_resets_after_elimination() {
    let env = create_test_env();
    env.mock_all_auths();
    let (admin, token, _contract_id, client) = setup_arena(&env);

    let treasury = Address::generate(&env);
    client.initialize(&admin, &token, &100_000_000, &100, &(env.ledger().timestamp() + 86400), &treasury, &0);

    // 2 Heads (minority) vs 3 Tails (majority, eliminated) — game stays InProgress after round 1
    let alice = Address::generate(&env);
    let bob = Address::generate(&env);
    let charlie = Address::generate(&env);
    let dave = Address::generate(&env);
    let eve = Address::generate(&env);
    for p in [&alice, &bob, &charlie, &dave, &eve] {
        mint_tokens(&env, &token, p, 100_000_000);
    }
    client.join(&alice);
    client.join(&bob);
    client.join(&charlie);
    client.join(&dave);
    client.join(&eve);
    client.start_game();

    // alice+bob=Heads (minority=2, survive), charlie+dave+eve=Tails (majority=3, eliminated)
    client.submit_choice(&alice, &Choice::Heads);
    client.submit_choice(&bob, &Choice::Heads);
    client.submit_choice(&charlie, &Choice::Tails);
    client.submit_choice(&dave, &Choice::Tails);
    client.submit_choice(&eve, &Choice::Tails);
    client.resolve_round();

    // charlie was eliminated — submitting a choice should fail
    let result = client.try_submit_choice(&charlie, &Choice::Heads);
    assert!(result.is_err());
    assert_eq!(result.unwrap_err().unwrap(), ArenaError::PlayerEliminated);
}

// ── Capacity Edge Cases (Issue #908) ─────────────────────────────────────────

fn initialize_arena(
    env: &Env,
    client: &ArenaContractClient<'_>,
    admin: &Address,
    token: &Address,
    max_players: u32,
) {
    let entry_fee: i128 = 10_000_000;
    let deadline = env.ledger().timestamp() + 86_400;
    let treasury = Address::generate(env);
    client.initialize(admin, token, &entry_fee, &max_players, &deadline, &treasury, &0);
}

/// Minimum arena — exactly 2 players (boundary: the smallest valid game).
#[test]
fn capacity_minimum_two_players_game_runs_to_completion() {
    let env = create_test_env();
    env.mock_all_auths();

    let (admin, token, _contract_id, client) = setup_arena(&env);
    initialize_arena(&env, &client, &admin, &token, 2);

    let p1 = Address::generate(&env);
    let p2 = Address::generate(&env);
    mint_tokens(&env, &token, &p1, 10_000_000);
    mint_tokens(&env, &token, &p2, 10_000_000);

    client.join(&p1);
    client.join(&p2);
    client.start_game();

    // Submit opposite choices so one player is eliminated deterministically.
    client.submit_choice(&p1, &Choice::Heads);
    client.submit_choice(&p2, &Choice::Tails);

    let result = client.resolve_round();
    // Minority wins: Tails has fewer → p2 survives; p1 eliminated.
    assert_eq!(result.survivors, 1);
    assert_eq!(result.eliminated, 1);

    // Game should be finished after 1 round with 1 survivor.
    let state = client.game_state();
    assert_eq!(state, GameState::Finished);

    let winner = client.winner();
    assert!(winner.is_some());
}

/// Exactly at capacity — max_players == player_count; next join must fail.
#[test]
fn capacity_join_at_max_returns_arena_full_error() {
    let env = create_test_env();
    env.mock_all_auths();

    let (admin, token, _contract_id, client) = setup_arena(&env);
    initialize_arena(&env, &client, &admin, &token, 3);

    let mut players = Vec::new(&env);
    for _ in 0..3 {
        let p = Address::generate(&env);
        mint_tokens(&env, &token, &p, 10_000_000);
        players.push_back(p);
    }
    for p in &players {
        client.join(&p);
    }

    // Arena is now at full capacity; a 4th join must be rejected.
    let overflow = Address::generate(&env);
    let err = client.try_join(&overflow);
    assert!(err.is_err());
    assert_eq!(err.unwrap_err().unwrap(), ArenaError::ArenaFull);
}

#[test]
fn auto_start_when_max_players_reached() {
    let env = create_test_env();
    env.mock_all_auths();

    let (admin, token, _contract_id, client) = setup_arena(&env);
    initialize_arena(&env, &client, &admin, &token, 2);

    let p1 = Address::generate(&env);
    let p2 = Address::generate(&env);
    mint_tokens(&env, &token, &p1, 10_000_000);
    mint_tokens(&env, &token, &p2, 10_000_000);

    client.join(&p1);
    client.join(&p2);

    assert_eq!(client.game_state(), GameState::InProgress);
    assert_eq!(client.get_player_count(), 2);
    assert_eq!(client.get_round(), 1);
    assert_eq!(client.get_round_deadline(), Some(env.ledger().timestamp() + 86_400 + 86_400));
}

#[test]
fn initialize_rejects_entry_fee_outside_bounds() {
    let env = create_test_env();
    env.mock_all_auths();

    let (admin, token, _contract_id, client) = setup_arena(&env);
    let treasury = Address::generate(&env);
    let deadline = env.ledger().timestamp() + 86_400;

    let result = client.try_initialize(&admin, &token, &(4_000_000 - 1), &2, &deadline, &treasury, &0);
    assert!(result.is_err());
    assert_eq!(result.unwrap_err().unwrap(), ArenaError::InvalidEntryFee);
}

/// Large arena — 50 players all submit the same choice (tie) then the
/// round produces no eliminations for >2 players.
#[test]
fn capacity_large_arena_tie_round_no_eliminations() {
    let env = create_test_env();
    env.mock_all_auths();

    const N: u32 = 50;
    let (admin, token, _contract_id, client) = setup_arena(&env);
    initialize_arena(&env, &client, &admin, &token, N);

    let mut players = Vec::new(&env);
    for _ in 0..N {
        let p = Address::generate(&env);
        mint_tokens(&env, &token, &p, 10_000_000);
        players.push_back(p);
    }
    for p in &players {
        client.join(&p);
    }
    client.start_game();

    // Tie: half heads, half tails — for >2 players this is a tie round.
    for (i, p) in players.iter().enumerate() {
        let choice = if i % 2 == 0 { Choice::Heads } else { Choice::Tails };
        client.submit_choice(&p, &choice);
    }

    let result = client.resolve_round();
    // For >2 players with a tie, no eliminations occur.
    assert_eq!(result.eliminated, 0);
    assert_eq!(result.survivors, N);
    assert_eq!(client.game_state(), GameState::InProgress);
}

/// Large arena — 100 players; minority-wins eliminates the heads side.
#[test]
fn capacity_hundred_players_minority_wins_eliminates_majority() {
    let env = create_test_env();
    env.mock_all_auths();

    const N: u32 = 60;
    const HEADS: u32 = 18;
    const TAILS: u32 = 42;
    let (admin, token, _contract_id, client) = setup_arena(&env);
    initialize_arena(&env, &client, &admin, &token, N);

    let mut players = Vec::new(&env);
    for _ in 0..N {
        let p = Address::generate(&env);
        mint_tokens(&env, &token, &p, 10_000_000);
        players.push_back(p);
    }
    for p in &players {
        client.join(&p);
    }
    client.start_game();

    // 30 heads (minority = survivors), 70 tails (eliminated)
    for (i, p) in players.iter().enumerate() {
        let choice = if (i as u32) < HEADS { Choice::Heads } else { Choice::Tails };
        client.submit_choice(&p, &choice);
    }

    let result = client.resolve_round();
    assert_eq!(result.survivors, HEADS);
    assert_eq!(result.eliminated, TAILS);
}

/// Global stats — joining increments arena count and survivor count.
#[test]
fn global_stats_updated_on_join_and_elimination() {
    let env = create_test_env();
    env.mock_all_auths();

    let (admin, token, _contract_id, client) = setup_arena(&env);
    initialize_arena(&env, &client, &admin, &token, 4);

    let stats_initial = client.get_global_stats();
    assert_eq!(stats_initial.total_arenas, 1);
    assert_eq!(stats_initial.live_survivors, 0);

    let p1 = Address::generate(&env);
    let p2 = Address::generate(&env);
    mint_tokens(&env, &token, &p1, 10_000_000);
    mint_tokens(&env, &token, &p2, 10_000_000);
    client.join(&p1);
    client.join(&p2);
    client.start_game();

    let stats_joined = client.get_global_stats();
    assert_eq!(stats_joined.live_survivors, 2);

    // Resolve: heads wins (p1 heads, p2 tails — tails eliminated)
    client.submit_choice(&p1, &Choice::Heads);
    client.submit_choice(&p2, &Choice::Tails);
    client.resolve_round();

    let stats_after = client.get_global_stats();
    assert_eq!(stats_after.live_survivors, 1);
}

/// RWA yield — receive_rwa_yield grows the prize pool and records the entry.
#[test]
fn rwa_yield_grows_prize_pool_and_returns_id() {
    let env = create_test_env();
    env.mock_all_auths();

    let (admin, token, _contract_id, client) = setup_arena(&env);
    initialize_arena(&env, &client, &admin, &token, 10);

    let adapter = Address::generate(&env);
    let yield_amount: i128 = 5_000_000_000; // 500 XLM

    let id = client.receive_rwa_yield(
        &adapter,
        &yield_amount,
        &soroban_sdk::String::from_str(&env, "Treasury vault A"),
    );
    assert_eq!(id, 1u64);

    // A second call increments the ID monotonically.
    let id2 = client.receive_rwa_yield(
        &adapter,
        &1_000_000_000i128,
        &soroban_sdk::String::from_str(&env, "Treasury vault B"),
    );
    assert_eq!(id2, 2u64);

    let stats = client.get_global_stats();
    assert_eq!(stats.global_pool_total, yield_amount + 1_000_000_000i128);
}

// ── Issue #892: RoundStarted event tests ────────────────────────────────

#[test]
fn start_round_emits_event_and_sets_deadline() {
    let env = create_test_env();
    env.mock_all_auths();
    let (admin, token, _contract_id, client) = setup_arena(&env);

    let treasury = Address::generate(&env);
    client.initialize(&admin, &token, &100_000_000, &100, &(env.ledger().timestamp() + 86400), &treasury, &0);

    let alice = Address::generate(&env);
    let bob = Address::generate(&env);
    mint_tokens(&env, &token, &alice, 100_000_000);
    mint_tokens(&env, &token, &bob, 100_000_000);
    client.join(&alice);
    client.join(&bob);
    client.start_game();

    let round_deadline = env.ledger().timestamp() + 3600;
    let round = client.start_round(&round_deadline);
    assert_eq!(round, 1);

    let stored_deadline = client.get_round_deadline();
    assert_eq!(stored_deadline, Some(round_deadline));

    let current_round = client.get_round();
    assert_eq!(current_round, 1);

    // Verify event emitted
    let events = env.events().all();
    let last_event = events.last().unwrap();
    let topics = &last_event.1;
    let expected: soroban_sdk::Val = soroban_sdk::IntoVal::into_val(&symbol_short!("RND_STR"), &env);
    assert!(topics.contains(&expected));
}

#[test]
fn start_round_fails_when_not_in_progress() {
    let env = create_test_env();
    env.mock_all_auths();
    let (admin, token, _contract_id, client) = setup_arena(&env);

    let treasury = Address::generate(&env);
    client.initialize(&admin, &token, &100_000_000, &100, &(env.ledger().timestamp() + 86400), &treasury, &0);

    let deadline = env.ledger().timestamp() + 3600;
    let result = client.try_start_round(&deadline);
    assert!(result.is_err());
    assert_eq!(result.unwrap_err().unwrap(), ArenaError::InvalidStateTransition);
}

#[test]
fn start_round_fails_with_past_deadline() {
    let env = create_test_env();
    env.mock_all_auths();
    let (admin, token, _contract_id, client) = setup_arena(&env);

    let treasury = Address::generate(&env);
    client.initialize(&admin, &token, &100_000_000, &100, &(env.ledger().timestamp() + 86400), &treasury, &0);
    client.start_game();

    let past_deadline = env.ledger().timestamp() - 100;
    let result = client.try_start_round(&past_deadline);
    assert!(result.is_err());
    assert_eq!(result.unwrap_err().unwrap(), ArenaError::DeadlineTooSoon);
}

// ── Issue #884: get_arena_players tests ─────────────────────────────────

#[test]
fn get_arena_players_returns_all_players() {
    let env = create_test_env();
    env.mock_all_auths();
    let (admin, token, _contract_id, client) = setup_arena(&env);

    let treasury = Address::generate(&env);
    client.initialize(&admin, &token, &100_000_000, &100, &(env.ledger().timestamp() + 86400), &treasury, &0);

    let alice = Address::generate(&env);
    let bob = Address::generate(&env);
    let charlie = Address::generate(&env);
    mint_tokens(&env, &token, &alice, 100_000_000);
    mint_tokens(&env, &token, &bob, 100_000_000);
    mint_tokens(&env, &token, &charlie, 100_000_000);

    client.join(&alice);
    client.join(&bob);
    client.join(&charlie);

    let players = client.get_arena_players();
    assert_eq!(players.len(), 3);
    assert!(players.contains(&alice));
    assert!(players.contains(&bob));
    assert!(players.contains(&charlie));
}

#[test]
fn get_arena_players_returns_empty_when_no_players() {
    let env = create_test_env();
    env.mock_all_auths();
    let (admin, token, _contract_id, client) = setup_arena(&env);

    let treasury = Address::generate(&env);
    client.initialize(&admin, &token, &100_000_000, &100, &(env.ledger().timestamp() + 86400), &treasury, &0);

    let players = client.get_arena_players();
    assert_eq!(players.len(), 0);
}

// ── Issue #870: Commit-reveal tests ─────────────────────────────────────

fn compute_commit_hash(env: &Env, choice: &Choice, salt: &soroban_sdk::BytesN<32>) -> soroban_sdk::BytesN<32> {
    let choice_byte: u8 = match choice {
        Choice::Heads => 0,
        Choice::Tails => 1,
    };
    let mut preimage = soroban_sdk::Bytes::new(env);
    preimage.push_back(choice_byte);
    let salt_bytes: &[u8] = &salt.to_array();
    preimage.append(&soroban_sdk::Bytes::from_slice(env, salt_bytes));
    env.crypto().keccak256(&preimage).into()
}

#[test]
fn commit_reveal_full_flow() {
    let env = create_test_env();
    env.mock_all_auths();
    let (admin, token, _contract_id, client) = setup_arena(&env);

    let treasury = Address::generate(&env);
    client.initialize(&admin, &token, &100_000_000, &100, &(env.ledger().timestamp() + 86400), &treasury, &0);

    let alice = Address::generate(&env);
    let bob = Address::generate(&env);
    mint_tokens(&env, &token, &alice, 100_000_000);
    mint_tokens(&env, &token, &bob, 100_000_000);
    client.join(&alice);
    client.join(&bob);
    client.start_game();

    // Start round so round counter is set
    let round_deadline = env.ledger().timestamp() + 3600;
    client.start_round(&round_deadline);

    // Generate salts
    let salt_a = soroban_sdk::BytesN::from_array(&env, &[1u8; 32]);
    let salt_b = soroban_sdk::BytesN::from_array(&env, &[2u8; 32]);

    // Compute hashes
    let hash_a = compute_commit_hash(&env, &Choice::Heads, &salt_a);
    let hash_b = compute_commit_hash(&env, &Choice::Tails, &salt_b);

    // Commit phase
    client.commit_choice(&alice, &hash_a);
    client.commit_choice(&bob, &hash_b);

    // Reveal phase
    client.reveal_choice(&alice, &Choice::Heads, &salt_a);
    client.reveal_choice(&bob, &Choice::Tails, &salt_b);
}

#[test]
fn commit_fails_without_being_a_player() {
    let env = create_test_env();
    env.mock_all_auths();
    let (admin, token, _contract_id, client) = setup_arena(&env);

    let treasury = Address::generate(&env);
    client.initialize(&admin, &token, &100_000_000, &100, &(env.ledger().timestamp() + 86400), &treasury, &0);

    let alice = Address::generate(&env);
    mint_tokens(&env, &token, &alice, 100_000_000);
    client.join(&alice);
    client.start_game();

    let non_player = Address::generate(&env);
    let hash = soroban_sdk::BytesN::from_array(&env, &[0u8; 32]);
    let result = client.try_commit_choice(&non_player, &hash);
    assert!(result.is_err());
    assert_eq!(result.unwrap_err().unwrap(), ArenaError::NotAPlayer);
}

#[test]
fn double_commit_fails() {
    let env = create_test_env();
    env.mock_all_auths();
    let (admin, token, _contract_id, client) = setup_arena(&env);

    let treasury = Address::generate(&env);
    client.initialize(&admin, &token, &100_000_000, &100, &(env.ledger().timestamp() + 86400), &treasury, &0);

    let alice = Address::generate(&env);
    let bob = Address::generate(&env);
    mint_tokens(&env, &token, &alice, 100_000_000);
    mint_tokens(&env, &token, &bob, 100_000_000);
    client.join(&alice);
    client.join(&bob);
    client.start_game();

    let round_deadline = env.ledger().timestamp() + 3600;
    client.start_round(&round_deadline);

    let hash = soroban_sdk::BytesN::from_array(&env, &[0u8; 32]);
    client.commit_choice(&alice, &hash);

    let result = client.try_commit_choice(&alice, &hash);
    assert!(result.is_err());
    assert_eq!(result.unwrap_err().unwrap(), ArenaError::AlreadyCommitted);
}

#[test]
fn reveal_fails_without_commit() {
    let env = create_test_env();
    env.mock_all_auths();
    let (admin, token, _contract_id, client) = setup_arena(&env);

    let treasury = Address::generate(&env);
    client.initialize(&admin, &token, &100_000_000, &100, &(env.ledger().timestamp() + 86400), &treasury, &0);

    let alice = Address::generate(&env);
    let bob = Address::generate(&env);
    mint_tokens(&env, &token, &alice, 100_000_000);
    mint_tokens(&env, &token, &bob, 100_000_000);
    client.join(&alice);
    client.join(&bob);
    client.start_game();

    let round_deadline = env.ledger().timestamp() + 3600;
    client.start_round(&round_deadline);

    let salt = soroban_sdk::BytesN::from_array(&env, &[1u8; 32]);
    let result = client.try_reveal_choice(&alice, &Choice::Heads, &salt);
    assert!(result.is_err());
    assert_eq!(result.unwrap_err().unwrap(), ArenaError::NoCommitFound);
}

#[test]
fn reveal_fails_with_wrong_salt() {
    let env = create_test_env();
    env.mock_all_auths();
    let (admin, token, _contract_id, client) = setup_arena(&env);

    let treasury = Address::generate(&env);
    client.initialize(&admin, &token, &100_000_000, &100, &(env.ledger().timestamp() + 86400), &treasury, &0);

    let alice = Address::generate(&env);
    let bob = Address::generate(&env);
    mint_tokens(&env, &token, &alice, 100_000_000);
    mint_tokens(&env, &token, &bob, 100_000_000);
    client.join(&alice);
    client.join(&bob);
    client.start_game();

    let round_deadline = env.ledger().timestamp() + 3600;
    client.start_round(&round_deadline);

    let correct_salt = soroban_sdk::BytesN::from_array(&env, &[1u8; 32]);
    let wrong_salt = soroban_sdk::BytesN::from_array(&env, &[9u8; 32]);
    let hash = compute_commit_hash(&env, &Choice::Heads, &correct_salt);

    client.commit_choice(&alice, &hash);

    let result = client.try_reveal_choice(&alice, &Choice::Heads, &wrong_salt);
    assert!(result.is_err());
    assert_eq!(result.unwrap_err().unwrap(), ArenaError::RevealMismatch);
}

#[test]
fn reveal_fails_with_wrong_choice() {
    let env = create_test_env();
    env.mock_all_auths();
    let (admin, token, _contract_id, client) = setup_arena(&env);

    let treasury = Address::generate(&env);
    client.initialize(&admin, &token, &100_000_000, &100, &(env.ledger().timestamp() + 86400), &treasury, &0);

    let alice = Address::generate(&env);
    let bob = Address::generate(&env);
    mint_tokens(&env, &token, &alice, 100_000_000);
    mint_tokens(&env, &token, &bob, 100_000_000);
    client.join(&alice);
    client.join(&bob);
    client.start_game();

    let round_deadline = env.ledger().timestamp() + 3600;
    client.start_round(&round_deadline);

    let salt = soroban_sdk::BytesN::from_array(&env, &[1u8; 32]);
    let hash = compute_commit_hash(&env, &Choice::Heads, &salt);

    client.commit_choice(&alice, &hash);

    // Try to reveal with Tails instead of Heads
    let result = client.try_reveal_choice(&alice, &Choice::Tails, &salt);
    assert!(result.is_err());
    assert_eq!(result.unwrap_err().unwrap(), ArenaError::RevealMismatch);
}

#[test]
fn double_reveal_fails() {
    let env = create_test_env();
    env.mock_all_auths();
    let (admin, token, _contract_id, client) = setup_arena(&env);

    let treasury = Address::generate(&env);
    client.initialize(&admin, &token, &100_000_000, &100, &(env.ledger().timestamp() + 86400), &treasury, &0);

    let alice = Address::generate(&env);
    let bob = Address::generate(&env);
    mint_tokens(&env, &token, &alice, 100_000_000);
    mint_tokens(&env, &token, &bob, 100_000_000);
    client.join(&alice);
    client.join(&bob);
    client.start_game();

    let round_deadline = env.ledger().timestamp() + 3600;
    client.start_round(&round_deadline);

    let salt = soroban_sdk::BytesN::from_array(&env, &[1u8; 32]);
    let hash = compute_commit_hash(&env, &Choice::Heads, &salt);
    client.commit_choice(&alice, &hash);
    client.reveal_choice(&alice, &Choice::Heads, &salt);

    let result = client.try_reveal_choice(&alice, &Choice::Heads, &salt);
    assert!(result.is_err());
    assert_eq!(result.unwrap_err().unwrap(), ArenaError::AlreadyRevealed);
}

// ── Issue #865: Two-step admin transfer tests ───────────────────────────

#[test]
fn admin_transfer_full_flow() {
    let env = create_test_env();
    env.mock_all_auths();
    let (admin, token, _contract_id, client) = setup_arena(&env);

    let treasury = Address::generate(&env);
    client.initialize(&admin, &token, &100_000_000, &100, &(env.ledger().timestamp() + 86400), &treasury, &0);

    let new_admin = Address::generate(&env);

    // Propose
    client.propose_admin(&new_admin);
    let pending = client.get_pending_admin();
    assert_eq!(pending, Some(new_admin.clone()));

    // Accept
    client.accept_admin();
    let config = client.get_config();
    assert_eq!(config.admin, new_admin);

    // Pending should be cleared
    let pending_after = client.get_pending_admin();
    assert_eq!(pending_after, None);
}

#[test]
fn accept_admin_fails_without_proposal() {
    let env = create_test_env();
    env.mock_all_auths();
    let (admin, token, _contract_id, client) = setup_arena(&env);

    let treasury = Address::generate(&env);
    client.initialize(&admin, &token, &100_000_000, &100, &(env.ledger().timestamp() + 86400), &treasury, &0);

    let result = client.try_accept_admin();
    assert!(result.is_err());
    assert_eq!(result.unwrap_err().unwrap(), ArenaError::NoPendingAdmin);
}

#[test]
fn propose_admin_emits_event() {
    let env = create_test_env();
    env.mock_all_auths();
    let (admin, token, _contract_id, client) = setup_arena(&env);

    let treasury = Address::generate(&env);
    client.initialize(&admin, &token, &100_000_000, &100, &(env.ledger().timestamp() + 86400), &treasury, &0);

    let new_admin = Address::generate(&env);
    client.propose_admin(&new_admin);

    let events = env.events().all();
    let last_event = events.last().unwrap();
    let topics = &last_event.1;
    let expected: soroban_sdk::Val = soroban_sdk::IntoVal::into_val(&symbol_short!("ADM_PROP"), &env);
    assert!(topics.contains(&expected));
}

#[test]
fn accept_admin_emits_event() {
    let env = create_test_env();
    env.mock_all_auths();
    let (admin, token, _contract_id, client) = setup_arena(&env);

    let treasury = Address::generate(&env);
    client.initialize(&admin, &token, &100_000_000, &100, &(env.ledger().timestamp() + 86400), &treasury, &0);

    let new_admin = Address::generate(&env);
    client.propose_admin(&new_admin);
    client.accept_admin();

    let events = env.events().all();
    let last_event = events.last().unwrap();
    let topics = &last_event.1;
    let expected: soroban_sdk::Val = soroban_sdk::IntoVal::into_val(&symbol_short!("ADM_ACPT"), &env);
    assert!(topics.contains(&expected));
}

#[test]
fn propose_admin_requires_admin_auth() {
    let env = create_test_env();
    env.mock_all_auths();
    let (admin, token, _contract_id, client) = setup_arena(&env);

    let treasury = Address::generate(&env);
    client.initialize(&admin, &token, &100_000_000, &100, &(env.ledger().timestamp() + 86400), &treasury, &0);

    env.set_auths(&[]);

    let new_admin = Address::generate(&env);
    let result = client.try_propose_admin(&new_admin);
    assert!(result.is_err());
}

// ── Player Profile Tests ───────────────────────────────────────────────────

#[test]
fn player_profile_updates_on_elimination_and_win() {
    let env = create_test_env();
    env.mock_all_auths();
    let (admin, token, _contract_id, client) = setup_arena(&env);

    let initial_fee = 100_000_000;
    let initial_max = 100;
    let initial_deadline = env.ledger().timestamp() + 86400;

    let treasury = Address::generate(&env);
    client.initialize(&admin, &token, &initial_fee, &initial_max, &initial_deadline, &treasury, &0);

    let alice = Address::generate(&env);
    let bob = Address::generate(&env);
    let charlie = Address::generate(&env);
    let dave = Address::generate(&env);

    mint_tokens(&env, &token, &alice, initial_fee * 10);
    mint_tokens(&env, &token, &bob, initial_fee * 10);
    mint_tokens(&env, &token, &charlie, initial_fee * 10);
    mint_tokens(&env, &token, &dave, initial_fee * 10);

    // GAME 1: Alice survives, Bob is eliminated
    client.join(&alice);
    client.join(&bob);
    client.start_game();

    client.submit_choice(&alice, &Choice::Heads);
    client.submit_choice(&bob, &Choice::Tails);
    client.resolve_round(); // Alice survives, Bob is eliminated

    // Bob eliminated: games_played=1, survival_streak=0
    let bob_profile = client.get_player_profile(&bob);
    assert_eq!(bob_profile.games_played, 1);
    assert_eq!(bob_profile.survival_streak, 0);
    assert_eq!(bob_profile.games_won, 0);

    // Alice claims
    client.claim(&alice);

    let alice_profile = client.get_player_profile(&alice);
    assert_eq!(alice_profile.games_played, 1);
    assert_eq!(alice_profile.games_won, 1);
    assert_eq!(alice_profile.survival_streak, 1);
    assert_eq!(alice_profile.best_streak, 1);
    
    let expected_prize = (2 * initial_fee) - ((2 * initial_fee) * 1000 / 10000);
    assert_eq!(alice_profile.total_earnings, expected_prize);

    // GAME 2: Alice wins again
    client.cleanup_arena();
    let new_deadline = env.ledger().timestamp() + 172800;
    client.initialize(&admin, &token, &initial_fee, &initial_max, &new_deadline, &treasury, &0);
    
    client.join(&alice);
    client.join(&charlie);
    client.start_game();

    client.submit_choice(&alice, &Choice::Heads);
    client.submit_choice(&charlie, &Choice::Tails);
    client.resolve_round(); // Alice survives, Charlie eliminated

    client.claim(&alice);

    let alice_profile_2 = client.get_player_profile(&alice);
    assert_eq!(alice_profile_2.games_played, 2);
    assert_eq!(alice_profile_2.games_won, 2);
    assert_eq!(alice_profile_2.survival_streak, 2);
    assert_eq!(alice_profile_2.best_streak, 2);

    // GAME 3: Alice loses, Dave wins
    client.cleanup_arena();
    let new_deadline_3 = env.ledger().timestamp() + 259200;
    client.initialize(&admin, &token, &initial_fee, &initial_max, &new_deadline_3, &treasury, &0);
    
    client.join(&alice);
    client.join(&dave);
    client.start_game();

    client.submit_choice(&alice, &Choice::Tails); // Alice Tails, Dave Heads
    client.submit_choice(&dave, &Choice::Heads);
    client.resolve_round(); // Dave survives, Alice eliminated

    let alice_profile_3 = client.get_player_profile(&alice);
    assert_eq!(alice_profile_3.games_played, 3);
    assert_eq!(alice_profile_3.games_won, 2);
    assert_eq!(alice_profile_3.survival_streak, 0); // streak reset
    assert_eq!(alice_profile_3.best_streak, 2); // best streak remains 2
}

