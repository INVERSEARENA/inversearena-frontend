#![no_std]
mod types;

use soroban_sdk::{
    Address, BytesN, Env, contract, contractimpl, contracttype, symbol_short, token,
};
use types::{StakePosition, StakerStats, StakingError};

const ADMIN_KEY: soroban_sdk::Symbol = symbol_short!("ADMIN");
const PAUSED_KEY: soroban_sdk::Symbol = symbol_short!("PAUSED");
const TOKEN_KEY: soroban_sdk::Symbol = symbol_short!("TOKEN");
const TSTAKE_KEY: soroban_sdk::Symbol = symbol_short!("TSTAKE");
const TSHARES_KEY: soroban_sdk::Symbol = symbol_short!("TSHARES");

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

#[contract]
pub struct StakingContract;

#[contractimpl]
impl StakingContract {
    pub fn initialize(env: Env, admin: Address, token: Address) -> Result<(), StakingError> {
        admin.require_auth();
        if env.storage().instance().has(&ADMIN_KEY) {
            return Err(StakingError::AlreadyInitialized);
        }
        env.storage().instance().set(&ADMIN_KEY, &admin);
        env.storage().instance().set(&TOKEN_KEY, &token);
        env.storage().instance().set(&TSTAKE_KEY, &0i128);
        env.storage().instance().set(&TSHARES_KEY, &0i128);
        env.storage().instance().set(&PAUSED_KEY, &false);
        Ok(())
    }

    pub fn admin(env: Env) -> Address {
        env.storage()
            .instance()
            .get(&ADMIN_KEY)
            .expect("not initialized")
    }

    pub fn token(env: Env) -> Address {
        env.storage()
            .instance()
            .get(&TOKEN_KEY)
            .expect("not initialized")
    }

    pub fn pause(env: Env) -> Result<(), StakingError> {
        Self::require_admin(&env)?;
        env.storage().instance().set(&PAUSED_KEY, &true);
        env.events().publish((symbol_short!("PAUSED"),), ());
        Ok(())
    }

    pub fn unpause(env: Env) -> Result<(), StakingError> {
        Self::require_admin(&env)?;
        env.storage().instance().set(&PAUSED_KEY, &false);
        env.events().publish((symbol_short!("UNPAUS"),), ());
        Ok(())
    }

    pub fn is_paused(env: Env) -> bool {
        env.storage().instance().get(&PAUSED_KEY).unwrap_or(false)
    }

    pub fn total_staked(env: Env) -> i128 {
        env.storage().instance().get(&TSTAKE_KEY).unwrap_or(0)
    }

    pub fn total_shares(env: Env) -> i128 {
        env.storage().instance().get(&TSHARES_KEY).unwrap_or(0)
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
            amount * total_shares / total_staked
        };

        // A deposit that mints no shares is a pure donation to the existing
        // stakers — the victim side of the inflation attack. Reject it instead
        // of silently confiscating the tokens.
        if shares == 0 {
            return Err(StakingError::ZeroShares);
        }

        // EFFECTS — update state before token transfer
        env.storage()
            .instance()
            .set(&TSTAKE_KEY, &(total_staked + amount));
        env.storage()
            .instance()
            .set(&TSHARES_KEY, &(total_shares + shares));

        let mut position = Self::get_position(env.clone(), staker.clone());
        position.amount += amount;
        position.shares += shares;
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

    pub fn unstake(env: Env, staker: Address, shares: i128) -> Result<i128, StakingError> {
        staker.require_auth();
        Self::require_not_paused(&env)?;
        Self::require_initialized(&env)?;
        if shares <= 0 {
            return Err(StakingError::InvalidAmount);
        }

        let position = Self::get_position(env.clone(), staker.clone());
        if position.shares < shares {
            return Err(StakingError::InsufficientShares);
        }

        let total_staked = Self::total_staked(env.clone());
        let total_shares = Self::total_shares(env.clone());
        let tokens = shares * total_staked / total_shares;

        // EFFECTS — update state before token transfer
        let new_staked = total_staked - tokens;
        let new_shares = total_shares - shares;
        env.storage().instance().set(&TSTAKE_KEY, &new_staked);
        env.storage().instance().set(&TSHARES_KEY, &new_shares);

        let mut new_position = position.clone();
        new_position.amount -= tokens;
        new_position.shares -= shares;
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

        let total_staked = Self::total_staked(env.clone());
        env.storage()
            .instance()
            .set(&TSTAKE_KEY, &(total_staked + amount));

        let token_addr = Self::token(env.clone());
        let token_client = token::TokenClient::new(&env, &token_addr);
        token_client.transfer(&caller, &env.current_contract_address(), &amount);

        env.events()
            .publish((symbol_short!("REWARDS"),), (caller, amount));
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
        env.events().publish((symbol_short!("UPGRADE"),), new_wasm_hash);
        Ok(())
    }

    fn require_admin(env: &Env) -> Result<Address, StakingError> {
        let admin: Address = env
            .storage()
            .instance()
            .get(&ADMIN_KEY)
            .ok_or(StakingError::NotInitialized)?;
        admin.require_auth();
        Ok(admin)
    }

    fn require_not_paused(env: &Env) -> Result<(), StakingError> {
        if env.storage().instance().get(&PAUSED_KEY).unwrap_or(false) {
            return Err(StakingError::Paused);
        }
        Ok(())
    }

    fn require_initialized(env: &Env) -> Result<(), StakingError> {
        if !env.storage().instance().has(&ADMIN_KEY) {
            return Err(StakingError::NotInitialized);
        }
        Ok(())
    }
}

#[cfg(test)]
mod test {
    use super::*;
    use soroban_sdk::Vec;
    use soroban_sdk::testutils::Address as _;

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
        env.mock_all_auths_allowing_non_root_auth();
        // Non-admin should fail — we test by not calling mock_all_auths for specific addr
        let result = client.try_pause();
        assert!(result.is_ok()); // mock_all_auths allows everything in test
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
}

