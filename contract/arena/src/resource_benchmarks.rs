//! Resource cost benchmark test suite for Arena contract entrypoints (#1649).
//!
//! Measures Soroban execution resources (`instructions`, `read_entries`, `write_entries`,
//! `read_bytes`, `write_bytes`) using `env.cost_estimate().resources()`.
//! Output is formatted as `[RESOURCE_BENCHMARK]` JSON lines for CI regression evaluation.

#![cfg(test)]

extern crate std;

use super::*;
use soroban_sdk::{
    Address, BytesN, Env, contract, contractimpl,
    testutils::{Address as _, Ledger as _},
    token::StellarAssetClient,
};
use crate::storage::ArenaStorage;
use crate::types::{ArenaConfig, Choice, GameState};

#[contract]
struct BenchVault;

#[contractimpl]
impl BenchVault {
    pub fn deposit(_env: Env, _from: Address, _amount: i128) {}
    pub fn balance_of(_env: Env, _user: Address) -> i128 {
        0
    }
    pub fn withdraw_all(_env: Env, _user: Address) -> i128 {
        0
    }
}

#[contract]
struct BenchOracle;

#[contractimpl]
impl BenchOracle {
    pub fn get_current_yield_bps(_env: Env) -> u32 {
        500
    }

    pub fn get_oracle_reading(env: Env) -> oracle::OracleReading {
        oracle::OracleReading {
            rate_bps: 500,
            observed_at: env.ledger().timestamp(),
            source_version: 1,
        }
    }
}

struct Metric {
    entrypoint: &'static str,
    instructions: i64,
    read_entries: u32,
    write_entries: u32,
    read_bytes: u32,
    write_bytes: u32,
}

fn bench_join() -> Metric {
    let env = Env::default();
    env.mock_all_auths();
    let contract_id = env.register(ArenaContract, ());
    let vault_id = env.register(BenchVault, ());
    let oracle_id = env.register(BenchOracle, ());

    let admin = Address::generate(&env);
    let sac = env.register_stellar_asset_contract_v2(admin.clone());
    let token_id = sac.address();

    env.as_contract(&contract_id, || {
        let config = ArenaConfig {
            admin: admin.clone(),
            stake_token: token_id.clone(),
            entry_fee: 100,
            state: GameState::Open,
            paused: false,
            player_count: 0,
            active_player_count: 0,
            cumulative_yield: 0,
            commit_deadline: u64::MAX,
            yield_vault: vault_id,
            round_count: 0,
            oracle_contract: oracle_id,
            factory: Address::generate(&env),
            pool_id: 0,
            platform_fee_bps: 1000,
        };
        ArenaStorage::save_config(&env, &config);
        ArenaStorage::save_last_vault_balance(&env, 0);
    });

    let player = Address::generate(&env);
    StellarAssetClient::new(&env, &token_id).mint(&player, &100);

    let client = ArenaContractClient::new(&env, &contract_id);
    client.join_arena(&player);
    let res = env.cost_estimate().resources();

    Metric {
        entrypoint: "join",
        instructions: res.instructions,
        read_entries: res.read_entries,
        write_entries: res.write_entries,
        read_bytes: res.read_bytes,
        write_bytes: res.write_bytes,
    }
}

fn bench_commit() -> Metric {
    let env = Env::default();
    env.mock_all_auths();
    let contract_id = env.register(ArenaContract, ());
    let vault_id = env.register(BenchVault, ());
    let oracle_id = env.register(BenchOracle, ());
    let admin = Address::generate(&env);
    let token_id = Address::generate(&env);

    let p1 = Address::generate(&env);
    let p2 = Address::generate(&env);
    let start_ts = 1_000_000u64;
    let duration = 60u64;

    env.as_contract(&contract_id, || {
        let config = ArenaConfig {
            admin: admin.clone(),
            stake_token: token_id.clone(),
            entry_fee: 100,
            state: GameState::Active,
            paused: false,
            player_count: 2,
            active_player_count: 2,
            cumulative_yield: 0,
            commit_deadline: start_ts + duration,
            yield_vault: vault_id,
            round_count: 0,
            oracle_contract: oracle_id,
            factory: Address::generate(&env),
            pool_id: 0,
            platform_fee_bps: 1000,
        };
        ArenaStorage::save_config(&env, &config);
        ArenaStorage::add_player(&env, &p1);
        ArenaStorage::add_player(&env, &p2);
        ArenaStorage::save_round_start(&env, start_ts);
        ArenaStorage::save_round_duration(&env, duration);
    });

    env.ledger().with_mut(|li| li.timestamp = start_ts + 10);
    let salt = BytesN::from_array(&env, &[1u8; 32]);
    let commitment = ArenaContract::compute_commitment(&env, Choice::Heads, &salt);

    let client = ArenaContractClient::new(&env, &contract_id);
    client.submit_commitment(&p1, &commitment);
    let res = env.cost_estimate().resources();

    Metric {
        entrypoint: "commit",
        instructions: res.instructions,
        read_entries: res.read_entries,
        write_entries: res.write_entries,
        read_bytes: res.read_bytes,
        write_bytes: res.write_bytes,
    }
}

