use soroban_sdk::{symbol_short, Address, Env};

pub struct ArenaEvents;

impl ArenaEvents {
    /// Emit arena initialized event
    pub fn arena_initialized(env: &Env, admin: &Address) {
        env.events().publish((symbol_short!("INIT"),), admin);
    }

    /// Emit arena configured event
    pub fn arena_configured(env: &Env) {
        env.events().publish((symbol_short!("CFGD"),), ());
    }

    /// Emit game started event
    pub fn game_started(env: &Env) {
        env.events().publish((symbol_short!("START"),), ());
    }

    /// Emit game finished event
    pub fn game_finished(env: &Env) {
        env.events().publish((symbol_short!("FINISH"),), ());
    }

    /// Emit player joined event
    pub fn player_joined(env: &Env, player: &Address) {
        env.events().publish((symbol_short!("JOIN"),), player);
    }
}
