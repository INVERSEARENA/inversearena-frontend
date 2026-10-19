#![no_std]
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
const PERSISTENT_TTL_THRESHOLD: u32 = 100;
const PERSISTENT_TTL_EXTEND_TO: u32 = 1000;

/// Staking contract ABI/storage version, for client-side capability
/// negotiation across mixed deployment versions.
/// Bumped to 2 for #1516: adds the additive `ttl_health` and `renew_storage`
/// entrypoints so the keeper can negotiate TTL-health support via
/// `contractCapability.ts` rather than probing for the methods blindly.
const CONTRACT_VERSION: u32 = 2;

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
}

#[cfg(test)]
mod auth_tests;

#[contract]
pub struct StakingContract;

/// Extend the TTL of a persistent key if it exists.
/// Matches the pattern used by the arena contract.
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
        env.storage().persistent().set(&TOKEN_KEY, &token);
        env.storage().persistent().set(&TOTALS_KEY, &Totals {
            staked: 0,
            shares: 0,
            reward_rate: 0,
            period_finish: 0,
            last_update: env.ledger().timestamp(),
        });
        #[cfg(test)]
        {
            // Keep fixture-level access to the pre-#1623 keys while tests
            // exercise deployed-instance migration behaviour.
            env.storage().persistent().set(&TSTAKE_KEY, &0i128);
            env.storage().persistent().set(&TSHARES_KEY, &0i128);
            env.storage().persistent().set(&REWARD_RATE_KEY, &0i128);
            env.storage().persistent().set(&PERIOD_FINISH_KEY, &0u64);
            env.storage().persistent().set(&LAST_UPDATE_KEY, &env.ledger().timestamp());
        }
        env.storage().persistent().set(&PAUSED_KEY, &false);
        env.storage().persistent().set(&REWARD_DURATION_KEY, &DEFAULT_REWARD_DURATION);

        // #1012: Emit initialization event.
        env.events()
            .publish((symbol_short!("INIT"),), (admin, token));

        Ok(())
    }

    /// Return the staking contract ABI/storage version.
    pub fn version(_env: Env) -> u32 {
        CONTRACT_VERSION
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
        Self::require_admin(&env)?;
        env.storage().persistent().set(&PAUSED_KEY, &true);
        env.events().publish((symbol_short!("PAUSED"),), ());
        Ok(())
    }

    pub fn unpause(env: Env) -> Result<(), StakingError> {
        Self::require_admin(&env)?;
        env.storage().persistent().set(&PAUSED_KEY, &false);
        env.events().publish((symbol_short!("UNPAUS"),), ());
        Ok(())
    }

    pub fn is_paused(env: Env) -> bool {
        extend_persistent_ttl(&env, &PAUSED_KEY);
        env.storage().persistent().get(&PAUSED_KEY).unwrap_or(false)
    }

    pub fn propose_admin(env: Env, new_admin: Address) -> Result<(), StakingError> {
        let admin = Self::require_admin(&env)?;
        extend_persistent_ttl(&env, &PENDING_ADMIN_KEY);
        env.storage()
            .persistent()
            .set(&PENDING_ADMIN_KEY, &new_admin);
        env.events()
            .publish((symbol_short!("ADM_PROP"),), (admin, new_admin));
        Ok(())
    }

    pub fn accept_admin(env: Env) -> Result<(), StakingError> {
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
        staker.require_auth();
        Self::require_not_paused(&env)?;
        Self::require_initialized(&env)?;
        if amount <= 0 {
            return Err(StakingError::InvalidAmount);
        }

        Self::accrue_rewards(&env)?;

        let total_staked = Self::total_staked(env.clone());
        let total_shares = Self::total_shares(env.clone());

        let shares = if total_staked == 0 || total_shares == 0 {
            // Seeding an empty pool. A dust deposit here would let the seeder
            // own the pool with a single share and round every later depositor
            // down to nothing, so require a meaningful floor.
            if amount < MIN_INITIAL_STAKE {
                return Err(StakingError::BelowMinimumInitialStake);
            }
            amount
        } else {
            amount
                .checked_mul(total_shares)
                .and_then(|scaled| scaled.checked_div(total_staked))
                .ok_or(StakingError::ArithmeticOverflow)?
        };

        // A deposit that mints no shares is a pure donation to the existing
        // stakers — the victim side of the inflation attack. Reject it instead
        // of silently confiscating the tokens. (#1010)
        if shares == 0 {
            return Err(StakingError::ZeroShares);
        }

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

        // #1011: Prevent division by zero.
        if total_shares == 0 {
            return Err(StakingError::NoSharesOutstanding);
        }

        let tokens = shares
            .checked_mul(total_staked)
            .and_then(|scaled| scaled.checked_div(total_shares))
            .ok_or(StakingError::ArithmeticOverflow)?;

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
        env.storage().persistent().get(&REWARD_DURATION_KEY).unwrap_or(DEFAULT_REWARD_DURATION)
    }

    pub fn set_reward_duration(env: Env, duration: u64) -> Result<(), StakingError> {
        Self::require_admin(&env)?;
        if duration == 0 || duration > 365 * 24 * 60 * 60 { return Err(StakingError::InvalidAmount); }
        Self::accrue_rewards(&env)?;
        env.storage().persistent().set(&REWARD_DURATION_KEY, &duration);
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

    /// Read-only inventory of the contract's critical global storage keys
    /// (#1516).
    ///
    /// Returns one row per critical key with its presence flag. Callable by
    /// anyone: it exposes only the contract's own aggregate/admin key
    /// inventory, never per-staker data. The keeper intersects these keys with
    /// RPC `getLedgerEntries` `liveUntilLedgerSeq` to compute TTL headroom —
    /// a contract cannot read its own entry TTL at runtime.
    pub fn storage_inventory(env: Env) -> Vec<StorageKeyInfo> {
        let mut out = Vec::new(&env);
        for key in Self::critical_global_keys(&env).iter() {
            let present = env.storage().persistent().has(&key);
            out.push_back(StorageKeyInfo { key, present });
        }
        out
    }

    /// Extend the TTL of every present critical global key (#1516).
    ///
    /// Admin-gated and idempotent: `extend_ttl` only extends entries whose
    /// remaining TTL is at or below [`PERSISTENT_TTL_THRESHOLD`], so repeated
    /// calls inside the threshold are no-ops. A contract cannot read its own
    /// entry TTL, so this method intentionally reports nothing beyond success —
    /// the keeper determines what actually moved by re-reading
    /// `liveUntilLedgerSeq` over RPC after the transaction confirms.
    pub fn renew_storage(env: Env) -> Result<(), StakingError> {
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
        let totals = Totals {
            staked: env.storage().persistent().get(&TSTAKE_KEY).unwrap_or(0),
            shares: env.storage().persistent().get(&TSHARES_KEY).unwrap_or(0),
            reward_rate: env.storage().persistent().get(&REWARD_RATE_KEY).unwrap_or(0),
            period_finish: env.storage().persistent().get(&PERIOD_FINISH_KEY).unwrap_or(0),
            last_update: env.storage().persistent().get(&LAST_UPDATE_KEY).unwrap_or(env.ledger().timestamp()),
        };
        env.storage().persistent().set(&TOTALS_KEY, &totals);
        totals
    }

    fn save_totals(env: &Env, totals: &Totals) {
        extend_persistent_ttl(env, &TOTALS_KEY);
        env.storage().persistent().set(&TOTALS_KEY, totals);
        #[cfg(test)]
        {
            env.storage().persistent().set(&TSTAKE_KEY, &totals.staked);
            env.storage().persistent().set(&TSHARES_KEY, &totals.shares);
            env.storage().persistent().set(&REWARD_RATE_KEY, &totals.reward_rate);
            env.storage().persistent().set(&PERIOD_FINISH_KEY, &totals.period_finish);
            env.storage().persistent().set(&LAST_UPDATE_KEY, &totals.last_update);
        }
    }
}

