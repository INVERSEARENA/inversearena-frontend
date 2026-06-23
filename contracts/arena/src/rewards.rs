use soroban_sdk::{Address, Env};

use crate::errors::ArenaError;
use crate::storage::DataKey;
use crate::types::{ArenaState, ArenaStatus, ContractConfig, PlayerInfo};

/// Calculate the winner's prize after platform fee deduction.
pub fn calculate_prize(total_pot: i128, platform_fee_bps: u32) -> (i128, i128) {
    let fee = (total_pot * platform_fee_bps as i128) / 10_000;
    let prize = total_pot - fee;
    (prize, fee)
}

/// Claim winnings as the winner of a finished arena.
pub fn claim_winnings(
    env: &Env,
    arena_id: u64,
    player: &Address,
    state: &ArenaState,
    config: &ContractConfig,
) -> Result<i128, ArenaError> {
    if state.status != ArenaStatus::Finished {
        return Err(ArenaError::ArenaNotActive);
    }
    if *player != state.winner {
        return Err(ArenaError::NotWinner);
    }

    let key = DataKey::PlayerInfo(arena_id, player.clone());
    let mut info: PlayerInfo = env
        .storage()
        .persistent()
        .get(&key)
        .ok_or(ArenaError::NotInArena)?;

    if info.has_claimed {
        return Err(ArenaError::AlreadyClaimed);
    }

    let (prize, _fee) = calculate_prize(state.total_pot, config.platform_fee_bps);

    info.has_claimed = true;
    env.storage().persistent().set(&key, &info);

    // TODO: Transfer prize to winner via token contract (Issue #XX)
    // TODO: Transfer platform fee to admin/treasury (Issue #XX)

    Ok(prize)
}

/// Claim a refund from a cancelled arena.
pub fn claim_refund(
    env: &Env,
    arena_id: u64,
    player: &Address,
    state: &ArenaState,
) -> Result<i128, ArenaError> {
    if state.status != ArenaStatus::Cancelled {
        return Err(ArenaError::InvalidStatusTransition);
    }

    let key = DataKey::PlayerInfo(arena_id, player.clone());
    let mut info: PlayerInfo = env
        .storage()
        .persistent()
        .get(&key)
        .ok_or(ArenaError::NotInArena)?;

    if info.has_claimed {
        return Err(ArenaError::AlreadyClaimed);
    }
    if !info.is_active && info.round_eliminated > 0 {
        return Err(ArenaError::NothingToClaim);
    }

    // Refund the entry fee
    let config: crate::types::ArenaConfig = env
        .storage()
        .persistent()
        .get(&DataKey::ArenaConfig(arena_id))
        .ok_or(ArenaError::ArenaNotFound)?;

    info.has_claimed = true;
    env.storage().persistent().set(&key, &info);

    // TODO: Transfer refund via token contract (Issue #XX)

    Ok(config.entry_fee)
}

// TODO: Implement partial refund for eliminated players in cancelled arenas (Issue #XX)
// TODO: Implement creator stake slash on cancel (Issue #XX)
// TODO: Implement yield distribution from RWA adapter (Issue #XX)
