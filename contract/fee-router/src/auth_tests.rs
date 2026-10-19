//! Exact-authorization tests for every `require_auth` site in the fee router
//! (#1636), plus the cross-contract path into the real staking contract. See
//! `contract/test-support/auth.rs` for what these catch that
//! `mock_all_auths` cannot.

#![cfg(test)]

#[path = "../../test-support/auth.rs"]
mod auth;

use crate::types::{MIN_FLUSH_AMOUNT, STAKING_SHARE_TIMELOCK_SECS};
use crate::{FeeRouterContract, FeeRouterContractClient};
use auth::{Call, assert_exact_auth, assert_rejects_signer, call, mint, new_token, sign};
use soroban_sdk::{
    Address, Env, IntoVal, Val, Vec,
    testutils::{Address as _, Ledger as _},
};
use staking::{StakingContract, StakingContractClient};

struct Fx {
    env: Env,
    id: Address,
    client: FeeRouterContractClient<'static>,
    admin: Address,
    token: Address,
    token_admin: Address,
    staking: Address,
    treasury: Address,
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

    fn receive_tree(&self, sender: &Address, amount: i128) -> Call {
        self.tree("receive_fees", (sender.clone(), self.token.clone(), amount)).with(call(
            &self.env,
            &self.token,
            "transfer",
            (sender.clone(), self.id.clone(), amount),
        ))
    }
}

/// A router splitting 50/50 between a real staking contract (with one
/// staker, so it accepts rewards) and a treasury.
fn fixture() -> Fx {
    let env = Env::default();
    let (token, token_admin) = new_token(&env);
    let admin = Address::generate(&env);

    let staking = env.register(StakingContract, ());
    let staking_client = StakingContractClient::new(&env, &staking);
    sign(&env, &admin, &call(&env, &staking, "initialize", (admin.clone(), token.clone())));
    staking_client.initialize(&admin, &token);
    let staker = Address::generate(&env);
    let stake = staking_client.min_initial_stake();
    mint(&env, &token, &token_admin, &staker, stake);
    sign(
        &env,
        &staker,
        &call(&env, &staking, "stake", (staker.clone(), stake))
            .with(call(&env, &token, "transfer", (staker.clone(), staking.clone(), stake))),
    );
    staking_client.stake(&staker, &stake);

    let id = env.register(FeeRouterContract, ());
    let client = FeeRouterContractClient::new(&env, &id);
    let treasury = Address::generate(&env);
    let args = (admin.clone(), staking.clone(), treasury.clone(), 5_000u32);
    sign(&env, &admin, &call(&env, &id, "initialize", args));
    client.initialize(&admin, &staking, &treasury, &5_000);

    Fx {
        intruder: Address::generate(&env),
        env,
        id,
        client,
        admin,
        token,
        token_admin,
        staking,
        treasury,
    }
}

#[test]
fn initialize_requires_exactly_the_admin() {
    let env = Env::default();
    let id = env.register(FeeRouterContract, ());
    let client = FeeRouterContractClient::new(&env, &id);
    let admin = Address::generate(&env);
    let (staking, treasury) = (Address::generate(&env), Address::generate(&env));
    let tree = call(&env, &id, "initialize", (admin.clone(), staking.clone(), treasury.clone(), 0u32));
    let invoke = || client.try_initialize(&admin, &staking, &treasury, &0).is_ok();
    assert_rejects_signer(&env, &Address::generate(&env), &tree, invoke);
    assert_exact_auth(&env, &admin, &tree, invoke);
}

#[test]
fn receive_fees_requires_the_sender_for_the_call_and_their_transfer_only() {
    let fx = fixture();
    let sender = Address::generate(&fx.env);
    mint(&fx.env, &fx.token, &fx.token_admin, &sender, 1_000);
    let tree = fx.receive_tree(&sender, 1_000);
    let invoke = || fx.client.try_receive_fees(&sender, &fx.token, &1_000).is_ok();
    assert_rejects_signer(&fx.env, &fx.intruder, &tree, invoke);
    assert_exact_auth(&fx.env, &sender, &tree, invoke);
}

/// `flush` is permissionless: nobody signs, yet the router must still be
/// able to pay the real staking contract, which pulls the rewards with a
/// `transfer` from the router. Before #1636 this only worked under
/// `mock_all_auths` and failed for real.
#[test]
fn flush_needs_no_signature_and_router_authorises_the_staking_pull() {
    let fx = fixture();
    let sender = Address::generate(&fx.env);
    let amount = MIN_FLUSH_AMOUNT * 2;
    mint(&fx.env, &fx.token, &fx.token_admin, &sender, amount);
    sign(&fx.env, &sender, &fx.receive_tree(&sender, amount));
    fx.client.receive_fees(&sender, &fx.token, &amount);

    let token = soroban_sdk::token::TokenClient::new(&fx.env, &fx.token);
    let staking_before = token.balance(&fx.staking);
    fx.env.set_auths(&[]);
    fx.client.flush(&fx.token);
    assert!(fx.env.auths().is_empty(), "flush must not require any signature");
    assert_eq!(token.balance(&fx.staking) - staking_before, amount / 2);
    assert_eq!(token.balance(&fx.treasury), amount / 2);
}

#[test]
fn staking_share_governance_requires_exactly_the_admin() {
    let fx = fixture();
    fx.assert_admin_only(fx.tree("propose_staking_share", (2_500u32,)), || {
        fx.client.try_propose_staking_share(&2_500).is_ok()
    });
    fx.assert_admin_only(fx.tree("cancel_staking_share", ()), || {
        fx.client.try_cancel_staking_share().is_ok()
    });

    // Committing after the timelock is deliberately permissionless.
    sign(&fx.env, &fx.admin, &fx.tree("propose_staking_share", (2_500u32,)));
    fx.client.propose_staking_share(&2_500);
    fx.env.ledger().with_mut(|li| li.timestamp += STAKING_SHARE_TIMELOCK_SECS);
    fx.env.set_auths(&[]);
    fx.client.commit_staking_share();
    assert!(fx.env.auths().is_empty());
    assert_eq!(fx.client.staking_share_bps(), 2_500);
}

#[test]
fn set_treasury_requires_exactly_the_admin() {
    let fx = fixture();
    let treasury = Address::generate(&fx.env);
    fx.assert_admin_only(fx.tree("set_treasury", (treasury.clone(),)), || {
        fx.client.try_set_treasury(&treasury).is_ok()
    });
}

#[test]
fn set_staking_contract_requires_exactly_the_admin() {
    let fx = fixture();
    let staking = Address::generate(&fx.env);
    fx.assert_admin_only(fx.tree("set_staking_contract", (staking.clone(),)), || {
        fx.client.try_set_staking_contract(&staking).is_ok()
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