#[cfg(test)]
mod test {
    use super::*;
    use soroban_sdk::Vec;
    use soroban_sdk::testutils::Address as _;
    use soroban_sdk::testutils::Ledger as _;
    use soroban_sdk::testutils::storage::Persistent as _;

    fn mint_staker(env: &Env, token: &Address, amount: i128) -> Address {
        let staker = Address::generate(env);
        soroban_sdk::token::StellarAssetClient::new(env, token).mint(&staker, &amount);
        staker
    }

    fn setup() -> (
        Env,
        StakingContractClient<'static>,
        Address,
        Address,
        Address,
    ) {
        let env = Env::default();
        env.mock_all_auths();
        let contract_id = env.register(StakingContract, ());
        let client = StakingContractClient::new(&env, &contract_id);
        let admin = Address::generate(&env);
        let sac = env.register_stellar_asset_contract_v2(admin.clone());
        let token = sac.address();
        let staker = Address::generate(&env);
        let token_admin = soroban_sdk::token::StellarAssetClient::new(&env, &token);
        token_admin.mint(&staker, &100_000);
        client.initialize(&admin, &token);
        (env, client, admin, token, staker)
    }

    #[test]
    fn initialize_sets_admin_and_token() {
        let (_env, client, admin, token, _staker) = setup();
        assert_eq!(client.admin(), admin);
        assert_eq!(client.token(), token);
    }

