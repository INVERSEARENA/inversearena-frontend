use soroban_sdk::{Address, Env};

use crate::errors::ArenaError;
use crate::storage::{extend_instance_ttl, DataKey};
use crate::types::ContractConfig;

/// Verify that the caller is the contract admin.
pub fn require_admin(env: &Env, caller: &Address) -> Result<(), ArenaError> {
    let config: ContractConfig = env
        .storage()
        .instance()
        .get(&DataKey::Config)
        .ok_or(ArenaError::NotInitialized)?;

    if *caller != config.admin {
        return Err(ArenaError::Unauthorized);
    }
    caller.require_auth();
    Ok(())
}

/// Check that the contract is not paused.
pub fn require_not_paused(env: &Env) -> Result<(), ArenaError> {
    let config: ContractConfig = env
        .storage()
        .instance()
        .get(&DataKey::Config)
        .ok_or(ArenaError::NotInitialized)?;

    if config.is_paused {
        return Err(ArenaError::ContractPaused);
    }
    Ok(())
}

/// Get the current contract config.
pub fn get_config(env: &Env) -> Result<ContractConfig, ArenaError> {
    extend_instance_ttl(env);
    env.storage()
        .instance()
        .get(&DataKey::Config)
        .ok_or(ArenaError::NotInitialized)
}

// TODO: Implement set_admin for admin transfer (Issue #XX)
// TODO: Implement pause/unpause (Issue #XX)
// TODO: Implement update_platform_fee (Issue #XX)
// TODO: Implement update_config for min/max bounds (Issue #XX)
// TODO: Implement force_cancel_arena (Issue #XX)
// TODO: Implement emergency_withdraw (Issue #XX)
