#[cfg(test)]
use super::*;
use soroban_sdk::{
    testutils::{Address as _, Ledger},
    Address, BytesN, Env,
};

const TIMELOCK: u64 = 48 * 60 * 60; // 48 hours
const MIN_STAKE: i128 = 10_000_000; // 10 XLM in stroops
const MAX_CAPACITY: u32 = 256;

// ── helpers ───────────────────────────────────────────────────────────────────

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
#[should_panic(expected = "already initialized")]
fn test_double_initialize_panics() {
    let (_env, admin, client) = setup();
    client.initialize(&admin);
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
#[should_panic(expected = "not initialized")]
fn test_is_whitelisted_when_not_initialized() {
    let env = Env::default();
    let contract_id = env.register(FactoryContract, ());
    let client = FactoryContractClient::new(&env, &contract_id);
    let host = Address::generate(&env);
    client.is_whitelisted(&host);
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
#[should_panic(expected = "stake amount cannot be negative")]
fn test_set_negative_min_stake_panics() {
    let (_env, _admin, client) = setup();
    client.set_min_stake(&-1000);
}

// ── create_pool authorization ──────────────────────────────────────────────────

#[test]
fn test_admin_can_create_pool() {
    let (env, admin, client) = setup();
    let wasm_hash = dummy_hash(&env);
    client.set_arena_wasm_hash(&wasm_hash);
    let creator = Address::generate(&env);
    let stake = MIN_STAKE + 1_000_000;
    client.create_pool(&admin, &creator, &1u32, &8u32, &stake);
}

#[test]
fn test_whitelisted_host_can_create_pool() {
    let (env, _admin, client) = setup();
    let host = Address::generate(&env);
    client.add_to_whitelist(&host);

    let wasm_hash = dummy_hash(&env);
    client.set_arena_wasm_hash(&wasm_hash);
    let creator = Address::generate(&env);
    let stake = MIN_STAKE + 1_000_000;
    client.create_pool(&host, &creator, &1u32, &8u32, &stake);
}

#[test]
#[should_panic(expected = "caller is not authorized to create pools")]
fn test_unauthorized_caller_cannot_create_pool() {
    let (env, _admin, client) = setup();
    let wasm_hash = dummy_hash(&env);
    client.set_arena_wasm_hash(&wasm_hash);
    let unauthorized = Address::generate(&env);
    let creator = Address::generate(&env);
    let stake = MIN_STAKE + 1_000_000;
    client.create_pool(&unauthorized, &creator, &1u32, &8u32, &stake);
}

// ── create_pool stake validation ────────────────────────────────────────────────

#[test]
fn test_create_pool_with_stake_equal_to_minimum_succeeds() {
    let (env, admin, client) = setup();
    let wasm_hash = dummy_hash(&env);
    client.set_arena_wasm_hash(&wasm_hash);
    let creator = Address::generate(&env);
    client.create_pool(&admin, &creator, &1u32, &8u32, &MIN_STAKE);
}

#[test]
#[should_panic(expected = "stake amount")]
fn test_create_pool_with_stake_below_minimum_panics() {
    let (env, admin, client) = setup();
    let wasm_hash = dummy_hash(&env);
    client.set_arena_wasm_hash(&wasm_hash);
    let creator = Address::generate(&env);
    let stake = MIN_STAKE - 1;
    client.create_pool(&admin, &creator, &1u32, &8u32, &stake);
}

#[test]
#[should_panic(expected = "stake amount")]
fn test_create_pool_with_zero_stake_panics() {
    let (env, admin, client) = setup();
    let wasm_hash = dummy_hash(&env);
    client.set_arena_wasm_hash(&wasm_hash);
    let creator = Address::generate(&env);
    client.create_pool(&admin, &creator, &1u32, &8u32, &0);
}

#[test]
#[should_panic(expected = "stake amount")]
fn test_create_pool_with_negative_stake_panics() {
    let (env, admin, client) = setup();
    let wasm_hash = dummy_hash(&env);
    client.set_arena_wasm_hash(&wasm_hash);
    let creator = Address::generate(&env);
    client.create_pool(&admin, &creator, &1u32, &8u32, &-1000);
}

#[test]
#[should_panic(expected = "arena WASM hash not set")]
fn test_create_pool_without_wasm_hash_panics() {
    let (env, admin, client) = setup();
    let creator = Address::generate(&env);
    let stake = MIN_STAKE + 1_000_000;
    client.create_pool(&admin, &creator, &1u32, &8u32, &stake);
}

// ── create_pool capacity validation ───────────────────────────────────────────

#[test]
fn test_create_pool_with_capacity_one_succeeds() {
    let (env, admin, client) = setup();
    client.set_arena_wasm_hash(&dummy_hash(&env));
    let creator = Address::generate(&env);
    client.create_pool(&admin, &creator, &1u32, &1u32, &MIN_STAKE);
}

#[test]
fn test_create_pool_with_max_capacity_succeeds() {
    let (env, admin, client) = setup();
    client.set_arena_wasm_hash(&dummy_hash(&env));
    let creator = Address::generate(&env);
    client.create_pool(&admin, &creator, &1u32, &MAX_CAPACITY, &MIN_STAKE);
}

#[test]
#[should_panic(expected = "capacity must be at least 1")]
fn test_create_pool_with_zero_capacity_panics() {
    let (env, admin, client) = setup();
    client.set_arena_wasm_hash(&dummy_hash(&env));
    let creator = Address::generate(&env);
    client.create_pool(&admin, &creator, &1u32, &0u32, &MIN_STAKE);
}

#[test]
#[should_panic(expected = "capacity exceeds maximum allowed value")]
fn test_create_pool_exceeding_max_capacity_panics() {
    let (env, admin, client) = setup();
    client.set_arena_wasm_hash(&dummy_hash(&env));
    let creator = Address::generate(&env);
    client.create_pool(&admin, &creator, &1u32, &(MAX_CAPACITY + 1), &MIN_STAKE);
}

// ── create_pool duplicate rejection ───────────────────────────────────────────

#[test]
fn test_create_pool_with_different_ids_succeeds() {
    let (env, admin, client) = setup();
    client.set_arena_wasm_hash(&dummy_hash(&env));
    let creator = Address::generate(&env);
    client.create_pool(&admin, &creator, &1u32, &8u32, &MIN_STAKE);
    client.create_pool(&admin, &creator, &2u32, &8u32, &MIN_STAKE);
}

#[test]
#[should_panic(expected = "pool with this id already exists")]
fn test_create_pool_duplicate_id_panics() {
    let (env, admin, client) = setup();
    client.set_arena_wasm_hash(&dummy_hash(&env));
    let creator = Address::generate(&env);
    client.create_pool(&admin, &creator, &42u32, &8u32, &MIN_STAKE);
    // Second call with the same pool_id must be rejected.
    client.create_pool(&admin, &creator, &42u32, &8u32, &MIN_STAKE);
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

// ── execute_upgrade – timelock guard ─────────────────────────────────────────

#[test]
#[should_panic(expected = "malformed upgrade state")]
fn test_execute_without_proposal_panics() {
    let (_env, _admin, client) = setup();
    client.execute_upgrade();
}

#[test]
#[should_panic(expected = "timelock has not expired")]
fn test_execute_before_timelock_panics() {
    let (env, _admin, client) = setup();
    client.propose_upgrade(&dummy_hash(&env));
    // Advance only 47 h — one hour short.
    env.ledger().with_mut(|l| {
        l.timestamp += 47 * 60 * 60;
    });
    client.execute_upgrade();
}

#[test]
#[should_panic(expected = "timelock has not expired")]
fn test_execute_exactly_at_boundary_panics() {
    let (env, _admin, client) = setup();
    let propose_time = env.ledger().timestamp();
    client.propose_upgrade(&dummy_hash(&env));
    env.ledger().with_mut(|l| {
        l.timestamp = propose_time + TIMELOCK - 1;
    });
    client.execute_upgrade();
}

// ── cancel_upgrade ────────────────────────────────────────────────────────────

#[test]
#[should_panic(expected = "no pending upgrade to cancel")]
fn test_cancel_without_proposal_panics() {
    let (_env, _admin, client) = setup();
    client.cancel_upgrade();
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
#[should_panic(expected = "malformed upgrade state")]
fn test_execute_after_cancel_panics() {
    let (env, _admin, client) = setup();
    client.propose_upgrade(&dummy_hash(&env));
    client.cancel_upgrade();

    env.ledger().with_mut(|l| {
        l.timestamp += TIMELOCK + 1;
    });
    client.execute_upgrade();
}

#[test]
#[should_panic(expected = "no pending upgrade to cancel")]
fn test_double_cancel_panics() {
    let (env, _admin, client) = setup();
    client.propose_upgrade(&dummy_hash(&env));
    client.cancel_upgrade();
    client.cancel_upgrade(); // second cancel must panic
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

// ── Admin access control tests ────────────────────────────────────────────────

#[test]
fn test_set_admin_changes_admin() {
    let (env, _admin, client) = setup();
    let new_admin = Address::generate(&env);
    client.set_admin(&new_admin);
    assert_eq!(client.admin(), new_admin);
}

#[test]
#[should_panic(expected = "not initialized")]
fn test_set_admin_fails_without_admin() {
    let env = Env::default();
    let contract_id = env.register(FactoryContract, ());
    let client = FactoryContractClient::new(&env, &contract_id);
    let new_admin = Address::generate(&env);
    client.set_admin(&new_admin);
}

#[test]
#[should_panic(expected = "authorize")]
fn test_unauthorized_propose_upgrade_panics() {
    let env = Env::default();
    let contract_id = env.register(FactoryContract, ());
    let client = FactoryContractClient::new(&env, &contract_id);
    let admin = Address::generate(&env);
    client.initialize(&admin);

    client.propose_upgrade(&dummy_hash(&env));
}

#[test]
#[should_panic(expected = "authorize")]
fn test_unauthorized_execute_upgrade_panics() {
    let env = Env::default();
    let contract_id = env.register(FactoryContract, ());
    let client = FactoryContractClient::new(&env, &contract_id);
    let admin = Address::generate(&env);
    client.initialize(&admin);

    client.execute_upgrade();
}

#[test]
#[should_panic(expected = "authorize")]
fn test_unauthorized_cancel_upgrade_panics() {
    let env = Env::default();
    let contract_id = env.register(FactoryContract, ());
    let client = FactoryContractClient::new(&env, &contract_id);
    let admin = Address::generate(&env);
    client.initialize(&admin);

    client.cancel_upgrade();
}