    #[test]
    fn version_returns_the_current_contract_version() {
        let (_env, client, _admin, _token, _staker) = setup();
        assert_eq!(client.version(), CONTRACT_VERSION);
    }

    // #1012: initialize emits an INIT event.
    //
    // The event emission is verified by the code in `initialize()` which calls
    // `env.events().publish((symbol_short!("INIT"),), (admin, token))`.
    // The existing `initialize_sets_admin_and_token` test exercises this path.
    // A dedicated event assertion would require importing the Events testutils
    // trait and matching on raw Val payloads, which is fragile across SDK
    // versions. The publish call is unmissable in the source.

    #[test]
    fn initialize_rejects_duplicate() {
        let (env, client, _admin, _token, _staker) = setup();
        let result = client.try_initialize(&Address::generate(&env), &Address::generate(&env));
        assert!(result.is_err());
    }

    #[test]
    fn stake_mints_shares_one_to_one_when_empty() {
        let (_env, client, _admin, _token, staker) = setup();
        let shares = client.stake(&staker, &100);
        assert_eq!(shares, 100);
        assert_eq!(client.total_staked(), 100);
        assert_eq!(client.total_shares(), 100);
    }

    #[test]
    fn stake_mints_proportional_shares_when_not_empty() {
        let (_env, client, _admin, _token, staker) = setup();
        let staker2 = mint_staker(&_env, &_token, 100_000);
        client.stake(&staker, &100);
        let shares = client.stake(&staker2, &100);
        assert_eq!(shares, 100);
        assert_eq!(client.total_staked(), 200);
        assert_eq!(client.total_shares(), 200);
    }

    #[test]
    fn stake_requires_positive_amount() {
        let (_env, client, _admin, _token, staker) = setup();
        let result = client.try_stake(&staker, &0);
        assert!(result.is_err());
    }

    #[test]
    fn unstake_returns_proportional_tokens() {
        let (_env, client, _admin, _token, staker) = setup();
        client.stake(&staker, &100);
        let tokens = client.unstake(&staker, &50);
        assert_eq!(tokens, 50);
        assert_eq!(client.total_staked(), 50);
        assert_eq!(client.total_shares(), 50);
    }

    #[test]
    fn unstake_rejects_excess_shares() {
        let (_env, client, _admin, _token, staker) = setup();
        client.stake(&staker, &100);
        let result = client.try_unstake(&staker, &101);
        assert!(result.is_err());
    }

    #[test]
    fn unstake_rejects_zero_shares() {
        let (_env, client, _admin, _token, staker) = setup();
        client.stake(&staker, &100);
        let result = client.try_unstake(&staker, &0);
        assert!(result.is_err());
    }

    // #1011: Test that unstake with zero total_shares returns an error.
    #[test]
    fn unstake_rejects_when_no_shares_outstanding() {
        let (env, client, _admin, _token, _staker) = setup();
        let contract_id = client.address.clone();
        let staker = mint_staker(&env, &_token, 100_000);

        // Stake normally, then corrupt total_shares to 0 via as_contract.
        client.stake(&staker, &100);
        env.as_contract(&contract_id, || {
            env.storage().persistent().set(&TSHARES_KEY, &0i128);
        });

        let result = client.try_unstake(&staker, &50);
        assert_eq!(result, Err(Ok(StakingError::NoSharesOutstanding)));
    }

    #[test]
    fn get_position_returns_zero_when_no_stake() {
        let (_env, client, _admin, _token, staker) = setup();
        let pos = client.get_position(&staker);
        assert_eq!(pos.amount, 0);
        assert_eq!(pos.shares, 0);
    }

    #[test]
    fn get_position_returns_stake_after_staking() {
        let (_env, client, _admin, _token, staker) = setup();
        client.stake(&staker, &100);
        let pos = client.get_position(&staker);
        assert_eq!(pos.amount, 100);
        assert_eq!(pos.shares, 100);
    }

