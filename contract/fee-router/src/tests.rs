#![cfg(test)]

use super::*;
use soroban_sdk::{
    Env, Address, testutils::Address as _,
    testutils::Ledger as _,
    token::{Client as TokenClient, StellarAssetClient},
};
use crate::types::{FeeRouterError, MAX_STAKING_SHARE_BPS, MIN_FLUSH_AMOUNT, STAKING_SHARE_TIMELOCK_SECS};

// ─── Minimal staking mock ─────────────────────────────────────────────────────

/// A simple mock staking contract used in tests so we can control
/// `total_shares` and observe `distribute_rewards` calls without running the
/// full staking contract.
mod mock_staking {
    use soroban_sdk::{
        Address, Env, contract, contractimpl, symbol_short, token,
        contracttype,
    };

    #[contracttype]
    enum StakKey {
        TotalShares,
        Token,
        RewardReceived,
    }

    #[contract]
    pub struct MockStaking;

    #[contractimpl]
    impl MockStaking {
        pub fn init(env: Env, token: Address) {
            env.storage().instance().set(&StakKey::Token, &token);
            env.storage().instance().set(&StakKey::TotalShares, &1i128); // non-zero by default
        }

        pub fn set_total_shares(env: Env, shares: i128) {
            env.storage().instance().set(&StakKey::TotalShares, &shares);
        }

        pub fn total_shares(env: Env) -> i128 {
            env.storage().instance().get(&StakKey::TotalShares).unwrap_or(0)
        }

        /// Mimics the real staking contract: pulls `amount` tokens from
        /// `caller` with a plain `transfer`, exactly as
        /// `staking::distribute_rewards` does (not `transfer_from`).
        pub fn distribute_rewards(env: Env, caller: Address, amount: i128) {
            caller.require_auth();
            let token_addr: Address = env.storage().instance().get(&StakKey::Token).unwrap();
            let token = token::TokenClient::new(&env, &token_addr);
            token.transfer(&caller, &env.current_contract_address(), &amount);
            let prev: i128 = env.storage().instance().get(&StakKey::RewardReceived).unwrap_or(0);
            env.storage().instance().set(&StakKey::RewardReceived, &(prev + amount));
            env.events().publish((symbol_short!("REWARDS"),), (caller, amount));
        }

        pub fn total_rewards_received(env: Env) -> i128 {
            env.storage().instance().get(&StakKey::RewardReceived).unwrap_or(0)
        }
    }
}

use mock_staking::{MockStaking, MockStakingClient};

// ─── Test helpers ─────────────────────────────────────────────────────────────

struct TestFixture {
    env: Env,
    router: FeeRouterContractClient<'static>,
    staking: MockStakingClient<'static>,
    token: TokenClient<'static>,
    admin: Address,
    treasury: Address,
    user: Address,
}

impl TestFixture {
    fn new(staking_share_bps: u32) -> Self {
        let env = Env::default();
        env.mock_all_auths();

        let admin = Address::generate(&env);
        let treasury = Address::generate(&env);
        let user = Address::generate(&env);

        // Deploy mock staking
        let staking_id = env.register(MockStaking, ());
        let staking = MockStakingClient::new(&env, &staking_id);

        // Deploy a native token for testing
        let token_admin = Address::generate(&env);
        let token_id = env.register_stellar_asset_contract_v2(token_admin.clone());
        let sac = StellarAssetClient::new(&env, &token_id.address());
        let token = TokenClient::new(&env, &token_id.address());

        staking.init(&token_id.address());

        // Mint tokens to the user for fee funding
        sac.mint(&user, &1_000_000_000);

        // Deploy fee router
        let router_id = env.register(FeeRouterContract, ());
        let router = FeeRouterContractClient::new(&env, &router_id);

        router.initialize(
            &admin,
            &staking_id,
            &treasury,
            &staking_share_bps,
        );

        // Approve token spend from user → router
        token.approve(&user, &router_id, &1_000_000_000, &(env.ledger().sequence() + 100));

        // Approve staking to pull from router (pre-approve large amount)
        token.approve(&router_id, &staking_id, &1_000_000_000, &(env.ledger().sequence() + 100));

        Self { env, router, staking, token, admin, treasury, user }
    }
}

// ─── Initialization tests ─────────────────────────────────────────────────────

