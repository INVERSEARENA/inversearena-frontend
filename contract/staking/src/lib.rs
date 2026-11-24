#![no_std]
#![cfg_attr(coverage_nightly, feature(coverage_attribute))]
pub mod share_math;
mod types;

use soroban_sdk::{
    Address, BytesN, Env, Symbol, Vec, contract, contractimpl, contracttype, symbol_short, token,
};
use types::{StakePosition, StakerStats, StorageKeyInfo, StakingError, Totals};

// ─── Persistent storage keys ─────────────────────────────────────────────
// Migrated from instance storage (#1009) so each key's TTL can be extended
// independently of the contract instance lifetime.

const ADMIN_KEY: soroban_sdk::Symbol = symbol_short!("ADMIN");
const PAUSED_KEY: soroban_sdk::Symbol = symbol_short!("PAUSED");
const TOKEN_KEY: soroban_sdk::Symbol = symbol_short!("TOKEN");
const TSTAKE_KEY: soroban_sdk::Symbol = symbol_short!("TSTAKE");
const TSHARES_KEY: soroban_sdk::Symbol = symbol_short!("TSHARES");
const TOTALS_KEY: soroban_sdk::Symbol = symbol_short!("TOTALS");
const PENDING_ADMIN_KEY: soroban_sdk::Symbol = symbol_short!("P_ADMIN");
const REWARD_RATE_KEY: soroban_sdk::Symbol = symbol_short!("RWRATE");
const PERIOD_FINISH_KEY: soroban_sdk::Symbol = symbol_short!("RWFINISH");
const LAST_UPDATE_KEY: soroban_sdk::Symbol = symbol_short!("RWUPDATE");
const REWARD_DURATION_KEY: soroban_sdk::Symbol = symbol_short!("RWDUR");
const DEFAULT_REWARD_DURATION: u64 = 7 * 24 * 60 * 60;

// TTL thresholds matching the arena contract pattern.
const PERSISTENT_TTL_THRESHOLD: u32 = 518_400;
const PERSISTENT_TTL_EXTEND_TO: u32 = 6_307_200;

/// Staking contract ABI/storage version, for client-side capability
/// negotiation across mixed deployment versions.
/// Bumped to 2 for #1516: adds the additive `ttl_health` and `renew_storage`
/// entrypoints so the keeper can negotiate TTL-health support via
/// `contractCapability.ts` rather than probing for the methods blindly.
const CONTRACT_VERSION: u32 = 2;
const CURRENT_STORAGE_VERSION: u32 = 1;

/// Minimum deposit accepted when the pool holds no shares, in token base units.
///
/// # Share-inflation ("donation") attack
///
/// Shares are minted pro rata: `amount * total_shares / total_staked`. An
/// attacker who is first into an empty pool can seed it with a dust deposit —
/// say 1 base unit, minting 1 share — and then inflate `total_staked` without
/// minting any shares against it. In this contract the inflation lever is
/// [`StakingContract::distribute_rewards`], which is callable by anyone and
/// credits the pool's value while leaving `total_shares` untouched. (Raw token
/// transfers into the contract are *not* a lever here, because `total_staked`
/// is tracked in storage rather than read from the token balance.)
///
/// With `total_shares = 1` and `total_staked = 1 + D`, the next depositor's
/// integer division rounds down: any deposit smaller than `1 + D` mints **zero**
/// shares, and the whole deposit accrues to the attacker's single share.
///
/// Two guards close this off:
///
/// 1. The pool must be seeded with at least `MIN_INITIAL_STAKE` base units, so
///    a dust first deposit can never make one share represent the pool. The
///    attacker must now donate roughly `MIN_INITIAL_STAKE` times the victim's
///    deposit to steal a comparable amount, which costs more than it takes.
/// 2. A deposit that would round down to zero shares is rejected outright with
///    [`StakingError::ZeroShares`], so no depositor can ever be diluted to
///    nothing even if guard (1) is somehow cleared.
///
/// Test builds use a small floor so the existing fixtures can keep staking
/// human-readable amounts; release builds require 1 XLM on a 7-decimal token.
#[cfg(not(test))]
const MIN_INITIAL_STAKE: i128 = 10_000_000;
/// Test-build floor for `MIN_INITIAL_STAKE`; see the release constant above.
#[cfg(test)]
const MIN_INITIAL_STAKE: i128 = 10;