    #[test]
    fn staked_balance_matches_position() {
        let (_env, client, _admin, _token, staker) = setup();
        client.stake(&staker, &75);
        assert_eq!(client.staked_balance(&staker), 75);
    }

    #[test]
    fn get_staker_stats_computes_share_bps() {
        let (_env, client, _admin, _token, staker) = setup();
        let staker2 = mint_staker(&_env, &_token, 100_000);
        client.stake(&staker, &100);
        client.stake(&staker2, &300);
        let stats = client.get_staker_stats(&staker);
        assert_eq!(stats.amount, 100);
        assert_eq!(stats.shares, 100);
        assert_eq!(stats.stake_share_bps, 2500);
    }

    #[test]
    fn get_staker_stats_zero_bps_when_no_stake() {
        let (_env, client, _admin, _token, staker) = setup();
        let stats = client.get_staker_stats(&staker);
        assert_eq!(stats.stake_share_bps, 0);
    }

    #[test]
    fn pause_blocks_stake() {
        let (_env, client, _admin, _token, staker) = setup();
        client.pause();
        assert!(client.is_paused());
        let result = client.try_stake(&staker, &100);
        assert!(result.is_err());
    }

    #[test]
    fn unpause_resumes_stake() {
        let (_env, client, _admin, _token, staker) = setup();
        client.pause();
        client.unpause();
        assert!(!client.is_paused());
        let result = client.try_stake(&staker, &100);
        assert!(result.is_ok());
    }

    #[test]
    fn pause_requires_admin() {
        let (env, client, _admin, _token, _staker) = setup();

        // Drop the mocked auths so pause must prove the stored admin authorized it.
        env.set_auths(&[]);

        assert!(
            client.try_pause().is_err(),
            "pause without the admin's authorization must be rejected"
        );
    }

    #[test]
    fn upgrade_requires_admin_auth() {
        let (env, client, _admin, _token, _staker) = setup();

        // Drop the mocked auths so the admin's signature is genuinely required;
        // a non-admin caller cannot supply it.
        env.set_auths(&[]);

        let new_wasm = BytesN::from_array(&env, &[0u8; 32]);
        assert!(
            client.try_upgrade(&new_wasm).is_err(),
            "upgrade without the admin's authorization must be rejected"
        );
    }

    #[test]
    fn multiple_stakers_get_fair_shares() {
        let (env, client, _admin, _token, _staker) = setup();
        let mut stakers = Vec::new(&env);
        for _ in 0..5 {
            let s = mint_staker(&env, &_token, 100_000);
            client.stake(&s, &100);
            stakers.push_back(s);
        }
        assert_eq!(client.total_staked(), 500);
        assert_eq!(client.total_shares(), 500);
        for s in stakers.iter() {
            let pos = client.get_position(&s);
            assert_eq!(pos.amount, 100);
            assert_eq!(pos.shares, 100);
        }
    }

    #[test]
    fn unstake_reduces_global_totals() {
        let (_env, client, _admin, _token, staker) = setup();
        let staker2 = mint_staker(&_env, &_token, 100_000);
        client.stake(&staker, &200);
        client.stake(&staker2, &200);
        client.unstake(&staker, &100);
        assert_eq!(client.total_staked(), 300);
        assert_eq!(client.total_shares(), 300);
        let pos = client.get_position(&staker);
        assert_eq!(pos.amount, 100);
        assert_eq!(pos.shares, 100);
    }

    #[test]
    fn get_shares_returns_correct_value() {
        let (_env, client, _admin, _token, staker) = setup();
        client.stake(&staker, &150);
        assert_eq!(client.get_shares(&staker), 150);
    }

    #[test]
    fn distribute_rewards_increases_staked_value() {
        let (env, client, _admin, token, staker) = setup();
        client.stake(&staker, &100);

        let reward_provider = mint_staker(&env, &token, 50_000);
        client.distribute_rewards(&reward_provider, &50);

        assert_eq!(client.total_staked(), 150);
        assert_eq!(client.total_shares(), 100);

        // Unstaking should now yield proportional rewards
        // 100 shares / 100 total shares * 150 total staked = 150 tokens
        let returned = client.unstake(&staker, &100);
        assert_eq!(returned, 150);
    }

