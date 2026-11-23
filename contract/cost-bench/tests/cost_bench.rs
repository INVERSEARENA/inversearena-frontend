//! Resource cost benchmarks for the protocol's hot entry points (#1649).
//!
//! Every contract is registered from its compiled WASM (build it first:
//! `cargo build --workspace --target wasm32v1-none --release`), so
//! `env.cost_estimate().resources()` includes VM instantiation and execution.
//! Registering the native Rust contracts instead would silently drop those
//! costs.
//!
//! Each benchmark prints its measurement. When `COST_BENCH_OUT` names a
//! directory, it also writes `<name>.json` there for
//! `contract/scripts/cost-bench.mjs`, which compares the results against
//! `contract/cost-baseline.json`.

use arena::types::Choice;
use arena::{ArenaContractClient, MAX_PLAYERS_ALLOWED};
use factory::FactoryContractClient;
use oracle::OracleContractClient;
use rwa_adapter::RwaAdapterClient;
use soroban_sdk::testutils::{Address as _, Ledger as _};
use soroban_sdk::token::StellarAssetClient;
use soroban_sdk::{Address, Bytes, BytesN, Env};
use staking::StakingContractClient;

const ARENA_WASM: &[u8] = include_bytes!("../../target/wasm32v1-none/release/arena.wasm");
const FACTORY_WASM: &[u8] = include_bytes!("../../target/wasm32v1-none/release/factory.wasm");
const ORACLE_WASM: &[u8] = include_bytes!("../../target/wasm32v1-none/release/oracle.wasm");
const RWA_WASM: &[u8] = include_bytes!("../../target/wasm32v1-none/release/rwa_adapter.wasm");
const STAKING_WASM: &[u8] = include_bytes!("../../target/wasm32v1-none/release/staking.wasm");

const ENTRY_FEE: i128 = 10_000_000;
const ROUND_SECONDS: u64 = 3_600;
const START_TS: u64 = 1_000;

/// Record the resources of the most recent top-level invocation.
fn record(env: &Env, name: &str, players: u32) {
    let r = env.cost_estimate().resources();
    let fee = env.cost_estimate().fee().total;
    let json = format!(
        concat!(
            "{{\"name\":\"{}\",\"players\":{},\"instructions\":{},\"mem_bytes\":{},",
            "\"read_entries\":{},\"write_entries\":{},\"read_bytes\":{},\"write_bytes\":{},",
            "\"events_bytes\":{},\"fee_stroops\":{}}}"
        ),
        name,
        players,
        r.instructions,
        r.mem_bytes,
        r.read_entries,
        r.write_entries,
        r.read_bytes,
        r.write_bytes,
        r.contract_events_size_bytes,
        fee,
    );
    println!("cost-bench {json}");
    if let Ok(dir) = std::env::var("COST_BENCH_OUT") {
        std::fs::create_dir_all(&dir).expect("create COST_BENCH_OUT");
        let file = format!("{}_{players}.json", name.replace('/', "_"));
        std::fs::write(std::path::Path::new(&dir).join(file), json).expect("write benchmark result");
    }
}

fn commitment(env: &Env, choice: Choice, salt: &BytesN<32>) -> BytesN<32> {
    let mut preimage = Bytes::new(env);
    preimage.push_back(choice.to_byte());
    preimage.extend_from_array(&salt.to_array());
    env.crypto().sha256(&preimage).into()
}

fn salt(env: &Env, i: u32) -> BytesN<32> {
    let mut bytes = [0u8; 32];
    bytes[..4].copy_from_slice(&i.to_be_bytes());
    BytesN::from_array(env, &bytes)
}

/// One arena deployed from WASM against WASM factory, oracle and vault.
struct ArenaBench {
    env: Env,
    arena: ArenaContractClient<'static>,
    oracle: OracleContractClient<'static>,
    vault: Address,
    token: StellarAssetClient<'static>,
    players: std::vec::Vec<Address>,
}

