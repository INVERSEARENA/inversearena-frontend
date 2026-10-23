//! Exact-authorization tests for every `require_auth` site in the arena
//! (#1636). See `contract/test-support/auth.rs` for what these catch that
//! `mock_all_auths` cannot.
//!
//! The arena runs against a real token, vault, oracle and factory, so the
//! cross-contract authorizations are the real ones too: the arena
//! authorising the vault's pull of its entry fees, and the factory callbacks
//! (`release_arena`, `reclaim_creator_stake`, `update_arena_status`) that
//! accept the arena as their direct invoker. None of those may appear in the
//! human signer's tree, and each callback's effect is asserted.

#![cfg(test)]

extern crate std;

#[path = "../../test-support/auth.rs"]
mod auth;

use crate::types::Choice;
use crate::{ArenaContract, ArenaContractClient, EXPIRY_GRACE_SECONDS};
use ::factory::types::{ArenaStatus, PoolConfig};
use ::factory::{FactoryContract, FactoryContractClient};
use ::oracle::{OracleContract, OracleContractClient};
use ::rwa_adapter::{RwaAdapter, RwaAdapterClient};
use auth::{Call, assert_exact_auth, assert_rejects_signer, call, mint, new_token, sign};
use soroban_sdk::{
    Address, BytesN, Env, IntoVal, Symbol, Val, Vec,
    testutils::{Address as _, Ledger as _},
};

const FEE: i128 = 100;
const ROUND: u64 = 60;

struct Fx {
    env: Env,
    arena: Address,
    client: ArenaContractClient<'static>,
    admin: Address,
    factory: Address,
    factory_client: FactoryContractClient<'static>,
    token: Address,
    token_admin: Address,
    vault: Address,
    oracle: Address,
    intruder: Address,
}

impl Fx {
    fn tree(&self, fn_name: &'static str, args: impl IntoVal<Env, Vec<Val>>) -> Call {
        call(&self.env, &self.arena, fn_name, args)
    }

    /// Run a setup step signed by `signer`.
    fn signed<T>(&self, signer: &Address, tree: Call, step: impl FnOnce() -> T) -> T {
        sign(&self.env, signer, &tree);
        step()
    }

    fn join_tree(&self, player: &Address) -> Call {
        self.tree("join_arena", (player.clone(),)).with(call(
            &self.env,
            &self.token,
            "transfer",
            (player.clone(), self.arena.clone(), FEE),
        ))
    }

    fn join(&self, player: &Address) {
        mint(&self.env, &self.token, &self.token_admin, player, FEE);
        self.signed(player, self.join_tree(player), || self.client.join_arena(player));
    }

    fn players(&self, n: usize) -> std::vec::Vec<Address> {
        (0..n)
            .map(|_| {
                let player = Address::generate(&self.env);
                self.join(&player);
                player
            })
            .collect()
    }

    fn start_round(&self) {
        self.signed(&self.admin, self.tree("start_round", (ROUND,)), || {
            self.client.start_round(&ROUND)
        });
    }

    fn commitment(
        &self,
        player: &Address,
        choice: Choice,
        salt: &BytesN<32>,
    ) -> BytesN<32> {
        ArenaContract::compute_commitment(&self.env, &self.arena, 1, player, choice, salt)
    }

    fn commit(&self, player: &Address, choice: Choice, salt: &BytesN<32>) {
        let commitment = self.commitment(player, choice, salt);
        self.signed(
            player,
            self.tree("submit_commitment", (player.clone(), commitment.clone())),
            || self.client.submit_commitment(player, &commitment),
        );
    }

    fn reveal(&self, player: &Address, choice: Choice, salt: &BytesN<32>) {
        self.signed(
            player,
            self.tree("reveal_choice", (player.clone(), choice, salt.clone())),
            || self.client.reveal_choice(player, &choice, salt),
        );
    }

    fn advance(&self, seconds: u64) {
        self.env.ledger().with_mut(|li| li.timestamp += seconds);
    }

