#![allow(dead_code)]
use crate::types::PayoutError;
use soroban_sdk::{Address, Env, contracttype};

/// Minimum ledgers remaining before we extend a persistent entry's TTL
/// (~30 days at 5 s/ledger).
const PERSISTENT_TTL_THRESHOLD: u32 = 518_400;
/// Target TTL for persistent entries after extension (~1 year at 5 s/ledger).
const PERSISTENT_TTL_TARGET: u32 = 6_307_200;

/// Storage keys.
///
/// `Admin` and `Token` are persistent (not instance) so they share the same
/// TTL domain as `Paid` records — preventing a scenario where the contract
/// instance expires and admin/token disappear while paid records survive as
/// orphans (issue #1026).
#[contracttype]
pub(crate) enum DataKey {
    Admin,
    PendingAdmin,
    Token,
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
            env.storage()
                .persistent()
                .extend_ttl(&key, PAYOUT_TTL_THRESHOLD, PAYOUT_TTL_EXTEND_TO);
        }
    }

    pub fn has_admin(env: &Env) -> bool {
        env.storage().persistent().has(&DataKey::Admin)
    }

    pub fn set_admin(env: &Env, admin: &Address) {
        env.storage().persistent().set(&DataKey::Admin, admin);
        env.storage().persistent().extend_ttl(
            &DataKey::Admin,
            PERSISTENT_TTL_THRESHOLD,
            PERSISTENT_TTL_TARGET,
        );
    }

    pub fn get_admin(env: &Env) -> Result<Address, PayoutError> {
        let key = DataKey::Admin;
        let admin = env
            .storage()
            .persistent()
            .get(&key)
            .ok_or(PayoutError::NotInitialised)?;
        env.storage().persistent().extend_ttl(
            &key,
            PERSISTENT_TTL_THRESHOLD,
            PERSISTENT_TTL_TARGET,
        );
        Ok(admin)
    }

    pub fn save_pending_admin(env: &Env, admin: &Address) {
        let key = DataKey::PendingAdmin;
        env.storage().persistent().set(&key, admin);
        env.storage().persistent().extend_ttl(
            &key,
            PERSISTENT_TTL_THRESHOLD,
            PERSISTENT_TTL_TARGET,
        );
    }

    pub fn load_pending_admin(env: &Env) -> Option<Address> {
        let key = DataKey::PendingAdmin;
        let val = env.storage().persistent().get(&key);
        if val.is_some() {
            env.storage().persistent().extend_ttl(
                &key,
                PERSISTENT_TTL_THRESHOLD,
                PERSISTENT_TTL_TARGET,
            );
        }
        val
    }

    pub fn delete_pending_admin(env: &Env) {
        env.storage()
            .persistent()
            .remove(&DataKey::PendingAdmin);
    }

    pub fn set_token(env: &Env, token: &Address) {
        env.storage().persistent().set(&DataKey::Token, token);
        env.storage().persistent().extend_ttl(
            &DataKey::Token,
            PERSISTENT_TTL_THRESHOLD,
            PERSISTENT_TTL_TARGET,
        );
    }

    pub fn get_token(env: &Env) -> Result<Address, PayoutError> {
        let key = DataKey::Token;
        let token = env
            .storage()
            .persistent()
            .get(&key)
            .ok_or(PayoutError::NotInitialised)?;
        env.storage().persistent().extend_ttl(
            &key,
            PERSISTENT_TTL_THRESHOLD,
            PERSISTENT_TTL_TARGET,
        );
        Ok(token)
    }

    pub fn is_paid(env: &Env, payout_id: u64) -> bool {
        Self::extend_paid_ttl(env, payout_id);
        env.storage().persistent().has(&DataKey::Paid(payout_id))
    }

    pub fn mark_paid(env: &Env, payout_id: u64) {
        let key = DataKey::Paid(payout_id);
        env.storage().persistent().set(&key, &true);
        env.storage().persistent().extend_ttl(
            &key,
            PERSISTENT_TTL_THRESHOLD,
            PERSISTENT_TTL_TARGET,
        );
    }
}
