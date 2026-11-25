#![no_std]
#![cfg_attr(coverage_nightly, feature(coverage_attribute))]
pub mod payout_math;
mod snapshot_tests;
mod storage;
mod types;

#[cfg(test)]
mod auth_tests;

use soroban_sdk::{
    Address, Bytes, BytesN, Env, Map, Vec, contract, contractclient, contractimpl, symbol_short,
    token, xdr::ToXdr,
};
use storage::PayoutStorage;
pub use types::{ArenaMetadata, ArenaSettlement, ArenaStatus, PayoutError, PendingCap};

/// Maximum entries per `distribute_batch` call (Soroban compute budget guard).
pub const MAX_BATCH_SIZE: u32 = 50;
/// Payout contract ABI/storage version, for client-side capability
/// negotiation across mixed deployment versions.
/// Bumped to 2 for #1632: payouts name an arena and are validated against it,
/// ids are derived from `(arena, recipient)`, and outflow is capped per day.
const CONTRACT_VERSION: u32 = 2;
/// How long a daily-cap *increase* waits before `apply_daily_cap` may apply
/// it (#1632). Lowering the cap is never delayed.
pub const CAP_TIMELOCK_SECONDS: u64 = 86_400;
const SECONDS_PER_DAY: u64 = 86_400;

/// The one arena read the payout contract depends on (#1632). Local stub
/// rather than a dependency on the `arena` crate, whose `#[contractimpl]`
/// would otherwise be linked into this contract's wasm.
#[contractclient(name = "ArenaSettlementClient")]
pub trait ArenaSettlementInterface {
    fn get_settlement(env: Env) -> ArenaSettlement;
}

/// The one factory read the payout contract depends on (#1632).
#[contractclient(name = "FactoryRegistryClient")]
pub trait FactoryRegistryInterface {
    fn get_arena(env: Env, pool_id: u32) -> Option<ArenaMetadata>;
}

/// Payout contract — distributes winnings to the surviving player of an
/// arena (#660).
///
/// The backend `PaymentService` builds transactions calling
/// `distribute_winnings`; it lives in-repo so it is open source and auditable.
///
/// The admin key alone cannot move funds anywhere it likes (#1632). Every
/// payout names an arena, and before any transfer the contract checks:
/// - the arena is genuine — the configured factory records it at the pool id
///   the arena reports;
/// - the arena has finished, the recipient is its recorded winner, and the
///   amount is at most the prize the arena records;
/// - the prize is in this contract's token;
/// - the pair `(arena, recipient)` has not been paid before (the payout id is
///   derived from it, so retries cannot pick fresh ids);
/// - today's total outflow stays within the daily cap, which can only be
///   raised behind a timelock.
#[contract]
pub struct PayoutContract;

#[contractimpl]
impl PayoutContract {
    /// One-time setup: the admin authorised to distribute, the payout token,
    /// the factory whose registry identifies genuine arenas, and the initial
    /// per-day outflow cap.
    ///
    /// # Errors
    /// - `PayoutError::AlreadyInitialised` on a second call.
    /// - `PayoutError::InvalidCap` if `daily_cap` is not positive.
    pub fn initialize(
        env: Env,
        admin: Address,
        token: Address,
        factory: Address,
        daily_cap: i128,
    ) -> Result<(), PayoutError> {
        admin.require_auth();
        if PayoutStorage::has_admin(&env) {
            return Err(PayoutError::AlreadyInitialised);
        }
        if daily_cap <= 0 {
            return Err(PayoutError::InvalidCap);
        }
        PayoutStorage::set_admin(&env, &admin);
        PayoutStorage::set_token(&env, &token);
        PayoutStorage::set_factory(&env, &factory);
        PayoutStorage::set_daily_cap(&env, daily_cap);
        PayoutStorage::save_storage_version(&env, storage::CURRENT_STORAGE_VERSION);
        Ok(())
    }

    /// Return the payout contract ABI/storage version.
    pub fn version(_env: Env) -> u32 {
        CONTRACT_VERSION
    }

