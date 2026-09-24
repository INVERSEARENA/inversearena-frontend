#![allow(dead_code)]
use crate::types::PayoutError;
use soroban_sdk::{Address, Env, contracttype, IntoVal, TryFromVal};

pub trait StorageRepository<K, V> {
    fn has(env: &Env, key: &K) -> bool;
    fn get(env: &Env, key: &K) -> Option<V>;
    fn set(env: &Env, key: &K, val: &V);
    fn remove(env: &Env, key: &K);
}

pub trait TtlRepository<K> {
    fn extend_ttl(env: &Env, key: &K, threshold: u32, extend_to: u32);
}

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


pub struct PayoutRepository<'a> {
    env: &'a Env,
}

impl<'a> PayoutRepository<'a> {
    pub fn new(env: &'a Env) -> Self {
        PayoutRepository { env }
    }
}

impl StorageRepository<DataKey, Address> for PayoutRepository<'_> {
    fn has(env: &Env, key: &DataKey) -> bool {
        env.storage().persistent().has(key)
    }

    fn get(env: &Env, key: &DataKey) -> Option<Address> {
        env.storage().persistent().get(key)
    }

    fn set(env: &Env, key: &DataKey, val: &Address) {
        env.storage().persistent().set(key, val);
    }

    fn remove(env: &Env, key: &DataKey) {
        env.storage().persistent().remove(key);
    }
}

// For DataKey::Paid which stores a bool
impl StorageRepository<DataKey, bool> for PayoutRepository<'_> {
    fn has(env: &Env, key: &DataKey) -> bool {
        env.storage().persistent().has(key)
    }

    fn get(env: &Env, key: &DataKey) -> Option<bool> {
        env.storage().persistent().get(key)
    }

    fn set(env: &Env, key: &DataKey, val: &bool) {
        env.storage().persistent().set(key, val);
    }

    fn remove(env: &Env, key: &DataKey) {
        env.storage().persistent().remove(key);
    }
}


impl TtlRepository<DataKey> for PayoutRepository<'_> {
    fn extend_ttl(env: &Env, key: &DataKey, threshold: u32, extend_to: u32) {
        if env.storage().persistent().has(key) {
            env.storage().persistent().extend_ttl(key, threshold, extend_to);
        }
    }
}

pub struct PayoutStorage;

impl PayoutStorage {
    fn extend_paid_ttl(env: &Env, payout_id: u64) {
        PayoutRepository::new(env).extend_ttl(&DataKey::Paid(payout_id), PAYOUT_TTL_THRESHOLD, PAYOUT_TTL_EXTEND_TO);
    }

    pub fn has_admin(env: &Env) -> bool {
        PayoutRepository::new(env).has(&DataKey::Admin)
    }

    pub fn set_admin(env: &Env, admin: &Address) {
        let repo = PayoutRepository::new(env);
        repo.set(&DataKey::Admin, admin);
        repo.extend_ttl(
            &DataKey::Admin,
            PERSISTENT_TTL_THRESHOLD,
            PERSISTENT_TTL_TARGET,
        );
    }

    pub fn get_admin(env: &Env) -> Result<Address, PayoutError> {
        let repo = PayoutRepository::new(env);
        let key = DataKey::Admin;
        let admin = repo
            .get(&key)
            .ok_or(PayoutError::NotInitialised)?;
        repo.extend_ttl(
            &key,
            PERSISTENT_TTL_THRESHOLD,
            PERSISTENT_TTL_TARGET,
        );
        Ok(admin)
    }

    pub fn save_pending_admin(env: &Env, admin: &Address) {
        let repo = PayoutRepository::new(env);
        let key = DataKey::PendingAdmin;
        repo.set(&key, admin);
        repo.extend_ttl(
            &key,
            PERSISTENT_TTL_THRESHOLD,
            PERSISTENT_TTL_TARGET,
        );
    }

    pub fn load_pending_admin(env: &Env) -> Option<Address> {
        let repo = PayoutRepository::new(env);
        let key = DataKey::PendingAdmin;
        let val = repo.get(&key);
        if val.is_some() {
            repo.extend_ttl(
                &key,
                PERSISTENT_TTL_THRESHOLD,
                PERSISTENT_TTL_TARGET,
            );
        }
        val
    }

    pub fn delete_pending_admin(env: &Env) {
        PayoutRepository::new(env).remove(&DataKey::PendingAdmin);
    }

    pub fn set_token(env: &Env, token: &Address) {
        let repo = PayoutRepository::new(env);
        repo.set(&DataKey::Token, token);
        repo.extend_ttl(
            &DataKey::Token,
            PERSISTENT_TTL_THRESHOLD,
            PERSISTENT_TTL_TARGET,
        );
    }

    pub fn get_token(env: &Env) -> Result<Address, PayoutError> {
        let repo = PayoutRepository::new(env);
        let key = DataKey::Token;
        let token = repo
            .get(&key)
            .ok_or(PayoutError::NotInitialised)?;
        repo.extend_ttl(
            &key,
            PERSISTENT_TTL_THRESHOLD,
            PERSISTENT_TTL_TARGET,
        );
        Ok(token)
    }

    pub fn is_paid(env: &Env, payout_id: u64) -> bool {
        let repo = PayoutRepository::new(env);
        repo.extend_ttl( &DataKey::Paid(payout_id), PAYOUT_TTL_THRESHOLD, PAYOUT_TTL_EXTEND_TO);
        repo.has(&DataKey::Paid(payout_id))
    }

    pub fn mark_paid(env: &Env, payout_id: u64) {
        let repo = PayoutRepository::new(env);
        let key = DataKey::Paid(payout_id);
        repo.set(&key, &true);
        repo.extend_ttl(
            &key,
            PERSISTENT_TTL_THRESHOLD,
            PERSISTENT_TTL_TARGET,
        );
    }
}
