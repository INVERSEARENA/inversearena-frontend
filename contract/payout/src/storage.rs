#![allow(dead_code)]
use crate::types::PayoutError;
use soroban_sdk::{contracttype, symbol_short, Address, Env};

/// Persistent record that a given payout id has been executed, enabling
/// idempotent distribution and off-chain reconciliation.
#[contracttype]
pub(crate) enum DataKey {
    Paid(u64),
}

pub struct PayoutStorage;

impl PayoutStorage {
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
        env.storage().persistent().has(&DataKey::Paid(payout_id))
    }

    pub fn mark_paid(env: &Env, payout_id: u64) {
        env.storage()
            .persistent()
            .set(&DataKey::Paid(payout_id), &true);
    }
}
