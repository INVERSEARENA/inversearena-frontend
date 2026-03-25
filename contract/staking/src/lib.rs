#![no_std]

use soroban_sdk::{
    Address, Env, Symbol, contract, contracterror, contractimpl, contracttype, symbol_short, token,
};

const ADMIN_KEY: Symbol = symbol_short!("ADMIN");
const TOKEN_KEY: Symbol = symbol_short!("TOKEN");
const TOTAL_STAKED_KEY: Symbol = symbol_short!("T_STAKE");
const TOTAL_SHARES_KEY: Symbol = symbol_short!("T_SHARE");
const TOPIC_STAKED: Symbol = symbol_short!("STAKED");
const TOPIC_UNSTAKED: Symbol = symbol_short!("UNSTAKD");

#[contracterror]
#[derive(Copy, Clone, Debug, Eq, PartialEq, PartialOrd, Ord)]
#[repr(u32)]
pub enum StakingError {
    AlreadyInitialized = 1,
    NotInitialized = 2,
    InvalidAmount = 3,
    ZeroShareMint = 4,
    InsufficientShares = 5,
    ZeroShares = 6,
}

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum DataKey {
    Position(Address),
}

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct StakePosition {
    pub amount: i128,
    pub shares: i128,
}

#[contract]
pub struct StakingContract;

#[contractimpl]
impl StakingContract {
    pub fn initialize(
        env: Env,
        admin: Address,
        token_contract: Address,
    ) -> Result<(), StakingError> {
        if env.storage().instance().has(&ADMIN_KEY) {
            return Err(StakingError::AlreadyInitialized);
        }

        env.storage().instance().set(&ADMIN_KEY, &admin);
        env.storage().instance().set(&TOKEN_KEY, &token_contract);
        env.storage().instance().set(&TOTAL_STAKED_KEY, &0i128);
        env.storage().instance().set(&TOTAL_SHARES_KEY, &0i128);

        Ok(())
    }

    pub fn stake(env: Env, staker: Address, amount: i128) -> Result<i128, StakingError> {
        let token_contract = get_token_contract(&env)?;
        staker.require_auth();

        if amount <= 0 {
            return Err(StakingError::InvalidAmount);
        }

        let total_staked = Self::total_staked(env.clone())?;
        let total_shares = Self::total_shares(env.clone())?;
        let minted_shares = if total_staked == 0 || total_shares == 0 {
            amount
        } else {
            amount
                .checked_mul(total_shares)
                .and_then(|value| value.checked_div(total_staked))
                .ok_or(StakingError::ZeroShareMint)?
        };

        if minted_shares <= 0 {
            return Err(StakingError::ZeroShareMint);
        }

        let contract_address = env.current_contract_address();
        let token_client = token::TokenClient::new(&env, &token_contract);
        token_client.transfer(&staker, &contract_address, &amount);

        let position_key = DataKey::Position(staker.clone());
        let existing_position =
            env.storage()
                .persistent()
                .get(&position_key)
                .unwrap_or(StakePosition {
                    amount: 0,
                    shares: 0,
                });

        let updated_position = StakePosition {
            amount: existing_position.amount + amount,
            shares: existing_position.shares + minted_shares,
        };

        env.storage()
            .persistent()
            .set(&position_key, &updated_position);
        env.storage()
            .instance()
            .set(&TOTAL_STAKED_KEY, &(total_staked + amount));
        env.storage()
            .instance()
            .set(&TOTAL_SHARES_KEY, &(total_shares + minted_shares));

        env.events().publish(
            (TOPIC_STAKED, staker, token_contract),
            (amount, minted_shares),
        );

        Ok(minted_shares)
    }

    pub fn unstake(env: Env, staker: Address, shares: i128) -> Result<i128, StakingError> {
        let token_contract = get_token_contract(&env)?;
        staker.require_auth();

        // Checks
        if shares <= 0 {
            return Err(StakingError::ZeroShares);
        }

        let position_key = DataKey::Position(staker.clone());
        let position: StakePosition = env
            .storage()
            .persistent()
            .get(&position_key)
            .ok_or(StakingError::InsufficientShares)?;

        if shares > position.shares {
            return Err(StakingError::InsufficientShares);
        }

        let total_staked = Self::total_staked(env.clone())?;
        let total_shares = Self::total_shares(env.clone())?;

        // Compute token amount: shares * total_staked / total_shares
        let token_amount = shares
            .checked_mul(total_staked)
            .and_then(|v| v.checked_div(total_shares))
            .ok_or(StakingError::ZeroShareMint)?;

        // Effects (before external call — CEI pattern)
        let new_shares = position.shares - shares;
        if new_shares == 0 {
            env.storage().persistent().remove(&position_key);
        } else {
            let new_amount = position
                .amount
                .checked_mul(new_shares)
                .and_then(|v| v.checked_div(position.shares))
                .ok_or(StakingError::ZeroShareMint)?;
            env.storage().persistent().set(
                &position_key,
                &StakePosition {
                    amount: new_amount,
                    shares: new_shares,
                },
            );
        }

        env.storage()
            .instance()
            .set(&TOTAL_STAKED_KEY, &(total_staked - token_amount));
        env.storage()
            .instance()
            .set(&TOTAL_SHARES_KEY, &(total_shares - shares));

        // Interaction
        let contract_address = env.current_contract_address();
        let token_client = token::TokenClient::new(&env, &token_contract);
        token_client.transfer(&contract_address, &staker, &token_amount);

        // Event
        env.events().publish(
            (TOPIC_UNSTAKED, staker, token_contract),
            (token_amount, shares),
        );

        Ok(token_amount)
    }

    pub fn get_position(env: Env, staker: Address) -> StakePosition {
        env.storage()
            .persistent()
            .get(&DataKey::Position(staker))
            .unwrap_or(StakePosition {
                amount: 0,
                shares: 0,
            })
    }

    pub fn total_staked(env: Env) -> Result<i128, StakingError> {
        ensure_initialized(&env)?;
        Ok(env.storage().instance().get(&TOTAL_STAKED_KEY).unwrap_or(0))
    }

    pub fn total_shares(env: Env) -> Result<i128, StakingError> {
        ensure_initialized(&env)?;
        Ok(env.storage().instance().get(&TOTAL_SHARES_KEY).unwrap_or(0))
    }

    pub fn token(env: Env) -> Result<Address, StakingError> {
        get_token_contract(&env)
    }
}

fn ensure_initialized(env: &Env) -> Result<(), StakingError> {
    if !env.storage().instance().has(&ADMIN_KEY) || !env.storage().instance().has(&TOKEN_KEY) {
        return Err(StakingError::NotInitialized);
    }

    Ok(())
}

fn get_token_contract(env: &Env) -> Result<Address, StakingError> {
    ensure_initialized(env)?;
    env.storage()
        .instance()
        .get(&TOKEN_KEY)
        .ok_or(StakingError::NotInitialized)
}

#[cfg(test)]
mod test;

#[cfg(test)]
mod integration_tests;