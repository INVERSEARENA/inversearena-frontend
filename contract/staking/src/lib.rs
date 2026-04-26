#![no_std]

use soroban_sdk::{
    Address, BytesN, Env, Symbol, contract, contracterror, contractimpl, contracttype,
    panic_with_error, symbol_short, token,
};
#[path = "../../shared/admin_transfer.rs"]
mod admin_transfer_utils;
#[path = "../../shared/upgrade.rs"]
mod upgrade_utils;
use admin_transfer_utils::{
    AdminTransferErrors, AdminTransferKeys, accept_admin_transfer as accept_admin_transfer_flow,
    cancel_admin_transfer as cancel_admin_transfer_flow,
    pending_admin_transfer as pending_admin_transfer_flow,
    propose_admin_transfer as propose_admin_transfer_flow,
};
use upgrade_utils::{
    ExecuteTimePolicy, UpgradeErrors, UpgradeKeys, UpgradeTopics,
    cancel_upgrade as cancel_upgrade_flow, execute_upgrade as execute_upgrade_flow,
    pending_upgrade as pending_upgrade_flow, propose_upgrade as propose_upgrade_flow,
};

// ── Storage keys ──────────────────────────────────────────────────────────────

const ADMIN_KEY: Symbol = symbol_short!("ADMIN");
const PENDING_ADMIN_KEY: Symbol = symbol_short!("P_ADMIN");
const ADMIN_EXPIRY_KEY: Symbol = symbol_short!("A_EXP");
const PAUSED_KEY: Symbol = symbol_short!("PAUSED");

const ADMIN_TRANSFER_EXPIRY: u64 = 7 * 24 * 60 * 60;
const TOKEN_KEY: Symbol = symbol_short!("TOKEN");
const FACTORY_KEY: Symbol = symbol_short!("FACTRY");
pub const TOTAL_STAKED_KEY: Symbol = symbol_short!("TSTAKE");
const TOTAL_SHARES_KEY: Symbol = symbol_short!("TSHARES");
const PENDING_HASH_KEY: Symbol = symbol_short!("P_HASH");
const EXECUTE_AFTER_KEY: Symbol = symbol_short!("P_AFTER");
const LOCK_PERIOD_KEY: Symbol = symbol_short!("LOCK_SEC");
const MIN_STAKE_KEY: Symbol = symbol_short!("MIN_STK");
const MAX_STAKE_KEY: Symbol = symbol_short!("MAX_STK");
const REWARDS_ENABLED_KEY: Symbol = symbol_short!("RWD_EN");
const REWARD_PER_SHARE_KEY: Symbol = symbol_short!("RWD_PSH");
const REWARD_POOL_KEY: Symbol = symbol_short!("RWD_POOL");
const UNALLOCATED_REWARDS_KEY: Symbol = symbol_short!("RWD_UNA");

// ── Timelock: 48 hours in seconds ─────────────────────────────────────────────
const TIMELOCK_PERIOD: u64 = 48 * 60 * 60;
const EVENT_VERSION: u32 = 1;

// ── TTL constants for persistent stake/reward entries ─────────────────────────
// Bump stake records when they have fewer than 7 days of life remaining,
// extending to ~31 days (535_680 ledgers at ~5 s/ledger).
const STAKING_TTL_THRESHOLD: u32 = 100_000;
const STAKING_TTL_EXTEND_TO: u32 = 535_680;
const PRECISION: i128 = 1_000_000_000_000_000_000;

// ── Event topics ──────────────────────────────────────────────────────────────

const TOPIC_PAUSED: Symbol = symbol_short!("PAUSED");
const TOPIC_UNPAUSED: Symbol = symbol_short!("UNPAUSED");
const TOPIC_STAKE: Symbol = symbol_short!("STAKED");
const TOPIC_UNSTAKE: Symbol = symbol_short!("UNSTAKED");
const TOPIC_UPGRADE_PROPOSED: Symbol = symbol_short!("UP_PROP");
const TOPIC_UPGRADE_EXECUTED: Symbol = symbol_short!("UP_EXEC");
const TOPIC_UPGRADE_CANCELLED: Symbol = symbol_short!("UP_CANC");
const TOPIC_ADMIN_PROPOSED: Symbol = symbol_short!("AD_PROP");
const TOPIC_ADMIN_ACCEPTED: Symbol = symbol_short!("AD_DONE");
const TOPIC_ADMIN_CANCELLED: Symbol = symbol_short!("AD_CANC");
const TOPIC_REWARDS_DEPOSITED: Symbol = symbol_short!("RWD_DEP");
const TOPIC_REWARDS_CLAIMED: Symbol = symbol_short!("RWD_CLM");
const TOPIC_COMPOUNDED: Symbol = symbol_short!("CMPND");
const TOPIC_CONFIG_UPDATED: Symbol = symbol_short!("CFG_UP");

// ── Error codes ───────────────────────────────────────────────────────────────