impl ArenaBench {
    fn new() -> Self {
        let env = Env::default();
        // Measure, don't enforce: resolve_round at 50+ players exceeds the
        // 100M-instruction transaction limit today, and the benchmark must
        // still record it. cost-bench.mjs flags results over network limits.
        env.cost_estimate().budget().reset_unlimited();
        env.mock_all_auths_allowing_non_root_auth();
        env.ledger().with_mut(|l| l.timestamp = START_TS);
        let admin = Address::generate(&env);

        let token_id = env
            .register_stellar_asset_contract_v2(Address::generate(&env))
            .address();
        let token = StellarAssetClient::new(&env, &token_id);

        let factory = FactoryContractClient::new(&env, &env.register(FACTORY_WASM, ()));
        factory.initialize(&admin, &ENTRY_FEE);

        let oracle = OracleContractClient::new(&env, &env.register(ORACLE_WASM, ()));
        oracle.initialize(&admin, &500);

        let vault = env.register(RWA_WASM, ());
        RwaAdapterClient::new(&env, &vault).initialize(&admin, &token_id, &oracle.address);

        let arena = ArenaContractClient::new(&env, &env.register(ARENA_WASM, ()));
        arena.initialize(
            &admin,
            &token_id,
            &vault,
            &ENTRY_FEE,
            &oracle.address,
            &factory.address,
            &1,
            &2,
            &MAX_PLAYERS_ALLOWED,
            &ROUND_SECONDS,
        );

        ArenaBench {
            env,
            arena,
            oracle,
            vault,
            token,
            players: std::vec::Vec::new(),
        }
    }

    /// Join `n` players; the last join is the measured one.
    fn join(&mut self, n: u32) {
        for _ in 0..n {
            let player = Address::generate(&self.env);
            self.token.mint(&player, &ENTRY_FEE);
            self.arena.join_arena(&player);
            self.players.push(player);
        }
    }

    /// Player 0 picks the minority choice, so it is the round's sole survivor.
    fn choice(i: usize) -> Choice {
        if i == 0 { Choice::Tails } else { Choice::Heads }
    }

    fn start(&self) {
        self.arena.start_round(&ROUND_SECONDS);
    }

    fn commit_all(&self) {
        for (i, player) in self.players.iter().enumerate() {
            let c = commitment(&self.env, Self::choice(i), &salt(&self.env, i as u32));
            self.arena.submit_commitment(player, &c);
        }
    }

    fn reveal_all(&self) {
        self.env
            .ledger()
            .with_mut(|l| l.timestamp = START_TS + ROUND_SECONDS + 1);
        for (i, player) in self.players.iter().enumerate() {
            self.arena
                .reveal_choice(player, &Self::choice(i), &salt(&self.env, i as u32));
        }
    }

    fn resolve(&self) {
        // Refresh the oracle observation so the #1512 freshness check passes.
        self.oracle.set_yield_bps(&500);
        self.arena.resolve_round();
    }
}

/// join, commit, reveal and resolve at one roster size, then claim.
fn bench_round(players: u32) {
    let mut b = ArenaBench::new();
    b.join(players);
    record(&b.env, "arena/join_arena", players);
    b.start();
    b.commit_all();
    record(&b.env, "arena/submit_commitment", players);
    b.reveal_all();
    record(&b.env, "arena/reveal_choice", players);
    b.resolve();
    record(&b.env, "arena/resolve_round", players);

    let winner = b.players[0].clone();
    b.arena.claim(&winner);
    record(&b.env, "arena/claim", players);
    // The payout includes whatever the vault returned; the benchmark only
    // asserts the call succeeded and paid the winner.
    assert!(soroban_sdk::token::TokenClient::new(&b.env, &b.token.address).balance(&winner) > 0);
    let _ = &b.vault;
}

#[test]
fn cost_bench_arena_round_10_players() {
    bench_round(10);
}

#[test]
fn cost_bench_arena_round_50_players() {
    bench_round(50);
}

#[test]
fn cost_bench_arena_round_max_players() {
    bench_round(MAX_PLAYERS_ALLOWED);
}

#[test]
fn cost_bench_arena_refund() {
    let mut b = ArenaBench::new();
    b.join(10);
    b.arena.force_cancel_arena();
    let player = b.players[9].clone();
    b.arena.claim_refund(&player);
    record(&b.env, "arena/claim_refund", 10);
}

#[test]
fn cost_bench_staking_stake_unstake() {
    let env = Env::default();
    env.mock_all_auths();
    let admin = Address::generate(&env);
    let token_id = env
        .register_stellar_asset_contract_v2(admin.clone())
        .address();
    let token = StellarAssetClient::new(&env, &token_id);
    let staking = StakingContractClient::new(&env, &env.register(STAKING_WASM, ()));
    staking.initialize(&admin, &token_id);

    // A second staker so the measured stake prices shares against an
    // existing pool rather than the first-deposit path.
    let seed = Address::generate(&env);
    token.mint(&seed, &ENTRY_FEE);
    staking.stake(&seed, &ENTRY_FEE);

    let staker = Address::generate(&env);
    token.mint(&staker, &ENTRY_FEE);
    let shares = staking.stake(&staker, &ENTRY_FEE);
    record(&env, "staking/stake", 2);

    staking.unstake(&staker, &shares);
    record(&env, "staking/unstake", 2);
}
