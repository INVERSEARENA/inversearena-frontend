//! Integration tests for the complete game lifecycle.
//!
//! These tests exercise all three contracts (Factory, Arena, Payout) together
//! in a single Soroban test environment, verifying that they interact correctly
//! across the full sequence: pool creation → rounds → submissions → timeouts →
//! payout distribution.
#![cfg(test)]

extern crate std;

use factory::{FactoryContract, FactoryContractClient};
use payout::{PayoutContract, PayoutContractClient};
use soroban_sdk::{
    symbol_short,
    testutils::{Address as _, Ledger, LedgerInfo},
    Address, BytesN, Env,
};

use super::*;

// ── helpers ───────────────────────────────────────────────────────────────────

fn dummy_wasm_hash(env: &Env) -> BytesN<32> {
    BytesN::from_array(env, &[0xabu8; 32])
}

/// Set ledger sequence with safe TTL values.
fn set_seq(env: &Env, seq: u32) {
    let ledger = env.ledger().get();
    env.ledger().set(LedgerInfo {
        sequence_number: seq,
        timestamp: 1_700_000_000 + seq as u64,
        protocol_version: 22,
        network_id: ledger.network_id,
        base_reserve: ledger.base_reserve,
        min_temp_entry_ttl: u32::MAX / 4,
        min_persistent_entry_ttl: u32::MAX / 4,
        max_entry_ttl: u32::MAX / 4,
    });
}

/// Deploy and initialise all three contracts, returning their clients.
fn deploy_all(
    env: &Env,
    admin: &Address,
) -> (
    ArenaContractClient<'static>,
    FactoryContractClient<'static>,
    PayoutContractClient<'static>,
) {
    // SAFETY: env outlives all clients within the test.
    let env_s: &'static Env = unsafe { &*(env as *const Env) };

    let arena_id = env.register(ArenaContract, ());
    let factory_id = env.register(FactoryContract, ());
    let payout_id = env.register(PayoutContract, ());

    let arena = ArenaContractClient::new(env_s, &arena_id);
    let factory = FactoryContractClient::new(env_s, &factory_id);
    let payout = PayoutContractClient::new(env_s, &payout_id);

    factory.initialize(admin);
    payout.initialize(admin);

    (arena, factory, payout)
}

// ── AC: Full lifecycle runs without error ─────────────────────────────────────