#[contracterror]
#[derive(Copy, Clone, Debug, Eq, PartialEq, PartialOrd, Ord)]
#[repr(u32)]
pub enum StakingError {
    NotInitialized = 1,
    AlreadyInitialized = 2,
    Paused = 3,
    InvalidAmount = 4,
    InsufficientShares = 5,
    ZeroShares = 6,
    NoPendingUpgrade = 7,
    TimelockNotExpired = 8,
    UpgradeAlreadyPending = 9,
    HashMismatch = 10,
    NoPendingAdminTransfer = 11,
    AdminTransferExpired = 12,
    Unauthorized = 13,
    LockedStake = 14,
    StillLocked = 15,
    InsufficientBalance = 16,
    NothingToCompound = 17,
    BelowMinStake = 18,
    ExceedsMaxStake = 19,
}

// ── Storage key schema ────────────────────────────────────────────────────────

#[contracttype]
#[derive(Clone)]
enum DataKey {
    Stake(Address),
    Position(Address),
    HostLock(Address, u64),
    HostLockedTotal(Address),
    RewardDebt(Address),
    PendingRewards(Address),
    StakedAt(Address),
    TotalClaimedRewards(Address),
}

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct StakerBalance {
    pub amount: i128,
    pub staked_at: u64,
    pub last_reward_snapshot: i128,
}

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct StakingConfig {
    pub token_address: Address,
    pub min_stake: i128,
    pub lock_period_seconds: u64,
    pub max_stake_per_address: i128,
    pub rewards_enabled: bool,
}

// ── Types ─────────────────────────────────────────────────────────────────────

/// Per-staker position record.
///
/// * `amount`  — total tokens currently deposited by this staker.
/// * `shares`  — shares currently held by this staker.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct StakePosition {
    pub amount: i128,
    pub shares: i128,
}

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct StakerStats {
    pub staked_amount: i128,
    pub pending_rewards: i128,
    pub unlock_at: u64,
    pub total_claimed_rewards: i128,
    pub stake_share_bps: u32,
}

// ── Contract ──────────────────────────────────────────────────────────────────

#[contract]
pub struct StakingContract;

#[contractimpl]
impl StakingContract {
    /// Placeholder function — returns a fixed value for contract liveness checks.
    pub fn hello(_env: Env) -> u32 {
        101112
    }

    // ── Initialisation ───────────────────────────────────────────────────────

    /// Initialise the staking contract. Must be called exactly once after deployment.
    ///
    /// # Authorization
    /// Requires auth from the `admin` address to prevent front-running.
    pub fn __constructor(env: Env, admin: Address, token: Address) {
        admin.require_auth();
        env.storage().instance().set(&ADMIN_KEY, &admin);
        env.storage().instance().set(&TOKEN_KEY, &token);
        env.storage().instance().set(&LOCK_PERIOD_KEY, &0u64);
        env.storage().instance().set(&MIN_STAKE_KEY, &1i128);
        env.storage().instance().set(&MAX_STAKE_KEY, &i128::MAX);
        env.storage().instance().set(&REWARDS_ENABLED_KEY, &true);
        env.storage().instance().set(&REWARD_PER_SHARE_KEY, &0i128);
        env.storage().instance().set(&REWARD_POOL_KEY, &0i128);
        env.storage()
            .instance()
            .set(&UNALLOCATED_REWARDS_KEY, &0i128);
    }

    /// Return the current admin address.
    pub fn admin(env: Env) -> Address {
        env.storage()
            .instance()
            .get(&ADMIN_KEY)
            .unwrap_or_else(|| panic_with_error!(&env, StakingError::NotInitialized))
    }

    /// Return the staking token address.
    pub fn token(env: Env) -> Address {
        env.storage()
            .instance()
            .get(&TOKEN_KEY)
            .unwrap_or_else(|| panic_with_error!(&env, StakingError::NotInitialized))
    }

    /// Admin-only: configure factory contract that can lock/release host stake.
    pub fn set_factory(env: Env, factory: Address) {
        let admin = Self::admin(env.clone());
        admin.require_auth();
        env.storage().instance().set(&FACTORY_KEY, &factory);
    }

    pub fn factory(env: Env) -> Option<Address> {
        env.storage().instance().get(&FACTORY_KEY)
    }

    pub fn set_lock_period_seconds(env: Env, seconds: u64) {
        let admin = Self::admin(env.clone());
        admin.require_auth();
        env.storage().instance().set(&LOCK_PERIOD_KEY, &seconds);
    }

    pub fn lock_period_seconds(env: Env) -> u64 {
        env.storage().instance().get(&LOCK_PERIOD_KEY).unwrap_or(0)
    }

    pub fn set_min_stake(env: Env, min_stake: i128) -> Result<(), StakingError> {
        let admin = Self::admin(env.clone());
        admin.require_auth();
        if min_stake <= 0 {
            return Err(StakingError::InvalidAmount);
        }
        env.storage().instance().set(&MIN_STAKE_KEY, &min_stake);
        Ok(())
    }

    pub fn min_stake(env: Env) -> i128 {
        env.storage().instance().get(&MIN_STAKE_KEY).unwrap_or(1)
    }

    pub fn get_config(env: Env) -> StakingConfig {
        StakingConfig {
            token_address: Self::token(env.clone()),
            min_stake: Self::min_stake(env.clone()),
            lock_period_seconds: Self::lock_period_seconds(env.clone()),
            max_stake_per_address: env
                .storage()
                .instance()
                .get(&MAX_STAKE_KEY)
                .unwrap_or(i128::MAX),
            rewards_enabled: env
                .storage()
                .instance()
                .get(&REWARDS_ENABLED_KEY)
                .unwrap_or(true),
        }
    }

