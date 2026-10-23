//! Exact-authorization tests for every `require_auth` site in the factory
//! (#1636). See `contract/test-support/auth.rs` for what these catch that
//! `mock_all_auths` cannot.
//!
//! `create_pool` is covered in `arena/src/auth_tests.rs`, which has the
//! arena wasm the factory deploys. The arena-only callbacks are covered here
//! with the arena as a plain signer, and again in the arena's tests through
//! real cross-contract calls, where the arena authorises them as the direct
//! invoker.

#![cfg(test)]

#[path = "../../test-support/auth.rs"]
mod auth;

use crate::storage::{CreatorStakeRecord, FactoryStorage};
use crate::types::{ArenaMetadata, ArenaStatus, VaultConfig};
use crate::{FactoryContract, FactoryContractClient};
use auth::{Call, assert_exact_auth, assert_rejects_signer, call, mint, new_token, sign};
use soroban_sdk::{
    Address, BytesN, Env, IntoVal, Symbol, Val, Vec, contract, contractimpl, symbol_short,
    testutils::Address as _,
};

#[contract]
struct ConfiguredVault;

#[contractimpl]
impl ConfiguredVault {
    pub fn set_config(env: Env, stake_token: Address, oracle: Address) {
        env.storage()
            .instance()
            .set(&symbol_short!("CFG"), &VaultConfig { stake_token, oracle });
    }

    pub fn config(env: Env) -> VaultConfig {
        env.storage().instance().get(&symbol_short!("CFG")).unwrap()
    }
}

struct Fx {
    env: Env,
    id: Address,
    client: FactoryContractClient<'static>,
    admin: Address,
    intruder: Address,
}

impl Fx {
    fn tree(&self, fn_name: &'static str, args: impl IntoVal<Env, Vec<Val>>) -> Call {
        call(&self.env, &self.id, fn_name, args)
    }

    /// The admin's exact signature is required, and nobody else's works.
    fn assert_admin_only(&self, tree: Call, invoke: impl Fn() -> bool) {
        assert_rejects_signer(&self.env, &self.intruder, &tree, &invoke);
        assert_exact_auth(&self.env, &self.admin, &tree, &invoke);
    }

    /// Record `arena` as deployed by this factory, with a funded creator
    /// stake and pool 1, as `create_pool` would.
    fn deployed_arena(&self) -> Address {
        let arena = Address::generate(&self.env);
        let creator = Address::generate(&self.env);
        let (token, token_admin) = new_token(&self.env);
        mint(&self.env, &token, &token_admin, &self.id, 100);
        self.env.as_contract(&self.id, || {
            FactoryStorage::save_creator_stake(
                &self.env,
                &arena,
                &CreatorStakeRecord { creator: creator.clone(), amount: 100, stake_token: token },
            );
            FactoryStorage::increment_active_pool_count(&self.env, &creator);
            FactoryStorage::save_pool(
                &self.env,
                1,
                &ArenaMetadata {
                    arena_address: arena.clone(),
                    pool_id: 1,
                    host: creator,
                    entry_fee: 100,
                    status: ArenaStatus::Active,
                    created_at: 0,
                    metadata_hash: BytesN::from_array(&self.env, &[0u8; 32]),
                },
            );
            FactoryStorage::index_pool_status(&self.env, 1, &ArenaStatus::Active);
        });
        arena
    }
}

fn fixture() -> Fx {
    let env = Env::default();
    let id = env.register(FactoryContract, ());
    let client = FactoryContractClient::new(&env, &id);
    let admin = Address::generate(&env);
    sign(&env, &admin, &call(&env, &id, "initialize", (admin.clone(), 100i128)));
    client.initialize(&admin, &100);
    Fx { intruder: Address::generate(&env), env, id, client, admin }
}

#[test]
fn initialize_requires_exactly_the_admin() {
    let env = Env::default();
    let id = env.register(FactoryContract, ());
    let client = FactoryContractClient::new(&env, &id);
    let admin = Address::generate(&env);
    let tree = call(&env, &id, "initialize", (admin.clone(), 100i128));
    let invoke = || client.try_initialize(&admin, &100).is_ok();
    assert_rejects_signer(&env, &Address::generate(&env), &tree, invoke);
    assert_exact_auth(&env, &admin, &tree, invoke);
}

#[test]
fn upgrade_requires_exactly_the_admin() {
    let fx = fixture();
    let hash = fx.env.deployer().upload_contract_wasm(FACTORY_WASM);
    fx.assert_admin_only(fx.tree("upgrade", (hash.clone(),)), || {
        fx.client.try_upgrade(&hash).is_ok()
    });
}

#[test]
fn set_arena_wasm_hash_requires_exactly_the_admin() {
    let fx = fixture();
    let hash = BytesN::from_array(&fx.env, &[3u8; 32]);
    fx.assert_admin_only(fx.tree("set_arena_wasm_hash", (hash.clone(),)), || {
        fx.client.try_set_arena_wasm_hash(&hash).is_ok()
    });
}

