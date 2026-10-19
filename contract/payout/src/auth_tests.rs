//! Exact-authorization tests for every `require_auth` site in the payout
//! contract (#1636). See `contract/test-support/auth.rs` for what these
//! catch that `mock_all_auths` cannot.

#![cfg(test)]

#[path = "../../test-support/auth.rs"]
mod auth;

use crate::test_support::{MockArena, MockArenaClient, MockFactory, MockFactoryClient};
use crate::types::ArenaSettlement;
use crate::{CAP_TIMELOCK_SECONDS, PayoutContract, PayoutContractClient};
use auth::{Call, assert_exact_auth, assert_rejects_signer, call, mint, new_token, sign};
use soroban_sdk::{
    Address, Env, IntoVal, Val, Vec,
    testutils::{Address as _, Ledger as _},
};

const CAP: i128 = 10_000;

struct Fx {
    env: Env,
    id: Address,
    client: PayoutContractClient<'static>,
    admin: Address,
    token: Address,
    factory: Address,
    intruder: Address,
}

impl Fx {
    fn tree(&self, fn_name: &'static str, args: impl IntoVal<Env, Vec<Val>>) -> Call {
        call(&self.env, &self.id, fn_name, args)
    }

    fn assert_admin_only(&self, tree: Call, invoke: impl Fn() -> bool) {
        assert_rejects_signer(&self.env, &self.intruder, &tree, &invoke);
        assert_exact_auth(&self.env, &self.admin, &tree, &invoke);
    }

    /// A genuine finished arena won by `winner`, registered as pool `pool_id`.
    fn arena_won_by(&self, winner: &Address, pool_id: u32) -> Address {
        let arena = self.env.register(MockArena, ());
        MockArenaClient::new(&self.env, &arena).set_settlement(&ArenaSettlement {
            finished: true,
            winner: Some(winner.clone()),
            prize: 1_000,
            stake_token: self.token.clone(),
            pool_id,
        });
        MockFactoryClient::new(&self.env, &self.factory).register(&pool_id, &arena);
        arena
    }
}

fn fixture() -> Fx {
    let env = Env::default();
    let id = env.register(PayoutContract, ());
    let client = PayoutContractClient::new(&env, &id);
    let admin = Address::generate(&env);
    let (token, token_admin) = new_token(&env);
    let factory = env.register(MockFactory, ());
    let args = (admin.clone(), token.clone(), factory.clone(), CAP);
    sign(&env, &admin, &call(&env, &id, "initialize", args));
    client.initialize(&admin, &token, &factory, &CAP);
    mint(&env, &token, &token_admin, &id, 5_000);
    Fx { intruder: Address::generate(&env), env, id, client, admin, token, factory }
}

#[test]
fn initialize_requires_exactly_the_admin() {
    let env = Env::default();
    let id = env.register(PayoutContract, ());
    let client = PayoutContractClient::new(&env, &id);
    let admin = Address::generate(&env);
    let (token, factory) = (Address::generate(&env), Address::generate(&env));
    let tree = call(&env, &id, "initialize", (admin.clone(), token.clone(), factory.clone(), CAP));
    let invoke = || client.try_initialize(&admin, &token, &factory, &CAP).is_ok();
    assert_rejects_signer(&env, &Address::generate(&env), &tree, invoke);
    assert_exact_auth(&env, &admin, &tree, invoke);
}

#[test]
fn upgrade_requires_exactly_the_admin() {
    let fx = fixture();
    let hash = fx.env.deployer().upload_contract_wasm(PAYOUT_WASM);
    fx.assert_admin_only(fx.tree("upgrade", (hash.clone(),)), || {
        fx.client.try_upgrade(&hash).is_ok()
    });
}

#[test]
fn distribute_winnings_requires_exactly_the_admin_and_nothing_from_the_winner() {
    let fx = fixture();
    let winner = Address::generate(&fx.env);
    let arena = fx.arena_won_by(&winner, 1);
    let tree = fx.tree("distribute_winnings", (arena.clone(), winner.clone(), 600i128));
    let invoke = || fx.client.try_distribute_winnings(&arena, &winner, &600).is_ok();
    // The winner cannot pay themselves; only the payout admin can.
    assert_rejects_signer(&fx.env, &winner, &tree, invoke);
    // The arena and factory reads, and the transfer out of the contract's own
    // balance, need no further authorization.
    fx.assert_admin_only(tree.clone(), invoke);
}

#[test]
fn distribute_batch_requires_exactly_the_admin() {
    let fx = fixture();
    let (a, b) = (Address::generate(&fx.env), Address::generate(&fx.env));
    let mut batch = Vec::new(&fx.env);
    batch.push_back((fx.arena_won_by(&a, 1), a.clone(), 100i128));
    batch.push_back((fx.arena_won_by(&b, 2), b.clone(), 200i128));
    fx.assert_admin_only(fx.tree("distribute_batch", (batch.clone(),)), || {
        fx.client.try_distribute_batch(&batch).is_ok()
    });
}

#[test]
fn daily_cap_changes_require_exactly_the_admin() {
    let fx = fixture();
    fx.assert_admin_only(fx.tree("propose_daily_cap", (CAP * 2,)), || {
        fx.client.try_propose_daily_cap(&(CAP * 2)).is_ok()
    });
    fx.env.ledger().with_mut(|li| li.timestamp += CAP_TIMELOCK_SECONDS);
    fx.assert_admin_only(fx.tree("apply_daily_cap", ()), || {
        fx.client.try_apply_daily_cap().is_ok()
    });

    sign(&fx.env, &fx.admin, &fx.tree("propose_daily_cap", (CAP * 3,)));
    fx.client.propose_daily_cap(&(CAP * 3));
    fx.assert_admin_only(fx.tree("cancel_daily_cap", ()), || {
        fx.client.try_cancel_daily_cap().is_ok()
    });
}

#[test]
fn propose_admin_requires_exactly_the_admin() {
    let fx = fixture();
    let next = Address::generate(&fx.env);
    fx.assert_admin_only(fx.tree("propose_admin", (next.clone(),)), || {
        fx.client.try_propose_admin(&next).is_ok()
    });
}

#[test]
fn accept_admin_requires_exactly_the_proposed_admin() {
    let fx = fixture();
    let next = Address::generate(&fx.env);
    sign(&fx.env, &fx.admin, &fx.tree("propose_admin", (next.clone(),)));
    fx.client.propose_admin(&next);
    let tree = fx.tree("accept_admin", ());
    let invoke = || fx.client.try_accept_admin().is_ok();
    assert_rejects_signer(&fx.env, &fx.admin, &tree, invoke);
    assert_exact_auth(&fx.env, &next, &tree, invoke);
}

const PAYOUT_WASM: &[u8] = include_bytes!("../../target/wasm32v1-none/release/payout.wasm");