    pub fn update_config(env: Env, config: StakingConfig) -> Result<(), StakingError> {
        let admin = Self::admin(env.clone());
        admin.require_auth();
        if config.min_stake <= 0 {
            return Err(StakingError::InvalidAmount);
        }
        if config.max_stake_per_address < config.min_stake {
            return Err(StakingError::InvalidAmount);
        }
        env.storage()
            .instance()
            .set(&TOKEN_KEY, &config.token_address);
        env.storage()
            .instance()
            .set(&MIN_STAKE_KEY, &config.min_stake);
        env.storage()
            .instance()
            .set(&LOCK_PERIOD_KEY, &config.lock_period_seconds);
        env.storage()
            .instance()
            .set(&MAX_STAKE_KEY, &config.max_stake_per_address);
        env.storage()
            .instance()
            .set(&REWARDS_ENABLED_KEY, &config.rewards_enabled);
        env.events()
            .publish((TOPIC_CONFIG_UPDATED,), (EVENT_VERSION, config));
        Ok(())
    }

    // ── Pause mechanism ──────────────────────────────────────────────────────

    /// Pause the contract. Prevents `stake` and `unstake` from executing.
    ///
    /// # Authorization
    /// Requires admin signature.
    pub fn pause(env: Env) {
        let admin = Self::admin(env.clone());
        admin.require_auth();
        env.storage().instance().set(&PAUSED_KEY, &true);
        env.events().publish((TOPIC_PAUSED,), ());
    }

    /// Unpause the contract. Restores normal `stake` and `unstake` operation.
    ///
    /// # Authorization
    /// Requires admin signature.
    pub fn unpause(env: Env) {
        let admin = Self::admin(env.clone());
        admin.require_auth();
        env.storage().instance().set(&PAUSED_KEY, &false);
        env.events().publish((TOPIC_UNPAUSED,), ());
    }

    /// Return whether the contract is currently paused.
    pub fn is_paused(env: Env) -> bool {
        env.storage().instance().get(&PAUSED_KEY).unwrap_or(false)
    }

    // ── Query functions ───────────────────────────────────────────────────────

    /// Total tokens currently held in the staking pool.
    pub fn total_staked(env: Env) -> i128 {
        env.storage()
            .instance()
            .get(&TOTAL_STAKED_KEY)
            .unwrap_or(0i128)
    }

    /// Total shares outstanding across all stakers.
    pub fn total_shares(env: Env) -> i128 {
        env.storage()
            .instance()
            .get(&TOTAL_SHARES_KEY)
            .unwrap_or(0i128)
    }

    /// Return the `StakePosition` for `staker`.
    pub fn get_position(env: Env, staker: Address) -> StakePosition {
        env.storage()
            .persistent()
            .get(&DataKey::Position(staker))
            .unwrap_or(StakePosition {
                amount: 0,
                shares: 0,
            })
    }

    /// Return the token amount currently staked by `staker`.
    pub fn staked_balance(env: Env, staker: Address) -> i128 {
        Self::get_position(env, staker).amount
    }

    pub fn get_staker_stats(env: Env, staker: Address) -> StakerStats {
        let position = Self::get_position(env.clone(), staker.clone());
        let total_staked = Self::total_staked(env.clone());
        let pending_rewards = pending_rewards_of(&env, &staker, &position);
        let staked_at: u64 = env
            .storage()
            .persistent()
            .get(&DataKey::StakedAt(staker.clone()))
            .unwrap_or(0);
        let unlock_at = staked_at.saturating_add(Self::lock_period_seconds(env.clone()));
        let total_claimed_rewards: i128 = env
            .storage()
            .persistent()
            .get(&DataKey::TotalClaimedRewards(staker.clone()))
            .unwrap_or(0);
        let stake_share_bps = if total_staked <= 0 || position.amount <= 0 {
            0
        } else {
            position
                .amount
                .checked_mul(10_000)
                .and_then(|v| v.checked_div(total_staked))
                .unwrap_or(0) as u32
        };

        StakerStats {
            staked_amount: position.amount,
            pending_rewards,
            unlock_at,
            total_claimed_rewards,
            stake_share_bps,
        }
    }

    /// Returns currently available host stake (staked minus locked amount).
    pub fn get_host_stake(env: Env, host: Address) -> i128 {
        let total = Self::staked_balance(env.clone(), host.clone());
        let locked: i128 = env
            .storage()
            .persistent()
            .get(&DataKey::HostLockedTotal(host))
            .unwrap_or(0);
        total.saturating_sub(locked)
    }

