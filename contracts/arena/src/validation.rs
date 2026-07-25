use crate::errors::ArenaError;

/// Maximum allowed players per arena to keep round resolution within
/// Soroban instruction limits (#1086).
pub const MAX_PLAYERS_ALLOWED: u32 = 100;

/// Validate that an entry fee is within the configured contract bounds.
pub fn validate_entry_fee(entry_fee: i128) -> Result<(), ArenaError> {
    if entry_fee <= 0 {
        return Err(ArenaError::InvalidEntryFee);
    }
    Ok(())
}

/// Validate that a join deadline is strictly in the future.
pub fn validate_deadline(deadline: u64, now: u64) -> Result<(), ArenaError> {
    if deadline <= now {
        return Err(ArenaError::DeadlineTooSoon);
    }
    Ok(())
}

/// Validate that a deposit or stake amount is strictly positive.
pub fn validate_positive_amount(amount: i128) -> Result<(), ArenaError> {
    if amount <= 0 {
        return Err(ArenaError::InvalidEntryFee);
    }
    Ok(())
}

/// Validate max_players does not exceed the safe limit for Soroban
/// transaction instruction budgets (#1086).
pub fn validate_max_players(max_players: u32) -> Result<(), ArenaError> {
    if max_players == 0 || max_players > MAX_PLAYERS_ALLOWED {
        return Err(ArenaError::InvalidEntryFee);
    }
    Ok(())
}
