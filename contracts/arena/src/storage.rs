use soroban_sdk::{Env, Symbol};
use crate::types::ArenaConfig;
use crate::errors::ArenaError;

const CONFIG_KEY: Symbol = Symbol::short("CONFIG");

pub struct ArenaStorage;

impl ArenaStorage {
    /// Save arena configuration to storage
    pub fn save_config(env: &Env, config: &ArenaConfig) {
        env.storage().instance().set(&CONFIG_KEY, config);
    }

    /// Load arena configuration from storage
    pub fn load_config(env: &Env) -> Result<ArenaConfig, ArenaError> {
        env.storage()
            .instance()
            .get(&CONFIG_KEY)
            .ok_or(ArenaError::ConfigNotFound)
    }
}
