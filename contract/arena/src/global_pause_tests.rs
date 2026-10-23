//! Factory-wide emergency pause propagating to every arena (#1583).

#![cfg(test)]

extern crate std;

use super::*;
use ::factory::{FactoryContract, FactoryContractClient};
use soroban_sdk::{
    Address, Env, Symbol, contract, contractimpl,
    testutils::{Address as _, Ledger as _},
    token::StellarAssetClient,
};

/// `factory.wasm` must be built first (`cargo build -p factory --target
/// wasm32v1-none --release`), as Contract CI does, so the budget test measures
/// real WASM execution rather than the native test build.
const FACTORY_WASM: &[u8] = include_bytes!("../../target/wasm32v1-none/release/factory.wasm");

const ROUND_SECONDS: u64 = 60;

#[contract]
struct MockVault;

#[contractimpl]
impl MockVault {
    pub fn deposit(_env: Env, _from: Address, _amount: i128) {}

    pub fn balance_of(_env: Env, _user: Address) -> i128 {
        0
    }

    pub fn withdraw(_env: Env, _user: Address, amount: i128) -> i128 {
        amount
    }

    pub fn withdraw_all(_env: Env, _user: Address) -> i128 {
        0
    }
}

/// A factory deployment that predates `is_globally_paused`.
#[contract]
struct LegacyFactory;

#[contractimpl]
impl LegacyFactory {
    pub fn version(_env: Env) -> u32 {
        1
    }
}

struct Protocol {
    env: Env,
    factory: FactoryContractClient<'static>,
    token: Address,
    vault: Address,
}

impl Protocol {
    fn new() -> Self {
        Self::with_factory(|env| env.register(FactoryContract, ()))
    }

    fn with_factory(register: impl FnOnce(&Env) -> Address) -> Self {
        let env = Env::default();
        env.mock_all_auths_allowing_non_root_auth();
        let factory = FactoryContractClient::new(&env, &register(&env));
        let token = env
            .register_stellar_asset_contract_v2(Address::generate(&env))
            .address();
        let vault = env.register(MockVault, ());
        Protocol {
            env,
            factory,
            token,
            vault,
        }
    }

    fn initialize_factory(&self) {
        self.factory.initialize(&Address::generate(&self.env), &100);
    }

    fn arena(&self) -> ArenaContractClient<'static> {
        self.arena_from(self.env.register(ArenaContract, ()))
    }

    fn arena_from(&self, contract_id: Address) -> ArenaContractClient<'static> {
        let arena = ArenaContractClient::new(&self.env, &contract_id);
        arena.initialize(
            &Address::generate(&self.env),
            &self.token,
            &self.vault,
            &100,
            &Address::generate(&self.env),
            &self.factory.address,
            &1,
            &2,
            &10,
            &ROUND_SECONDS,
        );
        arena
    }

    fn player(&self) -> Address {
        let player = Address::generate(&self.env);
        StellarAssetClient::new(&self.env, &self.token).mint(&player, &100);
        player
    }

    fn pause(&self) {
        self.factory
            .set_global_pause(&true, &Symbol::new(&self.env, "incident"));
    }

    fn unpause(&self) {
        self.factory
            .set_global_pause(&false, &Symbol::new(&self.env, "resolved"));
    }

    fn salt(&self, byte: u8) -> BytesN<32> {
        BytesN::from_array(&self.env, &[byte; 32])
    }

    fn commitment(
        &self,
        arena: &Address,
        player: &Address,
        choice: Choice,
        salt: u8,
    ) -> BytesN<32> {
        ArenaContract::compute_commitment(&self.env, arena, 1, player, choice, &self.salt(salt))
    }

    fn advance(&self, seconds: u64) {
        self.env
            .ledger()
            .with_mut(|li| li.timestamp = li.timestamp.saturating_add(seconds));
    }

    /// Run `step` on every arena while globally paused (each must fail with
    /// `GloballyPaused`), then again after unpausing (each must succeed).
    fn blocked_then_allowed<E: core::fmt::Debug, T>(
        &self,
        arenas: &[&ArenaContractClient<'static>],
        step: impl Fn(&ArenaContractClient<'static>) -> Result<T, Result<ArenaError, E>>,
    ) {
        self.pause();
        for arena in arenas {
            assert!(matches!(step(arena), Err(Ok(ArenaError::GloballyPaused))));
        }
        self.unpause();
        for arena in arenas {
            assert!(step(arena).is_ok(), "step must succeed once unpaused");
        }
    }
}

fn unwrap_conversion<T, E>(
    result: Result<Result<T, soroban_sdk::ConversionError>, Result<ArenaError, E>>,
) -> Result<T, Result<ArenaError, E>> {
    result.map(|value| value.expect("return value decodes"))
}

#[test]
fn global_pause_blocks_join_commit_reveal_resolve_and_claim_on_two_arenas() {
    let protocol = Protocol::new();
    protocol.initialize_factory();
    let arena_a = protocol.arena();
    let arena_b = protocol.arena();
    let arenas = [&arena_a, &arena_b];

    // Per arena: one minority winner and two majority players.
    let players: std::vec::Vec<[Address; 3]> = arenas
        .iter()
        .map(|_| [protocol.player(), protocol.player(), protocol.player()])
        .collect();
    let player_of = |arena: &ArenaContractClient<'static>, index: usize| {
        let row = if arena.address == arena_a.address { 0 } else { 1 };
        players[row][index].clone()
    };
    let choice_of = |index: usize| if index == 0 { Choice::Tails } else { Choice::Heads };

    for index in 0..3 {
        protocol.blocked_then_allowed(&arenas, |arena| {
            unwrap_conversion(arena.try_join_arena(&player_of(arena, index)))
        });
    }

    protocol.blocked_then_allowed(&arenas, |arena| {
        unwrap_conversion(arena.try_start_round(&ROUND_SECONDS))
    });

    for index in 0..3 {
        protocol.blocked_then_allowed(&arenas, |arena| {
            let player = player_of(arena, index);
            let commitment =
                protocol.commitment(&arena.address, &player, choice_of(index), index as u8);
            unwrap_conversion(arena.try_submit_commitment(&player, &commitment))
        });
    }

    protocol.advance(ROUND_SECONDS);
    for index in 0..3 {
        protocol.blocked_then_allowed(&arenas, |arena| {
            unwrap_conversion(arena.try_reveal_choice(
                &player_of(arena, index),
                &choice_of(index),
                &protocol.salt(index as u8),
            ))
        });
    }

    protocol.blocked_then_allowed(&arenas, |arena| unwrap_conversion(arena.try_resolve_round()));

    protocol.blocked_then_allowed(&arenas, |arena| {
        unwrap_conversion(arena.try_claim(&player_of(arena, 0)))
    });
}

