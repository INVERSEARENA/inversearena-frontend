#[cfg(test)]
use super::*;
use soroban_sdk::{
    Address, BytesN, Env,
    testutils::{Address as _, Ledger},
};

const TIMELOCK: u64 = 48 * 60 * 60; // 48 hours
const MIN_STAKE: i128 = 10_000_000; // 10 XLM in stroops
const MAX_CAPACITY: u32 = 256;

// ── helpers ───────────────────────────────────────────────────────────────────

fn assert_auth_err<T>(_res: T) {}

fn setup() -> (Env, Address, FactoryContractClient<'static>) {
    let env = Env::default();
    env.mock_all_auths();

    let contract_id = env.register(FactoryContract, ());
    let client = FactoryContractClient::new(&env, &contract_id);
    let admin = Address::generate(&env);
    client.initialize(&admin);

    // SAFETY: env lives for the duration of the test.
    let env_static: &'static Env = unsafe { &*(&env as *const Env) };
    let client = FactoryContractClient::new(env_static, &contract_id);
    (env, admin, client)
}

fn dummy_hash(env: &Env) -> BytesN<32> {
    BytesN::from_array(env, &[2u8; 32])
}

// ── initialize ────────────────────────────────────────────────────────────────

#[test]
fn test_initialize_sets_admin() {
    let (_env, admin, client) = setup();
    assert_eq!(client.admin(), admin);
}

#[test]
fn test_double_initialize_returns_already_initialized() {
    let (_env, admin, client) = setup();
    let result = client.try_initialize(&admin);
    assert_eq!(result, Err(Ok(Error::AlreadyInitialized)));
}

// ── whitelist management ───────────────────────────────────────────────────────

#[test]
fn test_add_to_whitelist() {
    let (env, _admin, client) = setup();
    let host = Address::generate(&env);
    assert!(!client.is_whitelisted(&host));
    client.add_to_whitelist(&host);
    assert!(client.is_whitelisted(&host));
}

#[test]
fn test_remove_from_whitelist() {
    let (env, _admin, client) = setup();
    let host = Address::generate(&env);
    client.add_to_whitelist(&host);
    assert!(client.is_whitelisted(&host));
    client.remove_from_whitelist(&host);
    assert!(!client.is_whitelisted(&host));
}

#[test]
fn test_is_whitelisted_when_not_initialized_returns_not_initialized() {
    let env = Env::default();
    let contract_id = env.register(FactoryContract, ());
    let client = FactoryContractClient::new(&env, &contract_id);
    let host = Address::generate(&env);
    let result = client.try_is_whitelisted(&host);
    assert_eq!(result, Err(Ok(Error::NotInitialized)));
}

// ── minimum stake ──────────────────────────────────────────────────────────────

#[test]
fn test_get_default_min_stake() {
    let (_env, _admin, client) = setup();
    assert_eq!(client.get_min_stake(), MIN_STAKE);
}

#[test]
fn test_set_min_stake() {
    let (_env, _admin, client) = setup();
    let new_min = 5_000_000i128; // 5 XLM
    client.set_min_stake(&new_min);
    assert_eq!(client.get_min_stake(), new_min);
}

#[test]
fn test_set_negative_min_stake_returns_invalid_stake_amount() {
    let (_env, _admin, client) = setup();
    let result = client.try_set_min_stake(&-1000);
    assert_eq!(result, Err(Ok(Error::InvalidStakeAmount)));
}

// ── create_pool authorization ──────────────────────────────────────────────────

#[test]
fn test_admin_can_create_pool() {
    let (env, admin, client) = setup();
    let wasm_hash = dummy_hash(&env);
    client.set_arena_wasm_hash(&wasm_hash);
    let stake = MIN_STAKE + 1_000_000;
    let currency = Address::generate(&env);
    client.create_pool(&admin, &stake, &currency, &10u32, &8u32);
}

#[test]
fn test_whitelisted_host_can_create_pool() {
    let (env, _admin, client) = setup();
    let host = Address::generate(&env);
    client.add_to_whitelist(&host);

    let wasm_hash = dummy_hash(&env);
    client.set_arena_wasm_hash(&wasm_hash);
    let stake = MIN_STAKE + 1_000_000;
    let currency = Address::generate(&env);
    client.create_pool(&host, &stake, &currency, &10u32, &8u32);
}

#[test]
fn test_unauthorized_caller_returns_unauthorized() {
    let (env, _admin, client) = setup();
    let wasm_hash = dummy_hash(&env);
    client.set_arena_wasm_hash(&wasm_hash);
    let unauthorized = Address::generate(&env);
    let stake = MIN_STAKE + 1_000_000;
    let currency = Address::generate(&env);
    let result = client.try_create_pool(&unauthorized, &stake, &currency, &10u32, &8u32);
    assert_eq!(result, Err(Ok(Error::Unauthorized)));
}

