#![cfg(test)]

extern crate std;
use std::vec::Vec;

use super::*;
use proptest::prelude::*;
use soroban_sdk::{
    testutils::{Address as _, Ledger as _, LedgerInfo},
    Address, BytesN, Env,
};

// ── helpers ───────────────────────────────────────────────────────────────────

/// Advance ledger sequence, preserving existing TTL settings.
/// Use this for tests that do not involve auth (no submit_choice).
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

/// Advance ledger sequence with large but non-overflowing TTL values.
/// Required for proptest fuzz tests where the ledger may jump to arbitrary
/// sequences and auth mocks must remain valid.
///
/// In soroban-sdk v22, `env.ledger().set()` clears mock-auth state; callers
/// must re-invoke `mock_all_auths()` after this if auth is needed.
fn set_ledger(env: &Env, sequence_number: u32) {
    let ledger = env.ledger().get();
    env.ledger().set(LedgerInfo {
        timestamp: 1_700_000_000,
        protocol_version: 22,
        sequence_number,
        network_id: ledger.network_id,
        base_reserve: ledger.base_reserve,
        // u32::MAX / 4 gives plenty of lifetime while keeping
        // current_ledger + ttl - 1 well within u32 range.
        min_temp_entry_ttl: u32::MAX / 4,
        min_persistent_entry_ttl: u32::MAX / 4,
        max_entry_ttl: u32::MAX / 4,
    });
}

/// Create a fresh Env with large TTLs and mock_all_auths pre-applied.
/// Use in proptest tests where submit_choice auth must remain mocked across
/// arbitrary ledger advances.
fn make_env() -> Env {
    let env = Env::default();
    env.mock_all_auths();
    set_ledger(&env, 0);
    env
}

fn create_client<'a>(env: &'a Env) -> ArenaContractClient<'a> {
    let contract_id = env.register(ArenaContract, ());
    ArenaContractClient::new(env, &contract_id)
}

/// Advance ledger and immediately re-apply mock_all_auths.
/// Call this in proptest tests before any submit_choice invocation.
fn advance_ledger_with_auth(env: &Env, sequence_number: u32) {
    set_ledger(env, sequence_number);
    env.mock_all_auths();
}

