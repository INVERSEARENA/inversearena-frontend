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
        from.require_auth();
        if amount <= 0 {
            return Err(RwaError::InvalidAmount);
        }
        let config = RwaStorage::load_config(&env)?;

        let mut pos = RwaStorage::load_position(&env, &from);
        pos.principal += amount;
        RwaStorage::save_position(&env, &from, &pos);

        let mut cfg = config;
        cfg.total_deposited += amount;
        RwaStorage::save_config(&env, &cfg);

        env.events().publish(
            (
                soroban_sdk::symbol_short!("deposited"),
                from.clone(),
                amount,
            ),
            (),
        );
        Ok(())
    }

    pub fn withdraw_all(env: Env, from: Address) -> Result<i128, RwaError> {
        from.require_auth();
        let config = RwaStorage::load_config(&env)?;

        let pos = RwaStorage::load_position(&env, &from);
        if pos.principal == 0 {
            return Err(RwaError::NoDeposit);
        }
        if pos.withdrawn {
            return Err(RwaError::AlreadyWithdrawn);
        }

        let yield_amount = pos
            .principal
            .checked_mul(YIELD_BPS)
            .and_then(|v| v.checked_div(10000))
            .ok_or(RwaError::ArithmeticOverflow)?;
        let total = pos
            .principal
            .checked_add(yield_amount)
            .ok_or(RwaError::ArithmeticOverflow)?;

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
                    pos.principal
                        .checked_mul(YIELD_BPS)
                        .and_then(|y| y.checked_div(10000))
                        .and_then(|y| pos.principal.checked_add(y))
                        .unwrap_or(0)
                }
            })
            .unwrap_or(0)
    }

    pub fn get_total_deposited(env: Env) -> i128 {
        RwaStorage::load_config(&env)
            .map(|c| c.total_deposited)
            .unwrap_or(0)
    }

    pub fn upgrade(env: Env, new_wasm_hash: soroban_sdk::BytesN<32>) -> Result<(), RwaError> {
        let config = RwaStorage::load_config(&env)?;
        config.admin.require_auth();
        env.deployer().update_current_contract_wasm(new_wasm_hash);
        Ok(())
    }
}

#[cfg(test)]
mod test {
    extern crate std;

    use super::*;
    use soroban_sdk::{Address, Env, testutils::Address as _, token::StellarAssetClient};

    // ── helpers ───────────────────────────────────────────────────────────────

    /// Register the RwaAdapter and wire up a SAC token, writing config directly
    /// into storage so tests can control auth independently of `initialize`.
    fn setup(env: &Env) -> (RwaAdapterClient<'static>, Address, Address) {
        let contract_id = env.register(RwaAdapter, ());
        let token_admin = Address::generate(env);
        let token_id = env
            .register_stellar_asset_contract_v2(token_admin)
            .address();
        let admin = Address::generate(env);

        env.as_contract(&contract_id, || {
            let config = RwaConfig {
                admin: admin.clone(),
                stake_token: token_id.clone(),
                total_deposited: 0,
            };
            RwaStorage::save_config(env, &config);
            RwaStorage::set_initialized(env);
        });

        let env_static: &'static Env = unsafe { &*(env as *const Env) };
        let client = RwaAdapterClient::new(env_static, &contract_id);
        (client, token_id, contract_id)
    }

    // ── Authorization tests for deposit() ────────────────────────────────────

    /// deposit() must panic when the `from` address has not authorized the call.
    #[test]
    #[should_panic]
    fn deposit_without_auth_panics() {
        let env = Env::default();
        // Intentionally no mock_all_auths — auth is enforced.
        let (client, _, _) = setup(&env);
        let from = Address::generate(&env);
        // from has not signed anything; require_auth() should panic.
        client.deposit(&from, &100);
    }

    /// deposit() records the position when the caller provides authorization.
    #[test]
    fn deposit_with_auth_succeeds() {
        let env = Env::default();
        env.mock_all_auths();
        let (client, _, _) = setup(&env);
        let from = Address::generate(&env);

        client.deposit(&from, &100);

        // balance_of returns principal + 5% simulated yield
        assert_eq!(client.balance_of(&from), 105);
        assert_eq!(client.get_total_deposited(), 100);
    }

    // ── Authorization tests for withdraw_all() ────────────────────────────────

    /// withdraw_all() must panic when the `from` address has not authorized the call.
    #[test]
    #[should_panic]
    fn withdraw_without_auth_panics() {
        let env = Env::default();
        // Intentionally no mock_all_auths — auth is enforced.
        let (client, _, contract_id) = setup(&env);
        let from = Address::generate(&env);

        // Seed a position directly so the test reaches require_auth() without
        // going through deposit (which also requires auth).
        env.as_contract(&contract_id, || {
            RwaStorage::save_position(
                &env,
                &from,
                &types::YieldAccrual {
                    principal: 100,
                    withdrawn: false,
                },
            );
        });

        // from has not signed anything; require_auth() should panic.
        client.withdraw_all(&from);
    }

    /// withdraw_all() transfers principal + yield to the caller when authorized.
    #[test]
    fn withdraw_with_auth_returns_correct_amount() {
        let env = Env::default();
        env.mock_all_auths();
        let (client, token_id, contract_id) = setup(&env);
        let from = Address::generate(&env);

        // Deposit 1000 tokens worth of position.
        client.deposit(&from, &1_000);

        // Expected payout: 1000 principal + 5% yield = 1050.
        let expected: i128 = 1_050;

        // Fund the contract so the token transfer in withdraw_all can succeed.
        StellarAssetClient::new(&env, &token_id).mint(&contract_id, &expected);

        let returned = client.withdraw_all(&from);
        assert_eq!(returned, expected);

        // After withdrawal the position is closed; balance_of must return 0.
        assert_eq!(client.balance_of(&from), 0);
    }
}
