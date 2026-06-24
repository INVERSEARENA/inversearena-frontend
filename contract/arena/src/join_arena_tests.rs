//! Regression tests for issue #777.
//!
//! Verifies that `join_arena()` rejects every non-Open state and accepts a
//! join when the arena is Open.
//!
//! State guard in lib.rs join_arena() (lines 70-72):
//!   !Open → ArenaError::InvalidGameState

#![cfg(test)]

extern crate std;

use super::*;
use soroban_sdk::{
    Address, Env, contract, contractimpl, testutils::Address as _, token::StellarAssetClient,
};

// ── Mock vault (needed by join_arena's try_deposit call) ─────────────────────

#[contract]
struct MockVault;

#[contractimpl]
impl MockVault {
    pub fn deposit(_env: Env, _from: Address, _amount: i128) {}
    pub fn balance_of(_env: Env, _user: Address) -> i128 {
        0
    }
    pub fn withdraw_all(_env: Env, _user: Address) -> i128 {
        0
    }
}

// ── Helpers ───────────────────────────────────────────────────────────────────

/// Build an arena contract whose on-chain config is set to `state`.
/// Returns (Env, ArenaContractClient, token_address).
fn setup_arena(state: GameState) -> (Env, ArenaContractClient<'static>, Address) {
    let env = Env::default();
    env.mock_all_auths();

    let contract_id = env.register(ArenaContract, ());
    let vault_id = env.register(MockVault, ());

    let token_admin = Address::generate(&env);
    let token_id = env
        .register_stellar_asset_contract_v2(token_admin)
        .address();

    let oracle = Address::generate(&env);

    env.as_contract(&contract_id, || {
        let config = ArenaConfig {
            admin: Address::generate(&env),
            stake_token: token_id.clone(),
            yield_vault: vault_id,
            entry_fee: 100,
            state,
            paused: false,
            player_count: 0,
            cumulative_yield: 0,
            commit_deadline: u64::MAX,
            round_count: 0,
            oracle_contract: oracle,
        };
        ArenaStorage::save_config(&env, &config);
        ArenaStorage::save_last_vault_balance(&env, 0);
    });

    let env_static: &'static Env = unsafe { &*(&env as *const Env) };
    let client = ArenaContractClient::new(env_static, &contract_id);
    (env, client, token_id)
}

// ── Tests ─────────────────────────────────────────────────────────────────────

/// join_arena() accepts a player when the arena is Open.
#[test]
fn join_accepted_when_arena_is_open() {
    let (env, client, token_id) = setup_arena(GameState::Open);

    let player = Address::generate(&env);
    StellarAssetClient::new(&env, &token_id).mint(&player, &100);

    assert!(
        client.try_join_arena(&player).is_ok(),
        "join_arena() must succeed when arena is Open"
    );
}

#[test]
fn creator_cannot_join_own_arena() {
    let (env, client, _) = setup_arena(GameState::Open);
    let creator = env.as_contract(&client.address, || {
        ArenaStorage::load_config(&env).unwrap().admin
    });

    assert_eq!(
        client.try_join_arena(&creator),
        Err(Ok(ArenaError::CreatorCannotJoin)),
        "arena creator/admin must not be able to join their own arena"
    );
}

#[test]
fn banned_player_cannot_join_until_unbanned() {
    let (env, client, token_id) = setup_arena(GameState::Open);
    let player = Address::generate(&env);

    client.ban_player(&player);
    assert!(client.is_player_banned(&player));
    assert_eq!(
        client.try_join_arena(&player),
        Err(Ok(ArenaError::PlayerBanned)),
        "banned player must not be able to join"
    );

    client.unban_player(&player);
    assert!(!client.is_player_banned(&player));
    StellarAssetClient::new(&env, &token_id).mint(&player, &100);
    assert!(
        client.try_join_arena(&player).is_ok(),
        "unbanned player should be able to join normally"
    );
}

#[test]
fn banning_existing_player_does_not_remove_participation() {
    let (env, client, token_id) = setup_arena(GameState::Open);
    let player = Address::generate(&env);
    StellarAssetClient::new(&env, &token_id).mint(&player, &100);

    client.join_arena(&player);
    assert_eq!(client.player_count(), 1);
    client.ban_player(&player);

    let players = client.get_players(&0);
    assert_eq!(players.len(), 1);
    assert_eq!(players.get(0).unwrap().0, player);
    assert_eq!(client.player_count(), 1);
}

/// join_arena() rejects with InvalidGameState when the arena is Active.
#[test]
fn join_rejected_when_arena_is_active() {
    let (env, client, _) = setup_arena(GameState::Active);
    let player = Address::generate(&env);
    assert_eq!(
        client.try_join_arena(&player),
        Err(Ok(ArenaError::InvalidGameState)),
        "join_arena() must reject when Active; removing the guard allows mid-game joins"
    );
}

/// join_arena() rejects with InvalidGameState when the arena is Finished.
#[test]
fn join_rejected_when_arena_is_finished() {
    let (env, client, _) = setup_arena(GameState::Finished);
    let player = Address::generate(&env);
    assert_eq!(
        client.try_join_arena(&player),
        Err(Ok(ArenaError::InvalidGameState)),
        "join_arena() must reject when Finished; removing the guard allows post-game joins"
    );
}

/// join_arena() rejects with InvalidGameState when the arena is Cancelled.
#[test]
fn join_rejected_when_arena_is_cancelled() {
    let (env, client, _) = setup_arena(GameState::Cancelled);
    let player = Address::generate(&env);
    assert_eq!(
        client.try_join_arena(&player),
        Err(Ok(ArenaError::InvalidGameState)),
        "join_arena() must reject when Cancelled; removing the guard accepts fees after cancellation"
    );
}

/// join_arena() rejects with InvalidGameState when the arena is Settled.
#[test]
fn join_rejected_when_arena_is_settled() {
    let (env, client, _) = setup_arena(GameState::Settled);
    let player = Address::generate(&env);
    assert_eq!(
        client.try_join_arena(&player),
        Err(Ok(ArenaError::InvalidGameState)),
        "join_arena() must reject when Settled; removing the guard allows joins after prize payout"
    );
}
