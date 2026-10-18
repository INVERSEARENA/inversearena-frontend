/// Tests for the HostPools and StatusBucket secondary indexes (#1613) and
/// arena temporary-storage TTL behaviour (#1612).
///
/// These are unit-level storage tests — no cross-contract calls, no WASM
/// deployment.  They exercise the FactoryStorage and ArenaStorage helpers
/// directly inside an `Env::default()` contract sandbox.

#![cfg(test)]

use soroban_sdk::testutils::Address as _;
use soroban_sdk::{Address, Env, Vec};

// ---------------------------------------------------------------------------
// #1613 — Factory secondary indexes
// ---------------------------------------------------------------------------

#[cfg(test)]
mod factory_indexes {
    use super::*;
    use crate::storage::FactoryStorage;
    use crate::types::{ArenaMetadata, ArenaStatus};
    use soroban_sdk::BytesN;

    fn make_pool_meta(env: &Env, pool_id: u32, host: &Address) -> ArenaMetadata {
        ArenaMetadata {
            arena_address: Address::generate(env),
            pool_id,
            host: host.clone(),
            entry_fee: 100,
            status: ArenaStatus::Active,
            created_at: 0,
            metadata_hash: BytesN::<32>::from_array(env, &[0u8; 32]),
        }
    }

    #[test]
    fn index_host_pool_pages_correctly() {
        let env = Env::default();
        let host = Address::generate(&env);

        // Insert 1 pool — should go to page 0.
        FactoryStorage::index_host_pool(&env, &host, 1);
        assert_eq!(FactoryStorage::host_pool_count(&env, &host), 1);
        let page0 = FactoryStorage::get_host_pools_page(&env, &host, 0);
        assert_eq!(page0.len(), 1);
        assert_eq!(page0.get(0), Some(1));

        // Insert up to HOST_POOLS_PAGE_SIZE.
        for i in 2..=FactoryStorage::HOST_POOLS_PAGE_SIZE {
            FactoryStorage::index_host_pool(&env, &host, i as u32);
        }
        assert_eq!(
            FactoryStorage::host_pool_count(&env, &host),
            FactoryStorage::HOST_POOLS_PAGE_SIZE
        );

        // Insert one more — should overflow to page 1.
        FactoryStorage::index_host_pool(&env, &host, 51);
        assert_eq!(
            FactoryStorage::host_pool_count(&env, &host),
            FactoryStorage::HOST_POOLS_PAGE_SIZE + 1
        );
        let page1 = FactoryStorage::get_host_pools_page(&env, &host, 1);
        assert_eq!(page1.len(), 1);
        assert_eq!(page1.get(0), Some(51));
    }

    #[test]
    fn index_host_pool_separate_hosts() {
        let env = Env::default();
        let host_a = Address::generate(&env);
        let host_b = Address::generate(&env);

        FactoryStorage::index_host_pool(&env, &host_a, 1);
        FactoryStorage::index_host_pool(&env, &host_b, 2);
        FactoryStorage::index_host_pool(&env, &host_a, 3);

        assert_eq!(FactoryStorage::host_pool_count(&env, &host_a), 2);
        assert_eq!(FactoryStorage::host_pool_count(&env, &host_b), 1);

        let a_page0 = FactoryStorage::get_host_pools_page(&env, &host_a, 0);
        assert_eq!(a_page0.get(0), Some(1));
        assert_eq!(a_page0.get(1), Some(3));

        let b_page0 = FactoryStorage::get_host_pools_page(&env, &host_b, 0);
        assert_eq!(b_page0.get(0), Some(2));
    }

    #[test]
    fn status_bucket_transition_moves_pool_between_buckets() {
        let env = Env::default();

        // Start in Pending.
        FactoryStorage::index_pool_status(&env, 1, &ArenaStatus::Pending);
        let pending = FactoryStorage::get_pools_by_status(&env, &ArenaStatus::Pending, 0, 50);
        assert_eq!(pending.len(), 1);
        assert_eq!(pending.get(0), Some(1));

        // Transition Pending → Active.
        FactoryStorage::transition_pool_status(&env, 1, &ArenaStatus::Pending, &ArenaStatus::Active);
        let pending_after = FactoryStorage::get_pools_by_status(&env, &ArenaStatus::Pending, 0, 50);
        let active_after = FactoryStorage::get_pools_by_status(&env, &ArenaStatus::Active, 0, 50);
        assert_eq!(pending_after.len(), 0);
        assert_eq!(active_after.len(), 1);
        assert_eq!(active_after.get(0), Some(1));
    }

    #[test]
    fn status_bucket_transition_is_o1_swap_remove() {
        let env = Env::default();

        // Fill a bucket with 3 pools.
        FactoryStorage::index_pool_status(&env, 1, &ArenaStatus::Pending);
        FactoryStorage::index_pool_status(&env, 2, &ArenaStatus::Pending);
        FactoryStorage::index_pool_status(&env, 3, &ArenaStatus::Pending);

        // Remove pool 1 (not the last) — swap-remove should work.
        FactoryStorage::transition_pool_status(&env, 1, &ArenaStatus::Pending, &ArenaStatus::Active);

        let pending = FactoryStorage::get_pools_by_status(&env, &ArenaStatus::Pending, 0, 50);
        let active = FactoryStorage::get_pools_by_status(&env, &ArenaStatus::Active, 0, 50);

        // Pending should have 2 entries (3 and 2, with 3 moved into slot 0 by swap).
        assert_eq!(pending.len(), 2);
        assert_eq!(active.len(), 1);
        assert_eq!(active.get(0), Some(1));

        // Both 2 and 3 should be present in pending.
        let mut found_2 = false;
        let mut found_3 = false;
        for i in 0..pending.len() {
            if let Some(id) = pending.get(i) {
                if id == 2 { found_2 = true; }
                if id == 3 { found_3 = true; }
            }
        }
        assert!(found_2);
        assert!(found_3);
    }

