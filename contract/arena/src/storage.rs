#![allow(dead_code)]
use crate::types::{ArenaConfig, ArenaError};
use soroban_sdk::{Address, Env, Vec, symbol_short};

const CONFIG_KEY: &str = "CONFIG";
const PLAYERS_KEY: &str = "PLAYERS";

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
    }
}

// Silence unused-import warnings until the full contract is wired up
const _: &str = CONFIG_KEY;
const _: &str = PLAYERS_KEY;
