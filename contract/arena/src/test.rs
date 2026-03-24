#![cfg(test)]

use super::*;
use soroban_sdk::{
    testutils::{Address as _, Ledger as _, LedgerInfo},
    Address, BytesN, Env,
};

// ── Ledger helpers ────────────────────────────────────────────────────────────

fn set_ledger_sequence(env: &Env, sequence_number: u32) {
    let mut ledger = env.ledger().get();
    ledger.sequence_number = sequence_number;
    env.ledger().set(LedgerInfo {
        timestamp: 1_700_000_000,
        protocol_version: 22,
        sequence_number: ledger.sequence_number,
        network_id: ledger.network_id,
        base_reserve: ledger.base_reserve,
        min_temp_entry_ttl: ledger.min_temp_entry_ttl,
        min_persistent_entry_ttl: ledger.min_persistent_entry_ttl,
        max_entry_ttl: ledger.max_entry_ttl,
    });
}

// ── Round state machine helpers ───────────────────────────────────────────────

fn create_client<'a>(env: &'a Env) -> ArenaContractClient<'a> {
    let contract_id = env.register(ArenaContract, ());
    ArenaContractClient::new(env, &contract_id)
}

// ── Upgrade helpers ───────────────────────────────────────────────────────────

const TIMELOCK: u64 = 48 * 60 * 60; // 48 hours

fn setup_with_admin() -> (Env, Address, ArenaContractClient<'static>) {
    let env = Env::default();
    env.mock_all_auths();

    let contract_id = env.register(ArenaContract, ());
    let client = ArenaContractClient::new(&env, &contract_id);
    let admin = Address::generate(&env);
    client.initialize(&admin);

    // SAFETY: env lives for the duration of the test.
    let env_static: &'static Env = unsafe { &*(&env as *const Env) };
    let client = ArenaContractClient::new(env_static, &contract_id);
    (env, admin, client)
}

fn dummy_hash(env: &Env) -> BytesN<32> {
    BytesN::from_array(env, &[1u8; 32])
}

// ── Round state machine tests (from main) ────────────────────────────────────

#[test]
fn start_round_records_start_and_deadline_ledgers() {
    let env = Env::default();
    let client = create_client(&env);

    set_ledger_sequence(&env, 100);

    client.init(&5);
    let round = client.start_round();

    assert_eq!(
        round,
        RoundState {
            round_number: 1,
            round_start_ledger: 100,
            round_deadline_ledger: 105,
            active: true,
            total_submissions: 0,
            timed_out: false,
        }
    );
}

#[test]
fn submit_choice_allows_submission_on_deadline_ledger() {
    let env = Env::default();
    env.mock_all_auths();

    let client = create_client(&env);
    let player = Address::generate(&env);

    set_ledger_sequence(&env, 200);
    client.init(&5);
    client.join_arena(&player);
    client.start_round();

    set_ledger_sequence(&env, 205);
    client.submit_choice(&player, &Choice::Heads);

    assert_eq!(client.get_choice(&1, &player), Some(Choice::Heads));
    assert_eq!(client.get_round().total_submissions, 1);
}

#[test]
fn submit_choice_rejects_late_submissions() {
    let env = Env::default();
    env.mock_all_auths();

    let client = create_client(&env);
    let player = Address::generate(&env);

    set_ledger_sequence(&env, 300);
    client.init(&5);
    client.join_arena(&player);
    client.start_round();

    set_ledger_sequence(&env, 306);
    let result = client.try_submit_choice(&player, &Choice::Tails);

    assert_eq!(result, Err(Ok(ArenaError::SubmissionWindowClosed)));
}

#[test]
fn timeout_round_is_callable_by_anyone_after_deadline() {
    let env = Env::default();
    let client = create_client(&env);

    set_ledger_sequence(&env, 400);
    client.init(&3);
    client.start_round();

    set_ledger_sequence(&env, 404);
    let timed_out_round = client.timeout_round();

    assert_eq!(timed_out_round.round_number, 1);
    assert!(!timed_out_round.active);
    assert!(timed_out_round.timed_out);
    assert_eq!(client.get_round(), timed_out_round);
}

