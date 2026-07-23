use soroban_sdk::{symbol_short, Env, Symbol, Address, Vec};
use crate::types::{ArenaConfig, Choice};
use crate::errors::ArenaError;

const CONFIG_KEY: Symbol = symbol_short!("CONFIG");
const PLAYERS_KEY: Symbol = symbol_short!("PLAYERS");
const WINNER_KEY: Symbol = symbol_short!("WINNER");
const ROUND_KEY: Symbol = symbol_short!("ROUND");
const PRIZE_CLAIMED: Symbol = symbol_short!("CLAIMED");
const CHOICE_KEY: Symbol = symbol_short!("CHOICE");

pub struct ArenaStorage;

impl ArenaStorage {
    pub fn save_config(env: &Env, config: &ArenaConfig) {
        env.storage().instance().set(&CONFIG_KEY, config);
    }

    pub fn load_config(env: &Env) -> Result<ArenaConfig, ArenaError> {
        env.storage()
            .instance()
            .get(&CONFIG_KEY)
            .ok_or(ArenaError::ConfigNotFound)
    }

    pub fn add_player(env: &Env, player: &Address) {
        let mut players: Vec<Address> = env
            .storage()
            .instance()
            .get(&PLAYERS_KEY)
            .unwrap_or_else(|| Vec::new(env));
        players.push_back(player.clone());
        env.storage().instance().set(&PLAYERS_KEY, &players);
        env.storage().instance().set(player, &true);
    }

    pub fn load_all_players(env: &Env) -> Vec<Address> {
        env.storage()
            .instance()
            .get(&PLAYERS_KEY)
            .unwrap_or_else(|| Vec::new(env))
    }

    pub fn is_player_active(env: &Env, player: &Address) -> bool {
        env.storage().instance().get(player).unwrap_or(false)
    }

    pub fn set_player_active(env: &Env, player: &Address, active: bool) {
        env.storage().instance().set(player, &active);
    }

    pub fn save_player_choice(env: &Env, player: &Address, choice: &Choice) {
        let key = (CHOICE_KEY, player.clone());
        env.storage().instance().set(&key, choice);
    }

    pub fn load_player_choice(env: &Env, player: &Address) -> Option<Choice> {
        let key = (CHOICE_KEY, player.clone());
        env.storage().instance().get(&key)
    }

    pub fn clear_choices(env: &Env) {
        let players = Self::load_all_players(env);
        for player in players.iter() {
            let key = (CHOICE_KEY, player.clone());
            env.storage().instance().remove(&key);
        }
    }

    pub fn get_round(env: &Env) -> u32 {
        env.storage().instance().get(&ROUND_KEY).unwrap_or(0)
    }

    pub fn set_round(env: &Env, round: u32) {
        env.storage().instance().set(&ROUND_KEY, &round);
    }

    pub fn get_winner(env: &Env) -> Option<Address> {
        env.storage().instance().get(&WINNER_KEY)
    }

    pub fn set_winner(env: &Env, winner: &Address) {
        env.storage().instance().set(&WINNER_KEY, winner);
    }

    pub fn is_prize_claimed(env: &Env) -> bool {
        env.storage().instance().get(&PRIZE_CLAIMED).unwrap_or(false)
    }

    pub fn set_prize_claimed(env: &Env) {
        env.storage().instance().set(&PRIZE_CLAIMED, &true);
    }
}