    pub fn storage_version(env: Env) -> u32 { PayoutStorage::load_storage_version(&env) }

    pub fn migrate(env: Env, caller: Address, max_steps: u32) -> Result<u32, PayoutError> {
        caller.require_auth();
        let admin = PayoutStorage::get_admin(&env)?;
        if caller != admin { return Err(PayoutError::Unauthorized); }
        Ok(PayoutStorage::migrate(&env, max_steps))
    }

    /// Upgrade this payout contract to `new_wasm_hash`.
    ///
    /// Only the configured admin may perform upgrades so payout history remains
    /// attached to the same contract instance.
    pub fn upgrade(env: Env, new_wasm_hash: BytesN<32>) -> Result<(), PayoutError> {
        PayoutStorage::require_current_storage_version(&env)?;
        let admin = PayoutStorage::get_admin(&env)?;
        admin.require_auth();
        env.deployer().update_current_contract_wasm(new_wasm_hash);
        Ok(())
    }

    /// The payout id for paying `recipient` out of `arena` (#1632):
    /// `sha256(xdr(arena) ‖ xdr(recipient))`.
    ///
    /// Derived rather than caller-chosen, so one arena prize maps to exactly
    /// one id and can be paid at most once.
    pub fn payout_id(env: Env, arena: Address, recipient: Address) -> BytesN<32> {
        let mut preimage = Bytes::new(&env);
        preimage.append(&arena.to_xdr(&env));
        preimage.append(&recipient.to_xdr(&env));
        env.crypto().sha256(&preimage).into()
    }

    /// Pay `winner` `amount` of the payout token for winning `arena`.
    ///
    /// # Errors
    /// - `PayoutError::InvalidAmount` if `amount <= 0`.
    /// - `PayoutError::AlreadyPaid` if `(arena, winner)` was already paid.
    /// - `PayoutError::ArenaSettlementUnavailable` if the arena cannot report
    ///   its settlement (not an arena, or WASM older than #1632).
    /// - `PayoutError::UnknownArena` if the factory does not know the arena.
    /// - `PayoutError::ArenaNotSettled`, `NotArenaWinner`, `ExceedsEntitlement`
    ///   or `TokenMismatch` if the arena's own record does not support the
    ///   payout.
    /// - `PayoutError::DailyCapExceeded` if today's outflow would exceed the cap.
    /// - `PayoutError::InsufficientBalance` if the contract cannot cover it.
    ///
    /// # Events
    /// Emits `payout` with topics `(payout, winner)` and data
    /// `(arena, payout_id, amount)`.
    pub fn distribute_winnings(
        env: Env,
        arena: Address,
        winner: Address,
        amount: i128,
    ) -> Result<(), PayoutError> {
        PayoutStorage::require_current_storage_version(&env)?;
        let admin = PayoutStorage::get_admin(&env)?;
        admin.require_auth();

        let token_addr = PayoutStorage::get_token(&env)?;
        let payout_id = Self::validate_payout(&env, &token_addr, &arena, &winner, amount)?;
        let client = token::TokenClient::new(&env, &token_addr);
        if amount > client.balance(&env.current_contract_address()) {
            return Err(PayoutError::InsufficientBalance);
        }
        Self::consume_daily_allowance(&env, amount)?;

        // Effects before the transfer: a re-entrant call sees the id as paid.
        PayoutStorage::record_payout(&env, &payout_id, amount);
        client.transfer(&env.current_contract_address(), &winner, &amount);

        env.events().publish(
            (symbol_short!("payout"), winner),
            (arena, payout_id, amount),
        );
        Ok(())
    }

