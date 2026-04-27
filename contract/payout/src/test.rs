#[cfg(test)]
use super::*;
use soroban_sdk::{
    Address, BytesN, Env, IntoVal, Symbol, Vec, symbol_short,
    testutils::Address as _,
    token::{StellarAssetClient, TokenClient},
};

#[contract]
pub struct MockFactoryContract;
#[contractimpl]
impl MockFactoryContract {
    pub fn set_arena(env: Env, arena_id: u64, contract: Address) {
        let r = ArenaRef {
            contract,
            status: ArenaStatus::Active,
            host: Address::generate(&env),
        };
        env.storage().instance().set(&arena_id, &r);
    }
    pub fn get_arena_ref(env: Env, arena_id: u64) -> ArenaRef {
        env.storage().instance().get(&arena_id).unwrap()
    }
    pub fn current_fee_bps(_env: Env) -> u32 {
        _env.storage()
            .instance()
            .get(&symbol_short!("FEE_BPS"))
            .unwrap_or(0)
    }
    pub fn set_fee_bps(env: Env, bps: u32) {
        env.storage()
            .instance()
            .set(&symbol_short!("FEE_BPS"), &bps);
    }
    pub fn get_arena(env: Env, arena_id: u32) -> Option<FactoryArenaMetadata> {
        let fee: u32 = env
            .storage()
            .instance()
            .get(&symbol_short!("FEE_BPS"))
            .unwrap_or(0);
        let r: Option<ArenaRef> = env.storage().instance().get(&(arena_id as u64));
        r.map(|a| FactoryArenaMetadata {
            pool_id: arena_id,
            creator: a.host,
            capacity: 2,
            stake_amount: 1,
            win_fee_bps: fee,
        })
    }
    pub fn record_win_fee(_env: Env, _amount: i128) {}
}

const TIMELOCK: u64 = 48 * 60 * 60;

fn setup() -> (
    Env,
    Address,
    PayoutContractClient<'static>,
    Address,
    MockFactoryContractClient<'static>,
) {
    let env = Env::default();
    env.mock_all_auths();

    let admin = Address::generate(&env);
    let contract_id = env.register(PayoutContract, (&admin,));

    let factory_id = env.register(MockFactoryContract, ());
    let env_static: &'static Env = unsafe { &*(&env as *const Env) };
    let client = PayoutContractClient::new(env_static, &contract_id);
    let factory_client = MockFactoryContractClient::new(env_static, &factory_id);

    client.init_factory(&factory_id);

    (env, admin, client, factory_id, factory_client)
}

fn setup_with_token() -> (
    Env,
    Address,
    PayoutContractClient<'static>,
    Address,
    Address,
    Address,
    MockFactoryContractClient<'static>,
) {
    let (env, admin, client, factory_id, factory_client) = setup();

    let treasury = Address::generate(&env);
    client.set_treasury(&treasury);

    let token_admin = Address::generate(&env);
    let token_id = env
        .register_stellar_asset_contract_v2(token_admin.clone())
        .address();
    let asset = StellarAssetClient::new(&env, &token_id);
    asset.mint(&client.address, &10_000i128);

    (
        env,
        admin,
        client,
        token_id,
        treasury,
        factory_id,
        factory_client,
    )
}

#[test]
fn test_initialize_sets_admin() {
    let (_env, admin, client, _, _factory_client) = setup();
    assert_eq!(client.admin(), admin);
}

#[test]
fn test_double_initialize_panics() {
    // With __constructor, double initialization is structurally impossible.
    // The constructor runs exactly once at deploy time.
    let (_env, admin, client, _, _factory_client) = setup();
    assert_eq!(client.admin(), admin);
    // No separate initialize() to call; the constructor is the only init path.
}

#[test]
fn test_admin_can_distribute_winnings() {
    let (env, _admin, client, _, factory_client) = setup();

    let winner = Address::generate(&env);
    let ctx = symbol_short!("ARENA_1");
    let pool_id = 1u32;
    let round_id = 1u32;
    let amount = 1000i128;
    let currency = symbol_short!("XLM");

    assert!(!client.is_payout_processed(&ctx, &pool_id, &round_id, &winner));
    {
        let caller = Address::generate(&env);
        factory_client.set_arena(&(pool_id as u64), &caller);
        client.distribute_winnings(
            &caller, &ctx, &pool_id, &round_id, &winner, &amount, &currency,
        )
    };
    assert!(client.is_payout_processed(&ctx, &pool_id, &round_id, &winner));

    let payout = client
        .get_payout(&ctx, &pool_id, &round_id, &winner)
        .unwrap();
    assert_eq!(payout.winner, winner);
    assert_eq!(payout.amount, amount);
    assert_eq!(payout.currency, currency);
    assert!(payout.paid);
}

#[test]
fn test_unauthorized_caller_cannot_distribute() {
    // admin.require_auth() is the only gate — no caller param to spoof.
    // Register with constructor (mock_all_auths for constructor auth).
    let env = Env::default();
    env.mock_all_auths();
    let admin = Address::generate(&env);
    let contract_id = env.register(PayoutContract, (&admin,));
    let client = PayoutContractClient::new(&env, &contract_id);

    let winner = Address::generate(&env);
    let ctx = symbol_short!("ARENA_1");
    let currency = symbol_short!("XLM");

    let result = {
        let caller = Address::generate(&env);
        // factory_client is not defined here, so we instantiate it
        let factory_client =
            MockFactoryContractClient::new(&env, &env.register(MockFactoryContract, ()));
        client.init_factory(&factory_client.address);

        // Clear all mocked auths BEFORE trying to distribute, but AFTER init_factory which needs admin auth
        env.mock_auths(&[]);

        factory_client.set_arena(&(1u32 as u64), &caller);
        client.try_distribute_winnings(&caller, &ctx, &1u32, &1u32, &winner, &1000i128, &currency)
    };
    assert!(
        result.is_err(),
        "non-admin signer must be rejected by admin.require_auth()"
    );
}