#[test]
fn timeout_round_rejects_calls_before_deadline() {
    let env = Env::default();
    let client = create_client(&env);

    set_ledger_sequence(&env, 500);
    client.init(&4);
    client.start_round();

    set_ledger_sequence(&env, 504);
    let result = client.try_timeout_round();

    assert_eq!(result, Err(Ok(ArenaError::RoundStillOpen)));
}

#[test]
fn new_round_can_start_after_timeout() {
    let env = Env::default();
    let client = create_client(&env);

    set_ledger_sequence(&env, 600);
    client.init(&2);
    client.start_round();

    set_ledger_sequence(&env, 603);
    client.timeout_round();

    set_ledger_sequence(&env, 604);
    let second_round = client.start_round();

    assert_eq!(second_round.round_number, 2);
    assert_eq!(second_round.round_start_ledger, 604);
    assert_eq!(second_round.round_deadline_ledger, 606);
    assert!(second_round.active);
    assert!(!second_round.timed_out);
}

#[test]
fn data_model_doc_covers_required_sections() {
    let doc = include_str!("../../DATA_MODEL.md");

    assert!(doc.contains("## Storage Key Inventory"));
    assert!(doc.contains("## TTL Policy Baseline"));
    assert!(doc.contains("## Access Pattern Matrix"));
    assert!(doc.contains("## ER-Style State Diagram"));
    assert!(doc.contains("No custom Soroban storage keys are currently defined or used."));
}

// ── TTL survival test ─────────────────────────────────────────────────────────

#[test]
fn state_survives_expected_game_duration() {
    let env = Env::default();
    env.mock_all_auths();
    let client = create_client(&env);
    let player = Address::generate(&env);

    // Initialise and start a round at ledger 1_000.  Use a large round window
    // (20_000 ledgers) so the round remains open when we advance the ledger.
    set_ledger_sequence(&env, 1_000);
    client.init(&20_000);
    client.join_arena(&player);
    client.start_round();

    // Submit a choice while still within the round window.
    set_ledger_sequence(&env, 1_001);
    client.submit_choice(&player, &Choice::Heads);

    // Advance 10_000 ledgers beyond init — well past the default
    // min_persistent_entry_ttl (4_096) but far below GAME_TTL_EXTEND_TO
    // (535_680).  Without explicit TTL extension the Config, Round, and
    // Submission entries would have expired here.
    set_ledger_sequence(&env, 11_000);

    // All state must still be readable.
    let config = client.get_config();
    assert_eq!(config.round_speed_in_ledgers, 20_000);

    let round = client.get_round();
    assert!(round.active);
    assert_eq!(round.round_number, 1);
    assert_eq!(round.total_submissions, 1);

    assert_eq!(client.get_choice(&1, &player), Some(Choice::Heads));
}

// ── Upgrade mechanism tests ───────────────────────────────────────────────────

#[test]
fn test_initialize_sets_admin() {
    let (_env, admin, client) = setup_with_admin();
    assert_eq!(client.admin(), admin);
}

#[test]
#[should_panic(expected = "already initialized")]
fn test_double_initialize_panics() {
    let (_env, admin, client) = setup_with_admin();
    client.initialize(&admin);
}

#[test]
fn test_propose_upgrade_stores_pending() {
    let (env, _admin, client) = setup_with_admin();
    let hash = dummy_hash(&env);
    client.propose_upgrade(&hash);

    let pending = client.pending_upgrade().unwrap();
    assert_eq!(pending.0, hash);
    assert!(pending.1 >= env.ledger().timestamp() + TIMELOCK);
}

#[test]
fn test_propose_upgrade_replaces_previous() {
    let (env, _admin, client) = setup_with_admin();
    let hash1 = BytesN::from_array(&env, &[1u8; 32]);
    let hash2 = BytesN::from_array(&env, &[2u8; 32]);

    client.propose_upgrade(&hash1);
    client.propose_upgrade(&hash2);

    let pending = client.pending_upgrade().unwrap();
    assert_eq!(pending.0, hash2);
}