#[contracttype]
pub enum DataKey {
    Position(Address),
    StorageVersion,
}

#[cfg(test)]
mod auth_tests;

#[contract]
pub struct StakingContract;

/// Extend the TTL of a persistent key if it exists.
/// Matches the pattern used by the arena contract.

fn load_storage_version(env: &Env) -> u32 {
    extend_persistent_ttl(env, &DataKey::StorageVersion);
    env.storage().persistent().get(&DataKey::StorageVersion).unwrap_or(CURRENT_STORAGE_VERSION)
}
fn save_storage_version(env: &Env, v: u32) {
    env.storage().persistent().set(&DataKey::StorageVersion, &v);
    extend_persistent_ttl(&env, &DataKey::StorageVersion);
}
fn require_current_storage_version(env: &Env) -> Result<(), StakingError> {
    if load_storage_version(env) < CURRENT_STORAGE_VERSION { return Err(StakingError::MigrationPending); }
    Ok(())
}
fn extend_persistent_ttl<K: soroban_sdk::IntoVal<Env, soroban_sdk::Val>>(env: &Env, key: &K) {
    if env.storage().persistent().has(key) {
        env.storage().persistent().extend_ttl(
            key,
            PERSISTENT_TTL_THRESHOLD,
            PERSISTENT_TTL_EXTEND_TO,
        );
    }
}

#[contractimpl]
impl StakingContract {
    /// Initialize the staking contract.
    ///
    /// #1012: Now emits an `INIT` event with admin and token addresses
    /// so off-chain indexers can detect contract setup.
    pub fn initialize(env: Env, admin: Address, token: Address) -> Result<(), StakingError> {
        admin.require_auth();
        if env.storage().persistent().has(&ADMIN_KEY) {
            return Err(StakingError::AlreadyInitialized);
        }

        // #1009: Use persistent storage instead of instance storage.
        env.storage().persistent().set(&ADMIN_KEY, &admin);
        extend_persistent_ttl(&env, &ADMIN_KEY);
        save_storage_version(&env, CURRENT_STORAGE_VERSION);
        env.storage().persistent().set(&TOKEN_KEY, &token);
        extend_persistent_ttl(&env, &TOKEN_KEY);
        env.storage().persistent().set(&TOTALS_KEY, &Totals {
            staked: 0,
            shares: 0,
            reward_rate: 0,
            period_finish: 0,
            last_update: env.ledger().timestamp(),
        });
        extend_persistent_ttl(&env, &TOTALS_KEY);
        #[cfg(test)]
        {
            // Keep fixture-level access to the pre-#1623 keys while tests
            // exercise deployed-instance migration behaviour.
            env.storage().persistent().set(&TSTAKE_KEY, &0i128);
            extend_persistent_ttl(&env, &TSTAKE_KEY);
            env.storage().persistent().set(&TSHARES_KEY, &0i128);
            extend_persistent_ttl(&env, &TSHARES_KEY);
            env.storage().persistent().set(&REWARD_RATE_KEY, &0i128);
            extend_persistent_ttl(&env, &REWARD_RATE_KEY);
            env.storage().persistent().set(&PERIOD_FINISH_KEY, &0u64);
            extend_persistent_ttl(&env, &PERIOD_FINISH_KEY);
            env.storage().persistent().set(&LAST_UPDATE_KEY, &env.ledger().timestamp());
            extend_persistent_ttl(&env, &LAST_UPDATE_KEY);
        }
        env.storage().persistent().set(&PAUSED_KEY, &false);
        extend_persistent_ttl(&env, &PAUSED_KEY);
        env.storage().persistent().set(&REWARD_DURATION_KEY, &DEFAULT_REWARD_DURATION);
        extend_persistent_ttl(&env, &REWARD_DURATION_KEY);
        for key in Self::critical_global_keys(&env).iter() {
            extend_persistent_ttl(&env, &key);
        }
        extend_persistent_ttl(&env, &DataKey::StorageVersion);
        #[cfg(test)]
        for key in [
            TSTAKE_KEY,
            TSHARES_KEY,
            REWARD_RATE_KEY,
            PERIOD_FINISH_KEY,
            LAST_UPDATE_KEY,
        ] {
            extend_persistent_ttl(&env, &key);
        }

        // #1012: Emit initialization event.
        env.events()
            .publish((symbol_short!("INIT"),), (admin, token));

        Ok(())
    }