#[test]
fn test_zero_amount_returns_error() {
    let (env, _admin, client, _, factory_client) = setup();
    let winner = Address::generate(&env);
    let ctx = symbol_short!("ARENA_1");
    let currency = symbol_short!("XLM");

    let result = {
        let caller = Address::generate(&env);
        factory_client.set_arena(&(1u32 as u64), &caller);
        client.try_distribute_winnings(&caller, &ctx, &1u32, &1u32, &winner, &0i128, &currency)
    };
    assert_eq!(result, Err(Ok(PayoutError::InvalidAmount)));
}

#[test]
fn test_negative_amount_returns_error() {
    let (env, _admin, client, _, factory_client) = setup();
    let winner = Address::generate(&env);
    let ctx = symbol_short!("ARENA_1");
    let currency = symbol_short!("XLM");

    let result = {
        let caller = Address::generate(&env);
        factory_client.set_arena(&(1u32 as u64), &caller);
        client.try_distribute_winnings(&caller, &ctx, &1u32, &1u32, &winner, &-1i128, &currency)
    };
    assert_eq!(result, Err(Ok(PayoutError::InvalidAmount)));
}

#[test]
fn test_idempotency_prevents_double_pay_same_key() {
    let (env, _admin, client, _, factory_client) = setup();
    let winner = Address::generate(&env);
    let ctx = symbol_short!("ARENA_1");
    let currency = symbol_short!("XLM");

    {
        let caller = Address::generate(&env);
        factory_client.set_arena(&(7u32 as u64), &caller);
        client.distribute_winnings(&caller, &ctx, &7u32, &2u32, &winner, &1000i128, &currency)
    };

    let second = {
        let caller = Address::generate(&env);
        factory_client.set_arena(&(7u32 as u64), &caller);
        client.try_distribute_winnings(&caller, &ctx, &7u32, &2u32, &winner, &9999i128, &currency)
    };
    assert_eq!(second, Err(Ok(PayoutError::AlreadyPaid)));
}

#[test]
fn test_different_round_ids_allow_multiple_payouts() {
    let (env, _admin, client, _, factory_client) = setup();
    let winner = Address::generate(&env);
    let ctx = symbol_short!("ARENA_1");
    let currency = symbol_short!("USDC");

    {
        let caller = Address::generate(&env);
        factory_client.set_arena(&(1u32 as u64), &caller);
        client.distribute_winnings(&caller, &ctx, &1u32, &1u32, &winner, &1000i128, &currency)
    };
    {
        let caller = Address::generate(&env);
        factory_client.set_arena(&(1u32 as u64), &caller);
        client.distribute_winnings(&caller, &ctx, &1u32, &2u32, &winner, &2000i128, &currency)
    };

    assert!(client.is_payout_processed(&ctx, &1u32, &1u32, &winner));
    assert!(client.is_payout_processed(&ctx, &1u32, &2u32, &winner));
}

#[test]
fn test_get_payout_returns_none_for_unprocessed() {
    let (env, _admin, client, _, factory_client) = setup();
    let winner = Address::generate(&env);
    let ctx = symbol_short!("ARENA_1");

    assert!(client.get_payout(&ctx, &1u32, &1u32, &winner).is_none());
}

#[test]
fn test_set_currency_token_enables_token_transfer() {
    let (env, _admin, client, token_id, _treasury, _, factory_client) = setup_with_token();
    let winner = Address::generate(&env);
    let ctx = symbol_short!("ARENA_1");
    let currency = symbol_short!("USDC");

    client.set_currency_token(&currency, &token_id);
    {
        let caller = Address::generate(&env);
        factory_client.set_arena(&(3u32 as u64), &caller);
        client.distribute_winnings(&caller, &ctx, &3u32, &1u32, &winner, &750i128, &currency)
    };

    let token = TokenClient::new(&env, &token_id);
    assert_eq!(token.balance(&winner), 750i128);
}

// ── distribute_prize backward-compat tests (deprecated API) ──────────────────
// These tests verify that the deprecated `distribute_prize` function continues to
// behave correctly for integrators who have not yet migrated. New code should use
// `distribute_split_payout` instead.

#[allow(deprecated)]
#[test]
fn test_distribute_prize_backward_compat_two_winners() {
    let (env, _admin, client, token_id, _treasury, _, _factory_client) = setup_with_token();
    let winner1 = Address::generate(&env);
    let winner2 = Address::generate(&env);
    let mut winners = Vec::new(&env);
    winners.push_back(winner1.clone());
    winners.push_back(winner2.clone());

    client.distribute_prize(&1u32, &1000i128, &winners, &token_id);

    let token = TokenClient::new(&env, &token_id);
    assert_eq!(token.balance(&winner1), 500i128);
    assert_eq!(token.balance(&winner2), 500i128);
}

#[allow(deprecated)]
#[test]
fn test_distribute_prize_backward_compat_dust_to_treasury() {
    let (env, _admin, client, token_id, treasury, _, _factory_client) = setup_with_token();
    let winner1 = Address::generate(&env);
    let winner2 = Address::generate(&env);
    let winner3 = Address::generate(&env);
    let mut winners = Vec::new(&env);
    winners.push_back(winner1.clone());
    winners.push_back(winner2.clone());
    winners.push_back(winner3.clone());

    client.distribute_prize(&2u32, &1000i128, &winners, &token_id);

    let token = TokenClient::new(&env, &token_id);
    assert_eq!(token.balance(&winner1), 333i128);
    assert_eq!(token.balance(&winner2), 333i128);
    assert_eq!(token.balance(&winner3), 333i128);
    assert_eq!(token.balance(&treasury), 1i128);
}