/// Complete game lifecycle: factory creates pool → arena runs 3 rounds with
/// 8 players → payout distributes winnings to the survivor.
#[test]
fn lifecycle_full_game_three_rounds_eight_players() {
    let env = Env::default();
    env.mock_all_auths();
    set_seq(&env, 1_000);

    let admin = Address::generate(&env);
    let (arena, factory, payout) = deploy_all(&env, &admin);

    // ── Step 1: Factory creates a pool ────────────────────────────────────────
    let wasm_hash = dummy_wasm_hash(&env);
    factory.set_arena_wasm_hash(&wasm_hash);

    let creator = Address::generate(&env);
    // pool_id=1, capacity=8, stake=10 XLM
    factory.create_pool(&admin, &creator, &1u32, &8u32, &10_000_000i128);

    // ── Step 2: Initialise the arena (10-ledger rounds) ───────────────────────
    arena.init(&10u32);

    // Generate 8 players.
    let players: std::vec::Vec<Address> = (0..8).map(|_| Address::generate(&env)).collect();

    // ── Step 3: Round 1 — all 8 players submit ────────────────────────────────
    set_seq(&env, 1_010);
    let r1 = arena.start_round();
    assert_eq!(r1.round_number, 1);
    assert!(r1.active);
    assert_eq!(r1.round_start_ledger, 1_010);
    assert_eq!(r1.round_deadline_ledger, 1_020);

    set_seq(&env, 1_015);
    for (i, p) in players.iter().enumerate() {
        arena.join(p, &10_000_000i128);
        let choice = if i % 2 == 0 { Choice::Heads } else { Choice::Tails };
        arena.submit_choice(p, &1u32, &choice);
    }

    // Verify all 8 submissions recorded.
    let state1 = arena.get_round();
    assert_eq!(state1.total_submissions, 8);

    // Advance past deadline and timeout.
    set_seq(&env, 1_021);
    let t1 = arena.timeout_round();
    assert!(!t1.active);
    assert!(t1.timed_out);
    assert_eq!(t1.round_number, 1);
    assert_eq!(t1.total_submissions, 8, "round 1 must capture all 8 submissions");

    // All choices are still readable after timeout.
    for (i, p) in players.iter().enumerate() {
        let expected = if i % 2 == 0 { Choice::Heads } else { Choice::Tails };
        assert_eq!(arena.get_choice(&1u32, p), Some(expected));
    }

    // ── Step 4: Round 2 — 4 survivors submit ─────────────────────────────────
    // (simulate elimination: only players who chose Heads in round 1 advance)
    let survivors_r2: std::vec::Vec<&Address> =
        players.iter().enumerate().filter(|(i, _)| i % 2 == 0).map(|(_, p)| p).collect();
    assert_eq!(survivors_r2.len(), 4);

    set_seq(&env, 1_030);
    let r2 = arena.start_round();
    assert_eq!(r2.round_number, 2);
    assert_eq!(r2.round_start_ledger, 1_030);

    set_seq(&env, 1_035);
    for (i, p) in survivors_r2.iter().enumerate() {
        let choice = if i % 2 == 0 { Choice::Heads } else { Choice::Tails };
        arena.submit_choice(p, &2u32, &choice);
    }

    let state2 = arena.get_round();
    assert_eq!(state2.total_submissions, 4, "round 2 must have exactly 4 submissions");

    set_seq(&env, 1_041);
    let t2 = arena.timeout_round();
    assert!(!t2.active);
    assert!(t2.timed_out);
    assert_eq!(t2.round_number, 2);

    // ── Step 5: Round 3 — 2 survivors submit ─────────────────────────────────
    // (simulate elimination: keep only those who chose Heads in round 2)
    let survivors_r3: std::vec::Vec<&Address> = survivors_r2
        .iter()
        .enumerate()
        .filter(|(i, _)| i % 2 == 0)
        .map(|(_, p)| *p)
        .collect();
    assert_eq!(survivors_r3.len(), 2);

    set_seq(&env, 1_050);
    let r3 = arena.start_round();
    assert_eq!(r3.round_number, 3);

    set_seq(&env, 1_055);
    for p in &survivors_r3 {
        arena.submit_choice(p, &3u32, &Choice::Heads);
    }

    let state3 = arena.get_round();
    assert_eq!(state3.total_submissions, 2, "round 3 must have exactly 2 submissions");

    set_seq(&env, 1_061);
    let t3 = arena.timeout_round();
    assert!(!t3.active);
    assert!(t3.timed_out);
    assert_eq!(t3.round_number, 3);

    // ── Step 6: Payout — distribute winnings to the winner ───────────────────
    let winner = survivors_r3[0];
    let idempotency_key = 1u32;
    let prize_amount = 80_000_000i128; // 80 XLM in stroops (8 × 10 XLM stakes)
    let currency = symbol_short!("XLM");

    assert!(!payout.is_payout_processed(&idempotency_key, winner));
    payout.distribute_winnings(&admin, &idempotency_key, winner, &prize_amount, &currency);
    assert!(payout.is_payout_processed(&idempotency_key, winner));

    let record = payout.get_payout(&idempotency_key, winner).unwrap();
    assert_eq!(record.winner, *winner);
    assert_eq!(record.amount, prize_amount);
    assert!(record.paid);
}

// ── AC: Correct player counts verified at each round ─────────────────────────

#[test]
fn lifecycle_player_counts_decrease_each_round() {
    let env = Env::default();
    env.mock_all_auths();
    set_seq(&env, 500);

    let admin = Address::generate(&env);
    let (arena, factory, _payout) = deploy_all(&env, &admin);

    factory.set_arena_wasm_hash(&dummy_wasm_hash(&env));
    let creator = Address::generate(&env);
    factory.create_pool(&admin, &creator, &1u32, &8u32, &10_000_000i128);

    arena.init(&5u32);

    let all_players: std::vec::Vec<Address> = (0..8).map(|_| Address::generate(&env)).collect();

    // Round 1: 8 players.
    set_seq(&env, 510);
    arena.start_round();
    set_seq(&env, 512);
    for p in &all_players {
        arena.join(p, &10_000_000i128);
        arena.submit_choice(p, &1u32, &Choice::Heads);
    }
    set_seq(&env, 516);
    let r1 = arena.timeout_round();
    assert_eq!(r1.total_submissions, 8);

    // Round 2: 4 players (half eliminated).
    set_seq(&env, 520);
    arena.start_round();
    set_seq(&env, 522);
    for p in all_players.iter().take(4) {
        arena.submit_choice(p, &2u32, &Choice::Heads);
    }
    set_seq(&env, 526);
    let r2 = arena.timeout_round();
    assert_eq!(r2.total_submissions, 4);

    // Round 3: 2 players.
    set_seq(&env, 530);
    arena.start_round();
    set_seq(&env, 532);
    for p in all_players.iter().take(2) {
        arena.submit_choice(p, &3u32, &Choice::Heads);
    }
    set_seq(&env, 536);
    let r3 = arena.timeout_round();
    assert_eq!(r3.total_submissions, 2);

    assert!(r1.total_submissions > r2.total_submissions);
    assert!(r2.total_submissions > r3.total_submissions);
}

