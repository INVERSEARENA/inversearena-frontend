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

    /// Emit choice submitted event
    pub fn choice_submitted(env: &Env, player: &Address) {
        env.events().publish((symbol_short!("CHOICE"),), player);
    }

    /// Emit player eliminated event
    pub fn player_eliminated(env: &Env, player: &Address) {
        env.events().publish((symbol_short!("ELIM"),), player);
    }

    /// Emit prize claimed event
    pub fn prize_claimed(env: &Env, winner: &Address) {
        env.events().publish((symbol_short!("CLAIMED"),), winner);
    }

    /// Emit arena cancelled event
    pub fn arena_cancelled(env: &Env) {
        env.events().publish((symbol_short!("CNCL"),), ());
    }

    /// Emit refund claimed event
    pub fn refund_claimed(env: &Env, player: &Address) {
        env.events().publish((symbol_short!("REFUND"),), player);
    }

    /// Emit stake deposited event
    pub fn stake_deposited(env: &Env, amount: i128) {
        env.events().publish((symbol_short!("STK_DEP"),), amount);
    }

    /// Emit stake withdrawn event
    pub fn stake_withdrawn(env: &Env, amount: i128) {
        env.events().publish((symbol_short!("STK_WTH"),), amount);
    }
}