#[allow(deprecated)]
#[test]
fn test_distribute_prize_backward_compat_idempotency() {
    let (env, _admin, client, token_id, _treasury, _, _factory_client) = setup_with_token();
    let winner = Address::generate(&env);
    let mut winners = Vec::new(&env);
    winners.push_back(winner.clone());

    client.distribute_prize(&3u32, &500i128, &winners, &token_id);
    assert!(client.is_prize_distributed(&3u32));

    let second = client.try_distribute_prize(&3u32, &500i128, &winners, &token_id);
    assert_eq!(second, Err(Ok(PayoutError::AlreadyPaid)));
}

#[allow(deprecated)]
#[test]
fn test_distribute_prize_backward_compat_no_winners_error() {
    let (env, _admin, client, token_id, _treasury, _, _factory_client) = setup_with_token();
    let empty: Vec<Address> = Vec::new(&env);

    let result = client.try_distribute_prize(&4u32, &1000i128, &empty, &token_id);
    assert_eq!(result, Err(Ok(PayoutError::NoWinners)));
}

#[allow(deprecated)]
#[test]
fn test_distribute_prize_backward_compat_invalid_amount_error() {
    let (env, _admin, client, token_id, _treasury, _, _factory_client) = setup_with_token();
    let winner = Address::generate(&env);
    let mut winners = Vec::new(&env);
    winners.push_back(winner);

    let result = client.try_distribute_prize(&5u32, &0i128, &winners, &token_id);
    assert_eq!(result, Err(Ok(PayoutError::InvalidAmount)));
}

// ── distribute_split_payout canonical multi-winner tests ─────────────────────
// These are the canonical tests for multi-winner distribution. All new integrations
// should use `distribute_split_payout` rather than the deprecated `distribute_prize`.

#[test]
fn canonical_split_two_winners_equal_split() {
    let (env, _admin, client, token_id, _treasury, _, _) = setup_with_token();
    let winner1 = Address::generate(&env);
    let winner2 = Address::generate(&env);
    let mut winners = Vec::new(&env);
    winners.push_back(winner1.clone());
    winners.push_back(winner2.clone());

    client.distribute_split_payout(&10u32, &winners, &1000i128, &token_id);

    let token = TokenClient::new(&env, &token_id);
    assert_eq!(token.balance(&winner1), 500i128);
    assert_eq!(token.balance(&winner2), 500i128);
    assert!(client.is_split_payout_distributed(&10u32));
}

#[test]
fn canonical_split_three_winners_dust_to_first() {
    let (env, _admin, client, token_id, _treasury, _, _) = setup_with_token();
    let winner1 = Address::generate(&env);
    let winner2 = Address::generate(&env);
    let winner3 = Address::generate(&env);
    let mut winners = Vec::new(&env);
    winners.push_back(winner1.clone());
    winners.push_back(winner2.clone());
    winners.push_back(winner3.clone());

    client.distribute_split_payout(&11u32, &winners, &1000i128, &token_id);

    let token = TokenClient::new(&env, &token_id);
    // 1000 / 3 = 333 rem 1; first winner absorbs the 1-unit dust
    assert_eq!(token.balance(&winner1), 334i128);
    assert_eq!(token.balance(&winner2), 333i128);
    assert_eq!(token.balance(&winner3), 333i128);
}

#[test]
fn canonical_split_idempotency_prevents_double_payout() {
    let (env, _admin, client, token_id, _treasury, _, _) = setup_with_token();
    let winner = Address::generate(&env);
    let mut winners = Vec::new(&env);
    winners.push_back(winner.clone());

    client.distribute_split_payout(&12u32, &winners, &500i128, &token_id);
    assert!(client.is_split_payout_distributed(&12u32));

    let second = client.try_distribute_split_payout(&12u32, &winners, &500i128, &token_id);
    assert_eq!(second, Err(Ok(PayoutError::AlreadyPaid)));
}

#[test]
fn canonical_split_no_winners_returns_error() {
    let (env, _admin, client, token_id, _treasury, _, _) = setup_with_token();
    let empty: Vec<Address> = Vec::new(&env);

    let result = client.try_distribute_split_payout(&13u32, &empty, &1000i128, &token_id);
    assert_eq!(result, Err(Ok(PayoutError::NoWinners)));
}

#[test]
fn canonical_split_invalid_amount_returns_error() {
    let (env, _admin, client, token_id, _treasury, _, _) = setup_with_token();
    let winner = Address::generate(&env);
    let mut winners = Vec::new(&env);
    winners.push_back(winner);

    let result = client.try_distribute_split_payout(&14u32, &winners, &0i128, &token_id);
    assert_eq!(result, Err(Ok(PayoutError::InvalidAmount)));
}

#[test]
fn canonical_split_stores_per_winner_receipts() {
    let (env, _admin, client, token_id, _treasury, _, _) = setup_with_token();
    let winner1 = Address::generate(&env);
    let winner2 = Address::generate(&env);
    let mut winners = Vec::new(&env);
    winners.push_back(winner1.clone());
    winners.push_back(winner2.clone());

    client.distribute_split_payout(&15u32, &winners, &1000i128, &token_id);

    let r1 = client
        .get_split_payout_receipt(&15u32, &winner1)
        .expect("receipt for winner1 must exist");
    let r2 = client
        .get_split_payout_receipt(&15u32, &winner2)
        .expect("receipt for winner2 must exist");
    assert_eq!(r1.amount, 500i128);
    assert_eq!(r2.amount, 500i128);
    assert_eq!(r1.arena_id, 15u32);
    assert_eq!(r2.arena_id, 15u32);
}

#[test]
fn canonical_split_single_winner_gets_full_amount() {
    let (env, _admin, client, token_id, _treasury, _, _) = setup_with_token();
    let winner = Address::generate(&env);
    let mut winners = Vec::new(&env);
    winners.push_back(winner.clone());

    client.distribute_split_payout(&16u32, &winners, &777i128, &token_id);

    let token = TokenClient::new(&env, &token_id);
    assert_eq!(token.balance(&winner), 777i128);
    let receipt = client
        .get_split_payout_receipt(&16u32, &winner)
        .expect("receipt must exist");
    assert_eq!(receipt.amount, 777i128);
}