    /// Pay several `(arena, recipient, amount)` entries in one transaction.
    ///
    /// Every entry is validated exactly as `distribute_winnings` validates
    /// one — entries may name different arenas — and the batch's total must
    /// fit both the balance and today's remaining cap. Nothing is transferred
    /// unless every entry passes.
    ///
    /// # Errors
    /// Those of `distribute_winnings`, plus `EmptyBatch`, `BatchTooLarge`, and
    /// `DuplicateRecipient` when two entries share an `(arena, recipient)`.
    pub fn distribute_batch(
        env: Env,
        payouts: Vec<(Address, Address, i128)>,
    ) -> Result<(), PayoutError> {
        PayoutStorage::require_current_storage_version(&env)?;
        let admin = PayoutStorage::get_admin(&env)?;
        admin.require_auth();

        if payouts.is_empty() {
            return Err(PayoutError::EmptyBatch);
        }
        if payouts.len() > MAX_BATCH_SIZE {
            return Err(PayoutError::BatchTooLarge);
        }

        let token_addr = PayoutStorage::get_token(&env)?;
        // Duplicate detection is O(n) via a Map keyed by payout id (#1620), so
        // the check no longer grows quadratically with the batch size.
        let mut ids: Vec<BytesN<32>> = Vec::new(&env);
        let mut seen: Map<BytesN<32>, bool> = Map::new(&env);
        let mut total: i128 = 0;
        for (arena, recipient, amount) in payouts.iter() {
            let payout_id = Self::validate_payout(&env, &token_addr, &arena, &recipient, amount)?;
            if seen.contains_key(payout_id.clone()) {
                return Err(PayoutError::DuplicateRecipient);
            }
            seen.set(payout_id.clone(), true);
            ids.push_back(payout_id);
            total = total.checked_add(amount).ok_or(PayoutError::InvalidAmount)?;
        }

        let client = token::TokenClient::new(&env, &token_addr);
        let contract = env.current_contract_address();
        if total > client.balance(&contract) {
            return Err(PayoutError::InsufficientBalance);
        }
        Self::consume_daily_allowance(&env, total)?;

        // Record every id before the first transfer (checks-effects-
        // interactions): a token callback re-entering cannot replay any entry.
        for (i, (_, _, amount)) in payouts.iter().enumerate() {
            PayoutStorage::record_payout(&env, &ids.get_unchecked(i as u32), amount);
        }
        for (i, (arena, recipient, amount)) in payouts.iter().enumerate() {
            client.transfer(&contract, &recipient, &amount);
            env.events().publish(
                (symbol_short!("payout"), recipient),
                (arena, ids.get_unchecked(i as u32), amount),
            );
        }
        Ok(())
    }

    /// Whether `payout_id` (see `payout_id`) has been paid.
    pub fn is_paid(env: Env, payout_id: BytesN<32>) -> bool {
        PayoutStorage::paid_amount(&env, &payout_id).is_some()
    }

    /// The amount paid for `payout_id`, or `None` if it is unpaid.
    pub fn paid_amount(env: Env, payout_id: BytesN<32>) -> Option<i128> {
        PayoutStorage::paid_amount(&env, &payout_id)
    }

    // ── Daily outflow cap (#1632) ─────────────────────────────────────────

    /// Propose a new per-day outflow cap.
    ///
    /// Lowering (or keeping) the cap takes effect immediately — tightening can
    /// only reduce what a compromised key could move. Raising it is staged
    /// and only `apply_daily_cap` after `CAP_TIMELOCK_SECONDS` makes it
    /// effective, leaving a window to notice and rotate the admin. A new
    /// proposal replaces any pending one.
    ///
    /// # Events
    /// Emits `cap_set` with `cap` when applied immediately, or `cap_prop`
    /// with `(cap, eta)` when staged.
    pub fn propose_daily_cap(env: Env, cap: i128) -> Result<(), PayoutError> {
        PayoutStorage::require_current_storage_version(&env)?;
        let admin = PayoutStorage::get_admin(&env)?;
        admin.require_auth();
        if cap <= 0 {
            return Err(PayoutError::InvalidCap);
        }
        if cap <= PayoutStorage::get_daily_cap(&env)? {
            PayoutStorage::set_daily_cap(&env, cap);
            PayoutStorage::clear_pending_cap(&env);
            env.events().publish((symbol_short!("cap_set"),), cap);
            return Ok(());
        }
        let eta = env.ledger().timestamp().saturating_add(CAP_TIMELOCK_SECONDS);
        PayoutStorage::set_pending_cap(&env, &PendingCap { cap, eta });
        env.events().publish((symbol_short!("cap_prop"),), (cap, eta));
        Ok(())
    }

