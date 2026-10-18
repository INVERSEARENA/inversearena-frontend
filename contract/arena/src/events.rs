/// Arena contract event helpers — issue #1607 normalization applied.
///
/// **Convention** (normative — see `docs/event-schema.md`):
///
///   topic[0]  = contract namespace: `"arena"` (Symbol)
///   topic[1]  = event name (Symbol, max 9 ASCII chars)
///   topic[2+] = indexed addresses only (filterable, not put in data)
///
///   data      = versioned tuple `(v: u32, …rest)` where `v` is FIRST so
///               decoders can version-dispatch without parsing further.
///               Unknown `v` values MUST be silently ignored, not failed.
///
/// Existing short-name topics (`symbol_short!("join")`, etc.) are preserved
/// in the topic tuple as `topic[1]` to avoid breaking existing indexers; the
/// namespace `"arena"` is prepended as `topic[0]`.  The data payload gains a
/// leading `v: u32` version field.
use crate::types::Choice;
use soroban_sdk::{Address, BytesN, Env, Symbol, symbol_short};

/// Namespace symbol shared by all arena events.
fn ns(env: &Env) -> Symbol {
    Symbol::new(env, "arena")
}

/// Schema version for the `rslvd2` event payload (#1394).
/// Bump and document in `docs/event-schema.md` when the payload shape changes;
/// consumers must ignore unknown newer versions.
pub const ROUND_PROOF_EVENT_VERSION: u32 = 1;

/// Current schema version for all *other* arena events (#1607).
/// Bump when a data-payload field is added, removed, or retyped.
pub const EVENT_SCHEMA_VERSION: u32 = 1;

pub struct ArenaEvents;

impl ArenaEvents {
    pub fn initialized(env: &Env, admin: &Address) {
        env.events()
            .publish((ns(env), symbol_short!("init")), (EVENT_SCHEMA_VERSION, admin.clone()));
    }

    pub fn player_joined(env: &Env, player: &Address, player_count: u32) {
        env.events()
            .publish((ns(env), symbol_short!("join"), player.clone()), (EVENT_SCHEMA_VERSION, player_count));
    }

    pub fn player_banned(env: &Env, admin: &Address, player: &Address) {
        env.events()
            .publish((ns(env), symbol_short!("ban"), admin.clone()), (EVENT_SCHEMA_VERSION, player.clone()));
    }

    pub fn player_unbanned(env: &Env, admin: &Address, player: &Address) {
        env.events()
            .publish((ns(env), symbol_short!("unban"), admin.clone()), (EVENT_SCHEMA_VERSION, player.clone()));
    }

    /// Emitted when a player withdraws from the lobby before the first round
    /// (#1580). `player_count` is the roster size after the removal.
    pub fn player_left(env: &Env, player: &Address, player_count: u32) {
        env.events()
            .publish((ns(env), symbol_short!("left"), player.clone()), (EVENT_SCHEMA_VERSION, player_count));
    }

    /// Emitted when an entry fee is returned to a player who left or was banned
    /// from the lobby before the first round (#1580, #1581).
    pub fn player_refunded(env: &Env, player: &Address, amount: i128) {
        env.events()
            .publish((ns(env), symbol_short!("refunded"), player.clone()), (EVENT_SCHEMA_VERSION, amount));
    }

    pub fn player_limits_configured(env: &Env, min_players: u32, max_players: u32) {
        env.events()
            .publish((ns(env), symbol_short!("limits")), (EVENT_SCHEMA_VERSION, min_players, max_players));
    }

    pub fn platform_fee_updated(env: &Env, admin: &Address, new_fee_bps: u32) {
        env.events()
            .publish((ns(env), symbol_short!("fee_upd"), admin.clone()), (EVENT_SCHEMA_VERSION, new_fee_bps));
    }

    pub fn upgrade_proposed(env: &Env, new_wasm_hash: &BytesN<32>, proposed_at: u64) {
        env.events().publish(
            (ns(env), symbol_short!("up_prop")),
            (EVENT_SCHEMA_VERSION, new_wasm_hash.clone(), proposed_at),
        );
    }

    pub fn upgraded(env: &Env, new_wasm_hash: &BytesN<32>) {
        env.events()
            .publish((ns(env), symbol_short!("upgrade")), (EVENT_SCHEMA_VERSION, new_wasm_hash.clone()));
    }

    pub fn game_started(env: &Env, round: u32, duration_seconds: u64) {
        env.events()
            .publish((ns(env), symbol_short!("started")), (EVENT_SCHEMA_VERSION, round, duration_seconds));
    }

    pub fn round_resolved(env: &Env, round: u32, eliminated: u32, survivors: u32) {
        env.events()
            .publish((ns(env), symbol_short!("resolved")), (EVENT_SCHEMA_VERSION, round, eliminated, survivors));
    }

    /// Emitted alongside `round_resolved` (#1394) with enough data for a
    /// client to independently recompute survivor membership: the full
    /// heads/tails tally and the surviving choice (if any). Additive —
    /// `round_resolved` keeps firing unchanged for existing consumers; this
    /// is a *new* topic, not a payload change to an existing one, so no
    /// existing indexer breaks by ignoring it.
    ///
    /// `surviving_choice` is `None` encoded as `heads_count == tails_count`
    /// when both are nonzero (a tie — nobody eliminated); callers should use
    /// `crate::eliminations::surviving_choice` on the tally rather than
    /// inferring it from a sentinel, since Soroban events cannot carry
    /// `Option<Choice>` as a topic-friendly primitive here.
    pub fn round_resolved_v2(
        env: &Env,
        round: u32,
        heads_count: u32,
        tails_count: u32,
        eliminated: u32,
        survivors: u32,
    ) {
        env.events().publish(
            (ns(env), symbol_short!("rslvd2"), round),
            (
                ROUND_PROOF_EVENT_VERSION,
                heads_count,
                tails_count,
                eliminated,
                survivors,
            ),
        );
    }

