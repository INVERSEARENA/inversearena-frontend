//! Exact-authorization tests for every `require_auth` site in the RWA adapter
//! (#1636). See `contract/test-support/auth.rs` for what these catch that
//! `mock_all_auths` cannot.

#![cfg(test)]

#[path = "../../test-support/auth.rs"]
mod auth;

use crate::storage::RwaStorage;
use crate::types::{PendingAdmin, YieldAccrual};
use crate::{RwaAdapter, RwaAdapterClient};
use auth::{assert_exact_auth, assert_rejects_signer, call, mint, new_token};
use soroban_sdk::{Address, Env, contract, contractimpl, testutils::Address as _};

#[contract]
struct FixedOracle;

#[contractimpl]
impl FixedOracle {
    pub fn get_current_yield_bps(_env: Env) -> u32 {
        0
    }
}

struct Fx {
    env: Env,
    id: Address,
    client: RwaAdapterClient<'static>,
    admin: Address,
    token: Address,
    token_admin: Address,
    oracle: Address,
    intruder: Address,
}

/// An uninitialised adapter plus the addresses its tests need.
fn fresh() -> Fx {
    let env = Env::default();
    let id = env.register(RwaAdapter, ());
    let client = RwaAdapterClient::new(&env, &id);
    let (token, token_admin) = new_token(&env);
    let oracle = env.register(FixedOracle, ());
    Fx {
        admin: Address::generate(&env),
        intruder: Address::generate(&env),
        env,
        id,
        client,
        token,
        token_admin,
        oracle,
    }
}

/// An adapter initialised by `fx.admin`.
fn initialised() -> Fx {
    let fx = fresh();
    auth::sign(
        &fx.env,
        &fx.admin,
        &call(&fx.env, &fx.id, "initialize", (fx.admin.clone(), fx.token.clone(), fx.oracle.clone())),
    );
    fx.client.initialize(&fx.admin, &fx.token, &fx.oracle);
    fx
}

/// `depositor` holds a 1_000 position in the vault, backed by real tokens.
fn with_position(fx: &Fx, depositor: &Address) {
    mint(&fx.env, &fx.token, &fx.token_admin, &fx.id, 1_000);
    fx.env.as_contract(&fx.id, || {
        RwaStorage::save_position(
            &fx.env,
            depositor,
            &YieldAccrual {
                principal: 1_000,
                withdrawn: false,
                deposited_at: 0,
                index_entry: 1_000_000_000_000_000_000,
            },
        );
    });
}

#[test]
fn initialize_requires_exactly_the_admin() {
    let fx = fresh();
    let args = (fx.admin.clone(), fx.token.clone(), fx.oracle.clone());
    let tree = call(&fx.env, &fx.id, "initialize", args);
    let invoke = || fx.client.try_initialize(&fx.admin, &fx.token, &fx.oracle).is_ok();
    assert_rejects_signer(&fx.env, &fx.intruder, &tree, invoke);
    assert_exact_auth(&fx.env, &fx.admin, &tree, invoke);
}

#[test]
fn deposit_requires_the_depositor_for_the_call_and_its_token_transfer() {
    let fx = initialised();
    let depositor = Address::generate(&fx.env);
    mint(&fx.env, &fx.token, &fx.token_admin, &depositor, 500);

    // The depositor authorises deposit() and, beneath it, the transfer of
    // their own tokens into the vault — nothing else.
    let tree = call(&fx.env, &fx.id, "deposit", (depositor.clone(), 500i128)).with(call(
        &fx.env,
        &fx.token,
        "transfer",
        (depositor.clone(), fx.id.clone(), 500i128),
    ));
    let invoke = || fx.client.try_deposit(&depositor, &500).is_ok();
    assert_rejects_signer(&fx.env, &fx.intruder, &tree, invoke);
    assert_exact_auth(&fx.env, &depositor, &tree, invoke);
}

#[test]
fn withdraw_all_requires_exactly_the_position_owner() {
    let fx = initialised();
    let owner = Address::generate(&fx.env);
    with_position(&fx, &owner);

    let tree = call(&fx.env, &fx.id, "withdraw_all", (owner.clone(),));
    let invoke = || fx.client.try_withdraw_all(&owner).is_ok();
    assert_rejects_signer(&fx.env, &fx.intruder, &tree, invoke);
    assert_exact_auth(&fx.env, &owner, &tree, invoke);
}

#[test]
fn withdraw_requires_exactly_the_position_owner() {
    let fx = initialised();
    let owner = Address::generate(&fx.env);
    with_position(&fx, &owner);

    let tree = call(&fx.env, &fx.id, "withdraw", (owner.clone(), 400i128));
    let invoke = || fx.client.try_withdraw(&owner, &400).is_ok();
    assert_rejects_signer(&fx.env, &fx.intruder, &tree, invoke);
    assert_exact_auth(&fx.env, &owner, &tree, invoke);
}

#[test]
fn propose_admin_requires_exactly_the_admin() {
    let fx = initialised();
    let next = Address::generate(&fx.env);
    let tree = call(&fx.env, &fx.id, "propose_admin", (next.clone(),));
    let invoke = || fx.client.try_propose_admin(&next).is_ok();
    assert_rejects_signer(&fx.env, &fx.intruder, &tree, invoke);
    assert_exact_auth(&fx.env, &fx.admin, &tree, invoke);
}

#[test]
fn accept_admin_requires_exactly_the_proposed_admin() {
    let fx = initialised();
    let next = Address::generate(&fx.env);
    fx.env.as_contract(&fx.id, || {
        RwaStorage::save_pending_admin(&fx.env, &PendingAdmin { new_admin: next.clone() });
    });
    let tree = call(&fx.env, &fx.id, "accept_admin", ());
    let invoke = || fx.client.try_accept_admin().is_ok();
    // The current admin cannot complete a transfer on the nominee's behalf.
    assert_rejects_signer(&fx.env, &fx.admin, &tree, invoke);
    assert_exact_auth(&fx.env, &next, &tree, invoke);
}

#[test]
fn upgrade_requires_exactly_the_admin() {
    let fx = initialised();
    let hash = fx.env.deployer().upload_contract_wasm(TEST_WASM);
    let tree = call(&fx.env, &fx.id, "upgrade", (hash.clone(),));
    let invoke = || fx.client.try_upgrade(&hash).is_ok();
    assert_rejects_signer(&fx.env, &fx.intruder, &tree, invoke);
    assert_exact_auth(&fx.env, &fx.admin, &tree, invoke);
}

/// Any valid contract wasm will do as an upgrade target; the adapter's own
/// release build is the one guaranteed to exist after the CI wasm step.
const TEST_WASM: &[u8] = include_bytes!("../../target/wasm32v1-none/release/rwa_adapter.wasm");
