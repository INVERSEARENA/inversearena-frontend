use crate::errors::ArenaError;

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
