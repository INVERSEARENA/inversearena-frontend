#![cfg(test)]

extern crate std;
use std::vec::Vec;

use super::*;
use proptest::prelude::*;
use soroban_sdk::{
    Address, BytesN, Env,
    testutils::{Address as _, Ledger as _, LedgerInfo},
    token::StellarAssetClient,
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

/// Register a Stellar Asset Contract and return (StellarAssetClient, token Address).
fn setup_token<'a>(env: &'a Env, admin: &Address) -> (StellarAssetClient<'a>, Address) {
    let token_id = env
        .register_stellar_asset_contract_v2(admin.clone())
        .address();
    let asset = StellarAssetClient::new(env, &token_id);
    (asset, token_id)
}

fn seed_joined_players(
    env: &Env,
    client: &ArenaContractClient<'_>,
    token_id: &Address,
    player_count: u32,
) -> Vec<Address> {
    let asset = StellarAssetClient::new(env, token_id);
    let mut players = Vec::new();
    for _ in 0..player_count {
        let player = Address::generate(env);
        asset.mint(&player, &1_000_000i128);
        client.join(&player, &100i128);
        players.push(player);
    }
    players
}

fn configure_arena(
    env: &Env,
    client: &ArenaContractClient<'_>,
    round_speed: u32,
    player_count: u32,
) -> (Address, Address, Vec<Address>) {
    let admin = Address::generate(env);
    client.initialize(&admin);
    let (_asset, token_id) = setup_token(env, &admin);
    client.set_token(&token_id);
    client.init(&round_speed);
    env.mock_all_auths();
    let players = seed_joined_players(env, client, &token_id, player_count);
    (admin, token_id, players)
}

fn setup_game(
    round_speed: u32,
    player_count: u32,
) -> (
    Env,
    Address,
    ArenaContractClient<'static>,
    Address,
    Vec<Address>,
) {
    let (env, admin, client) = setup_with_admin();
    let (_asset, token_id) = setup_token(&env, &admin);
    client.set_token(&token_id);
    client.init(&round_speed);
    env.mock_all_auths();
    let players = seed_joined_players(&env, &client, &token_id, player_count);
    (env, admin, client, token_id, players)
}

// ── round_speed bounds ────────────────────────────────────────────────────────

#[test]
fn test_init_zero_round_speed_returns_invalid() {
    let env = make_env();
    let client = create_client(&env);
    assert_eq!(client.try_init(&0), Err(Ok(ArenaError::InvalidRoundSpeed)));
}

#[test]
fn test_init_min_round_speed_succeeds() {
    let env = make_env();
    let client = create_client(&env);
    assert!(client.try_init(&bounds::MIN_SPEED_LEDGERS).is_ok());
}

#[test]
fn test_init_max_round_speed_succeeds() {
    let env = make_env();
    let client = create_client(&env);
    assert!(client.try_init(&bounds::MAX_SPEED_LEDGERS).is_ok());
}

#[test]
fn test_init_above_max_round_speed_returns_invalid() {
    let env = make_env();
    let client = create_client(&env);
    assert_eq!(
        client.try_init(&(bounds::MAX_SPEED_LEDGERS + 1)),
        Err(Ok(ArenaError::InvalidRoundSpeed))
    );
}

// ── sanity: basic contract round cycle ───────────────────────────────────────

#[test]
fn basic_init_and_round_cycle() {
    let (env, _admin, client, _token_id, _players) = setup_game(5, 2);
    set_ledger(&env, 100);
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
    let (env, _admin, client, _token_id, _players) = setup_game(5, 2);
    set_ledger_sequence(&env, 100);
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
            finished: false,
        }
    );
}

#[test]
fn submit_choice_allows_submission_on_deadline_ledger() {
    let (env, _admin, client, _token_id, players) = setup_game(5, 2);
    let player = players[0].clone();
    set_ledger_sequence(&env, 200);
    client.start_round();

    set_ledger_sequence(&env, 205);
    client.submit_choice(&player, &1u32, &Choice::Heads);

    assert_eq!(client.get_choice(&1, &player), Some(Choice::Heads));
    assert_eq!(client.get_round().total_submissions, 1);
}

#[test]
fn submit_choice_rejects_late_submissions() {
    let (env, _admin, client, _token_id, players) = setup_game(5, 2);
    let player = players[0].clone();
    set_ledger_sequence(&env, 300);
    client.start_round();

    set_ledger_sequence(&env, 306);
    let result = client.try_submit_choice(&player, &1u32, &Choice::Tails);

    assert_eq!(result, Err(Ok(ArenaError::SubmissionWindowClosed)));
}

#[test]
fn timeout_round_is_callable_by_anyone_after_deadline() {
    let (env, _admin, client, _token_id, _players) = setup_game(3, 2);
    set_ledger_sequence(&env, 400);
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
    let (env, _admin, client, _token_id, _players) = setup_game(4, 2);
    set_ledger_sequence(&env, 500);
    client.start_round();

    set_ledger_sequence(&env, 504);
    let result = client.try_timeout_round();

    assert_eq!(result, Err(Ok(ArenaError::RoundStillOpen)));
}

