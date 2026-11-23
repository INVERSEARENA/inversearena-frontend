/// Factory contract event helpers — issue #1607.
///
/// **Convention** (normative — see `docs/event-schema.md`):
///
///   topic[0]  = contract namespace as a Symbol, max 9 chars (e.g. `"factory"`)
///   topic[1]  = event name as a Symbol (e.g. `"pool_cre"`)
///   topic[2+] = indexed addresses only (filterable, not counted toward data)
///
///   data      = versioned struct `{ v: u32, … }`
///
/// The `v` (version) field MUST be the first field in every data struct so
/// decoders can dispatch without reading further. Unknown versions must be
/// silently skipped, not failed.

use soroban_sdk::{Address, BytesN, Env, Symbol, symbol_short};

const NS: fn(&Env) -> Symbol = |env| Symbol::new(env, "factory");

/// Emitted when the factory is initialized.
///
/// ```text
/// topic[0] = "factory"
/// topic[1] = "init"
/// data     = { v: 1, admin: Address, min_stake: i128 }
/// ```
pub fn initialized(env: &Env, admin: &Address, min_stake: i128) {
    env.events().publish(
        (NS(env), symbol_short!("init")),
        (1u32, admin.clone(), min_stake),
    );
}

/// Emitted when a new pool / arena is created.
///
/// ```text
/// topic[0] = "factory"
/// topic[1] = "pool_cre"
/// topic[2] = host address  (indexed)
/// data     = { v: 1, pool_id: u32, arena: Address, entry_fee: i128 }
/// ```
pub fn pool_created(env: &Env, host: &Address, pool_id: u32, arena: &Address, entry_fee: i128) {
    env.events().publish(
        (NS(env), symbol_short!("pool_cre"), host.clone()),
        (1u32, pool_id, arena.clone(), entry_fee),
    );
}

/// Emitted when an arena's status is updated.
///
/// ```text
/// topic[0] = "factory"
/// topic[1] = "pool_st"
/// topic[2] = arena address  (indexed)
/// data     = { v: 1, pool_id: u32, new_status: u32 }
/// ```
///
/// `new_status` is the ordinal of `ArenaStatus` (`0=Pending`, `1=Active`,
/// `2=Finished`, `3=Cancelled`).
pub fn pool_status_updated(env: &Env, arena: &Address, pool_id: u32, new_status: u32) {
    env.events().publish(
        (NS(env), symbol_short!("pool_st"), arena.clone()),
        (1u32, pool_id, new_status),
    );
}

/// Emitted when a creator's stake is reclaimed.
///
/// ```text
/// topic[0] = "factory"
/// topic[1] = "stk_rclm"
/// topic[2] = creator address  (indexed)
/// data     = { v: 1, arena: Address, amount: i128 }
/// ```
pub fn stake_reclaimed(env: &Env, creator: &Address, arena: &Address, amount: i128) {
    env.events().publish(
        (NS(env), symbol_short!("stk_rclm"), creator.clone()),
        (1u32, arena.clone(), amount),
    );
}

/// Emitted when a host is added to the whitelist.
///
/// ```text
/// topic[0] = "factory"
/// topic[1] = "wl_add"
/// topic[2] = host address  (indexed)
/// data     = { v: 1 }
/// ```
pub fn whitelist_added(env: &Env, host: &Address) {
    env.events().publish(
        (NS(env), symbol_short!("wl_add"), host.clone()),
        (1u32,),
    );
}

/// Emitted when a host is removed from the whitelist.
///
/// ```text
/// topic[0] = "factory"
/// topic[1] = "wl_rem"
/// topic[2] = host address  (indexed)
/// data     = { v: 1 }
/// ```
pub fn whitelist_removed(env: &Env, host: &Address) {
    env.events().publish(
        (NS(env), symbol_short!("wl_rem"), host.clone()),
        (1u32,),
    );
}

/// Emitted when an approved vault is added.
pub fn vault_added(env: &Env, vault: &Address) {
    env.events().publish(
        (NS(env), symbol_short!("vlt_add"), vault.clone()),
        (1u32,),
    );
}

/// Emitted when an approved vault is removed.
pub fn vault_removed(env: &Env, vault: &Address) {
    env.events().publish(
        (NS(env), symbol_short!("vlt_rem"), vault.clone()),
        (1u32,),
    );
}

/// Emitted when an approved oracle is added.
pub fn oracle_added(env: &Env, oracle: &Address) {
    env.events().publish(
        (NS(env), symbol_short!("orc_add"), oracle.clone()),
        (1u32,),
    );
}

/// Emitted when an approved oracle is removed.
pub fn oracle_removed(env: &Env, oracle: &Address) {
    env.events().publish(
        (NS(env), symbol_short!("orc_rem"), oracle.clone()),
        (1u32,),
    );
}

/// Emitted when the factory WASM is upgraded.
///
/// ```text
/// topic[0] = "factory"
/// topic[1] = "upgrade"
/// data     = { v: 1, new_wasm_hash: BytesN<32> }
/// ```
pub fn upgraded(env: &Env, new_wasm_hash: &BytesN<32>) {
    env.events().publish(
        (NS(env), symbol_short!("upgrade")),
        (1u32, new_wasm_hash.clone()),
    );
}

/// Emitted when the factory is paused or unpaused.
pub fn pause_toggled(env: &Env, paused: bool) {
    env.events().publish(
        (NS(env), symbol_short!("pause")),
        (1u32, paused),
    );
}

/// Emitted when the admin changes.
pub fn admin_changed(env: &Env, old_admin: &Address, new_admin: &Address) {
    env.events().publish(
        (NS(env), symbol_short!("admin")),
        (1u32, old_admin.clone(), new_admin.clone()),
    );
}
