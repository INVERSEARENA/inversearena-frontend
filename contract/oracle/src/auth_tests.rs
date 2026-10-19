//! Exact-authorization tests for every `require_auth` site in the oracle
//! (#1636). See `contract/test-support/auth.rs` for what these catch that
//! `mock_all_auths` cannot.

#![cfg(test)]

#[path = "../../test-support/auth.rs"]
mod auth;

use crate::{OracleContract, OracleContractClient};
use auth::{Call, assert_exact_auth, assert_rejects_signer, call, sign};
use soroban_sdk::{Address, Env, IntoVal, Val, Vec, testutils::Address as _};

struct Fx {
    env: Env,
    id: Address,
    client: OracleContractClient<'static>,
    admin: Address,
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
}

fn fixture() -> Fx {
    let env = Env::default();
    let id = env.register(OracleContract, ());
    let client = OracleContractClient::new(&env, &id);
    let admin = Address::generate(&env);
    sign(&env, &admin, &call(&env, &id, "initialize", (admin.clone(), 100u32)));
    client.initialize(&admin, &100);
    Fx { intruder: Address::generate(&env), env, id, client, admin }
}

#[test]
fn initialize_requires_exactly_the_admin() {
    let env = Env::default();
    let id = env.register(OracleContract, ());
    let client = OracleContractClient::new(&env, &id);
    let admin = Address::generate(&env);
    let tree = call(&env, &id, "initialize", (admin.clone(), 100u32));
    let invoke = || client.try_initialize(&admin, &100).is_ok();
    assert_rejects_signer(&env, &Address::generate(&env), &tree, invoke);
    assert_exact_auth(&env, &admin, &tree, invoke);
}

#[test]
fn set_yield_bps_requires_exactly_the_admin() {
    let fx = fixture();
    fx.assert_admin_only(fx.tree("set_yield_bps", (150u32,)), || {
        fx.client.try_set_yield_bps(&150).is_ok()
    });
}

#[test]
fn set_rate_to_zero_requires_exactly_the_admin() {
    let fx = fixture();
    fx.assert_admin_only(fx.tree("set_rate_to_zero", ()), || {
        fx.client.try_set_rate_to_zero().is_ok()
    });
}

#[test]
fn set_max_delta_bps_requires_exactly_the_admin() {
    let fx = fixture();
    fx.assert_admin_only(fx.tree("set_max_delta_bps", (200u32,)), || {
        fx.client.try_set_max_delta_bps(&200).is_ok()
    });
}

#[test]
fn set_activation_delay_requires_exactly_the_admin() {
    let fx = fixture();
    fx.assert_admin_only(fx.tree("set_activation_delay", (60u64,)), || {
        fx.client.try_set_activation_delay(&60).is_ok()
    });
}

#[test]
fn set_max_rate_requires_exactly_the_admin() {
    let fx = fixture();
    fx.assert_admin_only(fx.tree("set_max_rate", (1_000u32,)), || {
        fx.client.try_set_max_rate(&1_000).is_ok()
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

#[test]
fn upgrade_requires_exactly_the_admin() {
    let fx = fixture();
    let hash = fx.env.deployer().upload_contract_wasm(ORACLE_WASM);
    fx.assert_admin_only(fx.tree("upgrade", (hash.clone(),)), || {
        fx.client.try_upgrade(&hash).is_ok()
    });
}

const ORACLE_WASM: &[u8] = include_bytes!("../../target/wasm32v1-none/release/oracle.wasm");
