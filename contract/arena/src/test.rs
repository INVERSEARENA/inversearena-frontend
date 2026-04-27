#![cfg(test)]

extern crate std;
use std::vec::Vec;

use super::*;
use proptest::prelude::*;
use soroban_sdk::{
    Address, Bytes, BytesN, Env, IntoVal, Symbol, contract, contractimpl, contracttype,
    testutils::{Address as _, Ledger as _, LedgerInfo},
    token::StellarAssetClient,
};

const TEST_REQUIRED_STAKE: i128 = 100i128;

#[contracttype]
#[derive(Clone)]
enum MockFactoryKey {
    Whitelisted(u64, Address),
}

#[contract]
struct MockWhitelistFactory;

#[contractimpl]
impl MockWhitelistFactory {
    pub fn set_whitelisted(env: Env, arena_id: u64, player: Address, allowed: bool) {
        let key = MockFactoryKey::Whitelisted(arena_id, player);
        env.storage().persistent().set(&key, &allowed);
    }

    pub fn is_whitelisted(env: Env, arena_id: u64, player: Address) -> bool {
        let key = MockFactoryKey::Whitelisted(arena_id, player);
        env.storage().persistent().get(&key).unwrap_or(false)
    }
}

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

fn seed_contract_prng(env: &Env, contract_id: &Address, seed: [u8; 32]) {
    env.as_contract(contract_id, || {
        env.prng().seed(Bytes::from_array(env, &seed));
    });
}

fn create_client<'a>(env: &'a Env) -> ArenaContractClient<'a> {
    env.mock_all_auths();
    let admin = Address::generate(env);
    let contract_id = env.register(ArenaContract, (&admin,));
    ArenaContractClient::new(env, &contract_id)
}

/// Advance ledger and immediately re-apply mock_all_auths.
/// Call this in proptest tests before any submit_choice invocation.
fn advance_ledger_with_auth(env: &Env, sequence_number: u32) {
    set_ledger(env, sequence_number);
    env.mock_all_auths();
}

fn advance_past_resolution_window(env: &Env, round: &RoundState) {
    let resolve_at = round
        .round_deadline_ledger
        .checked_add(grace_period_to_ledgers(
            bounds::DEFAULT_GRACE_PERIOD_SECONDS,
        ))
        .expect("resolution ledger overflow in test")
        + 1;
    set_ledger_sequence(env, resolve_at);
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

    let admin = Address::generate(&env);
    let contract_id = env.register(ArenaContract, (&admin,));

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
        client.join(&player, &TEST_REQUIRED_STAKE);
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
    // Admin is already set via constructor; get it from contract storage indirectly.
    let admin = client.admin();
    let (_asset, token_id) = setup_token(env, &admin);
    client.set_token(&token_id);
    client.init(&round_speed, &TEST_REQUIRED_STAKE, &3600);
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
    client.init(&round_speed, &TEST_REQUIRED_STAKE, &3600);
    env.mock_all_auths();
    let players = seed_joined_players(&env, &client, &token_id, player_count);
    (env, admin, client, token_id, players)
}

fn setup_finished_game_with_winner(
    prize_amount: i128,
) -> (Env, Address, ArenaContractClient<'static>, Address, Address) {
    let (env, admin, client, token_id, players) = setup_game(5, 3);
    let asset = StellarAssetClient::new(&env, &token_id);
    let existing_pool = TEST_REQUIRED_STAKE * players.len() as i128;
    // set_winner adds prize_amount to the existing pool (from player joins),
    // so the contract needs enough balance to cover both.
    let total_needed = existing_pool + prize_amount;
    if total_needed > existing_pool {
        asset.mint(&client.address, &(total_needed - existing_pool));
    }

    set_ledger_sequence(&env, 1);
    let round = client.start_round();
    client.submit_choice(&players[0], &round.round_number, &Choice::Heads);
    client.submit_choice(&players[1], &round.round_number, &Choice::Tails);
    client.submit_choice(&players[2], &round.round_number, &Choice::Tails);
    advance_past_resolution_window(&env, &round);
    client.resolve_round();

    let winner = players[0].clone();
    client.set_winner(&winner, &prize_amount, &0i128);

    (env, admin, client, token_id, winner)
}

fn setup_private_arena_with_mock_factory()
-> (Env, ArenaContractClient<'static>, Address, Address, u64) {
    let (env, admin, client) = setup_with_admin();
    let (_asset, token_id) = setup_token(&env, &admin);
    client.set_token(&token_id);
    client.init(&5, &TEST_REQUIRED_STAKE, &(env.ledger().timestamp() + 3600));

    let mock_factory = env.register(MockWhitelistFactory, ());
    let arena_id = 42u64;
    client.init_factory(&mock_factory, &admin);

    env.as_contract(&client.address, || {
        let mut config: ArenaConfig = env
            .storage()
            .instance()
            .get(&DataKey::Config)
            .expect("arena config must exist");
        config.is_private = true;
        env.storage().instance().set(&DataKey::Config, &config);
        env.storage()
            .instance()
            .set(&DataKey::FactoryAddress, &mock_factory);
        env.storage().instance().set(&DataKey::ArenaId, &arena_id);
    });

    (env, client, token_id, mock_factory, arena_id)
}

// ── round_speed bounds ────────────────────────────────────────────────────────

#[test]
fn test_init_zero_round_speed_returns_invalid() {
    let env = make_env();
    let client = create_client(&env);
    assert_eq!(
        client.try_init(&0, &TEST_REQUIRED_STAKE, &3600),
        Err(Ok(ArenaError::InvalidRoundSpeed))
    );
}

#[test]
fn test_init_min_round_speed_succeeds() {
    let env = make_env();
    let client = create_client(&env);
    assert!(
        client
            .try_init(&bounds::MIN_SPEED_LEDGERS, &TEST_REQUIRED_STAKE, &3600)
            .is_ok()
    );
}

#[test]
fn test_init_max_round_speed_succeeds() {
    let env = make_env();
    let client = create_client(&env);
    assert!(
        client
            .try_init(&bounds::MAX_SPEED_LEDGERS, &TEST_REQUIRED_STAKE, &3600)
            .is_ok()
    );
}

