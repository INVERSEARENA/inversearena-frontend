use soroban_sdk::Env;
use crate::storage::ArenaStorage;
use crate::events::ArenaEvents;
use crate::errors::ArenaError;

pub const MAX_PLATFORM_FEE_BPS: u32 = 1000; // 10%

/// Update the global platform fee (basis points). Only the admin can call this.
///
/// The change only affects arenas created *after* this call; ongoing arenas
/// retain the fee that was snapshotted into their `ArenaConfig` at creation time.
///
/// # Validation
/// `new_fee_bps` must be in the range `0..=1000` (0–10 %).
pub fn update_platform_fee(env: &Env, new_fee_bps: u32) -> Result<(), ArenaError> {
    let config = ArenaStorage::load_config(env)?;
    config.admin.require_auth();

    if new_fee_bps > MAX_PLATFORM_FEE_BPS {
        return Err(ArenaError::InvalidPlatformFee);
    }

    ArenaStorage::set_platform_fee_bps(env, new_fee_bps);
    ArenaEvents::platform_fee_updated(env, &config.admin, new_fee_bps);

    Ok(())
}