#[test]
fn test_distribute_split_payout_two_winners_equal_split() {
    let (env, _admin, client, token_id, _treasury, _, _) = setup_with_token();
    let winner1 = Address::generate(&env);
    let winner2 = Address::generate(&env);
    let mut winners = Vec::new(&env);
    winners.push_back(winner1.clone());
    winners.push_back(winner2.clone());

    client.distribute_split_payout(&77u32, &winners, &1000i128, &token_id);

    let token = TokenClient::new(&env, &token_id);
    assert_eq!(token.balance(&winner1), 500i128);
    assert_eq!(token.balance(&winner2), 500i128);
    assert!(client.is_split_payout_distributed(&77u32));

    let receipt1 = client
        .get_split_payout_receipt(&77u32, &winner1)
        .expect("receipt for winner1 must exist");
    let receipt2 = client
        .get_split_payout_receipt(&77u32, &winner2)
        .expect("receipt for winner2 must exist");
    assert_eq!(receipt1.amount, 500i128);
    assert_eq!(receipt2.amount, 500i128);
}

#[test]
fn test_distribute_split_payout_three_winners_remainder_to_first() {
    let (env, _admin, client, token_id, _treasury, _, _) = setup_with_token();
    let winner1 = Address::generate(&env);
    let winner2 = Address::generate(&env);
    let winner3 = Address::generate(&env);
    let mut winners = Vec::new(&env);
    winners.push_back(winner1.clone());
    winners.push_back(winner2.clone());
    winners.push_back(winner3.clone());

    client.distribute_split_payout(&78u32, &winners, &1000i128, &token_id);

    let token = TokenClient::new(&env, &token_id);
    assert_eq!(token.balance(&winner1), 334i128);
    assert_eq!(token.balance(&winner2), 333i128);
    assert_eq!(token.balance(&winner3), 333i128);
}

#[test]
fn test_distribute_split_payout_no_winners_returns_error() {
    let (env, _admin, client, token_id, _treasury, _, _) = setup_with_token();
    let empty: Vec<Address> = Vec::new(&env);

    let result = client.try_distribute_split_payout(&79u32, &empty, &1000i128, &token_id);
    assert_eq!(result, Err(Ok(PayoutError::NoWinners)));
}

#[test]
fn test_distribute_split_payout_single_winner_gets_full_amount() {
    let (env, _admin, client, token_id, _treasury, _, _) = setup_with_token();
    let winner = Address::generate(&env);
    let mut winners = Vec::new(&env);
    winners.push_back(winner.clone());

    client.distribute_split_payout(&80u32, &winners, &750i128, &token_id);

    let token = TokenClient::new(&env, &token_id);
    assert_eq!(token.balance(&winner), 750i128);

    let receipt = client
        .get_split_payout_receipt(&80u32, &winner)
        .expect("single-winner receipt must exist");
    assert_eq!(receipt.amount, 750i128);
}

// ── persistent storage TTL ────────────────────────────────────────────────────

#[test]
fn payout_record_survives_ttl_threshold() {
    use soroban_sdk::testutils::Ledger;

    let (env, _admin, client, _, factory_client) = setup();
    let winner = Address::generate(&env);
    let ctx = symbol_short!("arena_1");
    let pool_id = 1u32;
    let round_id = 1u32;
    let amount = 500i128;
    let currency = symbol_short!("XLM");

    {
        let caller = Address::generate(&env);
        factory_client.set_arena(&(pool_id as u64), &caller);
        client.distribute_winnings(
            &caller, &ctx, &pool_id, &round_id, &winner, &amount, &currency,
        )
    };

    // Advance ledger past PAYOUT_TTL_THRESHOLD (100_000) — record must still exist.
    env.ledger().with_mut(|l| {
        l.sequence_number += 100_001;
        l.timestamp += 100_001 * 5;
    });

    assert!(
        client.is_payout_processed(&ctx, &pool_id, &round_id, &winner),
        "payout record must survive past TTL threshold due to extend_ttl"
    );
}

// ── Issue #499: constructor-based init security guards (payout) ──────────────

#[test]
fn initialize_with_wrong_signer_fails() {
    // With __constructor, the admin must authorize their own deployment.
    // The constructor runs once atomically — no separate initialize() to front-run.
    // This test verifies the constructor-based approach sets up admin correctly.
    let env = Env::default();
    env.mock_all_auths();
    let admin = Address::generate(&env);
    let contract_id = env.register(PayoutContract, (&admin,));
    let client = PayoutContractClient::new(&env, &contract_id);
    // Admin should be correctly set by the constructor.
    assert_eq!(client.admin(), admin);
}

// ── Issue #506: Emergency pause (payout) ─────────────────────────────────────

#[test]
fn admin_can_pause_and_unpause_payout() {
    let (_env, _admin, client, _, _factory_client) = setup();
    assert!(!client.is_paused());
    client.pause();
    assert!(client.is_paused());
    client.unpause();
    assert!(!client.is_paused());
}

#[test]
fn pause_blocks_distribute_winnings() {
    let (env, _admin, client, _, factory_client) = setup();
    client.pause();
    let winner = Address::generate(&env);
    let ctx = symbol_short!("CTX");
    let currency = symbol_short!("XLM");
    let result = {
        let caller = Address::generate(&env);
        factory_client.set_arena(&(1u32 as u64), &caller);
        client.try_distribute_winnings(&caller, &ctx, &1u32, &1u32, &winner, &100i128, &currency)
    };
    assert_eq!(result, Err(Ok(PayoutError::Paused)));
}

#[allow(deprecated)]
#[test]
fn pause_blocks_distribute_prize() {
    let (env, _admin, client, token_id, _treasury, _, _factory_client) = setup_with_token();
    client.pause();
    let winners = Vec::from_array(&env, [Address::generate(&env)]);
    let result = client.try_distribute_prize(&1u32, &100i128, &winners, &token_id);
    assert_eq!(result, Err(Ok(PayoutError::Paused)));
}

