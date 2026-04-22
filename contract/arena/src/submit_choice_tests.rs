//! Focused unit tests for `submit_choice()` — Issue #431.
//!
//! Covers every acceptance criterion:
//! - Happy path: survivor submits within deadline, choice stored, event emitted
//! - Eliminated player cannot submit (`PlayerEliminated`)
//! - Submission after deadline rejected (`SubmissionWindowClosed`)
//! - Duplicate submission rejected (`SubmissionAlreadyExists`)
//! - `ChoiceSubmitted` event payload does NOT reveal the choice value
#![cfg(test)]

extern crate std;

use super::*;
use soroban_sdk::{
    testutils::{Address as _, Events as _, Ledger as _, LedgerInfo},
    token::StellarAssetClient,
    Address, Env, IntoVal,
};

const STAKE: i128 = 100i128;
const ROUND_SPEED: u32 = 10;

// ── helpers ───────────────────────────────────────────────────────────────────

fn set_seq(env: &Env, seq: u32) {
    let ledger = env.ledger().get();
    env.ledger().set(LedgerInfo {
        sequence_number: seq,
        timestamp: 1_700_000_000,
        protocol_version: 22,
        network_id: ledger.network_id,
        base_reserve: ledger.base_reserve,
        min_temp_entry_ttl: u32::MAX / 4,
        min_persistent_entry_ttl: u32::MAX / 4,
        max_entry_ttl: u32::MAX / 4,
    });
}

/// Deploy arena, set token, init, and have `n` players join.
/// Returns `(env, client, token_id, players)`.
fn setup_arena(n: u32) -> (Env, ArenaContractClient<'static>, Address, std::vec::Vec<Address>) {
    let env = Env::default();
    env.mock_all_auths();
    set_seq(&env, 100);

    let contract_id = env.register(ArenaContract, ());
    let admin = Address::generate(&env);

    let env_s: &'static Env = unsafe { &*(&env as *const Env) };
    let client = ArenaContractClient::new(env_s, &contract_id);

    client.initialize(&admin);

    let token_admin = Address::generate(&env);
    let token_id = env
        .register_stellar_asset_contract_v2(token_admin.clone())
        .address();
    let asset = StellarAssetClient::new(&env, &token_id);

    client.set_token(&token_id);
    client.init(&ROUND_SPEED, &STAKE);

    let mut players = std::vec::Vec::new();
    for _ in 0..n {
        let p = Address::generate(&env);
        asset.mint(&p, &1_000i128);
        client.join(&p, &STAKE);
        players.push(p);
    }

    (env, client, token_id, players)
}

// ── AC: Happy path ────────────────────────────────────────────────────────────

#[test]
fn submit_choice_happy_path_stores_choice_and_increments_count() {
    let (env, client, _token, players) = setup_arena(3);

    set_seq(&env, 200);
    client.start_round();

    // Submit within the deadline window.
    set_seq(&env, 205);
    client.submit_choice(&players[0], &1u32, &Choice::Heads);

    // Choice is readable.
    assert_eq!(client.get_choice(&1u32, &players[0]), Some(Choice::Heads));

    // Submission count incremented.
    let round = client.get_round();
    assert_eq!(round.total_submissions, 1);
}

#[test]
fn submit_choice_on_deadline_ledger_succeeds() {
    let (env, client, _token, players) = setup_arena(3);

    set_seq(&env, 300);
    let round = client.start_round();
    // deadline = 300 + 10 = 310

    // Submit exactly on the deadline ledger — must succeed.
    set_seq(&env, round.round_deadline_ledger);
    client.submit_choice(&players[0], &1u32, &Choice::Tails);

    assert_eq!(client.get_choice(&1u32, &players[0]), Some(Choice::Tails));
}

// ── AC: ChoiceSubmitted event does NOT reveal choice value ────────────────────

#[test]
fn submit_choice_event_does_not_reveal_choice_value() {
    let (env, client, _token, players) = setup_arena(3);

    set_seq(&env, 400);
    client.start_round();

    let before = env.events().all().len();
    set_seq(&env, 405);
    client.submit_choice(&players[0], &1u32, &Choice::Heads);

    let events = env.events().all();
    // At least one new event was emitted.
    assert!(events.len() > before, "expected at least one new event");

    // Find the ChoiceSubmitted event by its topic.
    let choice_events: std::vec::Vec<_> = events
        .iter()
        .filter(|(_, topics, _)| {
            topics
                .get(0)
                .map(|t| {
                    let sym: Symbol = t.into_val(&env);
                    sym == symbol_short!("CH_SUB")
                })
                .unwrap_or(false)
        })
        .collect();

    assert_eq!(choice_events.len(), 1, "exactly one ChoiceSubmitted event");

    let (_, _, data) = &choice_events[0];
    // The event data is (player, round_number, EVENT_VERSION).
    // Deserialise as a tuple and confirm Choice is NOT present.
    let payload: (Address, u32, u32) = data.clone().into_val(&env);
    assert_eq!(payload.0, players[0]);
    assert_eq!(payload.1, 1u32); // round number
    // The payload has exactly 3 elements — no choice field.
    assert_eq!(payload.2, 1u32); // EVENT_VERSION
}

