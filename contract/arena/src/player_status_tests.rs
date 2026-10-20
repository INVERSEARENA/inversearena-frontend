//! `get_player_status` across the arena lifecycle (#1582).

#![cfg(test)]

extern crate std;

use super::*;
use crate::types::{ArenaPhase, EliminationReason};
use soroban_sdk::{
    Address, Env, contract, contractimpl,
    testutils::{Address as _, Ledger as _},
    token::StellarAssetClient,
};

const ROUND_SECONDS: u64 = 60;

#[contract]
struct MockVault;

#[contractimpl]
impl MockVault {
    pub fn deposit(_env: Env, _from: Address, _amount: i128) {}

    pub fn balance_of(_env: Env, _user: Address) -> i128 {
        0
    }

    pub fn withdraw(_env: Env, _user: Address, amount: i128) -> i128 {
        amount
    }

    pub fn withdraw_all(_env: Env, _user: Address) -> i128 {
        0
    }
}

struct Arena {
    env: Env,
    client: ArenaContractClient<'static>,
    token: Address,
}

impl Arena {
    fn new() -> Self {
        Self::deploy(|env| env.register(ArenaContract, ()))
    }

    /// Run against the compiled WASM, so measured costs match on-chain execution.
    fn new_wasm() -> Self {
        Self::deploy(|env| env.register(crate::WASM, ()))
    }

    fn deploy(register: impl FnOnce(&Env) -> Address) -> Self {
        let env = Env::default();
        env.mock_all_auths();
        let contract_id = register(&env);
        let vault = env.register(MockVault, ());
        let token = env
            .register_stellar_asset_contract_v2(Address::generate(&env))
            .address();

        env.as_contract(&contract_id, || {
            ArenaStorage::save_config(
                &env,
                &ArenaConfig {
                    admin: Address::generate(&env),
                    stake_token: token.clone(),
                    yield_vault: vault,
                    entry_fee: 100,
                    state: GameState::Open,
                    paused: false,
                    player_count: 0,
                    active_player_count: 0,
                    cumulative_yield: 0,
                    commit_deadline: 0,
                    round_count: 0,
                    oracle_contract: Address::generate(&env),
                    factory: Address::generate(&env),
                    pool_id: 0,
                    platform_fee_bps: 1000,
                },
            );
            ArenaStorage::initialize_paged_roster(&env);
            ArenaStorage::save_last_vault_balance(&env, 0);
            ArenaStorage::save_player_limits(&env, 2, 10);
        });

        let client = ArenaContractClient::new(&env, &contract_id);
        Arena { env, client, token }
    }

    fn join(&self) -> Address {
        let player = Address::generate(&self.env);
        StellarAssetClient::new(&self.env, &self.token).mint(&player, &100);
        self.client.join_arena(&player);
        player
    }

    fn commit(&self, player: &Address, choice: Choice, salt: u8) {
        let salt = BytesN::from_array(&self.env, &[salt; 32]);
        let commitment = ArenaContract::compute_commitment(
            &self.env,
            &self.client.address,
            1,
            player,
            choice,
            &salt,
        );
        self.client.submit_commitment(player, &commitment);
    }

    fn reveal(&self, player: &Address, choice: Choice, salt: u8) {
        let salt = BytesN::from_array(&self.env, &[salt; 32]);
        self.client.reveal_choice(player, &choice, &salt);
    }

    fn start_round(&self) {
        self.client.start_round(&ROUND_SECONDS);
    }

    fn end_commit_phase(&self) {
        self.env
            .ledger()
            .with_mut(|li| li.timestamp = li.timestamp.saturating_add(ROUND_SECONDS));
    }

    fn status(&self, player: &Address) -> PlayerStatus {
        self.client.get_player_status(player)
    }
}

fn idle(phase: ArenaPhase, current_round: u32) -> PlayerStatus {
    PlayerStatus {
        joined: false,
        active: false,
        committed: false,
        revealed: false,
        eliminated_round: None,
        elimination_reason: EliminationReason::NotEliminated,
        refund_claimed: false,
        winner: false,
        current_round,
        phase,
    }
}

fn joined_active(phase: ArenaPhase, current_round: u32) -> PlayerStatus {
    PlayerStatus {
        joined: true,
        active: true,
        ..idle(phase, current_round)
    }
}