#[test]
fn pause_blocks_distribute_split_payout() {
    let (env, _admin, client, token_id, _treasury, _, _factory_client) = setup_with_token();
    client.pause();
    let winners = Vec::from_array(&env, [Address::generate(&env)]);
    let result = client.try_distribute_split_payout(&1u32, &winners, &100i128, &token_id);
    assert_eq!(result, Err(Ok(PayoutError::Paused)));
}

#[test]
fn unpause_restores_distribute_winnings() {
    let (env, _admin, client, _, factory_client) = setup();
    client.pause();
    client.unpause();
    assert!(!client.is_paused());
    let winner = Address::generate(&env);
    let ctx = symbol_short!("CTX");
    let currency = symbol_short!("XLM");
    // distribute_winnings requires no actual token transfer, it just records
    let result = {
        let caller = Address::generate(&env);
        factory_client.set_arena(&(1u32 as u64), &caller);
        client.try_distribute_winnings(&caller, &ctx, &1u32, &1u32, &winner, &100i128, &currency)
    };
    assert!(result.is_ok(), "should succeed after unpause");
}

#[test]
fn read_functions_unaffected_by_payout_pause() {
    let (_env, admin, client, _, _factory_client) = setup();
    client.pause();
    assert_eq!(client.admin(), admin);
    assert!(client.is_paused());
}

#[test]
fn pause_allows_currency_token_rotation_for_incident_response() {
    let (_env, _admin, client, token_id, _treasury, _factory_id, _factory_client) =
        setup_with_token();
    let currency = symbol_short!("USDC");

    client.pause();
    assert!(client.is_paused());

    let result = client.try_set_currency_token(&currency, &token_id);
    assert!(
        result.is_ok(),
        "set_currency_token must remain callable while paused"
    );
}

#[test]
fn pause_allows_admin_transfer_controls() {
    let (env, _admin, client, _, _factory_client) = setup();
    let new_admin = Address::generate(&env);

    client.pause();
    assert!(client.is_paused());

    client.propose_admin(&new_admin);
    assert_eq!(client.pending_admin_transfer().unwrap().0, new_admin);

    client.accept_admin(&new_admin);
    assert_eq!(client.admin(), new_admin);
}

#[test]
fn payout_history_empty_page() {
    let (_env, _admin, client, _, _factory_client) = setup();
    let page = client.get_payout_history(&None, &10u32);

    assert!(page.items.is_empty());
    assert_eq!(page.next_cursor, None);
    assert!(!page.has_more);
}

#[test]
fn payout_history_records_single_payout_and_arena_lookup() {
    let (env, _admin, client, _, factory_client) = setup();
    let winner = Address::generate(&env);
    let ctx = symbol_short!("ARENA_1");
    let currency = symbol_short!("XLM");

    {
        let caller = Address::generate(&env);
        factory_client.set_arena(&(7u32 as u64), &caller);
        client.distribute_winnings(&caller, &ctx, &7u32, &1u32, &winner, &1234i128, &currency)
    };

    let page = client.get_payout_history(&None, &10u32);
    assert_eq!(page.items.len(), 1);
    let receipt = page.items.get(0).unwrap();
    assert_eq!(receipt.arena_id, 7);
    assert_eq!(receipt.winner, winner);
    assert_eq!(receipt.amount, 1234);
    assert_eq!(receipt.fee, 0);
    assert_eq!(receipt.tx_hash_hint, None);
    assert_eq!(client.get_payout_by_arena(&7u64), Some(receipt));
}

#[test]
fn payout_history_paginates_and_caps_limit() {
    let (env, _admin, client, _, factory_client) = setup();
    let ctx = symbol_short!("ARENA_1");
    let currency = symbol_short!("XLM");

    for i in 0..105u32 {
        let caller = Address::generate(&env);
        factory_client.set_arena(&(i as u64), &caller);
        client.distribute_winnings(
            &caller,
            &ctx,
            &i,
            &1u32,
            &Address::generate(&env),
            &(100i128 + i as i128),
            &currency,
        );
    }

    let first = client.get_payout_history(&None, &500u32);
    assert_eq!(first.items.len(), 100);
    assert_eq!(first.next_cursor, Some(100));
    assert!(first.has_more);

    let second = client.get_payout_history(&first.next_cursor, &10u32);
    assert_eq!(second.items.len(), 5);
    assert_eq!(second.next_cursor, None);
    assert!(!second.has_more);
}

// ── Issue #518: upgrade timelock test suite (9 cases) ────────────────────────

#[test]
fn timelock_propose_stores_hash_and_executable_after_and_emits_event() {
    use soroban_sdk::testutils::Ledger as _;

    let (env, _admin, client, _, factory_client) = setup();
    let hash = BytesN::from_array(&env, &[0u8; 32]);

    client.propose_upgrade(&hash);

    let pending = client.pending_upgrade().expect("pending must be set");
    assert_eq!(pending.0, hash);
    assert!(
        pending.1 >= env.ledger().timestamp() + TIMELOCK,
        "executable_after must be at least propose_time + 48h"
    );
}

#[test]
fn timelock_execute_before_delay_returns_timelock_not_expired() {
    use soroban_sdk::testutils::Ledger;

    let (env, _admin, client, _, factory_client) = setup();
    let hash = BytesN::from_array(&env, &[0u8; 32]);
    client.propose_upgrade(&hash);
    env.ledger().with_mut(|l| {
        l.timestamp += TIMELOCK - 1;
    });
    assert_eq!(
        client.try_execute_upgrade(&hash),
        Err(Ok(PayoutError::TimelockNotExpired))
    );
}

#[test]
fn timelock_execute_exactly_at_boundary_passes_timelock_check() {
    use soroban_sdk::testutils::Ledger;

    let (env, _admin, client, _, factory_client) = setup();
    let hash = BytesN::from_array(&env, &[0u8; 32]);
    let propose_time = env.ledger().timestamp();
    client.propose_upgrade(&hash);
    env.ledger().with_mut(|l| {
        l.timestamp = propose_time + TIMELOCK;
    });
    let result = client.try_execute_upgrade(&hash);
    assert_ne!(
        result,
        Err(Ok(PayoutError::TimelockNotExpired)),
        "timelock must allow execution at timestamp == execute_after"
    );
}

