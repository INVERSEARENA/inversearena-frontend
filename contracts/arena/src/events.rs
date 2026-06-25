use soroban_sdk::{symbol_short, Address, Env, Symbol};

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

    /// Emit contract paused event
    pub fn contract_paused(env: &Env, admin: &Address, reason: &Symbol) {
        env.events().publish((symbol_short!("PAUSED"), admin.clone()), reason.clone());
    }

    /// Emit contract unpaused event
    pub fn contract_unpaused(env: &Env, admin: &Address) {
        env.events().publish((symbol_short!("UNPAUS"), admin.clone()), ());
    }

    /// Emit treasury address updated event
    pub fn treasury_updated(env: &Env, admin: &Address, new_treasury: &Address) {
        env.events().publish((symbol_short!("TRSRY"), admin.clone()), new_treasury);
    }

    /// Emit cooldown configured event
    pub fn cooldown_configured(env: &Env, admin: &Address, cooldown_seconds: &u64) {
        env.events().publish((symbol_short!("COOLDN"), admin.clone()), *cooldown_seconds);
    }

    /// Emit creator stake deposited event
    pub fn creator_stake_deposited(env: &Env, creator: &Address, amount: i128, total: i128) {
        env.events().publish((symbol_short!("STK_DEP"), creator.clone()), (amount, total));
    }

    /// Emit creator stake withdrawn event
    pub fn creator_stake_withdrawn(env: &Env, creator: &Address, amount: i128, slashed: bool) {
        env.events().publish((symbol_short!("STK_WTD"), creator.clone()), (amount, slashed));
    }

    /// Emit creator stake slashed event
    pub fn stake_slashed(env: &Env, creator: &Address, slashed_amount: i128, remaining_returned: i128) {
        env.events().publish((symbol_short!("STK_SLSH"), creator.clone()), (slashed_amount, remaining_returned));
    }

    /// Emit slash rate configured event
    pub fn slash_rate_configured(env: &Env, admin: &Address, slash_rate_bps: u32) {
        env.events().publish((symbol_short!("SLSH_CFG"), admin.clone()), slash_rate_bps);
    }

    /// Emit RWA yield received event
    pub fn rwa_yield_received(env: &Env, amount: i128) {
        env.events().publish((symbol_short!("RWAYLD"),), amount);
    }

    /// Emit round started event with round number and deadline
    pub fn round_started(env: &Env, round: u32, deadline: u64) {
        env.events().publish((symbol_short!("RND_STR"),), (round, deadline));
    }

    /// Emit commit submitted event (commit-reveal scheme)
    pub fn commit_submitted(env: &Env, player: &Address) {
        env.events().publish((symbol_short!("COMMIT"),), player);
    }

    /// Emit reveal submitted event (commit-reveal scheme)
    pub fn reveal_submitted(env: &Env, player: &Address) {
        env.events().publish((symbol_short!("REVEAL"),), player);
    }

    /// Emit admin transfer proposed event
    pub fn admin_transfer_proposed(env: &Env, current_admin: &Address, proposed_admin: &Address) {
        env.events().publish((symbol_short!("ADM_PROP"), current_admin.clone()), proposed_admin);
    }

    /// Emit admin transfer accepted event
    pub fn admin_transfer_accepted(env: &Env, new_admin: &Address) {
        env.events().publish((symbol_short!("ADM_ACPT"),), new_admin);
    }
}
