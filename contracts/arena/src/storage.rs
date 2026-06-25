use soroban_sdk::{Env, Symbol, Address, Vec};
use crate::types::{ArenaConfig, Choice};
use crate::errors::ArenaError;

const CONFIG_KEY: Symbol = Symbol::short("CONFIG");
const PLAYERS_KEY: Symbol = Symbol::short("PLAYERS");
const WINNER_KEY: Symbol = Symbol::short("WINNER");
const ROUND_KEY: Symbol = Symbol::short("ROUND");
const PRIZE_CLAIMED_KEY: Symbol = Symbol::short("CLAIMED");
const CREATOR_STAKE_KEY: Symbol = Symbol::short("STAKE");
const APPROVED_TOKENS_KEY: Symbol = Symbol::short("APRV_TK");
const ACTIVE_POOLS_KEY: Symbol = Symbol::short("ACTPOOL");

pub struct ArenaStorage;

impl ArenaStorage {
    /// Save arena configuration to storage
    pub fn save_config(env: &Env, config: &ArenaConfig) {
        env.storage().instance().set(&CONFIG_KEY, config);
    }

    /// Load arena configuration from storage
    pub fn load_config(env: &Env) -> Result<ArenaConfig, ArenaError> {
        env.storage()
            .instance()
            .get(&CONFIG_KEY)
            .ok_or(ArenaError::ConfigNotFound)
    }

    /// Add a new player to the registered players list and set them active
    pub fn add_player(env: &Env, player: &Address) {
        let mut players: Vec<Address> = env.storage().instance().get(&PLAYERS_KEY).unwrap_or_else(|| Vec::new(env));
        players.push_back(player.clone());
        env.storage().instance().set(&PLAYERS_KEY, &players);

        // Save player active status
        env.storage().instance().set(player, &true);
    }

    /// Load all players who joined the arena
    pub fn load_all_players(env: &Env) -> Vec<Address> {
        env.storage().instance().get(&PLAYERS_KEY).unwrap_or_else(|| Vec::new(env))
    }

    /// Check if a player is active (not eliminated)
    pub fn is_player_active(env: &Env, player: &Address) -> bool {
        env.storage().instance().get(player).unwrap_or(false)
    }

    /// Set active status of a player
    pub fn set_player_active(env: &Env, player: &Address, active: bool) {
        env.storage().instance().set(player, &active);
    }

    /// Save choice of a player for the current round
    pub fn save_player_choice(env: &Env, player: &Address, choice: &Choice) {
        let key = (Symbol::short("CHOICE"), player.clone());
        env.storage().instance().set(&key, choice);
    }

    /// Load choice of a player for the current round
    pub fn load_player_choice(env: &Env, player: &Address) -> Option<Choice> {
        let key = (Symbol::short("CHOICE"), player.clone());
        env.storage().instance().get(&key)
    }

    /// Clear all choices for players in the current round
    pub fn clear_choices(env: &Env) {
        let players = Self::load_all_players(env);
        for player in players.iter() {
            let key = (Symbol::short("CHOICE"), player.clone());
            env.storage().instance().remove(&key);
        }
    }

    /// Get current round number
    pub fn get_round(env: &Env) -> u32 {
        env.storage().instance().get(&ROUND_KEY).unwrap_or(0)
    }

    /// Set current round number
    pub fn set_round(env: &Env, round: u32) {
        env.storage().instance().set(&ROUND_KEY, &round);
    }

    /// Get winner of the arena
    pub fn get_winner(env: &Env) -> Option<Address> {
        env.storage().instance().get(&WINNER_KEY)
    }

    /// Set winner of the arena
    pub fn set_winner(env: &Env, winner: &Address) {
        env.storage().instance().set(&WINNER_KEY, winner);
    }

    /// Check if the prize pool has already been claimed
    pub fn is_prize_claimed(env: &Env) -> bool {
        env.storage().instance().get(&PRIZE_CLAIMED_KEY).unwrap_or(false)
    }

    /// Mark the prize pool as claimed
    pub fn set_prize_claimed(env: &Env) {
        env.storage().instance().set(&PRIZE_CLAIMED_KEY, &true);
    }

