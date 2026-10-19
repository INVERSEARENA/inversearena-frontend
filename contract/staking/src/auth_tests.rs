//! Exact-authorization tests for every `require_auth` site in the staking
//! contract (#1636). See `contract/test-support/auth.rs` for what these catch
//! that `mock_all_auths` cannot.

#![cfg(test)]

#[path = "../../test-support/auth.rs"]
mod auth;

use crate::{StakingContract, StakingContractClient};
use auth::{
    Call, assert_exact_auth, assert_exact_auths, assert_rejects_signer, call, mint, new_token,
    sign, sign_all,
};
use soroban_sdk::{Address, Env, IntoVal, Val, Vec, testutils::Address as _};

const STAKE: i128 = 1_000;

struct Fx {
    env: Env,
    id: Address,
    client: StakingContractClient<'static>,
    admin: Address,
    token: Address,
    token_admin: Address,
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

    /// `who` authorises `fn_name(who, amount)` and the pull of `amount` of
    /// their own tokens into the staking contract.
    fn pull_tree(&self, fn_name: &'static str, who: &Address, amount: i128) -> Call {
        self.tree(fn_name, (who.clone(), amount)).with(call(
            &self.env,
            &self.token,
            "transfer",
            (who.clone(), self.id.clone(), amount),
        ))
    }

    fn staker(&self) -> Address {
        let staker = Address::generate(&self.env);
        mint(&self.env, &self.token, &self.token_admin, &staker, STAKE);
        sign(&self.env, &staker, &self.pull_tree("stake", &staker, STAKE));
        self.client.stake(&staker, &STAKE);
        staker
    }
}

fn fixture() -> Fx {
    let env = Env::default();
    let id = env.register(StakingContract, ());
    let client = StakingContractClient::new(&env, &id);
    let admin = Address::generate(&env);
    let (token, token_admin) = new_token(&env);
    sign(&env, &admin, &call(&env, &id, "initialize", (admin.clone(), token.clone())));
    client.initialize(&admin, &token);
    Fx { intruder: Address::generate(&env), env, id, client, admin, token, token_admin }
}

#[test]
fn initialize_requires_exactly_the_admin() {
    let env = Env::default();
    let id = env.register(StakingContract, ());
    let client = StakingContractClient::new(&env, &id);
    let admin = Address::generate(&env);
    let token = Address::generate(&env);
    let tree = call(&env, &id, "initialize", (admin.clone(), token.clone()));
    let invoke = || client.try_initialize(&admin, &token).is_ok();
    assert_rejects_signer(&env, &Address::generate(&env), &tree, invoke);
    assert_exact_auth(&env, &admin, &tree, invoke);
}

#[test]
fn stake_requires_the_staker_for_the_call_and_their_transfer_only() {
    let fx = fixture();
    let staker = Address::generate(&fx.env);
    mint(&fx.env, &fx.token, &fx.token_admin, &staker, STAKE);
    let tree = fx.pull_tree("stake", &staker, STAKE);
    let invoke = || fx.client.try_stake(&staker, &STAKE).is_ok();
    assert_rejects_signer(&fx.env, &fx.intruder, &tree, invoke);
    assert_exact_auth(&fx.env, &staker, &tree, invoke);
}

#[test]
fn unstake_requires_exactly_the_staker() {
    let fx = fixture();
    let staker = fx.staker();
    let other = fx.staker();
    let shares = fx.client.get_shares(&staker);
    let tree = fx.tree("unstake", (staker.clone(), shares));
    let invoke = || fx.client.try_unstake(&staker, &shares).is_ok();
    // Another staker cannot withdraw someone else's position.
    assert_rejects_signer(&fx.env, &other, &tree, invoke);
    assert_exact_auth(&fx.env, &staker, &tree, invoke);
}

#[test]
fn distribute_rewards_requires_the_caller_for_the_call_and_their_transfer_only() {
    let fx = fixture();
    fx.staker();
    let funder = Address::generate(&fx.env);
    mint(&fx.env, &fx.token, &fx.token_admin, &funder, 500);
    let tree = fx.pull_tree("distribute_rewards", &funder, 500);
    let invoke = || fx.client.try_distribute_rewards(&funder, &500).is_ok();
    assert_rejects_signer(&fx.env, &fx.intruder, &tree, invoke);
    assert_exact_auth(&fx.env, &funder, &tree, invoke);
}

#[test]
fn pause_and_unpause_require_exactly_the_admin() {
    let fx = fixture();
    fx.assert_admin_only(fx.tree("pause", ()), || fx.client.try_pause().is_ok());
    fx.assert_admin_only(fx.tree("unpause", ()), || fx.client.try_unpause().is_ok());
}

#[test]
fn set_reward_duration_requires_exactly_the_admin() {
    let fx = fixture();
    fx.assert_admin_only(fx.tree("set_reward_duration", (3_600u64,)), || {
        fx.client.try_set_reward_duration(&3_600).is_ok()
    });
}

#[test]
fn upgrade_requires_exactly_the_admin() {
    let fx = fixture();
    let hash = fx.env.deployer().upload_contract_wasm(STAKING_WASM);
    fx.assert_admin_only(fx.tree("upgrade", (hash.clone(),)), || {
        fx.client.try_upgrade(&hash).is_ok()
    });
}

#[test]
fn renew_storage_requires_exactly_the_admin() {
    let fx = fixture();
    fx.assert_admin_only(fx.tree("renew_storage", ()), || fx.client.try_renew_storage().is_ok());
}

#[test]
fn propose_admin_requires_exactly_the_admin() {
    let fx = fixture();
    let next = Address::generate(&fx.env);
    fx.assert_admin_only(fx.tree("propose_admin", (next.clone(),)), || {
        fx.client.try_propose_admin(&next).is_ok()
    });
}

/// Staking's `accept_admin` checks both the nominee and the outgoing admin
/// (`require_admin`), so a transfer completes only with both signatures.
#[test]
fn accept_admin_requires_both_the_proposed_and_the_current_admin() {
    let fx = fixture();
    let next = Address::generate(&fx.env);
    sign(&fx.env, &fx.admin, &fx.tree("propose_admin", (next.clone(),)));
    fx.client.propose_admin(&next);
    let tree = fx.tree("accept_admin", ());
    let invoke = || fx.client.try_accept_admin().is_ok();

    assert_rejects_signer(&fx.env, &next, &tree, invoke);
    assert_rejects_signer(&fx.env, &fx.admin, &tree, invoke);
    sign_all(&fx.env, &[(&next, &tree), (&fx.intruder, &tree)]);
    assert!(!invoke(), "the nominee plus a stranger must not suffice");

    assert_exact_auths(&fx.env, &[(&next, &tree), (&fx.admin, &tree)], invoke);
    assert_eq!(fx.client.admin(), next);
}

const STAKING_WASM: &[u8] = include_bytes!("../../target/wasm32v1-none/release/staking.wasm");
