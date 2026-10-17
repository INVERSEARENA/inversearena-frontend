//! Resource cost benchmark test suite for Staking contract entrypoints (#1649).
//!
//! Measures Soroban execution resources (`instructions`, `read_entries`, `write_entries`,
//! `read_bytes`, `write_bytes`) using `env.cost_estimate().resources()`.
//! Output is formatted as `[RESOURCE_BENCHMARK]` JSON lines for CI regression evaluation.

#![cfg(test)]

extern crate std;

use super::*;
use soroban_sdk::{
    Address, Env,
    testutils::Address as _,
};

struct Metric {
    entrypoint: &'static str,
    instructions: i64,
    read_entries: u32,
    write_entries: u32,
    read_bytes: u32,
    write_bytes: u32,
}

fn bench_stake() -> Metric {
    let env = Env::default();
    env.mock_all_auths();
    let contract_id = env.register(StakingContract, ());
    let client = StakingContractClient::new(&env, &contract_id);
    let admin = Address::generate(&env);
    let sac = env.register_stellar_asset_contract_v2(admin.clone());
    let token = sac.address();
    let staker = Address::generate(&env);
    soroban_sdk::token::StellarAssetClient::new(&env, &token).mint(&staker, &100_000);
    client.initialize(&admin, &token);

    client.stake(&staker, &1_000);
    let res = env.cost_estimate().resources();

    Metric {
        entrypoint: "stake",
        instructions: res.instructions,
        read_entries: res.read_entries,
        write_entries: res.write_entries,
        read_bytes: res.read_bytes,
        write_bytes: res.write_bytes,
    }
}

fn bench_unstake() -> Metric {
    let env = Env::default();
    env.mock_all_auths();
    let contract_id = env.register(StakingContract, ());
    let client = StakingContractClient::new(&env, &contract_id);
    let admin = Address::generate(&env);
    let sac = env.register_stellar_asset_contract_v2(admin.clone());
    let token = sac.address();
    let staker = Address::generate(&env);
    soroban_sdk::token::StellarAssetClient::new(&env, &token).mint(&staker, &100_000);
    client.initialize(&admin, &token);
    let shares = client.stake(&staker, &1_000);

    client.unstake(&staker, &shares);
    let res = env.cost_estimate().resources();

    Metric {
        entrypoint: "unstake",
        instructions: res.instructions,
        read_entries: res.read_entries,
        write_entries: res.write_entries,
        read_bytes: res.read_bytes,
        write_bytes: res.write_bytes,
    }
}

#[test]
fn benchmark_staking_resource_costs() {
    let metrics = [
        bench_stake(),
        bench_unstake(),
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