    /// Return the staking contract ABI/storage version.
    pub fn version(_env: Env) -> u32 {
        CONTRACT_VERSION
    }
    pub fn storage_version(env: Env) -> u32 { load_storage_version(&env) }
    pub fn migrate(env: Env, caller: Address, _max_steps: u32) -> Result<u32, StakingError> {
        caller.require_auth();
        extend_persistent_ttl(&env, &ADMIN_KEY);
        let admin: Address = env.storage().persistent().get(&ADMIN_KEY).ok_or(StakingError::NotInitialized)?;
        if caller != admin { return Err(StakingError::Unauthorized); }
        save_storage_version(&env, CURRENT_STORAGE_VERSION); Ok(CURRENT_STORAGE_VERSION)
    }

    pub fn admin(env: Env) -> Address {
        extend_persistent_ttl(&env, &ADMIN_KEY);
        env.storage()
            .persistent()
            .get(&ADMIN_KEY)
            .expect("not initialized")
    }

    pub fn token(env: Env) -> Address {
        extend_persistent_ttl(&env, &TOKEN_KEY);
        env.storage()
            .persistent()
            .get(&TOKEN_KEY)
            .expect("not initialized")
    }

    pub fn pause(env: Env) -> Result<(), StakingError> {
        require_current_storage_version(&env)?;
        Self::require_admin(&env)?;
        env.storage().persistent().set(&PAUSED_KEY, &true);
        extend_persistent_ttl(&env, &PAUSED_KEY);
        env.events().publish((symbol_short!("PAUSED"),), ());
        Ok(())
    }

    pub fn unpause(env: Env) -> Result<(), StakingError> {
        require_current_storage_version(&env)?;
        Self::require_admin(&env)?;
        env.storage().persistent().set(&PAUSED_KEY, &false);
        extend_persistent_ttl(&env, &PAUSED_KEY);
        env.events().publish((symbol_short!("UNPAUS"),), ());
        Ok(())
    }

    pub fn is_paused(env: Env) -> bool {
        extend_persistent_ttl(&env, &PAUSED_KEY);
        env.storage().persistent().get(&PAUSED_KEY).unwrap_or(false)
    }

    pub fn propose_admin(env: Env, new_admin: Address) -> Result<(), StakingError> {
        require_current_storage_version(&env)?;
        let admin = Self::require_admin(&env)?;
        env.storage()
            .persistent()
            .set(&PENDING_ADMIN_KEY, &new_admin);
        extend_persistent_ttl(&env, &PENDING_ADMIN_KEY);
        env.events()
            .publish((symbol_short!("ADM_PROP"),), (admin, new_admin));
        Ok(())
    }

    pub fn accept_admin(env: Env) -> Result<(), StakingError> {
        require_current_storage_version(&env)?;
        extend_persistent_ttl(&env, &PENDING_ADMIN_KEY);
        let pending_admin: Address = env
            .storage()
            .persistent()
            .get(&PENDING_ADMIN_KEY)
            .ok_or(StakingError::NoPendingAdmin)?;
        pending_admin.require_auth();
        let old_admin = Self::require_admin(&env)?;
        env.storage()
            .persistent()
            .set(&ADMIN_KEY, &pending_admin);
        extend_persistent_ttl(&env, &ADMIN_KEY);
        env.storage()
            .persistent()
            .remove(&PENDING_ADMIN_KEY);
        env.events()
            .publish((symbol_short!("ADM_CHG"),), (old_admin, pending_admin));
        Ok(())
    }

    pub fn total_staked(env: Env) -> i128 {
        Self::load_totals(&env).staked
    }

    pub fn total_shares(env: Env) -> i128 {
        Self::load_totals(&env).shares
    }

    pub fn get_position(env: Env, staker: Address) -> StakePosition {
        extend_persistent_ttl(&env, &DataKey::Position(staker.clone()));
        let mut position: StakePosition = env.storage().persistent()
            .get(&DataKey::Position(staker)).unwrap_or(StakePosition { amount: 0, shares: 0 });
        let total_shares = Self::total_shares(env.clone());
        position.amount = if position.amount == i128::MIN {
            // Preserve the sentinel so checked arithmetic can reject a
            // corrupted legacy position instead of normalising it away.
            i128::MIN
        } else if total_shares == 0 { 0 } else {
            position.shares.saturating_mul(Self::total_staked(env)).saturating_div(total_shares)
        };
        position
    }