    /// Publish a fresh oracle observation so `resolve_round` passes its
    /// freshness check (#1512).
    fn refresh_oracle(&self) {
        let tree = call(&self.env, &self.oracle, "set_yield_bps", (0u32,));
        self.signed(&self.admin, tree, || {
            OracleContractClient::new(&self.env, &self.oracle).set_yield_bps(&0)
        });
    }

    fn resolve(&self) {
        self.refresh_oracle();
        self.signed(&self.admin, self.tree("resolve_round", ()), || {
            self.client.resolve_round()
        });
    }

    /// Three players; the lone Tails voter wins round one. Returns the winner.
    fn finished(&self) -> Address {
        let players = self.players(3);
        self.start_round();
        let choices = [Choice::Tails, Choice::Heads, Choice::Heads];
        let salts: std::vec::Vec<BytesN<32>> =
            (1..=3u8).map(|i| BytesN::from_array(&self.env, &[i; 32])).collect();
        for i in 0..3 {
            self.commit(&players[i], choices[i], &salts[i]);
        }
        self.advance(ROUND);
        for i in 0..3 {
            self.reveal(&players[i], choices[i], &salts[i]);
        }
        self.resolve();
        players[0].clone()
    }

    fn cancelled_with(&self, player: &Address) {
        self.join(player);
        self.join(&Address::generate(&self.env));
        self.signed(&self.admin, self.tree("cancel_arena", ()), || self.client.cancel_arena());
    }

    /// The factory still counts this arena as live and holds its stake.
    fn factory_tracks_arena(&self) -> bool {
        self.factory_client.get_creator_stake(&self.arena).is_some()
    }

    fn factory_status(&self) -> ArenaStatus {
        self.factory_client.get_arena(&1).expect("pool registered").status
    }
}

/// An initialised arena wired to a real token, vault and oracle.
///
/// With `factory_is_contract`, a real factory deploys the arena from its wasm
/// through `create_pool`, signed by the host exactly as a wallet would sign
/// it, so the factory holds the creator stake and the pool record. Otherwise
/// the arena is registered directly with a plain address as its factory.
fn setup(factory_is_contract: bool) -> Fx {
    let env = Env::default();
    let (token, token_admin) = new_token(&env);
    let admin = Address::generate(&env);

    let oracle = env.register(OracleContract, ());
    sign(&env, &admin, &call(&env, &oracle, "initialize", (admin.clone(), 0u32)));
    OracleContractClient::new(&env, &oracle).initialize(&admin, &0);

    let vault = env.register(RwaAdapter, ());
    sign(
        &env,
        &admin,
        &call(&env, &vault, "initialize", (admin.clone(), token.clone(), oracle.clone())),
    );
    RwaAdapterClient::new(&env, &vault).initialize(&admin, &token, &oracle);

    if factory_is_contract {
        let factory = env.register(FactoryContract, ());
        let factory_client = FactoryContractClient::new(&env, &factory);
        configure_factory(&env, &factory, &factory_client, &admin, &token, &vault, &oracle);
        mint(&env, &token, &token_admin, &admin, FEE);
        let cfg = pool_config(&env, &token, &vault, &oracle);
        let tree = create_pool_tree(&env, &factory, &admin, &cfg, &token, &vault, &oracle);
        sign(&env, &admin, &tree);
        let arena = factory_client.create_pool(&admin, &cfg, &metadata(&env));
        return Fx {
            client: ArenaContractClient::new(&env, &arena),
            intruder: Address::generate(&env),
            env,
            arena,
            admin,
            factory,
            factory_client,
            token,
            token_admin,
            vault,
            oracle,
        };
    }

    let factory = Address::generate(&env);
    let arena = env.register(ArenaContract, ());
    let client = ArenaContractClient::new(&env, &arena);
    let init_args = (
        admin.clone(),
        token.clone(),
        vault.clone(),
        FEE,
        oracle.clone(),
        factory.clone(),
        1u32,
        2u32,
        10u32,
        ROUND,
    );
    sign(&env, &admin, &call(&env, &arena, "initialize", init_args));
    client.initialize(&admin, &token, &vault, &FEE, &oracle, &factory, &1, &2, &10, &ROUND);
    Fx {
        factory_client: FactoryContractClient::new(&env, &factory),
        intruder: Address::generate(&env),
        env,
        arena,
        client,
        admin,
        factory,
        token,
        token_admin,
        vault,
        oracle,
    }
}

