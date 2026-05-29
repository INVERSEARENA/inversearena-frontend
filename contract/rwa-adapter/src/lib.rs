#![no_std]
use soroban_sdk::{Address, Env, contract, contractimpl, token};

mod storage;
mod types;

use storage::RwaStorage;
use types::RwaConfig;
pub use types::RwaError;

const YIELD_BPS: i128 = 500;

#[contract]
pub struct RwaAdapter;

#[contractimpl]
impl RwaAdapter {
    pub fn initialize(env: Env, admin: Address, stake_token: Address) -> Result<(), RwaError> {
        admin.require_auth();
        if RwaStorage::assert_initialized(&env).is_ok() {
            return Err(RwaError::AlreadyInitialized);
        }
        let config = RwaConfig {
            admin,
            stake_token,
            total_deposited: 0,
        };
        RwaStorage::save_config(&env, &config);
        RwaStorage::set_initialized(&env);
        env.events()
            .publish((soroban_sdk::symbol_short!("init"),), ());
        Ok(())
    }

    pub fn deposit(env: Env, from: Address, amount: i128) -> Result<(), RwaError> {
        let config = RwaStorage::load_config(&env)?;

        let mut pos = RwaStorage::load_position(&env, &from);
        pos.principal += amount;
        RwaStorage::save_position(&env, &from, &pos);

        let mut cfg = config;
        cfg.total_deposited += amount;
        RwaStorage::save_config(&env, &cfg);

        env.events().publish(
            (soroban_sdk::symbol_short!("deposited"), from.clone(), amount),
            (),
        );
        Ok(())
    }

    pub fn withdraw_all(env: Env, from: Address) -> Result<i128, RwaError> {
        let config = RwaStorage::load_config(&env)?;

        let pos = RwaStorage::load_position(&env, &from);
        if pos.principal == 0 {
            return Err(RwaError::NoDeposit);
        }
        if pos.withdrawn {
            return Err(RwaError::AlreadyWithdrawn);
        }

        let yield_amount = pos.principal * YIELD_BPS / 10000;
        let total = pos.principal + yield_amount;

        let mut updated = pos;
        updated.withdrawn = true;
        RwaStorage::save_position(&env, &from, &updated);

        let token_client = token::TokenClient::new(&env, &config.stake_token);
        let contract_addr = env.current_contract_address();
        let balance = token_client.balance(&contract_addr);
        let payable = if total > balance { balance } else { total };
        token_client.transfer(&contract_addr, &from, &payable);

        env.events().publish(
            (
                soroban_sdk::symbol_short!("withdrawn"),
                from.clone(),
                payable,
                payable - pos.principal,
            ),
            (),
        );

        Ok(payable)
    }

    pub fn balance_of(env: Env, user: Address) -> i128 {
        RwaStorage::load_config(&env)
            .map(|_| {
                let pos = RwaStorage::load_position(&env, &user);
                if pos.withdrawn {
                    0
                } else {
                    pos.principal + (pos.principal * YIELD_BPS / 10000)
                }
            })
            .unwrap_or(0)
    }

    pub fn get_total_deposited(env: Env) -> i128 {
        RwaStorage::load_config(&env)
            .map(|c| c.total_deposited)
            .unwrap_or(0)
    }
}
