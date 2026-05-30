#![no_std]

mod storage;
mod types;
mod events;
mod errors;

#[cfg(test)]
mod test;

use soroban_sdk::{contract, contractimpl, Address, Env};
use storage::ArenaStorage;
use types::{ArenaConfig, GameState};
use events::ArenaEvents;
use errors::ArenaError;

#[contract]
pub struct ArenaContract;

#[contractimpl]
impl ArenaContract {
    /// Initialize the arena with initial configuration
    pub fn initialize(
        env: Env,
        admin: Address,
        entry_fee: i128,
        max_players: u32,
        join_deadline: u64,
    ) -> Result<(), ArenaError> {
        // Validate inputs
        if entry_fee <= 0 {
            return Err(ArenaError::InvalidEntryFee);
        }

        let now = env.ledger().timestamp();
        if join_deadline <= now {
            return Err(ArenaError::DeadlineTooSoon);
        }

        // Create initial configuration
        let config = ArenaConfig {
            admin: admin.clone(),
            entry_fee,
            max_players,
            join_deadline,
            state: GameState::Open,
            player_count: 0,
        };

        // Save configuration
        ArenaStorage::save_config(&env, &config);

        // Emit initialization event
        ArenaEvents::arena_initialized(&env, &admin);

        Ok(())
    }

    /// Configure arena parameters before game starts
    /// 
    /// This function allows the admin to update arena parameters after initialization
    /// but before the game starts. This provides flexibility to adjust settings based
    /// on player adoption rates, market conditions, or operational requirements.
    /// 
    /// # Parameters
    /// - `new_entry_fee`: Optional new entry fee in stroops (must be > 0)
    /// - `new_max_players`: Optional new maximum player capacity
    /// - `new_join_deadline`: Optional new join deadline (must be in future)
    /// 
    /// # Authorization
    /// Requires admin authentication
    /// 
    /// # Errors
    /// - `ArenaError::ArenaAlreadyStarted`: Game is not in Open state
    /// - `ArenaError::InvalidEntryFee`: Entry fee <= 0
    /// - `ArenaError::DeadlineTooSoon`: Deadline <= current time
    pub fn configure_arena(
        env: Env,
        new_entry_fee: Option<i128>,
        new_max_players: Option<u32>,
        new_join_deadline: Option<u64>,
    ) -> Result<(), ArenaError> {
        // Load current configuration
        let mut config = ArenaStorage::load_config(&env)?;

        // Require admin authentication
        config.admin.require_auth();

        // Check that game hasn't started yet
        if config.state != GameState::Open {
            return Err(ArenaError::ArenaAlreadyStarted);
        }

        let now = env.ledger().timestamp();

        // Update entry fee if provided
        if let Some(fee) = new_entry_fee {
            if fee <= 0 {
                return Err(ArenaError::InvalidEntryFee);
            }
            config.entry_fee = fee;
        }

        // Update max players if provided
        if let Some(max) = new_max_players {
            config.max_players = max;
        }

        // Update join deadline if provided
        if let Some(deadline) = new_join_deadline {
            if deadline <= now {
                return Err(ArenaError::DeadlineTooSoon);
            }
            config.join_deadline = deadline;
        }

        // Save updated configuration
        ArenaStorage::save_config(&env, &config);

        // Emit configuration event
        ArenaEvents::arena_configured(&env);

        Ok(())
    }

    /// Get current arena configuration
    pub fn get_config(env: Env) -> Result<ArenaConfig, ArenaError> {
        ArenaStorage::load_config(&env)
    }

    /// Start the game (transition to InProgress state)
    pub fn start_game(env: Env) -> Result<(), ArenaError> {
        let mut config = ArenaStorage::load_config(&env)?;
        config.admin.require_auth();

        if config.state != GameState::Open {
            return Err(ArenaError::InvalidStateTransition);
        }

        config.state = GameState::InProgress;
        ArenaStorage::save_config(&env, &config);

        ArenaEvents::game_started(&env);
        Ok(())
    }

    /// Finish the game (transition to Finished state)
    pub fn finish_game(env: Env) -> Result<(), ArenaError> {
        let mut config = ArenaStorage::load_config(&env)?;
        config.admin.require_auth();

        if config.state != GameState::InProgress {
            return Err(ArenaError::InvalidStateTransition);
        }

        config.state = GameState::Finished;
        ArenaStorage::save_config(&env, &config);

        ArenaEvents::game_finished(&env);
        Ok(())
    }

    /// Join the arena as a player
    pub fn join(env: Env, player: Address) -> Result<(), ArenaError> {
        let mut config = ArenaStorage::load_config(&env)?;

        if config.state != GameState::Open {
            return Err(ArenaError::ArenaAlreadyStarted);
        }

        if config.player_count >= config.max_players {
            return Err(ArenaError::ArenaFull);
        }

        let now = env.ledger().timestamp();
        if now >= config.join_deadline {
            return Err(ArenaError::DeadlinePassed);
        }

        player.require_auth();

        config.player_count += 1;
        ArenaStorage::save_config(&env, &config);

        ArenaEvents::player_joined(&env, &player);
        Ok(())
    }

    /// Get current player count
    pub fn get_player_count(env: Env) -> Result<u32, ArenaError> {
        let config = ArenaStorage::load_config(&env)?;
        Ok(config.player_count)
    }
}
