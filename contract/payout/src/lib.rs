#![no_std]

use soroban_sdk::{
    Address, BytesN, Env, Symbol, Vec, contract, contracterror, contractimpl, contracttype,
    panic_with_error, symbol_short, token,
};

const ADMIN_KEY: Symbol = symbol_short!("ADMIN");
const TREASURY_KEY: Symbol = symbol_short!("TREAS");
const PAUSED_KEY: Symbol = symbol_short!("PAUSED");
const PAYOUT_COUNT_KEY: Symbol = symbol_short!("P_COUNT");
const PENDING_HASH_KEY: Symbol = symbol_short!("P_HASH");
const EXECUTE_AFTER_KEY: Symbol = symbol_short!("P_AFTER");
const TOPIC_PAYOUT_EXECUTED: Symbol = symbol_short!("PAYOUT");
const TOPIC_DUST_COLLECTED: Symbol = symbol_short!("DUST");
const TOPIC_PAUSED: Symbol = symbol_short!("PAUSED");
const TOPIC_UNPAUSED: Symbol = symbol_short!("UNPAUSED");
const TOPIC_UPGRADE_PROPOSED: Symbol = symbol_short!("UP_PROP");
const TOPIC_UPGRADE_EXECUTED: Symbol = symbol_short!("UP_EXEC");
const TOPIC_UPGRADE_CANCELLED: Symbol = symbol_short!("UP_CANC");

const TIMELOCK_PERIOD: u64 = 48 * 60 * 60;
const EVENT_VERSION: u32 = 1;

// ── TTL constants ─────────────────────────────────────────────────────────────
const PAYOUT_TTL_THRESHOLD: u32 = 100_000;
const PAYOUT_TTL_EXTEND_TO: u32 = 535_680;
const INSTANCE_TTL_THRESHOLD: u32 = 100_000;
const INSTANCE_TTL_EXTEND_TO: u32 = 535_680;

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum DataKey {
    CurrencyToken(Symbol),
    Payout(Symbol, u32, u32, Address),
    PrizePayout(u32),
    PayoutHistory(u64),
    ArenaPayout(u64),
}

