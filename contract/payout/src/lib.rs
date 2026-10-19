#![no_std]
mod snapshot_tests;
mod storage;
mod types;

#[cfg(test)]
mod auth_tests;

use soroban_sdk::{
    Address, Bytes, BytesN, Env, Vec, contract, contractclient, contractimpl, symbol_short,
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
        Ok(())
    }

    /// Return the payout contract ABI/storage version.
    pub fn version(_env: Env) -> u32 {
        CONTRACT_VERSION
    }

    /// Upgrade this payout contract to `new_wasm_hash`.
    ///
    /// Only the configured admin may perform upgrades so payout history remains
    /// attached to the same contract instance.
    pub fn upgrade(env: Env, new_wasm_hash: BytesN<32>) -> Result<(), PayoutError> {
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
        let admin = PayoutStorage::get_admin(&env)?;
        admin.require_auth();

        if payouts.is_empty() {
            return Err(PayoutError::EmptyBatch);
        }
        if payouts.len() > MAX_BATCH_SIZE {
            return Err(PayoutError::BatchTooLarge);
        }

        let token_addr = PayoutStorage::get_token(&env)?;
        // Duplicate check is O(n²) via Vec::contains. With MAX_BATCH_SIZE = 50
        // this is at most 1,225 comparisons — within compute budget.
        let mut ids: Vec<BytesN<32>> = Vec::new(&env);
        let mut total: i128 = 0;
        for (arena, recipient, amount) in payouts.iter() {
            let payout_id = Self::validate_payout(&env, &token_addr, &arena, &recipient, amount)?;
            if ids.contains(&payout_id) {
                return Err(PayoutError::DuplicateRecipient);
            }
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
        let admin = PayoutStorage::get_admin(&env)?;
        admin.require_auth();
        PayoutStorage::save_pending_admin(&env, &new_admin);
        env.events()
            .publish((symbol_short!("adm_prop"),), (new_admin,));
        Ok(())
    }

    pub fn accept_admin(env: Env) -> Result<(), PayoutError> {
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
mod test {
    use super::*;
    use crate::test_support::{LegacyArena, MockArena, MockArenaClient, MockFactory, MockFactoryClient};
    use soroban_sdk::testutils::{Address as _, Ledger as _};
    use soroban_sdk::token;

    const CAP: i128 = 10_000;

    struct Fixture {
        env: Env,
        client: PayoutContractClient<'static>,
        token: token::TokenClient<'static>,
        factory: Address,
        next_pool: core::cell::Cell<u32>,
    }

    impl Fixture {
        /// A genuine, finished arena (registered with the factory) won by
        /// `winner` with the given prize, paid in the payout token.
        fn finished_arena(&self, winner: &Address, prize: i128) -> Address {
            self.arena_with(ArenaSettlement {
                finished: true,
                winner: Some(winner.clone()),
                prize,
                stake_token: self.token.address.clone(),
                pool_id: 0,
            })
        }

        /// Register a mock arena reporting `settlement` (its `pool_id` is
        /// replaced with a fresh one) and record it with the factory.
        fn arena_with(&self, mut settlement: ArenaSettlement) -> Address {
            let pool_id = self.next_pool.get() + 1;
            self.next_pool.set(pool_id);
            settlement.pool_id = pool_id;
            let arena = self.env.register(MockArena, ());
            MockArenaClient::new(&self.env, &arena).set_settlement(&settlement);
            MockFactoryClient::new(&self.env, &self.factory).register(&pool_id, &arena);
            arena
        }

        fn id(&self, arena: &Address, recipient: &Address) -> BytesN<32> {
            self.client.payout_id(arena, recipient)
        }

        fn err(
            &self,
            result: Result<
                Result<(), soroban_sdk::ConversionError>,
                Result<PayoutError, soroban_sdk::InvokeError>,
            >,
        ) -> PayoutError {
            result
                .err()
                .expect("call must fail")
                .expect("error must be a contract error")
        }
    }

    /// Deploy a payout contract funded with `funding` of a fresh test token.
    fn setup(funding: i128) -> Fixture {
        let env = Env::default();
        env.mock_all_auths();

        let admin = Address::generate(&env);
        let sac = env.register_stellar_asset_contract_v2(admin.clone());
        let token_addr = sac.address();
        let factory = env.register(MockFactory, ());

        let contract_id = env.register(PayoutContract, ());
        let client = PayoutContractClient::new(&env, &contract_id);
        client.initialize(&admin, &token_addr, &factory, &CAP);

        token::StellarAssetClient::new(&env, &token_addr).mint(&contract_id, &funding);

        let token = token::TokenClient::new(&env, &token_addr);
        Fixture { env, client, token, factory, next_pool: core::cell::Cell::new(0) }
    }

    #[test]
    fn version_returns_the_current_contract_version() {
        let fx = setup(0);
        assert_eq!(fx.client.version(), CONTRACT_VERSION);
    }

    #[test]
    fn distributes_to_the_arena_winner() {
        let fx = setup(1_000);
        let winner = Address::generate(&fx.env);
        let arena = fx.finished_arena(&winner, 600);

        fx.client.distribute_winnings(&arena, &winner, &600);

        assert_eq!(fx.token.balance(&winner), 600);
        assert!(fx.client.is_paid(&fx.id(&arena, &winner)));
        assert_eq!(fx.client.paid_amount(&fx.id(&arena, &winner)), Some(600));
        assert_eq!(fx.client.outflow_today(), 600);
    }

    #[test]
    fn payout_ids_are_deterministic_per_arena_and_recipient() {
        let fx = setup(0);
        let (a, b) = (Address::generate(&fx.env), Address::generate(&fx.env));
        let (x, y) = (Address::generate(&fx.env), Address::generate(&fx.env));

        assert_eq!(fx.id(&a, &x), fx.id(&a, &x));
        assert_ne!(fx.id(&a, &x), fx.id(&a, &y));
        assert_ne!(fx.id(&a, &x), fx.id(&b, &x));
        assert_ne!(fx.id(&a, &x), fx.id(&x, &a), "argument order is part of the id");
    }

    #[test]
    fn rejects_a_second_payout_for_the_same_arena_and_winner() {
        let fx = setup(1_000);
        let winner = Address::generate(&fx.env);
        let arena = fx.finished_arena(&winner, 500);

        fx.client.distribute_winnings(&arena, &winner, &100);
        let err = fx.err(fx.client.try_distribute_winnings(&arena, &winner, &100));
        assert_eq!(err, PayoutError::AlreadyPaid);
        assert_eq!(fx.token.balance(&winner), 100);
    }

    #[test]
    fn rejects_non_positive_amount() {
        let fx = setup(1_000);
        let winner = Address::generate(&fx.env);
        let arena = fx.finished_arena(&winner, 500);
        let err = fx.err(fx.client.try_distribute_winnings(&arena, &winner, &0));
        assert_eq!(err, PayoutError::InvalidAmount);
    }

    // ── #1632 negative tests ─────────────────────────────────────────────────

    #[test]
    fn rejects_a_recipient_who_is_not_the_arena_winner() {
        let fx = setup(1_000);
        let winner = Address::generate(&fx.env);
        let attacker = Address::generate(&fx.env);
        let arena = fx.finished_arena(&winner, 500);

        let err = fx.err(fx.client.try_distribute_winnings(&arena, &attacker, &500));
        assert_eq!(err, PayoutError::NotArenaWinner);
        assert_eq!(fx.token.balance(&attacker), 0);
        assert!(!fx.client.is_paid(&fx.id(&arena, &attacker)));
    }

    #[test]
    fn rejects_an_amount_above_the_arena_prize() {
        let fx = setup(1_000);
        let winner = Address::generate(&fx.env);
        let arena = fx.finished_arena(&winner, 500);

        let err = fx.err(fx.client.try_distribute_winnings(&arena, &winner, &501));
        assert_eq!(err, PayoutError::ExceedsEntitlement);
        // Exactly the prize is fine.
        fx.client.distribute_winnings(&arena, &winner, &500);
        assert_eq!(fx.token.balance(&winner), 500);
    }

    #[test]
    fn rejects_an_arena_that_has_not_finished() {
        let fx = setup(1_000);
        let player = Address::generate(&fx.env);
        let arena = fx.arena_with(ArenaSettlement {
            finished: false,
            winner: None,
            prize: 500,
            stake_token: fx.token.address.clone(),
            pool_id: 0,
        });
        let err = fx.err(fx.client.try_distribute_winnings(&arena, &player, &100));
        assert_eq!(err, PayoutError::ArenaNotSettled);
    }

    #[test]
    fn rejects_an_arena_the_factory_does_not_know() {
        let fx = setup(1_000);
        let winner = Address::generate(&fx.env);
        // A look-alike contract reporting a settlement in the admin's favour,
        // claiming pool 1, which belongs to a different (genuine) arena.
        fx.finished_arena(&Address::generate(&fx.env), 500);
        let impostor = fx.env.register(MockArena, ());
        MockArenaClient::new(&fx.env, &impostor).set_settlement(&ArenaSettlement {
            finished: true,
            winner: Some(winner.clone()),
            prize: 1_000,
            stake_token: fx.token.address.clone(),
            pool_id: 1,
        });

        let err = fx.err(fx.client.try_distribute_winnings(&impostor, &winner, &1_000));
        assert_eq!(err, PayoutError::UnknownArena);

        // And one claiming a pool id the factory never issued.
        MockArenaClient::new(&fx.env, &impostor).set_settlement(&ArenaSettlement {
            finished: true,
            winner: Some(winner.clone()),
            prize: 1_000,
            stake_token: fx.token.address.clone(),
            pool_id: 999,
        });
        let err = fx.err(fx.client.try_distribute_winnings(&impostor, &winner, &1_000));
        assert_eq!(err, PayoutError::UnknownArena);
        assert_eq!(fx.token.balance(&winner), 0);
    }

    #[test]
    fn rejects_an_arena_from_older_wasm_without_settlement_reads() {
        let fx = setup(1_000);
        let winner = Address::generate(&fx.env);
        let legacy = fx.env.register(LegacyArena, ());
        MockFactoryClient::new(&fx.env, &fx.factory).register(&1, &legacy);

        let err = fx.err(fx.client.try_distribute_winnings(&legacy, &winner, &100));
        assert_eq!(err, PayoutError::ArenaSettlementUnavailable);

        // A plain account address is not an arena either.
        let not_a_contract = Address::generate(&fx.env);
        let err = fx.err(fx.client.try_distribute_winnings(&not_a_contract, &winner, &100));
        assert_eq!(err, PayoutError::ArenaSettlementUnavailable);
    }

    #[test]
    fn rejects_an_arena_prize_in_another_token() {
        let fx = setup(1_000);
        let winner = Address::generate(&fx.env);
        let arena = fx.arena_with(ArenaSettlement {
            finished: true,
            winner: Some(winner.clone()),
            prize: 500,
            stake_token: Address::generate(&fx.env),
            pool_id: 0,
        });
        let err = fx.err(fx.client.try_distribute_winnings(&arena, &winner, &100));
        assert_eq!(err, PayoutError::TokenMismatch);
    }

    #[test]
    fn rejects_a_payout_over_the_daily_cap() {
        let fx = setup(100_000);
        let w1 = Address::generate(&fx.env);
        let w2 = Address::generate(&fx.env);
        let a1 = fx.finished_arena(&w1, CAP);
        let a2 = fx.finished_arena(&w2, CAP);

        fx.client.distribute_winnings(&a1, &w1, &(CAP - 10));
        let err = fx.err(fx.client.try_distribute_winnings(&a2, &w2, &11));
        assert_eq!(err, PayoutError::DailyCapExceeded);
        assert!(!fx.client.is_paid(&fx.id(&a2, &w2)));

        // Exactly filling the cap is allowed.
        fx.client.distribute_winnings(&a2, &w2, &10);
        assert_eq!(fx.client.outflow_today(), CAP);
    }

    #[test]
    fn daily_cap_resets_on_the_next_day() {
        let fx = setup(100_000);
        let w1 = Address::generate(&fx.env);
        let w2 = Address::generate(&fx.env);
        let a1 = fx.finished_arena(&w1, CAP);
        let a2 = fx.finished_arena(&w2, CAP);

        fx.client.distribute_winnings(&a1, &w1, &CAP);
        fx.env.ledger().with_mut(|li| li.timestamp += SECONDS_PER_DAY);
        assert_eq!(fx.client.outflow_today(), 0);
        fx.client.distribute_winnings(&a2, &w2, &CAP);
        assert_eq!(fx.token.balance(&w2), CAP);
    }

    #[test]
    fn rejects_payout_beyond_contract_balance() {
        let fx = setup(100);
        let winner = Address::generate(&fx.env);
        let arena = fx.finished_arena(&winner, 500);
        let err = fx.err(fx.client.try_distribute_winnings(&arena, &winner, &101));
        assert_eq!(err, PayoutError::InsufficientBalance);
        assert!(!fx.client.is_paid(&fx.id(&arena, &winner)));
        assert_eq!(fx.client.outflow_today(), 0, "a failed payout must not consume the cap");
    }

    // ── Daily cap timelock ───────────────────────────────────────────────────

    #[test]
    fn lowering_the_cap_applies_immediately() {
        let fx = setup(0);
        fx.client.propose_daily_cap(&(CAP / 2));
        assert_eq!(fx.client.daily_cap(), Some(CAP / 2));
        assert_eq!(fx.client.pending_daily_cap(), None);
    }

    #[test]
    fn raising_the_cap_waits_for_the_timelock() {
        let fx = setup(100_000);
        let winner = Address::generate(&fx.env);
        let arena = fx.finished_arena(&winner, CAP * 2);

        fx.client.propose_daily_cap(&(CAP * 2));
        assert_eq!(fx.client.daily_cap(), Some(CAP), "an increase must not apply at once");
        let pending = fx.client.pending_daily_cap().expect("increase must be staged");
        assert_eq!(pending.cap, CAP * 2);

        // The higher cap cannot be used before it applies.
        let err = fx.err(fx.client.try_distribute_winnings(&arena, &winner, &(CAP * 2)));
        assert_eq!(err, PayoutError::DailyCapExceeded);

        let err = fx.err(fx.client.try_apply_daily_cap());
        assert_eq!(err, PayoutError::CapTimelockPending);

        fx.env.ledger().with_mut(|li| li.timestamp = pending.eta);
        fx.client.apply_daily_cap();
        assert_eq!(fx.client.daily_cap(), Some(CAP * 2));
        assert_eq!(fx.client.pending_daily_cap(), None);
        fx.client.distribute_winnings(&arena, &winner, &(CAP * 2));
    }

    #[test]
    fn a_staged_increase_can_be_cancelled_or_overridden_by_a_decrease() {
        let fx = setup(0);
        fx.client.propose_daily_cap(&(CAP * 3));
        fx.client.cancel_daily_cap();
        assert_eq!(fx.client.pending_daily_cap(), None);
        assert_eq!(fx.err(fx.client.try_apply_daily_cap()), PayoutError::NoPendingCap);

        fx.client.propose_daily_cap(&(CAP * 3));
        fx.client.propose_daily_cap(&(CAP - 1));
        assert_eq!(fx.client.pending_daily_cap(), None, "a decrease discards a staged increase");
        assert_eq!(fx.client.daily_cap(), Some(CAP - 1));
    }

    #[test]
    fn rejects_a_non_positive_cap() {
        let fx = setup(0);
        assert_eq!(fx.err(fx.client.try_propose_daily_cap(&0)), PayoutError::InvalidCap);
    }

    #[test]
    fn cap_changes_require_admin_auth() {
        let fx = setup(0);
        fx.env.set_auths(&[]);
        assert!(fx.client.try_propose_daily_cap(&1).is_err());
        assert!(fx.client.try_apply_daily_cap().is_err());
        assert!(fx.client.try_cancel_daily_cap().is_err());
        assert_eq!(fx.client.daily_cap(), Some(CAP));
    }

    // ── Batches ──────────────────────────────────────────────────────────────

    fn entry(arena: &Address, recipient: &Address, amount: i128) -> (Address, Address, i128) {
        (arena.clone(), recipient.clone(), amount)
    }

    #[test]
    fn distributes_a_batch_spanning_several_arenas() {
        let fx = setup(1_000);
        let a = Address::generate(&fx.env);
        let b = Address::generate(&fx.env);
        let arena_a = fx.finished_arena(&a, 300);
        let arena_b = fx.finished_arena(&b, 150);

        let mut batch = Vec::new(&fx.env);
        batch.push_back(entry(&arena_a, &a, 300));
        batch.push_back(entry(&arena_b, &b, 150));
        fx.client.distribute_batch(&batch);

        assert_eq!(fx.token.balance(&a), 300);
        assert_eq!(fx.token.balance(&b), 150);
        assert!(fx.client.is_paid(&fx.id(&arena_a, &a)));
        assert!(fx.client.is_paid(&fx.id(&arena_b, &b)));
        assert_eq!(fx.client.outflow_today(), 450);
    }

    #[test]
    fn a_batch_with_one_invalid_entry_pays_nobody() {
        let fx = setup(1_000);
        let a = Address::generate(&fx.env);
        let b = Address::generate(&fx.env);
        let arena_a = fx.finished_arena(&a, 300);
        let arena_b = fx.finished_arena(&b, 150);

        // Mixed arenas, where the second entry claims arena A's prize for b.
        let mut batch = Vec::new(&fx.env);
        batch.push_back(entry(&arena_b, &b, 150));
        batch.push_back(entry(&arena_a, &b, 300));
        assert_eq!(fx.err(fx.client.try_distribute_batch(&batch)), PayoutError::NotArenaWinner);
        assert_eq!(fx.token.balance(&a), 0);
        assert_eq!(fx.token.balance(&b), 0);
        assert!(!fx.client.is_paid(&fx.id(&arena_b, &b)));
        assert_eq!(fx.client.outflow_today(), 0);
    }

    #[test]
    fn a_batch_cannot_pay_the_same_arena_and_winner_twice() {
        let fx = setup(1_000);
        let a = Address::generate(&fx.env);
        let arena = fx.finished_arena(&a, 300);

        let mut batch = Vec::new(&fx.env);
        batch.push_back(entry(&arena, &a, 100));
        batch.push_back(entry(&arena, &a, 100));
        assert_eq!(fx.err(fx.client.try_distribute_batch(&batch)), PayoutError::DuplicateRecipient);
        assert_eq!(fx.token.balance(&a), 0);
    }

    #[test]
    fn a_batch_respects_the_daily_cap_as_a_whole() {
        let fx = setup(100_000);
        let a = Address::generate(&fx.env);
        let b = Address::generate(&fx.env);
        let arena_a = fx.finished_arena(&a, CAP);
        let arena_b = fx.finished_arena(&b, CAP);

        let mut batch = Vec::new(&fx.env);
        batch.push_back(entry(&arena_a, &a, CAP / 2 + 1));
        batch.push_back(entry(&arena_b, &b, CAP / 2));
        assert_eq!(fx.err(fx.client.try_distribute_batch(&batch)), PayoutError::DailyCapExceeded);
        assert_eq!(fx.token.balance(&a), 0);
    }

    #[test]
    fn a_batch_entry_already_paid_singly_is_rejected() {
        let fx = setup(1_000);
        let a = Address::generate(&fx.env);
        let arena = fx.finished_arena(&a, 300);
        fx.client.distribute_winnings(&arena, &a, &300);

        let mut batch = Vec::new(&fx.env);
        batch.push_back(entry(&arena, &a, 300));
        assert_eq!(fx.err(fx.client.try_distribute_batch(&batch)), PayoutError::AlreadyPaid);
        assert_eq!(fx.token.balance(&a), 300);
    }

    #[test]
    fn rejects_empty_batch() {
        let fx = setup(1_000);
        let batch: Vec<(Address, Address, i128)> = Vec::new(&fx.env);
        assert_eq!(fx.err(fx.client.try_distribute_batch(&batch)), PayoutError::EmptyBatch);
    }

    #[test]
    fn distribute_batch_is_atomic_when_balance_is_insufficient() {
        let fx = setup(100);
        let first = Address::generate(&fx.env);
        let second = Address::generate(&fx.env);
        let arena_1 = fx.finished_arena(&first, 60);
        let arena_2 = fx.finished_arena(&second, 60);
        let mut batch = Vec::new(&fx.env);
        batch.push_back(entry(&arena_1, &first, 60));
        batch.push_back(entry(&arena_2, &second, 60));

        assert_eq!(fx.err(fx.client.try_distribute_batch(&batch)), PayoutError::InsufficientBalance);
        assert_eq!(fx.token.balance(&first), 0);
        assert_eq!(fx.token.balance(&second), 0);
        assert!(!fx.client.is_paid(&fx.id(&arena_1, &first)));
    }

    #[test]
    fn distribute_batch_requires_admin_auth() {
        let fx = setup(1_000);
        let recipient = Address::generate(&fx.env);
        let arena = fx.finished_arena(&recipient, 100);
        let mut batch = Vec::new(&fx.env);
        batch.push_back(entry(&arena, &recipient, 100));
        fx.env.set_auths(&[]);

        assert!(fx.client.try_distribute_batch(&batch).is_err());
        assert_eq!(fx.token.balance(&recipient), 0);
        assert!(!fx.client.is_paid(&fx.id(&arena, &recipient)));
    }

    #[test]
    fn rejects_oversized_batch() {
        let fx = setup(100_000);
        let mut batch = Vec::new(&fx.env);
        for _ in 0..(MAX_BATCH_SIZE + 1) {
            let winner = Address::generate(&fx.env);
            let arena = fx.finished_arena(&winner, 1);
            batch.push_back(entry(&arena, &winner, 1));
        }
        assert_eq!(fx.err(fx.client.try_distribute_batch(&batch)), PayoutError::BatchTooLarge);
    }

    #[test]
    fn max_size_batch_succeeds() {
        let fx = setup(100_000);
        fx.env.cost_estimate().budget().reset_unlimited();
        let mut batch = Vec::new(&fx.env);
        for _ in 0..MAX_BATCH_SIZE {
            let winner = Address::generate(&fx.env);
            let arena = fx.finished_arena(&winner, 1);
            batch.push_back(entry(&arena, &winner, 1));
        }
        fx.client.distribute_batch(&batch);
        assert_eq!(fx.client.outflow_today(), i128::from(MAX_BATCH_SIZE));
    }

    // ── Initialisation ───────────────────────────────────────────────────────

    /// initialize() must require auth from the admin address; an unauthenticated
    /// caller cannot claim the admin role by frontrunning the deployment.
    #[test]
    fn initialize_attacker_without_auth_is_rejected() {
        let env = Env::default();
        let intended_admin = Address::generate(&env);
        let contract_id = env.register(PayoutContract, ());
        let client = PayoutContractClient::new(&env, &contract_id);

        env.set_auths(&[]);
        let result = client.try_initialize(
            &intended_admin,
            &Address::generate(&env),
            &Address::generate(&env),
            &CAP,
        );
        assert!(result.is_err(), "initialize() must reject a caller without admin auth");
        assert_eq!(client.admin(), None);
    }

    #[test]
    fn initialize_with_correct_admin_auth_succeeds() {
        let env = Env::default();
        env.mock_all_auths();
        let admin = Address::generate(&env);
        let token = Address::generate(&env);
        let factory = Address::generate(&env);
        let client = PayoutContractClient::new(&env, &env.register(PayoutContract, ()));

        client.initialize(&admin, &token, &factory, &CAP);
        assert_eq!(client.admin(), Some(admin));
        assert_eq!(client.token(), Some(token));
        assert_eq!(client.factory(), Some(factory));
        assert_eq!(client.daily_cap(), Some(CAP));
    }

    #[test]
    fn initialize_rejects_a_non_positive_cap_and_a_second_call() {
        let env = Env::default();
        env.mock_all_auths();
        let admin = Address::generate(&env);
        let client = PayoutContractClient::new(&env, &env.register(PayoutContract, ()));
        let (token, factory) = (Address::generate(&env), Address::generate(&env));

        let err = client.try_initialize(&admin, &token, &factory, &0).err().unwrap().unwrap();
        assert_eq!(err, PayoutError::InvalidCap);
        client.initialize(&admin, &token, &factory, &CAP);
        let err = client.try_initialize(&admin, &token, &factory, &CAP).err().unwrap().unwrap();
        assert_eq!(err, PayoutError::AlreadyInitialised);
    }

    #[test]
    fn distribute_before_initialise_fails() {
        let env = Env::default();
        env.mock_all_auths();
        let client = PayoutContractClient::new(&env, &env.register(PayoutContract, ()));
        let winner = Address::generate(&env);
        let err = client
            .try_distribute_winnings(&Address::generate(&env), &winner, &10)
            .err()
            .unwrap()
            .unwrap();
        assert_eq!(err, PayoutError::NotInitialised);
    }

    #[test]
    fn upgrade_requires_admin_auth() {
        let fx = setup(1_000);
        fx.env.set_auths(&[]);
        let wasm = BytesN::from_array(&fx.env, &[0u8; 32]);
        assert!(fx.client.try_upgrade(&wasm).is_err());
    }

    // ── Reentrancy ───────────────────────────────────────────────────────────

    /// A malicious token whose `transfer` callback reenters
    /// `distribute_batch`, attempting to replay the same payout and double-pay
    /// the recipient. It implements just enough of the SEP-41 surface
    /// (`balance` + `transfer`) for the payout contract to use it.
    #[contract]
    struct ReentrantToken;

    #[contractimpl]
    impl ReentrantToken {
        pub fn arm(env: Env, payout: Address, arena: Address, recipient: Address, amount: i128) {
            let s = env.storage().persistent();
            s.set(&symbol_short!("PAYOUT"), &payout);
            s.set(&symbol_short!("ARENA"), &arena);
            s.set(&symbol_short!("RECIP"), &recipient);
            s.set(&symbol_short!("AMT"), &amount);
            s.set(&symbol_short!("TCOUNT"), &0u32);
            s.set(&symbol_short!("ATTEMPT"), &false);
            s.set(&symbol_short!("BLOCKED"), &false);
        }

        pub fn transfer_count(env: Env) -> u32 {
            env.storage().persistent().get(&symbol_short!("TCOUNT")).unwrap_or(0)
        }

        pub fn reentry_blocked(env: Env) -> bool {
            env.storage().persistent().get(&symbol_short!("BLOCKED")).unwrap_or(false)
        }

        pub fn balance(_env: Env, _id: Address) -> i128 {
            1_000_000
        }

        pub fn transfer(env: Env, _from: Address, _to: Address, _amount: i128) {
            let s = env.storage().persistent();
            let count: u32 = s.get(&symbol_short!("TCOUNT")).unwrap_or(0);
            s.set(&symbol_short!("TCOUNT"), &(count + 1));

            let attempted: bool = s.get(&symbol_short!("ATTEMPT")).unwrap_or(false);
            if !attempted {
                s.set(&symbol_short!("ATTEMPT"), &true);
                let payout: Address = s.get(&symbol_short!("PAYOUT")).unwrap();
                let arena: Address = s.get(&symbol_short!("ARENA")).unwrap();
                let recipient: Address = s.get(&symbol_short!("RECIP")).unwrap();
                let amount: i128 = s.get(&symbol_short!("AMT")).unwrap();

                let mut batch = Vec::new(&env);
                batch.push_back((arena, recipient, amount));
                let res = PayoutContractClient::new(&env, &payout).try_distribute_batch(&batch);
                s.set(&symbol_short!("BLOCKED"), &res.is_err());
            }
        }
    }

    /// Because ids are recorded before any transfer (checks-effects-
    /// interactions), a token that re-enters `distribute_batch` from its
    /// transfer callback cannot replay the payout (#968).
    #[test]
    fn distribute_batch_blocks_reentrant_token() {
        let env = Env::default();
        env.mock_all_auths();

        let admin = Address::generate(&env);
        let recipient = Address::generate(&env);
        let token_addr = env.register(ReentrantToken, ());
        let token = ReentrantTokenClient::new(&env, &token_addr);
        let factory = env.register(MockFactory, ());

        let arena = env.register(MockArena, ());
        MockArenaClient::new(&env, &arena).set_settlement(&ArenaSettlement {
            finished: true,
            winner: Some(recipient.clone()),
            prize: 100,
            stake_token: token_addr.clone(),
            pool_id: 1,
        });
        MockFactoryClient::new(&env, &factory).register(&1, &arena);

        let payout_addr = env.register(PayoutContract, ());
        let payout = PayoutContractClient::new(&env, &payout_addr);
        payout.initialize(&admin, &token_addr, &factory, &CAP);
        token.arm(&payout_addr, &arena, &recipient, &100i128);

        let mut batch = Vec::new(&env);
        batch.push_back((arena.clone(), recipient.clone(), 100i128));
        payout.distribute_batch(&batch);

        assert!(token.reentry_blocked(), "reentrant replay must be rejected");
        assert_eq!(token.transfer_count(), 1, "recipient must be paid exactly once");
        assert!(payout.is_paid(&payout.payout_id(&arena, &recipient)));
    }

    // ── Admin rotation ───────────────────────────────────────────────────────

    #[test]
    fn propose_and_accept_admin_rotates_admin() {
        let fx = setup(1_000);
        let new_admin = Address::generate(&fx.env);
        fx.client.propose_admin(&new_admin);
        fx.client.accept_admin();
        assert_eq!(fx.client.admin(), Some(new_admin));
    }

    #[test]
    fn accept_admin_without_proposal_fails() {
        let fx = setup(1_000);
        assert_eq!(fx.err(fx.client.try_accept_admin()), PayoutError::NoPendingAdmin);
    }

    #[test]
    fn propose_admin_requires_current_admin_auth() {
        let fx = setup(1_000);
        let new_admin = Address::generate(&fx.env);
        fx.env.set_auths(&[]);
        assert!(fx.client.try_propose_admin(&new_admin).is_err());
    }

    #[test]
    fn second_propose_overwrites_first() {
        let fx = setup(1_000);
        let addr_a = Address::generate(&fx.env);
        let addr_b = Address::generate(&fx.env);
        fx.client.propose_admin(&addr_a);
        fx.client.propose_admin(&addr_b);
        fx.client.accept_admin();
        assert_eq!(fx.client.admin(), Some(addr_b));
    }
}
