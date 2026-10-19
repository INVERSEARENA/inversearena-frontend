//! Lobby lifecycle tests for leave (#1580), ban (#1581), and start deadlines
//! with permissionless cancellation (#1579).

#![cfg(test)]

extern crate std;

use super::*;
use soroban_sdk::{
    Address, Env, contract, contractimpl,
    testutils::{Address as _, Ledger as _},
    token::{StellarAssetClient, TokenClient},
};

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

fn setup() -> (Env, ArenaContractClient<'static>, Address) {
    let env = Env::default();
    env.mock_all_auths();

    let contract_id = env.register(ArenaContract, ());
    let vault_id = env.register(MockVault, ());

    let token_admin = Address::generate(&env);
    let token_id = env
        .register_stellar_asset_contract_v2(token_admin)
        .address();

    env.as_contract(&contract_id, || {
        let config = ArenaConfig {
            admin: Address::generate(&env),
            stake_token: token_id.clone(),
            yield_vault: vault_id,
            entry_fee: 100,
            state: GameState::Open,
            paused: false,
            player_count: 0,
            active_player_count: 0,
            cumulative_yield: 0,
            commit_deadline: u64::MAX,
            round_count: 0,
            oracle_contract: Address::generate(&env),
            factory: Address::generate(&env),
            pool_id: 0,
            platform_fee_bps: 1000,
        };
        ArenaStorage::save_config(&env, &config);
        ArenaStorage::save_last_vault_balance(&env, 0);
        ArenaStorage::save_player_limits(&env, 2, 10);
    });

    let client = ArenaContractClient::new(&env, &contract_id);
    (env, client, token_id)
}

fn join(env: &Env, client: &ArenaContractClient<'_>, token_id: &Address, player: &Address) {
    StellarAssetClient::new(env, token_id).mint(player, &100);
    client.join_arena(player);
}

fn set_round_count(env: &Env, client: &ArenaContractClient<'_>, round: u32) {
    env.as_contract(&client.address, || {
        let mut config = ArenaStorage::load_config(env).unwrap();
        config.round_count = round;
        ArenaStorage::save_config(env, &config);
    });
}

// ── #1580: leave_arena ──────────────────────────────────────────────────────

#[test]
fn leave_refunds_entry_fee_and_removes_player() {
    let (env, client, token_id) = setup();
    let player = Address::generate(&env);
    let other = Address::generate(&env);
    join(&env, &client, &token_id, &player);
    join(&env, &client, &token_id, &other);
    assert_eq!(client.player_count(), 2);

    client.leave_arena(&player);

    assert_eq!(client.player_count(), 1, "player_count must decrease");
    assert_eq!(
        TokenClient::new(&env, &token_id).balance(&player),
        100,
        "entry fee must be refunded"
    );
    let roster = client.get_players(&0);
    assert_eq!(roster.len(), 1);
    assert_eq!(roster.get(0).unwrap().0, other);
}

#[test]
fn leaving_player_can_rejoin() {
    let (env, client, token_id) = setup();
    let player = Address::generate(&env);
    join(&env, &client, &token_id, &player);
    client.leave_arena(&player);

    join(&env, &client, &token_id, &player);

    assert_eq!(client.player_count(), 1);
    assert_eq!(client.get_players(&0).len(), 1);
}

#[test]
fn leave_is_rejected_after_the_first_round() {
    let (env, client, token_id) = setup();
    let player = Address::generate(&env);
    join(&env, &client, &token_id, &player);
    set_round_count(&env, &client, 1);

    assert_eq!(
        client.try_leave_arena(&player),
        Err(Ok(ArenaError::ArenaAlreadyStarted))
    );
    assert_eq!(client.player_count(), 1);
}

#[test]
fn leave_is_rejected_for_non_players() {
    let (env, client, _token_id) = setup();
    let stranger = Address::generate(&env);

    assert_eq!(
        client.try_leave_arena(&stranger),
        Err(Ok(ArenaError::NotAPlayer))
    );
}

#[test]
fn leave_is_rejected_once_the_arena_is_active() {
    let (env, client, token_id) = setup();
    let player = Address::generate(&env);
    join(&env, &client, &token_id, &player);
    env.as_contract(&client.address, || {
        let mut config = ArenaStorage::load_config(&env).unwrap();
        config.state = GameState::Active;
        ArenaStorage::save_config(&env, &config);
    });

    assert_eq!(
        client.try_leave_arena(&player),
        Err(Ok(ArenaError::InvalidGameState))
    );
}

#[test]
fn last_player_can_leave_and_empties_the_roster() {
    let (env, client, token_id) = setup();
    let player = Address::generate(&env);
    join(&env, &client, &token_id, &player);

    client.leave_arena(&player);

    assert_eq!(client.player_count(), 0);
    assert_eq!(client.get_players(&0).len(), 0);
    assert_eq!(TokenClient::new(&env, &token_id).balance(&player), 100);
}

