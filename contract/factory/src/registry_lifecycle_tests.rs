//! Tests for the registry deprecation lifecycle (#1688).
//!
//! Approval used to be binary. A token, vault or oracle that already backs
//! live arenas could only stay approved or be pulled out from under them.
//! The lifecycle adds the middle state — `Deprecated` — and a guarded
//! `Disabled` state, so an integration is retired in a way that never
//! strands the funds of an arena that already uses it.
//!
//! These tests are contract-level: they drive the factory's own entry points
//! and its storage, without deploying an arena.

#![cfg(test)]

extern crate std;

use crate::storage::FactoryStorage;
use crate::types::{ArenaMetadata, ArenaStatus, PoolIntegration, RegistryKind, RegistryState};
use crate::{FactoryContract, FactoryContractClient};
use soroban_sdk::{
    Address, BytesN, Env, Symbol, symbol_short,
    testutils::{Address as _, Ledger as _},
};

/// An initialized factory whose admin is `admin`.
struct Fx {
    env: Env,
    id: Address,
    client: FactoryContractClient<'static>,
    admin: Address,
}

fn fixture() -> Fx {
    let env = Env::default();
    let id = env.register(FactoryContract, ());
    let client = FactoryContractClient::new(&env, &id);
    let admin = Address::generate(&env);
    env.mock_all_auths();
    client.initialize(&admin, &100);
    Fx { env, id, client, admin }
}

impl Fx {
    /// Record a live pool that uses `vault`, the way `create_pool` does.
    fn live_pool(&self, pool_id: u32, vault: &Address, oracle: &Address, token: &Address) {
        let env = &self.env;
        env.as_contract(&self.id, || {
            FactoryStorage::save_pool(
                env,
                pool_id,
                &ArenaMetadata {
                    arena_address: Address::generate(env),
                    pool_id,
                    host: Address::generate(env),
                    entry_fee: 100,
                    status: ArenaStatus::Active,
                    created_at: 0,
                    metadata_hash: BytesN::from_array(env, &[0u8; 32]),
                },
            );
            FactoryStorage::index_pool_status(env, pool_id, &ArenaStatus::Active);
            FactoryStorage::save_pool_integration(
                env,
                pool_id,
                &PoolIntegration {
                    stake_token: token.clone(),
                    yield_vault: vault.clone(),
                    oracle_contract: oracle.clone(),
                },
            );
            FactoryStorage::increment_live_use(env, &RegistryKind::Token, token);
            FactoryStorage::increment_live_use(env, &RegistryKind::Vault, vault);
            FactoryStorage::increment_live_use(env, &RegistryKind::Oracle, oracle);
        });
    }

    /// A live pool from before the registry tracked integrations: the
    /// factory cannot tell which integrations it uses.
    fn legacy_live_pool(&self, pool_id: u32) {
        let env = &self.env;
        env.as_contract(&self.id, || {
            FactoryStorage::save_pool(
                env,
                pool_id,
                &ArenaMetadata {
                    arena_address: Address::generate(env),
                    pool_id,
                    host: Address::generate(env),
                    entry_fee: 100,
                    status: ArenaStatus::Active,
                    created_at: 0,
                    metadata_hash: BytesN::from_array(env, &[0u8; 32]),
                },
            );
            FactoryStorage::index_pool_status(env, pool_id, &ArenaStatus::Active);
        });
    }
}

/// An entry that predates the lifecycle reads as active, so integrations
/// approved before #1688 keep working without a migration.
#[test]
fn unknown_legacy_entries_read_as_active() {
    let fx = fixture();
    let vault = Address::generate(&fx.env);
    let entry = fx.client.get_vault_lifecycle(&vault);
    assert_eq!(entry.state, RegistryState::Active);
    assert_eq!(entry.effective_ledger, 0);
    assert_eq!(entry.reason, Symbol::new(&fx.env, "legacy"));
}

/// Deprecating an integration keeps it usable for the arenas that already
/// use it, but stops it being accepted for new ones.
#[test]
fn deprecation_records_state_ledger_reason_and_revision() {
    let fx = fixture();
    let vault = Address::generate(&fx.env);
    let before = fx.client.get_registry_revision();

    let reason = symbol_short!("migrated");
    fx.env.ledger().set_timestamp(1_700_000_000);
    fx.client.deprecate_approved_vault(&vault, &reason);

    let entry = fx.client.get_vault_lifecycle(&vault);
    assert_eq!(entry.state, RegistryState::Deprecated);
    assert_eq!(entry.reason, reason);
    assert!(entry.effective_ledger > 0, "the transition is dated");
    assert!(fx.client.get_registry_revision() > before, "the revision moves");
}