#[test]
fn test_initialize_sets_state() {
    let env = Env::default();
    env.mock_all_auths();

    let admin = Address::generate(&env);
    let treasury = Address::generate(&env);
    let staking_id = env.register(MockStaking, ());
    let staking = MockStakingClient::new(&env, &staking_id);
    let token_admin = Address::generate(&env);
    let token_id = env.register_stellar_asset_contract_v2(token_admin);
    staking.init(&token_id.address());

    let router_id = env.register(FeeRouterContract, ());
    let router = FeeRouterContractClient::new(&env, &router_id);

    router.initialize(&admin, &staking_id, &treasury, &5_000u32);

    assert_eq!(router.version(), 1u32);
    assert_eq!(router.staking_share_bps(), 5_000u32);
    assert_eq!(router.admin(), admin);
    assert_eq!(router.treasury(), treasury);
    assert_eq!(router.staking_contract(), staking_id);
}

#[test]
fn test_double_initialize_fails() {
    let f = TestFixture::new(5_000);
    let result = f.router.try_initialize(
        &f.admin,
        &f.staking.address,
        &f.treasury,
        &5_000u32,
    );
    assert_eq!(result, Err(Ok(FeeRouterError::AlreadyInitialized)));
}

#[test]
fn test_invalid_bps_rejected() {
    let env = Env::default();
    env.mock_all_auths();
    let admin = Address::generate(&env);
    let treasury = Address::generate(&env);
    let staking_id = env.register(MockStaking, ());
    let staking = MockStakingClient::new(&env, &staking_id);
    let token_admin = Address::generate(&env);
    let token_id = env.register_stellar_asset_contract_v2(token_admin);
    staking.init(&token_id.address());

    let router_id = env.register(FeeRouterContract, ());
    let router = FeeRouterContractClient::new(&env, &router_id);

    // 10_001 bps > MAX
    let result = router.try_initialize(&admin, &staking_id, &treasury, &10_001u32);
    assert_eq!(result, Err(Ok(FeeRouterError::InvalidShareBps)));
}

// ─── receive_fees tests ────────────────────────────────────────────────────────

#[test]
fn test_receive_fees_increases_balance() {
    let f = TestFixture::new(5_000);
    let amount = 2_000_000i128;
    f.router.receive_fees(&f.user, &f.token.address, &amount);
    assert_eq!(f.router.accumulated_balance(&f.token.address), amount);
}

#[test]
fn test_receive_fees_accumulates() {
    let f = TestFixture::new(5_000);
    f.router.receive_fees(&f.user, &f.token.address, &MIN_FLUSH_AMOUNT);
    f.router.receive_fees(&f.user, &f.token.address, &MIN_FLUSH_AMOUNT);
    assert_eq!(f.router.accumulated_balance(&f.token.address), MIN_FLUSH_AMOUNT * 2);
}

// ─── flush tests ──────────────────────────────────────────────────────────────

#[test]
fn test_flush_below_min_defers() {
    let f = TestFixture::new(5_000);
    // Deposit less than MIN_FLUSH_AMOUNT
    f.router.receive_fees(&f.user, &f.token.address, &(MIN_FLUSH_AMOUNT - 1));
    let result = f.router.try_flush(&f.token.address);
    assert_eq!(result, Err(Ok(FeeRouterError::BelowMinFlushAmount)));
    // Balance must be preserved
    assert_eq!(f.router.accumulated_balance(&f.token.address), MIN_FLUSH_AMOUNT - 1);
}

#[test]
fn test_flush_when_staking_pool_empty_defers() {
    let f = TestFixture::new(5_000);
    // Set staking pool shares to 0
    f.staking.set_total_shares(&0i128);

    f.router.receive_fees(&f.user, &f.token.address, &MIN_FLUSH_AMOUNT);
    let result = f.router.try_flush(&f.token.address);
    assert_eq!(result, Err(Ok(FeeRouterError::StakingPoolEmpty)));
    // Balance must be preserved (deferred, not consumed)
    assert_eq!(f.router.accumulated_balance(&f.token.address), MIN_FLUSH_AMOUNT);
}

#[test]
fn test_flush_routes_staking_and_treasury() {
    let f = TestFixture::new(5_000); // 50% to staking
    let amount = 2_000_000i128; // 2 tokens
    f.router.receive_fees(&f.user, &f.token.address, &amount);

    let treasury_before = f.token.balance(&f.treasury);

    f.router.flush(&f.token.address);

    // 50% should go to staking
    let expected_staking = amount * 5_000 / 10_000; // 1_000_000
    let expected_treasury = amount - expected_staking; // 1_000_000

    // Balance should be zeroed
    assert_eq!(f.router.accumulated_balance(&f.token.address), 0);

    // Treasury received its share
    let treasury_after = f.token.balance(&f.treasury);
    assert_eq!(treasury_after - treasury_before, expected_treasury);
}

