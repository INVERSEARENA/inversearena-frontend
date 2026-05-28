#![allow(dead_code)]
use crate::types::{ArenaConfig, ArenaError, Choice, PlayerState};
use soroban_sdk::{Address, BytesN, Env, Vec, contracttype, symbol_short};

const CONFIG_KEY: &str = "CONFIG";
const PLAYERS_KEY: &str = "PLAYERS";

/// Storage key for per-player data, keyed by the player's address.
#[contracttype]
enum DataKey {
    Player(Address),
    Commitment(Address),
    Choice(Address),
}

pub struct ArenaStorage;

impl ArenaStorage {
    pub fn load_config(env: &Env) -> Result<ArenaConfig, ArenaError> {
        env.storage()
            .persistent()
            .get(&symbol_short!("CONFIG"))
            .ok_or(ArenaError::NotInitialised)
    }

    pub fn save_config(env: &Env, config: &ArenaConfig) {
        env.storage()
            .persistent()
            .set(&symbol_short!("CONFIG"), config);
    }

    /// Ledger timestamp at which the current round started (#689). `None` until
    /// `start_round` has been called.
    pub fn load_round_start(env: &Env) -> Option<u64> {
        env.storage().persistent().get(&symbol_short!("RSTART"))
    }

    pub fn save_round_start(env: &Env, timestamp: u64) {
        env.storage()
            .persistent()
            .set(&symbol_short!("RSTART"), &timestamp);
    }

    /// Minimum seconds that must elapse after `start_round` before
    /// `resolve_round` is permitted (#689). Defaults to 0 if never set.
    pub fn load_round_duration(env: &Env) -> u64 {
        env.storage()
            .persistent()
            .get(&symbol_short!("RDUR"))
            .unwrap_or(0)
    }

    pub fn save_round_duration(env: &Env, seconds: u64) {
        env.storage()
            .persistent()
            .set(&symbol_short!("RDUR"), &seconds);
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

    /// Store a commitment hash for a player during the commit phase.
    pub fn save_commitment(env: &Env, player: &Address, commitment: &BytesN<32>) {
        env.storage()
            .persistent()
            .set(&DataKey::Commitment(player.clone()), commitment);
    }

    /// Load a player's stored commitment, or `None` if they never committed.
    pub fn load_commitment(env: &Env, player: &Address) -> Option<BytesN<32>> {
        env.storage()
            .persistent()
            .get(&DataKey::Commitment(player.clone()))
    }

    /// Store a player's revealed choice.
    pub fn save_choice(env: &Env, player: &Address, choice: &Choice) {
        env.storage()
            .persistent()
            .set(&DataKey::Choice(player.clone()), choice);
    }

    /// Load a player's revealed choice, or `None` if not yet revealed.
    pub fn load_choice(env: &Env, player: &Address) -> Option<Choice> {
        env.storage()
            .persistent()
            .get(&DataKey::Choice(player.clone()))
    }

    /// Returns `true` if the player has already revealed their choice.
    pub fn has_revealed(env: &Env, player: &Address) -> bool {
        env.storage()
            .persistent()
            .has(&DataKey::Choice(player.clone()))
    }
}

// Silence unused-import warnings until the full contract is wired up
const _: &str = CONFIG_KEY;
const _: &str = PLAYERS_KEY;