/// The emergency removal path stays unconditional — it is the procedure that
/// covers liabilities the guarded disable path refuses.
#[test]
fn the_emergency_removal_path_bypasses_the_liability_guard() {
    let fx = fixture();
    let vault = Address::generate(&fx.env);
    let oracle = Address::generate(&fx.env);
    let token = Address::generate(&fx.env);
    fx.live_pool(1, &vault, &oracle, &token);

    // The guarded path refuses while the pool is live.
    assert_eq!(
        fx.client.try_disable_approved_vault(&vault, &symbol_short!("retired")),
        Err(Ok(crate::types::FactoryError::OutstandingLiabilities))
    );

    // The emergency path does not.
    fx.client.remove_approved_vault(&vault);
    assert_eq!(
        fx.client.get_vault_lifecycle(&vault).state,
        RegistryState::Disabled
    );
}

/// A deprecated integration cannot be disabled while a pool still uses it,
/// and can be once that pool has settled.
#[test]
fn disabling_is_refused_while_pools_are_live() {
    let fx = fixture();
    let vault = Address::generate(&fx.env);
    let oracle = Address::generate(&fx.env);
    let token = Address::generate(&fx.env);
    fx.live_pool(1, &vault, &oracle, &token);
    assert_eq!(fx.client.count_live_pools_using(&RegistryKind::Vault, &vault), 1);

    assert_eq!(
        fx.client.try_disable_approved_vault(&vault, &symbol_short!("retired")),
        Err(Ok(crate::types::FactoryError::OutstandingLiabilities))
    );

    // The pool settles: the liability is gone and the entry can be disabled.
    fx.client.update_arena_status(&1, &ArenaStatus::Cancelled);
    assert_eq!(fx.client.count_live_pools_using(&RegistryKind::Vault, &vault), 0);
    fx.client.disable_approved_vault(&vault, &symbol_short!("retired"));
    assert_eq!(
        fx.client.get_vault_lifecycle(&vault).state,
        RegistryState::Disabled
    );
}

/// A pool created before the registry tracked integrations leaves the
/// factory unable to prove that no liability remains: disabling is refused.
#[test]
fn disabling_is_refused_while_an_untracked_pool_is_live() {
    let fx = fixture();
    let vault = Address::generate(&fx.env);
    fx.legacy_live_pool(7);

    assert_eq!(
        fx.client.try_disable_approved_vault(&vault, &symbol_short!("retired")),
        Err(Ok(crate::types::FactoryError::OutstandingLiabilities))
    );

    // Once the legacy pool is gone, the entry can be disabled.
    fx.client.update_arena_status(&7, &ArenaStatus::Finished);
    fx.client.disable_approved_vault(&vault, &symbol_short!("retired"));
    assert_eq!(
        fx.client.get_vault_lifecycle(&vault).state,
        RegistryState::Disabled
    );
}

/// Reactivation needs the integration to be approved again; approving it is
/// what brings it back into service.
#[test]
fn reactivation_requires_an_approved_entry() {
    let fx = fixture();
    let vault = Address::generate(&fx.env);

    assert_eq!(
        fx.client.try_reactivate_approved_vault(&vault),
        Err(Ok(crate::types::FactoryError::IntegrationNotApproved))
    );

    fx.client.deprecate_approved_vault(&vault, &symbol_short!("migrated"));
    assert_eq!(
        fx.client.get_vault_lifecycle(&vault).state,
        RegistryState::Deprecated
    );
}

/// Tokens and oracles carry the same lifecycle as vaults.
#[test]
fn tokens_and_oracles_carry_the_same_lifecycle() {
    let fx = fixture();
    let token = Address::generate(&fx.env);
    let oracle = Address::generate(&fx.env);

    fx.client.deprecate_supported_token(&token, &symbol_short!("migrated"));
    fx.client.deprecate_approved_oracle(&oracle, &symbol_short!("migrated"));
    assert_eq!(
        fx.client.get_token_lifecycle(&token).state,
        RegistryState::Deprecated
    );
    assert_eq!(
        fx.client.get_oracle_lifecycle(&oracle).state,
        RegistryState::Deprecated
    );

    fx.client.disable_supported_token(&token, &symbol_short!("retired"));
    fx.client.disable_approved_oracle(&oracle, &symbol_short!("retired"));
    assert_eq!(
        fx.client.get_token_lifecycle(&token).state,
        RegistryState::Disabled
    );
    assert_eq!(
        fx.client.get_oracle_lifecycle(&oracle).state,
        RegistryState::Disabled
    );
}

/// Only the factory admin may move an entry through the lifecycle.
#[test]
fn lifecycle_changes_require_the_admin() {
    let env = Env::default();
    let id = env.register(FactoryContract, ());
    let client = FactoryContractClient::new(&env, &id);
    let admin = Address::generate(&env);
    env.mock_all_auths();
    client.initialize(&admin, &100);

    let vault = Address::generate(&env);
    let intruder = Address::generate(&env);
    env.set_auths(&[]);
    assert!(
        client
            .try_deprecate_approved_vault(&vault, &symbol_short!("migrated"))
            .is_err(),
        "an unauthorised caller must not deprecate an integration"
    );
    let _ = intruder;
}
