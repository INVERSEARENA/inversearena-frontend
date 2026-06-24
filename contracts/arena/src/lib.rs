#![no_std]

mod storage;
mod types;
mod events;
mod errors;

#[cfg(test)]
mod test;

use soroban_sdk::{contract, contractimpl, token::TokenClient, Address, Env, Symbol, Vec};
use storage::ArenaStorage;
use types::{ArenaConfig, GameState, Choice, RoundResult};
use events::ArenaEvents;
use errors::ArenaError;

const PLATFORM_FEE_BP: i128 = 1000; // 10% = 1000 basis points

#[contract]
pub struct ArenaContract;

#[contractimpl]
impl ArenaContract {
    /// Initialize the arena with initial configuration
    pub fn initialize(
        env: Env,
        admin: Address,
        token: Address,
        entry_fee: i128,
        max_players: u32,
        join_deadline: u64,
        treasury_address: Address,
        creation_cooldown_seconds: u64,
    ) -> Result<(), ArenaError> {
        // Validate inputs
        if entry_fee <= 0 {
            return Err(ArenaError::InvalidEntryFee);
        }

        let now = env.ledger().timestamp();
        if join_deadline <= now {
            return Err(ArenaError::DeadlineTooSoon);
        }

        // Check rate limiting cooldown (admin bypasses cooldown)
        if let Ok(existing_config) = ArenaStorage::load_config(&env) {
            if admin != existing_config.admin {
                if existing_config.creation_cooldown_seconds > 0 {
                    let elapsed = now.saturating_sub(existing_config.last_creation_timestamp);
                    if elapsed < existing_config.creation_cooldown_seconds {
                        return Err(ArenaError::CooldownNotElapsed);
                    }
                }
            }
        }

        // Create initial configuration
        let config = ArenaConfig {
            admin: admin.clone(),
            token,
            entry_fee,
            max_players,
            join_deadline,
            state: GameState::Open,
            paused: false,
            player_count: 0,
            treasury_address,
            last_creation_timestamp: now,
            creation_cooldown_seconds,
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

        Self::require_not_paused(&config)?;

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

        Self::require_not_paused(&config)?;

        if config.state != GameState::InProgress {
            return Err(ArenaError::InvalidStateTransition);
        }

        config.state = GameState::Finished;
        ArenaStorage::save_config(&env, &config);

        ArenaEvents::game_finished(&env);
        Ok(())
    }

    /// Pause the contract, blocking all state-mutating operations.
    ///
    /// While paused, calls to `join`, `submit_choice`, `resolve_round`, and `claim`
    /// all fail with `ArenaError::ContractPaused`. Read-only queries are unaffected.
    /// Only the admin can pause.
    pub fn pause(env: Env, reason: Symbol) -> Result<(), ArenaError> {
        let mut config = ArenaStorage::load_config(&env)?;
        config.admin.require_auth();
        config.paused = true;
        ArenaStorage::save_config(&env, &config);
        ArenaEvents::contract_paused(&env, &config.admin, &reason);
        Ok(())
    }

    /// Resume normal operation after a `pause`.
    ///
    /// Clears the paused flag so all gameplay entry points become callable
    /// again. Only the admin can unpause.
    pub fn unpause(env: Env) -> Result<(), ArenaError> {
        let mut config = ArenaStorage::load_config(&env)?;
        config.admin.require_auth();
        config.paused = false;
        ArenaStorage::save_config(&env, &config);
        ArenaEvents::contract_unpaused(&env, &config.admin);
        Ok(())
    }

    /// Update the treasury address where platform fees are collected.
    ///
    /// Only the admin can change the treasury address. This supports
    /// multi-sig treasury wallets and separation of concerns.
    pub fn update_treasury(env: Env, new_treasury: Address) -> Result<(), ArenaError> {
        let mut config = ArenaStorage::load_config(&env)?;
        config.admin.require_auth();
        config.treasury_address = new_treasury.clone();
        ArenaStorage::save_config(&env, &config);
        ArenaEvents::treasury_updated(&env, &config.admin, &new_treasury);
        Ok(())
    }

    /// Set the minimum cooldown period between arena creations.
    ///
    /// Only the admin can update this. The cooldown prevents a creator
    /// from rapidly creating and cancelling arenas to spam the system.
    pub fn set_creation_cooldown(env: Env, cooldown_seconds: u64) -> Result<(), ArenaError> {
        let mut config = ArenaStorage::load_config(&env)?;
        config.admin.require_auth();
        config.creation_cooldown_seconds = cooldown_seconds;
        ArenaStorage::save_config(&env, &config);
        ArenaEvents::cooldown_configured(&env, &config.admin, &cooldown_seconds);
        Ok(())
    }

    /// Get the current treasury address
    pub fn treasury(env: Env) -> Result<Address, ArenaError> {
        let config = ArenaStorage::load_config(&env)?;
        Ok(config.treasury_address)
    }

    /// Join the arena as a player
    pub fn join(env: Env, player: Address) -> Result<(), ArenaError> {
        let mut config = ArenaStorage::load_config(&env)?;

        Self::require_not_paused(&config)?;

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

        // Transfer entry fee from player to contract
        let token = TokenClient::new(&env, &config.token);
        token.transfer(&player, &env.current_contract_address(), &config.entry_fee);

        ArenaStorage::add_player(&env, &player);

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

    /// Submit a choice for the current round
    pub fn submit_choice(env: Env, player: Address, choice: Choice) -> Result<(), ArenaError> {
        let config = ArenaStorage::load_config(&env)?;

        Self::require_not_paused(&config)?;

        if config.state != GameState::InProgress {
            return Err(ArenaError::InvalidStateTransition);
        }

        // Verify player exists and is active
        let players = ArenaStorage::load_all_players(&env);
        if !players.contains(&player) {
            return Err(ArenaError::NotAPlayer);
        }
        if !ArenaStorage::is_player_active(&env, &player) {
            return Err(ArenaError::PlayerEliminated);
        }

        player.require_auth();

        ArenaStorage::save_player_choice(&env, &player, &choice);

        // Emit choice submitted event
        ArenaEvents::choice_submitted(&env, &player);

        Ok(())
    }

    /// Resolve the current round based on minority wins / coin flip
    pub fn resolve_round(env: Env) -> Result<RoundResult, ArenaError> {
        let mut config = ArenaStorage::load_config(&env)?;

        Self::require_not_paused(&config)?;

        if config.state != GameState::InProgress {
            return Err(ArenaError::InvalidStateTransition);
        }

        let players = ArenaStorage::load_all_players(&env);
        let mut active_players = Vec::new(&env);
        let mut heads_count = 0u32;
        let mut tails_count = 0u32;

        for player in players.iter() {
            if ArenaStorage::is_player_active(&env, &player) {
                active_players.push_back(player.clone());
                if let Some(choice) = ArenaStorage::load_player_choice(&env, &player) {
                    match choice {
                        Choice::Heads => heads_count += 1,
                        Choice::Tails => tails_count += 1,
                    }
                }
            }
        }

        let active_count = active_players.len();
        let mut eliminated = 0u32;
        let mut survivors = 0u32;

        if heads_count == tails_count {
            if active_count == 2 {
                // Break tie for exactly 2 players: Heads survives, Tails eliminated
                for player in active_players.iter() {
                    if let Some(choice) = ArenaStorage::load_player_choice(&env, &player) {
                        match choice {
                            Choice::Tails => {
                                ArenaStorage::set_player_active(&env, &player, false);
                                eliminated += 1;
                                ArenaEvents::player_eliminated(&env, &player);
                            }
                            Choice::Heads => {
                                survivors += 1;
                            }
                        }
                    } else {
                        ArenaStorage::set_player_active(&env, &player, false);
                        eliminated += 1;
                        ArenaEvents::player_eliminated(&env, &player);
                    }
                }
            } else {
                // For >2 players, tie round has no eliminations
                survivors = active_count;
            }
        } else {
            // Minority wins rule: the side with fewer choices survives
            let surviving_choice = if heads_count < tails_count {
                Choice::Heads
            } else {
                Choice::Tails
            };

            for player in active_players.iter() {
                if let Some(choice) = ArenaStorage::load_player_choice(&env, &player) {
                    if choice != surviving_choice {
                        ArenaStorage::set_player_active(&env, &player, false);
                        eliminated += 1;
                        ArenaEvents::player_eliminated(&env, &player);
                    } else {
                        survivors += 1;
                    }
                } else {
                    ArenaStorage::set_player_active(&env, &player, false);
                    eliminated += 1;
                    ArenaEvents::player_eliminated(&env, &player);
                }
            }
        }

        // Clear choices for the next round
        ArenaStorage::clear_choices(&env);

        let round = ArenaStorage::get_round(&env) + 1;
        ArenaStorage::set_round(&env, round);

        // If only 1 survivor left (or 0), game finishes
        if survivors <= 1 {
            config.state = GameState::Finished;
            ArenaStorage::save_config(&env, &config);

            // Find and save the winner
            for player in players.iter() {
                if ArenaStorage::is_player_active(&env, &player) {
                    ArenaStorage::set_winner(&env, &player);
                    break;
                }
            }
        }

        Ok(RoundResult {
            round,
            eliminated,
            survivors,
        })
    }

    /// Claim the prize pool
    pub fn claim(env: Env, winner: Address) -> Result<(), ArenaError> {
        winner.require_auth();

        let config = ArenaStorage::load_config(&env)?;

        Self::require_not_paused(&config)?;

        if config.state != GameState::Finished {
            return Err(ArenaError::GameNotFinished);
        }

        if ArenaStorage::is_prize_claimed(&env) {
            return Err(ArenaError::PrizeAlreadyClaimed);
        }

        let stored_winner = ArenaStorage::get_winner(&env).ok_or(ArenaError::PlayerEliminated)?;
        if stored_winner != winner {
            return Err(ArenaError::PlayerEliminated);
        }

        // Calculate prize: total pot minus platform fee
        let total_pot = (config.player_count as i128) * config.entry_fee;
        let platform_fee = total_pot * PLATFORM_FEE_BP / 10000;
        let prize = total_pot - platform_fee;

        // Transfer platform fee to admin
        let token = TokenClient::new(&env, &config.token);
        token.transfer(&env.current_contract_address(), &config.admin, &platform_fee);

        // Transfer prize to winner
        token.transfer(&env.current_contract_address(), &winner, &prize);

        ArenaStorage::set_prize_claimed(&env);

        ArenaEvents::prize_claimed(&env, &winner);

        Ok(())
    }

    /// Cancel the arena (admin only, before game starts)
    pub fn cancel_arena(env: Env) -> Result<(), ArenaError> {
        let mut config = ArenaStorage::load_config(&env)?;
        config.admin.require_auth();

        if config.state != GameState::Open {
            return Err(ArenaError::InvalidStateTransition);
        }

        config.state = GameState::Cancelled;
        ArenaStorage::save_config(&env, &config);

        ArenaEvents::arena_cancelled(&env);
        Ok(())
    }

    /// Claim a refund when arena is cancelled
    pub fn claim_refund(env: Env, player: Address) -> Result<(), ArenaError> {
        player.require_auth();

        let config = ArenaStorage::load_config(&env)?;
        if config.state != GameState::Cancelled {
            return Err(ArenaError::ArenaNotCancelled);
        }

        if ArenaStorage::is_refund_claimed(&env, &player) {
            return Err(ArenaError::RefundAlreadyClaimed);
        }

        // Verify player actually joined
        let players = ArenaStorage::load_all_players(&env);
        if !players.contains(&player) {
            return Err(ArenaError::NotAPlayer);
        }

        // Transfer entry fee back to player
        let token = TokenClient::new(&env, &config.token);
        token.transfer(&env.current_contract_address(), &player, &config.entry_fee);

        ArenaStorage::set_refund_claimed(&env, &player);

        ArenaEvents::refund_claimed(&env, &player);
        Ok(())
    }

    /// Deposit creator stake into the contract
    pub fn deposit_creator_stake(env: Env, creator: Address, amount: i128) -> Result<(), ArenaError> {
        creator.require_auth();

        if amount <= 0 {
            return Err(ArenaError::InvalidEntryFee);
        }

        if ArenaStorage::load_creator_stake(&env) > 0 {
            return Err(ArenaError::StakeAlreadyDeposited);
        }

        let config = ArenaStorage::load_config(&env)?;

        // Transfer stake from creator to contract
        let token = TokenClient::new(&env, &config.token);
        token.transfer(&creator, &env.current_contract_address(), &amount);

        ArenaStorage::save_creator_stake(&env, amount);

        ArenaEvents::stake_deposited(&env, amount);
        Ok(())
    }

    /// Withdraw creator stake from the contract
    pub fn withdraw_creator_stake(env: Env, creator: Address) -> Result<(), ArenaError> {
        creator.require_auth();

        let stake = ArenaStorage::load_creator_stake(&env);
        if stake <= 0 {
            return Err(ArenaError::NoStakeToWithdraw);
        }

        let config = ArenaStorage::load_config(&env)?;

        // Transfer stake back to creator
        let token = TokenClient::new(&env, &config.token);
        token.transfer(&env.current_contract_address(), &creator, &stake);

        ArenaStorage::save_creator_stake(&env, 0);

        ArenaEvents::stake_withdrawn(&env, stake);
        Ok(())
    }

    /// Get the winner address if the game is finished
    pub fn winner(env: Env) -> Option<Address> {
        ArenaStorage::get_winner(&env)
    }

    /// Get current game state directly
    pub fn game_state(env: Env) -> GameState {
        ArenaStorage::load_config(&env)
            .map(|c| c.state)
            .unwrap_or(GameState::Open)
    }

    /// Get current creator stake
    pub fn get_creator_stake(env: Env) -> i128 {
        ArenaStorage::load_creator_stake(&env)
    }

    fn require_not_paused(config: &ArenaConfig) -> Result<(), ArenaError> {
        if config.paused {
            return Err(ArenaError::ContractPaused);
        }
        Ok(())
    }
}

