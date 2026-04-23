//! Mutation-guard tests for issue #516.
//!
//! Each test verifies that a critical safety guard is exercised by the test
//! suite — i.e., that removing or weakening the guard would cause this test
//! to fail. The tests are written so that a mutation tool (cargo-mutants) can
//! automatically confirm the test suite kills each listed mutation.
//!
//! Critical mutations covered:
//!  1. Remove `admin.require_auth()` from `pause()` → auth test fails
//!  2. Remove `require_not_paused!` from `join()` → pause-blocks-join test fails
//!  3. Change `<=` to `<` in round-deadline check → boundary test fails
//!  4. Remove already-initialized guard from `initialize()` → double-init test fails
//!  5. Change minority-survives to majority-survives in `resolve_round()` → outcome test fails
//!  6. Remove double-payout guard from `distribute_winnings()` → idempotency test fails
//!  7. Change `==` to `>=` in exact-entry-fee check → wrong-amount test fails

#![cfg(test)]

extern crate std;

use super::*;
use soroban_sdk::{
    Address, Env, IntoVal,
    testutils::{Address as _, Ledger as _, LedgerInfo},
    token::StellarAssetClient,
};

// ── helpers ───────────────────────────────────────────────────────────────────

fn make_env() -> (Env, ArenaContractClient<'static>) {
    let env = Env::default();
    env.mock_all_auths();
    let contract_id = env.register(ArenaContract, ());
    let env_static: &'static Env = unsafe { &*(&env as *const Env) };
    let client = ArenaContractClient::new(env_static, &contract_id);
    (env, client)
}

fn setup_initialized() -> (Env, Address, ArenaContractClient<'static>) {
    let (env, client) = make_env();
    let admin = Address::generate(&env);
    client.initialize(&admin);
    (env, admin, client)
}

fn setup_game(
    player_count: u32,
    round_speed: u32,
) -> (Env, Address, ArenaContractClient<'static>, Address, std::vec::Vec<Address>) {
    let (env, admin, client) = setup_initialized();

    let token_admin = Address::generate(&env);
    let token_id = env.register_stellar_asset_contract_v2(token_admin.clone()).address();
    let sac = StellarAssetClient::new(&env, &token_id);

    let deadline = env.ledger().timestamp() + 7200;
    client.init(&round_speed, &100, &deadline);
    client.set_token(&token_id);
    client.set_capacity(&(player_count + 2));

    let mut players = std::vec![];
    for _ in 0..player_count {
        let p = Address::generate(&env);
        sac.mint(&p, &100);
        client.join(&p, &100);
        players.push(p);
    }

    (env, admin, client, token_id, players)
}

// ── Mutation 1: admin.require_auth() in pause() ───────────────────────────────
//
// If `admin.require_auth()` is removed from `pause()`, any caller could pause
// the contract. This test verifies that non-admin callers cannot pause.

#[test]
fn mutation1_pause_requires_admin_auth() {
    let env = Env::default();
    let contract_id = env.register(ArenaContract, ());
    let admin = Address::generate(&env);

    // Authorize only initialize, not pause.
    env.mock_auths(&[soroban_sdk::testutils::MockAuth {
        address: &admin,
        invoke: &soroban_sdk::testutils::MockAuthInvoke {
            contract: &contract_id,
            fn_name: "initialize",
            args: soroban_sdk::vec![&env, admin.clone().into_val(&env)].into(),
            sub_invokes: &[],
        },
    }]);
    let client = ArenaContractClient::new(&env, &contract_id);
    client.initialize(&admin);

    // No auth for pause — must be rejected.
    let result = client.try_pause();
    assert!(
        result.is_err(),
        "pause() must reject caller without admin auth; removing require_auth would make this pass"
    );
}

// ── Mutation 2: require_not_paused! in join() ─────────────────────────────────
//
// If the pause guard is removed from `join()`, players can join even when the
// contract is paused. This test verifies the guard is effective.

#[test]
fn mutation2_join_blocked_when_paused() {
    let (env, _admin, client) = setup_initialized();

    let token_admin = Address::generate(&env);
    let token_id = env.register_stellar_asset_contract_v2(token_admin.clone()).address();
    StellarAssetClient::new(&env, &token_id).mint(&Address::generate(&env), &100);

    let deadline = env.ledger().timestamp() + 7200;
    client.init(&5, &100, &deadline);
    client.set_token(&token_id);
    client.pause();

    let player = Address::generate(&env);
    StellarAssetClient::new(&env, &token_id).mint(&player, &100);

    let result = client.try_join(&player, &100);
    assert_eq!(
        result,
        Err(Ok(ArenaError::Paused)),
        "join() must return Paused when contract is paused; removing the guard would return Ok"
    );
}

// ── Mutation 3: <= vs < in round-deadline check ───────────────────────────────
//
// The guard `env.ledger().sequence() <= round_deadline_ledger` protects against
// early resolution. If changed to `<`, the round could be resolved exactly at
// the deadline ledger (off-by-one). This test verifies the boundary.

