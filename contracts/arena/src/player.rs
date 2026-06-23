use soroban_sdk::{Address, Env};

use crate::errors::ArenaError;
use crate::storage::DataKey;
use crate::types::{PlayerInfo, PlayerProfile, Choice};

/// Register a new player profile if one doesn't exist.
pub fn ensure_profile(env: &Env, player: &Address) -> PlayerProfile {
    let key = DataKey::PlayerProfile(player.clone());
    match env.storage().persistent().get::<_, PlayerProfile>(&key) {
        Some(profile) => profile,
        None => {
            let profile = PlayerProfile {
                address: player.clone(),
                games_played: 0,
                games_won: 0,
                total_earnings: 0,
                survival_streak: 0,
                best_streak: 0,
                registered_at: env.ledger().timestamp(),
            };
            env.storage().persistent().set(&key, &profile);
            profile
        }
    }
}

/// Get player info for a specific arena.
pub fn get_player_info(
    env: &Env,
    arena_id: u64,
    player: &Address,
) -> Result<PlayerInfo, ArenaError> {
    let key = DataKey::PlayerInfo(arena_id, player.clone());
    env.storage()
        .persistent()
        .get::<_, PlayerInfo>(&key)
        .ok_or(ArenaError::NotInArena)
}

/// Create initial player info when joining an arena.
pub fn create_player_info(env: &Env, arena_id: u64, player: &Address) {
    let key = DataKey::PlayerInfo(arena_id, player.clone());
    let info = PlayerInfo {
        is_active: true,
        current_choice: Choice::None,
        round_eliminated: 0,
        has_claimed: false,
    };
    env.storage().persistent().set(&key, &info);
}

// TODO: Implement update_player_stats after game completion (Issue #XX)
// TODO: Implement get_player_profile public query (Issue #XX)
// TODO: Implement player ban check (Issue #XX)
// TODO: Implement survival streak tracking (Issue #XX)
// TODO: Implement leaderboard ranking calculation (Issue #XX)
