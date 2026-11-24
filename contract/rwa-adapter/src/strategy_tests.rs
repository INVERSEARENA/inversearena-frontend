//! Strategy vaults (#1848). Legacy deposits (no strategy registered) stay on
//! the index path and are covered by the tests in `lib.rs`.
#![cfg(test)]

extern crate std;

use idle_strategy::{IdleStrategy, IdleStrategyClient};
use soroban_sdk::{
    Address, Env, contract, contractimpl,
    testutils::{Address as _, Ledger},
    token::{StellarAssetClient, TokenClient},
};

use crate::{RwaAdapter, RwaAdapterClient, RwaError};

#[contract]
struct MockOracle;

#[contractimpl]
impl MockOracle {
    pub fn get_current_yield_bps(_env: Env) -> u32 {
        0
    }
}

#[contract]
struct VaultRegistry;

#[contractimpl]
impl VaultRegistry {
    pub fn approve(env: Env, vault: Address) {
        env.storage().persistent().set(&vault, &true);
    }

    pub fn is_approved_vault(env: Env, vault: Address) -> bool {
        env.storage().persistent().get(&vault).unwrap_or(false)
    }
}

/// Reports `balance - loss`, and `withdraw` pays at most `liquid` tokens.
/// Own module so its exports do not collide with `Brick`.
mod lossy_contract {
use super::*;

#[contract]
pub struct Lossy;

#[contractimpl]
impl Lossy {
    pub fn initialize(env: Env, token: Address) {
        env.storage().instance().set(&soroban_sdk::symbol_short!("token"), &token);
    }

    pub fn deposit(env: Env, from: Address, amount: i128) {
        from.require_auth();
        let token: Address = env.storage().instance().get(&soroban_sdk::symbol_short!("token")).unwrap();
        if !env.storage().instance().has(&soroban_sdk::symbol_short!("vault")) {
            env.storage().instance().set(&soroban_sdk::symbol_short!("vault"), &from);
        }
        TokenClient::new(&env, &token).transfer(&from, &env.current_contract_address(), &amount);
    }

    pub fn withdraw(env: Env, to: Address, amount: i128) -> i128 {
        let vault: Address = env.storage().instance().get(&soroban_sdk::symbol_short!("vault")).unwrap();
        vault.require_auth();
        let token: Address = env.storage().instance().get(&soroban_sdk::symbol_short!("token")).unwrap();
        let liquid: i128 = env.storage().instance().get(&soroban_sdk::symbol_short!("liquid")).unwrap_or(i128::MAX);
        let pay = if amount < liquid { amount } else { liquid };
        if pay > 0 {
            TokenClient::new(&env, &token).transfer(&env.current_contract_address(), &to, &pay);
            if liquid != i128::MAX {
                env.storage().instance().set(&soroban_sdk::symbol_short!("liquid"), &(liquid - pay));
            }
        }
        pay
    }

    pub fn total_assets(env: Env) -> i128 {
        let token: Address = env.storage().instance().get(&soroban_sdk::symbol_short!("token")).unwrap();
        let balance = TokenClient::new(&env, &token).balance(&env.current_contract_address());
        let loss: i128 = env.storage().instance().get(&soroban_sdk::symbol_short!("loss")).unwrap_or(0);
        balance.saturating_sub(loss)
    }

    pub fn set_loss(env: Env, loss: i128) {
        env.storage().instance().set(&soroban_sdk::symbol_short!("loss"), &loss);
    }

    pub fn set_liquid(env: Env, liquid: i128) {
        env.storage().instance().set(&soroban_sdk::symbol_short!("liquid"), &liquid);
    }
}
}

/// `withdraw` always traps. Deposit and total_assets behave like idle.
mod brick_contract {
use super::*;

#[contract]
pub struct Brick;

#[contractimpl]
impl Brick {
    pub fn initialize(env: Env, token: Address) {
        env.storage().instance().set(&soroban_sdk::symbol_short!("token"), &token);
    }