    pub fn staked_balance(env: Env, staker: Address) -> i128 {
        Self::get_position(env, staker).amount
    }

    pub fn get_staker_stats(env: Env, staker: Address) -> StakerStats {
        let pos = Self::get_position(env.clone(), staker.clone());
        let total = Self::total_staked(env.clone());
        let share_bps = if total > 0 {
            pos.amount * 10_000 / total
        } else {
            0
        };
        StakerStats {
            amount: pos.amount,
            shares: pos.shares,
            stake_share_bps: share_bps,
        }
    }

    /// Deposit `amount` tokens and mint the caller a pro-rata share of the pool.
    ///
    /// Shares are minted `amount * total_shares / total_staked`, or one-for-one
    /// when the pool is empty. Two guards make that accounting resistant to the
    /// share-inflation attack described on `MIN_INITIAL_STAKE`: the deposit that
    /// seeds an empty pool must be at least `MIN_INITIAL_STAKE`, and any deposit
    /// whose share count rounds down to zero is rejected rather than absorbed by
    /// the existing stakers.
    ///
    /// # Errors
    /// - `StakingError::InvalidAmount` if `amount` is not positive.
    /// - `StakingError::BelowMinimumInitialStake` if the pool holds no shares
    ///   and `amount` is under `MIN_INITIAL_STAKE`.
    /// - `StakingError::ZeroShares` if `amount` is too small relative to the
    ///   pool's current value to mint a single share.
    pub fn stake(env: Env, staker: Address, amount: i128) -> Result<i128, StakingError> {
        require_current_storage_version(&env)?;
        staker.require_auth();
        Self::require_not_paused(&env)?;
        Self::require_initialized(&env)?;
        if amount <= 0 {
            return Err(StakingError::InvalidAmount);
        }

        Self::accrue_rewards(&env)?;

        let total_staked = Self::total_staked(env.clone());
        let total_shares = Self::total_shares(env.clone());

        let shares = share_math::calculate_stake_shares(amount, total_staked, total_shares, MIN_INITIAL_STAKE)?;

        let new_total_staked = total_staked
            .checked_add(amount)
            .ok_or(StakingError::ArithmeticOverflow)?;
        let new_total_shares = total_shares
            .checked_add(shares)
            .ok_or(StakingError::ArithmeticOverflow)?;

        // EFFECTS — update state before token transfer
        let mut totals = Self::load_totals(&env);
        totals.staked = new_total_staked;
        totals.shares = new_total_shares;
        Self::save_totals(&env, &totals);

        let mut position = Self::get_position(env.clone(), staker.clone());
        position.amount = position
            .amount
            .checked_add(amount)
            .ok_or(StakingError::ArithmeticOverflow)?;
        position.shares = position
            .shares
            .checked_add(shares)
            .ok_or(StakingError::ArithmeticOverflow)?;
        env.storage()
            .persistent()
            .set(&DataKey::Position(staker.clone()), &position);
        extend_persistent_ttl(&env, &DataKey::Position(staker.clone()));

        // INTERACTIONS — transfer tokens in
        let token_addr = Self::token(env.clone());
        let token_client = token::TokenClient::new(&env, &token_addr);
        token_client.transfer(&staker, &env.current_contract_address(), &amount);

        env.events()
            .publish((symbol_short!("STAKED"),), (staker, amount, shares));
        Ok(shares)
    }

