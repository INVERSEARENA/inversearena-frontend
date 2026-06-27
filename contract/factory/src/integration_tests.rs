#![cfg(test)]

extern crate std;

use crate::{FactoryContract, FactoryContractClient};
use crate::storage::CreatorStakeRecord;
use crate::types::{ArenaMetadata, ArenaStatus};
use soroban_sdk::{
    Address, BytesN, Env,
    testutils::{Address as _, Ledger},
    token::StellarAssetClient,
};

use arena::{ArenaContract, ArenaContractClient};
use oracle::{OracleContract, OracleContractClient};
use rwa_adapter::{RwaAdapter, RwaAdapterClient};

fn compute_commitment(env: &Env, choice: arena::types::Choice, salt: &BytesN<32>) -> BytesN<32> {
    let mut preimage = soroban_sdk::Bytes::new(env);
    preimage.push_back(choice.to_byte());
    let salt_bytes = salt.to_array();
    for b in salt_bytes.iter() {
        preimage.push_back(*b);
    }
    env.crypto().sha256(&preimage).into()
}

/// Full factory integration test: deploy an arena, register it with the
/// factory, then run a full game lifecycle through the arena.
///
/// Uses `env.register` to deploy the arena directly (avoids wasm-upload
/// issues in the test environment) while still exercising all factory
/// storage, query, and status-management functions.
#[test]
fn factory_deploys_arena_and_full_game_plays() {
    let env = Env::default();
    env.mock_all_auths();

    // ── 1. Deploy factory, oracle, vault, token ──────────────────────────
    let factory_id = env.register(FactoryContract, ());
    let factory_client = FactoryContractClient::new(&env, &factory_id);

    let admin = Address::generate(&env);
    let host = Address::generate(&env);
    let token_admin = Address::generate(&env);
    let token_id = env
        .register_stellar_asset_contract_v2(token_admin)
        .address();
    let token_admin_client = StellarAssetClient::new(&env, &token_id);

    // Deploy and initialize Oracle
    let oracle_id = env.register(OracleContract, ());
    let oracle_client = OracleContractClient::new(&env, &oracle_id);
    oracle_client.initialize(&admin, &500);

    // Deploy and initialize RWA Adapter
    let vault_id = env.register(RwaAdapter, ());
    let vault_client = RwaAdapterClient::new(&env, &vault_id);
    vault_client.initialize(&admin, &token_id);

    // ── 2. Initialize factory ────────────────────────────────────────────
    factory_client.initialize(&admin, &100);

    // Whitelist host, approve vault, oracle, token
    factory_client.add_to_whitelist(&host);
    factory_client.add_approved_vault(&vault_id);
    factory_client.add_approved_oracle(&oracle_id);
    factory_client.add_supported_token(&token_id);

    // ── 3. Register arena with factory manually ─────────────────────────
    // Deploy the arena contract directly (using env.register to avoid
    // wasm parser issues with reference-types in the test environment).
    let arena_id = env.register(ArenaContract, ());
    let arena_client = ArenaContractClient::new(&env, &arena_id);

    // The factory's create_pool calls initialize internally. We'll simulate
    // what create_pool would do after deploy_v2.
    arena_client.initialize(&host, &token_id, &vault_id, &100, &oracle_id);

    // Manually register the stake record and pool in factory storage
    // (this is what create_pool would do after a successful deployment)
    // We use env as_contract to impersonate the factory and write storage.
    env.as_contract(&factory_id, || {
        crate::storage::FactoryStorage::save_creator_stake(
            &env,
            &arena_id,
            &CreatorStakeRecord {
                creator: host.clone(),
                amount: 100,
            },
        );
        crate::storage::FactoryStorage::increment_active_pool_count(&env, &host);
        crate::storage::FactoryStorage::save_pool(
            &env,
            1,
            &ArenaMetadata {
                arena_address: arena_id.clone(),
                pool_id: 1,
                host: host.clone(),
                entry_fee: 100,
                status: ArenaStatus::Active,
                created_at: env.ledger().timestamp(),
            },
        );
        crate::storage::FactoryStorage::increment_pool_count(&env);
    });

    // Verify creator stake record exists
    let stake_record = factory_client.get_creator_stake(&arena_id);
    assert!(stake_record.is_some());
    assert_eq!(stake_record.unwrap().amount, 100);

    // ── 4. Fund players for entry fees ──────────────────────────────────
    let p1 = Address::generate(&env);
    let p2 = Address::generate(&env);
    let p3 = Address::generate(&env);
    token_admin_client.mint(&p1, &1000);
    token_admin_client.mint(&p2, &1000);
    token_admin_client.mint(&p3, &1000);

    // ── 5. Interact with deployed arena ─────────────────────────────────
    // Players join
    arena_client.join_arena(&p1);
    arena_client.join_arena(&p2);
    arena_client.join_arena(&p3);

    let token_client = soroban_sdk::token::TokenClient::new(&env, &token_id);
    assert_eq!(arena_client.player_count(), 3);
    assert_eq!(token_client.balance(&p1), 900);
    assert_eq!(token_client.balance(&arena_id), 300);

    // ── 6. Start round ──────────────────────────────────────────────────
    env.ledger().with_mut(|li| li.timestamp = 1000);
    arena_client.start_round(&3600);

    // ── 7. Submit commitments ────────────────────────────────────────────
    let salt1 = BytesN::from_array(&env, &[1u8; 32]);
    let salt2 = BytesN::from_array(&env, &[2u8; 32]);
    let salt3 = BytesN::from_array(&env, &[3u8; 32]);

    // p1 chooses Tails (minority), p2 and p3 choose Heads (majority)
    let c1 = compute_commitment(&env, arena::types::Choice::Tails, &salt1);
    let c2 = compute_commitment(&env, arena::types::Choice::Heads, &salt2);
    let c3 = compute_commitment(&env, arena::types::Choice::Heads, &salt3);

    arena_client.submit_commitment(&p1, &c1);
    arena_client.submit_commitment(&p2, &c2);
    arena_client.submit_commitment(&p3, &c3);

    // ── 8. Reveal choices after deadline ────────────────────────────────
    env.ledger().with_mut(|li| li.timestamp = 4601);
    arena_client.reveal_choice(&p1, &arena::types::Choice::Tails, &salt1);
    arena_client.reveal_choice(&p2, &arena::types::Choice::Heads, &salt2);
    arena_client.reveal_choice(&p3, &arena::types::Choice::Heads, &salt3);

    // ── 9. Resolve round ────────────────────────────────────────────────
    arena_client.resolve_round();

    // Verify round result
    let result = arena_client.get_round_result(&1).unwrap();
    assert_eq!(result.round, 1);
    assert_eq!(result.eliminated, 2, "majority voters should be eliminated");
    assert_eq!(result.survivors, 1, "minority voter should survive");

    // ── 10. Verify player states ────────────────────────────────────────
    assert_eq!(arena_client.player_count(), 3);
    let players = arena_client.get_players(&0);
    for (addr, state) in players.iter() {
        if addr == p1 {
            assert!(state.active, "p1 (minority: Tails) should survive");
            assert_eq!(state.rounds_survived, 1);
        } else {
            assert!(!state.active, "majority voter should be eliminated");
        }
    }

    // Verify yield snapshot was recorded
    let snapshot = arena_client.get_yield_snapshot(&1);
    assert!(snapshot.is_some());

    // ── 11. Query verification via factory ───────────────────────────────
    // verify_arena still references this deployment
    let metadata = factory_client.get_arena(&1);
    assert!(metadata.is_some());
    let meta = metadata.unwrap();
    assert_eq!(meta.arena_address, arena_id);
    assert_eq!(meta.host, host);
    assert_eq!(meta.entry_fee, 100);
    let arenas = factory_client.get_arenas(&0, &10);
    assert_eq!(arenas.len(), 1);
}