#[test]
fn mutation3_round_deadline_boundary_enforced() {
    let (env, _admin, client, _token_id, players) = setup_game(2, 5);

    client.start_round();
    let round = client.get_round();
    let deadline = round.round_deadline_ledger;

    // At exactly the deadline ledger, round is still open — resolve must fail.
    env.ledger().with_mut(|l: &mut LedgerInfo| {
        l.sequence_number = deadline;
    });

    let result = client.try_resolve_round();
    assert_eq!(
        result,
        Err(Ok(ArenaError::RoundStillOpen)),
        "resolve_round() must be blocked at sequence == deadline; changing <= to < would allow it"
    );

    // One ledger past the deadline — resolve must succeed.
    env.ledger().with_mut(|l: &mut LedgerInfo| {
        l.sequence_number = deadline + 1;
    });
    // This will either succeed or return a non-deadline error (e.g., no submissions = tie resolved).
    let result2 = client.try_resolve_round();
    assert_ne!(
        result2,
        Err(Ok(ArenaError::RoundStillOpen)),
        "resolve_round() must proceed after the deadline passes"
    );
    let _ = players;
}

// ── Mutation 4: already-initialized guard in initialize() ────────────────────
//
// If the double-init guard is removed, a second `initialize()` call would
// overwrite the admin, allowing admin hijacking.

#[test]
fn mutation4_double_initialize_panics() {
    let (env, _admin, client) = setup_initialized();
    let attacker = Address::generate(&env);

    // Second initialize must panic with "already initialized".
    let result = client.try_initialize(&attacker);
    assert!(
        result.is_err(),
        "second initialize() must fail; removing the guard would allow admin hijacking"
    );
}

// ── Mutation 5: minority-survives logic in resolve_round() ───────────────────
//
// The game rule: the *minority* choice survives. If changed to majority-survives,
// this test (3 heads vs 1 tail → tail should survive) would fail because the
// wrong side would be eliminated.

#[test]
fn mutation5_minority_survives_not_majority() {
    // 3 players pick Heads, 1 picks Tails. Minority = Tails → tails player survives.
    let (env, _admin, client, token_id, players) = setup_game(4, 5);

    client.start_round();
    let round = client.get_round();

    // players[0..2] pick Heads (majority), players[3] picks Tails (minority).
    client.submit_choice(&players[0], &round.round_number, &Choice::Heads);
    client.submit_choice(&players[1], &round.round_number, &Choice::Heads);
    client.submit_choice(&players[2], &round.round_number, &Choice::Heads);
    client.submit_choice(&players[3], &round.round_number, &Choice::Tails);

    // Advance past the deadline so resolve_round() is allowed.
    env.ledger().with_mut(|l: &mut LedgerInfo| {
        l.sequence_number = round.round_deadline_ledger + 1;
    });

    client.resolve_round();

    // The 3 majority-Heads players must be eliminated; Tails minority survives.
    assert!(
        !client.get_user_state(&players[0]).is_active,
        "majority Heads player[0] must be eliminated"
    );
    assert!(
        !client.get_user_state(&players[1]).is_active,
        "majority Heads player[1] must be eliminated"
    );
    assert!(
        !client.get_user_state(&players[2]).is_active,
        "majority Heads player[2] must be eliminated"
    );
    assert!(
        client.get_user_state(&players[3]).is_active,
        "minority Tails player must survive; changing to majority-survives would flip this"
    );
    let _ = token_id;
}

// ── Mutation 6: double-join guard / idempotency guard ────────────────────────
//
// The arena's `join()` guards against the same player joining twice
// (`AlreadyJoined`). Removing this guard would allow a player to inflate their
// stake weight by joining multiple times.
//
// The equivalent guard in `payout/distribute_winnings` (AlreadyPaid composite
// key) is tested in contract/payout/src/test.rs::test_idempotency_prevents_double_pay_same_key.

#[test]
fn mutation6_double_join_idempotency_guard() {
    let (env, _admin, client) = setup_initialized();

    let token_admin = Address::generate(&env);
    let token_id = env.register_stellar_asset_contract_v2(token_admin.clone()).address();
    let sac = StellarAssetClient::new(&env, &token_id);

    let deadline = env.ledger().timestamp() + 7200;
    client.init(&5, &100, &deadline);
    client.set_token(&token_id);

    let player = Address::generate(&env);
    sac.mint(&player, &1_000);

    // First join must succeed.
    assert!(client.try_join(&player, &100).is_ok());

    // Second join with the same player must fail.
    let result = client.try_join(&player, &100);
    assert_eq!(
        result,
        Err(Ok(ArenaError::AlreadyJoined)),
        "second join() for same player must fail; removing the guard would allow stake inflation"
    );
}

// ── Mutation 7: exact entry-fee check in join() ───────────────────────────────
//
// Players must join with exactly the `required_stake_amount`. If the check
// were changed from `!=` to `<` (or `>=`), players could over- or under-pay.

#[test]
fn mutation7_exact_entry_fee_enforced() {
    let (env, _admin, client) = setup_initialized();

    let token_admin = Address::generate(&env);
    let token_id = env.register_stellar_asset_contract_v2(token_admin.clone()).address();
    let sac = StellarAssetClient::new(&env, &token_id);

    let required = 100i128;
    let deadline = env.ledger().timestamp() + 7200;
    client.init(&5, &required, &deadline);
    client.set_token(&token_id);

    let player = Address::generate(&env);
    sac.mint(&player, &500);

    // Under-payment must be rejected.
    let result_under = client.try_join(&player, &(required - 1));
    assert_eq!(
        result_under,
        Err(Ok(ArenaError::InvalidAmount)),
        "join() must reject under-payment; changing == to >= would allow it"
    );

    // Over-payment must also be rejected.
    let result_over = client.try_join(&player, &(required + 1));
    assert_eq!(
        result_over,
        Err(Ok(ArenaError::InvalidAmount)),
        "join() must reject over-payment; changing == to <= would allow it"
    );

    // Exact amount must be accepted.
    assert!(
        client.try_join(&player, &required).is_ok(),
        "exact amount must be accepted"
    );
}