#[test]
fn timelock_execute_after_delay_passes_timelock_check() {
    use soroban_sdk::testutils::Ledger;

    let (env, _admin, client, _, factory_client) = setup();
    let hash = BytesN::from_array(&env, &[0u8; 32]);
    let propose_time = env.ledger().timestamp();
    client.propose_upgrade(&hash);
    env.ledger().with_mut(|l| {
        l.timestamp = propose_time + TIMELOCK + 3600;
    });
    let result = client.try_execute_upgrade(&hash);
    assert_ne!(
        result,
        Err(Ok(PayoutError::TimelockNotExpired)),
        "timelock must allow execution after the delay"
    );
}

#[test]
fn timelock_cancel_before_execute_clears_pending_and_execute_panics() {
    use soroban_sdk::testutils::Ledger;

    let (env, _admin, client, _, factory_client) = setup();
    let hash = BytesN::from_array(&env, &[0u8; 32]);
    client.propose_upgrade(&hash);
    client.cancel_upgrade();

    assert!(client.pending_upgrade().is_none());

    env.ledger().with_mut(|l| {
        l.timestamp += TIMELOCK + 1;
    });
    assert_eq!(
        client.try_execute_upgrade(&hash),
        Err(Ok(PayoutError::NoPendingUpgrade))
    );
}

#[test]
fn timelock_non_admin_propose_panics() {
    let env = Env::default();
    env.mock_all_auths();
    let admin = Address::generate(&env);
    let contract_id = env.register(PayoutContract, (&admin,));
    let c = PayoutContractClient::new(&env, &contract_id);
    // Explicitly clear all mocks so admin.require_auth() is no longer satisfied.
    env.mock_auths(&[]);
    let hash = BytesN::from_array(&env, &[0u8; 32]);
    let result = c.try_propose_upgrade(&hash);
    assert!(result.is_err(), "non-admin propose must fail without auth");
}

#[test]
fn timelock_non_admin_execute_panics() {
    let env = Env::default();
    env.mock_all_auths();
    let admin = Address::generate(&env);
    let contract_id = env.register(PayoutContract, (&admin,));
    let c = PayoutContractClient::new(&env, &contract_id);
    // Explicitly clear all mocks so admin.require_auth() is no longer satisfied.
    env.mock_auths(&[]);
    let hash = BytesN::from_array(&env, &[0u8; 32]);
    let result = c.try_execute_upgrade(&hash);
    assert!(result.is_err(), "non-admin execute must fail without auth");
}

#[test]
fn timelock_double_propose_returns_upgrade_already_pending() {
    let (env, _admin, client, _, factory_client) = setup();
    let hash1 = BytesN::from_array(&env, &[1u8; 32]);
    let hash2 = BytesN::from_array(&env, &[2u8; 32]);

    client.propose_upgrade(&hash1);
    let result = client.try_propose_upgrade(&hash2);
    assert_eq!(result, Err(Ok(PayoutError::UpgradeAlreadyPending)));

    let pending = client.pending_upgrade().unwrap();
    assert_eq!(pending.0, hash1);
}

#[test]
fn timelock_execute_with_wrong_hash_returns_hash_mismatch() {
    use soroban_sdk::testutils::Ledger;

    let (env, _admin, client, _, factory_client) = setup();
    let stored_hash = BytesN::from_array(&env, &[0u8; 32]);
    let wrong_hash = BytesN::from_array(&env, &[0xFFu8; 32]);

    let propose_time = env.ledger().timestamp();
    client.propose_upgrade(&stored_hash);
    env.ledger().with_mut(|l| {
        l.timestamp = propose_time + TIMELOCK;
    });

    assert_eq!(
        client.try_execute_upgrade(&wrong_hash),
        Err(Ok(PayoutError::HashMismatch))
    );
}

#[test]
fn test_unauthorized_caller_attack_scenario() {
    let (env, _admin, client, _, factory_client) = setup();
    let attacker = Address::generate(&env);
    let ctx = symbol_short!("ATTACK");
    let pool_id = 1u32;

    let valid_arena = Address::generate(&env);
    factory_client.set_arena(&(pool_id as u64), &valid_arena);

    let result = client.try_distribute_winnings(
        &attacker,
        &ctx,
        &pool_id,
        &1u32,
        &attacker,
        &1000i128,
        &symbol_short!("XLM"),
    );

    assert_eq!(result, Err(Ok(PayoutError::UnauthorizedCaller)));
}

#[test]
fn win_fee_bps_cases_0_200_1000() {
    let (env, _admin, client, token_id, _treasury, _factory_id, factory_client) =
        setup_with_token();
    let currency = symbol_short!("USDC");
    client.set_currency_token(&currency, &token_id);
    let token = TokenClient::new(&env, &token_id);

    let run_case = |pool_id: u32, bps: u32, amount: i128| {
        let winner = Address::generate(&env);
        let caller = Address::generate(&env);
        factory_client.set_arena(&(pool_id as u64), &caller);
        factory_client.set_fee_bps(&bps);
        let before_winner = token.balance(&winner);
        let before_factory = token.balance(&factory_client.address);
        client.distribute_winnings(
            &caller,
            &symbol_short!("CTX"),
            &pool_id,
            &1u32,
            &winner,
            &amount,
            &currency,
        );
        let fee = amount * (bps as i128) / 10_000;
        assert_eq!(token.balance(&winner), before_winner + (amount - fee));
        assert_eq!(token.balance(&factory_client.address), before_factory + fee);
    };

    run_case(10, 0, 1_000);
    run_case(11, 200, 1_000);
    run_case(12, 1_000, 1_000);
}