    /// Lock host stake for an arena so host cannot withdraw below reserved amount.
    ///
    /// # Authorization
    /// `caller` must be either the contract admin or the configured factory address.
    /// Any other caller is rejected with [`StakingError::Unauthorized`].
    pub fn lock_host_stake(
        env: Env,
        caller: Address,
        host: Address,
        arena_id: u64,
        amount: i128,
    ) -> Result<(), StakingError> {
        caller.require_auth();
        let admin = Self::admin(env.clone());
        let factory = Self::factory(env.clone());
        let is_authorized = caller == admin || factory.as_ref().is_some_and(|f| *f == caller);
        if !is_authorized {
            return Err(StakingError::Unauthorized);
        }
        if amount <= 0 {
            return Err(StakingError::InvalidAmount);
        }
        let available = Self::get_host_stake(env.clone(), host.clone());
        if available < amount {
            return Err(StakingError::InsufficientShares);
        }
        let lock_key = DataKey::HostLock(host.clone(), arena_id);
        if env.storage().persistent().has(&lock_key) {
            return Ok(());
        }
        env.storage().persistent().set(&lock_key, &amount);
        env.storage()
            .persistent()
            .extend_ttl(&lock_key, STAKING_TTL_THRESHOLD, STAKING_TTL_EXTEND_TO);
        let current_locked: i128 = env
            .storage()
            .persistent()
            .get(&DataKey::HostLockedTotal(host.clone()))
            .unwrap_or(0);
        let locked_total_key = DataKey::HostLockedTotal(host);
        env.storage()
            .persistent()
            .set(&locked_total_key, &(current_locked + amount));
        env.storage()
            .persistent()
            .extend_ttl(&locked_total_key, STAKING_TTL_THRESHOLD, STAKING_TTL_EXTEND_TO);
        Ok(())
    }

    /// Release previously locked host stake for an arena.
    pub fn release_host_stake(
        env: Env,
        caller: Address,
        host: Address,
        arena_id: u64,
    ) -> Result<(), StakingError> {
        caller.require_auth();
        let admin = Self::admin(env.clone());
        let factory = Self::factory(env.clone());
        let is_authorized = caller == admin || factory.as_ref().is_some_and(|f| *f == caller);
        if !is_authorized {
            return Err(StakingError::Unauthorized);
        }
        let lock_key = DataKey::HostLock(host.clone(), arena_id);
        let Some(locked_amount) = env.storage().persistent().get::<_, i128>(&lock_key) else {
            return Ok(());
        };
        env.storage().persistent().remove(&lock_key);
        let current_locked: i128 = env
            .storage()
            .persistent()
            .get(&DataKey::HostLockedTotal(host.clone()))
            .unwrap_or(0);
        let next_locked = current_locked.saturating_sub(locked_amount);
        env.storage()
            .persistent()
            .set(&DataKey::HostLockedTotal(host), &next_locked);
        Ok(())
    }

    // ── Staking ───────────────────────────────────────────────────────────────

    /// Deposit `amount` tokens and return the number of shares minted.
    ///
    /// Shares are minted proportionally: when the pool is empty, shares = amount;
    /// otherwise, shares = amount × total_shares / total_staked.
    ///
    /// # Errors
    /// * [`StakingError::Paused`] — Contract is paused.
    /// * [`StakingError::NotInitialized`] — Contract has not been initialized.
    /// * [`StakingError::InvalidAmount`] — `amount` is zero or negative.
    ///
    /// # Authorization
    /// Requires `staker.require_auth()`.
    pub fn stake(env: Env, staker: Address, amount: i128) -> Result<i128, StakingError> {
        require_not_paused(&env)?;
        staker.require_auth();

        if amount <= 0 {
            return Err(StakingError::InvalidAmount);
        }
        let min_stake = Self::min_stake(env.clone());
        if amount < min_stake {
            return Err(StakingError::BelowMinStake);
        }

        let token_contract = get_token_contract(&env)?;

        let mut position: StakePosition = env
            .storage()
            .persistent()
            .get(&DataKey::Position(staker.clone()))
            .unwrap_or(StakePosition {
                amount: 0,
                shares: 0,
            });
        accrue_rewards(&env, &staker, &position)?;

        let total_staked: i128 = env.storage().instance().get(&TOTAL_STAKED_KEY).unwrap_or(0);
        let total_shares: i128 = env.storage().instance().get(&TOTAL_SHARES_KEY).unwrap_or(0);
        let max_stake: i128 = env
            .storage()
            .instance()
            .get(&MAX_STAKE_KEY)
            .unwrap_or(i128::MAX);
        let new_balance = position
            .amount
            .checked_add(amount)
            .ok_or(StakingError::InvalidAmount)?;
        if new_balance > max_stake {
            return Err(StakingError::ExceedsMaxStake);
        }

        let shares_minted = if total_staked == 0 || total_shares == 0 {
            amount
        } else {
            amount
                .checked_mul(total_shares)
                .and_then(|v| v.checked_div(total_staked))
                .unwrap_or(amount)
        };

        // CEI: update state before token transfer.
        env.storage()
            .instance()
            .set(&TOTAL_STAKED_KEY, &(total_staked + amount));
        env.storage()
            .instance()
            .set(&TOTAL_SHARES_KEY, &(total_shares + shares_minted));
        position.amount = new_balance;
        position.shares += shares_minted;
        env.storage()
            .persistent()
            .set(&DataKey::Position(staker.clone()), &position);
        env.storage().persistent().set(
            &DataKey::StakedAt(staker.clone()),
            &env.ledger().timestamp(),
        );
        let reward_snapshot: i128 = env
            .storage()
            .instance()
            .get(&REWARD_PER_SHARE_KEY)
            .unwrap_or(0);
        env.storage().persistent().set(
            &DataKey::Stake(staker.clone()),
            &StakerBalance {
                amount: new_balance,
                staked_at: env.ledger().timestamp(),
                last_reward_snapshot: reward_snapshot,
            },
        );
        sync_reward_debt(&env, &staker)?;
        distribute_unallocated_rewards(&env)?;
        extend_staker_entry_ttl(&env, &staker);

        // Interaction: transfer tokens into the contract.
        token::Client::new(&env, &token_contract).transfer(
            &staker,
            &env.current_contract_address(),
            &amount,
        );

        env.events()
            .publish((TOPIC_STAKE,), (staker, amount, total_staked + amount));

        Ok(shares_minted)
    }