#[test]
fn refunds_stay_claimable_and_are_released_after_the_global_pause() {
    let protocol = Protocol::new();
    protocol.initialize_factory();
    let arena = protocol.arena();
    let player = protocol.player();
    arena.join_arena(&player);
    arena.join_arena(&protocol.player());

    // Cancelling and claiming both move funds, so both wait for the unpause.
    protocol.blocked_then_allowed(&[&arena], |arena| unwrap_conversion(arena.try_cancel_arena()));
    protocol.blocked_then_allowed(&[&arena], |arena| {
        unwrap_conversion(arena.try_claim_refund(&player))
    });

    // Nothing was lost: the refund was paid exactly once.
    let token = soroban_sdk::token::TokenClient::new(&protocol.env, &protocol.token);
    assert_eq!(token.balance(&player), 100);
    assert!(arena.get_player_status(&player).refund_claimed);
}

#[test]
fn global_pause_also_gates_host_moderation_and_force_cancel() {
    let protocol = Protocol::new();
    protocol.initialize_factory();
    let arena = protocol.arena();
    let banned = protocol.player();
    arena.join_arena(&banned);

    protocol.blocked_then_allowed(&[&arena], |arena| {
        unwrap_conversion(arena.try_ban_player(&banned))
    });
    protocol.blocked_then_allowed(&[&arena], |arena| {
        unwrap_conversion(arena.try_force_cancel_arena())
    });
}

#[test]
fn local_and_global_pauses_are_lifted_independently() {
    let protocol = Protocol::new();
    protocol.initialize_factory();
    let arena = protocol.arena();
    let player = protocol.player();
    let reason = Symbol::new(&protocol.env, "maint");

    arena.pause(&reason);
    protocol.pause();
    // The local flag is checked first, so it is reported while both are set.
    assert_eq!(
        arena.try_join_arena(&player).err(),
        Some(Ok(ArenaError::ContractPaused))
    );

    arena.unpause();
    assert_eq!(
        arena.try_join_arena(&player).err(),
        Some(Ok(ArenaError::GloballyPaused)),
        "a host unpause must not override the protocol-wide pause"
    );

    arena.pause(&reason);
    protocol.unpause();
    assert_eq!(
        arena.try_join_arena(&player).err(),
        Some(Ok(ArenaError::ContractPaused)),
        "a global unpause must not override the host's own pause"
    );

    arena.unpause();
    arena.join_arena(&player);
}

#[test]
fn reads_are_not_gated_by_the_global_pause() {
    let protocol = Protocol::new();
    protocol.initialize_factory();
    let arena = protocol.arena();
    let player = protocol.player();
    arena.join_arena(&player);

    protocol.pause();
    assert!(arena.get_player_status(&player).joined);
    assert_eq!(arena.player_count(), 1);
}

#[test]
fn factory_without_the_pause_read_fails_open() {
    let legacy = Protocol::with_factory(|env| env.register(LegacyFactory, ()));
    let arena = legacy.arena();
    arena.join_arena(&legacy.player());

    let unreachable = Protocol::with_factory(|env| Address::generate(env));
    let arena = unreachable.arena();
    arena.join_arena(&unreachable.player());
}

#[test]
fn global_pause_check_budget_is_one_factory_read() {
    let protocol = Protocol::with_factory(|env| env.register(FACTORY_WASM, ()));
    protocol.initialize_factory();

    protocol.factory.is_globally_paused();
    let check = protocol.env.cost_estimate().resources();
    std::println!("is_globally_paused (factory WASM): {check:?}");

    // Factory instance + code: the flag lives in instance storage, so the
    // check adds no entry of its own and never writes.
    assert_eq!(check.read_entries, 2);
    assert_eq!(check.write_entries, 0);
    assert_eq!(check.persistent_entry_rent_bumps, 0);

    let arena = protocol.arena_from(protocol.env.register(crate::WASM, ()));
    let player = protocol.player();
    arena.join_arena(&player);
    std::println!(
        "join_arena (arena + factory WASM): {:?}",
        protocol.env.cost_estimate().resources()
    );
    protocol.pause();
    assert_eq!(
        arena.try_join_arena(&protocol.player()).err(),
        Some(Ok(ArenaError::GloballyPaused))
    );
}
