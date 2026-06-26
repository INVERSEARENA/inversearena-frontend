//! Thin persistence helpers for the RWA adapter contract.

use soroban_sdk::{Env, Symbol, symbol_short};

use crate::types::RwaConfig;
use crate::RwaError;

/// Instance-storage key for the [`RwaConfig`] struct.
const CONFIG_KEY: Symbol = symbol_short!("CONFIG");

/// Helpers for reading and writing [`RwaConfig`] from/to instance storage.
pub struct RwaStorage;

impl RwaStorage {
    /// Persist `config` to instance storage.
    pub fn save_config(env: &Env, config: &RwaConfig) {
        env.storage().instance().set(&CONFIG_KEY, config);
    }

    /// Load the stored [`RwaConfig`], or return [`RwaError::NotInitialized`].
    pub fn load_config(env: &Env) -> Result<RwaConfig, RwaError> {
        env.storage()
            .instance()
            .get(&CONFIG_KEY)
            .ok_or(RwaError::NotInitialized)
    }

    /// Return `true` if the contract has been initialised.
    pub fn is_initialized(env: &Env) -> bool {
        env.storage().instance().has(&CONFIG_KEY)
    }
}