#[test]
#[should_panic(expected = "no pending upgrade")]
fn test_execute_without_proposal_panics() {
    let (_env, _admin, client) = setup_with_admin();
    client.execute_upgrade();
}

#[test]
#[should_panic(expected = "timelock has not expired")]
fn test_execute_before_timelock_panics() {
    let (env, _admin, client) = setup_with_admin();
    client.propose_upgrade(&dummy_hash(&env));
    // Advance only 47 h — one hour short of the 48-h timelock.
    env.ledger().with_mut(|l| {
        l.timestamp += 47 * 60 * 60;
    });
    client.execute_upgrade();
}

#[test]
#[should_panic(expected = "timelock has not expired")]
fn test_execute_exactly_at_boundary_panics() {
    let (env, _admin, client) = setup_with_admin();
    let propose_time = env.ledger().timestamp();
    client.propose_upgrade(&dummy_hash(&env));
    // Advance to exactly the proposal time + TIMELOCK – 1 second.
    env.ledger().with_mut(|l| {
        l.timestamp = propose_time + TIMELOCK - 1;
    });
    client.execute_upgrade();
}

#[test]
#[should_panic(expected = "no pending upgrade to cancel")]
fn test_cancel_without_proposal_panics() {
    let (_env, _admin, client) = setup_with_admin();
    client.cancel_upgrade();
}

#[test]
fn test_cancel_clears_pending_upgrade() {
    let (env, _admin, client) = setup_with_admin();
    client.propose_upgrade(&dummy_hash(&env));
    assert!(client.pending_upgrade().is_some());

    client.cancel_upgrade();
    assert!(client.pending_upgrade().is_none());
}

#[test]
#[should_panic(expected = "no pending upgrade")]
fn test_execute_after_cancel_panics() {
    let (env, _admin, client) = setup_with_admin();
    client.propose_upgrade(&dummy_hash(&env));
    client.cancel_upgrade();

    env.ledger().with_mut(|l| {
        l.timestamp += TIMELOCK + 1;
    });
    client.execute_upgrade();
}

#[test]
#[should_panic(expected = "no pending upgrade to cancel")]
fn test_double_cancel_panics() {
    let (env, _admin, client) = setup_with_admin();
    client.propose_upgrade(&dummy_hash(&env));
    client.cancel_upgrade();
    client.cancel_upgrade();
}

#[test]
fn test_pending_upgrade_none_before_propose() {
    let (_env, _admin, client) = setup_with_admin();
    assert!(client.pending_upgrade().is_none());
}

#[test]
fn test_pending_upgrade_none_after_cancel() {
    let (env, _admin, client) = setup_with_admin();
    client.propose_upgrade(&dummy_hash(&env));
    client.cancel_upgrade();
    assert!(client.pending_upgrade().is_none());
}

// ── Issue #232: round timeout and stalled game recovery ──────────────────────

// AC: Timeout callable after deadline passes
#[test]
fn timeout_round_succeeds_one_ledger_after_deadline() {
    let env = Env::default();
    let client = create_client(&env);

    set_ledger_sequence(&env, 1000);
    client.init(&10);
    client.start_round();

    // deadline = 1010; advance one past it
    set_ledger_sequence(&env, 1011);
    let result = client.timeout_round();

    assert!(!result.active, "round must be inactive after timeout");
    assert!(result.timed_out, "timed_out flag must be set");
    assert_eq!(result.round_number, 1);
}

// AC: Timeout callable after deadline passes (exact boundary)
#[test]
fn timeout_round_succeeds_just_after_deadline() {
    let env = Env::default();
    let client = create_client(&env);

    set_ledger_sequence(&env, 500);
    client.init(&5);
    client.start_round(); // deadline = 505

    set_ledger_sequence(&env, 506);
    let result = client.timeout_round();

    assert!(!result.active);
    assert!(result.timed_out);
}