// ── create_pool stake validation ────────────────────────────────────────────────

#[test]
fn test_create_pool_with_stake_equal_to_minimum_succeeds() {
    let (env, admin, client) = setup();
    let wasm_hash = dummy_hash(&env);
    client.set_arena_wasm_hash(&wasm_hash);
    let currency = Address::generate(&env);
    client.create_pool(&admin, &MIN_STAKE, &currency, &10u32, &8u32);
}

#[test]
fn test_create_pool_with_stake_below_minimum_returns_stake_below_minimum() {
    let (env, admin, client) = setup();
    let wasm_hash = dummy_hash(&env);
    client.set_arena_wasm_hash(&wasm_hash);
    let stake = MIN_STAKE - 1;
    let currency = Address::generate(&env);
    let result = client.try_create_pool(&admin, &stake, &currency, &10u32, &8u32);
    assert_eq!(result, Err(Ok(Error::StakeBelowMinimum)));
}

#[test]
fn test_create_pool_with_zero_stake_returns_invalid_stake_amount() {
    let (env, admin, client) = setup();
    let wasm_hash = dummy_hash(&env);
    client.set_arena_wasm_hash(&wasm_hash);
    let currency = Address::generate(&env);
    let result = client.try_create_pool(&admin, &0, &currency, &10u32, &8u32);
    assert_eq!(result, Err(Ok(Error::InvalidStakeAmount)));
}

#[test]
fn test_create_pool_with_negative_stake_returns_invalid_stake_amount() {
    let (env, admin, client) = setup();
    let wasm_hash = dummy_hash(&env);
    client.set_arena_wasm_hash(&wasm_hash);
    let currency = Address::generate(&env);
    let result = client.try_create_pool(&admin, &-1000, &currency, &10u32, &8u32);
    assert_eq!(result, Err(Ok(Error::InvalidStakeAmount)));
}

#[test]
fn test_create_pool_without_wasm_hash_returns_wasm_hash_not_set() {
    let (env, admin, client) = setup();
    let stake = MIN_STAKE + 1_000_000;
    let currency = Address::generate(&env);
    let result = client.try_create_pool(&admin, &stake, &currency, &10u32, &8u32);
    assert_eq!(result, Err(Ok(Error::WasmHashNotSet)));
}

// ── create_pool capacity validation ───────────────────────────────────────────

#[test]
fn test_create_pool_with_capacity_one_succeeds() {
    let (env, admin, client) = setup();
    client.set_arena_wasm_hash(&dummy_hash(&env));
    let currency = Address::generate(&env);
    client.create_pool(&admin, &MIN_STAKE, &currency, &10u32, &1u32);
}

#[test]
fn test_create_pool_with_max_capacity_succeeds() {
    let (env, admin, client) = setup();
    client.set_arena_wasm_hash(&dummy_hash(&env));
    let currency = Address::generate(&env);
    client.create_pool(&admin, &MIN_STAKE, &currency, &10u32, &MAX_CAPACITY);
}

#[test]
fn test_create_pool_with_zero_capacity_returns_invalid_capacity() {
    let (env, admin, client) = setup();
    client.set_arena_wasm_hash(&dummy_hash(&env));
    let currency = Address::generate(&env);
    let result = client.try_create_pool(&admin, &MIN_STAKE, &currency, &10u32, &0u32);
    assert_eq!(result, Err(Ok(Error::InvalidCapacity)));
}

#[test]
fn test_create_pool_exceeding_max_capacity_returns_invalid_capacity() {
    let (env, admin, client) = setup();
    client.set_arena_wasm_hash(&dummy_hash(&env));
    let currency = Address::generate(&env);
    let result = client.try_create_pool(&admin, &MIN_STAKE, &currency, &10u32, &(MAX_CAPACITY + 1));
    assert_eq!(result, Err(Ok(Error::InvalidCapacity)));
}

// ── create_pool duplicate rejection ───────────────────────────────────────────

#[test]
fn test_create_pool_increments_id() {
    let (env, admin, client) = setup();
    client.set_arena_wasm_hash(&dummy_hash(&env));
    let currency = Address::generate(&env);
    let pool1 = client.create_pool(&admin, &MIN_STAKE, &currency, &10u32, &8u32);
    let pool2 = client.create_pool(&admin, &MIN_STAKE, &currency, &10u32, &8u32);
    assert_ne!(pool1, pool2);
}

