use soroban_sdk::{Address, Env};
use crate::errors::ArenaError;
use crate::storage::ArenaStorage;

/// Check that a player is registered (joined) and currently active.
pub fn require_active_player(env: &Env, player: &Address) -> Result<(), ArenaError> {
    let players = ArenaStorage::load_all_players(env);
    if !players.contains(player) {
        return Err(ArenaError::NotAPlayer);
    }
    if !ArenaStorage::is_player_active(env, player) {
        return Err(ArenaError::PlayerEliminated);
    }
    Ok(())
}

/// Check whether a player has already submitted a choice this round.
pub fn has_submitted(env: &Env, player: &Address) -> bool {
    ArenaStorage::load_player_choice(env, player).is_some()
}