// AC: timeout_round fails before deadline (round still open)
#[test]
fn timeout_round_fails_at_deadline_ledger() {
    let env = Env::default();
    let client = create_client(&env);

    set_ledger_sequence(&env, 200);
    client.init(&4);
    client.start_round(); // deadline = 204

    set_ledger_sequence(&env, 204); // exactly at deadline — still open
    let result = client.try_timeout_round();

    assert_eq!(result, Err(Ok(ArenaError::RoundStillOpen)));
}

#[test]
fn timeout_round_fails_before_deadline() {
    let env = Env::default();
    let client = create_client(&env);

    set_ledger_sequence(&env, 100);
    client.init(&20);
    client.start_round(); // deadline = 120

    set_ledger_sequence(&env, 115);
    let result = client.try_timeout_round();

    assert_eq!(result, Err(Ok(ArenaError::RoundStillOpen)));
}

// AC: timeout_round fails when no active round
#[test]
fn timeout_round_fails_when_no_active_round() {
    let env = Env::default();
    let client = create_client(&env);

    set_ledger_sequence(&env, 50);
    client.init(&3);
    // do NOT call start_round

    set_ledger_sequence(&env, 200);
    let result = client.try_timeout_round();

    assert_eq!(result, Err(Ok(ArenaError::NoActiveRound)));
}

// AC: Game resolves correctly after timeout — state is consistent
#[test]
fn round_state_is_consistent_after_timeout() {
    let env = Env::default();
    env.mock_all_auths();
    let client = create_client(&env);

    let player = Address::generate(&env);

    set_ledger_sequence(&env, 300);
    client.init(&5); // deadline = 305
    client.join_arena(&player);
    client.start_round();

    // player submits within window
    set_ledger_sequence(&env, 302);
    env.mock_all_auths();
    client.submit_choice(&player, &Choice::Heads);

    // advance past deadline and call timeout
    set_ledger_sequence(&env, 306);
    let timed_out = client.timeout_round();

    // round must reflect the one submission that occurred
    assert_eq!(timed_out.total_submissions, 1);
    assert!(!timed_out.active);
    assert!(timed_out.timed_out);

    // persisted state must match returned state
    let stored = client.get_round();
    assert_eq!(stored, timed_out);
}

// AC: Funds remain accessible after timeout — choices/data still readable
#[test]
fn player_choice_accessible_after_timeout() {
    let env = Env::default();
    env.mock_all_auths();
    let client = create_client(&env);

    let player = Address::generate(&env);

    set_ledger_sequence(&env, 400);
    client.init(&3);
    client.join_arena(&player);
    client.start_round(); // deadline = 403

    set_ledger_sequence(&env, 401);
    env.mock_all_auths();
    client.submit_choice(&player, &Choice::Tails);

    set_ledger_sequence(&env, 404);
    client.timeout_round();

    // choice data must still be accessible for settlement / fund release
    let choice = client.get_choice(&1, &player);
    assert_eq!(choice, Some(Choice::Tails));
}

// AC: All-absent scenario — no submissions, game still resolves via timeout
#[test]
fn timeout_works_when_no_player_submitted() {
    let env = Env::default();
    let client = create_client(&env);

    set_ledger_sequence(&env, 600);
    client.init(&5);
    let round = client.start_round(); // deadline = 605
    assert_eq!(round.total_submissions, 0);

    set_ledger_sequence(&env, 610);
    let timed_out = client.timeout_round();

    assert_eq!(timed_out.total_submissions, 0, "no submissions expected");
    assert!(!timed_out.active);
    assert!(timed_out.timed_out);
}