/// Approve everything `create_pool` checks, each step signed by the
/// protocol admin.
fn configure_factory(
    env: &Env,
    factory: &Address,
    client: &FactoryContractClient<'static>,
    host: &Address,
    token: &Address,
    vault: &Address,
    oracle: &Address,
) {
    let protocol_admin = Address::generate(env);
    let step = |fn_name: &'static str, args: Vec<Val>| {
        sign(env, &protocol_admin, &call(env, factory, fn_name, args));
    };
    step("initialize", (protocol_admin.clone(), 1i128).into_val(env));
    client.initialize(&protocol_admin, &1);
    step("add_to_whitelist", (host.clone(),).into_val(env));
    client.add_to_whitelist(host);
    step("add_supported_token", (token.clone(),).into_val(env));
    client.add_supported_token(token);
    step("add_approved_vault", (vault.clone(),).into_val(env));
    client.add_approved_vault(vault);
    step("add_approved_oracle", (oracle.clone(),).into_val(env));
    client.add_approved_oracle(oracle);
    let wasm = env.deployer().upload_contract_wasm(crate::WASM);
    step("set_arena_wasm_hash", (wasm.clone(),).into_val(env));
    client.set_arena_wasm_hash(&wasm);
}

fn pool_config(env: &Env, token: &Address, vault: &Address, oracle: &Address) -> PoolConfig {
    PoolConfig {
        stake_token: token.clone(),
        yield_vault: vault.clone(),
        entry_fee: FEE,
        oracle_contract: oracle.clone(),
        min_players: 2,
        max_players: 10,
        round_duration: ROUND,
        start_deadline: env.ledger().timestamp() + 86_400,
    }
}

fn metadata(env: &Env) -> BytesN<32> {
    BytesN::from_array(env, &[7u8; 32])
}

/// What the host signs for `create_pool` of pool 1: the call itself, the
/// transfer of their creator stake into the factory, and the new arena's
/// `initialize` naming them admin. `set_start_deadline` is authorised by the
/// factory as direct invoker and must not appear.
fn create_pool_tree(
    env: &Env,
    factory: &Address,
    host: &Address,
    cfg: &PoolConfig,
    token: &Address,
    vault: &Address,
    oracle: &Address,
) -> Call {
    let mut salt = [0u8; 32];
    salt[31] = 1;
    let arena = env
        .deployer()
        .with_address(factory.clone(), BytesN::from_array(env, &salt))
        .deployed_address();
    call(env, factory, "create_pool", (host.clone(), cfg.clone(), metadata(env)))
        .with(call(env, token, "transfer", (host.clone(), factory.clone(), FEE)))
        .with(call(
            env,
            &arena,
            "initialize",
            (
                host.clone(),
                token.clone(),
                vault.clone(),
                FEE,
                oracle.clone(),
                factory.clone(),
                1u32,
                2u32,
                10u32,
                ROUND,
            ),
        ))
}

fn fixture() -> Fx {
    setup(true)
}

// ── Admin-gated configuration ────────────────────────────────────────────────

#[test]
fn initialize_requires_exactly_the_admin() {
    let env = Env::default();
    let arena = env.register(ArenaContract, ());
    let client = ArenaContractClient::new(&env, &arena);
    let (token, _) = new_token(&env);
    let admin = Address::generate(&env);
    let intruder = Address::generate(&env);
    let oracle = env.register(OracleContract, ());
    let vault = env.register(RwaAdapter, ());
    let factory = Address::generate(&env);
    let args = (
        admin.clone(),
        token.clone(),
        vault.clone(),
        FEE,
        oracle.clone(),
        factory.clone(),
        1u32,
        2u32,
        10u32,
        ROUND,
    );
    let tree = call(&env, &arena, "initialize", args);
    let invoke = || {
        client
            .try_initialize(&admin, &token, &vault, &FEE, &oracle, &factory, &1, &2, &10, &ROUND)
            .is_ok()
    };
    assert_rejects_signer(&env, &intruder, &tree, invoke);
    assert_exact_auth(&env, &admin, &tree, invoke);
}