    pub fn round_tied(env: &Env, round: u32, survivors: u32) {
        env.events()
            .publish((ns(env), symbol_short!("tied")), (EVENT_SCHEMA_VERSION, round, survivors));
    }

    pub fn player_eliminated(env: &Env, player: &Address, round: u32) {
        env.events()
            .publish((ns(env), symbol_short!("elim"), player.clone()), (EVENT_SCHEMA_VERSION, round));
    }

    pub fn game_finished(env: &Env, winner: &Address, round: u32) {
        env.events()
            .publish((ns(env), symbol_short!("finished")), (EVENT_SCHEMA_VERSION, winner.clone(), round));
    }

    pub fn prize_claimed(env: &Env, winner: &Address, amount: i128, yield_amount: i128) {
        env.events().publish(
            (ns(env), symbol_short!("claimed"), winner.clone()),
            (EVENT_SCHEMA_VERSION, amount, yield_amount),
        );
    }

    pub fn admin_changed(env: &Env, old_admin: &Address, new_admin: &Address) {
        env.events().publish(
            (ns(env), symbol_short!("admin")),
            (EVENT_SCHEMA_VERSION, old_admin.clone(), new_admin.clone()),
        );
    }

    pub fn paused(env: &Env, caller: &Address, reason: &Symbol) {
        env.events()
            .publish((ns(env), symbol_short!("paused"), caller.clone()), (EVENT_SCHEMA_VERSION, reason.clone()));
    }

    pub fn unpaused(env: &Env, caller: &Address) {
        env.events()
            .publish((ns(env), symbol_short!("unpaused"), caller.clone()), (EVENT_SCHEMA_VERSION,));
    }

    pub fn arena_expired(env: &Env) {
        env.events().publish((ns(env), symbol_short!("expired")), (EVENT_SCHEMA_VERSION,));
    }

    pub fn vault_balance_decreased(env: &Env, previous_balance: i128, current_balance: i128) {
        env.events().publish(
            (ns(env), symbol_short!("vaultdec")),
            (EVENT_SCHEMA_VERSION, previous_balance, current_balance),
        );
    }

    /// Emitted when the yield oracle cross-contract call fails. The arena falls
    /// back to a 0-bps yield, but surfaces the failure so operators can detect a
    /// misconfigured, unreachable, or malfunctioning oracle.
    pub fn vault_oracle_failed(env: &Env, oracle: &Address) {
        env.events()
            .publish((ns(env), Symbol::new(env, "vault_orc_f"), oracle.clone()), (EVENT_SCHEMA_VERSION,));
    }

    /// Emitted by `set_oracle_freshness_policy` (#1512).
    pub fn oracle_freshness_policy_updated(
        env: &Env,
        admin: &Address,
        max_age_secs: u64,
        warn_age_secs: u64,
    ) {
        env.events().publish(
            (ns(env), symbol_short!("frsh_pol"), admin.clone()),
            (EVENT_SCHEMA_VERSION, max_age_secs, warn_age_secs),
        );
    }

    /// Emitted on every `resolve_round` attempt that reaches the oracle
    /// freshness check (#1512), success or rejection — `classification_code`
    /// is `OracleFreshness::as_code()`'s value.
    pub fn oracle_freshness_observed(env: &Env, round: u32, classification_code: u32, age_secs: u64) {
        env.events().publish(
            (ns(env), Symbol::new(env, "orc_fresh")),
            (EVENT_SCHEMA_VERSION, round, classification_code, age_secs),
        );
    }

    /// Emitted when `resolve_round` refuses to proceed because the oracle's
    /// observation is `Stale` (#1512).
    pub fn oracle_stale_rejected(env: &Env, round: u32, age_secs: u64) {
        env.events().publish(
            (ns(env), Symbol::new(env, "orc_stale")),
            (EVENT_SCHEMA_VERSION, round, age_secs),
        );
    }

    pub fn arena_cancelled(env: &Env, admin: &Address) {
        env.events()
            .publish((ns(env), symbol_short!("cancel"), admin.clone()), (EVENT_SCHEMA_VERSION,));
    }

    pub fn refund_claimed(env: &Env, player: &Address) {
        env.events()
            .publish((ns(env), symbol_short!("refund"), player.clone()), (EVENT_SCHEMA_VERSION,));
    }

    pub fn leaderboard_updated(env: &Env) {
        env.events().publish((ns(env), symbol_short!("lboard")), (EVENT_SCHEMA_VERSION,));
    }

    pub fn commitment_submitted(env: &Env, player: &Address, round: u32) {
        env.events()
            .publish((ns(env), symbol_short!("commit"), player.clone()), (EVENT_SCHEMA_VERSION, round));
    }

    pub fn choice_revealed(env: &Env, player: &Address, choice: &Choice, round: u32) {
        env.events()
            .publish((ns(env), symbol_short!("reveal"), player.clone()), (EVENT_SCHEMA_VERSION, *choice, round));
    }
}
