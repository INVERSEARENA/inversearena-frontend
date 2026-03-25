#![no_std]

use soroban_sdk::{
    Address, Env, Symbol, Vec, contract, contracterror, contractimpl, contracttype,
    panic_with_error, symbol_short, token,
};

const ADMIN_KEY: Symbol = symbol_short!("ADMIN");
const TREASURY_KEY: Symbol = symbol_short!("TREAS");
const TOPIC_PAYOUT_EXECUTED: Symbol = symbol_short!("PAYOUT");
const TOPIC_DUST_COLLECTED: Symbol = symbol_short!("DUST");

// ── TTL constants for persistent payout records (~31 days) ───────────────────
const PAYOUT_TTL_THRESHOLD: u32 = 100_000;
const PAYOUT_TTL_EXTEND_TO: u32 = 535_680;

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum DataKey {
    CurrencyToken(Symbol),
    Payout(Symbol, u32, u32, Address),
    PrizePayout(u32),
}

#[contracttype]
#[derive(Clone, Debug)]
pub struct PayoutData {
    pub winner: Address,
    pub amount: i128,
    pub currency: Symbol,
    pub paid: bool,
}

#[contracterror]
#[derive(Copy, Clone, Debug, Eq, PartialEq, PartialOrd, Ord)]
#[repr(u32)]
pub enum PayoutError {
    UnauthorizedCaller = 1,
    InvalidAmount = 2,
    AlreadyPaid = 3,
    NoWinners = 4,
    TreasuryNotSet = 5,
}

#[contract]
pub struct PayoutContract;

#[contractimpl]
impl PayoutContract {
    /// Placeholder function — returns a fixed value for contract liveness checks.

    pub fn hello(_env: Env) -> u32 {
        789
    }

    pub fn initialize(env: Env, admin: Address) {
        if env.storage().instance().has(&ADMIN_KEY) {
            panic!("already initialized");
        }

        admin.require_auth();

        env.storage().instance().set(&ADMIN_KEY, &admin);
    }

    pub fn init_factory(env: Env, factory: Address, admin: Address) {
        if env.storage().instance().has(&ADMIN_KEY) {
            panic!("already initialized");
        }

        factory.require_auth();

        env.storage().instance().set(&ADMIN_KEY, &admin);
    }

    pub fn admin(env: Env) -> Address {
        env.storage()
            .instance()
            .get(&ADMIN_KEY)
            .expect("not initialized")
    }

    pub fn set_treasury(env: Env, treasury: Address) {
        let admin = Self::admin(env.clone());
        admin.require_auth();
        env.storage().instance().set(&TREASURY_KEY, &treasury);
    }

    pub fn treasury(env: Env) -> Result<Address, PayoutError> {
        env.storage()
            .instance()
            .get(&TREASURY_KEY)
            .ok_or(PayoutError::TreasuryNotSet)
    }

    /// Register a token contract address for a currency symbol.
    /// Admin-only. Used so `distribute_winnings` can transfer tokens on-chain.
    pub fn set_currency_token(env: Env, symbol: Symbol, token_address: Address) {
        let admin = Self::admin(env.clone());
        admin.require_auth();
        env.storage()
            .instance()
            .set(&DataKey::CurrencyToken(symbol), &token_address);
    }