#[test]
fn factory_create_pool_requires_exactly_the_host_and_their_stake_and_arena_init() {
    let env = Env::default();
    let (token, token_admin) = new_token(&env);
    let host = Address::generate(&env);
    let intruder = Address::generate(&env);
    let oracle = env.register(OracleContract, ());
    sign(&env, &host, &call(&env, &oracle, "initialize", (host.clone(), 0u32)));
    OracleContractClient::new(&env, &oracle).initialize(&host, &0);
    let vault = env.register(RwaAdapter, ());
    sign(&env, &host, &call(&env, &vault, "initialize", (host.clone(), token.clone(), oracle.clone())));
    RwaAdapterClient::new(&env, &vault).initialize(&host, &token, &oracle);
    let factory = env.register(FactoryContract, ());
    let client = FactoryContractClient::new(&env, &factory);
    configure_factory(&env, &factory, &client, &host, &token, &vault, &oracle);
    mint(&env, &token, &token_admin, &host, FEE);
    // The intruder is whitelisted too, so only authorization tells them apart.
    let cfg = pool_config(&env, &token, &vault, &oracle);
    let tree = create_pool_tree(&env, &factory, &host, &cfg, &token, &vault, &oracle);
    let invoke = || client.try_create_pool(&host, &cfg, &metadata(&env)).is_ok();
    assert_rejects_signer(&env, &intruder, &tree, invoke);
    assert_exact_auth(&env, &host, &tree, invoke);
    let arena = client.get_arena(&1).expect("pool recorded").arena_address;
    assert_eq!(ArenaContractClient::new(&env, &arena).get_start_deadline(), cfg.start_deadline);
}

#[test]
fn propose_upgrade_requires_exactly_the_admin() {
    let fx = fixture();
    let hash = fx.env.deployer().upload_contract_wasm(crate::WASM);
    let tree = fx.tree("propose_upgrade", (hash.clone(),));
    let invoke = || fx.client.try_propose_upgrade(&hash).is_ok();
    assert_rejects_signer(&fx.env, &fx.intruder, &tree, invoke);
    assert_exact_auth(&fx.env, &fx.admin, &tree, invoke);
}

#[test]
fn execute_upgrade_requires_exactly_the_admin() {
    let fx = fixture();
    let hash = fx.env.deployer().upload_contract_wasm(crate::WASM);
    fx.signed(&fx.admin, fx.tree("propose_upgrade", (hash.clone(),)), || {
        fx.client.propose_upgrade(&hash)
    });
    fx.advance(86_400);
    let tree = fx.tree("execute_upgrade", ());
    let invoke = || fx.client.try_execute_upgrade().is_ok();
    assert_rejects_signer(&fx.env, &fx.intruder, &tree, invoke);
    assert_exact_auth(&fx.env, &fx.admin, &tree, invoke);
}

#[test]
fn configure_player_limits_requires_exactly_the_admin() {
    let fx = fixture();
    let tree = fx.tree("configure_player_limits", (3u32, 20u32));
    let invoke = || fx.client.try_configure_player_limits(&3, &20).is_ok();
    assert_rejects_signer(&fx.env, &fx.intruder, &tree, invoke);
    assert_exact_auth(&fx.env, &fx.admin, &tree, invoke);
}

#[test]
fn set_start_deadline_requires_exactly_the_factory() {
    // `mock_auths` installs an account at the signer address, so the factory
    // here is a plain address; the real factory calling this as the direct
    // invoker is covered by the factory's `create_pool` auth test.
    let fx = setup(false);
    let tree = fx.tree("set_start_deadline", (5_000u64,));
    let invoke = || fx.client.try_set_start_deadline(&5_000).is_ok();
    // The arena's own admin (the host) must not be able to move the deadline.
    assert_rejects_signer(&fx.env, &fx.admin, &tree, invoke);
    assert_exact_auth(&fx.env, &fx.factory, &tree, invoke);
    assert_eq!(fx.client.get_start_deadline(), 5_000);
}