    /// Redeem `shares` shares and return the corresponding token amount.
    ///
    /// Tokens returned = shares × total_staked / total_shares.
    ///
    /// # Errors
    /// * [`StakingError::Paused`] — Contract is paused.
    /// * [`StakingError::NotInitialized`] — Contract has not been initialized.
    /// * [`StakingError::ZeroShares`] — `shares` is zero.
    /// * [`StakingError::InvalidAmount`] — `shares` is negative.
    /// * [`StakingError::InsufficientShares`] — `shares` exceeds staker's balance.
    ///
    /// # Authorization
    /// Requires `staker.require_auth()`.
    pub fn unstake(env: Env, staker: Address, amount: i128) -> Result<i128, StakingError> {
        require_not_paused(&env)?;
        staker.require_auth();

        if amount == 0 {
            return Err(StakingError::ZeroShares);
        }
        if amount < 0 {
            return Err(StakingError::InvalidAmount);
        }

        let mut position: StakePosition = env
            .storage()
            .persistent()
            .get(&DataKey::Position(staker.clone()))
            .unwrap_or(StakePosition {
                amount: 0,
                shares: 0,
            });
        if position.amount < amount {
            return Err(StakingError::InsufficientBalance);
        }

        let staked_at: u64 = env
            .storage()
            .persistent()
            .get(&DataKey::StakedAt(staker.clone()))
            .unwrap_or(0);
        let unlock_at = staked_at.saturating_add(Self::lock_period_seconds(env.clone()));
        if env.ledger().timestamp() < unlock_at {
            return Err(StakingError::StillLocked);
        }

        accrue_rewards(&env, &staker, &position)?;

        let total_staked: i128 = env.storage().instance().get(&TOTAL_STAKED_KEY).unwrap_or(0);
        let total_shares: i128 = env.storage().instance().get(&TOTAL_SHARES_KEY).unwrap_or(0);

        let shares_to_burn = if amount == position.amount {
            position.shares
        } else {
            amount
                .checked_mul(total_shares)
                .and_then(|v| v.checked_div(total_staked))
                .unwrap_or(0)
                .max(1)
                .min(position.shares)
        };

        let currently_locked: i128 = env
            .storage()
            .persistent()
            .get(&DataKey::HostLockedTotal(staker.clone()))
            .unwrap_or(0);
        if position.amount.saturating_sub(amount) < currently_locked {
            return Err(StakingError::LockedStake);
        }

        let token_contract = get_token_contract(&env)?;

        // CEI: update state before token transfer.
        position.shares = position.shares.saturating_sub(shares_to_burn);
        position.amount = position.amount.saturating_sub(amount);
        if position.shares == 0 || position.amount == 0 {
            env.storage()
                .persistent()
                .remove(&DataKey::Position(staker.clone()));
            env.storage()
                .persistent()
                .remove(&DataKey::RewardDebt(staker.clone()));
            env.storage()
                .persistent()
                .remove(&DataKey::StakedAt(staker.clone()));
        } else {
            env.storage()
                .persistent()
                .set(&DataKey::Position(staker.clone()), &position);
            sync_reward_debt(&env, &staker)?;
            extend_staker_entry_ttl(&env, &staker);
        }
        env.storage()
            .instance()
            .set(&TOTAL_STAKED_KEY, &(total_staked - amount));
        env.storage()
            .instance()
            .set(&TOTAL_SHARES_KEY, &(total_shares - shares_to_burn));

        // Interaction: transfer tokens back to staker.
        token::Client::new(&env, &token_contract).transfer(
            &env.current_contract_address(),
            &staker,
            &amount,
        );

        env.events()
            .publish((TOPIC_UNSTAKE,), (staker, amount, position.amount));

        Ok(amount)
    }

