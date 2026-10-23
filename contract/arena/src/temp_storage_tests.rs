//! Arena temporary-storage TTL behaviour for commitments and choices (#1612).
//!
//! Unit-level storage tests: they exercise `ArenaStorage` directly inside an
//! `Env::default()` contract sandbox, with no cross-contract calls.

#![cfg(test)]

use soroban_sdk::testutils::{Address as _, Ledger as _};
use soroban_sdk::{Address, Env};

// ---------------------------------------------------------------------------
// #1612 — Arena temporary-storage TTL for commitments and choices
// ---------------------------------------------------------------------------

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
            env.ledger().with_mut(|li| li.sequence_number += 17_300);

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
