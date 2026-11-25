#![cfg(test)]

#[path = "../../test-support/fixtures.rs"]
mod fixtures;

use fixtures::{ArenaFixture, PayoutFixture, MAX_ARENA_PLAYERS};
use soroban_sdk::Env;

#[test]
fn valid_arena_and_payout_fixtures_pass_validation() {
    let env = Env::default();
    let arena = ArenaFixture::valid(&env);
    assert!(arena.validate().is_ok());

    let boundary = ArenaFixture::valid(&env).with_max_players_boundary();
    assert_eq!(boundary.max_players, MAX_ARENA_PLAYERS);
    assert!(boundary.validate().is_ok());

    let payout = PayoutFixture::valid(&env, "payout-1");
    assert!(payout.validate().is_ok());
}

#[test]
fn explicit_invalid_state_helpers_fail_validation() {
    let env = Env::default();
    assert!(ArenaFixture::valid(&env).with_zero_entry_fee().validate().is_err());
    assert!(ArenaFixture::valid(&env).with_zero_max_players().validate().is_err());
    assert!(PayoutFixture::valid(&env, "payout-1").with_zero_amount().validate().is_err());

    let dup = PayoutFixture::valid(&env, "payout-1").with_duplicate_id(&env, "payout-1");
    assert_eq!(dup.payout_id, PayoutFixture::valid(&env, "payout-1").payout_id);
}
