use soroban_sdk::Env;
use crate::errors::ArenaError;
use crate::storage::ArenaStorage;
use crate::types::GameState;

/// Assert that the contract has been initialized.
pub fn require_initialized(env: &Env) -> Result<(), ArenaError> {
    ArenaStorage::load_config(env)?;
    Ok(())
}

/// Assert that the game is in Open (not yet started) state.
pub fn require_open(env: &Env) -> Result<(), ArenaError> {
    let config = ArenaStorage::load_config(env)?;
    if config.state != GameState::Open {
        return Err(ArenaError::ArenaAlreadyStarted);
    }
    Ok(())
}

/// Assert that the game is currently in progress.
pub fn require_in_progress(env: &Env) -> Result<(), ArenaError> {
    let config = ArenaStorage::load_config(env)?;
    if config.state != GameState::InProgress {
        return Err(ArenaError::InvalidStateTransition);
    }
    Ok(())
}

/// Assert that the game has finished.
pub fn require_finished(env: &Env) -> Result<(), ArenaError> {
    let config = ArenaStorage::load_config(env)?;
    if config.state != GameState::Finished {
        return Err(ArenaError::GameNotFinished);
    }
    Ok(())
}
