#![no_std]

mod admin;
mod errors;
mod events;
mod game;
mod player;
mod rewards;
mod storage;
mod types;

#[cfg(test)]
mod test;

use soroban_sdk::{contract, contractimpl, Address, Env};
use storage::ArenaStorage;
use types::{ArenaConfig, GameState, Choice, RoundResult};
use events::ArenaEvents;
use errors::ArenaError;

#[contract]
pub struct ArenaContract;

#[contractimpl]
impl ArenaContract {
    /// Initialize the arena with admin address and core configuration.
    pub fn initialize(
        env: Env,
        admin: Address,
        entry_fee: i128,
        max_players: u32,
        join_deadline: u64,
    ) -> Result<(), ArenaError> {
        if entry_fee <= 0 {
            return Err(ArenaError::InvalidEntryFee);
        }
        if join_deadline <= env.ledger().timestamp() {
            return Err(ArenaError::DeadlineTooSoon);
        }

        let config = ArenaConfig {
            admin: admin.clone(),
            entry_fee,
            max_players,
            join_deadline,
            state: GameState::Open,
            player_count: 0,
        };

        ArenaStorage::save_config(&env, &config);
        ArenaEvents::arena_initialized(&env, &admin);
        Ok(())
    }

    /// Update arena parameters (admin only, Open state only).
    pub fn configure_arena(
        env: Env,
        new_entry_fee: Option<i128>,
        new_max_players: Option<u32>,
        new_join_deadline: Option<u64>,
    ) -> Result<(), ArenaError> {
        let mut config = ArenaStorage::load_config(&env)?;
        config.admin.require_auth();
        admin::require_open(&env)?;

        let now = env.ledger().timestamp();

        if let Some(fee) = new_entry_fee {
            if fee <= 0 {
                return Err(ArenaError::InvalidEntryFee);
            }
            config.entry_fee = fee;
        }
        if let Some(max) = new_max_players {
            config.max_players = max;
        }
        if let Some(deadline) = new_join_deadline {
            if deadline <= now {
                return Err(ArenaError::DeadlineTooSoon);
            }
            config.join_deadline = deadline;
        }

        ArenaStorage::save_config(&env, &config);
        ArenaEvents::arena_configured(&env);
        Ok(())
    }

    /// Get current arena configuration.
    pub fn get_config(env: Env) -> Result<ArenaConfig, ArenaError> {
        ArenaStorage::load_config(&env)
    }

    /// Transition arena from Open to InProgress (admin only).
    pub fn start_game(env: Env) -> Result<(), ArenaError> {
        let mut config = ArenaStorage::load_config(&env)?;
        config.admin.require_auth();
        admin::require_open(&env)?;

        config.state = GameState::InProgress;
        ArenaStorage::save_config(&env, &config);
        ArenaEvents::game_started(&env);
        Ok(())
    }

    /// Transition arena from InProgress to Finished (admin only).
    pub fn finish_game(env: Env) -> Result<(), ArenaError> {
        let mut config = ArenaStorage::load_config(&env)?;
        config.admin.require_auth();
        admin::require_in_progress(&env)?;

        config.state = GameState::Finished;
        ArenaStorage::save_config(&env, &config);
        ArenaEvents::game_finished(&env);
        Ok(())
    }

    /// Join the arena as a player (Open state, before deadline, not full).
    pub fn join(env: Env, player: Address) -> Result<(), ArenaError> {
        let mut config = ArenaStorage::load_config(&env)?;
        admin::require_open(&env)?;

        if config.player_count >= config.max_players {
            return Err(ArenaError::ArenaFull);
        }
        if env.ledger().timestamp() >= config.join_deadline {
            return Err(ArenaError::DeadlinePassed);
        }

        player.require_auth();

        ArenaStorage::add_player(&env, &player);
        config.player_count += 1;
        ArenaStorage::save_config(&env, &config);
        ArenaEvents::player_joined(&env, &player);
        Ok(())
    }

    /// Get total player count.
    pub fn get_player_count(env: Env) -> Result<u32, ArenaError> {
        Ok(ArenaStorage::load_config(&env)?.player_count)
    }

    /// Submit a Heads or Tails choice for the current round.
    pub fn submit_choice(env: Env, player: Address, choice: Choice) -> Result<(), ArenaError> {
        admin::require_in_progress(&env)?;
        player::require_active_player(&env, &player)?;

        if player::has_submitted(&env, &player) {
            return Err(ArenaError::AlreadySubmitted);
        }

        player.require_auth();
        ArenaStorage::save_player_choice(&env, &player, &choice);
        ArenaEvents::choice_submitted(&env, &player);
        Ok(())
    }

    /// Resolve the current round: eliminate majority, minority survives.
    pub fn resolve_round(env: Env) -> Result<RoundResult, ArenaError> {
        let config = ArenaStorage::load_config(&env)?;
        config.admin.require_auth();
        game::resolve(&env)
    }

    /// Claim the prize pool as the winner.
    pub fn claim(env: Env, winner: Address) -> Result<(), ArenaError> {
        winner.require_auth();
        rewards::process_claim(&env, &winner)?;
        ArenaEvents::prize_claimed(&env, &winner);
        Ok(())
    }

    /// Get the winner address (set once game is Finished).
    pub fn winner(env: Env) -> Option<Address> {
        ArenaStorage::get_winner(&env)
    }

    /// Get current game state.
    pub fn game_state(env: Env) -> GameState {
        ArenaStorage::load_config(&env)
            .map(|c| c.state)
            .unwrap_or(GameState::Open)
    }
}