// ── propose_upgrade ───────────────────────────────────────────────────────────

#[test]
fn test_propose_upgrade_stores_pending() {
    let (env, _admin, client) = setup();
    let hash = dummy_hash(&env);
    client.propose_upgrade(&hash);

    let pending = client.pending_upgrade().unwrap();
    assert_eq!(pending.0, hash);
    assert!(pending.1 >= env.ledger().timestamp() + TIMELOCK);
}

#[test]
fn test_propose_upgrade_replaces_previous() {
    let (env, _admin, client) = setup();
    let hash1 = BytesN::from_array(&env, &[1u8; 32]);
    let hash2 = BytesN::from_array(&env, &[2u8; 32]);

    client.propose_upgrade(&hash1);
    client.propose_upgrade(&hash2);

    let pending = client.pending_upgrade().unwrap();
    assert_eq!(pending.0, hash2);
}

// ── execute_upgrade — timelock guard ─────────────────────────────────────────

#[test]
fn test_execute_without_proposal_returns_no_pending_upgrade() {
    let (_env, _admin, client) = setup();
    let result = client.try_execute_upgrade();
    assert_eq!(result, Err(Ok(Error::NoPendingUpgrade)));
}

#[test]
fn test_execute_before_timelock_returns_timelock_not_expired() {
    let (env, _admin, client) = setup();
    client.propose_upgrade(&dummy_hash(&env));
    // Advance only 47 h — one hour short.
    env.ledger().with_mut(|l| {
        l.timestamp += 47 * 60 * 60;
    });
    let result = client.try_execute_upgrade();
    assert_eq!(result, Err(Ok(Error::TimelockNotExpired)));
}

#[test]
fn test_execute_exactly_at_boundary_returns_timelock_not_expired() {
    let (env, _admin, client) = setup();
    let propose_time = env.ledger().timestamp();
    client.propose_upgrade(&dummy_hash(&env));
    env.ledger().with_mut(|l| {
        l.timestamp = propose_time + TIMELOCK - 1;
    });
    let result = client.try_execute_upgrade();
    assert_eq!(result, Err(Ok(Error::TimelockNotExpired)));
}

// ── cancel_upgrade ────────────────────────────────────────────────────────────

#[test]
fn test_cancel_without_proposal_returns_no_pending_upgrade() {
    let (_env, _admin, client) = setup();
    let result = client.try_cancel_upgrade();
    assert_eq!(result, Err(Ok(Error::NoPendingUpgrade)));
}

#[test]
fn test_cancel_clears_pending_upgrade() {
    let (env, _admin, client) = setup();
    client.propose_upgrade(&dummy_hash(&env));
    assert!(client.pending_upgrade().is_some());

    client.cancel_upgrade();
    assert!(client.pending_upgrade().is_none());
}

#[test]
fn test_execute_after_cancel_returns_no_pending_upgrade() {
    let (env, _admin, client) = setup();
    client.propose_upgrade(&dummy_hash(&env));
    client.cancel_upgrade();

    env.ledger().with_mut(|l| {
        l.timestamp += TIMELOCK + 1;
    });
    let result = client.try_execute_upgrade();
    assert_eq!(result, Err(Ok(Error::NoPendingUpgrade)));
}

#[test]
fn test_double_cancel_returns_no_pending_upgrade() {
    let (env, _admin, client) = setup();
    client.propose_upgrade(&dummy_hash(&env));
    client.cancel_upgrade();
    let result = client.try_cancel_upgrade();
    assert_eq!(result, Err(Ok(Error::NoPendingUpgrade)));
}

// ── pending_upgrade ───────────────────────────────────────────────────────────

#[test]
fn test_pending_upgrade_none_before_propose() {
    let (_env, _admin, client) = setup();
    assert!(client.pending_upgrade().is_none());
}

#[test]
fn test_pending_upgrade_none_after_cancel() {
    let (env, _admin, client) = setup();
    client.propose_upgrade(&dummy_hash(&env));
    client.cancel_upgrade();
    assert!(client.pending_upgrade().is_none());
}

// ── Admin access control ──────────────────────────────────────────────────────

#[test]
fn test_set_admin_changes_admin() {
    let (env, _admin, client) = setup();
    let new_admin = Address::generate(&env);
    client.set_admin(&new_admin);
    assert_eq!(client.admin(), new_admin);
}

#[test]
fn test_set_admin_fails_without_initialization_returns_not_initialized() {
    let env = Env::default();
    let contract_id = env.register(FactoryContract, ());
    let client = FactoryContractClient::new(&env, &contract_id);
    let new_admin = Address::generate(&env);
    let result = client.try_set_admin(&new_admin);
    assert_eq!(result, Err(Ok(Error::NotInitialized)));
}