#[test]
fn ban_player_requires_exactly_the_admin_and_refunds_without_player_auth() {
    let fx = fixture();
    let player = Address::generate(&fx.env);
    fx.join(&player);
    let tree = fx.tree("ban_player", (player.clone(),));
    let invoke = || fx.client.try_ban_player(&player).is_ok();
    assert_rejects_signer(&fx.env, &fx.intruder, &tree, invoke);
    assert_exact_auth(&fx.env, &fx.admin, &tree, invoke);
    assert_eq!(soroban_sdk::token::TokenClient::new(&fx.env, &fx.token).balance(&player), FEE);
}

#[test]
fn unban_player_requires_exactly_the_admin() {
    let fx = fixture();
    let player = Address::generate(&fx.env);
    let tree = fx.tree("unban_player", (player.clone(),));
    let invoke = || fx.client.try_unban_player(&player).is_ok();
    assert_rejects_signer(&fx.env, &fx.intruder, &tree, invoke);
    assert_exact_auth(&fx.env, &fx.admin, &tree, invoke);
}

#[test]
fn configure_leaderboard_limit_requires_exactly_the_admin() {
    let fx = fixture();
    let tree = fx.tree("configure_leaderboard_limit", (5u32,));
    let invoke = || fx.client.try_configure_leaderboard_limit(&5).is_ok();
    assert_rejects_signer(&fx.env, &fx.intruder, &tree, invoke);
    assert_exact_auth(&fx.env, &fx.admin, &tree, invoke);
}

#[test]
fn update_platform_fee_requires_exactly_the_admin() {
    let fx = fixture();
    let tree = fx.tree("update_platform_fee", (250u32,));
    let invoke = || fx.client.try_update_platform_fee(&250).is_ok();
    assert_rejects_signer(&fx.env, &fx.intruder, &tree, invoke);
    assert_exact_auth(&fx.env, &fx.admin, &tree, invoke);
}

#[test]
fn set_oracle_freshness_policy_requires_exactly_the_admin() {
    let fx = fixture();
    let tree = fx.tree("set_oracle_freshness_policy", (600u64, 300u64));
    let invoke = || fx.client.try_set_oracle_freshness_policy(&600, &300).is_ok();
    assert_rejects_signer(&fx.env, &fx.intruder, &tree, invoke);
    assert_exact_auth(&fx.env, &fx.admin, &tree, invoke);
}

#[test]
fn pause_and_unpause_require_exactly_the_admin() {
    let fx = fixture();
    let reason = Symbol::new(&fx.env, "maint");
    let tree = fx.tree("pause", (reason.clone(),));
    let invoke = || fx.client.try_pause(&reason).is_ok();
    assert_rejects_signer(&fx.env, &fx.intruder, &tree, invoke);
    assert_exact_auth(&fx.env, &fx.admin, &tree, invoke);

    let tree = fx.tree("unpause", ());
    let invoke = || fx.client.try_unpause().is_ok();
    assert_rejects_signer(&fx.env, &fx.intruder, &tree, invoke);
    assert_exact_auth(&fx.env, &fx.admin, &tree, invoke);
}

#[test]
fn propose_admin_and_its_change_admin_alias_require_exactly_the_admin() {
    let fx = fixture();
    let next = Address::generate(&fx.env);
    let tree = fx.tree("propose_admin", (next.clone(),));
    let invoke = || fx.client.try_propose_admin(&next).is_ok();
    assert_rejects_signer(&fx.env, &fx.intruder, &tree, invoke);
    assert_exact_auth(&fx.env, &fx.admin, &tree, invoke);

    let tree = fx.tree("change_admin", (next.clone(),));
    let invoke = || fx.client.try_change_admin(&next).is_ok();
    assert_rejects_signer(&fx.env, &fx.intruder, &tree, invoke);
    assert_exact_auth(&fx.env, &fx.admin, &tree, invoke);
}

#[test]
fn accept_admin_requires_exactly_the_proposed_admin() {
    let fx = fixture();
    let next = Address::generate(&fx.env);
    fx.signed(&fx.admin, fx.tree("propose_admin", (next.clone(),)), || {
        fx.client.propose_admin(&next)
    });
    let tree = fx.tree("accept_admin", ());
    let invoke = || fx.client.try_accept_admin().is_ok();
    assert_rejects_signer(&fx.env, &fx.admin, &tree, invoke);
    assert_exact_auth(&fx.env, &next, &tree, invoke);
}