#[test]
fn whitelist_changes_require_exactly_the_admin() {
    let fx = fixture();
    let host = Address::generate(&fx.env);
    fx.assert_admin_only(fx.tree("add_to_whitelist", (host.clone(),)), || {
        fx.client.try_add_to_whitelist(&host).is_ok()
    });
    fx.assert_admin_only(fx.tree("remove_from_whitelist", (host.clone(),)), || {
        fx.client.try_remove_from_whitelist(&host).is_ok()
    });
}

#[test]
fn vault_approval_changes_require_exactly_the_admin() {
    let fx = fixture();
    let vault = fx.env.register(ConfiguredVault, ());
    ConfiguredVaultClient::new(&fx.env, &vault)
        .set_config(&Address::generate(&fx.env), &Address::generate(&fx.env));
    // Reading the vault's config is a plain read: nothing beyond the
    // admin's own call may be authorised.
    fx.assert_admin_only(fx.tree("add_approved_vault", (vault.clone(),)), || {
        fx.client.try_add_approved_vault(&vault).is_ok()
    });
    fx.assert_admin_only(fx.tree("remove_approved_vault", (vault.clone(),)), || {
        fx.client.try_remove_approved_vault(&vault).is_ok()
    });
}

#[test]
fn oracle_approval_changes_require_exactly_the_admin() {
    let fx = fixture();
    let oracle = Address::generate(&fx.env);
    fx.assert_admin_only(fx.tree("add_approved_oracle", (oracle.clone(),)), || {
        fx.client.try_add_approved_oracle(&oracle).is_ok()
    });
    fx.assert_admin_only(fx.tree("remove_approved_oracle", (oracle.clone(),)), || {
        fx.client.try_remove_approved_oracle(&oracle).is_ok()
    });
}

#[test]
fn supported_token_changes_require_exactly_the_admin() {
    let fx = fixture();
    let token = Address::generate(&fx.env);
    fx.assert_admin_only(fx.tree("add_supported_token", (token.clone(),)), || {
        fx.client.try_add_supported_token(&token).is_ok()
    });
    fx.assert_admin_only(fx.tree("remove_supported_token", (token.clone(),)), || {
        fx.client.try_remove_supported_token(&token).is_ok()
    });
}

#[test]
fn set_max_active_pools_requires_exactly_the_admin() {
    let fx = fixture();
    fx.assert_admin_only(fx.tree("set_max_active_pools", (5u32,)), || {
        fx.client.try_set_max_active_pools(&5).is_ok()
    });
}

#[test]
fn pause_and_unpause_require_exactly_the_admin() {
    let fx = fixture();
    fx.assert_admin_only(fx.tree("pause", ()), || fx.client.try_pause().is_ok());
    fx.assert_admin_only(fx.tree("unpause", ()), || fx.client.try_unpause().is_ok());
}

#[test]
fn set_global_pause_requires_exactly_the_admin() {
    let fx = fixture();
    let reason = Symbol::new(&fx.env, "incident");
    fx.assert_admin_only(fx.tree("set_global_pause", (true, reason.clone())), || {
        fx.client.try_set_global_pause(&true, &reason).is_ok()
    });
    assert!(fx.client.is_globally_paused());
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

// ── Arena callbacks ──────────────────────────────────────────────────────────

#[test]
fn release_arena_requires_exactly_that_arena() {
    let fx = fixture();
    let arena = fx.deployed_arena();
    let tree = fx.tree("release_arena", (arena.clone(),));
    let invoke = || fx.client.try_release_arena(&arena).is_ok();
    // Neither the protocol admin nor another arena may release this one.
    assert_rejects_signer(&fx.env, &fx.admin, &tree, invoke);
    assert_rejects_signer(&fx.env, &Address::generate(&fx.env), &tree, invoke);
    assert_exact_auth(&fx.env, &arena, &tree, invoke);
}

#[test]
fn reclaim_creator_stake_requires_exactly_that_arena() {
    let fx = fixture();
    let arena = fx.deployed_arena();
    let tree = fx.tree("reclaim_creator_stake", (arena.clone(),));
    let invoke = || fx.client.try_reclaim_creator_stake(&arena).is_ok();
    assert_rejects_signer(&fx.env, &fx.admin, &tree, invoke);
    // The factory pays the stake from its own balance: no sub-authorization.
    assert_exact_auth(&fx.env, &arena, &tree, invoke);
    assert!(fx.client.get_creator_stake(&arena).is_none());
}

#[test]
fn update_arena_status_requires_exactly_the_recorded_arena() {
    let fx = fixture();
    let arena = fx.deployed_arena();
    let tree = fx.tree("update_arena_status", (1u32, ArenaStatus::Finished));
    let invoke = || fx.client.try_update_arena_status(&1, &ArenaStatus::Finished).is_ok();
    assert_rejects_signer(&fx.env, &fx.admin, &tree, invoke);
    assert_exact_auth(&fx.env, &arena, &tree, invoke);
    assert_eq!(fx.client.get_arena(&1).unwrap().status, ArenaStatus::Finished);
}

/// Any valid contract wasm will do as an upgrade target; the factory's own
/// release build exists once the CI wasm step has run.
const FACTORY_WASM: &[u8] = include_bytes!("../../target/wasm32v1-none/release/factory.wasm");