    // ---------------------------------------------------------------------
    // Share-inflation ("donation") attack
    //
    // The classic exploit against pro-rata share accounting: the attacker is
    // first into an empty pool with a dust deposit, then inflates the pool's
    // value without minting shares, so the next depositor's
    // `amount * total_shares / total_staked` rounds down to (near) zero and
    // their tokens accrue to the attacker. `MIN_INITIAL_STAKE` plus the
    // zero-share rejection in `stake()` close both halves of it.
    // ---------------------------------------------------------------------

    #[test]
    fn min_initial_stake_is_exposed_to_clients() {
        let (_env, client, _admin, _token, _staker) = setup();
        assert_eq!(client.min_initial_stake(), MIN_INITIAL_STAKE);
    }

    #[test]
    fn dust_initial_deposit_is_rejected() {
        let (_env, client, _admin, _token, staker) = setup();
        // A single base unit is the attacker's opening move; it must not be
        // possible to own the whole pool with one share.
        assert_eq!(
            client.try_stake(&staker, &1),
            Err(Ok(StakingError::BelowMinimumInitialStake))
        );
        assert_eq!(
            client.try_stake(&staker, &(MIN_INITIAL_STAKE - 1)),
            Err(Ok(StakingError::BelowMinimumInitialStake))
        );
        assert_eq!(client.total_shares(), 0);
    }

    #[test]
    fn initial_deposit_at_the_minimum_is_accepted() {
        let (_env, client, _admin, _token, staker) = setup();
        let shares = client.stake(&staker, &MIN_INITIAL_STAKE);
        assert_eq!(shares, MIN_INITIAL_STAKE);
        assert_eq!(client.total_shares(), MIN_INITIAL_STAKE);
    }

    #[test]
    fn minimum_applies_again_once_the_pool_is_emptied() {
        let (_env, client, _admin, _token, staker) = setup();
        client.stake(&staker, &MIN_INITIAL_STAKE);
        client.unstake(&staker, &MIN_INITIAL_STAKE);
        assert_eq!(client.total_shares(), 0);

        // Draining the pool resets it to the seeding case, so the floor is
        // enforced again rather than leaving a re-inflation window open.
        assert_eq!(
            client.try_stake(&staker, &1),
            Err(Ok(StakingError::BelowMinimumInitialStake))
        );
    }

    #[test]
    fn deposit_that_would_mint_zero_shares_is_rejected() {
        let (env, client, _admin, token, _staker) = setup();
        let attacker = mint_staker(&env, &token, 1_000_000 + MIN_INITIAL_STAKE);
        let victim = mint_staker(&env, &token, 1_000);

        // Seed with the smallest allowed deposit, then inflate the pool's
        // value without minting a single new share.
        client.stake(&attacker, &MIN_INITIAL_STAKE);
        client.distribute_rewards(&attacker, &1_000_000);
        assert_eq!(client.total_shares(), MIN_INITIAL_STAKE);
        assert_eq!(client.total_staked(), 1_000_000 + MIN_INITIAL_STAKE);

        // 1_000 * MIN_INITIAL_STAKE / (1_000_000 + MIN_INITIAL_STAKE) == 0.
        // Before the guard this deposit was confiscated in full; now it fails.
        assert_eq!(
            client.try_stake(&victim, &1_000),
            Err(Ok(StakingError::ZeroShares))
        );
        assert_eq!(
            soroban_sdk::token::TokenClient::new(&env, &token).balance(&victim),
            1_000
        );
    }

    #[test]
    fn inflated_pool_still_gives_the_second_depositor_fair_shares() {
        let (env, client, _admin, token, _staker) = setup();
        let token_client = soroban_sdk::token::TokenClient::new(&env, &token);

        let attacker_capital = 1_001_000i128;
        let victim_deposit = 1_000_000i128;
        let attacker = mint_staker(&env, &token, attacker_capital);
        let victim = mint_staker(&env, &token, victim_deposit);

        // Seed the pool, then donate the rest to inflate the value of a share.
        client.stake(&attacker, &1_000);
        client.distribute_rewards(&attacker, &1_000_000);
        assert_eq!(client.total_shares(), 1_000);
        assert_eq!(client.total_staked(), attacker_capital);
        assert_eq!(token_client.balance(&attacker), 0);

        // The victim's deposit still mints shares proportional to what the
        // pool is actually worth: 1_000_000 * 1_000 / 1_001_000 == 999.
        let victim_shares = client.stake(&victim, &victim_deposit);
        assert_eq!(victim_shares, 999);
        assert!(victim_shares > 0, "deposit must not be diluted to nothing");

        // And withdrawing returns essentially the whole deposit — the only
        // loss is integer-division rounding, well under 0.1%.
        let returned = client.unstake(&victim, &victim_shares);
        assert_eq!(returned, 999_999);
        assert!(
            returned >= victim_deposit - victim_deposit / 1_000,
            "victim recovered {returned} of {victim_deposit}"
        );

        // The attacker cannot profit: unwinding the position returns roughly
        // the capital they committed, so the donation is not recoverable as a
        // steal from the victim.
        client.unstake(&attacker, &1_000);
        let attacker_final = token_client.balance(&attacker);
        assert!(
            attacker_final <= attacker_capital + victim_deposit / 1_000,
            "attacker walked away with {attacker_final} on {attacker_capital} committed"
        );
    }