#[test]
fn test_flush_zero_share_all_to_treasury() {
    let f = TestFixture::new(0); // 0% to staking, 100% to treasury
    let amount = 2_000_000i128;
    f.router.receive_fees(&f.user, &f.token.address, &amount);

    let treasury_before = f.token.balance(&f.treasury);
    f.router.flush(&f.token.address);

    assert_eq!(f.router.accumulated_balance(&f.token.address), 0);
    assert_eq!(f.token.balance(&f.treasury) - treasury_before, amount);
}

// ─── Integration: arena settle → fee to router → flush → staker balance ───────
// This covers the acceptance criterion: "arena settle → fee to router → flush
// → staker balance increases".  The "arena settle" step is simulated by the
// test sending tokens directly through `receive_fees`.

#[test]
fn test_integration_arena_settle_to_staker() {
    let f = TestFixture::new(10_000); // 100% to staking for simplicity

    let fee_amount = 5_000_000i128;
    f.router.receive_fees(&f.user, &f.token.address, &fee_amount);

    // Pre-flush: staking contract has received nothing
    let staking_rewards_before = f.staking.total_rewards_received();

    f.router.flush(&f.token.address);

    // Post-flush: staking contract should have received the full fee
    let staking_rewards_after = f.staking.total_rewards_received();
    assert_eq!(staking_rewards_after - staking_rewards_before, fee_amount);
    assert_eq!(f.router.accumulated_balance(&f.token.address), 0);
}

// ─── Timelocked governance tests ──────────────────────────────────────────────

#[test]
fn test_propose_and_commit_staking_share() {
    let f = TestFixture::new(5_000);

    f.router.propose_staking_share(&3_000u32);
    let pending = f.router.pending_share_change().expect("should have pending change");
    assert_eq!(pending.new_bps, 3_000u32);

    // Should not commit before timelock
    let too_soon = f.router.try_commit_staking_share();
    assert_eq!(too_soon, Err(Ok(FeeRouterError::TimelockNotExpired)));

    // Advance time past the timelock
    f.env.ledger().with_mut(|l| {
        l.timestamp += STAKING_SHARE_TIMELOCK_SECS + 1;
    });

    f.router.commit_staking_share();
    assert_eq!(f.router.staking_share_bps(), 3_000u32);
    assert!(f.router.pending_share_change().is_none());
}

#[test]
fn test_cancel_staking_share() {
    let f = TestFixture::new(5_000);
    f.router.propose_staking_share(&3_000u32);
    f.router.cancel_staking_share();
    assert!(f.router.pending_share_change().is_none());
    assert_eq!(f.router.staking_share_bps(), 5_000u32); // unchanged
}

#[test]
fn test_commit_without_proposal_fails() {
    let f = TestFixture::new(5_000);
    let result = f.router.try_commit_staking_share();
    assert_eq!(result, Err(Ok(FeeRouterError::NoPendingShareChange)));
}

#[test]
fn test_propose_invalid_bps_fails() {
    let f = TestFixture::new(5_000);
    let result = f.router.try_propose_staking_share(&(MAX_STAKING_SHARE_BPS + 1));
    assert_eq!(result, Err(Ok(FeeRouterError::InvalidShareBps)));
}

// ─── Admin two-step transfer ──────────────────────────────────────────────────

#[test]
fn test_admin_two_step_transfer() {
    let f = TestFixture::new(5_000);
    let new_admin = Address::generate(&f.env);

    f.router.propose_admin(&new_admin);
    f.router.accept_admin();

    assert_eq!(f.router.admin(), new_admin);
}

#[test]
fn test_accept_admin_without_proposal_fails() {
    let f = TestFixture::new(5_000);
    let result = f.router.try_accept_admin();
    assert_eq!(result, Err(Ok(FeeRouterError::NoPendingAdmin)));
}

// ─── set_treasury / set_staking_contract ─────────────────────────────────────

#[test]
fn test_set_treasury_updates_address() {
    let f = TestFixture::new(5_000);
    let new_treasury = Address::generate(&f.env);
    f.router.set_treasury(&new_treasury);
    assert_eq!(f.router.treasury(), new_treasury);
}

#[test]
fn test_set_staking_contract_updates_address() {
    let f = TestFixture::new(5_000);
    let new_staking = Address::generate(&f.env);
    f.router.set_staking_contract(&new_staking);
    assert_eq!(f.router.staking_contract(), new_staking);
}
