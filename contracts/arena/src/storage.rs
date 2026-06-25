use soroban_sdk::{Env, Symbol, Address, BytesN, Vec};
use crate::types::{ArenaConfig, Choice, GlobalStats, RwaYieldRecord};
use crate::errors::ArenaError;

const CONFIG_KEY: Symbol = Symbol::short("CONFIG");
const PLAYERS_KEY: Symbol = Symbol::short("PLAYERS");
const WINNER_KEY: Symbol = Symbol::short("WINNER");
const ROUND_KEY: Symbol = Symbol::short("ROUND");
const PRIZE_CLAIMED_KEY: Symbol = Symbol::short("CLAIMED");
const CREATOR_STAKE_KEY: Symbol = Symbol::short("STAKE");
const GLOBAL_STATS_KEY: Symbol = Symbol::short("GSTATS");
const RWA_COUNTER_KEY: Symbol = Symbol::short("RWACNT");
const PRIZE_POOL_KEY: Symbol = Symbol::short("POOL");
const PENDING_ADMIN_KEY: Symbol = Symbol::short("PADMIN");
const ROUND_DEADLINE_KEY: Symbol = Symbol::short("RNDDEADL");

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
            // Remove player choice
            let choice_key = (Symbol::short("CHOICE"), player.clone());
            env.storage().instance().remove(&choice_key);
            // Remove player active status
            env.storage().instance().remove(&player);
            // Remove refund claimed status
            let refund_key = (Symbol::short("REFUND"), player.clone());
            env.storage().instance().remove(&refund_key);
        }

        // Remove player list
        env.storage().instance().remove(&PLAYERS_KEY);
        // Remove winner
        env.storage().instance().remove(&WINNER_KEY);
        // Remove round number
        env.storage().instance().remove(&ROUND_KEY);
        // Remove prize claimed flag
        env.storage().instance().remove(&PRIZE_CLAIMED_KEY);
        // Remove creator stake
        env.storage().instance().remove(&CREATOR_STAKE_KEY);
    }

    // ── Global statistics ────────────────────────────────────────────────

    pub fn load_global_stats(env: &Env) -> GlobalStats {
        env.storage()
            .instance()
            .get(&GLOBAL_STATS_KEY)
            .unwrap_or_default()
    }

    pub fn save_global_stats(env: &Env, stats: &GlobalStats) {
        env.storage().instance().set(&GLOBAL_STATS_KEY, stats);
    }

    pub fn increment_arena_count(env: &Env) {
        let mut stats = Self::load_global_stats(env);
        stats.total_arenas = stats.total_arenas.saturating_add(1);
        Self::save_global_stats(env, &stats);
    }

    pub fn increment_live_survivors(env: &Env, delta: u32) {
        let mut stats = Self::load_global_stats(env);
        stats.live_survivors = stats.live_survivors.saturating_add(delta);
        Self::save_global_stats(env, &stats);
    }

    pub fn decrement_live_survivors(env: &Env, delta: u32) {
        let mut stats = Self::load_global_stats(env);
        stats.live_survivors = stats.live_survivors.saturating_sub(delta);
        Self::save_global_stats(env, &stats);
    }

    pub fn add_to_global_pool(env: &Env, amount: i128) {
        let mut stats = Self::load_global_stats(env);
        stats.global_pool_total = stats.global_pool_total.saturating_add(amount);
        Self::save_global_stats(env, &stats);
    }

    // ── Prize pool accumulator ───────────────────────────────────────────

    pub fn get_prize_pool(env: &Env) -> i128 {
        env.storage().instance().get(&PRIZE_POOL_KEY).unwrap_or(0i128)
    }

    pub fn set_prize_pool(env: &Env, amount: i128) {
        env.storage().instance().set(&PRIZE_POOL_KEY, &amount);
    }

    // ── RWA yield records ────────────────────────────────────────────────

    fn next_rwa_id(env: &Env) -> u64 {
        let id: u64 = env.storage().instance().get(&RWA_COUNTER_KEY).unwrap_or(0u64);
        let next = id.saturating_add(1);
        env.storage().instance().set(&RWA_COUNTER_KEY, &next);
        next
    }

    pub fn save_rwa_yield(env: &Env, record: &RwaYieldRecord) {
        let key = (Symbol::short("RWA"), record.id);
        env.storage().instance().set(&key, record);
    }

    pub fn create_rwa_yield(env: &Env, record_without_id: RwaYieldRecord) -> RwaYieldRecord {
        let id = Self::next_rwa_id(env);
        let record = RwaYieldRecord { id, ..record_without_id };
        Self::save_rwa_yield(env, &record);
        record
    }

    pub fn load_rwa_yield(env: &Env, id: u64) -> Option<RwaYieldRecord> {
        let key = (Symbol::short("RWA"), id);
        env.storage().instance().get(&key)
    }

    // ── Commit-reveal storage ───────────────────────────────────────────

    pub fn save_commit_hash(env: &Env, player: &Address, round: u32, hash: &BytesN<32>) {
        let key = (Symbol::short("CMT"), player.clone(), round);
        env.storage().instance().set(&key, hash);
    }

    pub fn load_commit_hash(env: &Env, player: &Address, round: u32) -> Option<BytesN<32>> {
        let key = (Symbol::short("CMT"), player.clone(), round);
        env.storage().instance().get(&key)
    }

    pub fn is_revealed(env: &Env, player: &Address, round: u32) -> bool {
        let key = (Symbol::short("RVLD"), player.clone(), round);
        env.storage().instance().get(&key).unwrap_or(false)
    }

    pub fn set_revealed(env: &Env, player: &Address, round: u32) {
        let key = (Symbol::short("RVLD"), player.clone(), round);
        env.storage().instance().set(&key, &true);
    }

    // ── Pending admin transfer ──────────────────────────────────────────

    pub fn set_pending_admin(env: &Env, admin: &Address) {
        env.storage().instance().set(&PENDING_ADMIN_KEY, admin);
    }

    pub fn get_pending_admin(env: &Env) -> Option<Address> {
        env.storage().instance().get(&PENDING_ADMIN_KEY)
    }

    pub fn clear_pending_admin(env: &Env) {
        env.storage().instance().remove(&PENDING_ADMIN_KEY);
    }

    // ── Round deadline ──────────────────────────────────────────────────

    pub fn set_round_deadline(env: &Env, deadline: u64) {
        env.storage().instance().set(&ROUND_DEADLINE_KEY, &deadline);
    }

    pub fn get_round_deadline(env: &Env) -> Option<u64> {
        env.storage().instance().get(&ROUND_DEADLINE_KEY)
    }
}
