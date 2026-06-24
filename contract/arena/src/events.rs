use soroban_sdk::{Address, BytesN, Env, Symbol, symbol_short};

pub struct ArenaEvents;

impl ArenaEvents {
    pub fn initialized(env: &Env, admin: &Address) {
        env.events()
            .publish((symbol_short!("init"),), admin.clone());
    }

    pub fn player_joined(env: &Env, player: &Address, player_count: u32) {
        env.events()
            .publish((symbol_short!("join"), player.clone()), player_count);
    }

    pub fn player_banned(env: &Env, admin: &Address, player: &Address) {
        env.events()
            .publish((symbol_short!("ban"), admin.clone()), player.clone());
    }

    pub fn player_unbanned(env: &Env, admin: &Address, player: &Address) {
        env.events()
            .publish((symbol_short!("unban"), admin.clone()), player.clone());
    }

    pub fn player_limits_configured(env: &Env, min_players: u32, max_players: u32) {
        env.events()
            .publish((symbol_short!("limits"),), (min_players, max_players));
    }

    pub fn upgraded(env: &Env, new_wasm_hash: &BytesN<32>) {
        env.events()
            .publish((symbol_short!("upgrade"),), new_wasm_hash.clone());
    }

    pub fn game_started(env: &Env, round: u32, duration_seconds: u64) {
        env.events()
            .publish((symbol_short!("started"),), (round, duration_seconds));
    }

    pub fn round_resolved(env: &Env, round: u32, eliminated: u32, survivors: u32) {
        env.events()
            .publish((symbol_short!("resolved"),), (round, eliminated, survivors));
    }

    pub fn player_eliminated(env: &Env, player: &Address, round: u32) {
        env.events()
            .publish((symbol_short!("elim"), player.clone()), round);
    }

    pub fn game_finished(env: &Env, winner: &Address, round: u32) {
        env.events()
            .publish((symbol_short!("finished"),), (winner.clone(), round));
    }

    pub fn prize_claimed(env: &Env, winner: &Address, amount: i128, yield_amount: i128) {
        env.events().publish(
            (symbol_short!("claimed"), winner.clone()),
            (amount, yield_amount),
        );
    }

    pub fn admin_changed(env: &Env, old_admin: &Address, new_admin: &Address) {
        env.events().publish(
            (symbol_short!("admin"),),
            (old_admin.clone(), new_admin.clone()),
        );
    }

    pub fn paused(env: &Env, caller: &Address, reason: &Symbol) {
        env.events()
            .publish((symbol_short!("paused"), caller.clone()), reason.clone());
    }

    pub fn unpaused(env: &Env, caller: &Address) {
        env.events()
            .publish((symbol_short!("unpaused"), caller.clone()), ());
    }

    pub fn vault_balance_decreased(env: &Env, previous_balance: i128, current_balance: i128) {
        env.events().publish(
            (symbol_short!("vaultdec"),),
            (previous_balance, current_balance),
        );
    }
}