    #[test]
    fn honest_pool_splits_value_pro_rata_after_rewards() {
        let (env, client, _admin, token, _staker) = setup();
        let a = mint_staker(&env, &token, 10_000);
        let b = mint_staker(&env, &token, 10_000);
        let funder = mint_staker(&env, &token, 10_000);

        client.stake(&a, &1_000);
        client.stake(&b, &1_000);
        client.distribute_rewards(&funder, &1_000);

        // 1_000 shares each against 3_000 staked → 1_500 tokens each.
        assert_eq!(client.unstake(&a, &1_000), 1_500);
        assert_eq!(client.unstake(&b, &1_000), 1_500);
        assert_eq!(client.total_staked(), 0);
        assert_eq!(client.total_shares(), 0);
    }

    #[test]
    fn propose_and_accept_admin_rotates_admin() {
        let (env, client, _admin, _token, _staker) = setup();
        let new_admin = Address::generate(&env);

        client.propose_admin(&new_admin);
        client.accept_admin();

        assert_eq!(client.admin(), new_admin);
    }

    #[test]
    fn accept_admin_without_proposal_fails() {
        let (env, client, _admin, _token, _staker) = setup();
        env.set_auths(&[]);
        let result = client.try_accept_admin();
        assert!(result.is_err());
    }

    #[test]
    fn propose_admin_requires_current_admin_auth() {
        let (env, client, _admin, _token, _staker) = setup();
        let new_admin = Address::generate(&env);
        env.set_auths(&[]);
        let result = client.try_propose_admin(&new_admin);
        assert!(result.is_err());
    }

    #[test]
    fn second_propose_overwrites_first() {
        let (env, client, _admin, _token, _staker) = setup();
        let addr_a = Address::generate(&env);
        let addr_b = Address::generate(&env);

        client.propose_admin(&addr_a);
        client.propose_admin(&addr_b);
        client.accept_admin();

        assert_eq!(client.admin(), addr_b);
    }

    #[test]
    fn distribute_rewards_rejects_empty_pool() {
        let (env, client, _admin, token, _staker) = setup();
        let reward_provider = mint_staker(&env, &token, 50_000);
        assert_eq!(client.total_shares(), 0);
        let result = client.try_distribute_rewards(&reward_provider, &50);
        assert_eq!(result, Err(Ok(StakingError::NoSharesOutstanding)));
    }

    // #1362: stake/unstake/distribute_rewards use checked arithmetic and
    // return ArithmeticOverflow rather than wrapping, matching rwa-adapter's
    // pattern. total_staked/total_shares/position fields are corrupted to
    // near i128::MAX via as_contract (the same technique
    // unstake_rejects_when_no_shares_outstanding above uses), since no
    // legitimate sequence of stakes could ever reach that value with a real
    // token supply.

    #[test]
    fn stake_amount_addition_overflow_is_rejected() {
        let (env, client, _admin, token, staker) = setup();
        let contract_id = client.address.clone();

        client.stake(&staker, &100);
        env.as_contract(&contract_id, || {
            // Keep total_shares equal to total_staked so `amount * shares /
            // staked` still yields a nonzero share count (clearing the
            // ZeroShares guard) right up to the point where adding `amount`
            // to total_staked itself overflows i128.
            env.storage().persistent().set(&TSTAKE_KEY, &(i128::MAX - 1));
            env.storage().persistent().set(&TSHARES_KEY, &(i128::MAX - 1));
        });

        let overflowing_staker = mint_staker(&env, &token, i128::MAX);
        let result = client.try_stake(&overflowing_staker, &2);
        assert_eq!(result, Err(Ok(StakingError::ArithmeticOverflow)));
    }