    pub fn deposit_rewards(env: Env, from: Address, amount: i128) -> Result<(), StakingError> {
        require_not_paused(&env)?;
        from.require_auth();
        if amount <= 0 {
            return Err(StakingError::InvalidAmount);
        }

        let admin = Self::admin(env.clone());
        let factory = Self::factory(env.clone());
        let is_authorized = from == admin || factory.as_ref().is_some_and(|f| *f == from);
        if !is_authorized {
            return Err(StakingError::Unauthorized);
        }

        let token_contract = get_token_contract(&env)?;
        token::Client::new(&env, &token_contract).transfer(
            &from,
            &env.current_contract_address(),
            &amount,
        );

        let reward_pool: i128 = env.storage().instance().get(&REWARD_POOL_KEY).unwrap_or(0);
        env.storage()
            .instance()
            .set(&REWARD_POOL_KEY, &(reward_pool + amount));

        let total_shares = Self::total_shares(env.clone());
        if total_shares > 0 {
            let reward_per_share = env
                .storage()
                .instance()
                .get(&REWARD_PER_SHARE_KEY)
                .unwrap_or(0i128);
            let delta = amount
                .checked_mul(PRECISION)
                .and_then(|v| v.checked_div(total_shares))
                .unwrap_or(0);
            env.storage()
                .instance()
                .set(&REWARD_PER_SHARE_KEY, &(reward_per_share + delta));
        } else {
            let unallocated: i128 = env
                .storage()
                .instance()
                .get(&UNALLOCATED_REWARDS_KEY)
                .unwrap_or(0);
            env.storage()
                .instance()
                .set(&UNALLOCATED_REWARDS_KEY, &(unallocated + amount));
        }

        env.events()
            .publish((TOPIC_REWARDS_DEPOSITED,), (from, amount));
        Ok(())
    }

    pub fn claim_rewards(env: Env, staker: Address) -> Result<i128, StakingError> {
        require_not_paused(&env)?;
        staker.require_auth();

        let position = Self::get_position(env.clone(), staker.clone());
        accrue_rewards(&env, &staker, &position)?;

        let claim_key = DataKey::PendingRewards(staker.clone());
        let claimable: i128 = env.storage().persistent().get(&claim_key).unwrap_or(0);
        if claimable <= 0 {
            return Ok(0);
        }

        let token_contract = get_token_contract(&env)?;
        let pool: i128 = env.storage().instance().get(&REWARD_POOL_KEY).unwrap_or(0);
        env.storage()
            .instance()
            .set(&REWARD_POOL_KEY, &pool.saturating_sub(claimable));
        env.storage().persistent().set(&claim_key, &0i128);
        env.storage()
            .persistent()
            .extend_ttl(&claim_key, STAKING_TTL_THRESHOLD, STAKING_TTL_EXTEND_TO);

        let total_claimed_key = DataKey::TotalClaimedRewards(staker.clone());
        let total_claimed: i128 = env
            .storage()
            .persistent()
            .get(&total_claimed_key)
            .unwrap_or(0);
        env.storage()
            .persistent()
            .set(&total_claimed_key, &(total_claimed + claimable));
        env.storage()
            .persistent()
            .extend_ttl(&total_claimed_key, STAKING_TTL_THRESHOLD, STAKING_TTL_EXTEND_TO);

        token::Client::new(&env, &token_contract).transfer(
            &env.current_contract_address(),
            &staker,
            &claimable,
        );
        env.events()
            .publish((TOPIC_REWARDS_CLAIMED,), (staker, claimable));
        Ok(claimable)
    }

    pub fn compound(env: Env, staker: Address) -> Result<i128, StakingError> {
        require_not_paused(&env)?;
        staker.require_auth();

        let mut position = Self::get_position(env.clone(), staker.clone());
        accrue_rewards(&env, &staker, &position)?;

        let pending_key = DataKey::PendingRewards(staker.clone());
        let pending: i128 = env.storage().persistent().get(&pending_key).unwrap_or(0);
        if pending <= 0 {
            return Err(StakingError::NothingToCompound);
        }
        if pending < Self::min_stake(env.clone()) && position.amount <= 0 {
            return Err(StakingError::InvalidAmount);
        }

        let total_staked = Self::total_staked(env.clone());
        let total_shares = Self::total_shares(env.clone());
        let shares_minted = if total_staked == 0 || total_shares == 0 {
            pending
        } else {
            pending
                .checked_mul(total_shares)
                .and_then(|v| v.checked_div(total_staked))
                .unwrap_or(pending)
        };

        position.amount += pending;
        position.shares += shares_minted;
        env.storage()
            .persistent()
            .set(&DataKey::Position(staker.clone()), &position);
        env.storage().persistent().set(&pending_key, &0i128);

        let reward_pool: i128 = env.storage().instance().get(&REWARD_POOL_KEY).unwrap_or(0);
        env.storage()
            .instance()
            .set(&REWARD_POOL_KEY, &reward_pool.saturating_sub(pending));
        env.storage()
            .instance()
            .set(&TOTAL_STAKED_KEY, &(total_staked + pending));
        env.storage()
            .instance()
            .set(&TOTAL_SHARES_KEY, &(total_shares + shares_minted));
        sync_reward_debt(&env, &staker)?;
        extend_staker_entry_ttl(&env, &staker);

        env.events()
            .publish((TOPIC_COMPOUNDED,), (staker, pending, position.amount));
        Ok(pending)
    }

    // ── Upgrade timelock ─────────────────────────────────────────────────────