    /// Unstake `shares` and return the proportional token amount.
    ///
    /// #1011: Guards against division by zero when `total_shares` is 0.
    pub fn unstake(env: Env, staker: Address, shares: i128) -> Result<i128, StakingError> {
        require_current_storage_version(&env)?;
        staker.require_auth();
        Self::require_not_paused(&env)?;
        Self::require_initialized(&env)?;
        if shares <= 0 {
            return Err(StakingError::InvalidAmount);
        }

        Self::accrue_rewards(&env)?;

        let position = Self::get_position(env.clone(), staker.clone());
        if position.shares < shares {
            return Err(StakingError::InsufficientShares);
        }

        let total_staked = Self::total_staked(env.clone());
        let total_shares = Self::total_shares(env.clone());

        let tokens = share_math::calculate_unstake_tokens(shares, total_staked, total_shares)?;

        // EFFECTS — update state before token transfer
        let new_staked = total_staked
            .checked_sub(tokens)
            .ok_or(StakingError::ArithmeticOverflow)?;
        let new_shares = total_shares
            .checked_sub(shares)
            .ok_or(StakingError::ArithmeticOverflow)?;
        let mut totals = Self::load_totals(&env);
        totals.staked = new_staked;
        totals.shares = new_shares;
        Self::save_totals(&env, &totals);

        let mut new_position = position.clone();
        new_position.amount = new_position
            .amount
            .checked_sub(tokens)
            .ok_or(StakingError::ArithmeticOverflow)?;
        new_position.shares = new_position
            .shares
            .checked_sub(shares)
            .ok_or(StakingError::ArithmeticOverflow)?;
        env.storage()
            .persistent()
            .set(&DataKey::Position(staker.clone()), &new_position);
        extend_persistent_ttl(&env, &DataKey::Position(staker.clone()));

        // INTERACTIONS — transfer tokens out
        let token_addr = Self::token(env.clone());
        let token_client = token::TokenClient::new(&env, &token_addr);
        token_client.transfer(&env.current_contract_address(), &staker, &tokens);

        env.events()
            .publish((symbol_short!("UNSTAK"),), (staker, tokens, shares));
        Ok(tokens)
    }

    pub fn get_shares(env: Env, staker: Address) -> i128 {
        Self::get_position(env, staker).shares
    }

    /// The minimum deposit accepted while the pool holds no shares.
    ///
    /// Exposed so clients can validate a first deposit before submitting it
    /// rather than surfacing `StakingError::BelowMinimumInitialStake`.
    pub fn min_initial_stake(_env: Env) -> i128 {
        MIN_INITIAL_STAKE
    }

    pub fn distribute_rewards(env: Env, caller: Address, amount: i128) -> Result<(), StakingError> {
        require_current_storage_version(&env)?;
        caller.require_auth();
        Self::require_not_paused(&env)?;
        Self::require_initialized(&env)?;
        if amount <= 0 {
            return Err(StakingError::InvalidAmount);
        }

        if Self::total_shares(env.clone()) == 0 {
            return Err(StakingError::NoSharesOutstanding);
        }

        Self::accrue_rewards(&env)?;
        let now = env.ledger().timestamp();
        let totals = Self::load_totals(&env);
        let finish = totals.period_finish;
        extend_persistent_ttl(&env, &REWARD_DURATION_KEY);
        let duration: u64 = env.storage().persistent().get(&REWARD_DURATION_KEY).unwrap_or(DEFAULT_REWARD_DURATION);
        let previous_rate = totals.reward_rate;
        let remainder = if now < finish {
            previous_rate.checked_mul((finish - now) as i128).ok_or(StakingError::ArithmeticOverflow)?
        } else { 0 };
        let rate = amount.checked_add(remainder).and_then(|v| v.checked_div(duration as i128))
            .ok_or(StakingError::ArithmeticOverflow)?;
        let mut totals = Self::load_totals(&env);
        // Rewards are credited to the pool immediately; the reward fields
        // retain the schedule metadata for clients and future distributions.
        totals.staked = totals.staked.checked_add(amount).ok_or(StakingError::ArithmeticOverflow)?;
        totals.reward_rate = rate;
        totals.period_finish = now + duration;
        totals.last_update = now;
        Self::save_totals(&env, &totals);

        let token_addr = Self::token(env.clone());
        let token_client = token::TokenClient::new(&env, &token_addr);
        token_client.transfer(&caller, &env.current_contract_address(), &amount);

        env.events()
            .publish((symbol_short!("REWARDS"),), (caller, amount));
        Ok(())
    }

    pub fn reward_rate(env: Env) -> i128 {
        let _ = Self::accrue_rewards(&env);
        Self::load_totals(&env).reward_rate
    }

    pub fn reward_duration(env: Env) -> u64 {
        extend_persistent_ttl(&env, &REWARD_DURATION_KEY);
        env.storage().persistent().get(&REWARD_DURATION_KEY).unwrap_or(DEFAULT_REWARD_DURATION)
    }

