use soroban_sdk::{Address, Env};
use crate::errors::ArenaError;
use crate::storage::ArenaStorage;
use crate::types::GameState;

/// Validate and process a prize claim by the declared winner.
///
/// Does not transfer tokens (token integration is a separate concern); it
/// validates eligibility and marks the prize as claimed so it cannot be
/// double-claimed.
pub fn process_claim(env: &Env, claimant: &Address) -> Result<(), ArenaError> {
    let config = ArenaStorage::load_config(env)?;

    if config.state != GameState::Finished {
        return Err(ArenaError::GameNotFinished);
    }
    if ArenaStorage::is_prize_claimed(env) {
        return Err(ArenaError::PrizeAlreadyClaimed);
    }

    let winner = ArenaStorage::get_winner(env).ok_or(ArenaError::PlayerEliminated)?;
    if winner != *claimant {
        return Err(ArenaError::PlayerEliminated);
    }

    ArenaStorage::set_prize_claimed(env);
    Ok(())
}