#[test]
fn uninitialized_arena_reports_not_initialized() {
    let env = Env::default();
    let client = ArenaContractClient::new(&env, &env.register(ArenaContract, ()));
    let result = client.try_get_player_status(&Address::generate(&env));
    assert_eq!(result, Err(Ok(ArenaError::NotInitialized)));
}

#[test]
fn non_player_is_reported_as_not_joined_rather_than_an_error() {
    let arena = Arena::new();
    arena.join();
    let stranger = Address::generate(&arena.env);
    assert_eq!(arena.status(&stranger), idle(ArenaPhase::Lobby, 0));
}

#[test]
fn lobby_player_is_joined_and_active() {
    let arena = Arena::new();
    let player = arena.join();
    assert_eq!(arena.status(&player), joined_active(ArenaPhase::Lobby, 0));
}

#[test]
fn player_who_left_the_lobby_is_no_longer_joined() {
    let arena = Arena::new();
    let player = arena.join();
    arena.client.leave_arena(&player);
    assert_eq!(arena.status(&player), idle(ArenaPhase::Lobby, 0));
}

#[test]
fn commit_and_reveal_flags_track_the_running_round() {
    let arena = Arena::new();
    let player = arena.join();
    arena.join();
    arena.start_round();

    assert_eq!(arena.status(&player), joined_active(ArenaPhase::Commit, 1));

    arena.commit(&player, Choice::Heads, 1);
    let committed = arena.status(&player);
    assert!(committed.committed);
    assert!(!committed.revealed);
    assert_eq!(committed.phase, ArenaPhase::Commit);

    arena.end_commit_phase();
    assert_eq!(arena.status(&player).phase, ArenaPhase::Reveal);

    arena.reveal(&player, Choice::Heads, 1);
    let revealed = arena.status(&player);
    assert!(revealed.committed);
    assert!(revealed.revealed);
    assert_eq!(revealed.current_round, 1);
}

#[test]
fn resolution_records_round_and_reason_for_every_elimination_path() {
    let arena = Arena::new();
    let survivor = arena.join();
    let majority = [arena.join(), arena.join()];
    let silent_revealer = arena.join();
    let never_committed = arena.join();
    arena.start_round();

    arena.commit(&survivor, Choice::Tails, 1);
    arena.commit(&majority[0], Choice::Heads, 2);
    arena.commit(&majority[1], Choice::Heads, 3);
    arena.commit(&silent_revealer, Choice::Heads, 4);
    arena.end_commit_phase();
    arena.reveal(&survivor, Choice::Tails, 1);
    arena.reveal(&majority[0], Choice::Heads, 2);
    arena.reveal(&majority[1], Choice::Heads, 3);
    arena.client.resolve_round();

    let eliminated = |reason| PlayerStatus {
        joined: true,
        eliminated_round: Some(1),
        elimination_reason: reason,
        ..idle(ArenaPhase::Finished, 1)
    };
    assert_eq!(arena.status(&majority[0]), eliminated(EliminationReason::Majority));
    assert_eq!(arena.status(&majority[1]), eliminated(EliminationReason::Majority));
    assert_eq!(
        arena.status(&silent_revealer),
        eliminated(EliminationReason::NoReveal)
    );
    assert_eq!(
        arena.status(&never_committed),
        eliminated(EliminationReason::NoCommit)
    );
    assert_eq!(
        arena.status(&survivor),
        PlayerStatus {
            winner: true,
            ..joined_active(ArenaPhase::Finished, 1)
        }
    );
}

#[test]
fn player_eliminated_before_reasons_were_recorded_reports_unrecorded() {
    let arena = Arena::new();
    let player = arena.join();
    arena.env.as_contract(&arena.client.address, || {
        ArenaStorage::save_player(
            &arena.env,
            &player,
            &PlayerState {
                active: false,
                rounds_survived: 2,
            },
        );
    });

    let status = arena.status(&player);
    assert_eq!(status.eliminated_round, Some(3));
    assert_eq!(status.elimination_reason, EliminationReason::Unrecorded);
}

