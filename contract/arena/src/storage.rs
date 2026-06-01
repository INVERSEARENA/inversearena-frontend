#![allow(dead_code)]

use crate::types::{
    ArenaConfig, ArenaError, Choice, PendingAdmin, PlayerState, RoundResult, YieldSnapshot,
};
use soroban_sdk::{Address, BytesN, Env, Vec, contracttype, symbol_short};

/// Storage key for per-player data, keyed by the player's address.
#[contracttype]
enum DataKey {
    Player(Address),
    Commitment(Address),
    Choice(Address),
    YieldSnapshot(u32),
    RoundResult(u32),
    RoundYieldBps(u32),
    RoundStart,
    RoundDuration,
    LastVaultBalance,
    PrizeClaimed,
}

pub struct ArenaStorage;

impl ArenaStorage {
    pub fn load_config(env: &Env) -> Result<ArenaConfig, ArenaError> {
        env.storage()
            .persistent()
            .get(&symbol_short!("CONFIG"))
            .ok_or(ArenaError::NotInitialized)
    }

    pub fn save_config(env: &Env, config: &ArenaConfig) {
        env.storage()
            .persistent()
            .set(&symbol_short!("CONFIG"), config);
    }

    pub fn has_config(env: &Env) -> bool {
        env.storage().persistent().has(&symbol_short!("CONFIG"))
    }

    /// Return the list of all player addresses that have joined this arena.
    pub fn load_all_players(env: &Env) -> Vec<Address> {
        env.storage()
            .persistent()
            .get(&symbol_short!("PLAYERS"))
            .unwrap_or_else(|| Vec::new(env))
    }

    pub fn save_players(env: &Env, players: &Vec<Address>) {
        env.storage()
            .persistent()
            .set(&symbol_short!("PLAYERS"), players);
    }

    pub fn add_player(env: &Env, player: &Address) {
        let mut players = Self::load_all_players(env);
        players.push_back(player.clone());
        Self::save_players(env, &players);

        // Initialise the joining player's state (active, no rounds survived yet).
        Self::save_player(
            env,
            player,
            &PlayerState {
                active: true,
                rounds_survived: 0,
            },
        );

        // Keep the cached player count in `config` in sync so `player_count`
        // can be served without scanning the players list.
        if let Ok(mut config) = Self::load_config(env) {
            config.player_count = players.len();
            Self::save_config(env, &config);
        }
    }

    /// Load a single player's state, or `None` if they never joined.
    pub fn load_player(env: &Env, player: &Address) -> Option<PlayerState> {
        env.storage()
            .persistent()
            .get(&DataKey::Player(player.clone()))
    }

    pub fn save_player(env: &Env, player: &Address, state: &PlayerState) {
        env.storage()
            .persistent()
            .set(&DataKey::Player(player.clone()), state);
    }

    pub fn save_commitment(env: &Env, player: &Address, commitment: &BytesN<32>) {
        env.storage()
            .persistent()
            .set(&DataKey::Commitment(player.clone()), commitment);
    }

    pub fn load_commitment(env: &Env, player: &Address) -> Option<BytesN<32>> {
        env.storage()
            .persistent()
            .get(&DataKey::Commitment(player.clone()))
    }

    pub fn save_choice(env: &Env, player: &Address, choice: &Choice) {
        env.storage()
            .persistent()
            .set(&DataKey::Choice(player.clone()), choice);
    }

    pub fn load_choice(env: &Env, player: &Address) -> Option<Choice> {
        env.storage()
            .persistent()
            .get(&DataKey::Choice(player.clone()))
    }

    pub fn save_round_start(env: &Env, timestamp: u64) {
        env.storage()
            .persistent()
            .set(&DataKey::RoundStart, &timestamp);
    }

    pub fn load_round_start(env: &Env) -> Option<u64> {
        env.storage().persistent().get(&DataKey::RoundStart)
    }

    pub fn save_round_duration(env: &Env, duration_seconds: u64) {
        env.storage()
            .persistent()
            .set(&DataKey::RoundDuration, &duration_seconds);
    }

    pub fn load_round_duration(env: &Env) -> u64 {
        env.storage()
            .persistent()
            .get(&DataKey::RoundDuration)
            .unwrap_or(0)
    }

    pub fn save_round_yield_bps(env: &Env, round: u32, yield_bps: u32) {
        env.storage()
            .persistent()
            .set(&DataKey::RoundYieldBps(round), &yield_bps);
    }

    pub fn save_yield_snapshot(env: &Env, round: u32, snapshot: &YieldSnapshot) {
        env.storage()
            .persistent()
            .set(&DataKey::YieldSnapshot(round), snapshot);
    }

    pub fn load_yield_snapshot(env: &Env, round: u32) -> Option<YieldSnapshot> {
        env.storage()
            .persistent()
            .get(&DataKey::YieldSnapshot(round))
    }

    pub fn save_round_result(env: &Env, round: u32, result: &RoundResult) {
        env.storage()
            .persistent()
            .set(&DataKey::RoundResult(round), result);
    }

    pub fn load_round_result(env: &Env, round: u32) -> Option<RoundResult> {
        env.storage().persistent().get(&DataKey::RoundResult(round))
    }

    pub fn save_last_vault_balance(env: &Env, balance: i128) {
        env.storage()
            .persistent()
            .set(&DataKey::LastVaultBalance, &balance);
    }

    pub fn load_last_vault_balance(env: &Env) -> i128 {
        env.storage()
            .persistent()
            .get(&DataKey::LastVaultBalance)
            .unwrap_or(0)
    }

    /// Returns true once the prize has been claimed for this arena. Read inside
    /// `claim` so a reentrant call sees the flag and bails out with
    /// `PrizeAlreadyClaimed` before the token transfer can run a second time.
    pub fn prize_claimed(env: &Env) -> bool {
        env.storage()
            .persistent()
            .get(&DataKey::PrizeClaimed)
            .unwrap_or(false)
    }

    /// Persist the prize-claimed flag. MUST be called before any external
    /// (cross-contract) call in `claim` so that a malicious token contract
    /// re-entering the arena cannot replay the claim.
    pub fn mark_prize_claimed(env: &Env) {
        env.storage()
            .persistent()
            .set(&DataKey::PrizeClaimed, &true);
    }

    pub fn save_pending_admin(env: &Env, pending: &PendingAdmin) {
        env.storage()
            .persistent()
            .set(&symbol_short!("PADMIN"), pending);
    }

    pub fn load_pending_admin(env: &Env) -> Option<PendingAdmin> {
        env.storage().persistent().get(&symbol_short!("PADMIN"))
    }

    pub fn delete_pending_admin(env: &Env) {
        env.storage().persistent().remove(&symbol_short!("PADMIN"));
    }
}
