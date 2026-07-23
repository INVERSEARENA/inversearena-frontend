#![no_std]
use soroban_sdk::{contract, contractimpl, token, Address, Env};

mod storage;
mod types;

use storage::RwaStorage;
use types::{RwaConfig, RwaError, YieldAccrual};

#[contract]
pub struct RwaAdapter;

#[contractimpl]
impl RwaAdapter {
    /// Initialize the adapter with an admin and the SAC address of the stake token.
    pub fn initialize(env: Env, admin: Address, stake_token: Address) -> Result<(), RwaError> {
        admin.require_auth();
        if RwaStorage::has_config(&env) {
            return Err(RwaError::AlreadyInitialized);
        }
        RwaStorage::save_config(
            &env,
            &RwaConfig {
                admin,
                stake_token,
                total_deposited: 0,
            },
        );
        Ok(())
    }

    /// Deposit `amount` of the stake token into the adapter.
    /// Records the principal for future yield accounting.
    pub fn deposit(env: Env, from: Address, amount: i128) -> Result<(), RwaError> {
        from.require_auth();
        if amount <= 0 {
            return Err(RwaError::InvalidAmount);
        }
        let mut config = RwaStorage::load_config(&env)?;

        let token_client = token::Client::new(&env, &config.stake_token);
        token_client.transfer(&from, &env.current_contract_address(), &amount);

        let existing = RwaStorage::load_accrual(&env, &from).unwrap_or(YieldAccrual {
            principal: 0,
            withdrawn: false,
        });

        let new_principal = existing
            .principal
            .checked_add(amount)
            .ok_or(RwaError::ArithmeticOverflow)?;

        RwaStorage::save_accrual(
            &env,
            &from,
            &YieldAccrual {
                principal: new_principal,
                withdrawn: false,
            },
        );

        config.total_deposited = config
            .total_deposited
            .checked_add(amount)
            .ok_or(RwaError::ArithmeticOverflow)?;
        RwaStorage::save_config(&env, &config);
        Ok(())
    }

    /// Withdraw the caller's deposited principal back to their address.
    /// Yield distribution is handled separately by the admin via `distribute_yield`.
    pub fn withdraw(env: Env, from: Address) -> Result<i128, RwaError> {
        from.require_auth();
        let mut config = RwaStorage::load_config(&env)?;

        let accrual = RwaStorage::load_accrual(&env, &from).ok_or(RwaError::NoDeposit)?;
        if accrual.withdrawn {
            return Err(RwaError::AlreadyWithdrawn);
        }
        if accrual.principal <= 0 {
            return Err(RwaError::NoDeposit);
        }

        let payout = accrual.principal;

        if config.total_deposited < payout {
            return Err(RwaError::InsufficientBalance);
        }

        RwaStorage::save_accrual(
            &env,
            &from,
            &YieldAccrual {
                principal: accrual.principal,
                withdrawn: true,
            },
        );

        config.total_deposited = config
            .total_deposited
            .checked_sub(payout)
            .ok_or(RwaError::ArithmeticOverflow)?;
        RwaStorage::save_config(&env, &config);

        let token_client = token::Client::new(&env, &config.stake_token);
        token_client.transfer(&env.current_contract_address(), &from, &payout);

        Ok(payout)
    }

    /// Distribute `amount` of yield to `recipient` (admin only).
    pub fn distribute_yield(
        env: Env,
        recipient: Address,
        amount: i128,
    ) -> Result<(), RwaError> {
        let config = RwaStorage::load_config(&env)?;
        config.admin.require_auth();
        if amount <= 0 {
            return Err(RwaError::InvalidAmount);
        }
        let token_client = token::Client::new(&env, &config.stake_token);
        token_client.transfer(&env.current_contract_address(), &recipient, &amount);
        Ok(())
    }

    /// Return the deposited principal for a user (zero if no deposit).
    pub fn balance_of(env: Env, user: Address) -> i128 {
        RwaStorage::load_accrual(&env, &user)
            .map(|a| if a.withdrawn { 0 } else { a.principal })
            .unwrap_or(0)
    }