    #[test]
    fn index_pool_status_is_idempotent() {
        let env = Env::default();
        FactoryStorage::index_pool_status(&env, 1, &ArenaStatus::Active);
        FactoryStorage::index_pool_status(&env, 1, &ArenaStatus::Active);
        let active = FactoryStorage::get_pools_by_status(&env, &ArenaStatus::Active, 0, 50);
        assert_eq!(active.len(), 1);
    }
}

// ---------------------------------------------------------------------------
// #1612 — Arena temporary-storage TTL for commitments and choices
// ---------------------------------------------------------------------------

#[cfg(test)]
mod arena_temp_storage {
    use super::*;
    use crate::storage::ArenaStorage;
    use crate::types::{ArenaConfig, GameState};
    use soroban_sdk::BytesN;

    fn config(env: &Env, admin: &Address, state: GameState) -> ArenaConfig {
        ArenaConfig {
            admin: admin.clone(),
            stake_token: Address::generate(env),
            yield_vault: Address::generate(env),
            entry_fee: 100,
            state,
            paused: false,
            player_count: 0,
            active_player_count: 0,
            cumulative_yield: 0,
            commit_deadline: 0,
            round_count: 0,
            oracle_contract: Address::generate(env),
            factory: Address::generate(env),
            pool_id: 0,
            platform_fee_bps: 1000,
        }
    }

    #[test]
    fn save_and_load_commitment_from_temporary_storage() {
        let env = Env::default();
        let admin = Address::generate(&env);
        let player = Address::generate(&env);
        let contract_id = env.register(crate::ArenaContract, ());
        env.as_contract(&contract_id, || {
            ArenaStorage::save_config(&env, &config(&env, &admin, GameState::Open));
            ArenaStorage::save_round_duration(&env, 60);

            let commitment = BytesN::<32>::from_array(&env, &[0xAB; 32]);
            ArenaStorage::save_commitment(&env, &player, 1, &commitment);

            // Should round-trip from temporary storage.
            let loaded = ArenaStorage::load_commitment(&env, &player, 1);
            assert_eq!(loaded, Some(commitment));
        });
    }

    #[test]
    fn save_and_load_choice_from_temporary_storage() {
        use crate::types::Choice;

        let env = Env::default();
        let admin = Address::generate(&env);
        let player = Address::generate(&env);
        let contract_id = env.register(crate::ArenaContract, ());
        env.as_contract(&contract_id, || {
            ArenaStorage::save_config(&env, &config(&env, &admin, GameState::Open));
            ArenaStorage::save_round_duration(&env, 60);

            ArenaStorage::save_choice(&env, &player, 1, &Choice::Heads);
            let loaded = ArenaStorage::load_choice(&env, &player, 1);
            assert_eq!(loaded, Some(Choice::Heads));
        });
    }

    #[test]
    fn load_commitment_returns_none_when_expired() {
        let env = Env::default();
        let admin = Address::generate(&env);
        let player = Address::generate(&env);
        let contract_id = env.register(crate::ArenaContract, ());
        env.as_contract(&contract_id, || {
            ArenaStorage::save_config(&env, &config(&env, &admin, GameState::Open));
            ArenaStorage::save_round_duration(&env, 60);

            let commitment = BytesN::<32>::from_array(&env, &[0xCD; 32]);
            ArenaStorage::save_commitment(&env, &player, 1, &commitment);
            assert!(ArenaStorage::load_commitment(&env, &player, 1).is_some());

            // Advance the ledger beyond the temporary TTL.
            // TTL ≈ (60 / 5) + 17_280 = 17_292 ledgers.
            env.ledger().set_seq_number(env.ledger().sequence() + 17_300);

            // After expiry, load_commitment returns None — treated as no-commit.
            assert_eq!(ArenaStorage::load_commitment(&env, &player, 1), None);
        });
    }

    #[test]
    fn remove_player_choice_clears_temporary_entry() {
        use crate::types::Choice;

        let env = Env::default();
        let admin = Address::generate(&env);
        let player = Address::generate(&env);
        let contract_id = env.register(crate::ArenaContract, ());
        env.as_contract(&contract_id, || {
            ArenaStorage::save_config(&env, &config(&env, &admin, GameState::Open));
            ArenaStorage::save_round_duration(&env, 60);

            ArenaStorage::save_choice(&env, &player, 1, &Choice::Heads);
            assert!(ArenaStorage::load_choice(&env, &player, 1).is_some());

            ArenaStorage::remove_player_choice(&env, &player, 1);
            assert_eq!(ArenaStorage::load_choice(&env, &player, 1), None);
        });
    }
}