    pub fn propose_upgrade(env: Env, new_wasm_hash: BytesN<32>) -> Result<(), StakingError> {
        let admin = Self::admin(env.clone());
        admin.require_auth();
        propose_upgrade_flow(
            &env,
            UpgradeKeys {
                pending_hash: &PENDING_HASH_KEY,
                execute_after: &EXECUTE_AFTER_KEY,
            },
            UpgradeTopics {
                proposed: &TOPIC_UPGRADE_PROPOSED,
                executed: &TOPIC_UPGRADE_EXECUTED,
                cancelled: &TOPIC_UPGRADE_CANCELLED,
            },
            EVENT_VERSION,
            TIMELOCK_PERIOD,
            &new_wasm_hash,
            StakingError::UpgradeAlreadyPending,
        )
    }

    pub fn execute_upgrade(env: Env, expected_hash: BytesN<32>) -> Result<(), StakingError> {
        let admin = Self::admin(env.clone());
        admin.require_auth();
        let stored_hash = execute_upgrade_flow(
            &env,
            UpgradeKeys {
                pending_hash: &PENDING_HASH_KEY,
                execute_after: &EXECUTE_AFTER_KEY,
            },
            UpgradeTopics {
                proposed: &TOPIC_UPGRADE_PROPOSED,
                executed: &TOPIC_UPGRADE_EXECUTED,
                cancelled: &TOPIC_UPGRADE_CANCELLED,
            },
            EVENT_VERSION,
            &expected_hash,
            UpgradeErrors {
                no_pending: StakingError::NoPendingUpgrade,
                timelock_not_expired: StakingError::TimelockNotExpired,
                hash_mismatch: StakingError::HashMismatch,
                malformed_state: None,
            },
            ExecuteTimePolicy::AtOrAfter,
        )?;
        env.deployer().update_current_contract_wasm(stored_hash);
        Ok(())
    }

    pub fn cancel_upgrade(env: Env) -> Result<(), StakingError> {
        let admin = Self::admin(env.clone());
        admin.require_auth();
        cancel_upgrade_flow(
            &env,
            UpgradeKeys {
                pending_hash: &PENDING_HASH_KEY,
                execute_after: &EXECUTE_AFTER_KEY,
            },
            UpgradeTopics {
                proposed: &TOPIC_UPGRADE_PROPOSED,
                executed: &TOPIC_UPGRADE_EXECUTED,
                cancelled: &TOPIC_UPGRADE_CANCELLED,
            },
            EVENT_VERSION,
            StakingError::NoPendingUpgrade,
        )
    }

    pub fn pending_upgrade(env: Env) -> Option<(BytesN<32>, u64)> {
        pending_upgrade_flow(
            &env,
            UpgradeKeys {
                pending_hash: &PENDING_HASH_KEY,
                execute_after: &EXECUTE_AFTER_KEY,
            },
        )
    }

    // ── Two-step admin transfer ───────────────────────────────────────────────

    /// Propose a new admin. The pending admin has 7 days to call `accept_admin`.
    pub fn propose_admin(env: Env, new_admin: Address) -> Result<(), StakingError> {
        let admin = Self::admin(env.clone());
        admin.require_auth();
        let expires_at = propose_admin_transfer_flow(
            &env,
            AdminTransferKeys {
                admin: &ADMIN_KEY,
                pending_admin: &PENDING_ADMIN_KEY,
                admin_expiry: &ADMIN_EXPIRY_KEY,
            },
            &new_admin,
            ADMIN_TRANSFER_EXPIRY,
        );
        env.events().publish(
            (TOPIC_ADMIN_PROPOSED,),
            (EVENT_VERSION, admin, new_admin, expires_at),
        );
        Ok(())
    }

    /// Accept a pending admin transfer. Must be called by the proposed new admin
    /// within 7 days.
    pub fn accept_admin(env: Env, new_admin: Address) -> Result<(), StakingError> {
        new_admin.require_auth();
        let old_admin = Self::admin(env.clone());
        accept_admin_transfer_flow(
            &env,
            AdminTransferKeys {
                admin: &ADMIN_KEY,
                pending_admin: &PENDING_ADMIN_KEY,
                admin_expiry: &ADMIN_EXPIRY_KEY,
            },
            &new_admin,
            AdminTransferErrors {
                no_pending: StakingError::NoPendingAdminTransfer,
                unauthorized: StakingError::Unauthorized,
                expired: StakingError::AdminTransferExpired,
            },
        )?;
        env.events().publish(
            (TOPIC_ADMIN_ACCEPTED,),
            (EVENT_VERSION, old_admin, new_admin),
        );
        Ok(())
    }

    /// Cancel a pending admin transfer. Only the current admin may call this.
    pub fn cancel_admin_transfer(env: Env) -> Result<(), StakingError> {
        let admin = Self::admin(env.clone());
        admin.require_auth();
        cancel_admin_transfer_flow(
            &env,
            AdminTransferKeys {
                admin: &ADMIN_KEY,
                pending_admin: &PENDING_ADMIN_KEY,
                admin_expiry: &ADMIN_EXPIRY_KEY,
            },
            StakingError::NoPendingAdminTransfer,
        )?;
        env.events()
            .publish((TOPIC_ADMIN_CANCELLED,), (EVENT_VERSION,));
        Ok(())
    }