#[contracttype]
#[derive(Clone, Debug)]
pub struct PayoutData {
    pub winner: Address,
    pub amount: i128,
    pub currency: Symbol,
    pub paid: bool,
}

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct PayoutReceipt {
    pub arena_id: u64,
    pub winner: Address,
    pub amount: i128,
    pub fee: i128,
    pub timestamp: u64,
    pub tx_hash_hint: Option<BytesN<32>>,
}

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct PayoutPage {
    pub items: Vec<PayoutReceipt>,
    pub next_cursor: Option<u64>,
    pub has_more: bool,
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
    /// Contract is paused; write operations are disabled.
    Paused = 6,
    NoPendingUpgrade = 7,
    TimelockNotExpired = 8,
    UpgradeAlreadyPending = 9,
    HashMismatch = 10,
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
        if env
            .storage()
            .instance()
            .get::<_, bool>(&PAUSED_KEY)
            .unwrap_or(false)
        {
            panic_with_error!(&env, PayoutError::Paused);
        }
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

        admin.require_auth();

        require_not_paused(&env)?;

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
        env.storage().persistent().extend_ttl(
            &payout_key,
            PAYOUT_TTL_THRESHOLD,
            PAYOUT_TTL_EXTEND_TO,
        );
        env.storage()
            .instance()
            .extend_ttl(INSTANCE_TTL_THRESHOLD, INSTANCE_TTL_EXTEND_TO);

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

        record_receipt(&env, pool_id as u64, payout_data.winner, amount, 0, None);

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

        require_not_paused(&env)?;

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

    pub fn get_payout_history(env: Env, cursor: Option<u64>, limit: u32) -> PayoutPage {
        let count: u64 = env.storage().instance().get(&PAYOUT_COUNT_KEY).unwrap_or(0);
        let start = cursor.unwrap_or(0).min(count);
        let clamped_limit = limit.min(100);
        let end = start.saturating_add(clamped_limit as u64).min(count);
        let mut items = Vec::new(&env);

        for index in start..end {
            if let Some(receipt) = env
                .storage()
                .persistent()
                .get::<_, PayoutReceipt>(&DataKey::PayoutHistory(index))
            {
                items.push_back(receipt);
            }
        }

        PayoutPage {
            items,
            next_cursor: if end < count { Some(end) } else { None },
            has_more: end < count,
        }
    }

    pub fn get_payout_by_arena(env: Env, arena_id: u64) -> Option<PayoutReceipt> {
        env.storage()
            .persistent()
            .get(&DataKey::ArenaPayout(arena_id))
    }

    pub fn is_prize_distributed(env: Env, game_id: u32) -> bool {
        env.storage().instance().has(&DataKey::PrizePayout(game_id))
    }

    // ── Emergency pause ──────────────────────────────────────────────────────

    /// Pause the contract, disabling all write operations. Admin-only.
    pub fn pause(env: Env) {
        let admin = Self::admin(env.clone());
        admin.require_auth();
        env.storage().instance().set(&PAUSED_KEY, &true);
        env.events().publish((TOPIC_PAUSED,), ());
    }

    /// Unpause the contract, re-enabling write operations. Admin-only.
    pub fn unpause(env: Env) {
        let admin = Self::admin(env.clone());
        admin.require_auth();
        env.storage().instance().remove(&PAUSED_KEY);
        env.events().publish((TOPIC_UNPAUSED,), ());
    }

    /// Return whether the contract is currently paused.
    pub fn is_paused(env: Env) -> bool {
        env.storage().instance().get(&PAUSED_KEY).unwrap_or(false)
    }

    // ── Upgrade timelock ─────────────────────────────────────────────────────

    pub fn propose_upgrade(env: Env, new_wasm_hash: BytesN<32>) -> Result<(), PayoutError> {
        let admin = Self::admin(env.clone());
        admin.require_auth();
        if env.storage().instance().has(&PENDING_HASH_KEY) {
            return Err(PayoutError::UpgradeAlreadyPending);
        }
        let execute_after: u64 = env.ledger().timestamp() + TIMELOCK_PERIOD;
        env.storage().instance().set(&PENDING_HASH_KEY, &new_wasm_hash);
        env.storage().instance().set(&EXECUTE_AFTER_KEY, &execute_after);
        env.events().publish(
            (TOPIC_UPGRADE_PROPOSED,),
            (EVENT_VERSION, new_wasm_hash, execute_after),
        );
        Ok(())
    }

    pub fn execute_upgrade(env: Env, expected_hash: BytesN<32>) -> Result<(), PayoutError> {
        let admin = Self::admin(env.clone());
        admin.require_auth();
        let execute_after: u64 = env
            .storage()
            .instance()
            .get(&EXECUTE_AFTER_KEY)
            .ok_or(PayoutError::NoPendingUpgrade)?;
        if env.ledger().timestamp() < execute_after {
            return Err(PayoutError::TimelockNotExpired);
        }
        let stored_hash: BytesN<32> = env
            .storage()
            .instance()
            .get(&PENDING_HASH_KEY)
            .ok_or(PayoutError::NoPendingUpgrade)?;
        if stored_hash != expected_hash {
            return Err(PayoutError::HashMismatch);
        }
        env.storage().instance().remove(&PENDING_HASH_KEY);
        env.storage().instance().remove(&EXECUTE_AFTER_KEY);
        env.events().publish(
            (TOPIC_UPGRADE_EXECUTED,),
            (EVENT_VERSION, stored_hash.clone()),
        );
        env.deployer().update_current_contract_wasm(stored_hash);
        Ok(())
    }

    pub fn cancel_upgrade(env: Env) -> Result<(), PayoutError> {
        let admin = Self::admin(env.clone());
        admin.require_auth();
        if !env.storage().instance().has(&PENDING_HASH_KEY) {
            return Err(PayoutError::NoPendingUpgrade);
        }
        env.storage().instance().remove(&PENDING_HASH_KEY);
        env.storage().instance().remove(&EXECUTE_AFTER_KEY);
        env.events().publish((TOPIC_UPGRADE_CANCELLED,), (EVENT_VERSION,));
        Ok(())
    }

    pub fn pending_upgrade(env: Env) -> Option<(BytesN<32>, u64)> {
        let hash: Option<BytesN<32>> = env.storage().instance().get(&PENDING_HASH_KEY);
        let after: Option<u64> = env.storage().instance().get(&EXECUTE_AFTER_KEY);
        match (hash, after) {
            (Some(h), Some(a)) => Some((h, a)),
            _ => None,
        }
    }
}

/// Return `Err(PayoutError::Paused)` if the contract is currently paused.
fn require_not_paused(env: &Env) -> Result<(), PayoutError> {
    if env.storage().instance().get(&PAUSED_KEY).unwrap_or(false) {
        return Err(PayoutError::Paused);
    }
    Ok(())
}

fn record_receipt(
    env: &Env,
    arena_id: u64,
    winner: Address,
    amount: i128,
    fee: i128,
    tx_hash_hint: Option<BytesN<32>>,
) {
    let index: u64 = env.storage().instance().get(&PAYOUT_COUNT_KEY).unwrap_or(0);
    let receipt = PayoutReceipt {
        arena_id,
        winner,
        amount,
        fee,
        timestamp: env.ledger().timestamp(),
        tx_hash_hint,
    };
    env.storage()
        .persistent()
        .set(&DataKey::PayoutHistory(index), &receipt);
    env.storage()
        .persistent()
        .set(&DataKey::ArenaPayout(arena_id), &receipt);
    env.storage()
        .instance()
        .set(&PAYOUT_COUNT_KEY, &(index + 1));
}

#[cfg(test)]
mod test;
