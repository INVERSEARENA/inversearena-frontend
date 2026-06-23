use soroban_sdk::{Address, Env, Vec};

use crate::errors::ArenaError;
use crate::storage::DataKey;
use crate::types::{ArenaConfig, ArenaState, ArenaStatus, Choice, PlayerInfo};

/// Start a new round for an active arena.
/// Only callable when the arena is Active and no round is in progress.
pub fn start_round(
    env: &Env,
    arena_id: u64,
    state: &mut ArenaState,
    config: &ArenaConfig,
) -> Result<(), ArenaError> {
    if state.status != ArenaStatus::Active {
        return Err(ArenaError::ArenaNotActive);
    }

    state.current_round += 1;
    state.round_deadline = env.ledger().timestamp() + config.round_duration;
    state.status = ArenaStatus::Active;

    env.storage()
        .persistent()
        .set(&DataKey::ArenaState(arena_id), state);

    Ok(())
}

/// Submit a choice for the current round.
pub fn submit_choice(
    env: &Env,
    arena_id: u64,
    player: &Address,
    choice: Choice,
    state: &ArenaState,
) -> Result<(), ArenaError> {
    if state.status != ArenaStatus::Active {
        return Err(ArenaError::ArenaNotActive);
    }
    if choice == Choice::None {
        return Err(ArenaError::InvalidChoice);
    }
    if env.ledger().timestamp() > state.round_deadline {
        return Err(ArenaError::RoundDeadlinePassed);
    }

    let key = DataKey::PlayerInfo(arena_id, player.clone());
    let mut info: PlayerInfo = env
        .storage()
        .persistent()
        .get(&key)
        .ok_or(ArenaError::NotInArena)?;

    if !info.is_active {
        return Err(ArenaError::PlayerEliminated);
    }
    if info.current_choice != Choice::None {
        return Err(ArenaError::AlreadySubmitted);
    }

    info.current_choice = choice;
    env.storage().persistent().set(&key, &info);

    Ok(())
}

/// Resolve the current round: eliminate the majority, keep the minority.
/// Returns the number of eliminated players.
pub fn resolve_round(
    env: &Env,
    arena_id: u64,
    state: &mut ArenaState,
    players: &Vec<Address>,
) -> Result<u32, ArenaError> {
    if state.status != ArenaStatus::Active {
        return Err(ArenaError::ArenaNotActive);
    }
    if env.ledger().timestamp() < state.round_deadline {
        return Err(ArenaError::RoundDeadlineNotPassed);
    }

    let mut heads_count: u32 = 0;
    let mut tails_count: u32 = 0;

    // Count choices
    for player in players.iter() {
        let key = DataKey::PlayerInfo(arena_id, player.clone());
        if let Some(info) = env.storage().persistent().get::<_, PlayerInfo>(&key) {
            if info.is_active {
                match info.current_choice {
                    Choice::Heads => heads_count += 1,
                    Choice::Tails => tails_count += 1,
                    Choice::None => {} // no-choice players handled separately
                }
            }
        }
    }

    // Minority wins — eliminate the majority
    let losing_choice = if heads_count <= tails_count {
        Choice::Tails
    } else {
        Choice::Heads
    };

    let mut eliminated = 0u32;

    for player in players.iter() {
        let key = DataKey::PlayerInfo(arena_id, player.clone());
        if let Some(mut info) = env.storage().persistent().get::<_, PlayerInfo>(&key) {
            if info.is_active {
                if info.current_choice == losing_choice || info.current_choice == Choice::None {
                    info.is_active = false;
                    info.round_eliminated = state.current_round;
                    eliminated += 1;
                }
                info.current_choice = Choice::None; // reset for next round
                env.storage().persistent().set(&key, &info);
            }
        }
    }

    state.survivor_count -= eliminated;
    state.status = ArenaStatus::Active;

    // Check for winner
    if state.survivor_count <= 1 {
        state.status = ArenaStatus::Finished;
        // TODO: Find and set the winner address (Issue #XX)
    }

    env.storage()
        .persistent()
        .set(&DataKey::ArenaState(arena_id), state);

    Ok(eliminated)
}

// TODO: Implement commit-reveal scheme instead of plain choice (Issue #XX)
// TODO: Handle tie scenarios (equal heads/tails) (Issue #XX)
// TODO: Handle case where no players submit choices (Issue #XX)
// TODO: Auto-eliminate players who don't submit within deadline (Issue #XX)