    /// Distribute a payout to a single winner.
    ///
    /// The composite key `(ctx, pool_id, round_id, winner)` ensures idempotency:
    /// the same combination can only be paid once.
    ///
    /// If the currency symbol has a registered token address (via
    /// `set_currency_token`), the contract transfers `amount` tokens directly
    /// to the winner. Otherwise, the payout is recorded on-chain only.
    ///
    /// # Errors
    /// * `UnauthorizedCaller` — `caller` is not the admin.
    /// * `InvalidAmount`      — `amount` is zero or negative.
    /// * `AlreadyPaid`        — the composite key was already processed.
    pub fn distribute_winnings(
        env: Env,
        caller: Address,
        ctx: Symbol,
        pool_id: u32,
        round_id: u32,
        winner: Address,
        amount: i128,
        currency: Symbol,
    ) -> Result<(), PayoutError> {
        let admin: Address = env
            .storage()
            .instance()
            .get(&ADMIN_KEY)
            .expect("not initialized");

        // Enforce admin authorization before using caller identity checks.
        admin.require_auth();

        if caller != admin {
            panic_with_error!(&env, PayoutError::UnauthorizedCaller);
        }

        if amount <= 0 {
            panic_with_error!(&env, PayoutError::InvalidAmount);
        }

        let payout_key = DataKey::Payout(ctx.clone(), pool_id, round_id, winner.clone());
        if env
            .storage()
            .persistent()
            .get::<_, PayoutData>(&payout_key)
            .is_some()
        {
            panic_with_error!(&env, PayoutError::AlreadyPaid);
        }

        let payout_data = PayoutData {
            winner: winner.clone(),
            amount,
            currency: currency.clone(),
            paid: true,
        };
        env.storage().persistent().set(&payout_key, &payout_data);
        env.storage()
            .persistent()
            .extend_ttl(&payout_key, PAYOUT_TTL_THRESHOLD, PAYOUT_TTL_EXTEND_TO);

        // Transfer tokens to winner if a token address is registered for this currency.
        if let Some(token_address) = env
            .storage()
            .instance()
            .get::<_, Address>(&DataKey::CurrencyToken(currency.clone()))
        {
            token::Client::new(&env, &token_address).transfer(
                &env.current_contract_address(),
                &winner,
                &amount,
            );
        }

        env.events()
            .publish((TOPIC_PAYOUT_EXECUTED,), (winner, amount, currency));

        Ok(())
    }

    /// Returns whether a payout for the composite key has already been processed.
    pub fn is_payout_processed(
        env: Env,
        ctx: Symbol,
        pool_id: u32,
        round_id: u32,
        winner: Address,
    ) -> bool {
        let payout_key = DataKey::Payout(ctx, pool_id, round_id, winner);
        env.storage()
            .persistent()
            .get::<_, PayoutData>(&payout_key)
            .map(|p| p.paid)
            .unwrap_or(false)
    }

    /// Returns the stored `PayoutData` for the composite key, or `None` if not processed.
    pub fn get_payout(
        env: Env,
        ctx: Symbol,
        pool_id: u32,
        round_id: u32,
        winner: Address,
    ) -> Option<PayoutData> {
        let payout_key = DataKey::Payout(ctx, pool_id, round_id, winner);
        env.storage().persistent().get(&payout_key)
    }

    pub fn distribute_prize(
        env: Env,
        game_id: u32,
        total_prize: i128,
        winners: Vec<Address>,
        currency: Address,
    ) -> Result<(), PayoutError> {
        let admin = Self::admin(env.clone());
        admin.require_auth();

        // Idempotency guard — prevent double-payment on retry
        let prize_key = DataKey::PrizePayout(game_id);
        if env.storage().instance().has(&prize_key) {
            return Err(PayoutError::AlreadyPaid);
        }

        if total_prize <= 0 {
            return Err(PayoutError::InvalidAmount);
        }
        if winners.is_empty() {
            return Err(PayoutError::NoWinners);
        }

        let treasury = Self::treasury(env.clone())?;
        let count = winners.len() as i128;
        let share = total_prize / count;
        let dust = total_prize % count;

        // Effects before interactions: mark idempotency guard first.
        env.storage().instance().set(&prize_key, &true);

        let token_client = token::Client::new(&env, &currency);
        let contract_address = env.current_contract_address();

        for winner in winners.iter() {
            token_client.transfer(&contract_address, &winner, &share);
            env.events()
                .publish((TOPIC_PAYOUT_EXECUTED,), (winner, share, currency.clone()));
        }

        if dust > 0 {
            token_client.transfer(&contract_address, &treasury, &dust);
            env.events()
                .publish((TOPIC_DUST_COLLECTED,), (treasury, dust, currency));
        }

        Ok(())
    }

    pub fn is_prize_distributed(env: Env, game_id: u32) -> bool {
        env.storage().instance().has(&DataKey::PrizePayout(game_id))
    }
}

#[cfg(test)]
mod test;
