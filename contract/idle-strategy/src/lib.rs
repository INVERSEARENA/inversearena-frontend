//! Reference yield source (#1848). It holds the stake token and does not
//! invest it. The adapter is the only address that may withdraw.
#![no_std]

use soroban_sdk::{Address, Env, contract, contractimpl, symbol_short, token};

#[contract]
pub struct IdleStrategy;

#[contractimpl]
impl IdleStrategy {
    pub fn initialize(env: Env, token: Address) {
        if env.storage().instance().has(&symbol_short!("token")) {
            panic!("already initialized");
        }
        env.storage().instance().set(&symbol_short!("token"), &token);
    }

    pub fn deposit(env: Env, from: Address, amount: i128) {
        from.require_auth();
        if amount <= 0 {
            panic!("invalid amount");
        }
        let token: Address = env
            .storage()
            .instance()
            .get(&symbol_short!("token"))
            .unwrap();
        if !env.storage().instance().has(&symbol_short!("vault")) {
            env.storage().instance().set(&symbol_short!("vault"), &from);
        }
        token::TokenClient::new(&env, &token).transfer(
            &from,
            &env.current_contract_address(),
            &amount,
        );
    }

    pub fn withdraw(env: Env, to: Address, amount: i128) -> i128 {
        let vault: Address = env
            .storage()
            .instance()
            .get(&symbol_short!("vault"))
            .unwrap();
        vault.require_auth();
        if amount <= 0 {
            panic!("invalid amount");
        }
        let token: Address = env
            .storage()
            .instance()
            .get(&symbol_short!("token"))
            .unwrap();
        token::TokenClient::new(&env, &token).transfer(
            &env.current_contract_address(),
            &to,
            &amount,
        );
        amount
    }

    pub fn total_assets(env: Env) -> i128 {
        let token: Address = env
            .storage()
            .instance()
            .get(&symbol_short!("token"))
            .unwrap();
        token::TokenClient::new(&env, &token).balance(&env.current_contract_address())
    }
}