    /// Apply a staged cap increase once its timelock has elapsed.
    ///
    /// # Errors
    /// - `PayoutError::NoPendingCap` if nothing is staged.
    /// - `PayoutError::CapTimelockPending` before the staged `eta`.
    pub fn apply_daily_cap(env: Env) -> Result<(), PayoutError> {
        PayoutStorage::require_current_storage_version(&env)?;
        let admin = PayoutStorage::get_admin(&env)?;
        admin.require_auth();
        let pending = PayoutStorage::get_pending_cap(&env).ok_or(PayoutError::NoPendingCap)?;
        if env.ledger().timestamp() < pending.eta {
            return Err(PayoutError::CapTimelockPending);
        }
        PayoutStorage::set_daily_cap(&env, pending.cap);
        PayoutStorage::clear_pending_cap(&env);
        env.events().publish((symbol_short!("cap_set"),), pending.cap);
        Ok(())
    }

    /// Discard a staged cap increase.
    pub fn cancel_daily_cap(env: Env) -> Result<(), PayoutError> {
        let admin = PayoutStorage::get_admin(&env)?;
        admin.require_auth();
        PayoutStorage::get_pending_cap(&env).ok_or(PayoutError::NoPendingCap)?;
        PayoutStorage::clear_pending_cap(&env);
        Ok(())
    }

    pub fn daily_cap(env: Env) -> Option<i128> {
        PayoutStorage::get_daily_cap(&env).ok()
    }

    pub fn pending_daily_cap(env: Env) -> Option<PendingCap> {
        PayoutStorage::get_pending_cap(&env)
    }

    /// Total paid out so far on the current UTC day.
    pub fn outflow_today(env: Env) -> i128 {
        PayoutStorage::outflow(&env, Self::today(&env))
    }

    pub fn admin(env: Env) -> Option<Address> {
        PayoutStorage::get_admin(&env).ok()
    }

    pub fn token(env: Env) -> Option<Address> {
        PayoutStorage::get_token(&env).ok()
    }

    pub fn factory(env: Env) -> Option<Address> {
        PayoutStorage::get_factory(&env).ok()
    }

    pub fn propose_admin(env: Env, new_admin: Address) -> Result<(), PayoutError> {
        PayoutStorage::require_current_storage_version(&env)?;
        let admin = PayoutStorage::get_admin(&env)?;
        admin.require_auth();
        PayoutStorage::save_pending_admin(&env, &new_admin);
        env.events()
            .publish((symbol_short!("adm_prop"),), (new_admin,));
        Ok(())
    }

    pub fn accept_admin(env: Env) -> Result<(), PayoutError> {
        PayoutStorage::require_current_storage_version(&env)?;
        let pending_admin = PayoutStorage::load_pending_admin(&env)
            .ok_or(PayoutError::NoPendingAdmin)?;
        pending_admin.require_auth();
        let old_admin = PayoutStorage::get_admin(&env)?;
        PayoutStorage::set_admin(&env, &pending_admin);
        PayoutStorage::delete_pending_admin(&env);
        env.events()
            .publish((symbol_short!("adm_chg"),), (old_admin, pending_admin));
        Ok(())
    }