    pub fn deposit(env: Env, from: Address, amount: i128) {
        from.require_auth();
        let token: Address = env.storage().instance().get(&soroban_sdk::symbol_short!("token")).unwrap();
        if !env.storage().instance().has(&soroban_sdk::symbol_short!("vault")) {
            env.storage().instance().set(&soroban_sdk::symbol_short!("vault"), &from);
        }
        TokenClient::new(&env, &token).transfer(&from, &env.current_contract_address(), &amount);
    }

    pub fn withdraw(_env: Env, _to: Address, _amount: i128) -> i128 {
        panic!("strategy reverted");
    }

    pub fn total_assets(env: Env) -> i128 {
        let token: Address = env.storage().instance().get(&soroban_sdk::symbol_short!("token")).unwrap();
        TokenClient::new(&env, &token).balance(&env.current_contract_address())
    }
}
}

use brick_contract::{Brick, BrickClient};
use lossy_contract::{Lossy, LossyClient};

struct Fx {
    env: Env,
    client: RwaAdapterClient<'static>,
    token: Address,
    registry: Address,
}

fn setup() -> Fx {
    let env = Env::default();
    env.mock_all_auths();
    env.ledger().with_mut(|l| l.timestamp = 1_700_000_000);
    let token_admin = Address::generate(&env);
    let token = env.register_stellar_asset_contract_v2(token_admin).address();
    let oracle = env.register(MockOracle, ());
    let id = env.register(RwaAdapter, ());
    let client = RwaAdapterClient::new(&env, &id);
    let admin = Address::generate(&env);
    client.initialize(&admin, &token, &oracle);
    let registry = env.register(VaultRegistry, ());
    client.set_factory(&registry);
    Fx { env, client, token, registry }
}

fn mint(fx: &Fx, to: &Address, amount: i128) {
    StellarAssetClient::new(&fx.env, &fx.token).mint(to, &amount);
}

fn idle(fx: &Fx) -> Address {
    let id = fx.env.register(IdleStrategy, ());
    IdleStrategyClient::new(&fx.env, &id).initialize(&fx.token);
    VaultRegistryClient::new(&fx.env, &fx.registry).approve(&id);
    id
}

fn lossy(fx: &Fx) -> LossyClient<'static> {
    let id = fx.env.register(Lossy, ());
    let client = LossyClient::new(&fx.env, &id);
    client.initialize(&fx.token);
    VaultRegistryClient::new(&fx.env, &fx.registry).approve(&id);
    client
}

#[test]
fn caps_split_a_deposit_across_strategies_in_order() {
    let fx = setup();
    let first = idle(&fx);
    let second = idle(&fx);
    fx.client.add_strategy(&first, &2_500);
    fx.client.add_strategy(&second, &10_000);

    let user = Address::generate(&fx.env);
    mint(&fx, &user, 1_000);
    fx.client.deposit(&user, &1_000);

    assert_eq!(IdleStrategyClient::new(&fx.env, &first).total_assets(), 250);
    assert_eq!(IdleStrategyClient::new(&fx.env, &second).total_assets(), 750);
    assert_eq!(fx.client.balance_of(&user), 1_000);
    assert_eq!(fx.client.get_total_deposited(), 1_000);
}

#[test]
fn unapproved_strategy_is_rejected() {
    let fx = setup();
    let id = fx.env.register(IdleStrategy, ());
    IdleStrategyClient::new(&fx.env, &id).initialize(&fx.token);
    let result = fx.client.try_add_strategy(&id, &10_000);
    assert_eq!(result, Err(Ok(RwaError::StrategyNotApproved)));
}

#[test]
fn remove_strategy_requires_zero_assets() {
    let fx = setup();
    let full = idle(&fx);
    let empty = idle(&fx);
    fx.client.add_strategy(&full, &10_000);
    fx.client.add_strategy(&empty, &10_000);
    let user = Address::generate(&fx.env);
    mint(&fx, &user, 100);
    fx.client.deposit(&user, &100);

    assert_eq!(
        fx.client.try_remove_strategy(&full),
        Err(Ok(RwaError::StrategyNotEmpty))
    );
    fx.client.remove_strategy(&empty);
    assert_eq!(fx.client.get_strategies().len(), 1);
}