    /// Save creator stake amount
    pub fn save_creator_stake(env: &Env, amount: i128) {
        env.storage().instance().set(&CREATOR_STAKE_KEY, &amount);
    }

    /// Load creator stake amount
    pub fn load_creator_stake(env: &Env) -> i128 {
        env.storage().instance().get(&CREATOR_STAKE_KEY).unwrap_or(0)
    }

    /// Check if a player has already claimed a refund
    pub fn is_refund_claimed(env: &Env, player: &Address) -> bool {
        let key = (Symbol::short("REFUND"), player.clone());
        env.storage().instance().get(&key).unwrap_or(false)
    }

    /// Mark a player's refund as claimed
    pub fn set_refund_claimed(env: &Env, player: &Address) {
        let key = (Symbol::short("REFUND"), player.clone());
        env.storage().instance().set(&key, &true);
    }

    /// Clean up transient arena data (player lists, choices, round data, etc.)
    /// while preserving the ArenaConfig for historical reference.
    pub fn cleanup_arena_data(env: &Env) {
        // Remove all player-related data
        let players = Self::load_all_players(env);
        for player in players.iter() {
            let choice_key = (Symbol::short("CHOICE"), player.clone());
            env.storage().instance().remove(&choice_key);
            env.storage().instance().remove(&player);
            let refund_key = (Symbol::short("REFUND"), player.clone());
            env.storage().instance().remove(&refund_key);
        }

        env.storage().instance().remove(&PLAYERS_KEY);
        env.storage().instance().remove(&WINNER_KEY);
        env.storage().instance().remove(&ROUND_KEY);
        env.storage().instance().remove(&PRIZE_CLAIMED_KEY);
        env.storage().instance().remove(&CREATOR_STAKE_KEY);
    }

    // ── Approved Token Whitelist ────────────────────────────────────────────

    /// Check if a token is in the approved whitelist
    pub fn is_token_approved(env: &Env, token: &Address) -> bool {
        let approved: Vec<Address> = env.storage().instance().get(&APPROVED_TOKENS_KEY).unwrap_or_else(|| Vec::new(env));
        approved.contains(token)
    }

    /// Add a token to the approved whitelist
    pub fn add_approved_token(env: &Env, token: &Address) {
        let mut approved: Vec<Address> = env.storage().instance().get(&APPROVED_TOKENS_KEY).unwrap_or_else(|| Vec::new(env));
        approved.push_back(token.clone());
        env.storage().instance().set(&APPROVED_TOKENS_KEY, &approved);
    }

    /// Remove a token from the approved whitelist
    pub fn remove_approved_token(env: &Env, token: &Address) {
        let approved: Vec<Address> = env.storage().instance().get(&APPROVED_TOKENS_KEY).unwrap_or_else(|| Vec::new(env));
        let mut filtered: Vec<Address> = Vec::new(env);
        for t in approved.iter() {
            if t != *token {
                filtered.push_back(t.clone());
            }
        }
        env.storage().instance().set(&APPROVED_TOKENS_KEY, &filtered);
    }

    /// Get all approved tokens
    pub fn get_approved_tokens(env: &Env) -> Vec<Address> {
        env.storage().instance().get(&APPROVED_TOKENS_KEY).unwrap_or_else(|| Vec::new(env))
    }

    // ── Active Pools Per Creator ────────────────────────────────────────────

    /// Load active pools count for a creator
    pub fn load_active_pools(env: &Env, creator: &Address) -> u32 {
        let key = (ACTIVE_POOLS_KEY, creator.clone());
        env.storage().instance().get(&key).unwrap_or(0)
    }

    /// Set active pools count for a creator
    pub fn save_active_pools(env: &Env, creator: &Address, count: u32) {
        let key = (ACTIVE_POOLS_KEY, creator.clone());
        env.storage().instance().set(&key, &count);
    }

    /// Increment active pools count for a creator
    pub fn increment_active_pools(env: &Env, creator: &Address) {
        let current = Self::load_active_pools(env, creator);
        Self::save_active_pools(env, creator, current + 1);
    }

    /// Decrement active pools count for a creator
    pub fn decrement_active_pools(env: &Env, creator: &Address) {
        let current = Self::load_active_pools(env, creator);
        if current > 0 {
            Self::save_active_pools(env, creator, current - 1);
        }
    }
}