    pub fn set_reward_duration(env: Env, duration: u64) -> Result<(), StakingError> {
        Self::require_admin(&env)?;
        if duration == 0 || duration > 365 * 24 * 60 * 60 { return Err(StakingError::InvalidAmount); }
        Self::accrue_rewards(&env)?;
        env.storage().persistent().set(&REWARD_DURATION_KEY, &duration);
        extend_persistent_ttl(&env, &REWARD_DURATION_KEY);
        env.events().publish((symbol_short!("RWDUR"),), duration);
        Ok(())
    }

    /// Upgrade the staking contract's code to `new_wasm_hash`.
    ///
    /// Admin-gated. Upgrading in place preserves all state — admin, token,
    /// global share/stake totals, and every staker position — so a bug in
    /// share accounting or token transfer logic can be fixed without
    /// redeploying and losing staker positions.
    pub fn upgrade(env: Env, new_wasm_hash: BytesN<32>) -> Result<(), StakingError> {
        require_current_storage_version(&env)?;
        Self::require_admin(&env)?;
        env.deployer()
            .update_current_contract_wasm(new_wasm_hash.clone());
        env.events()
            .publish((symbol_short!("UPGRADE"),), new_wasm_hash);
        Ok(())
    }

    /// The staking contract's bounded set of *global* persistent keys whose
    /// loss would brick the contract. Per-staker `DataKey::Position` keys are
    /// intentionally excluded: they are unbounded and enumerating them would
    /// leak which wallets hold positions.
    fn critical_global_keys(env: &Env) -> Vec<Symbol> {
        Vec::from_array(
            env,
            [
                ADMIN_KEY,
                PAUSED_KEY,
                TOKEN_KEY,
                TOTALS_KEY,
                REWARD_DURATION_KEY,
                PENDING_ADMIN_KEY,
            ],
        )
    }

    /// Inventory of the contract's critical global storage keys (#1516).
    ///
    /// Returns one row per critical key with its presence flag. Callable by
    /// anyone: it exposes only the contract's own aggregate/admin key
    /// inventory, never per-staker data. The keeper intersects these keys with
    /// RPC `getLedgerEntries` `liveUntilLedgerSeq` to compute TTL headroom —
    /// a contract cannot read its own entry TTL at runtime.
    pub fn storage_inventory(env: Env) -> Vec<StorageKeyInfo> {
        let mut out = Vec::new(&env);
        for key in Self::critical_global_keys(&env).iter() {
            extend_persistent_ttl(&env, &key);
            let present = env.storage().persistent().has(&key);
            out.push_back(StorageKeyInfo { key, present });
        }
        out
    }

    /// Extend the TTL of every present critical global key (#1516).
    ///
    /// Admin-gated and idempotent: `extend_ttl` only extends entries whose
    /// remaining TTL is at or below `PERSISTENT_TTL_THRESHOLD`, so repeated
    /// calls inside the threshold are no-ops. A contract cannot read its own
    /// entry TTL, so this method intentionally reports nothing beyond success —
    /// the keeper determines what actually moved by re-reading
    /// `liveUntilLedgerSeq` over RPC after the transaction confirms.
    pub fn renew_storage(env: Env) -> Result<(), StakingError> {
        require_current_storage_version(&env)?;
        Self::require_admin(&env)?;
        for key in Self::critical_global_keys(&env).iter() {
            if !env.storage().persistent().has(&key) {
                continue;
            }
            env.storage().persistent().extend_ttl(
                &key,
                PERSISTENT_TTL_THRESHOLD,
                PERSISTENT_TTL_EXTEND_TO,
            );
        }
        Ok(())
    }

    fn require_admin(env: &Env) -> Result<Address, StakingError> {
        extend_persistent_ttl(env, &ADMIN_KEY);
        let admin: Address = env
            .storage()
            .persistent()
            .get(&ADMIN_KEY)
            .ok_or(StakingError::NotInitialized)?;
        admin.require_auth();
        Ok(admin)
    }

    fn require_not_paused(env: &Env) -> Result<(), StakingError> {
        extend_persistent_ttl(env, &PAUSED_KEY);
        if env.storage().persistent().get(&PAUSED_KEY).unwrap_or(false) {
            return Err(StakingError::Paused);
        }
        Ok(())
    }

    fn require_initialized(env: &Env) -> Result<(), StakingError> {
        extend_persistent_ttl(env, &ADMIN_KEY);
        if !env.storage().persistent().has(&ADMIN_KEY) {
            return Err(StakingError::NotInitialized);
        }
        Ok(())
    }