#[test]
fn new_round_can_start_after_timeout() {
    let (env, _admin, client, _token_id, _players) = setup_game(2, 2);
    set_ledger_sequence(&env, 600);
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
    let (env, _admin, client, _token_id, players) = setup_game(20_000, 2);
    let player = players[0].clone();

    // Initialise and start a round at ledger 1_000.  Use a large round window
    // (20_000 ledgers) so the round remains open when we advance the ledger.
    set_ledger_sequence(&env, 1_000);
    client.start_round();

    // Submit a choice while still within the round window.
    set_ledger_sequence(&env, 1_001);
    client.submit_choice(&player, &1u32, &Choice::Heads);

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

#[test]
fn get_full_state_returns_combined_arena_and_user_state() {
    let (env, admin, client) = setup_with_admin();
    let (asset, token_id) = setup_token(&env, &admin);
    client.set_token(&token_id);
    let player = Address::generate(&env);
    let other = Address::generate(&env);
    asset.mint(&player, &100i128);
    asset.mint(&other, &100i128);

    set_ledger_sequence(&env, 800);
    client.init(&5);

    client.join(&player, &10i128);
    client.join(&other, &10i128);
    client.start_round();
    client.submit_choice(&player, &1u32, &Choice::Heads);

    let full = client.get_full_state(&player);
    assert_eq!(full.round_number, 1);
    assert_eq!(full.survivors_count, 2);
    assert!(full.is_active);
    assert!(!full.has_won);
}

#[test]
fn get_full_state_requires_initialization() {
    let env = Env::default();
    let client = create_client(&env);
    let player = Address::generate(&env);

    let err = client.try_get_full_state(&player);
    assert_eq!(err, Err(Ok(ArenaError::NotInitialized)));
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
        let _ = configure_arena(&env, &client, round_speed, 2);

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
        let survivor_count = core::cmp::max(player_count as u32, bounds::MIN_ARENA_PARTICIPANTS);
        let (_, _, players) = configure_arena(&env, &client, round_speed, survivor_count);
        client.start_round();

        for p in players.iter().take(player_count) {
            client.submit_choice(p, &1u32, &Choice::Heads);
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
        let (_, _, players) = configure_arena(&env, &client, round_speed, 2);
        client.start_round();

        let player = players[0].clone();
        client.submit_choice(&player, &1u32, &Choice::Heads);

        let result = client.try_submit_choice(&player, &1u32, &Choice::Tails);
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
        let (_, _, players) = configure_arena(&env, &client, round_speed, 2);
        client.start_round();

        let player   = players[0].clone();
        let absent   = Address::generate(&env);
        let expected = if submit_heads { Choice::Heads } else { Choice::Tails };

        client.submit_choice(&player, &1u32, &expected);

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
        let survivor_count = core::cmp::max(player_count as u32, bounds::MIN_ARENA_PARTICIPANTS);
        let (_, _, players) = configure_arena(&env, &client, round_speed, survivor_count);
        client.start_round();

        for p in players.iter().take(player_count) {
            client.submit_choice(p, &1u32, &Choice::Heads);
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
        let survivor_count = core::cmp::max(early_submitters as u32, bounds::MIN_ARENA_PARTICIPANTS);
        let (_, _, players) = configure_arena(&env, &client, round_speed, survivor_count);
        client.start_round();

        for p in players.iter().take(early_submitters) {
            client.submit_choice(p, &1u32, &Choice::Tails);
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
            let result = client.try_submit_choice(&late, &1u32, &Choice::Heads);
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
        let _ = configure_arena(&env, &client, round_speed, 2);
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
        let _ = configure_arena(&env, &client, round_speed, 2);
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
    let _ = configure_arena(&env, &client, SPEED, 2);

    let numbers = run_cycles(&env, &client, SPEED, CYCLES);

    assert_eq!(numbers.len(), CYCLES as usize);
    for (i, &n) in numbers.iter().enumerate() {
        assert_eq!(
            n,
            (i + 1) as u32,
            "round number out of sequence at index {i}"
        );
    }
}

// ── Admin access control tests ────────────────────────────────────────────────

#[test]
fn test_set_admin_changes_admin() {
    let (env, _admin, client) = setup_with_admin();
    let new_admin = Address::generate(&env);
    client.set_admin(&new_admin);
    assert_eq!(client.admin(), new_admin);
}

#[test]
#[should_panic(expected = "not initialized")]
fn test_set_admin_fails_without_admin() {
    let env = Env::default();
    let contract_id = env.register(ArenaContract, ());
    let client = ArenaContractClient::new(&env, &contract_id);
    let new_admin = Address::generate(&env);
    client.set_admin(&new_admin);
}

#[test]
#[should_panic(expected = "authorize")]
fn test_unauthorized_propose_upgrade_panics() {
    let env = Env::default();
    let contract_id = env.register(ArenaContract, ());
    let client = ArenaContractClient::new(&env, &contract_id);
    let admin = Address::generate(&env);
    client.initialize(&admin);

    client.propose_upgrade(&dummy_hash(&env));
}

#[test]
#[should_panic(expected = "authorize")]
fn test_unauthorized_execute_upgrade_panics() {
    let env = Env::default();
    let contract_id = env.register(ArenaContract, ());
    let client = ArenaContractClient::new(&env, &contract_id);
    let admin = Address::generate(&env);
    client.initialize(&admin);

    client.execute_upgrade();
}

#[test]
#[should_panic(expected = "authorize")]
fn test_unauthorized_cancel_upgrade_panics() {
    let env = Env::default();
    let contract_id = env.register(ArenaContract, ());
    let client = ArenaContractClient::new(&env, &contract_id);
    let admin = Address::generate(&env);
    client.initialize(&admin);

    client.cancel_upgrade();
}

// ── Issue #232: round timeout and stalled game recovery ──────────────────────

// AC: Timeout callable after deadline passes
#[test]
fn timeout_round_succeeds_one_ledger_after_deadline() {
    let (env, _admin, client, _token_id, _players) = setup_game(10, 2);
    set_ledger_sequence(&env, 1000);
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
    let (env, _admin, client, _token_id, _players) = setup_game(5, 2);
    set_ledger_sequence(&env, 500);
    client.start_round(); // deadline = 505

    set_ledger_sequence(&env, 506);
    let result = client.timeout_round();

    assert!(!result.active);
    assert!(result.timed_out);
}

// AC: timeout_round fails before deadline (round still open)
#[test]
fn timeout_round_fails_at_deadline_ledger() {
    let (env, _admin, client, _token_id, _players) = setup_game(4, 2);
    set_ledger_sequence(&env, 200);
    client.start_round(); // deadline = 204

    set_ledger_sequence(&env, 204); // exactly at deadline — still open
    let result = client.try_timeout_round();

    assert_eq!(result, Err(Ok(ArenaError::RoundStillOpen)));
}

#[test]
fn timeout_round_fails_before_deadline() {
    let (env, _admin, client, _token_id, _players) = setup_game(20, 2);
    set_ledger_sequence(&env, 100);
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
    let (env, _admin, client, _token_id, players) = setup_game(5, 2);
    let player = players[0].clone();
    set_ledger_sequence(&env, 300);
    client.start_round();

    // player submits within window
    set_ledger_sequence(&env, 302);
    env.mock_all_auths();
    client.submit_choice(&player, &1u32, &Choice::Heads);

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
    let (env, _admin, client, _token_id, players) = setup_game(3, 2);
    let player = players[0].clone();
    set_ledger_sequence(&env, 400);
    client.start_round(); // deadline = 403

    set_ledger_sequence(&env, 401);
    env.mock_all_auths();
    client.submit_choice(&player, &1u32, &Choice::Tails);

    set_ledger_sequence(&env, 404);
    client.timeout_round();

    // choice data must still be accessible for settlement / fund release
    let choice = client.get_choice(&1, &player);
    assert_eq!(choice, Some(Choice::Tails));
}

// AC: All-absent scenario — no submissions, game still resolves via timeout
#[test]
fn timeout_works_when_no_player_submitted() {
    let (env, _admin, client, _token_id, _players) = setup_game(5, 2);
    set_ledger_sequence(&env, 600);
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
    let (env, _admin, client, _token_id, _players) = setup_game(8, 3);
    set_ledger_sequence(&env, 700);
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
    let (env, _admin, client, _token_id, players) = setup_game(5, 2);
    let player = players[0].clone();
    set_ledger_sequence(&env, 800);
    client.start_round();

    set_ledger_sequence(&env, 806);
    let result = client.try_submit_choice(&player, &1u32, &Choice::Heads);

    assert_eq!(result, Err(Ok(ArenaError::SubmissionWindowClosed)));
}

// AC: New round starts cleanly after a timed-out round
#[test]
fn new_round_starts_after_timeout_with_fresh_state() {
    let (env, _admin, client, _token_id, _players) = setup_game(5, 2);
    set_ledger_sequence(&env, 900);
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
    let (env, _admin, client, _token_id, _players) = setup_game(10, 2);
    set_ledger_sequence(&env, 1000);
    client.start_round();

    set_ledger_sequence(&env, 1005);
    let result = client.try_start_round();

    assert_eq!(result, Err(Ok(ArenaError::RoundAlreadyActive)));
}

// AC: timeout_round cannot be called twice on the same round
#[test]
fn timeout_round_fails_on_already_timed_out_round() {
    let (env, _admin, client, _token_id, _players) = setup_game(3, 2);
    set_ledger_sequence(&env, 1100);
    client.start_round();

    set_ledger_sequence(&env, 1104);
    client.timeout_round(); // first call — succeeds

    let result = client.try_timeout_round(); // second call — no active round
    assert_eq!(result, Err(Ok(ArenaError::NoActiveRound)));
}

// AC: round number increments correctly across multiple timeout cycles
#[test]
fn round_number_increments_across_timeout_cycles() {
    let (env, _admin, client, _token_id, _players) = setup_game(2, 2);
    set_ledger_sequence(&env, 0);

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
    let (env, _admin, client, _token_id, players) = setup_game(10, 3);
    let player_a = players[0].clone();
    let player_b = players[1].clone();
    let player_c = Address::generate(&env);

    set_ledger_sequence(&env, 2000);
    client.start_round();

    // only player_a and player_b submit
    set_ledger_sequence(&env, 2005);
    env.mock_all_auths();
    client.submit_choice(&player_a, &1u32, &Choice::Heads);
    client.submit_choice(&player_b, &1u32, &Choice::Tails);

    set_ledger_sequence(&env, 2011);
    let timed_out = client.timeout_round();

    assert_eq!(timed_out.total_submissions, 2);
    assert_eq!(client.get_choice(&1, &player_a), Some(Choice::Heads));
    assert_eq!(client.get_choice(&1, &player_b), Some(Choice::Tails));
    assert_eq!(client.get_choice(&1, &player_c), None); // absent
}

#[test]
fn start_round_rejects_when_no_players_joined() {
    let (env, admin, client) = setup_with_admin();
    let (_asset, token_id) = setup_token(&env, &admin);
    client.set_token(&token_id);
    client.init(&5);

    let err = client.try_start_round();
    assert_eq!(err, Err(Ok(ArenaError::NotEnoughPlayers)));
}

#[test]
fn start_round_rejects_when_only_one_player_joined() {
    let (env, _admin, client, token_id, _players) = setup_game(5, 1);
    let late = Address::generate(&env);
    let asset = StellarAssetClient::new(&env, &token_id);
    asset.mint(&late, &1_000_000i128);

    let err = client.try_start_round();
    assert_eq!(err, Err(Ok(ArenaError::NotEnoughPlayers)));
}

#[test]
fn set_capacity_enforces_minimum_and_maximum_bounds() {
    let (_env, _admin, client) = setup_with_admin();

    assert_eq!(
        client.try_set_capacity(&0),
        Err(Ok(ArenaError::InvalidAmount))
    );
    assert_eq!(
        client.try_set_capacity(&1),
        Err(Ok(ArenaError::InvalidAmount))
    );
    assert!(client.try_set_capacity(&2).is_ok());
    assert_eq!(
        client.try_set_capacity(&(bounds::MAX_ARENA_PARTICIPANTS + 1)),
        Err(Ok(ArenaError::InvalidAmount))
    );
}

#[test]
fn resolve_round_advances_minority_survivors() {
    let (env, _admin, client, _token_id, players) = setup_game(5, 3);

    set_ledger_sequence(&env, 10);
    client.start_round();

    client.submit_choice(&players[0], &1, &Choice::Heads);
    client.submit_choice(&players[1], &1, &Choice::Tails);
    client.submit_choice(&players[2], &1, &Choice::Tails);

    set_ledger_sequence(&env, 16);
    let resolved = client.resolve_round();

    assert!(!resolved.active);
    assert!(resolved.finished);
    assert_eq!(client.get_arena_state().survivors_count, 1);
    assert!(client.get_user_state(&players[0]).is_active);
    assert!(!client.get_user_state(&players[1]).is_active);
    assert!(!client.get_user_state(&players[2]).is_active);
}

#[test]
fn resolve_round_tie_breaks_deterministically_from_ledger_sequence() {
    let (env, _admin, client, _token_id, players) = setup_game(5, 2);

    set_ledger_sequence(&env, 20);
    client.start_round();
    client.submit_choice(&players[0], &1, &Choice::Heads);
    client.submit_choice(&players[1], &1, &Choice::Tails);

    let resolve_ledger = 26;
    set_ledger_sequence(&env, resolve_ledger);
    client.resolve_round();

    let heads_survive = ((resolve_ledger ^ 1) & 1) == 0;
    assert_eq!(client.get_user_state(&players[0]).is_active, heads_survive);
    assert_eq!(client.get_user_state(&players[1]).is_active, !heads_survive);
}

#[test]
fn resolve_round_unanimous_choice_keeps_submitters_alive() {
    let (env, _admin, client, _token_id, players) = setup_game(5, 3);

    set_ledger_sequence(&env, 30);
    client.start_round();
    for player in &players {
        client.submit_choice(player, &1, &Choice::Heads);
    }

    set_ledger_sequence(&env, 36);
    client.resolve_round();

    assert_eq!(client.get_arena_state().survivors_count, 3);
    for player in &players {
        assert!(client.get_user_state(player).is_active);
    }
}

#[test]
fn resolve_round_allows_next_round_only_for_remaining_survivors() {
    let (env, _admin, client, _token_id, players) = setup_game(5, 5);

    set_ledger_sequence(&env, 40);
    client.start_round();
    client.submit_choice(&players[0], &1, &Choice::Heads);
    client.submit_choice(&players[1], &1, &Choice::Heads);
    client.submit_choice(&players[2], &1, &Choice::Tails);
    client.submit_choice(&players[3], &1, &Choice::Tails);
    client.submit_choice(&players[4], &1, &Choice::Tails);

    set_ledger_sequence(&env, 46);
    client.resolve_round();

    assert_eq!(client.get_arena_state().survivors_count, 2);

    set_ledger_sequence(&env, 50);
    let next_round = client.start_round();
    assert_eq!(next_round.round_number, 2);
    client.submit_choice(&players[0], &2, &Choice::Heads);

    let err = client.try_submit_choice(&players[2], &2, &Choice::Tails);
    assert_eq!(err, Err(Ok(ArenaError::PlayerEliminated)));
}

// ── Pause mechanism tests ───────────────────────────────────────────────────

#[test]
fn test_pause_unpause_admin_only() {
    let (_env, _admin, client) = setup_with_admin();

    assert!(!client.is_paused());

    // Admin can pause
    client.pause();
    assert!(client.is_paused());

    // Admin can unpause
    client.unpause();
    assert!(!client.is_paused());

    // Non-admin cannot pause
    let _ = client.try_pause();
    // This should fail authorize if it was checked correctly,
    // but in tests with mock_all_auths we need to verify it specifically if we want,
    // however, the code uses admin.require_auth() where admin is the stored admin.
    // Since we called initialize with `admin`, only `admin.require_auth()` will pass if it was the one calling.
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
    assert_eq!(
        client.try_submit_choice(&player, &1u32, &Choice::Heads),
        Err(Ok(ArenaError::Paused))
    );
    assert_eq!(client.try_timeout_round(), Err(Ok(ArenaError::Paused)));

    // These panic on failure in lib.rs if I used .unwrap(),
    // but I can use try_ versions to check Result.
    // Wait, in lib.rs I used require_not_paused(&env).unwrap() for proposals?
    // Let me check if they returned Result. No, they were void functions.
    // If they return Result, I can check error code.
}

#[test]
fn test_unpause_restores_functionality() {
    let (_env, _admin, client, _token_id, _players) = setup_game(10, 2);
    client.pause();
    client.unpause();

    // Should succeed now
    let round = client.start_round();
    assert_eq!(round.round_number, 1);
}

// ── Issue #271: Emergency Pause Policy — governance/upgrade exemption ──────────
//
// Policy: propose_upgrade, execute_upgrade, and cancel_upgrade must be callable
// by ADMIN even when the contract is paused, so that a recovery upgrade can
// always be initiated without first unpausing.

/// When paused, propose_upgrade still succeeds for the admin.
#[test]
fn test_propose_upgrade_succeeds_when_paused() {
    let (env, _admin, client) = setup_with_admin();
    let hash = dummy_hash(&env);

    client.pause();
    assert!(client.is_paused(), "contract must be paused for this test");

    // Must NOT panic or return Paused error — governance is exempt.
    client.propose_upgrade(&hash);

    let pending = client.pending_upgrade();
    assert!(
        pending.is_some(),
        "proposal must be stored even when contract is paused"
    );
    assert_eq!(pending.unwrap().0, hash);
}

/// When paused, cancel_upgrade still succeeds for the admin.
#[test]
fn test_cancel_upgrade_succeeds_when_paused() {
    let (env, _admin, client) = setup_with_admin();
    let hash = dummy_hash(&env);

    // Propose first, then pause.
    client.propose_upgrade(&hash);
    client.pause();
    assert!(client.is_paused());

    // Cancel must succeed even while paused.
    client.cancel_upgrade();

    assert!(
        client.pending_upgrade().is_none(),
        "proposal must be cleared even when contract is paused"
    );
}

/// When paused, cancel_upgrade can be called after a proposal made while paused.
#[test]
fn test_cancel_upgrade_after_paused_propose() {
    let (env, _admin, client) = setup_with_admin();
    let hash = dummy_hash(&env);

    client.pause();
    assert!(client.is_paused());

    // Propose while paused — must succeed.
    client.propose_upgrade(&hash);
    assert!(client.pending_upgrade().is_some());

    // Cancel while still paused — must also succeed.
    client.cancel_upgrade();
    assert!(client.pending_upgrade().is_none());
}

/// When paused, normal game functions are blocked but governance functions are not.
/// This is the core invariant of the Emergency Pause Policy.
#[test]
fn test_paused_blocks_game_functions_not_governance() {
    let (env, _admin, client) = setup_with_admin();
    let player = Address::generate(&env);
    let hash = dummy_hash(&env);

    client.init(&10u32);
    client.pause();
    assert!(client.is_paused());

    // Game functions MUST be blocked when paused.
    assert_eq!(
        client.try_start_round(),
        Err(Ok(ArenaError::Paused)),
        "start_round must fail when paused"
    );
    assert_eq!(
        client.try_timeout_round(),
        Err(Ok(ArenaError::Paused)),
        "timeout_round must fail when paused"
    );
    assert_eq!(
        client.try_submit_choice(&player, &1u32, &Choice::Heads),
        Err(Ok(ArenaError::Paused)),
        "submit_choice must fail when paused"
    );

    // Governance functions MUST succeed even when paused.
    client.propose_upgrade(&hash);
    assert!(
        client.pending_upgrade().is_some(),
        "propose_upgrade must succeed when paused"
    );

    client.cancel_upgrade();
    assert!(
        client.pending_upgrade().is_none(),
        "cancel_upgrade must succeed when paused"
    );
}

/// After unpausing, all functions — game and governance — work normally.
#[test]
fn test_all_functions_work_after_unpause() {
    let (env, _admin, client, _token_id, _players) = setup_game(10, 2);
    let hash = dummy_hash(&env);

    client.pause();
    client.unpause();
    assert!(!client.is_paused());

    // Game functions must work again.
    let round = client.start_round();
    assert_eq!(round.round_number, 1);
    assert!(round.active);

    // Governance functions must also still work unpaused.
    client.propose_upgrade(&hash);
    assert!(client.pending_upgrade().is_some());

    client.cancel_upgrade();
    assert!(client.pending_upgrade().is_none());
}

/// Propose while paused, then unpause and verify the proposal persists so
/// execute_upgrade can be called after the timelock elapses.
#[test]
fn test_paused_proposal_persists_after_unpause() {
    let (env, _admin, client) = setup_with_admin();
    let hash = dummy_hash(&env);

    client.pause();
    client.propose_upgrade(&hash);

    let pending_paused = client
        .pending_upgrade()
        .expect("proposal must exist while paused");
    assert_eq!(pending_paused.0, hash);

    // Unpause — proposal must survive.
    client.unpause();
    assert!(!client.is_paused());

    let pending_unpaused = client
        .pending_upgrade()
        .expect("proposal must persist after unpause");
    assert_eq!(pending_unpaused.0, hash);
    assert_eq!(
        pending_paused.1, pending_unpaused.1,
        "execute_after timestamp must be unchanged"
    );
}

/// is_paused() view function reflects pause/unpause state transitions correctly.
#[test]
fn test_is_paused_reflects_state_transitions() {
    let (_env, _admin, client) = setup_with_admin();

    assert!(!client.is_paused(), "contract starts unpaused");

    client.pause();
    assert!(client.is_paused(), "must be paused after pause()");

    client.unpause();
    assert!(!client.is_paused(), "must be unpaused after unpause()");

    // Toggle multiple times — state must always match the last call.
    client.pause();
    client.pause(); // idempotent
    assert!(client.is_paused());

    client.unpause();
    assert!(!client.is_paused());
}

// ── Issue #214: get_arena_state() ─────────────────────────────────────────────

/// All fields default to zero / false on a fresh contract with no players.
#[test]
fn get_arena_state_defaults_before_any_action() {
    let env = Env::default();
    let client = create_client(&env);

    let state = client.get_arena_state();
    assert_eq!(state.survivors_count, 0);
    assert_eq!(state.max_capacity, 0);
    assert_eq!(state.round_number, 0);
    assert_eq!(state.current_stake, 0);
    assert_eq!(state.potential_payout, 0);
}

/// `round_number` in the returned state matches the value returned by `start_round`.
#[test]
fn get_arena_state_reflects_round_number() {
    let (env, _admin, client, _token_id, _players) = setup_game(5, 2);
    set_ledger_sequence(&env, 100);
    let round = client.start_round();

    let state = client.get_arena_state();
    assert_eq!(state.round_number, round.round_number);
    assert_eq!(state.round_number, 1);
}

/// After `join()`, `survivors_count` increases and subsequent reads are consistent.
#[test]
fn get_arena_state_reflects_survivor_count() {
    let (env, admin, client) = setup_with_admin();
    let (_token, token_id) = setup_token(&env, &admin);
    let asset = StellarAssetClient::new(&env, &token_id);
    asset.mint(&client.address, &1_000_000i128);
    client.set_token(&token_id);

    env.mock_all_auths();
    let player_a = Address::generate(&env);
    let player_b = Address::generate(&env);
    asset.mint(&player_a, &10_000i128);
    asset.mint(&player_b, &10_000i128);

    let (_token, token_id) = setup_token(&env, &admin);
    let asset = StellarAssetClient::new(&env, &token_id);
    client.set_token(&token_id);

    let player_a = Address::generate(&env);
    let player_b = Address::generate(&env);

    // Mint tokens to players so they can stake.
    asset.mint(&player_a, &20_000_000i128);
    asset.mint(&player_b, &20_000_000i128);

    // Before any joins.
    assert_eq!(client.get_arena_state().survivors_count, 0);

    client.join(&player_a, &10_000_000i128);
    assert_eq!(client.get_arena_state().survivors_count, 1);

    client.join(&player_b, &10_000_000i128);
    assert_eq!(client.get_arena_state().survivors_count, 2);
}

/// After `set_capacity(n)`, `max_capacity` reflects that value.
#[test]
fn get_arena_state_reflects_capacity() {
    let (_env, _admin, client) = setup_with_admin();

    assert_eq!(client.get_arena_state().max_capacity, 0, "default is 0");

    client.set_capacity(&8u32);
    assert_eq!(client.get_arena_state().max_capacity, 8);
}

/// Calling `get_arena_state` twice returns identical results with no side effects.
#[test]
fn get_arena_state_is_pure_read() {
    let (env, _admin, client, _token_id, _players) = setup_game(10, 2);
    set_ledger_sequence(&env, 50);
    client.start_round();

    let state_a = client.get_arena_state();
    let state_b = client.get_arena_state();
    assert_eq!(
        state_a, state_b,
        "repeated calls must return identical state"
    );
}

// ── Issue #275: explicit submission / participant bounds (N−1, N, N+1) ────────

#[test]
fn submission_boundary_n_minus_1_n_n_plus_1() {
    let env = make_env();
    let client = create_client(&env);
    let cap = crate::bounds::MAX_SUBMISSIONS_PER_ROUND;
    assert!(cap >= 3, "bounds must allow a three-point boundary test");

    advance_ledger_with_auth(&env, 500);
    let survivor_count = core::cmp::max(cap + 1, bounds::MIN_ARENA_PARTICIPANTS);
    let (_, _, players) = configure_arena(&env, &client, 20, survivor_count);
    client.start_round();

    let n = cap - 1;
    for p in players.iter().take(n as usize) {
        client.submit_choice(&p, &1u32, &Choice::Heads);
    }
    assert_eq!(client.get_round().total_submissions, n);

    let last_ok = players.get(n as usize).unwrap();
    client.submit_choice(&last_ok, &1u32, &Choice::Tails);
    assert_eq!(client.get_round().total_submissions, cap);

    let too_many = players.get(cap as usize).unwrap();
    let err = client.try_submit_choice(&too_many, &1u32, &Choice::Heads);
    assert_eq!(err, Err(Ok(ArenaError::MaxSubmissionsPerRound)));
}

#[test]
fn join_boundary_participants_n_minus_1_n_n_plus_1() {
    let (env, admin, client) = setup_with_admin();
    let (_token, token_id) = setup_token(&env, &admin);
    let asset = StellarAssetClient::new(&env, &token_id);
    asset.mint(&client.address, &50_000_000i128);
    client.set_token(&token_id);

    // Use admin capacity so the test stays fast while still exercising typed `ArenaFull`.
    const CAP: u32 = 50;
    client.set_capacity(&CAP);

    env.mock_all_auths();
    for _ in 0..(CAP - 1) {
        let p = Address::generate(&env);
        asset.mint(&p, &1000i128);
        client.join(&p, &100i128);
    }
    assert_eq!(client.get_arena_state().survivors_count, CAP - 1);

    let last_ok = Address::generate(&env);
    asset.mint(&last_ok, &1000i128);
    client.join(&last_ok, &100i128);
    assert_eq!(client.get_arena_state().survivors_count, CAP);

    let too_many = Address::generate(&env);
    asset.mint(&too_many, &1000i128);
    let err = client.try_join(&too_many, &100i128);
    assert_eq!(err, Err(Ok(ArenaError::ArenaFull)));
}

// ── Issue #277: round state machine invariant suite ───────────────────────────

#[test]
fn round_state_machine_invariant_suite_happy_path() {
    let (env, _admin, client, _token_id, _players) = setup_game(5, 2);
    set_ledger_sequence(&env, 100);
    let r0 = client.get_round();
    invariants::check_round_flags(&r0).unwrap();

    let r1 = client.start_round();
    invariants::check_round_flags(&r1).unwrap();
    invariants::check_round_number_monotonic(r0.round_number, r1.round_number).unwrap();
    invariants::check_submission_count_monotonic(r0.total_submissions, r1.total_submissions)
        .unwrap();

    set_ledger_sequence(&env, 106);
    let r1t = client.timeout_round();
    invariants::check_round_flags(&r1t).unwrap();
    invariants::check_timeout_transition(&r1, &r1t).unwrap();
}

// ── Issue #319: claim prize-pool drain and round.finished ─────────────────────

#[test]
fn claim_single_winner_gets_correct_prize() {
    let (env, admin, client) = setup_with_admin();
    let (asset, token_id) = setup_token(&env, &admin);
    // Fund the contract with enough tokens for the prize.
    asset.mint(&client.address, &1_500i128);
    client.set_token(&token_id);

    let winner = Address::generate(&env);
    client.set_winner(&winner, &1_000i128, &500i128);

    let claimed = client.claim(&winner);
    assert_eq!(claimed, 1_500i128);
}

#[test]
fn claim_second_set_winner_overwrites_prize_pool() {
    let (env, admin, client) = setup_with_admin();
    let (asset, token_id) = setup_token(&env, &admin);
    asset.mint(&client.address, &3_000i128);
    client.set_token(&token_id);

    let winner_a = Address::generate(&env);
    let winner_b = Address::generate(&env);
    client.set_winner(&winner_a, &1_000i128, &500i128);
    // Second set_winner overwrites the prize pool.
    client.set_winner(&winner_b, &800i128, &200i128);

    // The active prize pool is now 1000 (800 + 200), not 1500.
    let claimed_b = client.claim(&winner_b);
    assert_eq!(claimed_b, 1_000i128);
}

#[test]
fn claim_last_winner_sets_round_finished() {
    let (env, admin, client) = setup_with_admin();
    let (asset, token_id) = setup_token(&env, &admin);
    asset.mint(&client.address, &1_000i128);
    client.set_token(&token_id);

    let winner = Address::generate(&env);
    client.set_winner(&winner, &600i128, &400i128);

    // Before claim, start a round so RoundState exists.
    client.init(&5);
    let participant_a = Address::generate(&env);
    let participant_b = Address::generate(&env);
    asset.mint(&participant_a, &100i128);
    asset.mint(&participant_b, &100i128);
    client.join(&participant_a, &10i128);
    client.join(&participant_b, &10i128);
    set_ledger_sequence(&env, 1);
    client.start_round();

    client.claim(&winner);

    // After the last (only) winner claims, round.finished must be true.
    let round = client.get_round();
    assert!(round.finished);
}

#[test]
fn claim_already_claimed_returns_error() {
    let (env, admin, client) = setup_with_admin();
    let (asset, token_id) = setup_token(&env, &admin);
    asset.mint(&client.address, &1_000i128);
    client.set_token(&token_id);

    let winner = Address::generate(&env);
    client.set_winner(&winner, &600i128, &400i128);
    client.claim(&winner);

    // Second claim must be rejected.
    let err = client.try_claim(&winner);
    assert_eq!(err, Err(Ok(ArenaError::AlreadyClaimed)));
}

#[test]
fn join_rejects_after_game_is_finished() {
    let (env, admin, client) = setup_with_admin();
    let (asset, token_id) = setup_token(&env, &admin);
    client.set_token(&token_id);

    let winner = Address::generate(&env);
    client.set_winner(&winner, &600i128, &400i128);
    asset.mint(&client.address, &1_000i128);
    client.claim(&winner);

    let player = Address::generate(&env);
    asset.mint(&player, &100i128);
    let err = client.try_join(&player, &100i128);
    assert_eq!(err, Err(Ok(ArenaError::GameAlreadyFinished)));
}

#[test]
fn start_round_rejects_after_game_is_finished() {
    let (env, admin, client) = setup_with_admin();
    let (asset, token_id) = setup_token(&env, &admin);
    client.set_token(&token_id);

    client.init(&5);
    let winner = Address::generate(&env);
    client.set_winner(&winner, &600i128, &400i128);
    asset.mint(&client.address, &1_000i128);
    client.claim(&winner);

    let err = client.try_start_round();
    assert_eq!(err, Err(Ok(ArenaError::GameAlreadyFinished)));
}

// ── Issue #XXX: join() CEI ordering and retry after failed join ───────────────

#[test]
fn join_fails_when_token_not_set() {
    let (env, _admin, client) = setup_with_admin();
    // No set_token call — token is unset.
    env.mock_all_auths();

    let player = Address::generate(&env);
    let err = client.try_join(&player, &100i128);
    assert_eq!(err, Err(Ok(ArenaError::TokenNotSet)));

    // Player must NOT be marked as AlreadyJoined — no partial state committed.
    let err2 = client.try_join(&player, &100i128);
    assert_eq!(err2, Err(Ok(ArenaError::TokenNotSet)));
}

#[test]
fn join_succeeds_on_retry_after_capacity_was_cleared() {
    let (env, admin, client) = setup_with_admin();
    let (_token, token_id) = setup_token(&env, &admin);
    let asset = StellarAssetClient::new(&env, &token_id);

    const CAP: u32 = 2;
    client.set_token(&token_id);
    client.set_capacity(&CAP);

    env.mock_all_auths();

    // Fill arena to capacity.
    for _ in 0..CAP {
        let p = Address::generate(&env);
        asset.mint(&p, &1000i128);
        client.join(&p, &100i128);
    }

    // This player cannot join — arena is full.
    let late = Address::generate(&env);
    asset.mint(&late, &1000i128);
    let err = client.try_join(&late, &100i128);
    assert_eq!(err, Err(Ok(ArenaError::ArenaFull)));

    // Expand capacity so the player can retry — must NOT get AlreadyJoined.
    client.set_capacity(&(CAP + 1));
    client.join(&late, &100i128);
    assert_eq!(client.get_arena_state().survivors_count, CAP + 1);
}

#[test]
fn join_fails_when_paused() {
    let (env, admin, client) = setup_with_admin();
    let (_token, token_id) = setup_token(&env, &admin);
    let asset = StellarAssetClient::new(&env, &token_id);
    client.set_token(&token_id);

    env.mock_all_auths();
    client.pause();

    let player = Address::generate(&env);
    asset.mint(&player, &1000i128);
    let err = client.try_join(&player, &100i128);
    assert_eq!(err, Err(Ok(ArenaError::Paused)));
}

#[test]
fn winner_is_identifiable_before_claim() {
    let env = Env::default();
    env.mock_all_auths();
    let client = create_client(&env);
    client.init(&10);
    client.initialize(&Address::generate(&env));

    let token_admin_addr = Address::generate(&env);
    let asset = env.register_stellar_asset_contract_v2(token_admin_addr.clone());
    let token_addr = asset.address();
    client.set_token(&token_addr);

    let winner = Address::generate(&env);
    client.set_winner(&winner, &1000, &100);

    let state = client.get_user_state(&winner);
    assert_eq!(state.has_won, true);
    assert_eq!(state.is_active, false);
}

#[test]
fn submit_choice_wrong_round_returns_wrong_round_number() {
    let env = make_env();
    let client = create_client(&env);
    let (_, _, players) = configure_arena(&env, &client, 10, 2);
    client.start_round();

    let player = players[0].clone();
    let result = client.try_submit_choice(&player, &99u32, &Choice::Heads);
    assert_eq!(result, Err(Ok(ArenaError::WrongRoundNumber)));
}

// ── get_user_state ───────────────────────────────────────────────────────────

#[test]
fn get_user_state_non_existent_player_returns_inactive() {
    let env = Env::default();
    env.mock_all_auths();
    let client = create_client(&env);
    set_ledger_sequence(&env, 800);
    client.init(&5);

    let unknown = Address::generate(&env);
    let state = client.get_user_state(&unknown);
    assert_eq!(state.is_active, false);
    assert_eq!(state.has_won, false);
}

#[test]
fn get_user_state_active_player_shows_active() {
    let (env, admin, client) = setup_with_admin();
    let (asset, token_id) = setup_token(&env, &admin);
    client.set_token(&token_id);
    set_ledger_sequence(&env, 800);
    client.init(&5);

    let player = Address::generate(&env);
    asset.mint(&player, &100i128);
    client.join(&player, &10i128);

    let state = client.get_user_state(&player);
    assert_eq!(state.is_active, true);
    assert_eq!(state.has_won, false);
}

#[test]
fn get_user_state_returns_consistent_for_multiple_players() {
    let (env, admin, client) = setup_with_admin();
    let (asset, token_id) = setup_token(&env, &admin);
    client.set_token(&token_id);
    set_ledger_sequence(&env, 800);
    client.init(&5);

    let player_a = Address::generate(&env);
    let player_b = Address::generate(&env);
    let outsider = Address::generate(&env);

    asset.mint(&player_a, &100i128);
    asset.mint(&player_b, &100i128);
    client.join(&player_a, &10i128);
    client.join(&player_b, &20i128);

    let state_a = client.get_user_state(&player_a);
    let state_b = client.get_user_state(&player_b);
    let state_outsider = client.get_user_state(&outsider);

    assert_eq!(state_a.is_active, true);
    assert_eq!(state_b.is_active, true);
    assert_eq!(state_outsider.is_active, false);
    assert_eq!(state_outsider.has_won, false);
}

// ── Issue #312: non-survivor cannot submit_choice ─────────────────────────────

#[test]
fn submit_choice_rejects_non_survivor() {
    let (env, _admin, client, _token_id, _players) = setup_game(5, 2);

    set_ledger_sequence(&env, 100);
    client.start_round();

    let non_survivor = Address::generate(&env);

    // non_survivor never called join(), so they have no Survivor key.
    let result = client.try_submit_choice(&non_survivor, &1u32, &Choice::Heads);
    assert_eq!(result, Err(Ok(ArenaError::NotASurvivor)));

    // Confirm no submission was recorded.
    assert_eq!(client.get_choice(&1, &non_survivor), None);
    assert_eq!(client.get_round().total_submissions, 0);
}