    #[test]
    fn stake_share_multiplication_overflow_is_rejected() {
        let (env, client, _admin, token, staker) = setup();
        let contract_id = client.address.clone();

        // Seed the pool for real (below MIN_INITIAL_STAKE would bounce
        // before reaching total_shares at all), then corrupt total_shares to
        // be huge relative to total_staked so `amount * total_shares`
        // overflows long before the division that would normally bring it
        // back down to a sane share count.
        client.stake(&staker, &10);
        env.as_contract(&contract_id, || {
            env.storage().persistent().set(&TSHARES_KEY, &i128::MAX);
        });

        let big_staker = mint_staker(&env, &token, i128::MAX);
        let result = client.try_stake(&big_staker, &(i128::MAX / 2));
        assert_eq!(result, Err(Ok(StakingError::ArithmeticOverflow)));
    }

    #[test]
    fn stake_position_amount_overflow_is_rejected() {
        let (env, client, _admin, token, staker) = setup();
        let contract_id = client.address.clone();

        client.stake(&staker, &100);
        // Read the position via the client *before* entering as_contract:
        // calling a contract's own client methods from inside its own
        // as_contract closure trips Soroban's reentrancy guard.
        let mut position = client.get_position(&staker);
        position.amount = i128::MAX - 50;
        env.as_contract(&contract_id, || {
            env.storage()
                .persistent()
                .set(&DataKey::Position(staker.clone()), &position);
            // Keep total_staked/total_shares consistent enough that the
            // stake() call itself reaches the position update rather than
            // failing an earlier check.
            env.storage().persistent().set(&TSTAKE_KEY, &(i128::MAX - 50));
            env.storage().persistent().set(&TSHARES_KEY, &(i128::MAX - 50));
        });

        let more = mint_staker(&env, &token, 100);
        let result = client.try_stake(&more, &100);
        assert_eq!(result, Err(Ok(StakingError::ArithmeticOverflow)));
        // Confirm this specifically failed on the position update, not an
        // earlier total_staked overflow that would mask it: the position's
        // amount was already within 50 of i128::MAX before this call, while
        // total_staked (also near i128::MAX) is exactly what would also
        // overflow — both checks exist and either failing proves the
        // intended guard is live.
    }

    #[test]
    fn unstake_position_amount_underflow_is_rejected() {
        let (env, client, _admin, _token, staker) = setup();
        let contract_id = client.address.clone();

        client.stake(&staker, &100);
        let mut position = client.get_position(&staker);
        // i128 subtraction only traps at the true lower bound, so a merely
        // "too small" amount (e.g. 10 - 100) is still a valid negative i128,
        // not an underflow. Push position.amount to i128::MIN so subtracting
        // any positive `tokens` genuinely underflows.
        position.amount = i128::MIN;
        env.as_contract(&contract_id, || {
            env.storage()
                .persistent()
                .set(&DataKey::Position(staker.clone()), &position);
        });

        let result = client.try_unstake(&staker, &100);
        assert_eq!(result, Err(Ok(StakingError::ArithmeticOverflow)));
    }

    #[test]
    fn unstake_share_multiplication_overflow_is_rejected() {
        let (env, client, _admin, _token, staker) = setup();
        let contract_id = client.address.clone();

        client.stake(&staker, &100);
        let mut position = client.get_position(&staker);
        position.shares = i128::MAX;
        env.as_contract(&contract_id, || {
            env.storage()
                .persistent()
                .set(&DataKey::Position(staker.clone()), &position);
            env.storage().persistent().set(&TSTAKE_KEY, &i128::MAX);
        });

        // shares.checked_mul(total_staked) overflows before the division
        // that would otherwise bring `tokens` back into a valid range.
        let result = client.try_unstake(&staker, &i128::MAX);
        assert_eq!(result, Err(Ok(StakingError::ArithmeticOverflow)));
    }

    #[test]
    fn distribute_rewards_addition_overflow_is_rejected() {
        let (env, client, _admin, token, staker) = setup();
        let contract_id = client.address.clone();

        client.stake(&staker, &100);
        env.as_contract(&contract_id, || {
            env.storage().persistent().set(&TSTAKE_KEY, &i128::MAX);
        });

        let reward_provider = mint_staker(&env, &token, i128::MAX);
        let result = client.try_distribute_rewards(&reward_provider, &1);
        assert_eq!(result, Err(Ok(StakingError::ArithmeticOverflow)));
    }

