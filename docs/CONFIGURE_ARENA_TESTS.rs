// Test Template for configure_arena Function
// Copy these tests to contract/arena/src/test.rs

#![cfg(test)]

use super::*;
use soroban_sdk::{
    testutils::{Address as _, Ledger as _},
    Address, Env,
};

// ── Test 1: Valid Configuration Update ────────────────────────────────────

#[test]
fn configure_arena_updates_all_parameters() {
    let env = Env::default();
    env.mock_all_auths();
    
    let admin = Address::generate(&env);
    let client = create_client(&env);
    
    // Initialize arena with default config
    let initial_fee = 100_000_000; // 10 XLM
    let initial_max = 100;
    let initial_deadline = env.ledger().timestamp() + 86400;
    
    client.initialize(&admin, &initial_fee, &initial_max, &initial_deadline);
    
    // Configure with new values
    let new_fee = 50_000_000; // 5 XLM
    let new_max = 200;
    let new_deadline = env.ledger().timestamp() + 172800; // 2 days
    
    let result = client.configure_arena(
        &Some(new_fee),
        &Some(new_max),
        &Some(new_deadline)
    );
    
    assert!(result.is_ok());
    
    // Verify configuration was updated
    let config = client.get_config();
    assert_eq!(config.entry_fee, new_fee);
    assert_eq!(config.max_players, new_max);
    assert_eq!(config.join_deadline, new_deadline);
    
    // Verify event was emitted
    let events = env.events().all();
    let last_event = events.last().unwrap();
    assert!(last_event.topics.contains(&symbol_short!("CFGD")));
}

// ── Test 2: Partial Update - Entry Fee Only ───────────────────────────────

