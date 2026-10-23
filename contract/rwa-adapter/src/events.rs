/// RWA Adapter contract event helpers — issue #1607.
///
/// Follows the same convention as factory/events.rs and arena/events.rs:
///
///   topic[0]  = contract namespace (`"rwa"`)
///   topic[1]  = event name
///   topic[2+] = indexed addresses only
///   data      = versioned tuple `(v: u32, …rest)`
///
/// Previous convention put amounts *in* topics (unindexable, larger).  All
/// events here move amounts to data.

use soroban_sdk::{Address, Env, Symbol, symbol_short};

const NS: fn(&Env) -> Symbol = |env| Symbol::new(env, "rwa");

/// Emitted when the adapter is initialized.
///
/// ```text
/// topic[0] = "rwa"
/// topic[1] = "init"
/// data     = (v=1, admin: Address, stake_token: Address, oracle: Address)
/// ```
pub fn initialized(env: &Env, admin: &Address, stake_token: &Address, oracle: &Address) {
    env.events().publish(
        (NS(env), symbol_short!("init")),
        (1u32, admin.clone(), stake_token.clone(), oracle.clone()),
    );
}

/// Emitted when funds are deposited into the adapter.
///
/// ```text
/// topic[0] = "rwa"
/// topic[1] = "deposit"
/// topic[2] = depositor address  (indexed)
/// data     = (v=1, amount: i128)
/// ```
///
/// Previously the amount was in topics (making it unindexable and bloating
/// the topic array).  Moved to data per normalization convention (#1607).
pub fn deposited(env: &Env, from: &Address, amount: i128) {
    env.events().publish(
        (NS(env), symbol_short!("deposit"), from.clone()),
        (1u32, amount),
    );
}

/// Emitted when funds are withdrawn from the adapter.
///
/// ```text
/// topic[0] = "rwa"
/// topic[1] = "withdraw"
/// topic[2] = recipient address  (indexed)
/// data     = (v=1, amount: i128)
/// ```
pub fn withdrawn(env: &Env, to: &Address, amount: i128) {
    env.events().publish(
        (NS(env), symbol_short!("withdraw"), to.clone()),
        (1u32, amount),
    );
}

/// Emitted when yield is harvested and distributed.
///
/// ```text
/// topic[0] = "rwa"
/// topic[1] = "yield"
/// data     = (v=1, yield_amount: i128, new_index: i128)
/// ```
pub fn yield_harvested(env: &Env, yield_amount: i128, new_index: i128) {
    env.events().publish(
        (NS(env), symbol_short!("yield")),
        (1u32, yield_amount, new_index),
    );
}

/// Emitted when the admin transfers admin rights.
pub fn admin_changed(env: &Env, old_admin: &Address, new_admin: &Address) {
    env.events().publish(
        (NS(env), symbol_short!("admin")),
        (1u32, old_admin.clone(), new_admin.clone()),
    );
}

/// Emitted when the WASM is upgraded.
pub fn upgraded(env: &Env) {
    env.events().publish(
        (NS(env), symbol_short!("upgrade")),
        (1u32,),
    );
}