    /// Withdraw all of the caller's principal. Alias of `withdraw` for cross-contract compatibility.
    pub fn withdraw_all(env: Env, from: Address) -> Result<i128, RwaError> {
        from.require_auth();
        let mut config = RwaStorage::load_config(&env)?;

        let accrual = RwaStorage::load_accrual(&env, &from).ok_or(RwaError::NoDeposit)?;
        if accrual.withdrawn {
            return Err(RwaError::AlreadyWithdrawn);
        }
        if accrual.principal <= 0 {
            return Err(RwaError::NoDeposit);
        }

        let payout = accrual.principal;
        if config.total_deposited < payout {
            return Err(RwaError::InsufficientBalance);
        }

        RwaStorage::save_accrual(
            &env,
            &from,
            &YieldAccrual { principal: accrual.principal, withdrawn: true },
        );
        config.total_deposited = config
            .total_deposited
            .checked_sub(payout)
            .ok_or(RwaError::ArithmeticOverflow)?;
        RwaStorage::save_config(&env, &config);

        let token_client = token::Client::new(&env, &config.stake_token);
        token_client.transfer(&env.current_contract_address(), &from, &payout);
        Ok(payout)
    }

    /// Return the aggregate principal currently held in the adapter.
    pub fn get_total_deposited(env: Env) -> Result<i128, RwaError> {
        Ok(RwaStorage::load_config(&env)?.total_deposited)
    }

    /// Return global adapter configuration.
    pub fn get_config(env: Env) -> Result<RwaConfig, RwaError> {
        RwaStorage::load_config(&env)
    }

    /// Return yield accrual record for a specific user.
    pub fn get_accrual(env: Env, user: Address) -> Option<YieldAccrual> {
        RwaStorage::load_accrual(&env, &user)
    }
}

#[cfg(test)]
mod test {
    use super::*;
    use soroban_sdk::testutils::Address as _;
    use soroban_sdk::{token::StellarAssetClient, Env};

    fn setup() -> (Env, RwaAdapterClient<'static>, Address, Address, Address) {
        let env = Env::default();
        env.mock_all_auths();

        let admin = Address::generate(&env);
        let user = Address::generate(&env);

        // Deploy a test token (Stellar Asset Contract)
        let token_admin = Address::generate(&env);
        let token_id = env.register_stellar_asset_contract_v2(token_admin.clone());
        let token_sac = StellarAssetClient::new(&env, &token_id.address());
        token_sac.mint(&user, &1_000_000);

        let contract_id = env.register(RwaAdapter, ());
        let client = RwaAdapterClient::new(&env, &contract_id);
        client.initialize(&admin, &token_id.address());

        (env, client, admin, user, token_id.address())
    }

    #[test]
    fn deposit_and_withdraw_roundtrip() {
        let (_env, client, _admin, user, _token) = setup();
        client.deposit(&user, &500_000);
        let accrual = client.get_accrual(&user).expect("accrual should exist");
        assert_eq!(accrual.principal, 500_000);
        assert!(!accrual.withdrawn);

        let returned = client.withdraw(&user);
        assert_eq!(returned, 500_000);

        let after = client.get_accrual(&user).expect("accrual after withdraw");
        assert!(after.withdrawn);
    }

    #[test]
    fn double_withdraw_is_rejected() {
        let (_env, client, _admin, user, _token) = setup();
        client.deposit(&user, &100_000);
        client.withdraw(&user);
        let result = client.try_withdraw(&user);
        assert!(result.is_err());
    }

    #[test]
    fn initialize_twice_is_rejected() {
        let (env, client, admin, _user, token) = setup();
        let result = client.try_initialize(&admin, &token);
        assert!(result.is_err());
        let _ = env; // suppress unused warning
    }

    #[test]
    fn deposit_zero_is_rejected() {
        let (_env, client, _admin, user, _token) = setup();
        let result = client.try_deposit(&user, &0);
        assert!(result.is_err());
    }
}