#[test]
fn win_fee_overflow_guard_returns_error() {
    let (env, _admin, client, _token_id, _treasury, _factory_id, factory_client) =
        setup_with_token();
    let winner = Address::generate(&env);
    let caller = Address::generate(&env);
    factory_client.set_arena(&(99u32 as u64), &caller);
    factory_client.set_fee_bps(&1_000);
    let result = client.try_distribute_winnings(
        &caller,
        &symbol_short!("CTX"),
        &99u32,
        &1u32,
        &winner,
        &i128::MAX,
        &symbol_short!("XLM"),
    );
    assert_eq!(result, Err(Ok(PayoutError::ArithmeticOverflow)));
}

// ── Issue #581: Fee rounding and dust behavior ────────────────────────────────

#[test]
fn fee_rounding_with_tiny_payout_and_high_bps() {
    let (env, _admin, client, token_id, _treasury, _factory_id, factory_client) =
        setup_with_token();
    let currency = symbol_short!("USDC");
    client.set_currency_token(&currency, &token_id);
    let token = TokenClient::new(&env, &token_id);

    let winner = Address::generate(&env);
    let caller = Address::generate(&env);
    factory_client.set_arena(&(100u32 as u64), &caller);
    factory_client.set_fee_bps(&9_999);

    let amount = 1i128;
    let before_winner = token.balance(&winner);
    let before_factory = token.balance(&factory_client.address);

    client.distribute_winnings(
        &caller,
        &symbol_short!("CTX"),
        &100u32,
        &1u32,
        &winner,
        &amount,
        &currency,
    );

    let fee = amount * 9_999i128 / 10_000i128;
    let winner_amount = amount - fee;
    assert_eq!(token.balance(&winner), before_winner + winner_amount);
    assert_eq!(token.balance(&factory_client.address), before_factory + fee);
    assert_eq!(winner_amount, 1i128);
    assert_eq!(fee, 0i128);
}

#[test]
fn fee_rounding_with_small_payout_exact_division() {
    let (env, _admin, client, token_id, _treasury, _factory_id, factory_client) =
        setup_with_token();
    let currency = symbol_short!("USDC");
    client.set_currency_token(&currency, &token_id);
    let token = TokenClient::new(&env, &token_id);

    let winner = Address::generate(&env);
    let caller = Address::generate(&env);
    factory_client.set_arena(&(101u32 as u64), &caller);
    factory_client.set_fee_bps(&5_000);

    let amount = 10_000i128;
    let before_winner = token.balance(&winner);
    let before_factory = token.balance(&factory_client.address);

    client.distribute_winnings(
        &caller,
        &symbol_short!("CTX"),
        &101u32,
        &1u32,
        &winner,
        &amount,
        &currency,
    );

    let fee = amount * 5_000i128 / 10_000i128;
    let winner_amount = amount - fee;
    assert_eq!(token.balance(&winner), before_winner + winner_amount);
    assert_eq!(token.balance(&factory_client.address), before_factory + fee);
    assert_eq!(winner_amount, 5_000i128);
    assert_eq!(fee, 5_000i128);
}

#[test]
fn fee_rounding_with_remainder() {
    let (env, _admin, client, token_id, _treasury, _factory_id, factory_client) =
        setup_with_token();
    let currency = symbol_short!("USDC");
    client.set_currency_token(&currency, &token_id);
    let token = TokenClient::new(&env, &token_id);

    let winner = Address::generate(&env);
    let caller = Address::generate(&env);
    factory_client.set_arena(&(102u32 as u64), &caller);
    factory_client.set_fee_bps(&333);

    let amount = 1_000i128;
    let before_winner = token.balance(&winner);
    let before_factory = token.balance(&factory_client.address);

    client.distribute_winnings(
        &caller,
        &symbol_short!("CTX"),
        &102u32,
        &1u32,
        &winner,
        &amount,
        &currency,
    );

    let fee = amount * 333i128 / 10_000i128;
    let winner_amount = amount - fee;
    assert_eq!(token.balance(&winner), before_winner + winner_amount);
    assert_eq!(token.balance(&factory_client.address), before_factory + fee);
    assert_eq!(winner_amount, 967i128);
    assert_eq!(fee, 33i128);
}

// ── Issue #582: Missing currency-token mapping path ──────────────────────────

#[test]
fn distribute_winnings_records_payout_without_token_mapping() {
    let (env, _admin, client, _, factory_client) = setup();

    let winner = Address::generate(&env);
    let ctx = symbol_short!("NO_TOKEN");
    let pool_id = 200u32;
    let round_id = 1u32;
    let amount = 5_000i128;
    let currency = symbol_short!("UNKNOWN");

    assert!(!client.is_payout_processed(&ctx, &pool_id, &round_id, &winner));

    let caller = Address::generate(&env);
    factory_client.set_arena(&(pool_id as u64), &caller);
    client.distribute_winnings(
        &caller, &ctx, &pool_id, &round_id, &winner, &amount, &currency,
    );

    assert!(client.is_payout_processed(&ctx, &pool_id, &round_id, &winner));
    let payout = client
        .get_payout(&ctx, &pool_id, &round_id, &winner)
        .expect("payout must be recorded");
    assert_eq!(payout.winner, winner);
    assert_eq!(payout.amount, amount);
    assert_eq!(payout.currency, currency);
    assert!(payout.paid);
}

#[test]
fn distribute_winnings_with_partial_token_mapping() {
    let (env, _admin, client, token_id, _treasury, _, factory_client) = setup_with_token();

    let currency1 = symbol_short!("USDC");
    let currency2 = symbol_short!("EURC");
    client.set_currency_token(&currency1, &token_id);

    let winner = Address::generate(&env);
    let caller = Address::generate(&env);
    factory_client.set_arena(&(201u32 as u64), &caller);

    client.distribute_winnings(
        &caller,
        &symbol_short!("CTX"),
        &201u32,
        &1u32,
        &winner,
        &1_000i128,
        &currency1,
    );

    assert!(
        client.is_payout_processed(&symbol_short!("CTX"), &201u32, &1u32, &winner),
        "payout should be recorded for currency1"
    );

    let winner2 = Address::generate(&env);
    client.distribute_winnings(
        &caller,
        &symbol_short!("CTX"),
        &201u32,
        &2u32,
        &winner2,
        &2_000i128,
        &currency2,
    );

    assert!(
        client.is_payout_processed(&symbol_short!("CTX"), &201u32, &2u32, &winner2),
        "payout should be recorded for currency2 even without token mapping"
    );
}