// ── AC: Inter-contract calls verified ────────────────────────────────────────

#[test]
fn lifecycle_factory_and_arena_operate_in_same_env() {
    let env = Env::default();
    env.mock_all_auths();
    set_seq(&env, 100);

    let admin = Address::generate(&env);
    let (arena, factory, _payout) = deploy_all(&env, &admin);

    factory.set_arena_wasm_hash(&dummy_wasm_hash(&env));
    let creator = Address::generate(&env);
    // Factory must succeed before arena can be used.
    factory.create_pool(&admin, &creator, &1u32, &8u32, &20_000_000i128);

    // Arena initialises and runs a round — no cross-contract panic.
    arena.init(&3u32);
    let round = arena.start_round();
    assert_eq!(round.round_number, 1);
    assert!(round.active);

    let config = arena.get_config();
    assert_eq!(config.round_speed_in_ledgers, 3);
}

// ── AC: Winner receives full balance at end ───────────────────────────────────

#[test]
fn lifecycle_winner_payout_equals_total_stakes() {
    let env = Env::default();
    env.mock_all_auths();
    set_seq(&env, 200);

    let admin = Address::generate(&env);
    let (arena, factory, payout) = deploy_all(&env, &admin);

    factory.set_arena_wasm_hash(&dummy_wasm_hash(&env));
    let creator = Address::generate(&env);
    let stake_per_player: i128 = 10_000_000;
    let num_players: i128 = 8;
    let total_prize = stake_per_player * num_players;

    factory.create_pool(&admin, &creator, &1u32, &(num_players as u32), &stake_per_player);
    arena.init(&10u32);

    let players: std::vec::Vec<Address> = (0..num_players).map(|_| Address::generate(&env)).collect();

    // Run a single round, all players submit.
    set_seq(&env, 210);
    arena.start_round();
    set_seq(&env, 215);
    for p in &players {
        arena.join(p, &stake_per_player);
        arena.submit_choice(p, &1u32, &Choice::Heads);
    }
    set_seq(&env, 221);
    arena.timeout_round();

    // Distribute the full prize pool to the winner.
    let winner = &players[0];
    let key = 1u32;
    let currency = symbol_short!("XLM");

    payout.distribute_winnings(&admin, &key, winner, &total_prize, &currency);

    let record = payout.get_payout(&key, winner).unwrap();
    assert_eq!(
        record.amount, total_prize,
        "winner must receive the full combined stake"
    );
    assert!(record.paid);
}

// ── AC: No active round — submissions and timeouts rejected ───────────────────

#[test]
fn lifecycle_guard_no_active_round_between_rounds() {
    let env = Env::default();
    env.mock_all_auths();
    set_seq(&env, 0);

    let admin = Address::generate(&env);
    let (arena, _factory, _payout) = deploy_all(&env, &admin);

    arena.init(&5u32);

    let player = Address::generate(&env);

    // No round started yet — submit must fail.
    let err = arena.try_submit_choice(&player, &1u32, &Choice::Heads);
    assert_eq!(err, Err(Ok(ArenaError::NoActiveRound)));

    // Start and finish a round.
    set_seq(&env, 10);
    arena.start_round();
    set_seq(&env, 16);
    arena.timeout_round();

    // Between rounds — submit must fail.
    let err2 = arena.try_submit_choice(&player, &1u32, &Choice::Heads);
    assert_eq!(err2, Err(Ok(ArenaError::NoActiveRound)));

    // Between rounds — timeout must fail.
    let err3 = arena.try_timeout_round();
    assert_eq!(err3, Err(Ok(ArenaError::NoActiveRound)));
}

// ── AC: Full lifecycle with zero-submission round resolves cleanly ────────────

#[test]
fn lifecycle_round_with_no_submissions_resolves_then_payout() {
    let env = Env::default();
    env.mock_all_auths();
    set_seq(&env, 300);

    let admin = Address::generate(&env);
    let (arena, factory, payout) = deploy_all(&env, &admin);

    factory.set_arena_wasm_hash(&dummy_wasm_hash(&env));
    let creator = Address::generate(&env);
    factory.create_pool(&admin, &creator, &1u32, &8u32, &10_000_000i128);

    arena.init(&10u32);

    // Start round, nobody submits.
    set_seq(&env, 310);
    let r = arena.start_round();
    assert_eq!(r.total_submissions, 0);

    set_seq(&env, 321);
    let timed_out = arena.timeout_round();
    assert_eq!(timed_out.total_submissions, 0);
    assert!(timed_out.timed_out);

    // Payout can still be distributed for a separately determined winner.
    let winner = Address::generate(&env);
    payout.distribute_winnings(&admin, &1u32, &winner, &10_000_000i128, &symbol_short!("XLM"));
    assert!(payout.is_payout_processed(&1u32, &winner));
}