// AC: All-absent scenario — multiple players, none submit, timeout resolves
#[test]
fn timeout_with_multiple_absent_players_resolves_gracefully() {
    let env = Env::default();
    let client = create_client(&env);

    set_ledger_sequence(&env, 700);
    client.init(&8); // deadline = 708
    client.start_round();

    // generate some player addresses but have none submit
    let _p1 = Address::generate(&env);
    let _p2 = Address::generate(&env);
    let _p3 = Address::generate(&env);

    set_ledger_sequence(&env, 709);
    let timed_out = client.timeout_round();

    assert_eq!(timed_out.total_submissions, 0);
    assert!(!timed_out.active);
    assert!(timed_out.timed_out);

    // all player choices are absent (None) — accessible without panic
    assert_eq!(client.get_choice(&1, &_p1), None);
    assert_eq!(client.get_choice(&1, &_p2), None);
    assert_eq!(client.get_choice(&1, &_p3), None);
}

// AC: Submissions after timeout are rejected
#[test]
fn submit_choice_rejected_after_deadline() {
    let env = Env::default();
    env.mock_all_auths();
    let client = create_client(&env);

    let player = Address::generate(&env);

    set_ledger_sequence(&env, 800);
    client.init(&5); // deadline = 805
    client.join_arena(&player);
    client.start_round();

    set_ledger_sequence(&env, 806);
    let result = client.try_submit_choice(&player, &Choice::Heads);

    assert_eq!(result, Err(Ok(ArenaError::SubmissionWindowClosed)));
}

// AC: New round starts cleanly after a timed-out round
#[test]
fn new_round_starts_after_timeout_with_fresh_state() {
    let env = Env::default();
    let client = create_client(&env);

    set_ledger_sequence(&env, 900);
    client.init(&5); // deadline = 905
    client.start_round();

    set_ledger_sequence(&env, 906);
    client.timeout_round();

    set_ledger_sequence(&env, 910);
    let round2 = client.start_round();

    assert_eq!(round2.round_number, 2);
    assert_eq!(round2.round_start_ledger, 910);
    assert_eq!(round2.round_deadline_ledger, 915);
    assert!(round2.active);
    assert!(!round2.timed_out);
    assert_eq!(round2.total_submissions, 0);
}

// AC: Starting a round while one is already active fails
#[test]
fn start_round_fails_when_active_round_exists() {
    let env = Env::default();
    let client = create_client(&env);

    set_ledger_sequence(&env, 1000);
    client.init(&10);
    client.start_round();

    set_ledger_sequence(&env, 1005);
    let result = client.try_start_round();

    assert_eq!(result, Err(Ok(ArenaError::RoundAlreadyActive)));
}

// AC: timeout_round cannot be called twice on the same round
#[test]
fn timeout_round_fails_on_already_timed_out_round() {
    let env = Env::default();
    let client = create_client(&env);

    set_ledger_sequence(&env, 1100);
    client.init(&3); // deadline = 1103
    client.start_round();

    set_ledger_sequence(&env, 1104);
    client.timeout_round(); // first call — succeeds

    let result = client.try_timeout_round(); // second call — no active round
    assert_eq!(result, Err(Ok(ArenaError::NoActiveRound)));
}

// AC: round number increments correctly across multiple timeout cycles
#[test]
fn round_number_increments_across_timeout_cycles() {
    let env = Env::default();
    let client = create_client(&env);

    set_ledger_sequence(&env, 0);
    client.init(&2);

    for expected_round in 1u32..=5 {
        let start_seq = (expected_round - 1) * 10;
        set_ledger_sequence(&env, start_seq);
        let round = client.start_round();
        assert_eq!(round.round_number, expected_round);

        set_ledger_sequence(&env, start_seq + 3); // past deadline (start + 2)
        let timed = client.timeout_round();
        assert_eq!(timed.round_number, expected_round);
        assert!(timed.timed_out);
    }
}

