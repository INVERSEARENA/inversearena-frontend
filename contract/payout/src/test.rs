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
