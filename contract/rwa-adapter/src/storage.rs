use soroban_sdk::{Address, Env, contracttype, symbol_short};

const DEFAULT: &str = "DEFAULT";

#[contracttype]
pub enum DataKey {
    Admin,
    Vault,
    Token,
    TotalDeposited,
}

pub struct RwaStorage;

impl RwaStorage {
    pub fn has_admin(env: &Env) -> bool {
        env.storage().persistent().has(&DataKey::Admin)
    }

    pub fn set_admin(env: &Env, admin: &Address) {
        env.storage().persistent().set(&DataKey::Admin, admin);
    }

    pub fn get_admin(env: &Env) -> Address {
        env.storage().persistent().get(&DataKey::Admin).unwrap()
    }

    pub fn set_vault(env: &Env, vault: &Address) {
        env.storage().persistent().set(&DataKey::Vault, vault);
    }

    pub fn get_vault(env: &Env) -> Address {
        env.storage().persistent().get(&DataKey::Vault).unwrap()
    }

    pub fn set_token(env: &Env, token: &Address) {
        env.storage().persistent().set(&DataKey::Token, token);
    }

    pub fn get_token(env: &Env) -> Address {
        env.storage().persistent().get(&DataKey::Token).unwrap()
    }

    pub fn get_total_deposited(env: &Env) -> i128 {
        env.storage()
            .persistent()
            .get(&DataKey::TotalDeposited)
            .unwrap_or(0)
    }

    pub fn add_deposited(env: &Env, amount: i128) {
        let current = Self::get_total_deposited(env);
        env.storage()
            .persistent()
            .set(&DataKey::TotalDeposited, &current.checked_add(amount).unwrap());
    }

    pub fn sub_deposited(env: &Env, amount: i128) {
        let current = Self::get_total_deposited(env);
        env.storage()
            .persistent()
            .set(
                &DataKey::TotalDeposited,
                &current.checked_sub(amount).unwrap(),
            );
    }

    /// Timelock deadline for vault address upgrade (48h from set).
    pub fn get_timelock_deadline(env: &Env) -> Option<u64> {
        env.storage().persistent().get(&symbol_short!("TMLOCK"))
    }

    pub fn set_timelock_deadline(env: &Env, deadline: u64) {
        env.storage()
            .persistent()
            .set(&symbol_short!("TMLOCK"), &deadline);
    }

    pub fn clear_timelock(env: &Env) {
        env.storage().persistent().remove(&symbol_short!("TMLOCK"));
    }

    /// Pending vault address to be applied after timelock.
    pub fn get_pending_vault(env: &Env) -> Option<Address> {
        env.storage().persistent().get(&symbol_short!("PVAULT"))
    }

    pub fn set_pending_vault(env: &Env, vault: &Address) {
        env.storage()
            .persistent()
            .set(&symbol_short!("PVAULT"), vault);
    }
}

// Silence unused warnings
const _: &str = DEFAULT;