    /// Return the pending admin address and expiry timestamp, or `None` if none.
    pub fn pending_admin_transfer(env: Env) -> Option<(Address, u64)> {
        pending_admin_transfer_flow(
            &env,
            AdminTransferKeys {
                admin: &ADMIN_KEY,
                pending_admin: &PENDING_ADMIN_KEY,
                admin_expiry: &ADMIN_EXPIRY_KEY,
            },
        )
    }
}

// ── Helpers ───────────────────────────────────────────────────────────────────

fn get_token_contract(env: &Env) -> Result<Address, StakingError> {
    env.storage()
        .instance()
        .get(&TOKEN_KEY)
        .ok_or(StakingError::NotInitialized)
}

fn extend_staker_entry_ttl(env: &Env, staker: &Address) {
    macro_rules! bump {
        ($key:expr) => {
            let k = $key;
            if env.storage().persistent().has(&k) {
                env.storage()
                    .persistent()
                    .extend_ttl(&k, STAKING_TTL_THRESHOLD, STAKING_TTL_EXTEND_TO);
            }
        };
    }
    bump!(DataKey::Position(staker.clone()));
    bump!(DataKey::Stake(staker.clone()));
    bump!(DataKey::StakedAt(staker.clone()));
    bump!(DataKey::RewardDebt(staker.clone()));
    bump!(DataKey::PendingRewards(staker.clone()));
}

fn require_not_paused(env: &Env) -> Result<(), StakingError> {
    if env.storage().instance().get(&PAUSED_KEY).unwrap_or(false) {
        return Err(StakingError::Paused);
    }
    Ok(())
}

fn pending_rewards_of(env: &Env, staker: &Address, position: &StakePosition) -> i128 {
    let pending: i128 = env
        .storage()
        .persistent()
        .get(&DataKey::PendingRewards(staker.clone()))
        .unwrap_or(0);
    if position.shares <= 0 {
        return pending;
    }

    let reward_per_share: i128 = env
        .storage()
        .instance()
        .get(&REWARD_PER_SHARE_KEY)
        .unwrap_or(0);
    let reward_debt: i128 = env
        .storage()
        .persistent()
        .get(&DataKey::RewardDebt(staker.clone()))
        .unwrap_or(0);
    let delta = reward_per_share.saturating_sub(reward_debt);
    if delta <= 0 {
        return pending;
    }
    let accrued = position
        .shares
        .checked_mul(delta)
        .and_then(|v| v.checked_div(PRECISION))
        .unwrap_or(0);
    pending.saturating_add(accrued)
}

fn accrue_rewards(
    env: &Env,
    staker: &Address,
    position: &StakePosition,
) -> Result<(), StakingError> {
    distribute_unallocated_rewards(env)?;
    let pending = pending_rewards_of(env, staker, position);
    let pending_key = DataKey::PendingRewards(staker.clone());
    env.storage().persistent().set(&pending_key, &pending);
    env.storage()
        .persistent()
        .extend_ttl(&pending_key, STAKING_TTL_THRESHOLD, STAKING_TTL_EXTEND_TO);
    sync_reward_debt(env, staker)?;
    Ok(())
}

fn sync_reward_debt(env: &Env, staker: &Address) -> Result<(), StakingError> {
    let position: StakePosition = env
        .storage()
        .persistent()
        .get(&DataKey::Position(staker.clone()))
        .unwrap_or(StakePosition {
            amount: 0,
            shares: 0,
        });
    if position.shares <= 0 {
        env.storage()
            .persistent()
            .remove(&DataKey::RewardDebt(staker.clone()));
        return Ok(());
    }
    let reward_per_share: i128 = env
        .storage()
        .instance()
        .get(&REWARD_PER_SHARE_KEY)
        .unwrap_or(0);
    let reward_debt_key = DataKey::RewardDebt(staker.clone());
    env.storage()
        .persistent()
        .set(&reward_debt_key, &reward_per_share);
    env.storage()
        .persistent()
        .extend_ttl(&reward_debt_key, STAKING_TTL_THRESHOLD, STAKING_TTL_EXTEND_TO);
    Ok(())
}

fn distribute_unallocated_rewards(env: &Env) -> Result<(), StakingError> {
    let unallocated: i128 = env
        .storage()
        .instance()
        .get(&UNALLOCATED_REWARDS_KEY)
        .unwrap_or(0);
    if unallocated <= 0 {
        return Ok(());
    }
    let total_shares: i128 = env.storage().instance().get(&TOTAL_SHARES_KEY).unwrap_or(0);
    if total_shares <= 0 {
        return Ok(());
    }
    let reward_per_share: i128 = env
        .storage()
        .instance()
        .get(&REWARD_PER_SHARE_KEY)
        .unwrap_or(0);
    let delta = unallocated
        .checked_mul(PRECISION)
        .and_then(|v| v.checked_div(total_shares))
        .ok_or(StakingError::InvalidAmount)?;
    env.storage()
        .instance()
        .set(&REWARD_PER_SHARE_KEY, &(reward_per_share + delta));
    env.storage()
        .instance()
        .set(&UNALLOCATED_REWARDS_KEY, &0i128);
    Ok(())
}

#[cfg(test)]
mod test;

#[cfg(test)]
mod integration_tests;

#[cfg(test)]
mod snapshot_test;