// ── Player entry points ──────────────────────────────────────────────────────

#[test]
fn join_arena_requires_the_player_for_the_call_and_their_fee_transfer_only() {
    let fx = fixture();
    let player = Address::generate(&fx.env);
    mint(&fx.env, &fx.token, &fx.token_admin, &player, FEE);
    // The vault's pull of the fee from the arena is authorised by the arena
    // itself (`authorize_as_current_contract`), so it must not appear here.
    let tree = fx.join_tree(&player);
    let invoke = || fx.client.try_join_arena(&player).is_ok();
    assert_rejects_signer(&fx.env, &fx.intruder, &tree, invoke);
    assert_exact_auth(&fx.env, &player, &tree, invoke);
    let token = soroban_sdk::token::TokenClient::new(&fx.env, &fx.token);
    assert_eq!(token.balance(&fx.vault), FEE, "the fee must reach the vault");
}

#[test]
fn leave_arena_requires_exactly_the_player() {
    let fx = fixture();
    let player = Address::generate(&fx.env);
    fx.join(&player);
    let tree = fx.tree("leave_arena", (player.clone(),));
    let invoke = || fx.client.try_leave_arena(&player).is_ok();
    assert_rejects_signer(&fx.env, &fx.intruder, &tree, invoke);
    // Another *joined* player cannot pull someone else out either.
    let other = Address::generate(&fx.env);
    fx.join(&other);
    assert_rejects_signer(&fx.env, &other, &tree, invoke);
    assert_exact_auth(&fx.env, &player, &tree, invoke);
}

#[test]
fn submit_commitment_requires_exactly_the_player() {
    let fx = fixture();
    let players = fx.players(2);
    fx.start_round();
    let commitment = fx.commitment(
        &players[0],
        Choice::Heads,
        &BytesN::from_array(&fx.env, &[9; 32]),
    );
    let tree = fx.tree("submit_commitment", (players[0].clone(), commitment.clone()));
    let invoke = || fx.client.try_submit_commitment(&players[0], &commitment).is_ok();
    assert_rejects_signer(&fx.env, &players[1], &tree, invoke);
    assert_exact_auth(&fx.env, &players[0], &tree, invoke);
}

#[test]
fn reveal_choice_requires_exactly_the_player() {
    let fx = fixture();
    let players = fx.players(2);
    fx.start_round();
    let salt = BytesN::from_array(&fx.env, &[9; 32]);
    fx.commit(&players[0], Choice::Heads, &salt);
    fx.advance(ROUND);
    let tree = fx.tree("reveal_choice", (players[0].clone(), Choice::Heads, salt.clone()));
    let invoke = || fx.client.try_reveal_choice(&players[0], &Choice::Heads, &salt).is_ok();
    assert_rejects_signer(&fx.env, &players[1], &tree, invoke);
    assert_exact_auth(&fx.env, &players[0], &tree, invoke);
}

#[test]
fn claim_requires_exactly_the_winner() {
    let fx = fixture();
    let winner = fx.finished();
    let tree = fx.tree("claim", (winner.clone(),));
    let invoke = || fx.client.try_claim(&winner).is_ok();
    assert_rejects_signer(&fx.env, &fx.intruder, &tree, invoke);
    // Not even the host can claim the prize on the winner's behalf.
    assert_rejects_signer(&fx.env, &fx.admin, &tree, invoke);
    assert_exact_auth(&fx.env, &winner, &tree, invoke);
    let token = soroban_sdk::token::TokenClient::new(&fx.env, &fx.token);
    assert_eq!(token.balance(&winner), 3 * FEE);
}

#[test]
fn claim_refund_requires_exactly_the_refunded_player() {
    let fx = fixture();
    let player = Address::generate(&fx.env);
    fx.cancelled_with(&player);
    let tree = fx.tree("claim_refund", (player.clone(),));
    let invoke = || fx.client.try_claim_refund(&player).is_ok();
    assert_rejects_signer(&fx.env, &fx.intruder, &tree, invoke);
    assert_exact_auth(&fx.env, &player, &tree, invoke);
}