fn bench_reveal() -> Metric {
    let env = Env::default();
    env.mock_all_auths();
    let contract_id = env.register(ArenaContract, ());
    let vault_id = env.register(BenchVault, ());
    let oracle_id = env.register(BenchOracle, ());
    let admin = Address::generate(&env);
    let token_id = Address::generate(&env);

    let p1 = Address::generate(&env);
    let p2 = Address::generate(&env);
    let start_ts = 1_000_000u64;
    let duration = 60u64;
    let deadline = start_ts + duration;
    let salt = BytesN::from_array(&env, &[2u8; 32]);

    env.as_contract(&contract_id, || {
        let config = ArenaConfig {
            admin: admin.clone(),
            stake_token: token_id.clone(),
            entry_fee: 100,
            state: GameState::Active,
            paused: false,
            player_count: 2,
            active_player_count: 2,
            cumulative_yield: 0,
            commit_deadline: deadline,
            yield_vault: vault_id,
            round_count: 0,
            oracle_contract: oracle_id,
            factory: Address::generate(&env),
            pool_id: 0,
            platform_fee_bps: 1000,
        };
        ArenaStorage::save_config(&env, &config);
        ArenaStorage::add_player(&env, &p1);
        ArenaStorage::add_player(&env, &p2);
        ArenaStorage::save_round_start(&env, start_ts);
        ArenaStorage::save_round_duration(&env, duration);

        let commitment = ArenaContract::compute_commitment(&env, Choice::Tails, &salt);
        ArenaStorage::save_commitment(&env, &p1, 1, &commitment);
    });

    // Advance to deadline so reveal window is open
    env.ledger().with_mut(|li| li.timestamp = deadline);

    let client = ArenaContractClient::new(&env, &contract_id);
    client.reveal_choice(&p1, &Choice::Tails, &salt);
    let res = env.cost_estimate().resources();

    Metric {
        entrypoint: "reveal",
        instructions: res.instructions,
        read_entries: res.read_entries,
        write_entries: res.write_entries,
        read_bytes: res.read_bytes,
        write_bytes: res.write_bytes,
    }
}

fn bench_resolve(num_players: u32, entrypoint_label: &'static str) -> Metric {
    let env = Env::default();
    env.mock_all_auths();
    let contract_id = env.register(ArenaContract, ());
    let vault_id = env.register(BenchVault, ());
    let oracle_id = env.register(BenchOracle, ());
    let admin = Address::generate(&env);
    let token_id = Address::generate(&env);

    let start_ts = 1_000_000u64;
    let duration = 60u64;

    env.as_contract(&contract_id, || {
        let config = ArenaConfig {
            admin: admin.clone(),
            stake_token: token_id.clone(),
            entry_fee: 100,
            state: GameState::Active,
            paused: false,
            player_count: num_players,
            active_player_count: num_players,
            cumulative_yield: 0,
            commit_deadline: start_ts + duration,
            yield_vault: vault_id,
            round_count: 0,
            oracle_contract: oracle_id,
            factory: Address::generate(&env),
            pool_id: 0,
            platform_fee_bps: 1000,
        };
        ArenaStorage::save_config(&env, &config);
        ArenaStorage::save_last_vault_balance(&env, 0);
        ArenaStorage::save_round_start(&env, start_ts);
        ArenaStorage::save_round_duration(&env, duration);

        for i in 0..num_players {
            let player = Address::generate(&env);
            ArenaStorage::add_player(&env, &player);
            // First 2 players choose Tails, rest choose Heads
            let choice = if i < 2 { Choice::Tails } else { Choice::Heads };
            ArenaStorage::save_choice(&env, &player, 1, &choice);
        }
    });

    // Advance past grace period
    env.ledger().with_mut(|li| li.timestamp = start_ts + duration * 2);

    let client = ArenaContractClient::new(&env, &contract_id);
    client.resolve_round();
    let res = env.cost_estimate().resources();

    Metric {
        entrypoint: entrypoint_label,
        instructions: res.instructions,
        read_entries: res.read_entries,
        write_entries: res.write_entries,
        read_bytes: res.read_bytes,
        write_bytes: res.write_bytes,
    }
}