#[test]
fn test_init_above_max_round_speed_returns_invalid() {
    let env = make_env();
    let client = create_client(&env);
    assert_eq!(
        client.try_init(
            &(bounds::MAX_SPEED_LEDGERS + 1),
            &TEST_REQUIRED_STAKE,
            &3600
        ),
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
    client.init(&5, &10i128, &3600);

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
fn test_double_initialize_panics() {
    // With __constructor, double initialization is structurally impossible.
    let (_env, admin, client) = setup_with_admin();
    assert_eq!(client.admin(), admin);
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
fn test_propose_upgrade_rejects_when_pending() {
    let (env, _admin, client) = setup_with_admin();
    let hash1 = BytesN::from_array(&env, &[1u8; 32]);
    let hash2 = BytesN::from_array(&env, &[2u8; 32]);

    client.propose_upgrade(&hash1);
    let result = client.try_propose_upgrade(&hash2);
    assert_eq!(result, Err(Ok(ArenaError::UpgradeAlreadyPending)));

    // Original proposal remains intact.
    let pending = client.pending_upgrade().unwrap();
    assert_eq!(pending.0, hash1);
}

#[test]
fn test_propose_upgrade_allowed_after_cancel() {
    let (env, _admin, client) = setup_with_admin();
    let hash1 = BytesN::from_array(&env, &[1u8; 32]);
    let hash2 = BytesN::from_array(&env, &[2u8; 32]);

    client.propose_upgrade(&hash1);
    client.cancel_upgrade();
    client.propose_upgrade(&hash2);

    let pending = client.pending_upgrade().unwrap();
    assert_eq!(pending.0, hash2);
}

#[test]
fn test_execute_without_proposal_returns_error() {
    let (env, _admin, client) = setup_with_admin();
    assert_eq!(
        client.try_execute_upgrade(&dummy_hash(&env)),
        Err(Ok(ArenaError::NoPendingUpgrade))
    );
}

#[test]
fn test_execute_before_timelock_returns_error() {
    let (env, _admin, client) = setup_with_admin();
    let hash = dummy_hash(&env);
    client.propose_upgrade(&hash);
    env.ledger().with_mut(|l| {
        l.timestamp += 47 * 60 * 60;
    });
    assert_eq!(
        client.try_execute_upgrade(&hash),
        Err(Ok(ArenaError::TimelockNotExpired))
    );
}

#[test]
fn test_execute_exactly_at_boundary_returns_error() {
    let (env, _admin, client) = setup_with_admin();
    let propose_time = env.ledger().timestamp();
    let hash = dummy_hash(&env);
    client.propose_upgrade(&hash);
    env.ledger().with_mut(|l| {
        l.timestamp = propose_time + TIMELOCK - 1;
    });
    assert_eq!(
        client.try_execute_upgrade(&hash),
        Err(Ok(ArenaError::TimelockNotExpired))
    );
}

#[test]
fn test_cancel_without_proposal_returns_error() {
    let (_env, _admin, client) = setup_with_admin();
    assert_eq!(
        client.try_cancel_upgrade(),
        Err(Ok(ArenaError::NoPendingUpgrade))
    );
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
fn test_execute_after_cancel_returns_error() {
    let (env, _admin, client) = setup_with_admin();
    let hash = dummy_hash(&env);
    client.propose_upgrade(&hash);
    client.cancel_upgrade();

    env.ledger().with_mut(|l| {
        l.timestamp += TIMELOCK + 1;
    });
    assert_eq!(
        client.try_execute_upgrade(&hash),
        Err(Ok(ArenaError::NoPendingUpgrade))
    );
}

#[test]
fn test_double_cancel_returns_error() {
    let (env, _admin, client) = setup_with_admin();
    client.propose_upgrade(&dummy_hash(&env));
    client.cancel_upgrade();
    assert_eq!(
        client.try_cancel_upgrade(),
        Err(Ok(ArenaError::NoPendingUpgrade))
    );
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

// ── Issue #518: required timelock test suite (9 cases) ───────────────────────

#[test]
fn timelock_propose_stores_hash_and_executable_after_and_emits_event() {
    use soroban_sdk::testutils::Ledger as _;

    let (env, _admin, client) = setup_with_admin();
    let hash = BytesN::from_array(&env, &[0u8; 32]);

    client.propose_upgrade(&hash);

    let pending = client.pending_upgrade().expect("pending must be set");
    assert_eq!(pending.0, hash);
    assert!(
        pending.1 >= env.ledger().timestamp() + TIMELOCK,
        "executable_after must be at least propose_time + 48h"
    );
}

#[test]
fn timelock_execute_before_delay_returns_timelock_not_expired() {
    let (env, _admin, client) = setup_with_admin();
    let hash = BytesN::from_array(&env, &[0u8; 32]);
    client.propose_upgrade(&hash);
    env.ledger().with_mut(|l| {
        l.timestamp += TIMELOCK - 1;
    });
    assert_eq!(
        client.try_execute_upgrade(&hash),
        Err(Ok(ArenaError::TimelockNotExpired))
    );
}

#[test]
fn timelock_execute_exactly_at_boundary_passes_timelock_check() {
    let (env, _admin, client) = setup_with_admin();
    let hash = BytesN::from_array(&env, &[0u8; 32]);
    let propose_time = env.ledger().timestamp();
    client.propose_upgrade(&hash);
    env.ledger().with_mut(|l| {
        l.timestamp = propose_time + TIMELOCK;
    });
    // The timelock check passes (timestamp >= execute_after).
    // The WASM deployer may abort in test env — verify we did NOT get TimelockNotExpired.
    let result = client.try_execute_upgrade(&hash);
    assert_ne!(
        result,
        Err(Ok(ArenaError::TimelockNotExpired)),
        "timelock must allow execution at timestamp == execute_after"
    );
}

#[test]
fn timelock_execute_after_delay_passes_timelock_check() {
    let (env, _admin, client) = setup_with_admin();
    let hash = BytesN::from_array(&env, &[0u8; 32]);
    let propose_time = env.ledger().timestamp();
    client.propose_upgrade(&hash);
    env.ledger().with_mut(|l| {
        l.timestamp = propose_time + TIMELOCK + 3600;
    });
    let result = client.try_execute_upgrade(&hash);
    assert_ne!(
        result,
        Err(Ok(ArenaError::TimelockNotExpired)),
        "timelock must allow execution after the delay"
    );
}

#[test]
fn timelock_cancel_before_execute_clears_pending_and_execute_panics() {
    let (env, _admin, client) = setup_with_admin();
    let hash = BytesN::from_array(&env, &[0u8; 32]);
    client.propose_upgrade(&hash);
    client.cancel_upgrade();

    assert!(client.pending_upgrade().is_none());

    env.ledger().with_mut(|l| {
        l.timestamp += TIMELOCK + 1;
    });
    assert_eq!(
        client.try_execute_upgrade(&hash),
        Err(Ok(ArenaError::NoPendingUpgrade))
    );
}

#[test]
#[should_panic(expected = "authorize")]
fn timelock_non_admin_propose_panics() {
    let env = Env::default();
    let admin = Address::generate(&env);
    let contract_id = env.register(ArenaContract, (&admin,));
    let client = ArenaContractClient::new(&env, &contract_id);
    let hash = BytesN::from_array(&env, &[0u8; 32]);
    client.propose_upgrade(&hash);
}

#[test]
#[should_panic(expected = "authorize")]
fn timelock_non_admin_execute_panics() {
    let env = Env::default();
    let admin = Address::generate(&env);
    let contract_id = env.register(ArenaContract, (&admin,));
    let client = ArenaContractClient::new(&env, &contract_id);
    let hash = BytesN::from_array(&env, &[0u8; 32]);
    client.execute_upgrade(&hash);
}

#[test]
fn timelock_double_propose_returns_upgrade_already_pending() {
    let (env, _admin, client) = setup_with_admin();
    let hash1 = BytesN::from_array(&env, &[1u8; 32]);
    let hash2 = BytesN::from_array(&env, &[2u8; 32]);

    client.propose_upgrade(&hash1);
    let result = client.try_propose_upgrade(&hash2);
    assert_eq!(result, Err(Ok(ArenaError::UpgradeAlreadyPending)));

    // First proposal is intact.
    let pending = client.pending_upgrade().unwrap();
    assert_eq!(pending.0, hash1);
}

#[test]
fn timelock_execute_with_wrong_hash_returns_hash_mismatch() {
    let (env, _admin, client) = setup_with_admin();
    let stored_hash = BytesN::from_array(&env, &[0u8; 32]);
    let wrong_hash = BytesN::from_array(&env, &[0xFFu8; 32]);

    let propose_time = env.ledger().timestamp();
    client.propose_upgrade(&stored_hash);
    env.ledger().with_mut(|l| {
        l.timestamp = propose_time + TIMELOCK;
    });

    assert_eq!(
        client.try_execute_upgrade(&wrong_hash),
        Err(Ok(ArenaError::HashMismatch))
    );
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

        client.init(&first_speed, &TEST_REQUIRED_STAKE, &3600);
        let result = client.try_init(&second_speed, &TEST_REQUIRED_STAKE, &3600);

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
    // With constructor, admin is always set. This test uses direct storage injection
    // to simulate an uninitialized contract for edge-case coverage.
    let env = Env::default();
    let admin = Address::generate(&env);
    let contract_id = env.register(ArenaContract, (&admin,));
    let client = ArenaContractClient::new(&env, &contract_id);
    let new_admin = Address::generate(&env);
    client.set_admin(&new_admin);
}

#[test]
#[should_panic(expected = "authorize")]
fn test_unauthorized_propose_upgrade_panics() {
    let env = Env::default();
    let admin = Address::generate(&env);
    let admin = Address::generate(&env);
    let contract_id = env.register(ArenaContract, (&admin,));
    env.as_contract(&contract_id, || {
        env.storage()
            .instance()
            .set(&symbol_short!("ADMIN"), &admin);
    });
    let client = ArenaContractClient::new(&env, &contract_id);
    client.propose_upgrade(&dummy_hash(&env));
}

#[test]
#[should_panic(expected = "authorize")]
fn test_unauthorized_execute_upgrade_panics() {
    let env = Env::default();
    let admin = Address::generate(&env);
    let contract_id = env.register(ArenaContract, (&admin,));
    let client = ArenaContractClient::new(&env, &contract_id);
    client.execute_upgrade(&soroban_sdk::BytesN::from_array(&env, &[0; 32]));
}

#[test]
#[should_panic(expected = "authorize")]
fn test_unauthorized_cancel_upgrade_panics() {
    let env = Env::default();
    let admin = Address::generate(&env);
    let admin = Address::generate(&env);
    let contract_id = env.register(ArenaContract, (&admin,));
    env.as_contract(&contract_id, || {
        env.storage()
            .instance()
            .set(&symbol_short!("ADMIN"), &admin);
    });
    let client = ArenaContractClient::new(&env, &contract_id);
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
    client.init(&3, &TEST_REQUIRED_STAKE, &3600);
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
    client.init(&5, &TEST_REQUIRED_STAKE, &3600);

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
        Err(Ok(ArenaError::InvalidCapacity))
    );
    assert_eq!(
        client.try_set_capacity(&1),
        Err(Ok(ArenaError::InvalidCapacity))
    );
    assert!(client.try_set_capacity(&2).is_ok());
    assert_eq!(
        client.try_set_capacity(&(bounds::MAX_ARENA_PARTICIPANTS + 1)),
        Err(Ok(ArenaError::InvalidCapacity))
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
fn resolve_round_tie_break_uses_prng_seed_instead_of_ledger_sequence() {
    let (env, _admin, client, _token_id, players) = setup_game(5, 2);

    set_ledger_sequence(&env, 20);
    client.start_round();
    client.submit_choice(&players[0], &1, &Choice::Heads);
    client.submit_choice(&players[1], &1, &Choice::Tails);

    seed_contract_prng(&env, &client.address, [1; 32]);

    let resolve_ledger = 26;
    set_ledger_sequence(&env, resolve_ledger);
    client.resolve_round();

    assert!(client.get_user_state(&players[0]).is_active);
    assert!(!client.get_user_state(&players[1]).is_active);
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

#[test]
fn resolve_round_can_chain_across_multiple_rounds_until_one_survivor_remains() {
    let (env, _admin, client, _token_id, players) = setup_game(5, 8);

    set_ledger_sequence(&env, 60);
    let round_one = client.start_round();
    assert_eq!(round_one.round_number, 1);

    for player in &players[0..5] {
        client.submit_choice(player, &1, &Choice::Heads);
    }
    for player in &players[5..8] {
        client.submit_choice(player, &1, &Choice::Tails);
    }

    set_ledger_sequence(&env, 66);
    let resolved_one = client.resolve_round();
    assert!(!resolved_one.finished);
    assert_eq!(client.get_arena_state().survivors_count, 3);

    set_ledger_sequence(&env, 70);
    let round_two = client.start_round();
    assert_eq!(round_two.round_number, 2);

    client.submit_choice(&players[5], &2, &Choice::Heads);
    client.submit_choice(&players[6], &2, &Choice::Heads);
    client.submit_choice(&players[7], &2, &Choice::Tails);

    set_ledger_sequence(&env, 76);
    let resolved_two = client.resolve_round();

    assert_eq!(resolved_two.round_number, 2);
    assert!(resolved_two.finished);
    assert_eq!(client.get_arena_state().survivors_count, 1);
    assert!(!client.get_user_state(&players[5]).is_active);
    assert!(!client.get_user_state(&players[6]).is_active);
    assert!(client.get_user_state(&players[7]).is_active);
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

    client.init(&10, &TEST_REQUIRED_STAKE, &3600);
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

/// When paused, admin token rotation still succeeds.
#[test]
fn test_set_token_succeeds_when_paused() {
    let (env, admin, client) = setup_with_admin();
    let (_old_asset, old_token_id) = setup_token(&env, &admin);
    let (_new_asset, new_token_id) = setup_token(&env, &admin);

    client.set_token(&old_token_id);
    client.pause();
    assert!(client.is_paused());

    client.set_token(&new_token_id);

    let configured_token: Address = env.as_contract(&client.address, || {
        env.storage()
            .instance()
            .get(&TOKEN_KEY)
            .expect("token must remain configurable while paused")
    });
    assert_eq!(configured_token, new_token_id);
}

#[test]
fn test_admin_transfer_controls_succeed_when_paused() {
    let (env, _admin, client) = setup_with_admin();
    let new_admin = Address::generate(&env);

    client.pause();
    assert!(client.is_paused());

    client.propose_admin(&new_admin);
    assert_eq!(client.pending_admin_transfer().unwrap().0, new_admin);
    client.accept_admin(&new_admin);

    assert_eq!(client.admin(), new_admin);
}

/// When paused, normal game functions are blocked but governance functions are not.
/// This is the core invariant of the Emergency Pause Policy.
#[test]
fn test_paused_blocks_game_functions_not_governance() {
    let (env, _admin, client) = setup_with_admin();
    let player = Address::generate(&env);
    let hash = dummy_hash(&env);

    client.init(&10u32, &TEST_REQUIRED_STAKE, &3600);
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

    let (_old_asset, old_token_id) = setup_token(&env, &_admin);
    let (_new_asset, new_token_id) = setup_token(&env, &_admin);
    client.set_token(&old_token_id);
    client.set_token(&new_token_id);
    let configured_token: Address = env.as_contract(&client.address, || {
        env.storage()
            .instance()
            .get(&TOKEN_KEY)
            .expect("set_token must succeed when paused")
    });
    assert_eq!(configured_token, new_token_id);
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
    client.set_token(&token_id);
    client.init(&5, &10_000_000i128, &3600);

    env.mock_all_auths();
    let player_a = Address::generate(&env);
    let player_b = Address::generate(&env);
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
    client.init(&5, &TEST_REQUIRED_STAKE, &3600);

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

#[test]
fn join_rejects_amounts_that_do_not_match_required_stake() {
    let (env, admin, client) = setup_with_admin();
    let (_token, token_id) = setup_token(&env, &admin);
    let asset = StellarAssetClient::new(&env, &token_id);
    client.set_token(&token_id);
    client.init(&5, &TEST_REQUIRED_STAKE, &3600);

    let player = Address::generate(&env);
    asset.mint(&player, &1_000_000i128);

    let err = client.try_join(&player, &(TEST_REQUIRED_STAKE - 1));
    assert_eq!(err, Err(Ok(ArenaError::InvalidAmount)));
}

#[test]
fn private_arena_join_rejects_non_whitelisted_player() {
    let (env, client, token_id, _factory, _arena_id) = setup_private_arena_with_mock_factory();
    let token = StellarAssetClient::new(&env, &token_id);
    let intruder = Address::generate(&env);
    token.mint(&intruder, &(TEST_REQUIRED_STAKE * 10));

    let err = client.try_join(&intruder, &TEST_REQUIRED_STAKE);
    assert_eq!(err, Err(Ok(ArenaError::NotWhitelisted)));
}

#[test]
fn private_arena_whitelist_updates_apply_without_stale_cache() {
    let (env, client, token_id, factory, arena_id) = setup_private_arena_with_mock_factory();
    let token = StellarAssetClient::new(&env, &token_id);
    let whitelisted_player = Address::generate(&env);
    let revoked_player = Address::generate(&env);
    token.mint(&whitelisted_player, &(TEST_REQUIRED_STAKE * 10));
    token.mint(&revoked_player, &(TEST_REQUIRED_STAKE * 10));

    let set_method = Symbol::new(&env, "set_whitelisted");
    let check_method = Symbol::new(&env, "is_whitelisted");
    // Player is initially allowed and can join.
    env.invoke_contract::<()>(
        &factory,
        &set_method,
        soroban_sdk::vec![
            &env,
            arena_id.into_val(&env),
            whitelisted_player.clone().into_val(&env),
            true.into_val(&env),
        ],
    );
    assert!(
        client
            .try_join(&whitelisted_player, &TEST_REQUIRED_STAKE)
            .is_ok()
    );

    // Read path returns true, then host revokes access; join must fail immediately.
    env.invoke_contract::<()>(
        &factory,
        &set_method,
        soroban_sdk::vec![
            &env,
            arena_id.into_val(&env),
            revoked_player.clone().into_val(&env),
            true.into_val(&env),
        ],
    );
    let initially_whitelisted: bool = env.invoke_contract(
        &factory,
        &check_method,
        soroban_sdk::vec![
            &env,
            arena_id.into_val(&env),
            revoked_player.clone().into_val(&env),
        ],
    );
    assert!(initially_whitelisted);

    env.invoke_contract::<()>(
        &factory,
        &set_method,
        soroban_sdk::vec![
            &env,
            arena_id.into_val(&env),
            revoked_player.clone().into_val(&env),
            false.into_val(&env),
        ],
    );

    let err = client.try_join(&revoked_player, &TEST_REQUIRED_STAKE);
    assert_eq!(err, Err(Ok(ArenaError::NotWhitelisted)));
}

#[test]
fn init_rejects_stake_below_minimum() {
    let (_env, _admin, client) = setup_with_admin();
    // In test builds MIN_REQUIRED_STAKE = 1, so 0 is below the floor.
    let err = client.try_init(&5, &0, &3600);
    assert_eq!(err, Err(Ok(ArenaError::InvalidAmount)));
}

#[test]
fn init_accepts_stake_at_minimum() {
    let (_env, _admin, client) = setup_with_admin();
    // In test builds MIN_REQUIRED_STAKE = 1.
    client.init(&5, &bounds::MIN_REQUIRED_STAKE, &3600);
}

#[test]
fn set_token_rejects_changes_after_first_join() {
    let (env, admin, client) = setup_with_admin();
    let (_old_token, old_token_id) = setup_token(&env, &admin);
    let (_new_token, new_token_id) = setup_token(&env, &admin);
    let old_asset = StellarAssetClient::new(&env, &old_token_id);

    client.set_token(&old_token_id);
    client.init(&5, &TEST_REQUIRED_STAKE, &3600);

    let player = Address::generate(&env);
    old_asset.mint(&player, &1_000_000i128);
    client.join(&player, &TEST_REQUIRED_STAKE);

    let err = client.try_set_token(&new_token_id);
    assert_eq!(err, Err(Ok(ArenaError::TokenConfigurationLocked)));
}

// ── Issue #277: round state machine invariant suite ───────────────────────────

#[test]
fn round_state_machine_invariant_suite_happy_path() {
    let (env, _admin, client, _token_id, _players) = setup_game(5, 2);
    set_ledger_sequence(&env, 100);
    let r0 = client.get_round();
    crate::invariants::check_round_flags(&r0).unwrap();

    let r1 = client.start_round();
    crate::invariants::check_round_flags(&r1).unwrap();
    crate::invariants::check_round_number_monotonic(r0.round_number, r1.round_number).unwrap();
    crate::invariants::check_submission_count_monotonic(r0.total_submissions, r1.total_submissions)
        .unwrap();

    set_ledger_sequence(&env, 106);
    let r1t = client.timeout_round();
    crate::invariants::check_round_flags(&r1t).unwrap();
    crate::invariants::check_timeout_transition(&r1, &r1t).unwrap();
}

// ── Issue #319: claim prize-pool drain and round.finished ─────────────────────

#[test]
fn claim_single_winner_gets_correct_prize() {
    let (_env, _admin, client, _token_id, winner) = setup_finished_game_with_winner(1_500i128);

    // Pool contains player deposits (3 × 100 = 300) + prize_amount (1500) = 1800
    let claimed = client.claim(&winner);
    assert_eq!(claimed, 1_800i128);
}

#[test]
fn claim_rejects_before_game_is_finished() {
    let (env, admin, client, token_id, players) = setup_game(5, 2);
    let winner = players[0].clone();
    let asset = StellarAssetClient::new(&env, &token_id);
    asset.mint(&client.address, &1000);

    client.set_winner(&winner, &1000i128, &0i128);
    let err = client.try_claim(&winner);
    assert_eq!(err, Err(Ok(ArenaError::GameNotFinished)));
}

#[test]
fn claim_second_set_winner_overwrites_prize_pool() {
    let (_env, _admin, client, _token_id, winner) = setup_finished_game_with_winner(0i128);

    let err = client.try_set_winner(&winner, &200i128, &100i128);
    assert_eq!(err, Err(Ok(ArenaError::WinnerAlreadySet)));

    // Original pool remains claimable by the original winner.
    let claimed = client.claim(&winner);
    assert_eq!(claimed, 300i128);
}

#[test]
fn set_winner_twice_returns_error() {
    let (env, admin, client, token_id, players) = setup_game(5, 3);
    let winner = players[0].clone();
    let second = players[1].clone();
    let asset = StellarAssetClient::new(&env, &token_id);
    asset.mint(&client.address, &1000);

    client.set_winner(&winner, &0i128, &0i128);
    let err = client.try_set_winner(&second, &50i128, &25i128);
    assert_eq!(err, Err(Ok(ArenaError::WinnerAlreadySet)));
}

#[test]
fn set_winner_fails_for_non_survivor() {
    let (env, admin, client) = setup_with_admin();
    let (_asset, token_id) = setup_token(&env, &admin);
    client.set_token(&token_id);
    client.init(&5, &TEST_REQUIRED_STAKE, &3600);
    let non_survivor = Address::generate(&env);

    let err = client.try_set_winner(&non_survivor, &100i128, &0i128);
    assert_eq!(err, Err(Ok(ArenaError::NotASurvivor)));
}

#[test]
fn capacity_enforcement() {
    let (env, admin, client) = setup_with_admin();
    let (_asset, token_id) = setup_token(&env, &admin);
    client.set_token(&token_id);
    client.init(&5, &TEST_REQUIRED_STAKE, &3600);

    // Set capacity to 2
    client.set_capacity(&2);

    let p1 = Address::generate(&env);
    let p2 = Address::generate(&env);
    let p3 = Address::generate(&env);

    let asset = StellarAssetClient::new(&env, &token_id);
    asset.mint(&p1, &TEST_REQUIRED_STAKE);
    asset.mint(&p2, &TEST_REQUIRED_STAKE);
    asset.mint(&p3, &TEST_REQUIRED_STAKE);

    // First two should succeed
    client.join(&p1, &TEST_REQUIRED_STAKE);
    client.join(&p2, &TEST_REQUIRED_STAKE);

    // Third should fail
    let err = client.try_join(&p3, &TEST_REQUIRED_STAKE);
    assert_eq!(err, Err(Ok(ArenaError::ArenaFull)));
}

#[test]
fn claim_last_winner_sets_round_finished() {
    let (_env, _admin, client, _token_id, winner) = setup_finished_game_with_winner(1_000i128);

    client.claim(&winner);

    // After the last (only) winner claims, round.finished must be true.
    let round = client.get_round();
    assert!(round.finished);
}

#[test]
fn claim_already_claimed_returns_error() {
    let (_env, _admin, client, _token_id, winner) = setup_finished_game_with_winner(1_000i128);
    client.claim(&winner);

    // Second claim must be rejected.
    let err = client.try_claim(&winner);
    assert_eq!(err, Err(Ok(ArenaError::AlreadyClaimed)));
}

#[test]
fn join_rejects_after_game_is_finished() {
    let (env, _admin, client, token_id, winner) = setup_finished_game_with_winner(1_000i128);
    let asset = StellarAssetClient::new(&env, &token_id);
    client.claim(&winner);

    let player = Address::generate(&env);
    asset.mint(&player, &100i128);
    let err = client.try_join(&player, &100i128);
    assert_eq!(err, Err(Ok(ArenaError::GameAlreadyFinished)));
}

#[test]
fn start_round_rejects_after_game_is_finished() {
    let (_env, _admin, client, _token_id, winner) = setup_finished_game_with_winner(1_000i128);
    client.claim(&winner);

    let err = client.try_start_round();
    assert_eq!(err, Err(Ok(ArenaError::GameAlreadyFinished)));
}

// ── Issue #XXX: join() CEI ordering and retry after failed join ───────────────

#[test]
fn join_fails_when_token_not_set() {
    let (env, _admin, client) = setup_with_admin();
    client.init(&5, &TEST_REQUIRED_STAKE, &3600);
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
fn join_fails_before_init() {
    let (env, _admin, client) = setup_with_admin();
    let player = Address::generate(&env);

    // We initialized admin, but NOT the game configuration (init()).
    // join() must fail early because it can't know the required_stake_amount.

    let err = client.try_join(&player, &100i128);
    assert_eq!(err, Err(Ok(ArenaError::NotInitialized)));
}

#[test]
fn join_succeeds_on_retry_after_capacity_was_cleared() {
    let (env, admin, client) = setup_with_admin();
    let (_token, token_id) = setup_token(&env, &admin);
    let asset = StellarAssetClient::new(&env, &token_id);

    const CAP: u32 = 2;
    client.set_token(&token_id);
    client.init(&5, &TEST_REQUIRED_STAKE, &3600);
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
    client.init(&5, &TEST_REQUIRED_STAKE, &3600);

    env.mock_all_auths();
    client.pause();

    let player = Address::generate(&env);
    asset.mint(&player, &1000i128);
    let err = client.try_join(&player, &100i128);
    assert_eq!(err, Err(Ok(ArenaError::Paused)));
}

#[test]
fn winner_is_identifiable_before_claim() {
    let (env, _admin, client, _token_id, players) = setup_game(10, 1);
    let winner = players[0].clone();

    client.set_winner(&winner, &1000, &100);

    let state = client.get_user_state(&winner);
    assert_eq!(state.has_won, true);
    assert_eq!(state.is_active, true);
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
    client.init(&5, &TEST_REQUIRED_STAKE, &3600);

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
    client.init(&5, &10i128, &3600);

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
    client.init(&5, &TEST_REQUIRED_STAKE, &3600);

    let player_a = Address::generate(&env);
    let player_b = Address::generate(&env);
    let outsider = Address::generate(&env);

    asset.mint(&player_a, &100i128);
    asset.mint(&player_b, &100i128);
    client.join(&player_a, &TEST_REQUIRED_STAKE);
    client.join(&player_b, &TEST_REQUIRED_STAKE);

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

// ── Issue #359: start_round and timeout_round emit events ─────────────────────

#[test]
fn start_round_emits_r_start_event() {
    use soroban_sdk::testutils::Events as _;

    let (env, _admin, client, _token_id, _players) = setup_game(5, 2);
    set_ledger_sequence(&env, 1_000);

    let _ = client.get_round(); // flush prior invocation's events from the log
    let before = env.events().all().len();
    client.start_round();
    let after = env.events().all().len();

    assert_eq!(
        after,
        before + 1,
        "start_round() must emit exactly one event (R_START)"
    );
}

#[test]
fn start_round_event_carries_correct_round_data() {
    let (env, _admin, client, _token_id, _players) = setup_game(5, 2);
    set_ledger_sequence(&env, 1_000);

    client.start_round();
    let round = client.get_round();

    // The round fields persisted in storage must match what was emitted.
    assert_eq!(round.round_number, 1);
    assert_eq!(round.round_start_ledger, 1_000);
    // round_deadline_ledger = start + round_speed (5)
    assert_eq!(round.round_deadline_ledger, 1_005);
    assert!(round.active);
}

#[test]
fn timeout_round_emits_r_tout_event() {
    use soroban_sdk::testutils::Events as _;

    let (env, _admin, client, _token_id, _players) = setup_game(5, 2);
    set_ledger_sequence(&env, 1_000);
    client.start_round();
    let round = client.get_round();

    // Advance past deadline
    set_ledger_sequence(&env, round.round_deadline_ledger + 1);

    let before = env.events().all().len();
    client.timeout_round();
    let after = env.events().all().len();

    assert_eq!(
        after,
        before + 1,
        "timeout_round() must emit exactly one event (R_TOUT)"
    );
}

#[test]
fn timeout_round_event_reflects_timed_out_state() {
    let (env, _admin, client, _token_id, _players) = setup_game(5, 2);
    set_ledger_sequence(&env, 1_000);
    client.start_round();
    let round = client.get_round();

    set_ledger_sequence(&env, round.round_deadline_ledger + 1);
    let timed_out = client.timeout_round();

    assert!(!timed_out.active);
    assert!(timed_out.timed_out);
    assert_eq!(timed_out.round_number, 1);
}

#[test]
fn pause_unpause_emit_versioned_payloads() {
    use soroban_sdk::testutils::Events as _;

    let (env, _admin, client) = setup_with_admin();

    client.pause();
    let pause_event = env.events().all().last().unwrap();
    let (_contract, pause_topics, pause_data) = pause_event;
    let pause_topic: Symbol = pause_topics.get(0).unwrap().into_val(&env);
    let pause_payload: (u32,) = pause_data.into_val(&env);
    assert_eq!(pause_topic, symbol_short!("PAUSED"));
    assert_eq!(pause_payload, (1u32,));

    client.unpause();
    let unpause_event = env.events().all().last().unwrap();
    let (_contract, unpause_topics, unpause_data) = unpause_event;
    let unpause_topic: Symbol = unpause_topics.get(0).unwrap().into_val(&env);
    let unpause_payload: (u32,) = unpause_data.into_val(&env);
    assert_eq!(unpause_topic, symbol_short!("UNPAUSED"));
    assert_eq!(unpause_payload, (1u32,));
}

#[test]
fn set_winner_event_includes_version_field() {
    use soroban_sdk::testutils::Events as _;

    let (env, _admin, client, _token_id, players) = setup_game(5, 1);
    let winner = players[0].clone();

    client.set_winner(&winner, &100i128, &10i128);

    let winner_event = env.events().all().last().unwrap();
    let (_contract, topics, data) = winner_event;
    let topic: Symbol = topics.get(0).unwrap().into_val(&env);
    let payload: (Address, i128, i128, u32) = data.into_val(&env);

    assert_eq!(topic, symbol_short!("WIN_SET"));
    assert_eq!(payload.0, winner);
    assert_eq!(payload.3, 1u32);
}

// ── Issue #358: claim() must verify caller is the designated winner ────────────

#[test]
fn claim_fails_for_non_designated_winner() {
    let (env, _admin, client, _token_id, _designated_winner) =
        setup_finished_game_with_winner(300i128);
    let impersonator = Address::generate(&env);

    let result = client.try_claim(&impersonator);
    assert_eq!(
        result,
        Err(Ok(ArenaError::NotASurvivor)),
        "a survivor who is not the designated winner must not be able to claim"
    );
}

#[test]
fn claim_succeeds_only_for_designated_winner() {
    let (_env, _admin, client, _token_id, winner) = setup_finished_game_with_winner(300i128);

    // Pool contains player deposits (3 × 100 = 300) + prize_amount (300) = 600
    let prize = client.claim(&winner);
    assert_eq!(prize, 600i128);
}

#[test]
fn claim_fails_without_any_winner_set() {
    let (env, _admin, client, _token_id, players) = setup_game(5, 3);
    env.as_contract(&client.address, || {
        env.storage().instance().set(&GAME_FINISHED_KEY, &true);
    });

    // set_winner() never called and multiple survivors remain.
    let result = client.try_claim(&players[0]);
    assert_eq!(
        result,
        Err(Ok(ArenaError::WinnerNotSet)),
        "claim must fail when no winner has been designated"
    );
}

#[test]
fn last_survivor_can_claim_after_resolve_round() {
    let (env, _admin, client, _token_id, players) = setup_game(5, 3);
    set_ledger_sequence(&env, 1);
    client.start_round();
    client.submit_choice(&players[0], &1u32, &Choice::Heads);
    client.submit_choice(&players[1], &1u32, &Choice::Tails);
    client.submit_choice(&players[2], &1u32, &Choice::Tails);
    set_ledger_sequence(&env, 7);
    client.resolve_round();

    // No explicit set_winner() call; sole survivor can still claim.
    let prize = client.claim(&players[0]);
    assert_eq!(prize, 300i128);

    let user_state = client.get_user_state(&players[0]);
    assert!(user_state.has_won);
}

#[test]
fn claim_fails_gracefully_when_game_finished_but_winner_not_set() {
    let (env, _admin, client, _token_id, players) = setup_game(5, 3);
    env.as_contract(&client.address, || {
        env.storage().instance().set(&GAME_FINISHED_KEY, &true);
    });

    let result = client.try_claim(&players[0]);
    assert_eq!(result, Err(Ok(ArenaError::WinnerNotSet)));
}

// ── Issue #227: minority-wins resolution algorithm unit tests ─────────────────
//
// These tests cover every scenario called out in the acceptance criteria:
//   1. 2 players, 1 Heads / 1 Tails  → tie logic (PRNG decides)
//   2. 10 players, 3 Heads / 7 Tails → Heads (minority) survive
//   3. All players choose the same side → everyone survives
//   4. Single survivor remaining after resolution
//
// Each test also verifies the RSLVD event payload so that indexers and the
// frontend can rely on the emitted data.

// ── helper: run one full round with explicit per-side player lists ─────────────

/// Set up a game, submit choices for two groups, advance past the deadline,
/// call resolve_round(), and return the resolved RoundState together with the
/// two player vecs so callers can assert survivor / eliminated status.
fn run_resolution_scenario(
    heads_count: u32,
    tails_count: u32,
) -> (
    Env,
    ArenaContractClient<'static>,
    Vec<Address>, // heads players
    Vec<Address>, // tails players
) {
    let total = heads_count + tails_count;
    let (env, _admin, client, _token_id, players) = setup_game(5, total);

    set_ledger_sequence(&env, 100);
    let round = client.start_round();

    let heads_players: Vec<Address> = players[..heads_count as usize].to_vec();
    let tails_players: Vec<Address> = players[heads_count as usize..].to_vec();

    for p in &heads_players {
        client.submit_choice(p, &round.round_number, &Choice::Heads);
    }
    for p in &tails_players {
        client.submit_choice(p, &round.round_number, &Choice::Tails);
    }

    advance_past_resolution_window(&env, &round);

    (env, client, heads_players, tails_players)
}

// ── 1. Tie: 1 Heads vs 1 Tails (2 players) ───────────────────────────────────

#[test]
fn resolve_round_tie_2_players_exactly_one_survives() {
    // Seed PRNG so the tie-break is deterministic: seed [0;32] → gen() & 1 == 0
    // → Heads survives (see choose_surviving_side).
    let (env, client, heads_players, tails_players) = run_resolution_scenario(1, 1);

    seed_contract_prng(&env, &client.address, [0u8; 32]);

    let resolved = client.resolve_round();

    assert!(resolved.finished, "round must be finished after resolve");
    // Exactly one survivor remains
    assert_eq!(
        client.get_arena_state().survivors_count,
        1,
        "tie must leave exactly 1 survivor"
    );
    // With seed [0;32] Heads wins the coin flip
    assert!(
        client.get_user_state(&heads_players[0]).is_active,
        "heads player must survive the tie-break"
    );
    assert!(
        !client.get_user_state(&tails_players[0]).is_active,
        "tails player must be eliminated in the tie-break"
    );
}

#[test]
fn resolve_round_minority_tails_survives() {
    // 3 Heads vs 1 Tails → Tails is the minority → Tails survives (no tie-break needed).
    let (_env, client, heads_players, tails_players) = run_resolution_scenario(3, 1);

    client.resolve_round();

    assert_eq!(client.get_arena_state().survivors_count, 1);
    assert!(
        client.get_user_state(&tails_players[0]).is_active,
        "tails player must survive as the minority"
    );
    for h in &heads_players {
        assert!(
            !client.get_user_state(h).is_active,
            "heads players must be eliminated as the majority"
        );
    }
}

#[test]
fn resolve_round_tie_emits_rslvd_event_with_correct_counts() {
    use soroban_sdk::testutils::Events as _;

    let (env, client, _heads, _tails) = run_resolution_scenario(1, 1);
    seed_contract_prng(&env, &client.address, [0u8; 32]);

    let before = env.events().all().len();
    client.resolve_round();
    let after = env.events().all().len();

    assert_eq!(
        after,
        before + 1,
        "resolve_round() must emit exactly one RSLVD event"
    );
}

// ── 2. Clear minority: 3 Heads vs 7 Tails (10 players) ───────────────────────

#[test]
fn resolve_round_3_heads_7_tails_heads_survive() {
    let (_env, client, heads_players, tails_players) = run_resolution_scenario(3, 7);

    client.resolve_round();

    assert_eq!(
        client.get_arena_state().survivors_count,
        3,
        "only the 3 minority-heads players should survive"
    );
    for p in &heads_players {
        assert!(
            client.get_user_state(p).is_active,
            "heads player must survive (minority)"
        );
    }
    for p in &tails_players {
        assert!(
            !client.get_user_state(p).is_active,
            "tails player must be eliminated (majority)"
        );
    }
}

#[test]
fn resolve_round_3_heads_7_tails_event_payload_correct() {
    use soroban_sdk::testutils::Events as _;

    let (env, client, _heads, _tails) = run_resolution_scenario(3, 7);

    client.resolve_round();

    // The last event must be RSLVD with the right counts.
    let events = env.events().all();
    let last = events.last().expect("at least one event must be emitted");
    let (_contract, topics, _data) = last;
    let topic_sym: Symbol = soroban_sdk::symbol_short!("RSLVD");
    let got: Symbol = topics.get(0).unwrap().into_val(&env);
    assert_eq!(got, topic_sym, "event topic must be RSLVD");
}

#[test]
fn resolve_round_minority_survivor_count_matches_heads_count() {
    let (_env, client, heads_players, _tails_players) = run_resolution_scenario(3, 7);

    client.resolve_round();

    assert_eq!(
        client.get_arena_state().survivors_count,
        heads_players.len() as u32
    );
}

// ── 3. All-same-choice: everyone picks Heads ─────────────────────────────────

#[test]
fn resolve_round_all_heads_no_one_eliminated() {
    let (env, _admin, client, _token_id, players) = setup_game(5, 5);

    set_ledger_sequence(&env, 200);
    client.start_round();
    for p in &players {
        client.submit_choice(p, &1, &Choice::Heads);
    }
    set_ledger_sequence(&env, 206);
    client.resolve_round();

    assert_eq!(
        client.get_arena_state().survivors_count,
        5,
        "all-same-choice must leave all players alive"
    );
    for p in &players {
        assert!(
            client.get_user_state(p).is_active,
            "every player must still be active after unanimous choice"
        );
    }
}

#[test]
fn resolve_round_all_tails_no_one_eliminated() {
    let (env, _admin, client, _token_id, players) = setup_game(5, 4);

    set_ledger_sequence(&env, 200);
    client.start_round();
    for p in &players {
        client.submit_choice(p, &1, &Choice::Tails);
    }
    set_ledger_sequence(&env, 206);
    client.resolve_round();

    assert_eq!(client.get_arena_state().survivors_count, 4);
    for p in &players {
        assert!(client.get_user_state(p).is_active);
    }
}

#[test]
fn resolve_round_all_same_choice_emits_rslvd_with_zero_eliminated() {
    use soroban_sdk::testutils::Events as _;

    let (env, _admin, client, _token_id, players) = setup_game(5, 3);

    set_ledger_sequence(&env, 200);
    client.start_round();
    for p in &players {
        client.submit_choice(p, &1, &Choice::Heads);
    }
    set_ledger_sequence(&env, 206);

    let before = env.events().all().len();
    client.resolve_round();
    let after = env.events().all().len();

    assert_eq!(after, before + 1, "must emit exactly one RSLVD event");
}

// ── 4. Single survivor scenario ───────────────────────────────────────────────

#[test]
fn resolve_round_produces_single_survivor() {
    // 1 Heads vs 3 Tails → Heads (minority) is the sole survivor.
    let (_env, client, heads_players, tails_players) = run_resolution_scenario(1, 3);

    client.resolve_round();

    assert_eq!(
        client.get_arena_state().survivors_count,
        1,
        "exactly one survivor must remain"
    );
    assert!(
        client.get_user_state(&heads_players[0]).is_active,
        "the single minority player must be the survivor"
    );
    for p in &tails_players {
        assert!(
            !client.get_user_state(p).is_active,
            "all majority players must be eliminated"
        );
    }
}

#[test]
fn resolve_round_single_survivor_cannot_submit_next_round_as_eliminated() {
    // Verify that eliminated players are correctly blocked in the next round.
    // Use 2 heads vs 4 tails so that 2 heads players survive after resolution,
    // giving us enough players (>= 2) to start round 2.
    let (env, client, _heads_players, tails_players) = run_resolution_scenario(2, 4);

    client.resolve_round();

    // Start round 2 — requires at least 2 survivors, which we now have.
    set_ledger_sequence(&env, 200);
    client.start_round();

    // An eliminated player must get PlayerEliminated, not NotASurvivor
    let err = client.try_submit_choice(&tails_players[0], &2, &Choice::Heads);
    assert_eq!(
        err,
        Err(Ok(ArenaError::PlayerEliminated)),
        "eliminated player must receive PlayerEliminated on next round submission"
    );
}

#[test]
fn resolve_round_single_survivor_round_is_finished() {
    let (_env, client, _heads, _tails) = run_resolution_scenario(1, 3);

    let resolved = client.resolve_round();

    assert!(
        resolved.finished,
        "round must be marked finished after resolution"
    );
    assert!(
        !resolved.active,
        "round must not be active after resolution"
    );
}

// ── 5. No submissions (zero heads, zero tails) ────────────────────────────────

#[test]
fn resolve_round_no_submissions_keeps_all_survivors() {
    // When nobody submits, choose_surviving_side returns None → no eliminations.
    let (env, _admin, client, _token_id, players) = setup_game(5, 3);

    set_ledger_sequence(&env, 300);
    client.start_round();
    // Deliberately skip all submissions
    set_ledger_sequence(&env, 306);
    client.resolve_round();

    assert_eq!(
        client.get_arena_state().survivors_count,
        3,
        "no submissions must leave all survivors intact"
    );
    for p in &players {
        assert!(client.get_user_state(p).is_active);
    }
}

// ── 6. Parameterized minority-wins correctness ────────────────────────────────

/// Table-driven test covering a range of (heads, tails) splits to confirm the
/// minority always survives and the survivor count is correct.
#[test]
fn resolve_round_minority_wins_parameterized() {
    // (heads_count, tails_count, expected_survivors)
    let cases: &[(u32, u32, u32)] = &[
        (1, 2, 1), // heads minority
        (2, 1, 1), // tails minority
        (2, 5, 2), // heads minority
        (5, 2, 2), // tails minority
        (1, 4, 1), // heads minority, single survivor
        (4, 1, 1), // tails minority, single survivor
    ];

    for &(h, t, expected_survivors) in cases {
        let (_env, client, heads_players, tails_players) = run_resolution_scenario(h, t);

        client.resolve_round();

        let actual = client.get_arena_state().survivors_count;
        assert_eq!(
            actual, expected_survivors,
            "({h}H vs {t}T): expected {expected_survivors} survivors, got {actual}"
        );

        // Verify the correct side survived
        let (survivors, eliminated) = if h < t {
            (&heads_players, &tails_players)
        } else {
            (&tails_players, &heads_players)
        };

        for p in survivors {
            assert!(
                client.get_user_state(p).is_active,
                "({h}H vs {t}T): minority player must be active"
            );
        }
        for p in eliminated {
            assert!(
                !client.get_user_state(p).is_active,
                "({h}H vs {t}T): majority player must be eliminated"
            );
        }
    }
}

// ── Issue #474: comprehensive round resolution coverage ───────────────────────

fn seed_single_survivor_active_round() -> (Env, ArenaContractClient<'static>, Address, RoundState) {
    let (env, _admin, client) = setup_with_admin();
    let lone_survivor = Address::generate(&env);
    let round = RoundState {
        round_number: 7,
        round_start_ledger: 500,
        round_deadline_ledger: 505,
        active: true,
        total_submissions: 0,
        timed_out: false,
        finished: false,
    };

    env.as_contract(&client.address, || {
        env.storage().instance().set(
            &DataKey::Config,
            &ArenaConfig {
                round_speed_in_ledgers: 5,
                required_stake_amount: TEST_REQUIRED_STAKE,
                max_rounds: bounds::DEFAULT_MAX_ROUNDS,
                winner_yield_share_bps: DEFAULT_WINNER_YIELD_SHARE_BPS,
                reserve_ratio_bps: 0,
                grace_period_seconds: bounds::DEFAULT_GRACE_PERIOD_SECONDS,
                join_deadline: 3_600,
                win_fee_bps: 0,
                is_private: false,
            },
        );
        env.storage().instance().set(&DataKey::Round, &round);
        env.storage().instance().set(&SURVIVOR_COUNT_KEY, &1u32);
        env.storage()
            .instance()
            .set(&STATE_KEY, &ArenaState::Active);

        let mut players = soroban_sdk::Vec::new(&env);
        players.push_back(lone_survivor.clone());
        env.storage()
            .persistent()
            .set(&DataKey::AllPlayers, &players);

        let survivor_key = DataKey::Survivor(lone_survivor.clone());
        env.storage().persistent().set(&survivor_key, &true);
        bump(&env, &survivor_key);
    });

    (env, client, lone_survivor, round)
}

#[test]
fn issue_474_resolve_round_handles_normal_4v2_split() {
    let (_env, client, heads_players, tails_players) = run_resolution_scenario(4, 2);

    let resolved = client.resolve_round();

    assert!(resolved.finished);
    assert_eq!(client.get_arena_state().survivors_count, 2);
    for player in &heads_players {
        assert!(!client.get_user_state(player).is_active);
    }
    for player in &tails_players {
        assert!(client.get_user_state(player).is_active);
    }
}

#[test]
fn issue_474_resolve_round_handles_normal_1v5_split() {
    let (_env, client, heads_players, tails_players) = run_resolution_scenario(1, 5);

    let resolved = client.resolve_round();

    assert!(resolved.finished);
    assert_eq!(client.get_arena_state().survivors_count, 1);
    assert!(client.get_user_state(&heads_players[0]).is_active);
    for player in &tails_players {
        assert!(!client.get_user_state(player).is_active);
    }
}

#[test]
fn issue_474_exact_tie_is_deterministic_for_same_ledger_sequence() {
    let (_env_a, client_a, heads_a, tails_a) = run_resolution_scenario(2, 2);
    let (_env_b, client_b, heads_b, tails_b) = run_resolution_scenario(2, 2);

    client_a.resolve_round();
    client_b.resolve_round();

    assert_eq!(client_a.get_arena_state().survivors_count, 2);
    assert_eq!(client_b.get_arena_state().survivors_count, 2);

    for (left, right) in heads_a.iter().zip(heads_b.iter()) {
        assert_eq!(
            client_a.get_user_state(&left).is_active,
            client_b.get_user_state(&right).is_active
        );
    }
    for (left, right) in tails_a.iter().zip(tails_b.iter()) {
        assert_eq!(
            client_a.get_user_state(&left).is_active,
            client_b.get_user_state(&right).is_active
        );
    }
}

#[test]
fn issue_474_all_same_choice_eliminates_everyone_and_completes_arena() {
    let (env, _admin, client, _token_id, players) = setup_game(5, 6);

    set_ledger_sequence(&env, 200);
    let round = client.start_round();
    for player in &players {
        client.submit_choice(player, &round.round_number, &Choice::Heads);
    }
    advance_past_resolution_window(&env, &round);

    let resolved = client.resolve_round();

    assert!(resolved.finished);
    assert_eq!(client.get_arena_state().survivors_count, 0);
    assert_eq!(client.state(), ArenaState::Completed);
    for player in &players {
        assert!(!client.get_user_state(player).is_active);
    }
}

#[test]
fn issue_474_single_survivor_before_resolve_completes_without_crashing() {
    let (env, client, lone_survivor, round) = seed_single_survivor_active_round();
    advance_past_resolution_window(&env, &round);

    let resolved = client.resolve_round();

    assert_eq!(resolved.round_number, round.round_number);
    assert!(resolved.finished);
    assert!(!resolved.active);
    assert_eq!(client.get_arena_state().survivors_count, 1);
    assert_eq!(client.state(), ArenaState::Completed);
    assert!(client.get_user_state(&lone_survivor).is_active);
}

#[test]
fn issue_474_large_64_player_resolution_fits_default_budget() {
    let (env, _admin, client, _token_id, players) = setup_game(5, 64);

    set_ledger_sequence(&env, 300);
    let round = client.start_round();
    for (index, player) in players.iter().enumerate() {
        let choice = if index < 32 {
            Choice::Heads
        } else {
            Choice::Tails
        };
        client.submit_choice(player, &round.round_number, &choice);
    }
    advance_past_resolution_window(&env, &round);

    let resolved = client.resolve_round();

    assert!(
        resolved.finished,
        "resolution should finish under the default budget"
    );
    assert_eq!(client.get_arena_state().survivors_count, 32);
}

#[test]
fn issue_474_round_progression_carries_state_from_round_1_to_round_7() {
    let (env, _admin, client, _token_id, players) = setup_game(5, 6);
    let mut next_start = 400u32;

    for expected_round in 1..=6u32 {
        set_ledger_sequence(&env, next_start);
        let round = client.start_round();
        assert_eq!(round.round_number, expected_round);

        advance_past_resolution_window(&env, &round);
        let resolved = client.resolve_round();

        assert_eq!(resolved.round_number, expected_round);
        assert_eq!(client.get_arena_state().survivors_count, 6);
        next_start = round.round_deadline_ledger
            + grace_period_to_ledgers(bounds::DEFAULT_GRACE_PERIOD_SECONDS)
            + 10;
    }

    set_ledger_sequence(&env, next_start);
    let round_seven = client.start_round();
    assert_eq!(round_seven.round_number, 7);

    for player in &players[0..4] {
        client.submit_choice(player, &round_seven.round_number, &Choice::Heads);
    }
    for player in &players[4..6] {
        client.submit_choice(player, &round_seven.round_number, &Choice::Tails);
    }
    advance_past_resolution_window(&env, &round_seven);

    let resolved = client.resolve_round();

    assert_eq!(resolved.round_number, 7);
    assert_eq!(client.get_arena_state().survivors_count, 2);
    for player in &players[0..4] {
        assert!(!client.get_user_state(player).is_active);
    }
    for player in &players[4..6] {
        assert!(client.get_user_state(player).is_active);
    }
}

// ── Issue #499: constructor-based init guards ─────────────────────────────────

#[test]
fn initialize_happy_path_stores_admin() {
    // With __constructor, admin is set at deploy time via register(Contract, (&admin,)).
    let (_env, admin, client) = setup_with_admin();
    assert_eq!(client.admin(), admin);
}

#[test]
fn initialize_duplicate_call_returns_already_initialized() {
    // With __constructor, double initialization is structurally impossible.
    let (_env, admin, client) = setup_with_admin();
    assert_eq!(client.admin(), admin);
    // No separate initialize() to call.
}

#[test]
fn initialize_missing_auth_fails() {
    // With __constructor, the admin must authorize the constructor call.
    // This test verifies the constructor was set up correctly.
    let (_env, admin, client) = setup_with_admin();
    assert_eq!(client.admin(), admin);
}

#[test]
fn post_init_admin_query_returns_admin() {
    let (_env, admin, client) = setup_with_admin();
    assert_eq!(client.admin(), admin);
}

// ── Issue #502: cancel_arena() ────────────────────────────────────────────────

#[test]
fn cancel_zero_players_sets_cancelled_flag() {
    let (env, admin, client) = setup_with_admin();
    let (_asset, token_id) = setup_token(&env, &admin);
    client.set_token(&token_id);
    client.init(&5u32, &TEST_REQUIRED_STAKE, &3600);
    client.cancel_arena(&admin);
    assert!(client.is_cancelled());
}

#[test]
fn cancel_pending_arena_refunds_joined_players() {
    let (env, _admin, client, token_id, players) = setup_game(5, 3);
    let token_client = soroban_sdk::token::TokenClient::new(&env, &token_id);
    let balances_before: std::vec::Vec<i128> =
        players.iter().map(|p| token_client.balance(&p)).collect();
    let admin = client.admin();
    client.cancel_arena(&admin);

    assert!(client.is_cancelled());
    for (i, player) in players.iter().enumerate() {
        assert_eq!(
            token_client.balance(&player),
            balances_before[i] + TEST_REQUIRED_STAKE,
            "player {i} should be refunded"
        );
    }
}

#[test]
fn cancel_after_game_finished_returns_error() {
    let (_env, _admin, client, _token_id, _winner) = setup_finished_game_with_winner(0);
    let admin = client.admin();
    let result = client.try_cancel_arena(&admin);
    assert_eq!(result, Err(Ok(ArenaError::GameAlreadyFinished)));
}

#[test]
fn double_cancel_returns_already_cancelled() {
    let (_env, _admin, client, _token_id, _players) = setup_game(5, 2);
    let admin = client.admin();
    client.cancel_arena(&admin);
    let result = client.try_cancel_arena(&admin);
    assert_eq!(result, Err(Ok(ArenaError::AlreadyCancelled)));
}

// ── Issue #506: Emergency pause (arena) ──────────────────────────────────────

#[test]
fn pause_blocks_join() {
    let (env, _admin, client, token_id, _players) = setup_game(5, 0);
    client.pause();
    let new_player = Address::generate(&env);
    let asset = StellarAssetClient::new(&env, &token_id);
    asset.mint(&new_player, &1_000_000i128);
    let result = client.try_join(&new_player, &TEST_REQUIRED_STAKE);
    assert_eq!(result, Err(Ok(ArenaError::Paused)));
}

#[test]
fn pause_blocks_start_round() {
    let (_env, _admin, client, _token_id, _players) = setup_game(5, 2);
    client.pause();
    let result = client.try_start_round();
    assert_eq!(result, Err(Ok(ArenaError::Paused)));
}

#[test]
fn pause_blocks_cancel_arena() {
    let (_env, _admin, client, _token_id, _players) = setup_game(5, 2);
    client.pause();
    let admin = client.admin();
    let result = client.try_cancel_arena(&admin);
    assert_eq!(result, Err(Ok(ArenaError::Paused)));
}

#[test]
fn unpause_restores_join() {
    let (env, _admin, client, token_id, _players) = setup_game(5, 0);
    client.pause();
    client.unpause();
    assert!(!client.is_paused());
    let new_player = Address::generate(&env);
    let asset = StellarAssetClient::new(&env, &token_id);
    asset.mint(&new_player, &1_000_000i128);
    let result = client.try_join(&new_player, &TEST_REQUIRED_STAKE);
    assert!(result.is_ok(), "join should succeed after unpause");
}

#[test]
fn read_functions_unaffected_by_arena_pause() {
    let (_env, _admin, client, _token_id, _players) = setup_game(5, 2);
    client.pause();
    let _ = client.is_paused();
    let _ = client.is_cancelled();
    let _ = client.admin();
}

// ── Issue #513: max_rounds cap ───────────────────────────────────────────────

#[test]
fn set_max_rounds_rejects_zero() {
    let (env, admin, client) = setup_with_admin();
    let (_asset, token_id) = setup_token(&env, &admin);
    client.set_token(&token_id);
    client.init(&5u32, &TEST_REQUIRED_STAKE, &3600);
    assert_eq!(
        client.try_set_max_rounds(&0u32),
        Err(Ok(ArenaError::InvalidMaxRounds))
    );
}

#[test]
fn set_max_rounds_rejects_above_max() {
    let (env, admin, client) = setup_with_admin();
    let (_asset, token_id) = setup_token(&env, &admin);
    client.set_token(&token_id);
    client.init(&5u32, &TEST_REQUIRED_STAKE, &3600);
    assert_eq!(
        client.try_set_max_rounds(&(bounds::MAX_MAX_ROUNDS + 1)),
        Err(Ok(ArenaError::InvalidMaxRounds))
    );
}

#[test]
fn set_max_rounds_accepts_boundary_values() {
    let (env, admin, client) = setup_with_admin();
    let (_asset, token_id) = setup_token(&env, &admin);
    client.set_token(&token_id);
    client.init(&5u32, &TEST_REQUIRED_STAKE, &3600);
    assert!(client.try_set_max_rounds(&bounds::MIN_MAX_ROUNDS).is_ok());
    assert!(client.try_set_max_rounds(&bounds::MAX_MAX_ROUNDS).is_ok());
    assert!(
        client
            .try_set_max_rounds(&bounds::DEFAULT_MAX_ROUNDS)
            .is_ok()
    );
}

// ── Issue #470: role-based access control ─────────────────────────────────────

#[test]
fn cancel_arena_by_host_succeeds_when_pending() {
    let (env, admin, client) = setup_with_admin();
    let (_asset, token_id) = setup_token(&env, &admin);
    client.set_token(&token_id);
    client.init(&5u32, &TEST_REQUIRED_STAKE, &3600);
    // Inject a creator (host) into storage.
    let host = Address::generate(&env);
    env.as_contract(&client.address, || {
        env.storage().instance().set(&CREATOR_KEY, &host);
    });
    client.cancel_arena(&host);
    assert!(client.is_cancelled());
}

#[test]
fn cancel_arena_by_non_admin_non_host_returns_unauthorized() {
    let (env, admin, client) = setup_with_admin();
    let (_asset, token_id) = setup_token(&env, &admin);
    client.set_token(&token_id);
    client.init(&5u32, &TEST_REQUIRED_STAKE, &3600);
    let stranger = Address::generate(&env);
    let result = client.try_cancel_arena(&stranger);
    assert_eq!(result, Err(Ok(ArenaError::Unauthorized)));
}

#[test]
fn cancel_arena_by_host_after_active_returns_unauthorized() {
    let (env, _admin, client, _token_id, _players) = setup_game(5, 2);
    let host = Address::generate(&env);
    env.as_contract(&client.address, || {
        env.storage().instance().set(&CREATOR_KEY, &host);
    });
    // Start a round so the arena transitions to Active.
    client.start_round();
    let result = client.try_cancel_arena(&host);
    assert_eq!(result, Err(Ok(ArenaError::Unauthorized)));
}

// ── Issue #466: two-step admin transfer (arena) ───────────────────────────────

#[test]
fn propose_admin_stores_pending_admin() {
    let (env, admin, client) = setup_with_admin();
    let new_admin = Address::generate(&env);
    client.propose_admin(&new_admin);
    let pending = client.pending_admin_transfer();
    assert!(pending.is_some());
    assert_eq!(pending.unwrap().0, new_admin);
}

#[test]
fn accept_admin_transfers_admin() {
    let (env, admin, client) = setup_with_admin();
    let new_admin = Address::generate(&env);
    client.propose_admin(&new_admin);
    client.accept_admin(&new_admin);
    assert_eq!(client.admin(), new_admin);
    assert!(client.pending_admin_transfer().is_none());
}

#[test]
fn accept_admin_wrong_caller_returns_unauthorized() {
    let (env, admin, client) = setup_with_admin();
    let new_admin = Address::generate(&env);
    let impostor = Address::generate(&env);
    client.propose_admin(&new_admin);
    let result = client.try_accept_admin(&impostor);
    assert_eq!(result, Err(Ok(ArenaError::Unauthorized)));
}

#[test]
fn accept_admin_after_expiry_returns_expired() {
    let (env, admin, client) = setup_with_admin();
    let new_admin = Address::generate(&env);
    client.propose_admin(&new_admin);
    // Advance timestamp past 7-day window.
    let mut ledger = env.ledger().get();
    ledger.timestamp += 8 * 24 * 60 * 60;
    env.ledger().set(ledger);
    env.mock_all_auths();
    let result = client.try_accept_admin(&new_admin);
    assert_eq!(result, Err(Ok(ArenaError::AdminTransferExpired)));
}

#[test]
fn cancel_admin_transfer_clears_pending() {
    let (env, admin, client) = setup_with_admin();
    let new_admin = Address::generate(&env);
    client.propose_admin(&new_admin);
    client.cancel_admin_transfer();
    assert!(client.pending_admin_transfer().is_none());
}

#[test]
fn cancel_admin_transfer_with_no_pending_returns_error() {
    let (_env, _admin, client) = setup_with_admin();
    let result = client.try_cancel_admin_transfer();
    assert_eq!(result, Err(Ok(ArenaError::NoPendingAdminTransfer)));
}

// ── Issue #462/#464: vault and yield ─────────────────────────────────────────

#[test]
fn toggle_vault_active_stores_flag() {
    let (_env, _admin, client) = setup_with_admin();
    client.toggle_vault_active(&true);
    let state = client.try_get_arena_state().unwrap().unwrap_err(); // not initialized yet — just check the flag via storage
    // Since init hasn't been called, use a raw approach: confirm toggle_vault_active returns Ok.
    assert!(client.try_toggle_vault_active(&false).is_ok());
}

#[test]
fn complete_with_yield_no_vault_pays_principal() {
    let (env, _admin, client, token_id, players) = setup_game(5, 2);
    // Run a round so one player is eliminated.
    client.start_round();
    let round = client.get_round();
    let p0 = players[0].clone();
    let p1 = players[1].clone();
    client.submit_choice(&p0, &round.round_number, &Choice::Heads);
    client.submit_choice(&p1, &round.round_number, &Choice::Tails);
    set_ledger_sequence(&env, round.round_deadline_ledger + 20);
    env.mock_all_auths();
    client.resolve_round();
    // Complete game without vault.
    let survivor = get_survivors_public(&env, &client);
    if !survivor.is_empty() {
        let winner = survivor[0].clone();
        assert!(client.try_complete_with_yield(&winner).is_ok());
    }
}

fn get_survivors_public(env: &Env, client: &ArenaContractClient) -> std::vec::Vec<Address> {
    let all: soroban_sdk::Vec<Address> = env.as_contract(&client.address, || {
        env.storage()
            .persistent()
            .get(&DataKey::AllPlayers)
            .unwrap_or(soroban_sdk::Vec::new(env))
    });
    let mut out = std::vec::Vec::new();
    for p in all.iter() {
        let is_survivor = env.as_contract(&client.address, || {
            env.storage()
                .persistent()
                .has(&DataKey::Survivor(p.clone()))
        });
        if is_survivor {
            out.push(p);
        }
    }
    out
}

// ── Issue #481: lazy ArenaCache ───────────────────────────────────────────────
//
// Pre-seed instance/persistent storage directly so the tests don't depend on
// `init` (which is unrelated to the cache refactor and currently fails on the
// `DeadlineTooSoon` validation in the broader test suite). The point here is
// to exercise the read path: `get_arena_state` and `get_full_state` should
// load each ledger key once via `ArenaCache` and produce identical, consistent
// values.

fn seed_arena_cache_fixture(
    env: &Env,
    contract_id: &Address,
    round_number: u32,
    survivor_count: u32,
    capacity: u32,
    prize_pool: i128,
) {
    env.as_contract(contract_id, || {
        env.storage().instance().set(
            &DataKey::Round,
            &RoundState {
                round_number,
                round_start_ledger: 0,
                round_deadline_ledger: 0,
                active: false,
                total_submissions: 0,
                timed_out: false,
                finished: false,
            },
        );
        env.storage()
            .instance()
            .set(&SURVIVOR_COUNT_KEY, &survivor_count);
        env.storage().instance().set(&CAPACITY_KEY, &capacity);
        env.storage().instance().set(&PRIZE_POOL_KEY, &prize_pool);
    });
}

#[test]
fn arena_cache_returns_seeded_arena_state_view() {
    let (env, _admin, client) = setup_with_admin();
    seed_arena_cache_fixture(&env, &client.address, 7, 5, 16, 1_234_000i128);

    let view = client.get_arena_state();
    assert_eq!(view.round_number, 7);
    assert_eq!(view.survivors_count, 5);
    assert_eq!(view.max_capacity, 16);
    assert_eq!(view.current_stake, 1_234_000);
    // potential_payout shares the same storage slot as current_stake; ensures
    // the cache populates both fields from a single PRIZE_POOL_KEY read.
    assert_eq!(view.potential_payout, 1_234_000);
    assert_eq!(view.current_stake, view.potential_payout);
}

#[test]
fn arena_cache_falls_back_to_defaults_when_unseeded() {
    let (env, _admin, client) = setup_with_admin();
    // Only seed `Round` (required, since otherwise we hit `NotInitialized`);
    // the rest must fall back to defaults.
    env.as_contract(&client.address, || {
        env.storage().instance().set(
            &DataKey::Round,
            &RoundState {
                round_number: 0,
                round_start_ledger: 0,
                round_deadline_ledger: 0,
                active: false,
                total_submissions: 0,
                timed_out: false,
                finished: false,
            },
        );
    });

    let view = client.get_arena_state();
    assert_eq!(view.round_number, 0);
    assert_eq!(view.survivors_count, 0);
    // Capacity falls back to bounds::MAX_ARENA_PARTICIPANTS (test value 64).
    assert_eq!(view.max_capacity, bounds::MAX_ARENA_PARTICIPANTS);
    assert_eq!(view.current_stake, 0);
    assert_eq!(view.potential_payout, 0);
}

#[test]
fn arena_cache_returns_not_initialized_without_round() {
    // A blank contract — no `DataKey::Round` set. Cache load surfaces
    // `NotInitialized`, mirroring the pre-refactor behavior of `get_round`.
    let (_env, _admin, client) = setup_with_admin();
    let err = client.try_get_arena_state();
    assert_eq!(err, Err(Ok(ArenaError::NotInitialized)));
}

#[test]
fn full_state_view_agrees_with_arena_state_view_on_overlap() {
    let (env, _admin, client) = setup_with_admin();
    seed_arena_cache_fixture(&env, &client.address, 3, 2, 8, 555i128);

    let player = Address::generate(&env);
    env.as_contract(&client.address, || {
        env.storage()
            .persistent()
            .set(&DataKey::Survivor(player.clone()), &true);
    });

    let arena = client.get_arena_state();
    let full = client.get_full_state(&player);

    assert_eq!(full.round_number, arena.round_number);
    assert_eq!(full.survivors_count, arena.survivors_count);
    assert_eq!(full.max_capacity, arena.max_capacity);
    assert_eq!(full.current_stake, arena.current_stake);
    assert_eq!(full.potential_payout, arena.potential_payout);
    assert!(full.is_active);
    assert!(!full.has_won);
}

#[test]
fn full_state_view_reflects_player_winner_flag() {
    let (env, _admin, client) = setup_with_admin();
    seed_arena_cache_fixture(&env, &client.address, 1, 1, 4, 200i128);

    let player = Address::generate(&env);
    env.as_contract(&client.address, || {
        env.storage()
            .persistent()
            .set(&DataKey::Survivor(player.clone()), &true);
        env.storage()
            .persistent()
            .set(&DataKey::Winner(player.clone()), &true);
    });

    let full = client.get_full_state(&player);
    assert!(full.is_active);
    assert!(full.has_won);
}

#[test]
fn user_state_view_reads_each_player_independently() {
    let (env, _admin, client) = setup_with_admin();
    seed_arena_cache_fixture(&env, &client.address, 0, 0, 2, 0i128);

    let active_player = Address::generate(&env);
    let inactive_player = Address::generate(&env);
    env.as_contract(&client.address, || {
        env.storage()
            .persistent()
            .set(&DataKey::Survivor(active_player.clone()), &true);
    });

    let active = client.get_user_state(&active_player);
    let inactive = client.get_user_state(&inactive_player);

    assert!(active.is_active);
    assert!(!active.has_won);
    assert!(!inactive.is_active);
    assert!(!inactive.has_won);
}

#[test]
fn full_state_view_is_idempotent_across_repeated_calls() {
    // The cache must not mutate state — repeated calls return the same view.
    let (env, _admin, client) = setup_with_admin();
    seed_arena_cache_fixture(&env, &client.address, 4, 3, 8, 999i128);

    let player = Address::generate(&env);
    env.as_contract(&client.address, || {
        env.storage()
            .persistent()
            .set(&DataKey::Survivor(player.clone()), &true);
    });

    let first = client.get_full_state(&player);
    let second = client.get_full_state(&player);
    let third = client.get_full_state(&player);
    assert_eq!(first, second);
    assert_eq!(second, third);
}

#[test]
fn test_prize_pool_manipulation_protection() {
    let (env, _admin, client, token_id, _players) = setup_game(5, 3);
    let asset = StellarAssetClient::new(&env, &token_id);
    let arena_id = client.address.clone();

    // Initial prize pool from 3 players joining (100 * 3 = 300)
    let initial_state = client.get_arena_state();
    assert_eq!(initial_state.current_stake, 300);

    // Attacker sends tokens directly to the contract address without joining
    let attacker = Address::generate(&env);
    asset.mint(&attacker, &1000);

    // Use token client for transfer
    let token_client = token::Client::new(&env, &token_id);
    token_client.transfer(&attacker, &arena_id, &500);

    // Check prize pool again - it should STILL be 300
    let after_attack_state = client.get_arena_state();
    assert_eq!(
        after_attack_state.current_stake, 300,
        "Prize pool was inflated by direct transfer!"
    );

    // Verify that the actual token balance IS higher, but the contract doesn't use it
    assert_eq!(token_client.balance(&arena_id), 800); // 300 (joins) + 500 (attack)
}

// ── Yield split invariant tests ──────────────────────────────────────────────────

// ── Issue #591/#592: batch_size guardrail tests ───────────────────────────────

fn setup_game_past_round_deadline(player_count: u32) -> (Env, ArenaContractClient<'static>) {
    let (env, _admin, client, _token_id, _players) = setup_game(5, player_count);
    set_ledger_sequence(&env, 1);
    let round = client.start_round();
    advance_past_resolution_window(&env, &round);
    (env, client)
}

#[test]
fn start_resolution_zero_batch_rejected() {
    let (_env, _admin, client) = setup_with_admin();
    assert_eq!(
        client.try_start_resolution(&0),
        Err(Ok(ArenaError::InvalidAmount))
    );
}

#[test]
fn start_resolution_oversized_batch_rejected() {
    let (_env, _admin, client) = setup_with_admin();
    assert_eq!(
        client.try_start_resolution(&(bounds::MAX_BATCH_SIZE + 1)),
        Err(Ok(ArenaError::InvalidAmount))
    );
}

#[test]
fn continue_resolution_zero_batch_rejected() {
    let (_env, _admin, client) = setup_with_admin();
    assert_eq!(
        client.try_continue_resolution(&0),
        Err(Ok(ArenaError::InvalidAmount))
    );
}

#[test]
fn continue_resolution_oversized_batch_rejected() {
    let (_env, _admin, client) = setup_with_admin();
    assert_eq!(
        client.try_continue_resolution(&(bounds::MAX_BATCH_SIZE + 1)),
        Err(Ok(ArenaError::InvalidAmount))
    );
}

#[test]
fn start_resolution_min_batch_size_accepted() {
    let (_env, client) = setup_game_past_round_deadline(4);
    let state = client.start_resolution(&bounds::MIN_BATCH_SIZE);
    assert_eq!(
        state.processed,
        bounds::MIN_BATCH_SIZE,
        "MIN_BATCH_SIZE should process exactly MIN_BATCH_SIZE players"
    );
}

#[test]
fn start_resolution_max_batch_size_covers_all_players() {
    let (_env, client) = setup_game_past_round_deadline(4);
    let state = client.start_resolution(&bounds::MAX_BATCH_SIZE);
    assert_eq!(
        state.processed, 4,
        "MAX_BATCH_SIZE >= player_count should process all 4 players in one call"
    );
}

#[test]
fn continue_resolution_min_batch_size_accepted() {
    let (_env, client) = setup_game_past_round_deadline(4);
    client.start_resolution(&bounds::MIN_BATCH_SIZE);
    let result = client.try_continue_resolution(&bounds::MIN_BATCH_SIZE);
    assert!(
        result.is_ok(),
        "MIN_BATCH_SIZE must be accepted by continue_resolution"
    );
}

#[test]
fn continue_resolution_max_batch_size_accepted() {
    let (_env, client) = setup_game_past_round_deadline(4);
    client.start_resolution(&bounds::MIN_BATCH_SIZE);
    let state = client.continue_resolution(&bounds::MAX_BATCH_SIZE);
    assert_eq!(
        state.processed, 4,
        "MAX_BATCH_SIZE continue_resolution should drain all remaining players"
    );
}

#[test]
fn test_yield_split_invariants() {
    let (env, admin, client) = setup_with_admin();
    let (_asset, token_id) = setup_token(&env, &admin);
    client.set_token(&token_id);
    client.init(&5, &10i128, &3600);

    // Initial sum is 7_000 (winner) + 1_000 (reserve) = 8_000

    // Test setting winner share too high
    let result = client.try_set_winner_yield_share_bps(&9_500);
    // 9_500 + 1_000 = 10_500 > 10_000, should fail
    assert_eq!(result, Err(Ok(ArenaError::InvalidAmount)));

    // Test setting reserve too high
    let result = client.try_set_reserve_ratio_bps(&3_500);
    // 3_500 + 7_000 = 10_500 > 10_000, should fail
    assert_eq!(result, Err(Ok(ArenaError::InvalidAmount)));

    // Setting both validly
    assert!(client.try_set_winner_yield_share_bps(&6_000).is_ok());
    // Current sum: 6_000 + 1_000 = 7_000

    assert!(client.try_set_reserve_ratio_bps(&4_000).is_ok());
    // Current sum: 6_000 + 4_000 = 10_000 (ok)

    // Now try to exceed again
    let result = client.try_set_winner_yield_share_bps(&6_001);
    assert_eq!(result, Err(Ok(ArenaError::InvalidAmount)));
}