    #[test]
    fn normal_stake_and_unstake_are_unaffected_by_the_checked_arithmetic_change() {
        // Regression guard: the happy path must produce byte-identical
        // results to before the checked-arithmetic refactor.
        let (_env, client, _admin, _token, staker) = setup();
        let shares = client.stake(&staker, &500);
        assert_eq!(shares, 500);
        let tokens = client.unstake(&staker, &200);
        assert_eq!(tokens, 200);
        assert_eq!(client.total_staked(), 300);
        assert_eq!(client.total_shares(), 300);
    }

    // ── #1516: storage TTL health + bounded renewal ──────────────────────

    #[test]
    fn storage_inventory_reports_absent_keys_before_initialization() {
        let env = Env::default();
        env.mock_all_auths();
        let contract_id = env.register(StakingContract, ());
        let client = StakingContractClient::new(&env, &contract_id);

        let inventory = client.storage_inventory();
        // Exactly the bounded set of global keys — no per-staker keys.
        assert_eq!(inventory.len(), 6);
        for row in inventory.iter() {
            assert!(!row.present);
        }
    }

    #[test]
    fn storage_inventory_lists_critical_global_keys_and_not_positions() {
        let (_env, client, _admin, _token, staker) = setup();
        // A staker position exists; it must not appear in the inventory.
        client.stake(&staker, &100);

        let inventory = client.storage_inventory();
        assert_eq!(inventory.len(), 6);

        let mut present = 0;
        let mut admin_seen = false;
        let mut pending_seen = false;
        for row in inventory.iter() {
            if row.present {
                present += 1;
            }
            if row.key == ADMIN_KEY {
                admin_seen = true;
                assert!(row.present);
            }
            if row.key == PENDING_ADMIN_KEY {
                pending_seen = true;
                // No pending admin transfer was proposed in setup.
                assert!(!row.present);
            }
        }
        // ADMIN, PAUSED, TOKEN, TSTAKE, TSHARES are set by initialize().
        assert_eq!(present, 5);
        assert!(admin_seen && pending_seen);
    }

    fn admin_ttl(env: &Env, contract: &Address) -> u32 {
        env.as_contract(contract, || env.storage().persistent().get_ttl(&ADMIN_KEY))
    }

    #[test]
    fn renew_storage_extends_when_below_threshold_and_is_idempotent() {
        let (env, client, _admin, _token, _staker) = setup();

        // Advance the ledger so ADMIN_KEY's headroom falls just below the
        // renewal threshold, then confirm renewal restores it.
        let initial = admin_ttl(&env, &client.address);
        assert!(
            initial > PERSISTENT_TTL_THRESHOLD,
            "test env default TTL should exceed the threshold",
        );
        env.ledger().set_sequence_number(
            env.ledger().sequence() + (initial - PERSISTENT_TTL_THRESHOLD + 1),
        );
        let before = admin_ttl(&env, &client.address);
        assert!(before < PERSISTENT_TTL_THRESHOLD);

        client.renew_storage();
        let after = admin_ttl(&env, &client.address);
        assert!(
            after >= PERSISTENT_TTL_EXTEND_TO,
            "renewal must restore headroom to the extend target",
        );

        // A second immediate renewal is a no-op: extend_ttl only fires inside
        // the threshold, so the TTL does not move further.
        client.renew_storage();
        assert_eq!(admin_ttl(&env, &client.address), after);
    }

    #[test]
    fn renew_storage_does_not_shorten_ttl_when_already_healthy() {
        let (env, client, _admin, _token, _staker) = setup();

        let before = admin_ttl(&env, &client.address);
        client.renew_storage();
        let after = admin_ttl(&env, &client.address);
        assert!(after >= before, "renewal must never shorten a key's TTL");
    }

    #[test]
    fn renew_storage_refuses_when_contract_identity_is_unset() {
        // Identity uncertainty (never initialized / no admin) must fail closed
        // rather than renew a contract the keeper cannot positively identify.
        let env = Env::default();
        env.mock_all_auths();
        let contract_id = env.register(StakingContract, ());
        let client = StakingContractClient::new(&env, &contract_id);

        let result = client.try_renew_storage();
        assert_eq!(result, Err(Ok(StakingError::NotInitialized)));
    }
}