#[test]
fn survivors_enter_intermission_with_cleared_round_flags() {
    let arena = Arena::new();
    let minority = [arena.join(), arena.join()];
    let majority = [arena.join(), arena.join(), arena.join()];
    arena.start_round();
    for (i, player) in minority.iter().enumerate() {
        arena.commit(player, Choice::Tails, i as u8);
    }
    for (i, player) in majority.iter().enumerate() {
        arena.commit(player, Choice::Heads, 10 + i as u8);
    }
    arena.end_commit_phase();
    for (i, player) in minority.iter().enumerate() {
        arena.reveal(player, Choice::Tails, i as u8);
    }
    for (i, player) in majority.iter().enumerate() {
        arena.reveal(player, Choice::Heads, 10 + i as u8);
    }
    arena.client.resolve_round();

    assert_eq!(
        arena.status(&minority[0]),
        joined_active(ArenaPhase::Intermission, 1)
    );

    // The next round reports round 2, and the eliminated player keeps the
    // round they were eliminated in.
    arena.start_round();
    assert_eq!(arena.status(&minority[1]), joined_active(ArenaPhase::Commit, 2));
    let eliminated = arena.status(&majority[0]);
    assert_eq!(eliminated.eliminated_round, Some(1));
    assert_eq!(eliminated.current_round, 2);
    assert!(!eliminated.committed);
}

#[test]
fn claimed_prize_reports_settled_winner() {
    let arena = Arena::new();
    let winner = arena.join();
    let loser = arena.join();
    let other = arena.join();
    arena.start_round();
    arena.commit(&winner, Choice::Tails, 1);
    arena.commit(&loser, Choice::Heads, 2);
    arena.commit(&other, Choice::Heads, 3);
    arena.end_commit_phase();
    arena.reveal(&winner, Choice::Tails, 1);
    arena.reveal(&loser, Choice::Heads, 2);
    arena.reveal(&other, Choice::Heads, 3);
    arena.client.resolve_round();
    arena.client.claim(&winner);

    let status = arena.status(&winner);
    assert!(status.winner);
    assert_eq!(status.phase, ArenaPhase::Settled);
    assert!(!arena.status(&loser).winner);
}

#[test]
fn cancelled_arena_reports_refund_claims_per_player() {
    let arena = Arena::new();
    let refunded = arena.join();
    let pending = arena.join();
    arena.client.cancel_arena();
    arena.client.claim_refund(&refunded);

    assert_eq!(
        arena.status(&refunded),
        PlayerStatus {
            refund_claimed: true,
            ..joined_active(ArenaPhase::Cancelled, 0)
        }
    );
    assert_eq!(arena.status(&pending), joined_active(ArenaPhase::Cancelled, 0));
}

#[test]
fn read_writes_nothing_and_extends_no_ttl() {
    let arena = Arena::new();
    let player = arena.join();
    arena.join();
    arena.start_round();
    arena.commit(&player, Choice::Heads, 1);

    let before = arena.env.to_ledger_snapshot().ledger_entries;
    arena.status(&player);
    let resources = arena.env.cost_estimate().resources();
    let after = arena.env.to_ledger_snapshot().ledger_entries;

    assert_eq!(before, after, "ledger entries and their TTLs must be unchanged");
    assert_eq!(resources.write_entries, 0);
    assert_eq!(resources.write_bytes, 0);
    assert_eq!(resources.persistent_entry_rent_bumps, 0);
}

#[test]
fn read_cost_is_bounded_and_independent_of_roster_size() {
    let measure = |players: u32| {
        let arena = Arena::new_wasm();
        let player = arena.join();
        for _ in 1..players {
            arena.join();
        }
        arena.start_round();
        arena.commit(&player, Choice::Heads, 1);
        arena.status(&player);
        arena.env.cost_estimate().resources()
    };

    let small = measure(2);
    let full = measure(10);
    std::println!("get_player_status (WASM, commit phase): {small:?}");

    // Instance + code + config, player, commitment, choice.
    assert!(small.read_entries <= 6, "read entries: {}", small.read_entries);
    assert_eq!(full.read_entries, small.read_entries);
    assert_eq!(full.read_bytes, small.read_bytes);
    // Instruction metering includes a host-side per-ledger-entry overhead that
    // is unrelated to this read path: measured, adding 100 unrelated
    // persistent entries to a 2-player arena moves the count by ~38k
    // instructions while every storage metric above stays identical. The
    // roster-independence guarantee is the constant entry/byte footprint
    // asserted above; this bound only catches the read path itself growing
    // (it would need to exceed the host overhead for a 8-player delta).
    assert!(
        full.instructions <= small.instructions + 50_000,
        "instructions grew with the roster: {} vs {}",
        full.instructions,
        small.instructions
    );
}