    fn accrue_rewards(env: &Env) -> Result<(), StakingError> {
        let now = env.ledger().timestamp();
        let mut totals = Self::load_totals(env);
        let last = totals.last_update;
        let finish = totals.period_finish;
        let elapsed = core::cmp::min(now, finish).saturating_sub(last);
        if elapsed > 0 {
            let accrued = totals.reward_rate.checked_mul(elapsed as i128).ok_or(StakingError::ArithmeticOverflow)?;
            totals.staked = totals.staked.checked_add(accrued).ok_or(StakingError::ArithmeticOverflow)?;
        }
        totals.last_update = core::cmp::min(now, finish);
        Self::save_totals(env, &totals);
        Ok(())
    }

    fn load_totals(env: &Env) -> Totals {
        extend_persistent_ttl(env, &TOTALS_KEY);
        #[cfg(test)]
        if env.storage().persistent().has(&TSTAKE_KEY) {
            extend_persistent_ttl(env, &TSTAKE_KEY);
            extend_persistent_ttl(env, &TSHARES_KEY);
            extend_persistent_ttl(env, &REWARD_RATE_KEY);
            extend_persistent_ttl(env, &PERIOD_FINISH_KEY);
            extend_persistent_ttl(env, &LAST_UPDATE_KEY);
            return Totals {
                staked: env.storage().persistent().get(&TSTAKE_KEY).unwrap_or(0),
                shares: env.storage().persistent().get(&TSHARES_KEY).unwrap_or(0),
                reward_rate: env.storage().persistent().get(&REWARD_RATE_KEY).unwrap_or(0),
                period_finish: env.storage().persistent().get(&PERIOD_FINISH_KEY).unwrap_or(0),
                last_update: env.storage().persistent().get(&LAST_UPDATE_KEY).unwrap_or(env.ledger().timestamp()),
            };
        }
        if let Some(totals) = env.storage().persistent().get(&TOTALS_KEY) {
            return totals;
        }
        // Lazy migration for instances deployed before #1623.
        for key in [TSTAKE_KEY, TSHARES_KEY, REWARD_RATE_KEY, PERIOD_FINISH_KEY, LAST_UPDATE_KEY] {
            extend_persistent_ttl(env, &key);
        }
        let totals = Totals {
            staked: env.storage().persistent().get(&TSTAKE_KEY).unwrap_or(0),
            shares: env.storage().persistent().get(&TSHARES_KEY).unwrap_or(0),
            reward_rate: env.storage().persistent().get(&REWARD_RATE_KEY).unwrap_or(0),
            period_finish: env.storage().persistent().get(&PERIOD_FINISH_KEY).unwrap_or(0),
            last_update: env.storage().persistent().get(&LAST_UPDATE_KEY).unwrap_or(env.ledger().timestamp()),
        };
        env.storage().persistent().set(&TOTALS_KEY, &totals);
        extend_persistent_ttl(&env, &TOTALS_KEY);
        totals
    }

    fn save_totals(env: &Env, totals: &Totals) {
        extend_persistent_ttl(env, &TOTALS_KEY);
        env.storage().persistent().set(&TOTALS_KEY, totals);
        extend_persistent_ttl(&env, &TOTALS_KEY);
        #[cfg(test)]
        {
            env.storage().persistent().set(&TSTAKE_KEY, &totals.staked);
            extend_persistent_ttl(&env, &TSTAKE_KEY);
            env.storage().persistent().set(&TSHARES_KEY, &totals.shares);
            extend_persistent_ttl(&env, &TSHARES_KEY);
            env.storage().persistent().set(&REWARD_RATE_KEY, &totals.reward_rate);
            extend_persistent_ttl(&env, &REWARD_RATE_KEY);
            env.storage().persistent().set(&PERIOD_FINISH_KEY, &totals.period_finish);
            extend_persistent_ttl(&env, &PERIOD_FINISH_KEY);
            env.storage().persistent().set(&LAST_UPDATE_KEY, &totals.last_update);
            extend_persistent_ttl(&env, &LAST_UPDATE_KEY);
            for key in [TSTAKE_KEY, TSHARES_KEY, REWARD_RATE_KEY, PERIOD_FINISH_KEY, LAST_UPDATE_KEY] {
                extend_persistent_ttl(env, &key);
            }
        }
    }
}

#[cfg(test)]
#[cfg_attr(coverage_nightly, coverage(off))]
mod test;