/// Run N complete round cycles (start → timeout) and return observed round
/// numbers in order.
fn run_cycles(env: &Env, client: &ArenaContractClient, _round_speed: u32, cycles: u32) -> Vec<u32> {
    let mut round_numbers = Vec::new();
    let mut ledger: u32 = 1_000;

    for _ in 0..cycles {
        set_ledger(env, ledger);
        let round = client.start_round();
        round_numbers.push(round.round_number);

        ledger = round.round_deadline_ledger + 1;
        set_ledger(env, ledger);
        client.timeout_round();

        ledger += 1;
    }

    round_numbers
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

// ── sanity: basic contract round cycle ───────────────────────────────────────

#[test]
fn basic_init_and_round_cycle() {
    let env = make_env();
    let client = create_client(&env);
    set_ledger(&env, 100);
    client.init(&5);
    let r = client.start_round();
    assert_eq!(r.round_number, 1);
    assert!(r.active);
    set_ledger(&env, 106);
    let t = client.timeout_round();
    assert!(!t.active);
    assert!(t.timed_out);
}

// ── Round state machine tests ─────────────────────────────────────────────────

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

// ── Property 1: round number is strictly monotonically increasing ─────────────

proptest! {
    #![proptest_config(ProptestConfig::with_cases(500))]

    #[test]
    fn prop_round_number_strictly_increases(
        round_speed in 1u32..=50u32,
        cycles     in 1u32..=20u32,
    ) {
        let env = make_env();
        let client = create_client(&env);
        set_ledger(&env, 1_000);
        client.init(&round_speed);

        let observed = run_cycles(&env, &client, round_speed, cycles);

        let expected: Vec<u32> = (1..=cycles).collect();
        prop_assert_eq!(
            observed, expected,
            "round numbers must strictly increase from 1 to the last cycle"
        );
    }
}

// ── Property 2: submission count never exceeds the number of unique submitters ─

proptest! {
    #![proptest_config(ProptestConfig::with_cases(500))]

    #[test]
    fn prop_submission_count_equals_unique_submitters(
        player_count in 0usize..=15usize,
        round_speed  in 1u32..=30u32,
    ) {
        let env = make_env();
        let client = create_client(&env);

        advance_ledger_with_auth(&env, 500);
        client.init(&round_speed);
        client.start_round();

        let mut players: Vec<Address> = Vec::new();
        for _ in 0..player_count {
            let p = Address::generate(&env);
            players.push(p);
        }

        for p in &players {
            client.submit_choice(p, &Choice::Heads);
        }

        let round = client.get_round();
        prop_assert_eq!(
            round.total_submissions,
            player_count as u32,
            "total_submissions must equal the number of unique submitters"
        );
    }
}

// ── Property 3: no player can submit twice in the same round ─────────────────

proptest! {
    #![proptest_config(ProptestConfig::with_cases(500))]

    #[test]
    fn prop_no_double_submission(round_speed in 1u32..=50u32) {
        let env = make_env();
        let client = create_client(&env);

        advance_ledger_with_auth(&env, 1_000);
        client.init(&round_speed);
        client.start_round();

        let player = Address::generate(&env);
        client.submit_choice(&player, &Choice::Heads);

        let result = client.try_submit_choice(&player, &Choice::Tails);
        prop_assert_eq!(
            result,
            Err(Ok(ArenaError::SubmissionAlreadyExists)),
            "second submission from the same player must be rejected"
        );
    }
}

// ── Property 4: choices stored are exactly what was submitted ─────────────────

proptest! {
    #![proptest_config(ProptestConfig::with_cases(500))]

    #[test]
    fn prop_stored_choice_matches_submitted_choice(
        round_speed   in 1u32..=30u32,
        submit_heads  in proptest::bool::ANY,
    ) {
        let env = make_env();
        let client = create_client(&env);

        advance_ledger_with_auth(&env, 200);
        client.init(&round_speed);
        client.start_round();

        let player   = Address::generate(&env);
        let absent   = Address::generate(&env);
        let expected = if submit_heads { Choice::Heads } else { Choice::Tails };

        client.submit_choice(&player, &expected);

        prop_assert_eq!(client.get_choice(&1, &player), Some(expected));
        prop_assert_eq!(client.get_choice(&1, &absent), None);
    }
}

// ── Property 5: survivor count invariant ──────────────────────────────────────

proptest! {
    #![proptest_config(ProptestConfig::with_cases(300))]

    #[test]
    fn prop_survivor_count_never_exceeds_capacity(
        player_count in 1usize..=30usize,
        round_speed  in 1u32..=100u32,
    ) {
        let env = make_env();
        let client = create_client(&env);

        advance_ledger_with_auth(&env, 0);
        client.init(&round_speed);
        client.start_round();

        for _ in 0..player_count {
            let p = Address::generate(&env);
            client.submit_choice(&p, &Choice::Heads);
        }

        let round = client.get_round();
        prop_assert!(
            round.total_submissions <= player_count as u32,
            "submissions ({}) must never exceed player count ({})",
            round.total_submissions,
            player_count
        );
    }
}

// ── Property 6: submission count consistent after timeout ─────────────────────

proptest! {
    #![proptest_config(ProptestConfig::with_cases(300))]

    #[test]
    fn prop_submission_count_consistent_after_timeout(
        early_submitters in 0usize..=10usize,
        round_speed      in 1u32..=20u32,
    ) {
        let env = make_env();
        let client = create_client(&env);

        advance_ledger_with_auth(&env, 1_000);
        client.init(&round_speed);
        client.start_round();

        for _ in 0..early_submitters {
            let p = Address::generate(&env);
            client.submit_choice(&p, &Choice::Tails);
        }

        advance_ledger_with_auth(&env, 1_000 + round_speed + 1);
        let timed_out = client.timeout_round();

        prop_assert_eq!(
            timed_out.total_submissions,
            early_submitters as u32,
            "after timeout, total_submissions must equal early-window submitters"
        );

        for _ in 0..3 {
            let late = Address::generate(&env);
            let result = client.try_submit_choice(&late, &Choice::Heads);
            prop_assert!(
                result.is_err(),
                "late submission after timeout must be rejected"
            );
        }
    }
}

// ── Property 7: config is immutable after init ────────────────────────────────

proptest! {
    #![proptest_config(ProptestConfig::with_cases(200))]

    #[test]
    fn prop_init_is_idempotent_protected(
        first_speed  in 1u32..=100u32,
        second_speed in 1u32..=100u32,
    ) {
        let env = make_env();
        let client = create_client(&env);

        client.init(&first_speed);
        let result = client.try_init(&second_speed);

        prop_assert_eq!(
            result,
            Err(Ok(ArenaError::AlreadyInitialized)),
            "second init must always fail"
        );

        let config = client.get_config();
        prop_assert_eq!(config.round_speed_in_ledgers, first_speed);
    }
}

// ── Property 8: round deadline is always start + speed ───────────────────────

proptest! {
    #![proptest_config(ProptestConfig::with_cases(500))]

    #[test]
    fn prop_deadline_equals_start_plus_speed(
        start_ledger in 0u32..=1_000_000u32,
        round_speed  in 1u32..=1_000u32,
    ) {
        let deadline = match start_ledger.checked_add(round_speed) {
            Some(d) => d,
            None    => return Ok(()),
        };

        let env = make_env();
        let client = create_client(&env);

        set_ledger(&env, start_ledger);
        client.init(&round_speed);
        let round = client.start_round();

        prop_assert_eq!(round.round_start_ledger, start_ledger);
        prop_assert_eq!(round.round_deadline_ledger, deadline);
        prop_assert_eq!(
            round.round_deadline_ledger,
            round.round_start_ledger + round_speed,
            "deadline must always be start + speed"
        );
    }
}

// ── Property 9: timeout requires strictly > deadline, not ≥ ──────────────────

proptest! {
    #![proptest_config(ProptestConfig::with_cases(500))]

    #[test]
    fn prop_timeout_requires_strictly_past_deadline(round_speed in 1u32..=50u32) {
        let env = make_env();
        let client = create_client(&env);

        set_ledger(&env, 100);
        client.init(&round_speed);
        client.start_round();

        set_ledger(&env, 100 + round_speed);
        let at_deadline = client.try_timeout_round();
        prop_assert_eq!(at_deadline, Err(Ok(ArenaError::RoundStillOpen)));

        set_ledger(&env, 100 + round_speed + 1);
        let past_deadline = client.try_timeout_round();
        prop_assert!(past_deadline.is_ok(), "timeout must succeed one ledger past deadline");
    }
}

// ── Property 10: 10 000 round cycles without panic ───────────────────────────

#[test]
fn smoke_10000_round_cycles_without_panic() {
    const CYCLES: u32 = 10_000;
    const SPEED: u32 = 1;

    let env = make_env();
    let client = create_client(&env);

    set_ledger(&env, 1_000);
    client.init(&SPEED);

    let numbers = run_cycles(&env, &client, SPEED, CYCLES);

    assert_eq!(numbers.len(), CYCLES as usize);
    for (i, &n) in numbers.iter().enumerate() {
        assert_eq!(n, (i + 1) as u32, "round number out of sequence at index {i}");
    }
}
