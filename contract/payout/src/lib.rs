#![no_std]

use soroban_sdk::{
    Address, BytesN, Env, IntoVal, Symbol, Vec, contract, contracterror, contractimpl,
    contracttype, panic_with_error, symbol_short, token,
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

const ADMIN_KEY: Symbol = symbol_short!("ADMIN");
const PENDING_ADMIN_KEY: Symbol = symbol_short!("P_ADMIN");
const ADMIN_EXPIRY_KEY: Symbol = symbol_short!("A_EXP");
const TREASURY_KEY: Symbol = symbol_short!("TREAS");
const PAUSED_KEY: Symbol = symbol_short!("PAUSED");

const ADMIN_TRANSFER_EXPIRY: u64 = 7 * 24 * 60 * 60;
const PAYOUT_COUNT_KEY: Symbol = symbol_short!("P_COUNT");
const PENDING_HASH_KEY: Symbol = symbol_short!("P_HASH");
const EXECUTE_AFTER_KEY: Symbol = symbol_short!("P_AFTER");
const TOPIC_PAYOUT_EXECUTED: Symbol = symbol_short!("PAYOUT");
const TOPIC_DUST_COLLECTED: Symbol = symbol_short!("DUST");
const TOPIC_RECOVERY: Symbol = symbol_short!("RECOVER");
const TOPIC_PAUSED: Symbol = symbol_short!("PAUSED");
const TOPIC_UNPAUSED: Symbol = symbol_short!("UNPAUSED");
const TOPIC_CURRENCY_TOKEN_SET: Symbol = symbol_short!("TOK_SET");
const TOPIC_UPGRADE_PROPOSED: Symbol = symbol_short!("UP_PROP");
const TOPIC_UPGRADE_EXECUTED: Symbol = symbol_short!("UP_EXEC");
const TOPIC_UPGRADE_CANCELLED: Symbol = symbol_short!("UP_CANC");
const TOPIC_ADMIN_PROPOSED: Symbol = symbol_short!("AD_PROP");
const TOPIC_ADMIN_ACCEPTED: Symbol = symbol_short!("AD_DONE");
const TOPIC_ADMIN_CANCELLED: Symbol = symbol_short!("AD_CANC");

const FACTORY_KEY: Symbol = symbol_short!("FACTORY");

const TIMELOCK_PERIOD: u64 = 48 * 60 * 60;
const EVENT_VERSION: u32 = 1;

// ── TTL constants ─────────────────────────────────────────────────────────────
const PAYOUT_TTL_THRESHOLD: u32 = 100_000;
const PAYOUT_TTL_EXTEND_TO: u32 = 535_680;
const INSTANCE_TTL_THRESHOLD: u32 = 100_000;
const INSTANCE_TTL_EXTEND_TO: u32 = 535_680;

#[contracttype]
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum ArenaStatus {
    Pending,
    Active,
    Completed,
    Cancelled,
}

#[contracttype]
#[derive(Clone, Debug, PartialEq)]
pub struct ArenaRef {
    pub contract: Address,
    pub status: ArenaStatus,
    pub host: Address,
}

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum DataKey {
    CurrencyToken(Symbol),
    Payout(Symbol, u32, u32, Address),
    PrizePayout(u32),
    SplitPayout(u32, Address),
    SplitPayoutBatch(u32),
    PayoutHistory(u64),
    ArenaPayout(u64),
}

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct FactoryArenaMetadata {
    pub pool_id: u32,
    pub creator: Address,
    pub capacity: u32,
    pub stake_amount: i128,
    pub win_fee_bps: u32,
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
pub struct SplitPayoutReceipt {
    pub arena_id: u32,
    pub winner: Address,
    pub amount: i128,
    pub currency: Address,
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
    NoPendingAdminTransfer = 11,
    AdminTransferExpired = 12,
    Unauthorized = 13,
    NotInitialized = 14,
    RecoveryAmountInvalid = 15,
    ArithmeticOverflow = 16,
}

#[contract]
pub struct PayoutContract;

#[contractimpl]
impl PayoutContract {
    pub fn __constructor(env: Env, admin: Address) {
        admin.require_auth();
        env.storage().instance().set(&ADMIN_KEY, &admin);
    }

    pub fn init_factory(env: Env, factory: Address) {
        let admin = Self::admin(env.clone());
        admin.require_auth();

        env.storage().instance().set(&FACTORY_KEY, &factory);
    }

    pub fn admin(env: Env) -> Address {
        env.storage()
            .instance()
            .get(&ADMIN_KEY)
            .unwrap_or_else(|| panic_with_error!(&env, PayoutError::NotInitialized))
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
            .set(&DataKey::CurrencyToken(symbol.clone()), &token_address);
        env.events().publish(
            (TOPIC_CURRENCY_TOKEN_SET,),
            (EVENT_VERSION, symbol, token_address),
        );
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
        caller.require_auth();

        let factory: Address = env
            .storage()
            .instance()
            .get(&FACTORY_KEY)
            .ok_or(PayoutError::NotInitialized)?;

        let arena_id = pool_id as u64;
        let arena_ref: ArenaRef = env.invoke_contract(
            &factory,
            &soroban_sdk::Symbol::new(&env, "get_arena_ref"),
            soroban_sdk::vec![&env, arena_id.into_val(&env)],
        );

        if caller != arena_ref.contract {
            return Err(PayoutError::UnauthorizedCaller);
        }

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

        let mut fee_amount: i128 = 0;
        let mut winner_amount: i128 = amount;

        let arena_meta: Option<FactoryArenaMetadata> = env.invoke_contract(
            &factory,
            &soroban_sdk::Symbol::new(&env, "get_arena"),
            soroban_sdk::vec![&env, pool_id.into_val(&env)],
        );
        let fee_bps = arena_meta.map(|m| m.win_fee_bps).unwrap_or_else(|| {
            env.invoke_contract(
                &factory,
                &soroban_sdk::Symbol::new(&env, "current_fee_bps"),
                soroban_sdk::vec![&env],
            )
        });
        if fee_bps > 0 {
            fee_amount = amount
                .checked_mul(fee_bps as i128)
                .and_then(|v| v.checked_div(10_000i128))
                .ok_or(PayoutError::ArithmeticOverflow)?;
            winner_amount = amount
                .checked_sub(fee_amount)
                .ok_or(PayoutError::ArithmeticOverflow)?;
        }

        // Transfer tokens to winner and fee treasury if token address exists.
        if let Some(token_address) = env
            .storage()
            .instance()
            .get::<_, Address>(&DataKey::CurrencyToken(currency.clone()))
        {
            token::Client::new(&env, &token_address).transfer(
                &env.current_contract_address(),
                &winner,
                &winner_amount,
            );
            if fee_amount > 0 {
                token::Client::new(&env, &token_address).transfer(
                    &env.current_contract_address(),
                    &factory,
                    &fee_amount,
                );
                env.invoke_contract::<()>(
                    &factory,
                    &soroban_sdk::Symbol::new(&env, "record_win_fee"),
                    soroban_sdk::vec![&env, fee_amount.into_val(&env)],
                );
            }
        }

        env.events().publish(
            (TOPIC_PAYOUT_EXECUTED,),
            (winner, winner_amount, fee_amount, currency),
        );

        record_receipt(
            &env,
            pool_id as u64,
            payout_data.winner,
            winner_amount,
            fee_amount,
            None,
        );

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

    /// **Deprecated** — use [`PayoutContract::distribute_split_payout`] for multi-winner
    /// distributions.
    ///
    /// This function remains for backward compatibility only. It performs an equal split of
    /// `total_prize` across all `winners` and routes any integer remainder (dust) to the
    /// registered treasury address.
    ///
    /// # Migration
    /// Replace `distribute_prize(game_id, total_prize, winners, currency)` with
    /// `distribute_split_payout(game_id, winners, total_prize, currency)`.
    ///
    /// Key differences from `distribute_split_payout`:
    /// - Dust goes to the treasury, not to the first winner.
    /// - Per-winner receipts are **not** stored; only a batch marker is written.
    /// - Requires a treasury address to be set via `set_treasury`.
    ///
    /// # Errors
    /// * `AlreadyPaid`    — already distributed for `game_id`.
    /// * `InvalidAmount`  — `total_prize` ≤ 0.
    /// * `NoWinners`      — `winners` is empty.
    /// * `TreasuryNotSet` — no treasury address registered.
    /// * `Paused`         — contract is paused.
    #[deprecated(note = "Use `distribute_split_payout` instead; \
                see the function doc comment for the migration guide.")]
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

    /// **Deprecated** — use [`PayoutContract::is_split_payout_distributed`] for the
    /// canonical idempotency check that corresponds to `distribute_split_payout`.
    #[deprecated(
        note = "Use `is_split_payout_distributed` instead, which corresponds to the \
                canonical `distribute_split_payout` entrypoint."
    )]
    pub fn is_prize_distributed(env: Env, game_id: u32) -> bool {
        env.storage().instance().has(&DataKey::PrizePayout(game_id))
    }

    /// Canonical multi-winner distribution entrypoint. Splits `total_amount` across
    /// `winners`; remainder dust from integer division is sent to the first winner so
    /// no funds are left stranded in the contract.
    ///
    /// Prefer this function over the deprecated `distribute_prize`. Unlike
    /// `distribute_prize`, this function stores per-winner receipts (queryable via
    /// `get_split_payout_receipt`), does not require a treasury to be configured, and
    /// routes dust to the first winner rather than a separate treasury address.
    ///
    /// # Errors
    /// * `AlreadyPaid`   — already distributed for `arena_id`.
    /// * `InvalidAmount` — `total_amount` ≤ 0.
    /// * `NoWinners`     — `winners` is empty.
    /// * `Paused`        — contract is paused.
    pub fn distribute_split_payout(
        env: Env,
        arena_id: u32,
        winners: Vec<Address>,
        total_amount: i128,
        currency: Address,
    ) -> Result<(), PayoutError> {
        let admin = Self::admin(env.clone());
        admin.require_auth();

        require_not_paused(&env)?;

        if total_amount <= 0 {
            return Err(PayoutError::InvalidAmount);
        }
        if winners.is_empty() {
            return Err(PayoutError::NoWinners);
        }

        let batch_key = DataKey::SplitPayoutBatch(arena_id);
        if env.storage().instance().has(&batch_key) {
            return Err(PayoutError::AlreadyPaid);
        }

        let winners_count = winners.len() as i128;
        let per_winner = total_amount / winners_count;
        let remainder = total_amount % winners_count;
        let first_winner = winners.get(0).ok_or(PayoutError::NoWinners)?;

        // Idempotency guard first (effects before interactions)
        env.storage().instance().set(&batch_key, &true);

        let token_client = token::Client::new(&env, &currency);
        let contract_address = env.current_contract_address();

        for winner in winners.iter() {
            let amount = if winner == first_winner {
                per_winner
                    .checked_add(remainder)
                    .ok_or(PayoutError::InvalidAmount)?
            } else {
                per_winner
            };

            token_client.transfer(&contract_address, &winner, &amount);

            let receipt = SplitPayoutReceipt {
                arena_id,
                winner: winner.clone(),
                amount,
                currency: currency.clone(),
            };
            let receipt_key = DataKey::SplitPayout(arena_id, winner.clone());
            env.storage().persistent().set(&receipt_key, &receipt);
            env.storage().persistent().extend_ttl(
                &receipt_key,
                PAYOUT_TTL_THRESHOLD,
                PAYOUT_TTL_EXTEND_TO,
            );

            env.events()
                .publish((TOPIC_PAYOUT_EXECUTED,), (winner, amount, currency.clone()));
        }

        env.storage()
            .instance()
            .extend_ttl(INSTANCE_TTL_THRESHOLD, INSTANCE_TTL_EXTEND_TO);

        Ok(())
    }

    pub fn is_split_payout_distributed(env: Env, arena_id: u32) -> bool {
        env.storage()
            .instance()
            .has(&DataKey::SplitPayoutBatch(arena_id))
    }

    pub fn get_split_payout_receipt(
        env: Env,
        arena_id: u32,
        winner: Address,
    ) -> Option<SplitPayoutReceipt> {
        env.storage()
            .persistent()
            .get(&DataKey::SplitPayout(arena_id, winner))
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
            PayoutError::UpgradeAlreadyPending,
        )
    }

    pub fn execute_upgrade(env: Env, expected_hash: BytesN<32>) -> Result<(), PayoutError> {
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
                no_pending: PayoutError::NoPendingUpgrade,
                timelock_not_expired: PayoutError::TimelockNotExpired,
                hash_mismatch: PayoutError::HashMismatch,
                malformed_state: None,
            },
            ExecuteTimePolicy::AtOrAfter,
        )?;
        env.deployer().update_current_contract_wasm(stored_hash);
        Ok(())
    }

    pub fn cancel_upgrade(env: Env) -> Result<(), PayoutError> {
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
            PayoutError::NoPendingUpgrade,
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

    /// Admin-only recovery endpoint for stranded tokens.
    pub fn emergency_recover_tokens(
        env: Env,
        token_address: Address,
        recipient: Address,
        amount: i128,
    ) -> Result<(), PayoutError> {
        let admin = Self::admin(env.clone());
        admin.require_auth();
        if amount <= 0 {
            return Err(PayoutError::RecoveryAmountInvalid);
        }
        token::Client::new(&env, &token_address).transfer(
            &env.current_contract_address(),
            &recipient,
            &amount,
        );
        env.events()
            .publish((TOPIC_RECOVERY,), (recipient, amount, token_address));
        Ok(())
    }

    // ── Two-step admin transfer ───────────────────────────────────────────────

    /// Propose a new admin. The pending admin has 7 days to call `accept_admin`.
    pub fn propose_admin(env: Env, new_admin: Address) -> Result<(), PayoutError> {
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
    pub fn accept_admin(env: Env, new_admin: Address) -> Result<(), PayoutError> {
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
                no_pending: PayoutError::NoPendingAdminTransfer,
                unauthorized: PayoutError::Unauthorized,
                expired: PayoutError::AdminTransferExpired,
            },
        )?;
        env.events().publish(
            (TOPIC_ADMIN_ACCEPTED,),
            (EVENT_VERSION, old_admin, new_admin),
        );
        Ok(())
    }

    /// Cancel a pending admin transfer. Only the current admin may call this.
    pub fn cancel_admin_transfer(env: Env) -> Result<(), PayoutError> {
        let admin = Self::admin(env.clone());
        admin.require_auth();
        cancel_admin_transfer_flow(
            &env,
            AdminTransferKeys {
                admin: &ADMIN_KEY,
                pending_admin: &PENDING_ADMIN_KEY,
                admin_expiry: &ADMIN_EXPIRY_KEY,
            },
            PayoutError::NoPendingAdminTransfer,
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
mod snapshot_test;
#[cfg(test)]
mod test;
