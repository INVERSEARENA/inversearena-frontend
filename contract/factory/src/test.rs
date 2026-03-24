#[cfg(test)]
use super::*;
use soroban_sdk::{
    testutils::{Address as _, Ledger},
    Address, BytesN, Env,
};

const TIMELOCK: u64 = 48 * 60 * 60; // 48 hours

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
#[should_panic(expected = "no pending upgrade")]
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
#[should_panic(expected = "no pending upgrade")]
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