// AC: partial submissions followed by timeout — present choices preserved
#[test]
fn partial_submissions_preserved_after_timeout() {
    let env = Env::default();
    env.mock_all_auths();
    let client = create_client(&env);

    let player_a = Address::generate(&env);
    let player_b = Address::generate(&env);
    let player_c = Address::generate(&env);

    set_ledger_sequence(&env, 2000);
    client.init(&10); // deadline = 2010
    client.join_arena(&player_a);
    client.join_arena(&player_b);
    client.join_arena(&player_c);
    client.start_round();

    // only player_a and player_b submit
    set_ledger_sequence(&env, 2005);
    env.mock_all_auths();
    client.submit_choice(&player_a, &Choice::Heads);
    client.submit_choice(&player_b, &Choice::Tails);

    set_ledger_sequence(&env, 2011);
    let timed_out = client.timeout_round();

    assert_eq!(timed_out.total_submissions, 2);
    assert_eq!(client.get_choice(&1, &player_a), Some(Choice::Heads));
    assert_eq!(client.get_choice(&1, &player_b), Some(Choice::Tails));
    assert_eq!(client.get_choice(&1, &player_c), None); // absent
}

// ── Pause mechanism tests ───────────────────────────────────────────────────

#[test]
fn test_pause_unpause_admin_only() {
    let (env, admin, client) = setup_with_admin();

    assert!(!client.is_paused());

    // Admin can pause
    client.pause();
    
    // Verify admin authorized the call
    assert_eq!(
        env.auths().get(0).unwrap().0,
        admin
    );

    assert!(client.is_paused());

    // Admin can unpause
    client.unpause();
    
    assert_eq!(
        env.auths().get(0).unwrap().0,
        admin
    );

    assert!(!client.is_paused());
}

#[test]
fn test_functions_fail_when_paused() {
    let (env, _admin, client) = setup_with_admin();
    let player = Address::generate(&env);
    
    client.init(&10);
    client.pause();
    assert!(client.is_paused());

    // All state-changing functions should fail
    assert_eq!(client.try_start_round(), Err(Ok(ArenaError::Paused)));
    assert_eq!(client.try_timeout_round(), Err(Ok(ArenaError::Paused)));
    
    // Upgrades should NOT fail when paused
    let hash = dummy_hash(&env);
    client.propose_upgrade(&hash); // Should not panic/fail
}

#[test]
fn test_unpause_restores_functionality() {
    let (_env, _admin, client) = setup_with_admin();
    
    client.init(&10);
    client.pause();
    client.unpause();

    // Should succeed now
    let round = client.start_round();
    assert_eq!(round.round_number, 1);
}

// ── Survivor validation tests ───────────────────────────────────────────────

#[test]
fn test_join_arena_sets_active_status() {
    let env = Env::default();
    env.mock_all_auths();
    let client = create_client(&env);
    let player = Address::generate(&env);

    client.init(&10);
    client.join_arena(&player);

    assert_eq!(client.get_survivor_status(&player), Some(SurvivorStatus::Active));
}

#[test]
fn test_submit_choice_fails_if_not_joined() {
    let env = Env::default();
    env.mock_all_auths();
    let client = create_client(&env);
    let player = Address::generate(&env);

    client.init(&10);
    client.start_round();

    let result = client.try_submit_choice(&player, &Choice::Heads);
    assert_eq!(result, Err(Ok(ArenaError::NotASurvivor)));
}

#[test]
fn test_submit_choice_fails_if_eliminated() {
    let (env, admin, client) = setup_with_admin();
    let player = Address::generate(&env);

    client.init(&10);
    client.join_arena(&player);
    
    // Admin eliminates player
    client.eliminate_player(&player);
    assert_eq!(client.get_survivor_status(&player), Some(SurvivorStatus::Eliminated));

    client.start_round();
    let result = client.try_submit_choice(&player, &Choice::Heads);
    assert_eq!(result, Err(Ok(ArenaError::Eliminated)));
}

#[test]
fn test_submit_choice_succeeds_for_active_survivor() {
    let env = Env::default();
    env.mock_all_auths();
    let client = create_client(&env);
    let player = Address::generate(&env);

    client.init(&10);
    client.join_arena(&player);
    client.start_round();

    client.submit_choice(&player, &Choice::Tails);
    assert_eq!(client.get_choice(&1, &player), Some(Choice::Tails));
}
