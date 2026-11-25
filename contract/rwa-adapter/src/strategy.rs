//! Yield-source boundary for the RWA adapter (#1848).
//!
//! Depositor accounting (who is owed what) stays in the adapter as shares of
//! `total_assets`. Where the tokens sit is a `Strategy`: `deposit`,
//! `withdraw`, and `total_assets`. Arenas keep calling `deposit`,
//! `withdraw`, `withdraw_all`, and `balance_of`.

use crate::events;
use crate::storage::RwaStorage;
use crate::types::{RwaError, StrategyRecord};
use soroban_sdk::{Address, Env, Vec, contractclient, token};

const BPS: i128 = 10_000;

/// Client for a yield source. `IdleStrategy` is the reference implementation.
#[contractclient(name = "StrategyClient")]
pub trait Strategy {
    fn deposit(env: Env, from: Address, amount: i128);
    fn withdraw(env: Env, to: Address, amount: i128) -> i128;
    fn total_assets(env: Env) -> i128;
}

/// Same method the factory exposes as `is_approved_vault`.
#[contractclient(name = "ApprovedVaultClient")]
pub trait ApprovedVault {
    fn is_approved_vault(env: Env, vault: Address) -> bool;
}

pub fn total_assets(env: &Env) -> i128 {
    let mut sum = 0i128;
    for strategy in RwaStorage::load_strategies(env).iter() {
        let assets = StrategyClient::new(env, &strategy.address).total_assets();
        sum = sum.saturating_add(assets);
    }
    sum
}

pub fn shares_value(env: &Env, user: &Address) -> i128 {
    let shares = RwaStorage::user_shares(env, user);
    let supply = RwaStorage::share_supply(env);
    if shares <= 0 || supply <= 0 {
        return 0;
    }
    let assets = total_assets(env);
    shares.saturating_mul(assets) / supply
}

pub fn deposit(env: &Env, from: &Address, amount: i128) -> Result<(), RwaError> {
    from.require_auth();
    // Strategies pull tokens from this contract. That auth has to be
    // recorded on this invocation or the nested transfer is rejected.
    env.current_contract_address().require_auth();
    if amount <= 0 {
        return Err(RwaError::InvalidAmount);
    }
    let config = RwaStorage::load_config(env)?;
    let assets_before = total_assets(env);
    let supply = RwaStorage::share_supply(env);
    let minted = if supply == 0 || assets_before == 0 {
        amount
    } else {
        amount
            .checked_mul(supply)
            .and_then(|v| v.checked_div(assets_before))
            .ok_or(RwaError::ArithmeticOverflow)?
    };
    if minted == 0 {
        return Err(RwaError::InvalidAmount);
    }

    let token = token::TokenClient::new(env, &config.stake_token);
    let adapter = env.current_contract_address();
    token.transfer(from, &adapter, &amount);
    allocate(env, &adapter, amount)?;

    let next_user = RwaStorage::user_shares(env, from)
        .checked_add(minted)
        .ok_or(RwaError::ArithmeticOverflow)?;
    let next_supply = supply
        .checked_add(minted)
        .ok_or(RwaError::ArithmeticOverflow)?;
    RwaStorage::set_user_shares(env, from, next_user);
    RwaStorage::set_share_supply(env, next_supply);
    events::deposited(env, from, amount);
    Ok(())
}

pub fn withdraw_all(env: &Env, from: &Address) -> Result<i128, RwaError> {
    from.require_auth();
    let shares = RwaStorage::user_shares(env, from);
    if shares <= 0 {
        return Err(RwaError::NoDeposit);
    }
    let supply = RwaStorage::share_supply(env);
    let assets = total_assets(env);
    let owed = if supply <= 0 {
        0
    } else {
        shares.saturating_mul(assets) / supply
    };
    settle(env, from, shares, owed)
}