#[test]
fn removing_a_player_across_a_page_boundary_keeps_order() {
    let (env, client, token_id) = setup();
    env.as_contract(&client.address, || {
        ArenaStorage::save_player_limits(&env, 2, 100);
    });

    let mut players = soroban_sdk::Vec::new(&env);
    for _ in 0..60 {
        let player = Address::generate(&env);
        join(&env, &client, &token_id, &player);
        players.push_back(player);
    }
    let leaving = players.get(30).unwrap();

    client.leave_arena(&leaving);

    assert_eq!(client.player_count(), 59);
    let page0 = client.get_players(&0);
    let page1 = client.get_players(&1);
    assert_eq!(page0.len(), 50);
    assert_eq!(page1.len(), 9);
    for index in 0..players.len() {
        let player = players.get(index).unwrap();
        let listed = if index < 30 {
            page0.get(index).unwrap().0
        } else if index == 30 {
            continue;
        } else if index < 51 {
            page0.get(index - 1).unwrap().0
        } else {
            page1.get(index - 51).unwrap().0
        };
        assert_eq!(listed, player);
    }
}

// ── #1581: ban_player ───────────────────────────────────────────────────────

#[test]
fn banning_after_the_first_round_is_rejected() {
    let (env, client, token_id) = setup();
    let player = Address::generate(&env);
    join(&env, &client, &token_id, &player);
    set_round_count(&env, &client, 1);

    assert_eq!(
        client.try_ban_player(&player),
        Err(Ok(ArenaError::ArenaAlreadyStarted))
    );
    assert_eq!(client.player_count(), 1);
}

#[test]
fn banning_a_player_who_never_joined_only_blocks_future_joins() {
    let (env, client, token_id) = setup();
    let player = Address::generate(&env);
    client.ban_player(&player);

    StellarAssetClient::new(&env, &token_id).mint(&player, &100);
    assert_eq!(
        client.try_join_arena(&player),
        Err(Ok(ArenaError::PlayerBanned))
    );
    assert_eq!(client.player_count(), 0);
}

#[test]
fn banning_the_last_player_does_not_underflow_counts() {
    let (env, client, token_id) = setup();
    let player = Address::generate(&env);
    join(&env, &client, &token_id, &player);

    client.ban_player(&player);

    assert_eq!(client.player_count(), 0);
    assert_eq!(client.get_players(&0).len(), 0);
}

// ── #1577: canonical metadata hash golden vector ──────────────────────────

#[test]
fn metadata_hash_matches_shared_golden_vector() {
    let env = Env::default();
    let canonical = "{\"banner\":\"https://example.com/banner.png\",\"description\":\"Fast rounds\",\"name\":\"Alpha Arena\",\"rules\":\"Reveal before the deadline.\"}";
    let bytes = soroban_sdk::Bytes::from_slice(&env, canonical.as_bytes());
    let digest = env.crypto().sha256(&bytes).to_array();

    let expected: [u8; 32] = [
        0x05, 0xf1, 0xa2, 0x2d, 0x4e, 0x08, 0xe7, 0xe4, 0xcd, 0xde, 0x24, 0x23, 0xa6, 0xe5,
        0x9f, 0x34, 0x70, 0xfd, 0xdc, 0x27, 0x9e, 0x7d, 0xd3, 0x3f, 0x98, 0x97, 0x3a, 0x21,
        0xfc, 0x63, 0x85, 0xe7,
    ];
    assert_eq!(digest, expected);
}

// ── #1579: start deadline and permissionless cancellation ──────────────────

#[test]
fn join_is_rejected_after_the_start_deadline() {
    let (env, client, token_id) = setup();
    client.set_start_deadline(&1_000);

    env.ledger().with_mut(|ledger| ledger.timestamp = 1_000);
    let player = Address::generate(&env);
    StellarAssetClient::new(&env, &token_id).mint(&player, &100);

    assert_eq!(
        client.try_join_arena(&player),
        Err(Ok(ArenaError::StartDeadlinePassed))
    );
}

#[test]
fn join_is_allowed_before_the_start_deadline() {
    let (env, client, token_id) = setup();
    client.set_start_deadline(&1_000);
    env.ledger().with_mut(|ledger| ledger.timestamp = 999);

    let player = Address::generate(&env);
    join(&env, &client, &token_id, &player);
    assert_eq!(client.player_count(), 1);
}

#[test]
fn cancel_unstarted_is_rejected_before_the_deadline() {
    let (env, client, _token_id) = setup();
    client.set_start_deadline(&1_000);
    env.ledger().with_mut(|ledger| ledger.timestamp = 999);

    assert_eq!(
        client.try_cancel_unstarted(),
        Err(Ok(ArenaError::DeadlineTooSoon))
    );
}

#[test]
fn cancel_unstarted_is_rejected_without_a_deadline() {
    let (env, client, _token_id) = setup();

    assert_eq!(
        client.try_cancel_unstarted(),
        Err(Ok(ArenaError::NoStartDeadline))
    );
}

#[test]
fn cancel_unstarted_after_the_deadline_enables_refunds() {
    let (env, client, token_id) = setup();
    let player = Address::generate(&env);
    join(&env, &client, &token_id, &player);
    client.set_start_deadline(&1_000);

    env.ledger().with_mut(|ledger| ledger.timestamp = 1_000);
    client.cancel_unstarted();

    assert_eq!(client.get_players(&0).len(), 1, "roster is preserved for refunds");
    client.claim_refund(&player);
    assert_eq!(TokenClient::new(&env, &token_id).balance(&player), 100);
}

#[test]
fn cancel_unstarted_is_rejected_after_the_first_round() {
    let (env, client, _token_id) = setup();
    client.set_start_deadline(&1_000);
    set_round_count(&env, &client, 1);
    env.ledger().with_mut(|ledger| ledger.timestamp = 1_001);

    assert_eq!(
        client.try_cancel_unstarted(),
        Err(Ok(ArenaError::ArenaAlreadyStarted))
    );
}