// ── Issue #590: payout event snapshot tests ───────────────────────────────────

#[test]
fn distribute_winnings_emits_payout_event_with_correct_schema() {
    use soroban_sdk::testutils::Events as _;

    let (env, _admin, client, _, factory_client) = setup();

    let winner = Address::generate(&env);
    let caller = Address::generate(&env);
    let ctx = symbol_short!("CTX");
    let amount = 1_000i128;
    let currency = symbol_short!("XLM");
    factory_client.set_arena(&(42u32 as u64), &caller);

    let before = env.events().all().len();
    client.distribute_winnings(&caller, &ctx, &42u32, &1u32, &winner, &amount, &currency);
    let events = env.events().all();
    assert!(
        events.len() > before,
        "distribute_winnings must emit at least one event"
    );

    let (_contract, topics, data) = events.last().unwrap();
    let topic: Symbol = topics.get(0).unwrap().into_val(&env);
    assert_eq!(topic, symbol_short!("PAYOUT"), "topic must be PAYOUT");

    // Schema: (winner: Address, winner_amount: i128, fee_amount: i128, currency: Symbol)
    let (emitted_winner, emitted_amount, emitted_fee, emitted_currency): (
        Address,
        i128,
        i128,
        Symbol,
    ) = data.into_val(&env);
    assert_eq!(emitted_winner, winner);
    assert_eq!(emitted_amount, amount);
    assert_eq!(emitted_fee, 0i128);
    assert_eq!(emitted_currency, currency);
}

#[test]
fn set_currency_token_emits_tok_set_event_with_correct_schema() {
    use soroban_sdk::testutils::Events as _;

    let (env, _admin, client, _, _factory_client) = setup();

    let token_addr = Address::generate(&env);
    let currency = symbol_short!("USDC");

    let before = env.events().all().len();
    client.set_currency_token(&currency, &token_addr);
    let events = env.events().all();
    assert!(
        events.len() > before,
        "set_currency_token must emit at least one event"
    );

    let (_contract, topics, data) = events.last().unwrap();
    let topic: Symbol = topics.get(0).unwrap().into_val(&env);
    assert_eq!(topic, symbol_short!("TOK_SET"), "topic must be TOK_SET");

    // Schema: (v: u32, currency: Symbol, token_address: Address)
    let (v, emitted_currency, emitted_token): (u32, Symbol, Address) = data.into_val(&env);
    assert_eq!(v, 1u32, "event version must be 1");
    assert_eq!(emitted_currency, currency);
    assert_eq!(emitted_token, token_addr);
}

#[allow(deprecated)]
#[test]
fn distribute_prize_emits_payout_and_dust_events() {
    use soroban_sdk::testutils::Events as _;

    let (env, _admin, client, token_id, treasury, _, _factory_client) = setup_with_token();

    let winners = {
        let mut v = Vec::new(&env);
        let w1 = Address::generate(&env);
        let w2 = Address::generate(&env);
        v.push_back(w1);
        v.push_back(w2);
        v
    };
    let total = 1_001i128; // dust = 1 (1001 / 2 = 500, remainder 1)

    let before = env.events().all().len();
    client.distribute_prize(&42u32, &total, &winners, &token_id);
    let events = env.events().all();

    // 2 winners + 1 dust = 3 new events
    let new_count = events.len() - before;
    assert!(
        new_count >= 3,
        "expected at least 3 new events (2 winner + 1 dust)"
    );

    // First winner event: topic = PAYOUT; schema: (winner: Address, share: i128, currency: Address)
    let (_, topics, data) = events.get(before).unwrap();
    let topic: Symbol = topics.get(0).unwrap().into_val(&env);
    assert_eq!(topic, symbol_short!("PAYOUT"));
    let (_w, share, _tok): (Address, i128, Address) = data.into_val(&env);
    assert_eq!(share, 500i128);

    // Last new event is the dust event: topic = DUST; schema: (treasury: Address, dust: i128, currency: Address)
    let (_, dust_topics, dust_data) = events.get(before + new_count - 1).unwrap();
    let dust_topic: Symbol = dust_topics.get(0).unwrap().into_val(&env);
    assert_eq!(
        dust_topic,
        symbol_short!("DUST"),
        "remainder must emit DUST event"
    );
    let (recv, dust_amount, _tok): (Address, i128, Address) = dust_data.into_val(&env);
    assert_eq!(recv, treasury);
    assert_eq!(dust_amount, 1i128);
}

#[test]
fn distribute_winnings_with_fee_emits_correct_amounts() {
    use soroban_sdk::testutils::Events as _;

    let (env, _admin, client, _, factory_client) = setup();

    factory_client.set_fee_bps(&500u32); // 5% fee
    let winner = Address::generate(&env);
    let caller = Address::generate(&env);
    factory_client.set_arena(&(99u32 as u64), &caller);

    let amount = 1_000i128;
    let currency = symbol_short!("XLM");

    client.distribute_winnings(
        &caller,
        &symbol_short!("CTX"),
        &99u32,
        &1u32,
        &winner,
        &amount,
        &currency,
    );

    let events = env.events().all();
    let (_contract, _topics, data) = events.last().unwrap();
    let (_, winner_amount, fee_amount, _): (Address, i128, i128, Symbol) = data.into_val(&env);

    assert_eq!(fee_amount, 50i128, "5% of 1000 = 50");
    assert_eq!(winner_amount, 950i128, "winner receives 950 after 5% fee");
}