// ── Lifecycle transitions and the factory callbacks they trigger ─────────────

#[test]
fn start_round_requires_exactly_the_admin() {
    let fx = fixture();
    fx.players(2);
    let tree = fx.tree("start_round", (ROUND,));
    let invoke = || fx.client.try_start_round(&ROUND).is_ok();
    assert_rejects_signer(&fx.env, &fx.intruder, &tree, invoke);
    assert_exact_auth(&fx.env, &fx.admin, &tree, invoke);
}

#[test]
fn resolve_round_requires_exactly_the_admin_and_arena_authorises_factory_callbacks() {
    let fx = fixture();
    let players = fx.players(3);
    fx.start_round();
    let salts: std::vec::Vec<BytesN<32>> =
        (1..=3u8).map(|i| BytesN::from_array(&fx.env, &[i; 32])).collect();
    let choices = [Choice::Tails, Choice::Heads, Choice::Heads];
    for i in 0..3 {
        fx.commit(&players[i], choices[i], &salts[i]);
    }
    fx.advance(ROUND);
    for i in 0..3 {
        fx.reveal(&players[i], choices[i], &salts[i]);
    }
    fx.refresh_oracle();

    let tree = fx.tree("resolve_round", ());
    let invoke = || fx.client.try_resolve_round().is_ok();
    assert_rejects_signer(&fx.env, &fx.intruder, &tree, invoke);
    assert!(fx.factory_tracks_arena(), "a rejected resolve must not reach the factory");
    // The admin signs resolve_round alone; the arena's own authority — not
    // the admin's — carries the release / reclaim / status callbacks.
    assert_exact_auth(&fx.env, &fx.admin, &tree, invoke);
    assert!(!fx.factory_tracks_arena(), "creator stake must be reclaimed on finish");
    assert_eq!(fx.factory_status(), ArenaStatus::Finished);
}

#[test]
fn cancel_arena_requires_exactly_the_admin_and_arena_authorises_factory_callbacks() {
    let fx = fixture();
    fx.players(2);
    let tree = fx.tree("cancel_arena", ());
    let invoke = || fx.client.try_cancel_arena().is_ok();
    assert_rejects_signer(&fx.env, &fx.intruder, &tree, invoke);
    assert!(fx.factory_tracks_arena());
    assert_exact_auth(&fx.env, &fx.admin, &tree, invoke);
    assert!(!fx.factory_tracks_arena(), "creator stake must be reclaimed on cancel");
    assert_eq!(fx.factory_status(), ArenaStatus::Cancelled);
    let token = soroban_sdk::token::TokenClient::new(&fx.env, &fx.token);
    assert_eq!(token.balance(&fx.admin), FEE, "the reclaimed stake goes to the creator");
}

#[test]
fn force_cancel_arena_requires_exactly_the_admin_and_arena_authorises_factory_callbacks() {
    let fx = fixture();
    fx.players(2);
    fx.start_round();
    let tree = fx.tree("force_cancel_arena", ());
    let invoke = || fx.client.try_force_cancel_arena().is_ok();
    assert_rejects_signer(&fx.env, &fx.intruder, &tree, invoke);
    assert_exact_auth(&fx.env, &fx.admin, &tree, invoke);
    assert!(!fx.factory_tracks_arena());
    assert_eq!(fx.factory_status(), ArenaStatus::Cancelled);
}

/// The permissionless lifecycle exits need no signer at all, yet still move
/// funds and notify the factory under the arena's own authority.
#[test]
fn permissionless_exits_need_no_signature_and_still_reach_the_factory() {
    let fx = fixture();
    fx.players(2);
    fx.start_round();
    fx.advance(ROUND + 1 + EXPIRY_GRACE_SECONDS);
    fx.env.set_auths(&[]);
    fx.client.expire_arena();
    assert!(fx.env.auths().is_empty(), "expire_arena must not require any signature");
    assert!(!fx.factory_tracks_arena());
    assert_eq!(fx.factory_status(), ArenaStatus::Cancelled);
}
