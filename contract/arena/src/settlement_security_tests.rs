//! Regression tests for settlement security: expiry griefing (#1627) and
//! fail-closed vault withdrawals (#1631).

#![cfg(test)]

use super::*;
use ::oracle::{OracleContract, OracleContractClient};
use soroban_sdk::{
    Address, Env, contract, contractimpl, symbol_short,
    testutils::{Address as _, Ledger as _},
    token::StellarAssetClient,
};

const STUCK: soroban_sdk::Symbol = symbol_short!("STUCK");

/// Vault stub whose `withdraw_all` can be toggled to refuse. While stuck it
/// panics, which `try_withdraw_all` reports as a failed call.
#[contract]
struct StuckVault;

#[contractimpl]
impl StuckVault {
    pub fn set_stuck(env: Env, stuck: bool) {
        env.storage().instance().set(&STUCK, &stuck);
    }

    pub fn deposit(_env: Env, _from: Address, _amount: i128) {}

    /// Reports a live deposit so the arena attempts a withdrawal at settlement.
    pub fn balance_of(_env: Env, _user: Address) -> i128 {
        100
    }

    pub fn withdraw(_env: Env, _user: Address, amount: i128) -> i128 {
        amount
    }

    pub fn withdraw_all(env: Env, _user: Address) -> i128 {
        if env.storage().instance().get(&STUCK).unwrap_or(false) {
            panic!("vault refuses withdrawal");
        }
        100
    }

    pub fn get_total_deposited(_env: Env) -> i128 {
        0
    }
}

struct Harness {
    env: Env,
    arena: ArenaContractClient<'static>,
    arena_id: Address,
    token: soroban_sdk::token::TokenClient<'static>,
    vault: StuckVaultClient<'static>,
    players: std::vec::Vec<Address>,
}

/// Two joined players and an `Active` round that commits at `1000 + 60`.
fn active_arena() -> Harness {
    let env = Env::default();
    env.mock_all_auths_allowing_non_root_auth();

    let admin = Address::generate(&env);
    let token_admin = Address::generate(&env);
    let token_id = env.register_stellar_asset_contract_v2(token_admin).address();
    let token = soroban_sdk::token::TokenClient::new(&env, &token_id);
    let mint = StellarAssetClient::new(&env, &token_id);

    let players: std::vec::Vec<Address> = (0..2).map(|_| Address::generate(&env)).collect();
    for p in &players {
        mint.mint(p, &100);
    }

    let oracle_id = env.register(OracleContract, ());
    OracleContractClient::new(&env, &oracle_id).initialize(&admin, &0);

    let vault_id = env.register(StuckVault, ());
    let vault = StuckVaultClient::new(&env, &vault_id);
    vault.set_stuck(&false);

    let arena_id = env.register(ArenaContract, ());
    let arena = ArenaContractClient::new(&env, &arena_id);
    arena.initialize(
        &admin,
        &token_id,
        &vault_id,
        &100,
        &oracle_id,
        &Address::generate(&env),
        &1,
        &2,
        &10,
        &60,
    );
    for p in &players {
        arena.join_arena(p);
    }

    env.ledger().with_mut(|li| li.timestamp = 1000);
    arena.start_round(&60);

    Harness {
        env,
        arena,
        arena_id,
        token,
        vault,
        players,
    }
}

fn set_time(env: &Env, timestamp: u64) {
    env.ledger().with_mut(|li| li.timestamp = timestamp);
}

// ── #1627: expiry must not open at the commit deadline ─────────────────────

#[test]
fn stranger_cannot_expire_one_ledger_after_commit_deadline() {
    let h = active_arena();
    // commit_deadline = 1060. This is the window reveals and resolution use.
    set_time(&h.env, 1061);
    assert_eq!(
        h.arena.try_expire_arena(),
        Err(Ok(ArenaError::DeadlineTooSoon)),
    );
    h.env.as_contract(&h.arena_id, || {
        let config = ArenaStorage::load_config(&h.env).unwrap();
        assert_eq!(config.state, GameState::Active);
    });
}

#[test]
fn expire_stays_closed_through_the_whole_grace_window() {
    let h = active_arena();
    // Exactly at commit_deadline + EXPIRY_GRACE_SECONDS the window is still shut.
    set_time(&h.env, 1060 + EXPIRY_GRACE_SECONDS);
    assert_eq!(
        h.arena.try_expire_arena(),
        Err(Ok(ArenaError::DeadlineTooSoon)),
    );
}

#[test]
fn expire_opens_one_second_after_the_grace_window() {
    let h = active_arena();
    set_time(&h.env, 1060 + EXPIRY_GRACE_SECONDS + 1);
    assert!(h.arena.try_expire_arena().is_ok());
    assert!(!h.arena.funds_in_vault());
}

// ── #1631: fail closed when the vault refuses to release principal ────────

#[test]
fn expire_with_stuck_vault_flags_principal_and_blocks_refunds() {
    let h = active_arena();
    h.vault.set_stuck(&true);
    set_time(&h.env, 1060 + EXPIRY_GRACE_SECONDS + 1);

    assert!(h.arena.try_expire_arena().is_ok());
    assert!(h.arena.funds_in_vault());
    for p in &h.players {
        assert_eq!(
            h.arena.try_claim_refund(p),
            Err(Ok(ArenaError::FundsInVault)),
        );
    }
    assert_eq!(h.token.balance(&h.arena_id), 200);
}

#[test]
fn force_cancel_with_stuck_vault_blocks_refunds_until_retry_succeeds() {
    let h = active_arena();
    h.vault.set_stuck(&true);

    h.arena.force_cancel_arena();
    assert!(h.arena.funds_in_vault());
    assert_eq!(
        h.arena.try_claim_refund(&h.players[0]),
        Err(Ok(ArenaError::FundsInVault)),
    );

    // Still stuck: the retry reports the vault failure and the flag stays set.
    assert_eq!(
        h.arena.try_retry_withdraw(),
        Err(Ok(ArenaError::VaultWithdrawFailed)),
    );
    assert!(h.arena.funds_in_vault());

    // The vault recovers: the retry clears the flag and refunds resume.
    h.vault.set_stuck(&false);
    assert!(h.arena.try_retry_withdraw().is_ok());
    assert!(!h.arena.funds_in_vault());
    for p in &h.players {
        assert!(h.arena.try_claim_refund(p).is_ok());
    }
}

#[test]
fn retry_withdraw_is_idempotent_once_nothing_is_pending() {
    let h = active_arena();
    h.arena.force_cancel_arena();
    assert!(!h.arena.funds_in_vault());

    // Nothing pending: the retry succeeds without touching the vault.
    h.vault.set_stuck(&true);
    assert!(h.arena.try_retry_withdraw().is_ok());
    assert!(h.arena.try_retry_withdraw().is_ok());
    assert!(!h.arena.funds_in_vault());
}

#[test]
fn retry_withdraw_rejected_while_arena_is_still_active() {
    let h = active_arena();
    assert_eq!(
        h.arena.try_retry_withdraw(),
        Err(Ok(ArenaError::InvalidGameState)),
    );
}