#[test]
fn rebalance_moves_tokens_and_respects_the_destination_cap() {
    let fx = setup();
    let from = idle(&fx);
    let to = idle(&fx);
    fx.client.add_strategy(&from, &10_000);
    fx.client.add_strategy(&to, &2_500);
    let user = Address::generate(&fx.env);
    mint(&fx, &user, 1_000);
    fx.client.deposit(&user, &1_000);

    assert_eq!(
        fx.client.try_rebalance(&from, &to, &300),
        Err(Ok(RwaError::CapExceeded))
    );
    fx.client.rebalance(&from, &to, &200);
    assert_eq!(IdleStrategyClient::new(&fx.env, &from).total_assets(), 800);
    assert_eq!(IdleStrategyClient::new(&fx.env, &to).total_assets(), 200);
}

#[test]
fn a_loss_in_one_strategy_is_shared_by_every_depositor() {
    let fx = setup();
    let strategy = lossy(&fx);
    fx.client.add_strategy(&strategy.address.clone(), &10_000);
    let alice = Address::generate(&fx.env);
    let bob = Address::generate(&fx.env);
    mint(&fx, &alice, 1_000);
    mint(&fx, &bob, 1_000);
    fx.client.deposit(&alice, &1_000);
    fx.client.deposit(&bob, &1_000);

    strategy.set_loss(&1_000);
    assert_eq!(fx.client.balance_of(&alice), 500);
    assert_eq!(fx.client.balance_of(&bob), 500);
    assert_eq!(fx.client.balance_of(&alice) + fx.client.balance_of(&bob), fx.client.get_total_deposited());
}

#[test]
fn withdraw_all_pulls_in_registration_order() {
    let fx = setup();
    let first = idle(&fx);
    let second = idle(&fx);
    fx.client.add_strategy(&first, &4_000);
    fx.client.add_strategy(&second, &10_000);
    let user = Address::generate(&fx.env);
    mint(&fx, &user, 1_000);
    fx.client.deposit(&user, &1_000);

    let paid = fx.client.withdraw_all(&user);
    assert_eq!(paid, 1_000);
    assert_eq!(TokenClient::new(&fx.env, &fx.token).balance(&user), 1_000);
    assert_eq!(IdleStrategyClient::new(&fx.env, &first).total_assets(), 0);
    assert_eq!(IdleStrategyClient::new(&fx.env, &second).total_assets(), 0);
    assert_eq!(fx.client.balance_of(&user), 0);
}

#[test]
fn withdraw_all_fails_closed_when_a_strategy_is_illiquid() {
    let fx = setup();
    let strategy = lossy(&fx);
    fx.client.add_strategy(&strategy.address.clone(), &10_000);
    let user = Address::generate(&fx.env);
    mint(&fx, &user, 100);
    fx.client.deposit(&user, &100);
    strategy.set_liquid(&0);

    let result = fx.client.try_withdraw_all(&user);
    assert_eq!(result, Err(Ok(RwaError::InsufficientBalance)));
    assert_eq!(fx.client.balance_of(&user), 100);
    assert_eq!(TokenClient::new(&fx.env, &fx.token).balance(&user), 0);
    assert_eq!(strategy.total_assets(), 100);
}

#[test]
fn a_reverting_strategy_does_not_block_a_later_one() {
    let fx = setup();
    let brick_id = fx.env.register(Brick, ());
    let brick = BrickClient::new(&fx.env, &brick_id);
    brick.initialize(&fx.token);
    VaultRegistryClient::new(&fx.env, &fx.registry).approve(&brick_id);
    let healthy = idle(&fx);
    fx.client.add_strategy(&brick_id, &5_000);
    fx.client.add_strategy(&healthy, &10_000);

    let user = Address::generate(&fx.env);
    mint(&fx, &user, 1_000);
    fx.client.deposit(&user, &1_000);
    assert_eq!(brick.total_assets(), 500);
    assert_eq!(IdleStrategyClient::new(&fx.env, &healthy).total_assets(), 500);

    let paid = fx.client.withdraw(&user, &400);
    assert_eq!(paid, 400);
    assert_eq!(TokenClient::new(&fx.env, &fx.token).balance(&user), 400);
    assert_eq!(brick.total_assets(), 500);
    assert_eq!(IdleStrategyClient::new(&fx.env, &healthy).total_assets(), 100);
}