pub fn withdraw(env: &Env, from: &Address, amount: i128) -> Result<i128, RwaError> {
    from.require_auth();
    if amount <= 0 {
        return Err(RwaError::InvalidAmount);
    }
    let shares = RwaStorage::user_shares(env, from);
    if shares <= 0 {
        return Err(RwaError::NoDeposit);
    }
    let supply = RwaStorage::share_supply(env);
    let assets = total_assets(env);
    let value = if supply <= 0 {
        0
    } else {
        shares.saturating_mul(assets) / supply
    };
    if amount > value {
        return Err(RwaError::InsufficientBalance);
    }
    let burn = if amount >= value || assets == 0 {
        shares
    } else {
        let numerator = amount
            .checked_mul(supply)
            .ok_or(RwaError::ArithmeticOverflow)?;
        let rounded = numerator
            .checked_add(assets - 1)
            .ok_or(RwaError::ArithmeticOverflow)?
            .checked_div(assets)
            .ok_or(RwaError::ArithmeticOverflow)?;
        core::cmp::min(rounded, shares)
    };
    settle(env, from, burn, amount)
}

/// Pull `owed` from strategies in registration order, then pay `from`.
/// A reverting strategy is skipped. If the rest cannot cover `owed`, the
/// call returns an error and the host rolls the attempt back.
fn settle(env: &Env, from: &Address, burn: i128, owed: i128) -> Result<i128, RwaError> {
    env.current_contract_address().require_auth();
    let config = RwaStorage::load_config(env)?;
    if owed > 0 {
        pull(env, owed)?;
        let token = token::TokenClient::new(env, &config.stake_token);
        let adapter = env.current_contract_address();
        token.transfer(&adapter, from, &owed);
    }
    let left = RwaStorage::user_shares(env, from).saturating_sub(burn);
    RwaStorage::set_user_shares(env, from, left);
    RwaStorage::set_share_supply(env, RwaStorage::share_supply(env).saturating_sub(burn));
    events::withdrawn(env, from, owed);
    Ok(owed)
}

fn allocate(env: &Env, adapter: &Address, amount: i128) -> Result<(), RwaError> {
    let assets_now = total_assets(env);
    let total_after = assets_now
        .checked_add(amount)
        .ok_or(RwaError::ArithmeticOverflow)?;
    let mut left = amount;
    for strategy in RwaStorage::load_strategies(env).iter() {
        if left == 0 {
            break;
        }
        let client = StrategyClient::new(env, &strategy.address);
        let held = client.total_assets();
        let cap = total_after
            .checked_mul(strategy.cap_bps as i128)
            .and_then(|v| v.checked_div(BPS))
            .ok_or(RwaError::ArithmeticOverflow)?;
        let room = cap.saturating_sub(held);
        if room <= 0 {
            continue;
        }
        let take = if room < left { room } else { left };
        client.deposit(adapter, &take);
        left -= take;
    }
    if left > 0 {
        Err(RwaError::CapExceeded)
    } else {
        Ok(())
    }
}

fn pull(env: &Env, need: i128) -> Result<(), RwaError> {
    let config = RwaStorage::load_config(env)?;
    let token = token::TokenClient::new(env, &config.stake_token);
    let adapter = env.current_contract_address();
    let mut left = need;
    for strategy in RwaStorage::load_strategies(env).iter() {
        if left == 0 {
            break;
        }
        let client = StrategyClient::new(env, &strategy.address);
        let available = client.total_assets();
        if available <= 0 {
            continue;
        }
        let take = if available < left { available } else { left };
        let before = token.balance(&adapter);
        if client.try_withdraw(&adapter, &take).is_err() {
            continue;
        }
        let got = token.balance(&adapter).saturating_sub(before);
        left = left.saturating_sub(got);
    }
    if left > 0 {
        Err(RwaError::InsufficientBalance)
    } else {
        Ok(())
    }
}

pub fn require_known(list: &Vec<StrategyRecord>, strategy: &Address) -> Result<(), RwaError> {
    for record in list.iter() {
        if record.address == *strategy {
            return Ok(());
        }
    }
    Err(RwaError::UnknownStrategy)
}