#[test]
fn test_unauthorized_set_admin_panics() {
    let env = Env::default();
    let contract_id = env.register(FactoryContract, ());
    // No mock_all_auths()!
    let client = FactoryContractClient::new(&env, &contract_id);
    let admin = Address::generate(&env);
    client.initialize(&admin);
    assert_auth_err(client.try_set_admin(&Address::generate(&env)));
}

#[test]
fn test_unauthorized_set_arena_wasm_hash_panics() {
    let env = Env::default();
    let contract_id = env.register(FactoryContract, ());
    let client = FactoryContractClient::new(&env, &contract_id);
    let admin = Address::generate(&env);
    client.initialize(&admin);
    assert_auth_err(client.try_set_arena_wasm_hash(&dummy_hash(&env)));
}

#[test]
fn test_unauthorized_whitelist_panics() {
    let env = Env::default();
    let contract_id = env.register(FactoryContract, ());
    let client = FactoryContractClient::new(&env, &contract_id);
    let admin = Address::generate(&env);
    client.initialize(&admin);
    assert_auth_err(client.try_add_to_whitelist(&Address::generate(&env)));
    assert_auth_err(client.try_remove_from_whitelist(&Address::generate(&env)));
}

#[test]
fn test_unauthorized_set_min_stake_panics() {
    let env = Env::default();
    let contract_id = env.register(FactoryContract, ());
    let client = FactoryContractClient::new(&env, &contract_id);
    let admin = Address::generate(&env);
    client.initialize(&admin);
    assert_auth_err(client.try_set_min_stake(&1000i128));
}

#[test]
fn test_unauthorized_propose_upgrade_panics() {
    // `require_auth()` is enforced by the Soroban host and cannot be replaced
    // with a typed error — this test intentionally remains as a panic check.
    let env = Env::default();
    let contract_id = env.register(FactoryContract, ());
    let client = FactoryContractClient::new(&env, &contract_id);
    let admin = Address::generate(&env);
    client.initialize(&admin);
    client.propose_upgrade(&dummy_hash(&env));
}

#[test]
fn test_unauthorized_execute_upgrade_panics() {
    let env = Env::default();
    let contract_id = env.register(FactoryContract, ());
    let client = FactoryContractClient::new(&env, &contract_id);
    let admin = Address::generate(&env);
    client.initialize(&admin);
    client.execute_upgrade();
}

#[test]
fn test_unauthorized_cancel_upgrade_panics() {
    let env = Env::default();
    let contract_id = env.register(FactoryContract, ());
    let client = FactoryContractClient::new(&env, &contract_id);
    let admin = Address::generate(&env);
    client.initialize(&admin);
    client.cancel_upgrade();
}

// ── Queries tests ────────────────────────────────────────────────────────────

#[test]
fn test_get_arena() {
    let (env, admin, client) = setup();
    client.set_arena_wasm_hash(&dummy_hash(&env));
    let currency = Address::generate(&env);
    client.create_pool(&admin, &MIN_STAKE, &currency, &10u32, &10u32);

    let arena = client.get_arena(&0u32).unwrap();
    assert_eq!(arena.pool_id, 0);
    assert_eq!(arena.creator, admin);
    assert_eq!(arena.capacity, 10);
    assert_eq!(arena.stake_amount, MIN_STAKE);
}

#[test]
fn test_get_arenas_pagination() {
    let (env, admin, client) = setup();
    client.set_arena_wasm_hash(&dummy_hash(&env));
    let currency = Address::generate(&env);

    for _ in 0..5 {
        client.create_pool(&admin, &MIN_STAKE, &currency, &10u32, &10u32);
    }

    let all = client.get_arenas(&0u32, &10u32);
    assert_eq!(all.len(), 5);
    
    let page1 = client.get_arenas(&0u32, &2u32);
    assert_eq!(page1.len(), 2);
    assert_eq!(page1.get(0).unwrap().pool_id, 0);
    assert_eq!(page1.get(1).unwrap().pool_id, 1);

    let page2 = client.get_arenas(&2u32, &2u32);
    assert_eq!(page2.len(), 2);
    assert_eq!(page2.get(0).unwrap().pool_id, 2);
    assert_eq!(page2.get(1).unwrap().pool_id, 3);

    let page3 = client.get_arenas(&4u32, &2u32);
    assert_eq!(page3.len(), 1);
    assert_eq!(page3.get(0).unwrap().pool_id, 4);
}
