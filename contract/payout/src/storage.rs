#![allow(dead_code)]
use crate::types::PayoutError;
use soroban_sdk::{Address, Env, contracttype, symbol_short};

/// Persistent record that a given payout id has been executed, enabling
/// idempotent distribution and off-chain reconciliation.
#[contracttype]
pub(crate) enum DataKey {
    Paid(u64),
}

// ~6 months in ledgers (assuming 5s per ledger)
const PAYOUT_TTL_THRESHOLD: u32 = 3_153_600;
// ~1 year in ledgers
const PAYOUT_TTL_EXTEND_TO: u32 = 6_307_200;

pub struct PayoutStorage;

impl PayoutStorage {
    fn extend_paid_ttl(env: &Env, payout_id: u64) {
        let key = DataKey::Paid(payout_id);
        if env.storage().persistent().has(&key) {
            env.storage().persistent().extend_ttl(
                &key,
                PAYOUT_TTL_THRESHOLD,
                PAYOUT_TTL_EXTEND_TO,
            );
        }
    }

    pub fn has_admin(env: &Env) -> bool {
        env.storage().instance().has(&symbol_short!("ADMIN"))
    }

    pub fn set_admin(env: &Env, admin: &Address) {
        env.storage().instance().set(&symbol_short!("ADMIN"), admin);
    }

    pub fn get_admin(env: &Env) -> Result<Address, PayoutError> {
        env.storage()
            .instance()
            .get(&symbol_short!("ADMIN"))
            .ok_or(PayoutError::NotInitialised)
    }

    pub fn set_token(env: &Env, token: &Address) {
        env.storage().instance().set(&symbol_short!("TOKEN"), token);
    }

    pub fn get_token(env: &Env) -> Result<Address, PayoutError> {
        env.storage()
            .instance()
            .get(&symbol_short!("TOKEN"))
            .ok_or(PayoutError::NotInitialised)
    }

    pub fn is_paid(env: &Env, payout_id: u64) -> bool {
        Self::extend_paid_ttl(env, payout_id);
        env.storage().persistent().has(&DataKey::Paid(payout_id))
    }

    pub fn mark_paid(env: &Env, payout_id: u64) {
        env.storage()
            .persistent()
            .set(&DataKey::Paid(payout_id), &true);
        Self::extend_paid_ttl(env, payout_id);
    }
}
