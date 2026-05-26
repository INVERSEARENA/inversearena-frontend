#![no_std]
use soroban_sdk::{Env, contract, contractimpl, token};

mod storage;
mod types;

use storage::ArenaStorage;
use types::{ArenaError, GameState};

/// Arena contract — manages round lifecycle, player choices, and elimination logic.
///
/// Implementation is open for contribution. See the issue tracker for:
/// - Round state machine (OPEN → CLOSED → RESOLVED → SETTLED)
/// - Commit-reveal choice submission
/// - Minority-wins elimination logic
/// - Admin controls and upgrade timelock
///
/// Architecture overview: see `ARCHITECTURE.md` in the workspace root.
#[contract]
pub struct ArenaContract;

#[contractimpl]
impl ArenaContract {
    /// Cancel an open arena and refund all joined players their entry fee.
    ///
    /// Only callable by the arena admin, and only while the game is still in
    /// `Open` state (i.e. before the first round starts). State is written to
    /// `Cancelled` *before* any token transfers to guard against re-entrancy.
    pub fn cancel_arena(env: Env) -> Result<(), ArenaError> {
        let mut config = ArenaStorage::load_config(&env)?;

        // Require the caller to be the registered admin
        config.admin.require_auth();

        // Guard: cannot cancel a game that has already started
        if config.state != GameState::Open {
            return Err(ArenaError::CannotCancelStartedGame);
        }

        // Transition state first — reentrancy protection
        config.state = GameState::Cancelled;
        ArenaStorage::save_config(&env, &config);

        // Refund every joined player
        let token_client = token::TokenClient::new(&env, &config.stake_token);
        let players = ArenaStorage::load_all_players(&env);
        for player in players.iter() {
            token_client.transfer(&env.current_contract_address(), &player, &config.entry_fee);
            env.events().publish(
                (soroban_sdk::symbol_short!("refunded"), player.clone()),
                config.entry_fee,
            );
        }

        // Top-level cancellation event
        env.events()
            .publish((soroban_sdk::symbol_short!("cancelled"),), ());

        Ok(())
    }
}