// ── AC: Eliminated player cannot submit ───────────────────────────────────────

#[test]
fn eliminated_player_cannot_submit_in_next_round() {
    let (env, client, token_id, players) = setup_arena(4);

    // Round 1: players[0..3] submit. players[0] picks minority side.
    set_seq(&env, 500);
    client.start_round();

    set_seq(&env, 505);
    // players[0] picks Heads (minority — 1 vs 3 Tails)
    client.submit_choice(&players[0], &1u32, &Choice::Heads);
    client.submit_choice(&players[1], &1u32, &Choice::Tails);
    client.submit_choice(&players[2], &1u32, &Choice::Tails);
    client.submit_choice(&players[3], &1u32, &Choice::Tails);

    set_seq(&env, 511);
    client.timeout_round();

    // Seed PRNG deterministically so Tails wins (3 Tails > 1 Heads).
    use soroban_sdk::Bytes;
    env.as_contract(&client.address, || {
        env.prng().seed(Bytes::from_array(&env, &[0u8; 32]));
    });
    client.resolve_round();

    // players[0] (Heads) is now eliminated.
    // Round 2: start.
    set_seq(&env, 520);
    client.start_round();

    set_seq(&env, 525);
    let result = client.try_submit_choice(&players[0], &2u32, &Choice::Tails);
    assert_eq!(
        result,
        Err(Ok(ArenaError::PlayerEliminated)),
        "eliminated player must be rejected with PlayerEliminated"
    );
}

// ── AC: Submission after deadline rejected ────────────────────────────────────

#[test]
fn submit_choice_after_deadline_returns_submission_window_closed() {
    let (env, client, _token, players) = setup_arena(3);

    set_seq(&env, 600);
    let round = client.start_round();
    // deadline = 600 + 10 = 610

    // One ledger past the deadline.
    set_seq(&env, round.round_deadline_ledger + 1);
    let result = client.try_submit_choice(&players[0], &1u32, &Choice::Heads);

    assert_eq!(
        result,
        Err(Ok(ArenaError::SubmissionWindowClosed)),
        "late submission must return SubmissionWindowClosed"
    );
}

#[test]
fn submit_choice_far_past_deadline_also_rejected() {
    let (env, client, _token, players) = setup_arena(3);

    set_seq(&env, 700);
    client.start_round(); // deadline = 710

    set_seq(&env, 999);
    let result = client.try_submit_choice(&players[0], &1u32, &Choice::Tails);
    assert_eq!(result, Err(Ok(ArenaError::SubmissionWindowClosed)));
}

// ── AC: Duplicate submission rejected ────────────────────────────────────────

#[test]
fn duplicate_submission_returns_already_exists() {
    let (env, client, _token, players) = setup_arena(3);

    set_seq(&env, 800);
    client.start_round();

    set_seq(&env, 805);
    client.submit_choice(&players[0], &1u32, &Choice::Heads);

    // Second call with a different choice — must be rejected.
    let result = client.try_submit_choice(&players[0], &1u32, &Choice::Tails);
    assert_eq!(
        result,
        Err(Ok(ArenaError::SubmissionAlreadyExists)),
        "second submission from same player must return SubmissionAlreadyExists"
    );

    // Original choice is unchanged.
    assert_eq!(
        client.get_choice(&1u32, &players[0]),
        Some(Choice::Heads),
        "original choice must not be overwritten"
    );
}

#[test]
fn duplicate_submission_same_choice_also_rejected() {
    let (env, client, _token, players) = setup_arena(3);

    set_seq(&env, 900);
    client.start_round();

    set_seq(&env, 905);
    client.submit_choice(&players[0], &1u32, &Choice::Tails);

    let result = client.try_submit_choice(&players[0], &1u32, &Choice::Tails);
    assert_eq!(result, Err(Ok(ArenaError::SubmissionAlreadyExists)));
}

// ── AC: Non-survivor cannot submit ────────────────────────────────────────────

#[test]
fn non_survivor_cannot_submit() {
    let (env, client, _token, _players) = setup_arena(3);

    set_seq(&env, 1000);
    client.start_round();

    let stranger = Address::generate(&env);
    set_seq(&env, 1005);
    let result = client.try_submit_choice(&stranger, &1u32, &Choice::Heads);

    assert_eq!(
        result,
        Err(Ok(ArenaError::NotASurvivor)),
        "player who never joined must receive NotASurvivor"
    );
}

// ── AC: Wrong round number rejected ──────────────────────────────────────────

#[test]
fn wrong_round_number_rejected() {
    let (env, client, _token, players) = setup_arena(3);

    set_seq(&env, 1100);
    client.start_round(); // round_number = 1

    set_seq(&env, 1105);
    let result = client.try_submit_choice(&players[0], &2u32, &Choice::Heads);

    assert_eq!(
        result,
        Err(Ok(ArenaError::WrongRoundNumber)),
        "submitting with wrong round number must be rejected"
    );
}