#[test]
fn configure_arena_updates_entry_fee_only() {
    let env = Env::default();
    env.mock_all_auths();
    
    let admin = Address::generate(&env);
    let client = create_client(&env);
    
    let initial_fee = 100_000_000;
    let initial_max = 100;
    let initial_deadline = env.ledger().timestamp() + 86400;
    
    client.initialize(&admin, &initial_fee, &initial_max, &initial_deadline);
    
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
    let env = Env::default();
    env.mock_all_auths();
    
    let admin = Address::generate(&env);
    let client = create_client(&env);
    
    let initial_fee = 100_000_000;
    let initial_max = 100;
    let initial_deadline = env.ledger().timestamp() + 86400;
    
    client.initialize(&admin, &initial_fee, &initial_max, &initial_deadline);
    
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
    let env = Env::default();
    env.mock_all_auths();
    
    let admin = Address::generate(&env);
    let client = create_client(&env);
    
    let initial_fee = 100_000_000;
    let initial_max = 100;
    let initial_deadline = env.ledger().timestamp() + 86400;
    
    client.initialize(&admin, &initial_fee, &initial_max, &initial_deadline);
    
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
#[should_panic(expected = "Unauthorized")]
fn configure_arena_requires_admin_auth() {
    let env = Env::default();
    
    let admin = Address::generate(&env);
    let non_admin = Address::generate(&env);
    let client = create_client(&env);
    
    let initial_fee = 100_000_000;
    let initial_max = 100;
    let initial_deadline = env.ledger().timestamp() + 86400;
    
    env.mock_all_auths();
    client.initialize(&admin, &initial_fee, &initial_max, &initial_deadline);
    
    // Clear auth and try to configure as non-admin
    env.mock_all_auths_allowing_non_root_auth();
    
    // This should panic with Unauthorized
    client.configure_arena(&Some(50_000_000), &None, &None);
}

// ── Test 6: State Validation - InProgress ──────────────────────────────────

#[test]
fn configure_arena_fails_when_game_in_progress() {
    let env = Env::default();
    env.mock_all_auths();
    
    let admin = Address::generate(&env);
    let client = create_client(&env);
    
    let initial_fee = 100_000_000;
    let initial_max = 100;
    let initial_deadline = env.ledger().timestamp() + 86400;
    
    client.initialize(&admin, &initial_fee, &initial_max, &initial_deadline);
    
    // Start the game (transition to InProgress)
    client.start_game();
    
    // Attempt to configure should fail
    let result = client.try_configure_arena(&Some(50_000_000), &None, &None);
    
    assert!(result.is_err());
    assert_eq!(result.unwrap_err(), ArenaError::ArenaAlreadyStarted);
}

// ── Test 7: State Validation - Finished ────────────────────────────────────

#[test]
fn configure_arena_fails_when_game_finished() {
    let env = Env::default();
    env.mock_all_auths();
    
    let admin = Address::generate(&env);
    let client = create_client(&env);
    
    let initial_fee = 100_000_000;
    let initial_max = 100;
    let initial_deadline = env.ledger().timestamp() + 86400;
    
    client.initialize(&admin, &initial_fee, &initial_max, &initial_deadline);
    
    // Play game to completion (transition to Finished)
    client.start_game();
    // ... complete game logic ...
    client.finish_game();
    
    // Attempt to configure should fail
    let result = client.try_configure_arena(&Some(50_000_000), &None, &None);
    
    assert!(result.is_err());
    assert_eq!(result.unwrap_err(), ArenaError::ArenaAlreadyStarted);
}

// ── Test 8: Invalid Entry Fee - Zero ───────────────────────────────────────

#[test]
fn configure_arena_rejects_zero_entry_fee() {
    let env = Env::default();
    env.mock_all_auths();
    
    let admin = Address::generate(&env);
    let client = create_client(&env);
    
    let initial_fee = 100_000_000;
    let initial_max = 100;
    let initial_deadline = env.ledger().timestamp() + 86400;
    
    client.initialize(&admin, &initial_fee, &initial_max, &initial_deadline);
    
    // Attempt to set fee to 0
    let result = client.try_configure_arena(&Some(0), &None, &None);
    
    assert!(result.is_err());
    assert_eq!(result.unwrap_err(), ArenaError::InvalidEntryFee);
}

// ── Test 9: Invalid Entry Fee - Negative ───────────────────────────────────

#[test]
fn configure_arena_rejects_negative_entry_fee() {
    let env = Env::default();
    env.mock_all_auths();
    
    let admin = Address::generate(&env);
    let client = create_client(&env);
    
    let initial_fee = 100_000_000;
    let initial_max = 100;
    let initial_deadline = env.ledger().timestamp() + 86400;
    
    client.initialize(&admin, &initial_fee, &initial_max, &initial_deadline);
    
    // Attempt to set negative fee
    let result = client.try_configure_arena(&Some(-100), &None, &None);
    
    assert!(result.is_err());
    assert_eq!(result.unwrap_err(), ArenaError::InvalidEntryFee);
}

// ── Test 10: Invalid Deadline - Past ───────────────────────────────────────

#[test]
fn configure_arena_rejects_past_deadline() {
    let env = Env::default();
    env.mock_all_auths();
    
    let admin = Address::generate(&env);
    let client = create_client(&env);
    
    let current_time = env.ledger().timestamp();
    let initial_fee = 100_000_000;
    let initial_max = 100;
    let initial_deadline = current_time + 86400;
    
    client.initialize(&admin, &initial_fee, &initial_max, &initial_deadline);
    
    // Attempt to set deadline in the past
    let past_deadline = current_time - 1000;
    let result = client.try_configure_arena(&None, &None, &Some(past_deadline));
    
    assert!(result.is_err());
    assert_eq!(result.unwrap_err(), ArenaError::DeadlineTooSoon);
}

// ── Test 11: Invalid Deadline - Current Time ───────────────────────────────

#[test]
fn configure_arena_rejects_current_time_deadline() {
    let env = Env::default();
    env.mock_all_auths();
    
    let admin = Address::generate(&env);
    let client = create_client(&env);
    
    let current_time = env.ledger().timestamp();
    let initial_fee = 100_000_000;
    let initial_max = 100;
    let initial_deadline = current_time + 86400;
    
    client.initialize(&admin, &initial_fee, &initial_max, &initial_deadline);
    
    // Attempt to set deadline to current time
    let result = client.try_configure_arena(&None, &None, &Some(current_time));
    
    assert!(result.is_err());
    assert_eq!(result.unwrap_err(), ArenaError::DeadlineTooSoon);
}

// ── Test 12: Valid Deadline - Future ───────────────────────────────────────

#[test]
fn configure_arena_accepts_future_deadline() {
    let env = Env::default();
    env.mock_all_auths();
    
    let admin = Address::generate(&env);
    let client = create_client(&env);
    
    let current_time = env.ledger().timestamp();
    let initial_fee = 100_000_000;
    let initial_max = 100;
    let initial_deadline = current_time + 86400;
    
    client.initialize(&admin, &initial_fee, &initial_max, &initial_deadline);
    
    // Set deadline to future time
    let future_deadline = current_time + 172800; // 2 days
    let result = client.configure_arena(&None, &None, &Some(future_deadline));
    
    assert!(result.is_ok());
    
    let config = client.get_config();
    assert_eq!(config.join_deadline, future_deadline);
}

// ── Test 13: Multiple Updates ──────────────────────────────────────────────

#[test]
fn configure_arena_can_be_called_multiple_times() {
    let env = Env::default();
    env.mock_all_auths();
    
    let admin = Address::generate(&env);
    let client = create_client(&env);
    
    let initial_fee = 100_000_000;
    let initial_max = 100;
    let initial_deadline = env.ledger().timestamp() + 86400;
    
    client.initialize(&admin, &initial_fee, &initial_max, &initial_deadline);
    
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
    let env = Env::default();
    env.mock_all_auths();
    
    let admin = Address::generate(&env);
    let client = create_client(&env);
    
    let initial_fee = 100_000_000;
    let initial_max = 100;
    let initial_deadline = env.ledger().timestamp() + 86400;
    
    client.initialize(&admin, &initial_fee, &initial_max, &initial_deadline);
    
    // Clear events
    let events_before = env.events().all().len();
    
    // Configure arena
    client.configure_arena(&Some(50_000_000), &Some(200), &None);
    
    // Check event was emitted
    let events_after = env.events().all();
    assert!(events_after.len() > events_before);
    
    let last_event = events_after.last().unwrap();
    // Verify event topic is "CFGD" or "arena_configured"
    assert!(last_event.topics.contains(&symbol_short!("CFGD")));
}

// ── Test 15: No-Op Configuration ───────────────────────────────────────────

#[test]
fn configure_arena_with_all_none_succeeds() {
    let env = Env::default();
    env.mock_all_auths();
    
    let admin = Address::generate(&env);
    let client = create_client(&env);
    
    let initial_fee = 100_000_000;
    let initial_max = 100;
    let initial_deadline = env.ledger().timestamp() + 86400;
    
    client.initialize(&admin, &initial_fee, &initial_max, &initial_deadline);
    
    // Configure with all None (no-op)
    let result = client.configure_arena(&None, &None, &None);
    
    assert!(result.is_ok());
    
    // Verify nothing changed
    let config = client.get_config();
    assert_eq!(config.entry_fee, initial_fee);
    assert_eq!(config.max_players, initial_max);
    assert_eq!(config.join_deadline, initial_deadline);
}

// ── Test 16: Configure After Players Join ──────────────────────────────────

#[test]
fn configure_arena_after_players_joined() {
    let env = Env::default();
    env.mock_all_auths();
    
    let admin = Address::generate(&env);
    let client = create_client(&env);
    
    let initial_fee = 100_000_000;
    let initial_max = 100;
    let initial_deadline = env.ledger().timestamp() + 86400;
    
    client.initialize(&admin, &initial_fee, &initial_max, &initial_deadline);
    
    // Players join
    let player1 = Address::generate(&env);
    let player2 = Address::generate(&env);
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
    let env = Env::default();
    env.mock_all_auths();
    
    let admin = Address::generate(&env);
    let client = create_client(&env);
    
    let initial_fee = 100_000_000;
    let initial_max = 100;
    let initial_deadline = env.ledger().timestamp() + 86400;
    
    client.initialize(&admin, &initial_fee, &initial_max, &initial_deadline);
    
    // Configure with new entry fee
    let new_fee = 50_000_000;
    client.configure_arena(&Some(new_fee), &None, &None);
    
    // New player joins with new fee
    let player = Address::generate(&env);
    let result = client.join_with_fee(&player, &new_fee);
    
    assert!(result.is_ok());
}

// ── Property-Based Test 18: Entry Fee Range ────────────────────────────────

#[cfg(feature = "proptest")]
use proptest::prelude::*;

#[cfg(feature = "proptest")]
proptest! {
    #[test]
    fn configure_arena_accepts_any_positive_fee(fee in 1i128..1_000_000_000_000i128) {
        let env = Env::default();
        env.mock_all_auths();
        
        let admin = Address::generate(&env);
        let client = create_client(&env);
        
        let initial_deadline = env.ledger().timestamp() + 86400;
        client.initialize(&admin, &100_000_000, &100, &initial_deadline);
        
        let result = client.configure_arena(&Some(fee), &None, &None);
        prop_assert!(result.is_ok());
        
        let config = client.get_config();
        prop_assert_eq!(config.entry_fee, fee);
    }
}

// ── Property-Based Test 19: Max Players Range ──────────────────────────────

#[cfg(feature = "proptest")]
proptest! {
    #[test]
    fn configure_arena_accepts_any_max_players(max in 0u32..10_000u32) {
        let env = Env::default();
        env.mock_all_auths();
        
        let admin = Address::generate(&env);
        let client = create_client(&env);
        
        let initial_deadline = env.ledger().timestamp() + 86400;
        client.initialize(&admin, &100_000_000, &100, &initial_deadline);
        
        let result = client.configure_arena(&None, &Some(max), &None);
        prop_assert!(result.is_ok());
        
        let config = client.get_config();
        prop_assert_eq!(config.max_players, max);
    }
}

// ── Property-Based Test 20: Future Deadline Range ──────────────────────────

#[cfg(feature = "proptest")]
proptest! {
    #[test]
    fn configure_arena_accepts_any_future_deadline(
        offset in 1u64..1_000_000u64
    ) {
        let env = Env::default();
        env.mock_all_auths();
        
        let admin = Address::generate(&env);
        let client = create_client(&env);
        
        let current_time = env.ledger().timestamp();
        let initial_deadline = current_time + 86400;
        client.initialize(&admin, &100_000_000, &100, &initial_deadline);
        
        let new_deadline = current_time + offset;
        let result = client.configure_arena(&None, &None, &Some(new_deadline));
        prop_assert!(result.is_ok());
        
        let config = client.get_config();
        prop_assert_eq!(config.join_deadline, new_deadline);
    }
}