    /// Check one payout against the arena's on-chain record and return its
    /// derived id. Reads only; the caller applies the cap and records it.
    fn validate_payout(
        env: &Env,
        token: &Address,
        arena: &Address,
        recipient: &Address,
        amount: i128,
    ) -> Result<BytesN<32>, PayoutError> {
        if amount <= 0 {
            return Err(PayoutError::InvalidAmount);
        }
        let payout_id = Self::payout_id(env.clone(), arena.clone(), recipient.clone());
        if PayoutStorage::paid_amount(env, &payout_id).is_some() {
            return Err(PayoutError::AlreadyPaid);
        }

        // Older arena WASM has no settlement read; refuse rather than guess.
        let settlement = match ArenaSettlementClient::new(env, arena).try_get_settlement() {
            Ok(Ok(settlement)) => settlement,
            _ => return Err(PayoutError::ArenaSettlementUnavailable),
        };

        // The arena could be any contract returning any settlement; only the
        // factory's registry makes its answers trustworthy.
        let factory = PayoutStorage::get_factory(env)?;
        let registered = match FactoryRegistryClient::new(env, &factory)
            .try_get_arena(&settlement.pool_id)
        {
            Ok(Ok(Some(meta))) => meta.arena_address == *arena,
            _ => false,
        };
        if !registered {
            return Err(PayoutError::UnknownArena);
        }

        if !settlement.finished {
            return Err(PayoutError::ArenaNotSettled);
        }
        if settlement.winner.as_ref() != Some(recipient) {
            return Err(PayoutError::NotArenaWinner);
        }
        if settlement.stake_token != *token {
            return Err(PayoutError::TokenMismatch);
        }
        if amount > settlement.prize {
            return Err(PayoutError::ExceedsEntitlement);
        }
        Ok(payout_id)
    }

    /// Count `amount` against today's cap, failing if it would exceed it.
    fn consume_daily_allowance(env: &Env, amount: i128) -> Result<(), PayoutError> {
        let day = Self::today(env);
        let spent = PayoutStorage::outflow(env, day);
        let total = spent.checked_add(amount).ok_or(PayoutError::DailyCapExceeded)?;
        if total > PayoutStorage::get_daily_cap(env)? {
            return Err(PayoutError::DailyCapExceeded);
        }
        PayoutStorage::set_outflow(env, day, total);
        Ok(())
    }

    fn today(env: &Env) -> u64 {
        env.ledger().timestamp() / SECONDS_PER_DAY
    }
}

#[cfg(test)]
pub(crate) mod test_support {
    //! Stand-in arena and factory contracts for payout tests (#1632).
    use crate::types::{ArenaMetadata, ArenaSettlement, ArenaStatus};
    use soroban_sdk::{Address, BytesN, Env, contract, contractimpl, symbol_short};

    /// An arena that reports whatever settlement the test configures.
    #[contract]
    pub struct MockArena;

    #[contractimpl]
    impl MockArena {
        pub fn set_settlement(env: Env, settlement: ArenaSettlement) {
            env.storage().instance().set(&symbol_short!("SETTLE"), &settlement);
        }

        pub fn get_settlement(env: Env) -> ArenaSettlement {
            env.storage()
                .instance()
                .get(&symbol_short!("SETTLE"))
                .expect("mock arena settlement not set")
        }
    }

    /// An arena built before #1632: it has no `get_settlement`.
    #[contract]
    pub struct LegacyArena;

    #[contractimpl]
    impl LegacyArena {
        pub fn version(_env: Env) -> u32 {
            4
        }
    }

    /// A factory registry mapping pool ids to arena addresses.
    #[contract]
    pub struct MockFactory;

    #[contractimpl]
    impl MockFactory {
        pub fn register(env: Env, pool_id: u32, arena: Address) {
            let meta = ArenaMetadata {
                arena_address: arena.clone(),
                pool_id,
                host: arena,
                entry_fee: 100,
                status: ArenaStatus::Finished,
                created_at: 0,
                metadata_hash: BytesN::from_array(&env, &[0u8; 32]),
            };
            env.storage().persistent().set(&pool_id, &meta);
        }

        pub fn get_arena(env: Env, pool_id: u32) -> Option<ArenaMetadata> {
            env.storage().persistent().get(&pool_id)
        }
    }
}

#[cfg(test)]
#[cfg_attr(coverage_nightly, coverage(off))]
mod test;

#[cfg(test)]
#[cfg_attr(coverage_nightly, coverage(off))]
mod fixture_tests;