fn bench_claim() -> Metric {
    let env = Env::default();
    env.mock_all_auths();
    let contract_id = env.register(ArenaContract, ());
    let vault_id = env.register(BenchVault, ());
    let oracle_id = env.register(BenchOracle, ());
    let admin = Address::generate(&env);
    let sac = env.register_stellar_asset_contract_v2(admin.clone());
    let token_id = sac.address();
    let winner = Address::generate(&env);

    env.as_contract(&contract_id, || {
        let config = ArenaConfig {
            admin: admin.clone(),
            stake_token: token_id.clone(),
            entry_fee: 100,
            state: GameState::Finished,
            paused: false,
            player_count: 10,
            active_player_count: 1,
            cumulative_yield: 50,
            commit_deadline: 0,
            yield_vault: vault_id,
            round_count: 3,
            oracle_contract: oracle_id,
            factory: Address::generate(&env),
            pool_id: 0,
            platform_fee_bps: 1000,
        };
        ArenaStorage::save_config(&env, &config);
        ArenaStorage::set_winner(&env, &winner);
    });

    // Mint funds to arena contract for winner payout
    StellarAssetClient::new(&env, &token_id).mint(&contract_id, &2000);

    let client = ArenaContractClient::new(&env, &contract_id);
    client.claim(&winner);
    let res = env.cost_estimate().resources();

    Metric {
        entrypoint: "claim",
        instructions: res.instructions,
        read_entries: res.read_entries,
        write_entries: res.write_entries,
        read_bytes: res.read_bytes,
        write_bytes: res.write_bytes,
    }
}

fn bench_refund() -> Metric {
    let env = Env::default();
    env.mock_all_auths();
    let contract_id = env.register(ArenaContract, ());
    let vault_id = env.register(BenchVault, ());
    let oracle_id = env.register(BenchOracle, ());
    let admin = Address::generate(&env);
    let sac = env.register_stellar_asset_contract_v2(admin.clone());
    let token_id = sac.address();
    let player = Address::generate(&env);

    env.as_contract(&contract_id, || {
        let config = ArenaConfig {
            admin: admin.clone(),
            stake_token: token_id.clone(),
            entry_fee: 100,
            state: GameState::Cancelled,
            paused: false,
            player_count: 2,
            active_player_count: 2,
            cumulative_yield: 0,
            commit_deadline: 0,
            yield_vault: vault_id,
            round_count: 0,
            oracle_contract: oracle_id,
            factory: Address::generate(&env),
            pool_id: 0,
            platform_fee_bps: 1000,
        };
        ArenaStorage::save_config(&env, &config);
        ArenaStorage::add_player(&env, &player);
    });

    StellarAssetClient::new(&env, &token_id).mint(&contract_id, &1000);

    let client = ArenaContractClient::new(&env, &contract_id);
    client.claim_refund(&player);
    let res = env.cost_estimate().resources();

    Metric {
        entrypoint: "refund",
        instructions: res.instructions,
        read_entries: res.read_entries,
        write_entries: res.write_entries,
        read_bytes: res.read_bytes,
        write_bytes: res.write_bytes,
    }
}

#[test]
fn benchmark_arena_resource_costs() {
    let metrics = [
        bench_join(),
        bench_commit(),
        bench_reveal(),
        bench_resolve(10, "resolve_10"),
        bench_resolve(100, "resolve_100"),
        bench_resolve(MAX_PLAYERS_ALLOWED, "resolve_max"),
        bench_claim(),
        bench_refund(),
    ];

    for m in &metrics {
        assert!(m.instructions > 0, "{} instructions must be > 0", m.entrypoint);
        assert!(m.read_entries > 0, "{} read_entries must be > 0", m.entrypoint);
        assert!(m.read_bytes > 0, "{} read_bytes must be > 0", m.entrypoint);
        std::println!(
            "[RESOURCE_BENCHMARK] {{\"entrypoint\":\"{}\",\"instructions\":{},\"read_entries\":{},\"write_entries\":{},\"read_bytes\":{},\"write_bytes\":{}}}",
            m.entrypoint,
            m.instructions,
            m.read_entries,
            m.write_entries,
            m.read_bytes,
            m.write_bytes
        );
    }
}
