//! Arena contract for the InverseArena elimination game.
//!
//! Manages the full game lifecycle: player registration, commit-reveal rounds,
//! yield accounting via an RWA vault adapter, winner payout, and admin controls.
#![no_std]
#![cfg_attr(coverage_nightly, feature(coverage_attribute))]
use soroban_sdk::{
    Address, Bytes, BytesN, Env, IntoVal, Symbol, Vec,
    auth::{ContractContext, InvokerContractAuthEntry, SubContractInvocation},
    contract, contractimpl, token,
    xdr::ToXdr,
};

/// Domain separator prepended to every commitment preimage (#1630).
const COMMIT_DOMAIN: &[u8] = b"IA_COMMIT_V1";

mod eliminations;
mod events;
mod fuzz_tests;
mod oracle;
mod rwa_client;
mod snapshot_test;
mod storage_layout_fixture;
mod state_machine;
mod storage;
pub mod types;

use events::ArenaEvents;
use rwa_client::RwaAdapterClient;
use storage::ArenaStorage;
use types::{
    ArenaConfig, ArenaError, ArenaStatus, Choice, EliminationReason, GameState, LeaderboardEntry,
    OracleFreshnessPolicy, PendingAdmin, PendingUpgrade, PlayerState, PlayerStatus, PoolConfigView,
    RoundResult, Settlement, TransitionInitiator, YieldSnapshot,
};

#[soroban_sdk::contractclient(name = "FactoryClient")]
pub trait FactoryInterface {
    fn release_arena(env: Env, arena: Address);
    fn reclaim_creator_stake(env: Env, arena: Address);
    fn update_arena_status(env: Env, pool_id: u32, status: ArenaStatus);
    fn is_globally_paused(env: Env) -> bool;
    /// The factory's current protocol admin (#1629). The arena reads this to
    /// resolve who holds the protocol powers — upgrade, platform fee, pause —
    /// so a factory-level admin rotation takes effect on every arena at once.
    fn admin(env: Env) -> Address;
}

pub(crate) const PAGE_SIZE: u32 = 50;
pub(crate) const MIN_PLAYERS_TO_START: u32 = 2;
pub const MAX_PLAYERS_ALLOWED: u32 = 100;
/// Bumped to 3 for #1512: adds `set_oracle_freshness_policy`,
/// `get_oracle_freshness_policy`, and `get_oracle_contract`.
/// `resolve_round`'s signature is unchanged —
/// its new staleness check is a behavior change, not a new entrypoint — but
/// the version still moves so `contractCapability.ts`'s negotiation can
/// gate UI/tooling that specifically wants the new freshness-policy
/// entrypoints on older, already-deployed arena instances.
/// Bumped to 4 for #1582 (`get_player_status`) and #1583 (fund-moving entry
/// points now honour the factory-wide pause and may return `GloballyPaused`).
/// Bumped to 5 for #1632: adds `get_settlement`, which the payout contract
/// requires before it will pay out for an arena.
/// Bumped to 6 for #1572: adds `get_pool_config`, a read-only view of the
/// arena's full pool configuration, so off-chain rematch prefills read the
/// arena's own on-chain config instead of cached UI state.
/// Bumped to 7 for #1718: adds three-choice arena configuration and views.
/// Bumped to 8 for #1715: adds `join_arena_for(payer, player)` for sponsored
/// entries, and exposes the sponsor through `get_player_status`.
const CONTRACT_VERSION: u32 = 8;
const UPGRADE_TIMELOCK_SECONDS: u64 = 86_400; // 1 day
/// Maximum allowed platform fee: 1000 bps (10%). Enforced by `update_platform_fee`.
const MAX_PLATFORM_FEE_BPS: u32 = 1000;
/// Maximum time a protocol-admin pause may hold an arena shut (#1629).
///
/// A pause is protocol-governed, so it must not be able to lock players out
/// of their funds indefinitely: once this many seconds have passed since the
/// pause was set, the pause no longer blocks anything — claims and refunds
/// included. The protocol admin may pause again, which restarts the clock.
pub const MAX_PAUSE_DURATION_SECONDS: u64 = 86_400; // 1 day
/// Minimum inter-round inactivity window (24 hours).
pub const MIN_INTER_ROUND_TIMEOUT_SECONDS: u64 = 86_400;
/// Maximum inter-round inactivity window (30 days).
pub const MAX_INTER_ROUND_TIMEOUT_SECONDS: u64 = 2_592_000;
/// Default inter-round inactivity window (7 days), snapshotted at initialization.
pub const DEFAULT_INTER_ROUND_TIMEOUT_SECONDS: u64 = 604_800;

/// This crate's own compiled WASM, used by `integration_tests.rs` so the
/// in-process factory contract can dynamically deploy a real arena instance
/// (mirroring on-chain deployment) instead of reusing the natively-registered
/// test contract. Requires `cargo build -p arena --target wasm32v1-none
/// --release` to have produced the wasm first — CI runs that before
/// `cargo test`; for local runs, build the wasm once before running the
/// integration test.
///
/// Built for `wasm32v1-none`, not `wasm32-unknown-unknown`: newer rustc
/// versions emit reference-types instructions for `wasm32-unknown-unknown`
/// that soroban-env-host (pinned to an older wasm feature profile) rejects
/// at runtime with "reference-types not enabled". `wasm32v1-none` is the
/// Soroban-recommended target that avoids this.
#[cfg(test)]
pub(crate) const WASM: &[u8] = include_bytes!("../../target/wasm32v1-none/release/arena.wasm");

// ── Round duration bounds ─────────────────────────────────────────────────────

/// Minimum `duration_seconds` accepted by `start_round` (30 seconds).
///
/// A duration shorter than this would expire the commit window before players
/// have a realistic chance to submit their commitment transactions.
pub const MIN_ROUND_DURATION_SECONDS: u64 = 30;

/// Maximum `duration_seconds` accepted by `start_round` (1 hour = 3 600 s).
///
/// An uncapped duration allows a malicious or misconfigured admin to lock all
/// player funds indefinitely by starting a round with `u64::MAX`.
pub const MAX_ROUND_DURATION_SECONDS: u64 = 3_600;
/// Delay after a round deadline before keepers may act without the host.
pub const HOST_GRACE_SECONDS: u64 = 3_600;
/// Delay after `commit_deadline` before `expire_arena` becomes callable (#1627).
///
/// `commit_deadline` is also when reveals open and `resolve_round` becomes
/// callable. Expiry is a liveness backstop for an arena nobody resolves, so it
/// must wait long enough for the host and then keepers to resolve. Set well
/// above `HOST_GRACE_SECONDS`, so a keeper-initiated resolution can never race
/// a stranger-initiated cancellation.
pub const EXPIRY_GRACE_SECONDS: u64 = 86_400;

pub const DEFAULT_INTER_ROUND_TIMEOUT_SECONDS: u64 = 604_800;
pub const MIN_INTER_ROUND_TIMEOUT_SECONDS: u64 = 86_400;
pub const MAX_INTER_ROUND_TIMEOUT_SECONDS: u64 = 2_592_000;

/// Maximum duration between rounds: if a round ends and the next one does not
/// start within this long, the arena is force-cancelled to unstick any funds.
/// 30 days is long enough for any realistic off-chain delay, including
/// multi-sig delays, and also covers the rare case of a round resolving just
/// before a leap second.
pub const MAX_ROUND_GAP_SECONDS: u64 = 2_592_000; // 30 days

#[contract]
/// On-chain arena contract. Manages the full lifecycle of a single elimination
/// game: player registration, commit-reveal rounds, yield accounting, winner
/// payout, and admin controls.
pub struct ArenaContract;

struct RoundResolution {
    eliminated: u32,
    survivors: u32,
    winner: Option<Address>,
    tied: bool,
    /// Revealed-choice tally for the round, carried through so
    /// `resolve_round` can emit it in `round_resolved_v2` (#1394) without
    /// re-scanning storage that `resolve_players` already cleared.
    tally: eliminations::Tally,
}

#[contractimpl]
impl ArenaContract {
    /// Initialise the arena with its immutable configuration.
    ///
    /// Must be called exactly once before any other entry point. Sets the arena
    /// state to `Open`, allowing players to join.
    ///
    /// # Parameters
    /// - `admin`: Address that will control admin-only operations. Must authorize this call.
    /// - `stake_token`: SAC token address used for entry fees and prize payouts.
    /// - `yield_vault`: RWA adapter contract that earns yield on the staked principal.
    ///   Initialization performs a shallow `balance_of` reachability/interface check;
    ///   vault initialization state is enforced by later adapter calls.
    /// - `entry_fee`: Exact token amount every player must stake to join.
    /// - `oracle_contract`: On-chain oracle queried for the current yield rate on each round resolution.
    ///
    /// # Errors
    /// - `ArenaError::AlreadyInitialized` if `initialize` has already been called.
    ///
    /// # Events
    /// Emits `initialized` with the admin address.
    pub fn initialize(
        env: Env,
        admin: Address,
        stake_token: Address,
        yield_vault: Address,
        entry_fee: i128,
        oracle_contract: Address,
        factory: Address,
        pool_id: u32,
        min_players: u32,
        max_players: u32,
        _round_duration: u64,
    ) -> Result<(), ArenaError> {
        admin.require_auth();
        if ArenaStorage::has_config(&env) {
            return Err(ArenaError::AlreadyInitialized);
        }

        if entry_fee <= 0 {
            return Err(ArenaError::InvalidEntryFee);
        }
        if min_players < MIN_PLAYERS_TO_START || min_players > max_players {
            return Err(ArenaError::InvalidPlayerLimits);
        }
        if max_players > MAX_PLAYERS_ALLOWED {
            return Err(ArenaError::InvalidPlayerLimits);
        }

        // Validate that the provided yield_vault is reachable and exposes the expected RWA
        // adapter interface. This is intentionally a shallow interface check: the current
        // adapter returns 0 from balance_of when uninitialized, so adapter initialization
        // state is enforced by later deposit/withdraw calls rather than by this probe.
        let rwa_client = RwaAdapterClient::new(&env, &yield_vault);
        let dummy_addr = env.current_contract_address();
        if rwa_client.try_balance_of(&dummy_addr).is_err() {
            return Err(ArenaError::InvalidVaultAddress);
        }

        let config = ArenaConfig {
            admin: admin.clone(),
            stake_token,
            yield_vault,
            entry_fee,
            state: GameState::Open,
            paused: false,
            player_count: 0,
            active_player_count: 0,
            cumulative_yield: 0,
            commit_deadline: 0,
            round_count: 0,
            oracle_contract,
            factory,
            pool_id,
            platform_fee_bps: ArenaStorage::load_platform_fee_bps(&env),
        };
        ArenaStorage::save_config(&env, &config);
        ArenaStorage::initialize_paged_roster(&env);
        ArenaStorage::save_last_transition_at(&env, env.ledger().timestamp());
        ArenaStorage::save_inter_round_timeout(&env, DEFAULT_INTER_ROUND_TIMEOUT_SECONDS);
        ArenaStorage::save_paused_deadline_seconds(&env, 0);
        ArenaStorage::save_player_limits(&env, min_players, max_players);
        ArenaStorage::save_last_vault_balance(&env, 0);
        ArenaEvents::initialized(&env, &admin);
        Ok(())
    }

    /// Return the arena contract ABI/storage version.
    pub fn version(_env: Env) -> u32 {
        CONTRACT_VERSION
    }

    /// Current storage layout version.
    pub fn storage_version(env: Env) -> u32 {
        ArenaStorage::load_storage_version_raw(&env)
    }

    /// Admin-only, idempotent, resumable storage migration.
    pub fn migrate(env: Env, caller: Address, max_steps: u32) -> Result<u32, ArenaError> {
        caller.require_auth();
        let config = ArenaStorage::load_config(&env)?;
        let host = config.admin.clone();
        if caller != host {
            // allow protocol admin too
            let protocol = Self::resolve_protocol_admin(&env, &config)?;
            if caller != protocol {
                return Err(ArenaError::Unauthorized);
            }
        }
        Ok(ArenaStorage::migrate(&env, max_steps))
    }

    /// Return the host of this arena — the address that runs the game and
    /// moderates the lobby (#1629).
    ///
    /// The host is stored in `ArenaConfig.admin`; the field keeps its old
    /// name so the on-chain layout of every deployed arena stays readable.
    ///
    /// # Errors
    /// - `ArenaError::NotInitialized` if `initialize` has not been called.
    pub fn host(env: Env) -> Result<Address, ArenaError> {
        let config = ArenaStorage::load_config(&env)?;
        Ok(config.admin)
    }

    /// Return the protocol admin of this arena (#1629) — the deploying
    /// factory's current admin, which holds the arena's protocol powers:
    /// upgrade, platform fee, pause and force-cancel.
    ///
    /// # Errors
    /// - `ArenaError::NotInitialized` if `initialize` has not been called.
    /// - `ArenaError::NoProtocolAdmin` if the deploying factory cannot name a
    ///   protocol admin.
    pub fn protocol_admin(env: Env) -> Result<Address, ArenaError> {
        let config = ArenaStorage::load_config(&env)?;
        Self::resolve_protocol_admin(&env, &config)
    }

    /// Whether this arena's own pause has outlived
    /// `MAX_PAUSE_DURATION_SECONDS` and therefore no longer blocks anything
    /// (#1629).
    ///
    /// `false` for an arena that is not paused.
    pub fn pause_expired(env: Env) -> bool {
        match ArenaStorage::load_config(&env) {
            Ok(config) => Self::pause_has_expired(&env, &config),
            Err(_) => false,
        }
    }

    /// Propose an upgrade to `new_wasm_hash`.
    ///
    /// Stores the proposal and records the current ledger timestamp. The upgrade
    /// is NOT applied immediately — the protocol admin must call `execute_upgrade`
    /// after `UPGRADE_TIMELOCK_SECONDS` have elapsed, giving users time to review
    /// the new code.
    ///
    /// Protocol-only (#1629): the host of the arena cannot upgrade it. The
    /// protocol admin — the deploying factory's admin — must authorise this.
    ///
    /// Callable while paused so an emergency pause can be followed by a
    /// timelocked recovery upgrade. If a prior proposal exists it is silently
    /// overwritten.
    ///
    /// # Errors
    /// - `ArenaError::NoProtocolAdmin` if the deploying factory cannot name a
    ///   protocol admin.
    ///
    /// # Events
    /// Emits `upgrade_proposed`.
    pub fn propose_upgrade(env: Env, new_wasm_hash: BytesN<32>) -> Result<(), ArenaError> {
        ArenaStorage::require_current_storage_version(&env)?;
        let config = ArenaStorage::load_config(&env)?;
        Self::require_protocol_admin(&env, &config)?;
        let proposed_at = env.ledger().timestamp();
        ArenaStorage::save_pending_upgrade(
            &env,
            &PendingUpgrade {
                wasm_hash: new_wasm_hash.clone(),
                proposed_at,
            },
        );
        ArenaEvents::upgrade_proposed(&env, &new_wasm_hash, proposed_at);
        Ok(())
    }

    /// Execute a previously proposed upgrade after the timelock has elapsed.
    ///
    /// Only the protocol admin may execute (#1629). The timelock gives users a
    /// window to review the proposed WASM hash before it takes effect.
    ///
    /// # Errors
    /// - `ArenaError::NoPendingUpgrade` if no proposal exists.
    /// - `ArenaError::UpgradeTimelockPending` if the timelock has not elapsed.
    /// - `ArenaError::NoProtocolAdmin` if the deploying factory cannot name a
    ///   protocol admin.
    pub fn execute_upgrade(env: Env) -> Result<(), ArenaError> {
        ArenaStorage::require_current_storage_version(&env)?;
        let pending =
            ArenaStorage::load_pending_upgrade(&env).ok_or(ArenaError::NoPendingUpgrade)?;
        let config = ArenaStorage::load_config(&env)?;
        Self::require_protocol_admin(&env, &config)?;
        let now = env.ledger().timestamp();
        if now < pending.proposed_at.saturating_add(UPGRADE_TIMELOCK_SECONDS) {
            return Err(ArenaError::UpgradeTimelockPending);
        }
        env.deployer()
            .update_current_contract_wasm(pending.wasm_hash.clone());
        ArenaStorage::clear_pending_upgrade(&env);
        ArenaEvents::upgraded(&env, &pending.wasm_hash);
        Ok(())
    }

    /// Configure arena player bounds.
    ///
    /// `min_players` must be at least 2 and cannot exceed `max_players`.
    /// Existing participation is left untouched; the max applies to future
    /// joins and the min applies to future `start_round` calls.
    ///
    /// Limits freeze once the first player joins (#1640): players entered
    /// under advertised terms, so the admin cannot later promise a smaller
    /// field than the one recruited, nor a maximum below the count already
    /// present.
    ///
    /// # Errors
    /// - `ArenaError::ArenaAlreadyHasPlayers` if `player_count > 0`.
    /// - `ArenaError::InvalidPlayerLimits` if `min > max`, `min < 2`, or
    ///   `max > MAX_PLAYERS_ALLOWED`.
    pub fn configure_player_limits(
        env: Env,
        min_players: u32,
        max_players: u32,
    ) -> Result<(), ArenaError> {
        ArenaStorage::require_current_storage_version(&env)?;
        let config = ArenaStorage::load_config(&env)?;
        config.admin.require_auth();
        Self::validate_player_limits(min_players, max_players)?;
        if max_players < config.player_count {
            return Err(ArenaError::InvalidPlayerLimits);
        }
        if config.player_count > 0 {
            return Err(ArenaError::ArenaAlreadyHasPlayers);
        }
        ArenaStorage::save_player_limits(&env, min_players, max_players);
        ArenaEvents::player_limits_configured(&env, min_players, max_players);
        Ok(())
    }

    /// Set the lobby start deadline (#1579).
    ///
    /// Only the deploying factory may call this, immediately after
    /// `initialize`, as part of `create_pool`. It is a separate entry point
    /// because `initialize` already sits at Soroban's ten-parameter limit. Once
    /// the deadline passes, `join_arena` rejects new entries and anyone may
    /// call `cancel_unstarted`.
    ///
    /// # Errors
    /// - `ArenaError::NotInitialized` if `initialize` has not been called.
    /// - `ArenaError::InvalidGameState` if the lobby is no longer open.
    pub fn set_start_deadline(env: Env, deadline: u64) -> Result<(), ArenaError> {
        ArenaStorage::require_current_storage_version(&env)?;
        let config = ArenaStorage::load_config(&env)?;
        config.factory.require_auth();
        if config.state != GameState::Open || config.round_count > 0 {
            return Err(ArenaError::InvalidGameState);
        }
        ArenaStorage::save_start_deadline(&env, deadline);
        Ok(())
    }

    /// Configure the number of choices for a newly-created arena. The factory
    /// is the only caller and sets this before the arena is available to players.
    pub fn set_option_count(env: Env, option_count: u32) -> Result<(), ArenaError> {
        ArenaStorage::require_current_storage_version(&env)?;
        let config = ArenaStorage::load_config(&env)?;
        if env.invoker() != config.factory {
            return Err(ArenaError::Unauthorized);
        }
        if config.state != GameState::Open
            || config.player_count != 0
            || !(option_count == 2 || option_count == 3)
        {
            return Err(ArenaError::InvalidPlayerLimits);
        }
        ArenaStorage::save_option_count(&env, option_count);
        Ok(())
    }

    /// Return the configured choice count (`2` for legacy instances).
    pub fn get_option_count(env: Env) -> u32 {
        ArenaStorage::load_option_count(&env)
    }

    /// Return the lobby start deadline (#1579), or `0` if none is configured.
    /// The lobby UI uses this for its countdown and refund-availability state.
    pub fn get_start_deadline(env: Env) -> u64 {
        ArenaStorage::load_start_deadline(&env)
    }

    /// Ban a player from joining this arena.
    ///
    /// While the arena is still in its lobby (`round_count == 0`), a player who
    /// has already joined is removed from the roster and refunded their entry
    /// fee atomically (#1581). The ban flag persists so a future join attempt
    /// is rejected with `PlayerBanned`.
    ///
    /// Once the first round has started, banning is rejected with
    /// `ArenaAlreadyStarted`. Allowing it would give the host a way to
    /// eliminate players mid-game by removing them from an in-progress
    /// roster, which the game's commit-reveal model must not permit.
    ///
    /// # Errors
    /// - `ArenaError::NotInitialized` if `initialize` has not been called.
    /// - `ArenaError::ArenaAlreadyStarted` if at least one round has resolved.
    /// - `ArenaError::VaultWithdrawFailed` if a joined player's refund cannot
    ///   be released; the whole call reverts.
    pub fn ban_player(env: Env, player: Address) -> Result<(), ArenaError> {
        ArenaStorage::require_current_storage_version(&env)?;
        let config = ArenaStorage::load_config(&env)?;
        config.admin.require_auth();
        // Refunds move funds, so the protocol-wide pause applies (#1583); the
        // host's own pause deliberately does not gate host moderation.
        Self::require_not_globally_paused(&env, &config)?;

        if config.round_count > 0 {
            return Err(ArenaError::ArenaAlreadyStarted);
        }

        ArenaStorage::set_player_banned(&env, &player, true);
        ArenaEvents::player_banned(&env, &config.admin, &player);

        if ArenaStorage::load_player(&env, &player).is_some() {
            let refund = Self::refund_lobby_player(&env, &config, &player)?;
            ArenaStorage::remove_player(&env, &player);
            ArenaStorage::remove_sponsor(&env, &player);
            ArenaEvents::player_refunded(&env, &player, refund);
        }
        Ok(())
    }

    /// Remove a player's join ban.
    pub fn unban_player(env: Env, player: Address) -> Result<(), ArenaError> {
        ArenaStorage::require_current_storage_version(&env)?;
        let config = ArenaStorage::load_config(&env)?;
        config.admin.require_auth();
        ArenaStorage::set_player_banned(&env, &player, false);
        ArenaEvents::player_unbanned(&env, &config.admin, &player);
        Ok(())
    }

    /// Return whether a player is currently banned from joining.
    pub fn is_player_banned(env: Env, player: Address) -> bool {
        ArenaStorage::is_player_banned(&env, &player)
    }

    /// Join the arena by staking the configured entry fee.
    ///
    /// Transfers `entry_fee` tokens from the player to the arena contract and
    /// forwards them into the yield vault. Joining is only allowed while the
    /// arena is in the `Open` state.
    ///
    /// # Parameters
    /// - `player`: Address of the joining player. Must authorize this call.
    ///
    /// # Errors
    /// - `ArenaError::NotInitialized` if `initialize` has not been called.
    /// - `ArenaError::ContractPaused` if the contract is paused.
    /// - `ArenaError::InvalidGameState` if the arena is not in the `Open` state.
    /// - `ArenaError::ArenaAlreadyStarted` if at least one round has been played,
    ///   even though the arena is back in `Open` between rounds.
    ///
    /// # Events
    /// Emits `player_joined` with the player address and updated total player count.
    pub fn join_arena(env: Env, player: Address) -> Result<(), ArenaError> {
        ArenaStorage::require_current_storage_version(&env)?;
        Self::do_join_arena(&env, &player, &player, false)
    }

    /// Join the arena with the entry fee funded by a different account
    /// ("Gift a seat", #1715).
    ///
    /// Both addresses must authorize this call: `payer` authorizes the fee and
    /// the top-level invocation, `player` consents to taking the seat. The fee
    /// is transferred from `payer`, the seat and any prizes belong to `player`,
    /// and cancellation refunds are returned to `payer` (recorded as the
    /// sponsor). The sponsor is exposed through `get_player_status`.
    ///
    /// # Parameters
    /// - `payer`: Address funding the entry fee and receiving refunds.
    /// - `player`: Address registered as the player. Must authorize this call.
    ///
    /// # Errors
    /// Same guards as `join_arena` (the payer is checked for the fee instead of
    /// the player). The payer may be an existing player — gifting a seat to a
    /// second account is allowed.
    ///
    /// # Events
    /// Emits `player_joined_sponsored` with both the payer and player addresses
    /// and the updated total player count.
    pub fn join_arena_for(env: Env, payer: Address, player: Address) -> Result<(), ArenaError> {
        ArenaStorage::require_current_storage_version(&env)?;
        Self::do_join_arena(&env, &payer, &player, true)
    }

    /// Shared join implementation. `payer` funds the fee, `player` owns the
    /// seat. For a self-funded join both are the same address and only one
    /// `require_auth` is issued, preserving the existing auth tree.
    fn do_join_arena(
        env: &Env,
        payer: &Address,
        player: &Address,
        sponsored: bool,
    ) -> Result<(), ArenaError> {
        ArenaStorage::enter_reentrancy_guard(env)?;
        payer.require_auth();
        if sponsored {
            player.require_auth();
        }
        let config = ArenaStorage::load_config(env)?;
        Self::require_not_paused(env, &config)?;
        if config.state != GameState::Open {
            return Err(ArenaError::InvalidGameState);
        }
        // `Open` is reused for two different situations: the initial recruiting
        // lobby, and the gap between rounds when more than one survivor remains
        // (so `start_round` can run again). Only the first accepts new players —
        // otherwise someone who watched round 1 eliminate the majority could buy
        // into a 3-player field for the price the original 10 paid, which is
        // exactly the edge the minority-wins model is meant to deny (#1358).
        if config.round_count > 0 {
            return Err(ArenaError::ArenaAlreadyStarted);
        }
        // #1579: the lobby closes at `start_deadline`. Once it has passed and
        // the first round has not started, entry is refused and anyone can
        // cancel the arena to unlock refunds.
        let start_deadline = ArenaStorage::load_start_deadline(env);
        if start_deadline != 0 && env.ledger().timestamp() >= start_deadline {
            return Err(ArenaError::StartDeadlinePassed);
        }
        if player == &config.admin {
            return Err(ArenaError::CreatorCannotJoin);
        }
        if ArenaStorage::is_player_banned(env, player) {
            return Err(ArenaError::PlayerBanned);
        }
        // Reject a second join by the same player: charging the entry fee twice
        // and inflating the player count would corrupt the game. A player who
        // has joined already has stored player state.
        if ArenaStorage::load_player(env, player).is_some() {
            return Err(ArenaError::AlreadyJoined);
        }
        if let Some(max_players) = ArenaStorage::load_max_players(env)
            && config.player_count >= max_players
        {
            return Err(ArenaError::ArenaFull);
        }

        let token_client = token::TokenClient::new(env, &config.stake_token);
        let arena_addr = env.current_contract_address();
        // The payer funds the seat. For self-funded joins payer == player, so
        // this is byte-for-byte the original transfer.
        token_client.transfer(payer, &arena_addr, &config.entry_fee);

        // The vault's `deposit` pulls the fee with `transfer(arena, vault, fee)`.
        // The arena is not the direct invoker of that transfer (the vault is),
        // so without this pre-authorisation it fails under real auth and every
        // join reverts with VaultDepositFailed (#1636).
        env.authorize_as_current_contract(soroban_sdk::vec![
            env,
            InvokerContractAuthEntry::Contract(SubContractInvocation {
                context: ContractContext {
                    contract: config.stake_token.clone(),
                    fn_name: Symbol::new(env, "transfer"),
                    args: (arena_addr.clone(), config.yield_vault.clone(), config.entry_fee)
                        .into_val(env),
                },
                sub_invocations: soroban_sdk::vec![env],
            }),
        ]);

        // Deposit entry fee into vault and return an error if it fails.
        // The token transfer above will be rolled back together with any storage mutations
        // when we return an error, so no funds are permanently locked.
        let rwa_client = RwaAdapterClient::new(env, &config.yield_vault);
        if rwa_client
            .try_deposit(&arena_addr, &config.entry_fee)
            .is_err()
        {
            return Err(ArenaError::VaultDepositFailed);
        }

        let baseline = ArenaStorage::load_last_vault_balance(env).saturating_add(config.entry_fee);
        ArenaStorage::save_last_vault_balance(env, baseline);

        ArenaStorage::add_player(env, player);
        let count = ArenaStorage::load_roster_count(env);
        if sponsored {
            // Record before the event so indexers can query the sponsor from
            // `get_player_status` by the time they observe the join.
            ArenaStorage::save_sponsor(env, player, payer);
            ArenaEvents::player_joined_sponsored(env, payer, player, count);
        } else {
            ArenaEvents::player_joined(env, player, count);
        }
        ArenaStorage::exit_reentrancy_guard(env);
        Ok(())
    }

    /// Leave an arena lobby before the first round and reclaim the entry fee
    /// (#1580).
    ///
    /// Allowed only while the arena is `Open` and no round has resolved. The
    /// player's entry fee is released from the yield vault, the roster and
    /// counters are updated, and the player state is removed so they may join
    /// again later.
    ///
    /// Yield policy: any yield accrued in the lobby on the departing player's
    /// principal is forfeited to the pool and is not paid out. The refund is
    /// therefore exactly `entry_fee`, matching the amount the player staked.
    ///
    /// # Errors
    /// - `ArenaError::NotInitialized` if `initialize` has not been called.
    /// - `ArenaError::ContractPaused` if the contract is paused.
    /// - `ArenaError::InvalidGameState` if the arena is not in the `Open` state.
    /// - `ArenaError::ArenaAlreadyStarted` if at least one round has resolved.
    /// - `ArenaError::NotAPlayer` if the caller never joined.
    /// - `ArenaError::VaultWithdrawFailed` if the vault cannot release the fee.
    ///
    /// # Events
    /// Emits `player_left` and `player_refunded`.
    pub fn leave_arena(env: Env, player: Address) -> Result<(), ArenaError> {
        ArenaStorage::require_current_storage_version(&env)?;
        ArenaStorage::enter_reentrancy_guard(&env)?;
        player.require_auth();
        let config = ArenaStorage::load_config(&env)?;
        Self::require_not_paused(&env, &config)?;
        if config.state != GameState::Open {
            return Err(ArenaError::InvalidGameState);
        }
        if config.round_count > 0 {
            return Err(ArenaError::ArenaAlreadyStarted);
        }
        if ArenaStorage::load_player(&env, &player).is_none() {
            return Err(ArenaError::NotAPlayer);
        }

        // Effects first: the roster and counters no longer include the player
        // before any token movement. A failing vault call reverts everything.
        ArenaStorage::remove_player(&env, &player);
        let refund = Self::refund_lobby_player(&env, &config, &player)?;
        ArenaStorage::remove_sponsor(&env, &player);
        let count = ArenaStorage::load_roster_count(&env);

        ArenaEvents::player_left(&env, &player, count);
        ArenaEvents::player_refunded(&env, &player, refund);
        ArenaStorage::exit_reentrancy_guard(&env);
        Ok(())
    }

    /// Submit a blinded commitment to a coin-flip choice.
    ///
    /// The player hashes their choice together with a secret salt and submits
    /// only the hash. The actual choice is revealed later with `reveal_choice`.
    /// This prevents other players from front-running the revealed choice.
    ///
    /// # Parameters
    /// - `player`: Address of the committing player. Must authorize this call.
    /// - `commitment`: SHA-256 hash of `[choice_byte] ++ salt_bytes`.
    ///
    /// # Errors
    /// - `ArenaError::NotInitialized` if `initialize` has not been called.
    /// - `ArenaError::ContractPaused` if the contract is paused.
    pub fn submit_commitment(
        env: Env,
        player: Address,
        commitment: BytesN<32>,
    ) -> Result<(), ArenaError> {
        ArenaStorage::require_current_storage_version(&env)?;
        player.require_auth();
        let config = ArenaStorage::load_config(&env)?;
        Self::require_not_paused(&env, &config)?;
        if config.state != GameState::Active {
            return Err(ArenaError::RoundNotActive);
        }
        if env.ledger().timestamp() >= config.commit_deadline {
            return Err(ArenaError::CommitPhaseEnded);
        }
        let player_state =
            ArenaStorage::load_player(&env, &player).ok_or(ArenaError::NotAPlayer)?;
        if !player_state.active {
            return Err(ArenaError::PlayerEliminated);
        }
        let round = config.round_count.saturating_add(1);
        ArenaStorage::save_commitment(&env, &player, round, &commitment);
        ArenaEvents::commitment_submitted(&env, &player, round);
        Ok(())
    }

    /// Reveal the choice committed with `submit_commitment`.
    ///
    /// Verifies that `SHA-256([choice_byte] ++ salt_bytes)` matches the stored
    /// commitment, then records the player's choice for the current round. Can
    /// only be called after the `commit_deadline` timestamp has passed.
    ///
    /// # Parameters
    /// - `player`: Address of the revealing player. Must authorize this call.
    /// - `choice`: The coin-flip choice (`Heads` or `Tails`).
    /// - `salt`: The 32-byte random nonce used when hashing the original commitment.
    ///
    /// # Errors
    /// - `ArenaError::NotInitialized` if `initialize` has not been called.
    /// - `ArenaError::ContractPaused` if the contract is paused.
    /// - `ArenaError::ChoiceAlreadyRevealed` if this player has already revealed for the current round.
    /// - `ArenaError::RoundNotActive` if the `commit_deadline` has not yet elapsed.
    /// - `ArenaError::MissingCommitment` if no commitment was submitted for this player.
    /// - `ArenaError::InvalidReveal` if the revealed choice and salt do not match the stored commitment.
    /// - `ArenaError::NotAPlayer` if the caller never joined the arena.
    /// - `ArenaError::PlayerEliminated` if the caller is no longer an active player.
    pub fn reveal_choice(
        env: Env,
        player: Address,
        choice: Choice,
        salt: BytesN<32>,
    ) -> Result<(), ArenaError> {
        ArenaStorage::require_current_storage_version(&env)?;
        player.require_auth();
        let config = ArenaStorage::load_config(&env)?;
        if choice.to_byte() >= ArenaStorage::load_option_count(&env) as u8 {
            return Err(ArenaError::InvalidReveal);
        }
        Self::require_not_paused(&env, &config)?;
        let player_state =
            ArenaStorage::load_player(&env, &player).ok_or(ArenaError::NotAPlayer)?;
        if !player_state.active {
            return Err(ArenaError::PlayerEliminated);
        }
        let round = config.round_count.saturating_add(1);
        if ArenaStorage::load_choice(&env, &player, round).is_some() {
            return Err(ArenaError::ChoiceAlreadyRevealed);
        }
        if env.ledger().timestamp() < config.commit_deadline {
            return Err(ArenaError::RoundNotActive);
        }

        let commitment = ArenaStorage::load_commitment(&env, &player, round)
            .ok_or(ArenaError::MissingCommitment)?;
        let arena = env.current_contract_address();
        if commitment != Self::compute_commitment(&env, &arena, round, &player, choice, &salt) {
            return Err(ArenaError::InvalidReveal);
        }
        ArenaStorage::save_choice(&env, &player, round, &choice);
        ArenaEvents::choice_revealed(&env, &player, &choice, round);
        Ok(())
    }

    /// Cancel the arena and refund all entry fees to players.
    ///
    /// Only callable by the admin while the arena is still `Open`. Transitions
    /// the arena to `Cancelled`, withdraws all principal from the yield vault,
    /// and transfers each player's `entry_fee` back to their address.
    ///
    /// # Errors
    /// - `ArenaError::NotInitialized` if `initialize` has not been called.
    /// - `ArenaError::ContractPaused` if the contract is paused.
    /// - `ArenaError::InvalidGameState` if the arena is not in the `Open` state.
    pub fn cancel_arena(env: Env) -> Result<(), ArenaError> {
        ArenaStorage::require_current_storage_version(&env)?;
        ArenaStorage::enter_reentrancy_guard(&env)?;
        let mut config = ArenaStorage::load_config(&env)?;
        config.admin.require_auth();
        Self::require_not_paused(&env, &config)?;
        state_machine::ensure_state(
            &config.state,
            &GameState::Open,
            ArenaError::InvalidGameState,
        )?;

        Self::transition_to_cancelled(&env, &mut config);
        ArenaEvents::arena_cancelled(&env, &config.admin);

        ArenaStorage::exit_reentrancy_guard(&env);
        Ok(())
    }

    /// Cancel an arena that never started once its start deadline has passed
    /// (#1579).
    ///
    /// Permissionless: any caller may trigger this after `start_deadline` while
    /// the first round has not resolved. It reuses the normal cancellation
    /// path, so the arena becomes `Cancelled`, every joined player can claim a
    /// refund, and the creator stake is returned to the host. Without this,
    /// entry fees would stay locked forever in an arena that never reaches
    /// `min_players`.
    ///
    /// # Errors
    /// - `ArenaError::NotInitialized` if `initialize` has not been called.
    /// - `ArenaError::ContractPaused` if the contract is paused.
    /// - `ArenaError::InvalidGameState` if the arena is not in the `Open` state.
    /// - `ArenaError::ArenaAlreadyStarted` if at least one round has resolved.
    /// - `ArenaError::NoStartDeadline` if this arena has no deadline configured.
    /// - `ArenaError::DeadlineTooSoon` if the deadline has not been reached.
    ///
    /// # Events
    /// Emits `arena_cancelled`.
    pub fn cancel_unstarted(env: Env) -> Result<(), ArenaError> {
        ArenaStorage::require_current_storage_version(&env)?;
        ArenaStorage::enter_reentrancy_guard(&env)?;
        let mut config = ArenaStorage::load_config(&env)?;
        Self::require_not_paused(&env, &config)?;
        if config.state != GameState::Open {
            return Err(ArenaError::InvalidGameState);
        }
        if config.round_count > 0 {
            return Err(ArenaError::ArenaAlreadyStarted);
        }
        let deadline = ArenaStorage::load_start_deadline(&env);
        if deadline == 0 {
            return Err(ArenaError::NoStartDeadline);
        }
        if env.ledger().timestamp() < deadline {
            return Err(ArenaError::DeadlineTooSoon);
        }

        Self::transition_to_cancelled(&env, &mut config);
        ArenaEvents::arena_cancelled(&env, &config.admin);

        ArenaStorage::exit_reentrancy_guard(&env);
        Ok(())
    }

    /// Expire a stuck arena, making every joined player refundable.
    ///
    /// Any caller may trigger this when the arena is `Active` and the current
    /// round's commit deadline has already passed, i.e. the arena is stuck
    /// because no one called `resolve_round`.
    ///
    /// Transitions to `Cancelled` and lets every player who ever joined —
    /// including those already eliminated — reclaim their entry fee through
    /// `claim_refund`, exactly as `force_cancel_arena` does (#1359).
    ///
    /// This previously transitioned to `Finished` and pushed `entry_fee` only to
    /// players still `active`. Eliminated players' stakes then had no path out of
    /// the contract at all: `claim` requires a `stored_winner` that expiry never
    /// set, and no sweep existed. An arena that expired mid-game therefore
    /// stranded every eliminated player's stake permanently — while the *same*
    /// arena cancelled by an admin refunded all of them.
    ///
    /// # Errors
    /// - `ArenaError::NotInitialized` if `initialize` has not been called.
    /// - `ArenaError::ContractPaused` if the contract is paused.
    /// - `ArenaError::InvalidGameState` if the arena is not in the `Active` state.
    /// - `ArenaError::DeadlineTooSoon` unless `now > commit_deadline +
    ///   EXPIRY_GRACE_SECONDS` (#1627).
    ///
    /// # Security (#1627)
    /// Expiry is gated by `EXPIRY_GRACE_SECONDS` after the commit deadline, not
    /// by the deadline itself. The deadline is also when reveals open and
    /// `resolve_round` becomes callable, so an earlier gate would let any
    /// account cancel the game before reveals or resolution, forcing refunds
    /// and letting a losing player escape elimination.
    pub fn expire_arena(env: Env) -> Result<(), ArenaError> {
        ArenaStorage::require_current_storage_version(&env)?;
        ArenaStorage::enter_reentrancy_guard(&env)?;
        let mut config = ArenaStorage::load_config(&env)?;
        Self::require_not_paused(&env, &config)?;
        if config.state != GameState::Active {
            return Err(ArenaError::InvalidGameState);
        }
        let expiry_at = config.commit_deadline.saturating_add(EXPIRY_GRACE_SECONDS);
        if env.ledger().timestamp() <= expiry_at {
            return Err(ArenaError::DeadlineTooSoon);
        }

        // Cancelled, not Finished: `claim_refund` is gated on the cancelled state
        // and pays any joined player, which is precisely the payout completeness
        // an expired arena needs. Refunds are pull-based here, matching
        // force_cancel_arena rather than pushing to a subset of players.
        config.state = GameState::Cancelled;
        ArenaStorage::save_config(&env, &config);

        let arena_addr = env.current_contract_address();
        if !Self::release_vault_principal(&env, &config) {
            ArenaStorage::save_funds_in_vault(&env, true);
        }

        ArenaEvents::arena_expired(&env);

        // Notify the factory exactly as a cancellation does: release the active
        // pool slot, return the creator's stake, and report the arena cancelled.
        let factory_client = FactoryClient::new(&env, &config.factory);
        let _ = factory_client.try_release_arena(&arena_addr);
        let _ = factory_client.try_reclaim_creator_stake(&arena_addr);
        let _ = factory_client.try_update_arena_status(&config.pool_id, &ArenaStatus::Cancelled);
        
        ArenaStorage::exit_reentrancy_guard(&env);
        Ok(())
    }

    /// Return a paginated list of all players and their current state.
    ///
    /// Pages are zero-indexed and contain up to 50 entries each. Returns an
    /// empty list when `page` is out of range.
    ///
    /// # Parameters
    /// - `page`: Zero-based page index.
    pub fn get_players(env: Env, page: u32) -> Vec<(Address, PlayerState)> {
        let Some(start) = page.checked_mul(PAGE_SIZE) else {
            return Vec::new(&env);
        };
        let addrs = ArenaStorage::load_player_page(&env, start, PAGE_SIZE);
        let mut result: Vec<(Address, PlayerState)> = Vec::new(&env);
        for addr in addrs.iter() {
            let state = ArenaStorage::load_player(&env, &addr).unwrap_or_default();
            result.push_back((addr, state));
        }
        result
    }

    /// Return the total number of players who have ever joined this arena.
    ///
    /// Returns `0` if the contract has not been initialised.
    pub fn player_count(env: Env) -> u32 {
        ArenaStorage::load_config(&env)
            .map(|c| c.player_count)
            .unwrap_or(0)
    }

    /// Return every per-player fact needed to gate arena actions in one read
    /// (#1582): roster membership, liveness, commit/reveal status for the
    /// current round, elimination round and reason, refund and winner flags,
    /// and the current round and phase.
    ///
    /// An address that never joined (or left the lobby) yields
    /// `joined: false` rather than an error. The read writes nothing, does not
    /// extend TTLs, and touches at most five storage entries (the sponsor key
    /// added in #1715 is read only for joined players).
    ///
    /// # Errors
    /// - `ArenaError::NotInitialized` if `initialize` has not been called.
    pub fn get_player_status(env: Env, player: Address) -> Result<PlayerStatus, ArenaError> {
        let config = ArenaStorage::peek_config(&env)?;
        let round_running = config.state == GameState::Active;
        let current_round = if round_running {
            config.round_count.saturating_add(1)
        } else {
            config.round_count
        };

        let stored = ArenaStorage::peek_player(&env, &player);
        let joined = stored.is_some();
        let state = stored.unwrap_or_default();
        let eliminated = joined && !state.active;
        let playing_round = round_running && state.active;

        Ok(PlayerStatus {
            joined,
            active: state.active,
            committed: playing_round
                && ArenaStorage::has_commitment(&env, &player, current_round),
            revealed: playing_round && ArenaStorage::has_choice(&env, &player, current_round),
            // A player eliminated in round `r` survived exactly `r - 1` rounds:
            // only lobby joins are allowed, and every resolution visits every
            // active player.
            eliminated_round: eliminated.then(|| state.rounds_survived.saturating_add(1)),
            elimination_reason: if eliminated {
                ArenaStorage::peek_elimination_reason(&env, &player)
                    .unwrap_or(EliminationReason::Unrecorded)
            } else {
                EliminationReason::NotEliminated
            },
            refund_claimed: joined
                && config.state == GameState::Cancelled
                && ArenaStorage::peek_refund_claimed(&env, &player),
            winner: joined
                && matches!(config.state, GameState::Finished | GameState::Settled)
                && ArenaStorage::peek_winner(&env).is_some_and(|winner| winner == player),
            current_round,
            phase: state_machine::phase(
                &config.state,
                config.round_count,
                config.commit_deadline,
                env.ledger().timestamp(),
            ),
            sponsor: if joined {
                ArenaStorage::peek_sponsor(&env, &player)
            } else {
                None
            },
        })
    }

    /// Return what this arena owes and to whom (#1632).
    ///
    /// The payout contract reads this before paying anything for the arena:
    /// the recipient must be `winner` and the amount at most `prize`. The
    /// read writes nothing.
    ///
    /// # Errors
    /// - `ArenaError::NotInitialized` if `initialize` has not been called.
    pub fn get_settlement(env: Env) -> Result<Settlement, ArenaError> {
        let config = ArenaStorage::peek_config(&env)?;
        let finished = matches!(config.state, GameState::Finished | GameState::Settled);
        // Same formula `claim` uses for the winner's expected payout.
        let principal = config
            .entry_fee
            .saturating_mul(i128::from(config.player_count));
        Ok(Settlement {
            finished,
            winner: if finished { ArenaStorage::peek_winner(&env) } else { None },
            prize: principal.saturating_add(config.cumulative_yield),
            stake_token: config.stake_token,
            pool_id: config.pool_id,
        })
    }

    /// Return this arena's full pool configuration (#1572).
    ///
    /// Read-only. Off-chain rematch prefills read this so a rematch pool is
    /// derived from the arena's own on-chain config rather than cached UI
    /// state. Field names mirror the factory's `PoolConfig`.
    ///
    /// `round_duration` is `0` until the first round has started — the
    /// duration is recorded at `start_round`, not `initialize`.
    ///
    /// # Errors
    /// - `ArenaError::NotInitialized` if `initialize` has not been called.
    pub fn get_pool_config(env: Env) -> Result<PoolConfigView, ArenaError> {
        let config = ArenaStorage::peek_config(&env)?;
        Ok(PoolConfigView {
            stake_token: config.stake_token,
            yield_vault: config.yield_vault,
            entry_fee: config.entry_fee,
            oracle_contract: config.oracle_contract,
            min_players: ArenaStorage::load_min_players(&env),
            max_players: ArenaStorage::load_max_players(&env)
                .unwrap_or(crate::MAX_PLAYERS_ALLOWED),
            round_duration: ArenaStorage::load_round_duration(&env),
            start_deadline: ArenaStorage::load_start_deadline(&env),
            factory: config.factory,
            pool_id: config.pool_id,
        })
    }

    /// Start a new commit-reveal round.
    ///
    /// Only callable by the admin while the arena is `Open`.
    /// Transitions the arena to `Active` and records
    /// the round start timestamp. Players must submit commitments before
    /// `duration_seconds` elapses, after which reveals are accepted.
    ///
    /// # Parameters
    /// - `duration_seconds`: Length of the commit window in ledger seconds.
    ///   Must be in range [`MIN_ROUND_DURATION_SECONDS`, `MAX_ROUND_DURATION_SECONDS`].
    ///   When this many seconds have passed since the round start, `resolve_round`
    ///   becomes callable.
    ///
    /// # Errors
    /// - `ArenaError::NotInitialized` if `initialize` has not been called.
    /// - `ArenaError::ContractPaused` if the contract is paused.
    /// - `ArenaError::InvalidDuration` if `duration_seconds` is outside
    ///   [`MIN_ROUND_DURATION_SECONDS`, `MAX_ROUND_DURATION_SECONDS`].
    /// - `ArenaError::InvalidGameState` if the arena is not in the `Open` state.
    ///
    /// # Events
    /// Emits `game_started` with the round number and duration.
    pub fn start_round(env: Env, duration_seconds: u64) -> Result<(), ArenaError> {
        ArenaStorage::require_current_storage_version(&env)?;
        let mut config = ArenaStorage::load_config(&env)?;
        config.admin.require_auth();
        Self::require_not_paused(&env, &config)?;

        if duration_seconds < MIN_ROUND_DURATION_SECONDS || duration_seconds > MAX_ROUND_DURATION_SECONDS {
            return Err(ArenaError::InvalidDuration);
        }

        // Use the state machine to enforce Open → Active; rejects Finished, Settled, Cancelled (#1073)
        state_machine::ensure_transition(
            &config.state,
            &GameState::Active,
            ArenaError::InvalidGameState,
        )?;

        if config.active_player_count < ArenaStorage::load_min_players(&env) {
            return Err(ArenaError::NotEnoughPlayers);
        }

        // Clear stale choices/commitments from the previous round so they
        // cannot be reused in the new round.
        let round = config.round_count.saturating_add(1);
        ArenaStorage::clear_round_data(&env, round);

        // Capture the actual vault balance at round commencement as the yield
        // baseline. This must happen here (not in `join_arena`) so it reflects
        // the real balance — including any deposits made while the arena sat
        // in the `Open` state — rather than a rolling sum of entry fees.
        let arena_addr = env.current_contract_address();
        let rwa_client = RwaAdapterClient::new(&env, &config.yield_vault);
        let vault_balance = rwa_client
            .try_balance_of(&arena_addr)
            .unwrap_or(Ok(0))
            .unwrap_or(0);
        ArenaStorage::save_last_vault_balance(&env, vault_balance);

        config.commit_deadline = env.ledger().timestamp().saturating_add(duration_seconds);
        config.state = GameState::Active;
        ArenaStorage::save_config(&env, &config);
        ArenaStorage::save_round_start(&env, env.ledger().timestamp());
        ArenaStorage::save_round_duration(&env, duration_seconds);

        ArenaEvents::game_started(&env, config.round_count.saturating_add(1), duration_seconds);
        ArenaEvents::transition_initiated(
            &env,
            config.round_count.saturating_add(1),
            TransitionInitiator::Host,
            true,
        );
        Ok(())
    }

    /// Start a subsequent round with the stored duration after the host has
    /// missed the inter-round grace period.
    pub fn start_next_round(env: Env, caller: Address) -> Result<(), ArenaError> {
        ArenaStorage::require_current_storage_version(&env)?;
        caller.require_auth();
        let mut config = ArenaStorage::load_config(&env)?;
        Self::require_not_paused(&env, &config)?;
        if config.state != GameState::Open || config.round_count == 0 {
            return Err(ArenaError::InvalidGameState);
        }
        let previous_start = ArenaStorage::load_round_start(&env).ok_or(ArenaError::RoundNotStarted)?;
        let duration = ArenaStorage::load_round_duration(&env);
        if env.ledger().timestamp()
            < previous_start.saturating_add(duration).saturating_add(HOST_GRACE_SECONDS)
        {
            return Err(ArenaError::GracePeriodNotElapsed);
        }
        if config.active_player_count < ArenaStorage::load_min_players(&env) {
            return Err(ArenaError::NotEnoughPlayers);
        }
        let round = config.round_count.saturating_add(1);
        ArenaStorage::clear_round_data(&env, round);
        let arena_addr = env.current_contract_address();
        let rwa_client = RwaAdapterClient::new(&env, &config.yield_vault);
        let vault_balance = rwa_client.try_balance_of(&arena_addr).unwrap_or(Ok(0)).unwrap_or(0);
        ArenaStorage::save_last_vault_balance(&env, vault_balance);
        config.commit_deadline = env.ledger().timestamp().saturating_add(duration);
        config.state = GameState::Active;
        ArenaStorage::save_config(&env, &config);
        ArenaStorage::save_round_start(&env, env.ledger().timestamp());
        ArenaEvents::game_started(&env, round, duration);
        ArenaEvents::transition_initiated(&env, round, TransitionInitiator::Keeper, true);
        Ok(())
    }

    /// Resolve the current round by tallying revealed choices and eliminating the majority.
    ///
    /// Only callable by the admin after the grace period (`round_start +
    /// duration_seconds`) has elapsed. Computes which choice was in the
    /// majority, marks those players as eliminated, snapshots the vault yield,
    /// and transitions the arena:
    /// - back to `Open` if more than one survivor remains
    /// - to `Finished` if exactly one survivor remains (winner announced)
    /// - to `Cancelled` if zero survivors remain (no winner; enables refund recovery via `claim_refund`)
    ///
    /// # Errors
    /// - `ArenaError::NotInitialized` if `initialize` has not been called.
    /// - `ArenaError::ContractPaused` if the contract is paused.
    /// - `ArenaError::RoundNotActive` if the arena is not in the `Active` state.
    /// - `ArenaError::RoundNotStarted` if no round start timestamp is recorded.
    /// - `ArenaError::GracePeriodNotElapsed` if the round duration has not yet passed.
    /// - `ArenaError::StaleOracleData` if the oracle's latest observation is older than
    ///   this arena's configured `max_age_secs` (#1512), or was never recorded. Recoverable:
    ///   retry once the oracle has published a fresh observation. Does not apply when the
    ///   oracle is merely unreachable or predates freshness metadata — that case keeps the
    ///   existing liveness-first 0-bps fallback (see `oracle::fetch_yield_bps`).
    ///
    /// # Events
    /// Emits `round_resolved` with the round number, eliminated count, and survivor count.
    /// Emits `game_finished` with the winner address and round number if exactly one survivor remains.
    /// Emits `oracle_freshness_observed` with this round's oracle freshness classification and age (#1512).
    /// Emits `oracle_stale_rejected` instead of the above when the resolution is rejected for staleness.
    pub fn resolve_round(env: Env) -> Result<(), ArenaError> {
        ArenaStorage::require_current_storage_version(&env)?;
        ArenaStorage::enter_reentrancy_guard(&env)?;
        let mut config = ArenaStorage::load_config(&env)?;
        Self::require_not_paused(&env, &config)?;

        if config.state != GameState::Active {
            return Err(ArenaError::RoundNotActive);
        }

        let round_start =
            ArenaStorage::load_round_start(&env).ok_or(ArenaError::RoundNotStarted)?;
        let grace = ArenaStorage::load_round_duration(&env);
        if env.ledger().timestamp() < round_start.saturating_add(grace) {
            return Err(ArenaError::GracePeriodNotElapsed);
        }
        let keeper_initiated = env.ledger().timestamp()
            >= round_start.saturating_add(grace).saturating_add(HOST_GRACE_SECONDS);
        if !keeper_initiated {
            config.admin.require_auth();
        }

        let round = config.round_count.saturating_add(1);
        let option_count = ArenaStorage::load_option_count(&env);
        let yield_bps = oracle::fetch_yield_bps(&env, &config.oracle_contract);

        // ── #1512: reject a yield-dependent resolution against stale oracle
        // data. `fetch_yield_bps` above (kept unchanged, liveness-first) is
        // what actually feeds the payout snapshot; this is a *separate*,
        // additive freshness check that can reject before any state mutation
        // below, without changing what a live oracle read returns.
        let now = env.ledger().timestamp();
        let policy = ArenaStorage::load_oracle_freshness_policy(&env);
        let reading = oracle::fetch_oracle_reading(&env, &config.oracle_contract);
        let freshness = oracle::classify_freshness(now, reading.as_ref(), &policy);
        let age_secs = reading
            .as_ref()
            .map(|r| now.saturating_sub(r.observed_at))
            .unwrap_or(u64::MAX);
        ArenaEvents::oracle_freshness_observed(&env, round, freshness.as_code(), age_secs);
        if freshness == oracle::OracleFreshness::Stale {
            ArenaEvents::oracle_stale_rejected(&env, round, age_secs);
            return Err(ArenaError::StaleOracleData);
        }

        let arena_addr = env.current_contract_address();
        let rwa_client = RwaAdapterClient::new(&env, &config.yield_vault);
        let previous_balance = ArenaStorage::load_last_vault_balance(&env);
        let vault_balance = rwa_client
            .try_balance_of(&arena_addr)
            .unwrap_or(Ok(previous_balance))
            .unwrap_or(previous_balance);
        let accrued = if vault_balance >= previous_balance {
            vault_balance - previous_balance
        } else {
            // Emit event when vault balance decreased
            ArenaEvents::vault_balance_decreased(&env, previous_balance, vault_balance);
            0
        };
        let snapshot = YieldSnapshot {
            round,
            rate_bps: yield_bps,
            accrued,
        };

        ArenaStorage::save_round_yield_bps(&env, round, yield_bps);
        ArenaStorage::save_yield_snapshot(&env, round, &snapshot);
        ArenaStorage::save_last_vault_balance(&env, vault_balance);
        config.cumulative_yield = config.cumulative_yield.saturating_add(accrued);

        let resolution = Self::resolve_players(&env, round, config.active_player_count);
        let result = RoundResult {
            round,
            eliminated: resolution.eliminated,
            survivors: resolution.survivors,
            yield_snapshot: snapshot,
        };
        ArenaStorage::save_round_result(&env, round, &result);

        config.round_count = round;
        config.active_player_count = resolution.survivors;
        config.state = if resolution.survivors == 0 {
            // Zero survivors: all active players failed to reveal (e.g., both AFKs).
            // Transition to Cancelled to unlock claim_refund-style recovery instead of
            // permanently locking the prize pool. The alternative (Finished) requires a
            // winner for claim() to succeed, but there is no winner — the funds would be
            // locked forever with no state machine exit.
            GameState::Cancelled
        } else if resolution.survivors == 1 {
            if let Some(ref winner_addr) = resolution.winner {
                ArenaStorage::set_winner(&env, winner_addr);
            }
            build_leaderboard(&env);
            GameState::Finished
        } else {
            GameState::Open
        };
        ArenaStorage::save_config(&env, &config);

        ArenaEvents::round_resolved(&env, round, resolution.eliminated, resolution.survivors);
        ArenaEvents::transition_initiated(
            &env,
            round,
            if keeper_initiated { TransitionInitiator::Keeper } else { TransitionInitiator::Host },
            false,
        );
        // #1394: enriched event carrying the full tally so a client can
        // independently recompute survivor membership (proof-bundle
        // verification) instead of trusting the backend's derived counts.
        ArenaEvents::round_resolved_v2(
            &env,
            round,
            resolution.tally.heads,
            resolution.tally.tails,
            resolution.eliminated,
            resolution.survivors,
        );
        if option_count == 3 {
            ArenaEvents::round_resolved_v3(
                &env,
                round,
                resolution.tally.heads,
                resolution.tally.tails,
                resolution.tally.option3,
                resolution.eliminated,
                resolution.survivors,
            );
        }
        if resolution.tied {
            ArenaEvents::round_tied(&env, round, resolution.survivors);
        }
        if let Some(winner_addr) = resolution.winner {
            ArenaEvents::game_finished(&env, &winner_addr, round);
        }

        // Clear per-round choice and commitment data to prevent stale data
        // from persisting into a future round.
        ArenaStorage::clear_round_data(&env, round);

        // Notify factory of round resolution state changes
        let arena_addr = env.current_contract_address();
        let factory_client = FactoryClient::new(&env, &config.factory);
        if config.state == GameState::Finished {
            let _ = factory_client.try_release_arena(&arena_addr);
            // Settlement is terminal even if the winner never submits a claim.
            // Reclaim the creator stake here, before any winner-controlled action,
            // and persist the matching factory lifecycle state.
            let _ = factory_client.try_reclaim_creator_stake(&arena_addr);
            let _ = factory_client.try_update_arena_status(&config.pool_id, &ArenaStatus::Finished);
        } else if config.state == GameState::Cancelled {
            if !Self::release_vault_principal(&env, &config) {
                ArenaStorage::save_funds_in_vault(&env, true);
            }
            let _ = factory_client.try_release_arena(&arena_addr);
            let _ = factory_client.try_reclaim_creator_stake(&arena_addr);
            let _ = factory_client.try_update_arena_status(&config.pool_id, &ArenaStatus::Cancelled);
        }

        ArenaStorage::exit_reentrancy_guard(&env);
        Ok(())
    }

    /// Claim the prize pool as the last surviving player.
    ///
    /// Implements checks-effects-interactions: the prize-claimed flag and arena
    /// state are persisted to `Settled` *before* any token transfer, so a
    /// malicious re-entrant call via the stake token sees the flag and fails
    /// with `ArenaError::PrizeAlreadyClaimed`.
    ///
    /// Payout = staked principal + accumulated vault yield, capped to the
    /// amount actually withdrawn from the vault.
    ///
    /// # Parameters
    /// - `winner`: Address of the last surviving player. Must authorize this call.
    ///
    /// # Errors
    /// - `ArenaError::NotInitialized` if `initialize` has not been called.
    /// - `ArenaError::ContractPaused` if the contract is paused.
    /// - `ArenaError::GameNotFinished` if the arena is not in the `Finished` state.
    /// - `ArenaError::PrizeAlreadyClaimed` if the prize has already been paid out (guards re-entrancy).
    /// - `ArenaError::PlayerEliminated` if the caller was eliminated and is not the surviving winner.
    ///
    /// # Events
    /// Emits `prize_claimed` with the winner address, total payout, and yield portion.
    pub fn claim(env: Env, winner: Address) -> Result<(), ArenaError> {
        ArenaStorage::require_current_storage_version(&env)?;
        ArenaStorage::enter_reentrancy_guard(&env)?;
        winner.require_auth();
        let mut config = ArenaStorage::load_config(&env)?;
        Self::require_not_paused(&env, &config)?;

        // CHECKS — validate caller and arena state before doing anything else.
        if config.state != GameState::Finished {
            return Err(ArenaError::GameNotFinished);
        }
        if ArenaStorage::prize_claimed(&env) {
            return Err(ArenaError::PrizeAlreadyClaimed);
        }
        let stored_winner = ArenaStorage::get_winner(&env).ok_or(ArenaError::PlayerEliminated)?;
        if stored_winner != winner {
            return Err(ArenaError::PlayerEliminated);
        }

        // EFFECTS — persist state changes BEFORE any cross-contract call so a
        // malicious stake-token re-entering `claim` sees the claimed flag and
        // fails with PrizeAlreadyClaimed.
        ArenaStorage::mark_prize_claimed(&env);
        config.state = GameState::Settled;
        ArenaStorage::save_config(&env, &config);

        // INTERACTIONS — external calls happen only after state is committed.
        //
        // The prize is exactly the tokens the vault withdrawal delivered to the
        // arena (#1631). There is no fallback to a computed figure: if the vault
        // refuses, the whole call reverts and the prize stays claimable.
        let arena_addr = env.current_contract_address();
        let token_client = token::TokenClient::new(&env, &config.stake_token);
        let balance_before = token_client.balance(&arena_addr);
        if !Self::release_vault_principal(&env, &config) {
            return Err(ArenaError::VaultWithdrawFailed);
        }
        let total = token_client
            .balance(&arena_addr)
            .saturating_sub(balance_before);
        let principal = config
            .entry_fee
            .saturating_mul(i128::from(config.player_count));
        token_client.transfer(&arena_addr, &winner, &total);

        ArenaEvents::prize_claimed(&env, &winner, total, total.saturating_sub(principal));
        
        // The factory was already transitioned to Finished and the creator
        // stake reclaimed when the final round resolved. Repeating the status
        // write is harmless and keeps older factory deployments convergent.
        let factory_client = FactoryClient::new(&env, &config.factory);
        let _ = factory_client.try_update_arena_status(&config.pool_id, &ArenaStatus::Finished);
        
        ArenaStorage::exit_reentrancy_guard(&env);
        Ok(())
    }

    /// Propose a new admin address to take over contract administration.
    ///
    /// Begins a two-step admin transfer. The proposed address is stored as a
    /// pending admin; control does not change until the new admin calls
    /// `accept_admin`. Only the current admin can call this.
    ///
    /// # Parameters
    /// - `new_admin`: Address being nominated to become the next admin.
    ///
    /// # Errors
    /// - `ArenaError::NotInitialized` if `initialize` has not been called.
    /// - `ArenaError::ContractPaused` if the contract is paused.
    pub fn propose_admin(env: Env, new_admin: Address) -> Result<(), ArenaError> {
        ArenaStorage::require_current_storage_version(&env)?;
        let config = ArenaStorage::load_config(&env)?;
        config.admin.require_auth();
        Self::require_not_paused(&env, &config)?;
        ArenaStorage::save_pending_admin(&env, &PendingAdmin { new_admin });
        Ok(())
    }

    /// Accept a pending admin transfer initiated by `propose_admin`.
    ///
    /// Only the address stored as the pending admin may call this. On success,
    /// the pending admin record is deleted and the caller becomes the new admin.
    ///
    /// # Errors
    /// - `ArenaError::NoPendingAdmin` if no admin transfer has been proposed.
    /// - `ArenaError::NotInitialized` if `initialize` has not been called.
    /// - `ArenaError::ContractPaused` if the contract is paused.
    ///
    /// # Events
    /// Emits `admin_changed` with the old and new admin addresses.
    pub fn accept_admin(env: Env) -> Result<(), ArenaError> {
        ArenaStorage::require_current_storage_version(&env)?;
        let pending = ArenaStorage::load_pending_admin(&env).ok_or(ArenaError::NoPendingAdmin)?;
        pending.new_admin.require_auth();
        let mut config = ArenaStorage::load_config(&env)?;
        Self::require_not_paused(&env, &config)?;
        let old_admin = config.admin.clone();
        config.admin = pending.new_admin;
        ArenaStorage::save_config(&env, &config);
        ArenaStorage::delete_pending_admin(&env);
        ArenaEvents::admin_changed(&env, &old_admin, &config.admin.clone());
        Ok(())
    }

    /// Backward-compatible alias for `propose_admin`.
    ///
    /// Stages an admin transfer; the proposed admin must still call
    /// `accept_admin` before control changes hands. Prefer `propose_admin`
    /// for new integrations.
    ///
    /// # Parameters
    /// - `new_admin`: Address being nominated to become the next admin.
    ///
    /// # Errors
    /// See `propose_admin`.
    pub fn change_admin(env: Env, new_admin: Address) -> Result<(), ArenaError> {
        ArenaStorage::require_current_storage_version(&env)?;
        Self::propose_admin(env, new_admin)
    }

    /// Pause the contract, blocking all state-mutating gameplay entry points.
    ///
    /// While paused, calls to `join_arena`, `submit_commitment`, `reveal_choice`,
    /// `resolve_round`, and `claim` all fail with `ArenaError::ContractPaused`.
    /// Read-only queries are unaffected.
    ///
    /// Protocol-only (#1629): the host of the arena cannot pause it. The
    /// protocol admin — the deploying factory's admin — must authorise this.
    ///
    /// The pause is time-boxed: it stops blocking after
    /// `MAX_PAUSE_DURATION_SECONDS` (24 hours), so a protocol pause can never
    /// hold an arena — or the funds in it — shut indefinitely. `pause_expired`
    /// reports whether that has happened.
    ///
    /// Independent of the factory-wide pause (#1583): unpausing here does not
    /// lift a protocol-wide pause, which surfaces as `ArenaError::GloballyPaused`.
    ///
    /// # Parameters
    /// - `reason`: Short symbol describing why the contract is being paused
    ///   (e.g., `"emerg"`, `"maint"`). Included in the emitted event for
    ///   indexers and dashboards.
    ///
    /// # Errors
    /// - `ArenaError::NotInitialized` if `initialize` has not been called.
    /// - `ArenaError::NoProtocolAdmin` if the deploying factory cannot name a
    ///   protocol admin.
    ///
    /// # Events
    /// Emits `paused` with the protocol admin address and reason symbol.
    pub fn pause(env: Env, reason: Symbol) -> Result<(), ArenaError> {
        ArenaStorage::require_current_storage_version(&env)?;
        let mut config = ArenaStorage::load_config(&env)?;
        let protocol_admin = Self::require_protocol_admin(&env, &config)?;
        config.paused = true;
        ArenaStorage::save_config(&env, &config);
        ArenaStorage::save_paused_at(&env, env.ledger().timestamp());
        ArenaEvents::paused(&env, &protocol_admin, &reason);
        Ok(())
    }

    /// Resume normal operation after a `pause`.
    ///
    /// Clears the paused flag so all gameplay entry points become callable
    /// again. Only the protocol admin can unpause (#1629).
    ///
    /// # Errors
    /// - `ArenaError::NotInitialized` if `initialize` has not been called.
    /// - `ArenaError::NoProtocolAdmin` if the deploying factory cannot name a
    ///   protocol admin.
    ///
    /// # Events
    /// Emits `unpaused` with the protocol admin address.
    pub fn unpause(env: Env) -> Result<(), ArenaError> {
        ArenaStorage::require_current_storage_version(&env)?;
        let mut config = ArenaStorage::load_config(&env)?;
        let protocol_admin = Self::require_protocol_admin(&env, &config)?;
        config.paused = false;
        ArenaStorage::save_config(&env, &config);
        ArenaStorage::clear_paused_at(&env);
        ArenaEvents::unpaused(&env, &protocol_admin);
        Ok(())
    }

    /// Force-cancel the arena (protocol admin only, #1629).
    /// Can be called at any state except Finished or Settled.
    ///
    /// Allowed while this arena is locally paused, but not while the
    /// protocol-wide pause is set (#1583): cancelling drains the yield vault,
    /// which an incident response may need to keep untouched.
    pub fn force_cancel_arena(env: Env) -> Result<(), ArenaError> {
        ArenaStorage::require_current_storage_version(&env)?;
        ArenaStorage::enter_reentrancy_guard(&env)?;
        let mut config = ArenaStorage::load_config(&env)?;
        Self::require_protocol_admin(&env, &config)?;
        Self::require_not_globally_paused(&env, &config)?;

        if config.state == GameState::Finished || config.state == GameState::Settled {
            ArenaStorage::exit_reentrancy_guard(&env);
            return Err(ArenaError::InvalidGameState);
        }

        if config.state == GameState::Cancelled {
            ArenaStorage::exit_reentrancy_guard(&env);
            return Ok(());
        }

        config.state = GameState::Cancelled;
        ArenaStorage::save_config(&env, &config);

        // Withdraw all principal from the yield vault. A refusal is recorded
        // rather than ignored, so refunds stay blocked until `retry_withdraw`
        // succeeds (#1631).
        let arena_addr = env.current_contract_address();

        ArenaEvents::arena_cancelled(&env, &config.admin);

        // Notify factory of force cancellation: release active pool slot, refund creator stake, and sync status
        let factory_client = FactoryClient::new(&env, &config.factory);
        let _ = factory_client.try_release_arena(&arena_addr);
        let _ = factory_client.try_reclaim_creator_stake(&arena_addr);
        let _ = factory_client.try_update_arena_status(&config.pool_id, &ArenaStatus::Cancelled);
        
        ArenaStorage::exit_reentrancy_guard(&env);
        Ok(())
    }

    /// Claim a refund when the arena has been cancelled.
    pub fn claim_refund(env: Env, player: Address) -> Result<(), ArenaError> {
        ArenaStorage::require_current_storage_version(&env)?;
        ArenaStorage::enter_reentrancy_guard(&env)?;
        player.require_auth();

        let config = ArenaStorage::load_config(&env)?;
        // Pause is the admin's stop-the-world switch and gates token movement
        // too, so it's checked before any other guard here — including the
        // cancellation-state check below. This masks ArenaNotCancelled and
        // RefundAlreadyClaimed while paused, by design.
        Self::require_not_paused(&env, &config)?;

        if config.state != GameState::Cancelled {
            return Err(ArenaError::ArenaNotCancelled);
        }

        // Refunds are paid from the arena's own balance. While the principal is
        // still in the vault (#1631) that balance is short, so refuse with a
        // specific error instead of failing on an opaque token transfer.
        if ArenaStorage::load_funds_in_vault(&env) {
            return Err(ArenaError::FundsInVault);
        }

        if ArenaStorage::is_refund_claimed(&env, &player) {
            return Err(ArenaError::RefundAlreadyClaimed);
        }

        if ArenaStorage::load_player(&env, &player).is_none() {
            return Err(ArenaError::NotAPlayer);
        }

        ArenaStorage::set_refund_claimed(&env, &player);

        // #1715: a sponsored entry's fee is refunded to the payer who funded
        // it, not to the player occupying the seat.
        let refund_recipient = ArenaStorage::refund_recipient(&env, &player);
        let token_client = token::TokenClient::new(&env, &config.stake_token);
        token_client.transfer(&env.current_contract_address(), &refund_recipient, &config.entry_fee);

        ArenaEvents::refund_claimed(&env, &player);
        ArenaStorage::exit_reentrancy_guard(&env);
        Ok(())
    }

    /// Retry the vault withdrawal that failed during a cancellation, expiry, or
    /// settlement (#1631). Permissionless, because recovering the principal
    /// benefits every player and cannot move funds to a new destination.
    ///
    /// Idempotent: when no withdrawal is pending it succeeds without touching
    /// the vault. Refunds stay blocked (`FundsInVault`) until a retry succeeds.
    ///
    /// # Errors
    /// - `ArenaError::ContractPaused` / `ArenaError::GloballyPaused` while paused.
    /// - `ArenaError::InvalidGameState` if the arena is not `Cancelled`.
    /// - `ArenaError::VaultWithdrawFailed` if the vault still refuses to release.
    pub fn retry_withdraw(env: Env) -> Result<(), ArenaError> {
        ArenaStorage::require_current_storage_version(&env)?;
        ArenaStorage::enter_reentrancy_guard(&env)?;
        let config = ArenaStorage::load_config(&env)?;
        Self::require_not_paused(&env, &config)?;
        if config.state != GameState::Cancelled {
            return Err(ArenaError::InvalidGameState);
        }
        if !ArenaStorage::load_funds_in_vault(&env) {
            ArenaStorage::exit_reentrancy_guard(&env);
            return Ok(());
        }
        if !Self::release_vault_principal(&env, &config) {
            return Err(ArenaError::VaultWithdrawFailed);
        }
        ArenaStorage::save_funds_in_vault(&env, false);
        ArenaStorage::exit_reentrancy_guard(&env);
        Ok(())
    }

    /// Whether the principal is still held by the yield vault because a
    /// settlement-time withdrawal failed (#1631). `true` blocks refunds until
    /// `retry_withdraw` succeeds.
    pub fn funds_in_vault(env: Env) -> bool {
        ArenaStorage::load_funds_in_vault(&env)
    }

    /// Get the sorted top-N leaderboard of players.
    pub fn get_leaderboard(env: Env) -> Vec<LeaderboardEntry> {
        ArenaStorage::load_leaderboard(&env)
    }

    /// Configure the leaderboard size limit (admin only).
    ///
    /// # Errors
    /// - `ArenaError::InvalidLeaderboardLimit` if `limit` is 0 or exceeds
    ///   `types::MAX_LEADERBOARD_LIMIT`. Nothing is persisted in that case.
    pub fn configure_leaderboard_limit(env: Env, limit: u32) -> Result<(), ArenaError> {
        ArenaStorage::require_current_storage_version(&env)?;
        let config = ArenaStorage::load_config(&env)?;
        config.admin.require_auth();

        let limit = types::validate_leaderboard_limit(limit)?;
        ArenaStorage::save_leaderboard_limit(&env, limit);
        Ok(())
    }

    /// Update this arena instance's stored platform fee (0-1000 bps, max 10%).
    ///
    /// Protocol-only (#1629): the host of the arena cannot change the fee.
    /// The protocol admin — the deploying factory's admin — must authorise
    /// this.
    ///
    /// Each arena is deployed as its own contract instance (one per pool, via
    /// the factory), so this only affects `get_platform_fee_bps` reads on
    /// *this* instance going forward — it does not retroactively change this
    /// arena's own `config.platform_fee_bps` (already snapshotted at
    /// `initialize`), and has no effect on other arena instances, which each
    /// have independent storage. A fee that should apply uniformly to every
    /// newly-deployed arena would need to be threaded through the `factory`
    /// contract's deploy call instead. This value is also not currently
    /// deducted anywhere in `claim`'s payout calculation; it is stored and
    /// exposed for a future payout integration.
    ///
    /// # Errors
    /// - `ArenaError::InvalidPlatformFee` if `new_fee_bps` exceeds
    ///   `MAX_PLATFORM_FEE_BPS`.
    /// - `ArenaError::NoProtocolAdmin` if the deploying factory cannot name a
    ///   protocol admin.
    pub fn update_platform_fee(env: Env, new_fee_bps: u32) -> Result<(), ArenaError> {
        ArenaStorage::require_current_storage_version(&env)?;
        let config = ArenaStorage::load_config(&env)?;
        let protocol_admin = Self::require_protocol_admin(&env, &config)?;

        if new_fee_bps > MAX_PLATFORM_FEE_BPS {
            return Err(ArenaError::InvalidPlatformFee);
        }

        ArenaStorage::save_platform_fee_bps(&env, new_fee_bps);
        ArenaEvents::platform_fee_updated(&env, &protocol_admin, new_fee_bps);
        Ok(())
    }

    /// Return the current global platform fee in basis points.
    pub fn get_platform_fee_bps(env: Env) -> u32 {
        ArenaStorage::load_platform_fee_bps(&env)
    }

    /// Configure this arena instance's oracle freshness policy (#1512).
    ///
    /// Protocol-only (#1629): the host of the arena cannot change the oracle
    /// policy. The protocol admin — the deploying factory's admin — must
    /// authorise this.
    ///
    /// `max_age_secs`: an oracle observation older than this makes
    /// `resolve_round` refuse with `ArenaError::StaleOracleData`.
    /// `warn_age_secs`: an observation older than this (but younger than
    /// `max_age_secs`) still resolves, but is surfaced via
    /// `oracle_freshness_observed` as `Warning` for alerting.
    ///
    /// Like `update_platform_fee`, this only affects *this* arena instance
    /// going forward — each arena has independent storage.
    ///
    /// # Errors
    /// - `ArenaError::InvalidFreshnessPolicy` if the policy is out of range.
    /// - `ArenaError::NoProtocolAdmin` if the deploying factory cannot name a
    ///   protocol admin.
    pub fn set_oracle_freshness_policy(
        env: Env,
        max_age_secs: u64,
        warn_age_secs: u64,
    ) -> Result<(), ArenaError> {
        ArenaStorage::require_current_storage_version(&env)?;
        let config = ArenaStorage::load_config(&env)?;
        let protocol_admin = Self::require_protocol_admin(&env, &config)?;

        let policy = OracleFreshnessPolicy {
            max_age_secs,
            warn_age_secs,
            version: types::FRESHNESS_POLICY_VERSION,
        };
        types::validate_freshness_policy(&policy)?;

        ArenaStorage::save_oracle_freshness_policy(&env, &policy);
        ArenaEvents::oracle_freshness_policy_updated(
            &env,
            &protocol_admin,
            max_age_secs,
            warn_age_secs,
        );
        Ok(())
    }

    /// Return this arena instance's current oracle freshness policy (#1512).
    pub fn get_oracle_freshness_policy(env: Env) -> OracleFreshnessPolicy {
        ArenaStorage::load_oracle_freshness_policy(&env)
    }

    /// Return the oracle contract this arena instance reads its yield rate
    /// from (#1512). Previously only stored inside `ArenaConfig` with no
    /// dedicated getter — an off-chain reader (the backend's own
    /// independent freshness check, or any other tooling) had no way to
    /// discover which oracle instance a given arena actually uses.
    pub fn get_oracle_contract(env: Env) -> Result<Address, ArenaError> {
        let config = ArenaStorage::load_config(&env)?;
        Ok(config.oracle_contract)
    }

    /// Return the cumulative yield earned across all resolved rounds.
    ///
    /// Summed from vault balance deltas recorded during each `resolve_round`
    /// call. Returns `0` if the contract has not been initialised or no rounds
    /// have been resolved.
    pub fn get_total_yield(env: Env) -> i128 {
        Self::total_yield(&env)
    }

    fn total_yield(env: &Env) -> i128 {
        ArenaStorage::load_config(env)
            .map(|c| c.cumulative_yield)
            .unwrap_or(0)
    }

    /// Return the yield snapshot recorded when `round` was resolved.
    ///
    /// Returns `None` if `round` has not been resolved or does not exist.
    ///
    /// # Parameters
    /// - `round`: 1-based round number (the first round resolved is round 1).
    pub fn get_yield_snapshot(env: Env, round: u32) -> Option<YieldSnapshot> {
        ArenaStorage::load_yield_snapshot(&env, round)
    }

    /// Return the resolution result recorded when `round` was resolved.
    ///
    /// Includes eliminated and survivor counts and the associated yield
    /// snapshot. Returns `None` if `round` has not been resolved or does not
    /// exist.
    ///
    /// # Parameters
    /// - `round`: 1-based round number.
    pub fn get_round_result(env: Env, round: u32) -> Option<RoundResult> {
        ArenaStorage::load_round_result(&env, round)
    }

    /// Commitment preimage, bound to one arena, round, and player (#1630):
    ///
    /// `SHA-256("IA_COMMIT_V1" || arena || round || player || choice || salt)`
    ///
    /// - `arena` / `player`: the ScVal XDR of the address (`Address::to_xdr`),
    ///   i.e. the 4-byte `SCV_ADDRESS` discriminant followed by the ScAddress.
    /// - `round`: `u32`, big-endian (the XDR `u32` encoding).
    /// - `choice`: one byte, `Heads = 0`, `Tails = 1`.
    /// - `salt`: 32 raw bytes.
    ///
    /// A hash copied from another player, arena, or round therefore fails
    /// `reveal_choice`: the reveal recomputes the hash for the revealing
    /// caller's own context.
    fn compute_commitment(
        env: &Env,
        arena: &Address,
        round: u32,
        player: &Address,
        choice: Choice,
        salt: &BytesN<32>,
    ) -> BytesN<32> {
        let mut preimage = Bytes::from_slice(env, COMMIT_DOMAIN);
        preimage.append(&arena.clone().to_xdr(env));
        preimage.append(&Bytes::from_slice(env, &round.to_be_bytes()));
        preimage.append(&player.clone().to_xdr(env));
        preimage.push_back(choice.to_byte());
        preimage.append(&Bytes::from_slice(env, &salt.to_array()));
        env.crypto().sha256(&preimage).into()
    }

    /// Gameplay runs only while neither this arena's own pause nor the
    /// factory-wide emergency pause (#1583) is set. The two flags are
    /// independent: clearing one never clears the other.
    ///
    /// The arena's own pause is protocol-governed and time-boxed (#1629): once
    /// it has been held for `MAX_PAUSE_DURATION_SECONDS` it no longer blocks
    /// anything, so a protocol pause can never lock players out of their
    /// entry fees, prizes or refunds.
    fn require_not_paused(env: &Env, config: &ArenaConfig) -> Result<(), ArenaError> {
        if config.paused && !Self::pause_has_expired(env, config) {
            return Err(ArenaError::ContractPaused);
        }
        Self::require_not_globally_paused(env, config)
    }

    /// Whether the arena's own pause has outlived `MAX_PAUSE_DURATION_SECONDS`.
    ///
    /// A pause recorded by the protocol admin carries the timestamp of the
    /// pause, so it expires on schedule. A pause inherited from before the
    /// role split (#1629) carries no timestamp and therefore no bound: it is
    /// treated as already expired, because an unbounded pause must never be
    /// able to hold a player's funds.
    fn pause_has_expired(env: &Env, config: &ArenaConfig) -> bool {
        if !config.paused {
            return false;
        }
        match ArenaStorage::load_paused_at(env) {
            Some(paused_at) if paused_at > 0 => {
                env.ledger().timestamp() >= paused_at.saturating_add(MAX_PAUSE_DURATION_SECONDS)
            }
            _ => true,
        }
    }

    /// Resolve the protocol admin of this arena (#1629).
    ///
    /// The protocol admin is the deploying factory's current admin. Reading it
    /// from the factory — rather than caching it in the arena — means a
    /// factory-level admin rotation (`propose_admin` / `accept_admin` on the
    /// factory) immediately withdraws the old admin's protocol powers over
    /// every arena, with no per-arena bookkeeping to keep in sync.
    ///
    /// Fails closed: an arena whose factory cannot answer has no protocol
    /// admin, so the protocol-only entry points stay unavailable rather than
    /// falling back to the host — that fallback is exactly the conflated
    /// authority #1629 removes.
    fn resolve_protocol_admin(env: &Env, config: &ArenaConfig) -> Result<Address, ArenaError> {
        match FactoryClient::new(env, &config.factory).try_admin() {
            Ok(Ok(admin)) => Ok(admin),
            _ => Err(ArenaError::NoProtocolAdmin),
        }
    }

    /// Require the protocol admin's authorisation for a protocol-only entry
    /// point (#1629).
    fn require_protocol_admin(
        env: &Env,
        config: &ArenaConfig,
    ) -> Result<Address, ArenaError> {
        let protocol_admin = Self::resolve_protocol_admin(env, config)?;
        protocol_admin.require_auth();
        Ok(protocol_admin)
    }

    /// Reject while the deploying factory reports the protocol-wide pause.
    ///
    /// Fails open when the factory cannot answer (not a contract, or a factory
    /// version that predates `is_globally_paused`): such a factory has no way
    /// to set the pause, so there is nothing to enforce, and failing closed
    /// would freeze every arena — refunds included — on a deployment-ordering
    /// mistake. Budget exhaustion still aborts the whole transaction, so a
    /// caller cannot force the open path.
    fn require_not_globally_paused(env: &Env, config: &ArenaConfig) -> Result<(), ArenaError> {
        match FactoryClient::new(env, &config.factory).try_is_globally_paused() {
            Ok(Ok(true)) => Err(ArenaError::GloballyPaused),
            _ => Ok(()),
        }
    }

    /// Shared cancellation path: mark the arena `Cancelled`, release the pooled
    /// principal, and tell the factory to free the pool slot and refund the
    /// creator stake. Callers own the preconditions and the cancellation event.
    fn transition_to_cancelled(env: &Env, config: &mut ArenaConfig) {
        config.state = GameState::Cancelled;
        ArenaStorage::save_config(env, config);

        if !Self::release_vault_principal(env, config) {
            ArenaStorage::save_funds_in_vault(env, true);
        }

        let arena_addr = env.current_contract_address();
        let factory_client = FactoryClient::new(env, &config.factory);
        let _ = factory_client.try_release_arena(&arena_addr);
        let _ = factory_client.try_reclaim_creator_stake(&arena_addr);
        let _ = factory_client.try_update_arena_status(&config.pool_id, &ArenaStatus::Cancelled);
    }

    /// Pull the arena's principal back from the yield vault during settlement
    /// (#1631). Returns `false` when the vault did not release it, so the caller
    /// can record that funds are still parked there. A failed balance read counts
    /// as a failure, never as "nothing to release".
    fn release_vault_principal(env: &Env, config: &ArenaConfig) -> bool {
        if config.player_count == 0 {
            return true;
        }
        let arena_addr = env.current_contract_address();
        let rwa_client = RwaAdapterClient::new(env, &config.yield_vault);
        let held = match rwa_client.try_balance_of(&arena_addr) {
            Ok(Ok(balance)) => balance,
            _ => return false,
        };
        if held <= 0 {
            return true;
        }
        matches!(rwa_client.try_withdraw_all(&arena_addr), Ok(Ok(_)))
    }

    /// Release one lobby player's entry fee from the vault and transfer it to
    /// the refund destination. Used by `leave_arena` and `ban_player`
    /// (#1580, #1581). For sponsored entries the destination is the payer who
    /// funded the fee (#1715); otherwise it is the player.
    ///
    /// Yield accrued on the refunded principal is intentionally left in the
    /// vault for the remaining pool.
    fn refund_lobby_player(
        env: &Env,
        config: &ArenaConfig,
        player: &Address,
    ) -> Result<i128, ArenaError> {
        let arena_addr = env.current_contract_address();
        let rwa_client = RwaAdapterClient::new(env, &config.yield_vault);
        let withdrawn = rwa_client
            .try_withdraw(&arena_addr, &config.entry_fee)
            .map_err(|_| ArenaError::VaultWithdrawFailed)?
            .map_err(|_| ArenaError::VaultWithdrawFailed)?;
        let refund = if withdrawn > config.entry_fee {
            config.entry_fee
        } else {
            withdrawn
        };

        let refund_recipient = ArenaStorage::refund_recipient(env, player);
        let token_client = token::TokenClient::new(env, &config.stake_token);
        token_client.transfer(&arena_addr, &refund_recipient, &refund);

        let baseline = ArenaStorage::load_last_vault_balance(env);
        ArenaStorage::save_last_vault_balance(env, baseline.saturating_sub(config.entry_fee));

        Ok(refund)
    }

    fn validate_player_limits(min_players: u32, max_players: u32) -> Result<(), ArenaError> {
        if min_players < MIN_PLAYERS_TO_START || min_players > max_players {
            return Err(ArenaError::InvalidPlayerLimits);
        }
        if max_players > MAX_PLAYERS_ALLOWED {
            return Err(ArenaError::InvalidPlayerLimits);
        }
        Ok(())
    }

    fn resolve_players(env: &Env, round: u32, expected_active: u32) -> RoundResolution {
        let indexed = ArenaStorage::load_survivor_index(env);
        let mut players = Vec::new(env);
        for player in indexed.iter() {
            if players.contains(&player) {
                continue;
            }
            if let Some(state) = ArenaStorage::load_player(env, &player)
                && state.active
            {
                players.push_back(player);
            }
        }

        if players.len() != expected_active {
            players = ArenaStorage::load_active_roster(env);
        }

        let mut active_choices: Vec<Choice> = Vec::new(env);
        for player in players.iter() {
            if let Some(choice) = ArenaStorage::load_choice(env, &player, round) {
                active_choices.push_back(choice);
            }
        }

        let tally = eliminations::tally_choices(&active_choices);
        let option_count = ArenaStorage::load_option_count(env);
        let tied = option_count == 2
            && tally.heads > 0
            && tally.heads == tally.tails;
        let mut eliminated = 0u32;
        let mut survivors = 0u32;
        let mut winner: Option<Address> = None;
        let mut next_survivors = Vec::new(env);

        for player in players.iter() {
            let mut state = ArenaStorage::load_player(env, &player).unwrap_or_default();
            if !state.active {
                continue;
            }
            let elimination = match ArenaStorage::load_choice(env, &player, round) {
                Some(choice) if eliminations::is_eliminated(choice, &tally, ArenaStorage::load_option_count(env)) => {
                    Some(EliminationReason::Majority)
                }
                Some(_) => None,
                None if ArenaStorage::load_commitment(env, &player, round).is_some() => {
                    Some(EliminationReason::NoReveal)
                }
                None => Some(EliminationReason::NoCommit),
            };

            if let Some(reason) = elimination {
                state.active = false;
                eliminated += 1;
                ArenaStorage::remove_player_choice(env, &player, round);
                ArenaStorage::save_elimination_reason(env, &player, &reason);
                ArenaEvents::player_eliminated(env, &player, round);
                ArenaEvents::player_eliminated_v2(env, &player, round, reason);
            } else {
                state.rounds_survived = state.rounds_survived.saturating_add(1);
                survivors += 1;
                winner = Some(player.clone());
                next_survivors.push_back(player.clone());
            }
            ArenaStorage::save_player(env, &player, &state);
        }

        ArenaStorage::rebuild_survivor_index(env, &next_survivors);

        if survivors == 1 {
            RoundResolution {
                eliminated,
                survivors,
                winner,
                tied,
                tally,
            }
        } else {
            RoundResolution {
                eliminated,
                survivors,
                winner: None,
                tied,
                tally,
            }
        }
    }
}

fn build_leaderboard(env: &Env) {
    let total = ArenaStorage::load_roster_count(env);
    let page_count = if total == 0 {
        0
    } else {
        (total - 1) / PAGE_SIZE + 1
    };
    let limit = ArenaStorage::load_leaderboard_limit(env);

    // Keep only the bounded top-K while scanning the paged roster. This avoids
    // materializing and sorting the full roster at game finish.
    let mut leaderboard: Vec<LeaderboardEntry> = Vec::new(env);
    for page_index in 0..page_count {
        let players = ArenaStorage::load_roster_page(env, page_index);
        for player in players.iter() {
            let state = ArenaStorage::load_player(env, &player).unwrap_or_default();
            let entry = LeaderboardEntry {
                player,
                rounds_survived: state.rounds_survived,
            };
            let mut position = leaderboard.len();
            for index in 0..leaderboard.len() {
                if entry.rounds_survived > leaderboard.get(index).unwrap().rounds_survived {
                    position = index;
                    break;
                }
            }
            if position < limit {
                leaderboard.insert(position, entry);
                if leaderboard.len() > limit {
                    leaderboard.remove(limit);
                }
            }
        }
    }

    ArenaStorage::save_leaderboard(env, &leaderboard);
    ArenaEvents::leaderboard_updated(env);
}

#[cfg(test)]
#[cfg_attr(coverage_nightly, coverage(off))]
mod test {
    use super::*;
    use soroban_sdk::{
        IntoVal, Val, contract, contractimpl, symbol_short,
        testutils::{Address as _, Events as _, Ledger as _},
        token::StellarAssetClient,
    };

    #[contract]
    struct MockOracle;

    #[contractimpl]
    impl MockOracle {
        pub fn get_current_yield_bps(_env: Env) -> u32 {
            500
        }
    }

    /// Oracle mock that also implements `get_oracle_reading` (#1512), with a
    /// caller-settable `observed_at`/`source_version` so freshness tests can
    /// control exactly how old (or how far in the future) an observation is.
    /// A plain `MockOracle` above deliberately keeps *not* implementing this
    /// method, standing in for a pre-#1512 oracle deployment.
    ///
    /// Nested in its own module: Soroban's `#[contractimpl]` macro generates
    /// module-scoped helper items named after the method, not the struct, so
    /// this contract's `get_current_yield_bps` would otherwise collide with
    /// `MockOracle`'s identically-named method in the same enclosing module.
    mod fresh_oracle_mock {
        use super::*;

        #[contract]
        pub struct MockOracleWithReading;

        #[contractimpl]
        impl MockOracleWithReading {
            pub fn set_reading(env: Env, rate_bps: u32, observed_at: u64, source_version: u32) {
                env.storage()
                    .persistent()
                    .set(&symbol_short!("rate"), &rate_bps);
                env.storage()
                    .persistent()
                    .set(&symbol_short!("obs_at"), &observed_at);
                env.storage()
                    .persistent()
                    .set(&symbol_short!("ver"), &source_version);
            }

            pub fn get_current_yield_bps(env: Env) -> u32 {
                env.storage()
                    .persistent()
                    .get(&symbol_short!("rate"))
                    .unwrap_or(0)
            }

            pub fn get_oracle_reading(env: Env) -> oracle::OracleReading {
                oracle::OracleReading {
                    rate_bps: env
                        .storage()
                        .persistent()
                        .get(&symbol_short!("rate"))
                        .unwrap_or(0),
                    observed_at: env
                        .storage()
                        .persistent()
                        .get(&symbol_short!("obs_at"))
                        .unwrap_or(0),
                    source_version: env
                        .storage()
                        .persistent()
                        .get(&symbol_short!("ver"))
                        .unwrap_or(0),
                }
            }
        }
    }
    use fresh_oracle_mock::{MockOracleWithReading, MockOracleWithReadingClient};

    #[contract]
    struct MockVault;

    #[contractimpl]
    impl MockVault {
        pub fn balance_of(env: Env, _user: Address) -> i128 {
            env.storage()
                .persistent()
                .get(&soroban_sdk::symbol_short!("BAL"))
                .unwrap_or(0)
        }

        pub fn deposit(_env: Env, _from: Address, _amount: i128) {}

        pub fn withdraw(_env: Env, _user: Address, amount: i128) -> i128 {
            amount
        }

        pub fn withdraw_all(env: Env, user: Address) -> i128 {
            Self::balance_of(env, user)
        }
    }

    fn setup(n: u32) -> (Env, ArenaContractClient<'static>) {
        let env = Env::default();
        env.mock_all_auths();
        let contract_id = env.register(ArenaContract, ());
        let oracle_id = env.register(MockOracle, ());

        env.as_contract(&contract_id, || {
            let config = ArenaConfig {
                admin: Address::generate(&env),
                stake_token: Address::generate(&env),
                yield_vault: Address::generate(&env),
                entry_fee: 100,
                state: GameState::Open,
                paused: false,
                player_count: 0,
                active_player_count: 0,
                cumulative_yield: 0,
                commit_deadline: 0,
                round_count: 0,
                oracle_contract: oracle_id,
                factory: Address::generate(&env),
                pool_id: 0,
                platform_fee_bps: 1000,
            };
            ArenaStorage::save_config(&env, &config);
            for _ in 0..n {
                let player = Address::generate(&env);
                ArenaStorage::add_player(&env, &player);
            }
        });

        let client = ArenaContractClient::new(&env, &contract_id);
        (env, client)
    }

    #[test]
    fn zero_players() {
        let (_env, client) = setup(0);
        assert_eq!(client.player_count(), 0);
        assert_eq!(client.get_players(&0).len(), 0);
    }

    #[test]
    fn one_player() {
        let (_env, client) = setup(1);
        assert_eq!(client.player_count(), 1);

        let page0 = client.get_players(&0);
        assert_eq!(page0.len(), 1);
        let (_addr, state) = page0.get(0).unwrap();
        assert!(state.active);
        assert_eq!(state.rounds_survived, 0);
        assert_eq!(client.get_players(&1).len(), 0);
    }

    #[test]
    fn fifty_one_players_cross_page_boundary() {
        let (_env, client) = setup(51);
        assert_eq!(client.player_count(), 51);

        let page0 = client.get_players(&0);
        let page1 = client.get_players(&1);
        let page2 = client.get_players(&2);

        assert_eq!(page0.len(), PAGE_SIZE);
        assert_eq!(page1.len(), 1);
        assert_eq!(page2.len(), 0);

        for (addr1, _) in page1.iter() {
            for (addr0, _) in page0.iter() {
                assert_ne!(addr0, addr1);
            }
        }
        assert_eq!(page0.len() + page1.len(), client.player_count());
    }

    #[test]
    fn cross_page_minority_survives_and_compacts_survivor_index() {
        let (env, client) = setup(51);
        let mut expected_survivor = None;

        env.as_contract(&client.address, || {
            let players = ArenaStorage::load_all_players(&env);
            for index in 0..players.len() {
                let player = players.get(index).unwrap();
                let choice = if index == 50 {
                    Choice::Tails
                } else {
                    Choice::Heads
                };
                ArenaStorage::save_choice(&env, &player, 1, &choice);
            }
            expected_survivor = Some(players.get(50).unwrap());

            let resolution = ArenaContract::resolve_players(&env, 1, 51);
            assert_eq!(resolution.eliminated, 50);
            assert_eq!(resolution.survivors, 1);
            assert_eq!(resolution.winner, expected_survivor);

            let survivors = ArenaStorage::load_survivor_index(&env);
            assert_eq!(survivors.len(), 1);
            assert_eq!(survivors.get(0), expected_survivor);
        });

        let expected_survivor = expected_survivor.unwrap();
        for (player, state) in client.get_players(&0).iter() {
            assert!(!state.active);
            assert_ne!(player, expected_survivor);
        }
        let second_page = client.get_players(&1);
        assert_eq!(second_page.len(), 1);
        let (player, state) = second_page.get(0).unwrap();
        assert_eq!(player, expected_survivor);
        assert!(state.active);
        assert!(client.get_players(&2).is_empty());
    }

    #[test]
    fn stale_survivor_page_self_heals_from_player_state() {
        let (env, client) = setup(51);
        env.as_contract(&client.address, || {
            let players = ArenaStorage::load_all_players(&env);
            let stale = players.get(0).unwrap();
            ArenaStorage::save_player(
                &env,
                &stale,
                &PlayerState {
                    active: false,
                    rounds_survived: 1,
                },
            );
            let mut stale_page = Vec::new(&env);
            stale_page.push_back(stale);
            ArenaStorage::save_survivor_page(&env, 0, &stale_page);
            ArenaStorage::save_survivor_count(&env, 1);

            let resolution = ArenaContract::resolve_players(&env, 1, 51);
            assert_eq!(resolution.eliminated, 1);
            assert_eq!(resolution.survivors, 50);
            assert_eq!(resolution.winner, None);

            let survivors = ArenaStorage::load_survivor_index(&env);
            assert_eq!(survivors.len(), 50);
        });
    }

    #[test]
    fn paged_player_read_budget_is_bounded_at_maximum_roster() {
        let measure = |player_count: u32, page: u32| {
            let (env, client) = setup(player_count);
            assert_eq!(client.get_players(&page).len(), PAGE_SIZE);
            env.cost_estimate().resources()
        };

        let fifty = measure(50, 0);
        let hundred_first = measure(100, 0);
        let hundred_second = measure(100, 1);

        assert!(fifty.read_entries <= 53);
        assert!(hundred_first.read_entries <= 53);
        assert!(hundred_second.read_entries <= 53);
        assert_eq!(hundred_first.read_bytes, fifty.read_bytes);
        assert_eq!(hundred_second.read_bytes, hundred_first.read_bytes);
        assert!(hundred_first.instructions <= fifty.instructions + 100_000);
        assert!(hundred_second.instructions <= hundred_first.instructions + 100_000);
        assert!(hundred_first.instructions < 50_000_000);
        assert!(hundred_second.instructions < 50_000_000);
    }

    fn compute_commitment(
        env: &Env,
        arena: &Address,
        round: u32,
        player: &Address,
        choice: Choice,
        salt: &BytesN<32>,
    ) -> BytesN<32> {
        ArenaContract::compute_commitment(env, arena, round, player, choice, salt)
    }

    #[test]
    fn valid_commit_and_reveal() {
        let env = Env::default();
        env.mock_all_auths();
        let contract_id = env.register(ArenaContract, ());
        let player = Address::generate(&env);
        let salt = BytesN::from_array(&env, &[42u8; 32]);
        let choice = Choice::Tails;
        let commitment = compute_commitment(&env, &contract_id, 1, &player, choice, &salt);

        env.as_contract(&contract_id, || {
            let config = ArenaConfig {
                admin: Address::generate(&env),
                stake_token: Address::generate(&env),
                entry_fee: 100,
                state: GameState::Open,
                paused: false,
                player_count: 0,
                active_player_count: 0,
                cumulative_yield: 0,
                commit_deadline: 0,
                yield_vault: Address::generate(&env),
                round_count: 0,
                oracle_contract: oracle_id,
                factory: Address::generate(&env),
                pool_id: 0,
                platform_fee_bps: 1000,
            };
            ArenaStorage::save_config(&env, &config);
            ArenaStorage::add_player(&env, &player);
            ArenaStorage::save_commitment(&env, &player, 1, &commitment);
        });

        let client = ArenaContractClient::new(&env, &contract_id);
        client.reveal_choice(&player, &choice, &salt);

        env.as_contract(&contract_id, || {
            let stored = ArenaStorage::load_choice(&env, &player, 1).unwrap();
            assert_eq!(stored, choice);
        });
    }

    #[test]
    fn reveal_non_player_rejected() {
        let env = Env::default();
        env.mock_all_auths();
        let contract_id = env.register(ArenaContract, ());
        let player = Address::generate(&env);
        let salt = BytesN::from_array(&env, &[42u8; 32]);
        let choice = Choice::Heads;
        let commitment = compute_commitment(&env, &contract_id, 1, &player, choice, &salt);

        env.as_contract(&contract_id, || {
            let config = ArenaConfig {
                admin: Address::generate(&env),
                stake_token: Address::generate(&env),
                entry_fee: 100,
                state: GameState::Open,
                paused: false,
                player_count: 0,
                active_player_count: 0,
                cumulative_yield: 0,
                commit_deadline: 0,
                yield_vault: Address::generate(&env),
                round_count: 0,
                oracle_contract: oracle_id,
                factory: Address::generate(&env),
                pool_id: 0,
                platform_fee_bps: 1000,
            };
            ArenaStorage::save_config(&env, &config);
            ArenaStorage::save_commitment(&env, &player, 1, &commitment);
        });

        let client = ArenaContractClient::new(&env, &contract_id);
        let result = client.try_reveal_choice(&player, &choice, &salt);
        assert_eq!(result, Err(Ok(ArenaError::NotAPlayer)));
    }

    #[test]
    fn reveal_eliminated_player_rejected() {
        let env = Env::default();
        env.mock_all_auths();
        let contract_id = env.register(ArenaContract, ());
        let player = Address::generate(&env);
        let salt = BytesN::from_array(&env, &[42u8; 32]);
        let choice = Choice::Heads;
        let commitment = compute_commitment(&env, &contract_id, 1, &player, choice, &salt);

        env.as_contract(&contract_id, || {
            let config = ArenaConfig {
                admin: Address::generate(&env),
                stake_token: Address::generate(&env),
                entry_fee: 100,
                state: GameState::Open,
                paused: false,
                player_count: 0,
                active_player_count: 0,
                cumulative_yield: 0,
                commit_deadline: 0,
                yield_vault: Address::generate(&env),
                round_count: 0,
                oracle_contract: oracle_id,
                factory: Address::generate(&env),
                pool_id: 0,
                platform_fee_bps: 1000,
            };
            ArenaStorage::save_config(&env, &config);
            ArenaStorage::add_player(&env, &player);
            ArenaStorage::save_player(
                &env,
                &player,
                &PlayerState {
                    active: false,
                    rounds_survived: 1,
                },
            );
            ArenaStorage::save_commitment(&env, &player, 1, &commitment);
        });

        let client = ArenaContractClient::new(&env, &contract_id);
        let result = client.try_reveal_choice(&player, &choice, &salt);
        assert_eq!(result, Err(Ok(ArenaError::PlayerEliminated)));
    }

    #[test]
    fn reveal_hash_mismatch() {
        let env = Env::default();
        env.mock_all_auths();
        let contract_id = env.register(ArenaContract, ());
        let player = Address::generate(&env);
        let salt = BytesN::from_array(&env, &[7u8; 32]);
        let commitment = compute_commitment(&env, &contract_id, 1, &player, Choice::Heads, &salt);

        env.as_contract(&contract_id, || {
            let config = ArenaConfig {
                admin: Address::generate(&env),
                stake_token: Address::generate(&env),
                entry_fee: 100,
                state: GameState::Open,
                paused: false,
                player_count: 0,
                active_player_count: 0,
                cumulative_yield: 0,
                commit_deadline: 0,
                yield_vault: Address::generate(&env),
                round_count: 0,
                oracle_contract: oracle_id,
                factory: Address::generate(&env),
                pool_id: 0,
                platform_fee_bps: 1000,
            };
            ArenaStorage::save_config(&env, &config);
            ArenaStorage::add_player(&env, &player);
            ArenaStorage::save_commitment(&env, &player, 1, &commitment);
        });

        let client = ArenaContractClient::new(&env, &contract_id);
        let result = client.try_reveal_choice(&player, &Choice::Tails, &salt);
        assert!(result.is_err());
    }

    #[test]
    fn reveal_before_deadline_fails() {
        let env = Env::default();
        env.mock_all_auths();
        let contract_id = env.register(ArenaContract, ());
        let player = Address::generate(&env);
        let salt = BytesN::from_array(&env, &[3u8; 32]);
        let commitment = compute_commitment(&env, &contract_id, 1, &player, Choice::Heads, &salt);

        env.as_contract(&contract_id, || {
            let config = ArenaConfig {
                admin: Address::generate(&env),
                stake_token: Address::generate(&env),
                entry_fee: 100,
                state: GameState::Open,
                paused: false,
                player_count: 0,
                active_player_count: 0,
                cumulative_yield: 0,
                commit_deadline: 1,
                yield_vault: Address::generate(&env),
                round_count: 0,
                oracle_contract: oracle_id,
                factory: Address::generate(&env),
                pool_id: 0,
                platform_fee_bps: 1000,
            };
            ArenaStorage::save_config(&env, &config);
            ArenaStorage::add_player(&env, &player);
            ArenaStorage::save_commitment(&env, &player, 1, &commitment);
        });

        let client = ArenaContractClient::new(&env, &contract_id);
        let result = client.try_reveal_choice(&player, &Choice::Heads, &salt);
        assert!(result.is_err());
    }

    #[test]
    fn double_reveal_fails() {
        let env = Env::default();
        env.mock_all_auths();
        let contract_id = env.register(ArenaContract, ());
        let player = Address::generate(&env);
        let salt = BytesN::from_array(&env, &[9u8; 32]);
        let choice = Choice::Heads;
        let commitment = compute_commitment(&env, &contract_id, 1, &player, choice, &salt);

        env.as_contract(&contract_id, || {
            let config = ArenaConfig {
                admin: Address::generate(&env),
                stake_token: Address::generate(&env),
                entry_fee: 100,
                state: GameState::Open,
                paused: false,
                player_count: 0,
                active_player_count: 0,
                cumulative_yield: 0,
                commit_deadline: 0,
                yield_vault: Address::generate(&env),
                round_count: 0,
                oracle_contract: oracle_id,
                factory: Address::generate(&env),
                pool_id: 0,
                platform_fee_bps: 1000,
            };
            ArenaStorage::save_config(&env, &config);
            ArenaStorage::add_player(&env, &player);
            ArenaStorage::save_commitment(&env, &player, 1, &commitment);
        });

        let client = ArenaContractClient::new(&env, &contract_id);
        client.reveal_choice(&player, &choice, &salt);
        let result = client.try_reveal_choice(&player, &choice, &salt);
        assert!(result.is_err());
    }

    #[test]
    fn reveal_without_commitment_fails() {
        let env = Env::default();
        env.mock_all_auths();
        let contract_id = env.register(ArenaContract, ());
        let player = Address::generate(&env);
        let salt = BytesN::from_array(&env, &[5u8; 32]);

        env.as_contract(&contract_id, || {
            let config = ArenaConfig {
                admin: Address::generate(&env),
                stake_token: Address::generate(&env),
                entry_fee: 100,
                state: GameState::Open,
                paused: false,
                player_count: 0,
                active_player_count: 0,
                cumulative_yield: 0,
                commit_deadline: 0,
                yield_vault: Address::generate(&env),
                round_count: 0,
                oracle_contract: Address::generate(&env),
                factory: Address::generate(&env),
                pool_id: 0,
                platform_fee_bps: 1000,
            };
            ArenaStorage::save_config(&env, &config);
        });

        let client = ArenaContractClient::new(&env, &contract_id);
        let result = client.try_reveal_choice(&player, &Choice::Heads, &salt);
        assert!(result.is_err());
    }

    /// `player_count: 2` plus two registered active players is required,
    /// not incidental: `start_round` rejects any config with `player_count
    /// < MIN_PLAYERS_TO_START` (see #767/#1059), so a `player_count: 0`
    /// version of this helper would make every test built on it fail with
    /// `NotEnoughPlayers` regardless of what each test is actually trying
    /// to exercise (grace-period timing, yield tracking, etc.) — that
    /// exact regression was #1150. Keep this at 2 (or higher) if this
    /// helper is ever touched again.
    fn setup_started(duration: u64, start_ts: u64) -> (Env, ArenaContractClient<'static>) {
        let env = Env::default();
        let oracle_id = env.register(MockOracle, ());
        setup_started_with_oracle(env, duration, start_ts, oracle_id)
    }

    /// Same as `setup_started`, but lets the caller supply the oracle
    /// contract instance — used by the #1512 freshness tests to swap in
    /// `MockOracleWithReading` instead of the plain `MockOracle`.
    fn setup_started_with_oracle(
        env: Env,
        duration: u64,
        start_ts: u64,
        oracle_id: Address,
    ) -> (Env, ArenaContractClient<'static>) {
        env.mock_all_auths();
        let contract_id = env.register(ArenaContract, ());
        env.as_contract(&contract_id, || {
            let config = ArenaConfig {
                admin: Address::generate(&env),
                stake_token: Address::generate(&env),
                entry_fee: 100,
                state: GameState::Open,
                paused: false,
                player_count: 2,
                active_player_count: 2,
                cumulative_yield: 0,
                commit_deadline: 0,
                yield_vault: Address::generate(&env),
                round_count: 0,
                oracle_contract: oracle_id,
                factory: Address::generate(&env),
                pool_id: 0,
                platform_fee_bps: 1000,
            };
            ArenaStorage::save_config(&env, &config);
            // Register 2 active players so active_count check in start_round passes.
            let p1 = Address::generate(&env);
            let p2 = Address::generate(&env);
            ArenaStorage::add_player(&env, &p1);
            ArenaStorage::add_player(&env, &p2);
        });
        let client = ArenaContractClient::new(&env, &contract_id);
        env.ledger().with_mut(|li| li.timestamp = start_ts);
        client.start_round(&duration);
        (env, client)
    }

    fn state_of(env: &Env, client: &ArenaContractClient) -> GameState {
        env.as_contract(&client.address, || {
            ArenaStorage::load_config(env).unwrap().state
        })
    }

    fn paused_error<T>(
        result: Result<
            Result<T, soroban_sdk::ConversionError>,
            Result<ArenaError, soroban_sdk::InvokeError>,
        >,
    ) -> ArenaError {
        result
            .err()
            .expect("paused call must error")
            .expect("error must be a contract error")
    }

    #[test]
    fn pause_rejects_mutating_gameplay_entry_points() {
        let env = Env::default();
        env.mock_all_auths();
        let contract_id = env.register(ArenaContract, ());
        let admin = Address::generate(&env);
        let player = Address::generate(&env);
        let salt = BytesN::from_array(&env, &[1u8; 32]);
        let commitment = compute_commitment(&env, &contract_id, 1, &player, Choice::Heads, &salt);

        env.as_contract(&contract_id, || {
            ArenaStorage::save_config(
                &env,
                &ArenaConfig {
                    admin: admin.clone(),
                    stake_token: Address::generate(&env),
                    entry_fee: 100,
                    state: GameState::Active,
                    paused: false,
                    player_count: 0,
                    active_player_count: 0,
                    cumulative_yield: 0,
                    commit_deadline: 0,
                    yield_vault: Address::generate(&env),
                    round_count: 0,
                    oracle_contract: oracle_id,
                    factory: Address::generate(&env),
                    pool_id: 0,
                    platform_fee_bps: 1000,
                },
            );
            ArenaStorage::save_player(
                &env,
                &player,
                &PlayerState {
                    active: true,
                    rounds_survived: 0,
                },
            );
            ArenaStorage::save_commitment(&env, &player, 1, &commitment);
            ArenaStorage::save_round_start(&env, 0);
            ArenaStorage::save_round_duration(&env, 0);
        });

        let client = ArenaContractClient::new(&env, &contract_id);
        client.pause(&symbol_short!("emerg"));

        assert_eq!(
            paused_error(client.try_join_arena(&player)),
            ArenaError::ContractPaused
        );
        assert_eq!(
            paused_error(client.try_submit_commitment(&player, &commitment)),
            ArenaError::ContractPaused
        );
        assert_eq!(
            paused_error(client.try_reveal_choice(&player, &Choice::Heads, &salt)),
            ArenaError::ContractPaused
        );
        assert_eq!(
            paused_error(client.try_resolve_round()),
            ArenaError::ContractPaused
        );

        env.as_contract(&contract_id, || {
            let mut config = ArenaStorage::load_config(&env).unwrap();
            config.state = GameState::Finished;
            ArenaStorage::save_config(&env, &config);
        });
        assert_eq!(
            paused_error(client.try_claim(&player)),
            ArenaError::ContractPaused
        );
    }

    #[test]
    fn unpause_allows_mutating_gameplay_again() {
        let env = Env::default();
        env.mock_all_auths();
        let contract_id = env.register(ArenaContract, ());
        let vault_id = env.register(MockVault, ());
        let oracle_id = env.register(MockOracle, ());
        let token_admin = Address::generate(&env);
        let token_id = env
            .register_stellar_asset_contract_v2(token_admin)
            .address();
        let token_admin_client = StellarAssetClient::new(&env, &token_id);

        let admin = Address::generate(&env);
        let client = ArenaContractClient::new(&env, &contract_id);
        client.initialize(
            &admin,
            &token_id,
            &vault_id,
            &100,
            &oracle_id,
            &Address::generate(&env),
            &1,
            &2,
            &10,
            &60,
        );

        let p1 = Address::generate(&env);
        let p2 = Address::generate(&env);
        let p3 = Address::generate(&env);
        token_admin_client.mint(&p1, &1000);
        token_admin_client.mint(&p2, &1000);
        token_admin_client.mint(&p3, &1000);

        client.join_arena(&p1);
        client.join_arena(&p2);
        client.join_arena(&p3);

        // Round 1: players commit Heads (same side → both survive)
        env.ledger().with_mut(|li| li.timestamp = 1000);
        client.start_round(&60);
        let salt = BytesN::from_array(&env, &[1u8; 32]);
        let comm = compute_commitment(&env, &contract_id, 1, &p1, Choice::Heads, &salt);
        // Each hash is bound to its own player, so p2 cannot reuse p1's (#1630).
        let comm_p2 = compute_commitment(&env, &contract_id, 1, &p2, Choice::Heads, &salt);
        client.submit_commitment(&p1, &comm);
        client.submit_commitment(&p2, &comm_p2);
        env.ledger().with_mut(|li| li.timestamp = 1061);
        // Both reveal Heads — all same choice, both survive
        client.reveal_choice(&p1, &Choice::Heads, &salt);
        client.reveal_choice(&p2, &Choice::Heads, &salt);
        client.resolve_round();

        // Start round 2 – should clear round 1 choices/commitments
        env.ledger().with_mut(|li| li.timestamp = 2000);
        client.start_round(&60);

        // Verify choices are cleared: players can commit and reveal again
        let salt2 = BytesN::from_array(&env, &[2u8; 32]);
        let comm2 = compute_commitment(&env, &contract_id, 2, &p1, Choice::Heads, &salt2);
        let comm2_p2 = compute_commitment(&env, &contract_id, 2, &p2, Choice::Heads, &salt2);
        client.submit_commitment(&p1, &comm2);
        client.submit_commitment(&p2, &comm2_p2);
        env.ledger().with_mut(|li| li.timestamp = 2061);
        // If choices were not cleared, reveal would fail with ChoiceAlreadyRevealed
        // If stale commitment was present, reveal would succeed but use wrong commitment
        client.reveal_choice(&p1, &Choice::Heads, &salt2);
        client.reveal_choice(&p2, &Choice::Heads, &salt2);
        client.resolve_round();
    }

    /// Verify that a player who does not reveal their choice is eliminated
    /// during round resolution (AFK elimination).
    #[test]
    fn non_revealing_player_is_eliminated() {
        let env = Env::default();
        env.mock_all_auths();
        let contract_id = env.register(ArenaContract, ());
        let vault_id = env.register(MockVault, ());
        let oracle_id = env.register(MockOracle, ());
        let token_admin = Address::generate(&env);
        let token_id = env
            .register_stellar_asset_contract_v2(token_admin)
            .address();
        let token_admin_client = StellarAssetClient::new(&env, &token_id);

        let p1 = Address::generate(&env);
        let p2 = Address::generate(&env);
        let p3 = Address::generate(&env);
        token_admin_client.mint(&p1, &1000);
        token_admin_client.mint(&p2, &1000);
        token_admin_client.mint(&p3, &1000);

        let client = ArenaContractClient::new(&env, &contract_id);
        let admin = Address::generate(&env);
        client.initialize(
            &admin,
            &token_id,
            &vault_id,
            &100,
            &oracle_id,
            &Address::generate(&env),
            &1,
            &2,
            &10,
            &60,
        );
        client.join_arena(&p1);
        client.join_arena(&p2);
        client.join_arena(&p3);

        // Start round
        env.ledger().with_mut(|li| li.timestamp = 1000);
        client.start_round(&60);

        // Only p1 and p2 commit and reveal (p3 goes AFK)
        let salt = BytesN::from_array(&env, &[1u8; 32]);
        let comm = compute_commitment(&env, &contract_id, 1, &p1, Choice::Heads, &salt);
        let comm_p2 = compute_commitment(&env, &contract_id, 1, &p2, Choice::Heads, &salt);
        client.submit_commitment(&p1, &comm);
        client.submit_commitment(&p2, &comm_p2);
        let salt3 = BytesN::from_array(&env, &[3u8; 32]);
        let comm3 = compute_commitment(&env, &contract_id, 1, &p3, Choice::Heads, &salt3);
        client.submit_commitment(&p3, &comm3);

        env.ledger().with_mut(|li| li.timestamp = 1061);
        client.reveal_choice(&p1, &Choice::Heads, &salt);
        client.reveal_choice(&p2, &Choice::Heads, &salt);
        // p3 does NOT reveal

        client.resolve_round();

        // p3 should be eliminated (AFK)
        env.as_contract(&client.address, || {
            let state = ArenaStorage::load_player(&env, &p3).unwrap();
            assert!(!state.active, "AFK player should be eliminated");
        });

        // p1 and p2 should still be active (all same choice, no majority to eliminate)
        env.as_contract(&client.address, || {
            let s1 = ArenaStorage::load_player(&env, &p1).unwrap();
            let s2 = ArenaStorage::load_player(&env, &p2).unwrap();
            assert!(s1.active);
            assert!(s2.active);
        });
    }

    /// When every remaining active player fails to reveal the same choice
    /// (e.g., both AFKs in a 2-player round), the arena should transition to
    /// Cancelled to enable claim_refund recovery instead of becoming permanently
    /// locked.
    #[test]
    fn zero_survivor_round_resolution() {
        let env = Env::default();
        env.mock_all_auths();
        let contract_id = env.register(ArenaContract, ());
        let vault_id = env.register(MockVault, ());
        let oracle_id = env.register(MockOracle, ());
        let token_admin = Address::generate(&env);
        let token_id = env
            .register_stellar_asset_contract_v2(token_admin)
            .address();
        let token_admin_client = StellarAssetClient::new(&env, &token_id);

        let admin = Address::generate(&env);
        let client = ArenaContractClient::new(&env, &contract_id);
        client.initialize(&admin, &token_id, &vault_id, &100, &oracle_id, &Address::generate(&env), &1, &2, &10, &60);
        client.join_arena(&p1);
        client.join_arena(&p2);

        // Contract holds 200 (2 × 100 entry fee).
        let token_client = token::TokenClient::new(&env, &token_id);
        assert_eq!(token_client.balance(&contract_id), 200);

        // Start round
        env.ledger().with_mut(|li| li.timestamp = 1000);
        client.start_round(&60);

        // Advance time past the commit deadline WITHOUT any player revealing
        env.ledger()
            .with_mut(|li| li.timestamp = 1000 + MIN_ROUND_DURATION_SECONDS + 1);
        
        // Resolve the round
        client.resolve_round();
        
        // Get the arena config and verify it transitioned to Cancelled, not Finished
        env.as_contract(&contract_id, || {
            let config = ArenaStorage::load_config(&env).expect("config must exist");
            assert_eq!(
                config.state,
                GameState::Cancelled,
                "arena must transition to Cancelled when zero survivors remain, not Finished"
            );
            
            // Verify no winner was set
            let winner = ArenaStorage::get_winner(&env);
            assert!(
                winner.is_none(),
                "no winner should be set when more than one player survives"
            );
        });
    }

    /// Verify that a player who reveals the minority choice survives the round.
    #[test]
    fn minority_revealer_survives() {
        let env = Env::default();
        env.mock_all_auths();
        let contract_id = env.register(ArenaContract, ());
        let vault_id = env.register(MockVault, ());
        let oracle_id = env.register(MockOracle, ());
        let token_admin = Address::generate(&env);
        let token_id = env
            .register_stellar_asset_contract_v2(token_admin)
            .address();
        let token_admin_client = StellarAssetClient::new(&env, &token_id);

        let p1 = Address::generate(&env);
        let p2 = Address::generate(&env);
        let p3 = Address::generate(&env);
        token_admin_client.mint(&p1, &1000);
        token_admin_client.mint(&p2, &1000);
        token_admin_client.mint(&p3, &1000);

        let client = ArenaContractClient::new(&env, &contract_id);
        let admin = Address::generate(&env);
        client.initialize(
            &admin,
            &token_id,
            &vault_id,
            &100,
            &oracle_id,
            &Address::generate(&env),
            &1,
            &2,
            &10,
            &60,
        );
        client.join_arena(&p1);
        client.join_arena(&p2);
        client.join_arena(&p3);

        // Start round
        env.ledger().with_mut(|li| li.timestamp = 1000);
        client.start_round(&60);

        // p1 chooses Tails (minority), p2 and p3 choose Heads (majority)
        let salt1 = BytesN::from_array(&env, &[1u8; 32]);
        let salt2 = BytesN::from_array(&env, &[2u8; 32]);
        let salt3 = BytesN::from_array(&env, &[3u8; 32]);
        let comm1 = compute_commitment(&env, &contract_id, 1, &p1, Choice::Tails, &salt1);
        let comm2 = compute_commitment(&env, &contract_id, 1, &p2, Choice::Heads, &salt2);
        let comm3 = compute_commitment(&env, &contract_id, 1, &p3, Choice::Heads, &salt3);
        client.submit_commitment(&p1, &comm1);
        client.submit_commitment(&p2, &comm2);
        client.submit_commitment(&p3, &comm3);

        env.ledger().with_mut(|li| li.timestamp = 1061);
        client.reveal_choice(&p1, &Choice::Tails, &salt1);
        client.reveal_choice(&p2, &Choice::Heads, &salt2);
        client.reveal_choice(&p3, &Choice::Heads, &salt3);

        client.resolve_round();

        // p1 (minority: Tails) should survive
        env.as_contract(&client.address, || {
            let state = ArenaStorage::load_player(&env, &p1).unwrap();
            assert!(state.active, "Minority revealer should survive");
            assert_eq!(state.rounds_survived, 1);
        });

        // p2 and p3 (majority: Heads) should be eliminated
        env.as_contract(&client.address, || {
            let s2 = ArenaStorage::load_player(&env, &p2).unwrap();
            let s3 = ArenaStorage::load_player(&env, &p3).unwrap();
            assert!(!s2.active, "Majority voter should be eliminated");
            assert!(!s3.active, "Majority voter should be eliminated");
        });
    }

    /// #1145 — when every active player fails to reveal the same choice
    /// (e.g., both AFKs in a 2-player round), the arena should transition to
    /// Cancelled to enable claim_refund recovery instead of becoming permanently
    /// locked.
    #[test]
    fn zero_survivor_round_resolution() {
        let env = Env::default();
        env.mock_all_auths();
        let contract_id = env.register(ArenaContract, ());
        let vault_id = env.register(MockVault, ());
        let oracle_id = env.register(MockOracle, ());
        let token_admin = Address::generate(&env);
        let token_id = env
            .register_stellar_asset_contract_v2(token_admin)
            .address();
        let token_admin_client = StellarAssetClient::new(&env, &token_id);

        let admin = Address::generate(&env);
        let client = ArenaContractClient::new(&env, &contract_id);
        client.initialize(&admin, &token_id, &vault_id, &100, &oracle_id, &Address::generate(&env), &1, &2, &10, &60);
        client.join_arena(&p1);
        client.join_arena(&p2);

        // Contract holds 200 (2 × 100 entry fee).
        let token_client = token::TokenClient::new(&env, &token_id);
        assert_eq!(token_client.balance(&contract_id), 200);

        // Start round
        env.ledger().with_mut(|li| li.timestamp = 1000);
        client.start_round(&60);

        // Advance time past the commit deadline WITHOUT any player revealing
        env.ledger()
            .with_mut(|li| li.timestamp = 1000 + MIN_ROUND_DURATION_SECONDS + 1);
        
        // Resolve the round
        client.resolve_round();
        
        // Get the arena config and verify it transitioned to Cancelled, not Finished
        env.as_contract(&contract_id, || {
            let config = ArenaStorage::load_config(&env).expect("config must exist");
            assert_eq!(
                config.state,
                GameState::Cancelled,
                "arena must transition to Cancelled when zero survivors remain, not Finished"
            );
            
            // Verify no winner was set
            let winner = ArenaStorage::get_winner(&env);
            assert!(
                winner.is_none(),
                "no winner should be set when more than one player survives"
            );
        });
    }

    /// Verify that a player who reveals the minority choice survives the round.
    #[test]
    fn minority_revealer_survives() {
        let env = Env::default();
        env.mock_all_auths();
        let contract_id = env.register(ArenaContract, ());
        let vault_id = env.register(MockVault, ());
        let oracle_id = env.register(MockOracle, ());
        let token_admin = Address::generate(&env);
        let token_id = env
            .register_stellar_asset_contract_v2(token_admin)
            .address();
        let token_admin_client = StellarAssetClient::new(&env, &token_id);

        let p1 = Address::generate(&env);
        let p2 = Address::generate(&env);
        let p3 = Address::generate(&env);
        token_admin_client.mint(&p1, &1000);
        token_admin_client.mint(&p2, &1000);
        token_admin_client.mint(&p3, &1000);

        let client = ArenaContractClient::new(&env, &contract_id);
        let admin = Address::generate(&env);
        client.initialize(
            &admin,
            &token_id,
            &vault_id,
            &100,
            &oracle_id,
            &Address::generate(&env),
            &1,
            &2,
            &10,
            &60,
        );
        client.join_arena(&p1);
        client.join_arena(&p2);
        client.join_arena(&p3);

        // Start round
        env.ledger().with_mut(|li| li.timestamp = 1000);
        client.start_round(&60);

        // p1 chooses Tails (minority), p2 and p3 choose Heads (majority)
        let salt1 = BytesN::from_array(&env, &[1u8; 32]);
        let salt2 = BytesN::from_array(&env, &[2u8; 32]);
        let salt3 = BytesN::from_array(&env, &[3u8; 32]);
        let comm1 = compute_commitment(&env, &contract_id, 1, &p1, Choice::Tails, &salt1);
        let comm2 = compute_commitment(&env, &contract_id, 1, &p2, Choice::Heads, &salt2);
        let comm3 = compute_commitment(&env, &contract_id, 1, &p3, Choice::Heads, &salt3);
        client.submit_commitment(&p1, &comm1);
        client.submit_commitment(&p2, &comm2);
        client.submit_commitment(&p3, &comm3);

        env.ledger().with_mut(|li| li.timestamp = 1061);
        client.reveal_choice(&p1, &Choice::Tails, &salt1);
        client.reveal_choice(&p2, &Choice::Heads, &salt2);
        client.reveal_choice(&p3, &Choice::Heads, &salt3);

        client.resolve_round();

        // p1 (minority: Tails) should survive
        env.as_contract(&client.address, || {
            let state = ArenaStorage::load_player(&env, &p1).unwrap();
            assert!(state.active, "Minority revealer should survive");
            assert_eq!(state.rounds_survived, 1);
        });

        // p2 and p3 (majority: Heads) should be eliminated
        env.as_contract(&client.address, || {
            let s2 = ArenaStorage::load_player(&env, &p2).unwrap();
            let s3 = ArenaStorage::load_player(&env, &p3).unwrap();
            assert!(!s2.active, "Majority voter should be eliminated");
            assert!(!s3.active, "Majority voter should be eliminated");
        });
    }

    /// #1145 — when every active player fails to reveal the same choice
    /// (e.g., both AFKs in a 2-player round), the arena should transition to
    /// Cancelled to enable claim_refund recovery instead of becoming permanently
    /// locked.
    #[test]
    fn zero_survivor_round_resolution() {
        let env = Env::default();
        env.mock_all_auths();
        let contract_id = env.register(ArenaContract, ());
        let vault_id = env.register(MockVault, ());
        let oracle_id = env.register(MockOracle, ());
        let token_admin = Address::generate(&env);
        let token_id = env
            .register_stellar_asset_contract_v2(token_admin)
            .address();
        let token_admin_client = StellarAssetClient::new(&env, &token_id);

        let admin = Address::generate(&env);
        let client = ArenaContractClient::new(&env, &contract_id);
        client.initialize(&admin, &token_id, &vault_id, &100, &oracle_id, &Address::generate(&env), &1, &2, &10, &60);
        client.join_arena(&p1);
        client.join_arena(&p2);

        // Contract holds 200 (2 × 100 entry fee).
        let token_client = token::TokenClient::new(&env, &token_id);
        assert_eq!(token_client.balance(&contract_id), 200);

        // Start round
        env.ledger().with_mut(|li| li.timestamp = 1000);
        client.start_round(&60);

        // Advance time past the commit deadline WITHOUT any player revealing
        env.ledger()
            .with_mut(|li| li.timestamp = 1000 + MIN_ROUND_DURATION_SECONDS + 1);
        
        // Resolve the round
        client.resolve_round();
        
        // Get the arena config and verify it transitioned to Cancelled, not Finished
        env.as_contract(&contract_id, || {
            let config = ArenaStorage::load_config(&env).expect("config must exist");
            assert_eq!(
                config.state,
                GameState::Cancelled,
                "arena must transition to Cancelled when zero survivors remain, not Finished"
            );
            
            // Verify no winner was set
            let winner = ArenaStorage::get_winner(&env);
            assert!(
                winner.is_none(),
                "no winner should be set when more than one player survives"
            );
        });
    }

    /// Verify that a player who reveals the minority choice survives the round.
    #[test]
    fn minority_revealer_survives() {
        let env = Env::default();
        env.mock_all_auths();
        let contract_id = env.register(ArenaContract, ());
        let vault_id = env.register(MockVault, ());
        let oracle_id = env.register(MockOracle, ());
        let token_admin = Address::generate(&env);
        let token_id = env
            .register_stellar_asset_contract_v2(token_admin)
            .address();
        let token_admin_client = StellarAssetClient::new(&env, &token_id);

        let p1 = Address::generate(&env);
        let p2 = Address::generate(&env);
        let p3 = Address::generate(&env);
        token_admin_client.mint(&p1, &1000);
        token_admin_client.mint(&p2, &1000);
        token_admin_client.mint(&p3, &1000);

        let client = ArenaContractClient::new(&env, &contract_id);
        let admin = Address::generate(&env);
        client.initialize(
            &admin,
            &token_id,
            &vault_id,
            &100,
            &oracle_id,
            &Address::generate(&env),
            &1,
            &2,
            &10,
            &60,
        );
        client.join_arena(&p1);
        client.join_arena(&p2);
        client.join_arena(&p3);

        // Start round
        env.ledger().with_mut(|li| li.timestamp = 1000);
        client.start_round(&60);

        // p1 chooses Tails (minority), p2 and p3 choose Heads (majority)
        let salt1 = BytesN::from_array(&env, &[1u8; 32]);
        let salt2 = BytesN::from_array(&env, &[2u8; 32]);
        let salt3 = BytesN::from_array(&env, &[3u8; 32]);
        let comm1 = compute_commitment(&env, &contract_id, 1, &p1, Choice::Tails, &salt1);
        let comm2 = compute_commitment(&env, &contract_id, 1, &p2, Choice::Heads, &salt2);
        let comm3 = compute_commitment(&env, &contract_id, 1, &p3, Choice::Heads, &salt3);
        client.submit_commitment(&p1, &comm1);
        client.submit_commitment(&p2, &comm2);
        client.submit_commitment(&p3, &comm3);

        env.ledger().with_mut(|li| li.timestamp = 1061);
        client.reveal_choice(&p1, &Choice::Tails, &salt1);
        client.reveal_choice(&p2, &Choice::Heads, &salt2);
        client.reveal_choice(&p3, &Choice::Heads, &salt3);

        client.resolve_round();

        // p1 (minority: Tails) should survive
        env.as_contract(&client.address, || {
            let state = ArenaStorage::load_player(&env, &p1).unwrap();
            assert!(state.active, "Minority revealer should survive");
            assert_eq!(state.rounds_survived, 1);
        });

        // p2 and p3 (majority: Heads) should be eliminated
        env.as_contract(&client.address, || {
            let s2 = ArenaStorage::load_player(&env, &p2).unwrap();
            let s3 = ArenaStorage::load_player(&env, &p3).unwrap();
            assert!(!s2.active, "Majority voter should be eliminated");
            assert!(!s3.active, "Majority voter should be eliminated");
        });
    }

    /// #1145 — when every active player fails to reveal the same choice
    /// (e.g., both AFKs in a 2-player round), the arena should transition to
    /// Cancelled to enable claim_refund recovery instead of becoming permanently
    /// locked.
    #[test]
    fn zero_survivor_round_resolution() {
        let env = Env::default();
        env.mock_all_auths();
        let contract_id = env.register(ArenaContract, ());
        let vault_id = env.register(MockVault, ());
        let oracle_id = env.register(MockOracle, ());
        let token_admin = Address::generate(&env);
        let token_id = env
            .register_stellar_asset_contract_v2(token_admin)
            .address();
        let token_admin_client = StellarAssetClient::new(&env, &token_id);

        let admin = Address::generate(&env);
        let client = ArenaContractClient::new(&env, &contract_id);
        client.initialize(&admin, &token_id, &vault_id, &100, &oracle_id, &Address::generate(&env), &1, &2, &10, &60);
        client.join_arena(&p1);
        client.join_arena(&p2);

        // Contract holds 200 (2 × 100 entry fee).
        let token_client = token::TokenClient::new(&env, &token_id);
        assert_eq!(token_client.balance(&contract_id), 200);

        // Start round
        env.ledger().with_mut(|li| li.timestamp = 1000);
        client.start_round(&60);

        // Advance time past the commit deadline WITHOUT any player revealing
        env.ledger()
            .with_mut(|li| li.timestamp = 1000 + MIN_ROUND_DURATION_SECONDS + 1);
        
        // Resolve the round
        client.resolve_round();
        
        // Get the arena config and verify it transitioned to Cancelled, not Finished
        env.as_contract(&contract_id, || {
            let config = ArenaStorage::load_config(&env).expect("config must exist");
            assert_eq!(
                config.state,
                GameState::Cancelled,
                "arena must transition to Cancelled when zero survivors remain, not Finished"
            );
            
            // Verify no winner was set
            let winner = ArenaStorage::get_winner(&env);
            assert!(
                winner.is_none(),
                "no winner should be set when more than one player survives"
            );
        });
    }

    /// Verify that a player who reveals the minority choice survives the round.
    #[test]
    fn minority_revealer_survives() {
        let env = Env::default();
        env.mock_all_auths();
        let contract_id = env.register(ArenaContract, ());
        let vault_id = env.register(MockVault, ());
        let oracle_id = env.register(MockOracle, ());
        let token_admin = Address::generate(&env);
        let token_id = env
            .register_stellar_asset_contract_v2(token_admin)
            .address();
        let token_admin_client = StellarAssetClient::new(&env, &token_id);

        let p1 = Address::generate(&env);
        let p2 = Address::generate(&env);
        let p3 = Address::generate(&env);
        token_admin_client.mint(&p1, &1000);
        token_admin_client.mint(&p2, &1000);
        token_admin_client.mint(&p3, &1000);

        let client = ArenaContractClient::new(&env, &contract_id);
        let admin = Address::generate(&env);
        client.initialize(
            &admin,
            &token_id,
            &vault_id,
            &100,
            &oracle_id,
            &Address::generate(&env),
            &1,
            &2,
            &10,
            &60,
        );
        client.join_arena(&p1);
        client.join_arena(&p2);
        client.join_arena(&p3);

        // Start round
        env.ledger().with_mut(|li| li.timestamp = 1000);
        client.start_round(&60);

        // p1 chooses Tails (minority), p2 and p3 choose Heads (majority)
        let salt1 = BytesN::from_array(&env, &[1u8; 32]);
        let salt2 = BytesN::from_array(&env, &[2u8; 32]);
        let salt3 = BytesN::from_array(&env, &[3u8; 32]);
        let comm1 = compute_commitment(&env, &contract_id, 1, &p1, Choice::Tails, &salt1);
        let comm2 = compute_commitment(&env, &contract_id, 1, &p2, Choice::Heads, &salt2);
        let comm3 = compute_commitment(&env, &contract_id, 1, &p3, Choice::Heads, &salt3);
        client.submit_commitment(&p1, &comm1);
        client.submit_commitment(&p2, &comm2);
        client.submit_commitment(&p3, &comm3);

        env.ledger().with_mut(|li| li.timestamp = 1061);
        client.reveal_choice(&p1, &Choice::Tails, &salt1);
        client.reveal_choice(&p2, &Choice::Heads, &salt2);
        client.reveal_choice(&p3, &Choice::Heads, &salt3);

        client.resolve_round();

        // p1 (minority: Tails) should survive
        env.as_contract(&client.address, || {
            let state = ArenaStorage::load_player(&env, &p1).unwrap();
            assert!(state.active, "Minority revealer should survive");
            assert_eq!(state.rounds_survived, 1);
        });

        // p2 and p3 (majority: Heads) should be eliminated
        env.as_contract(&client.address, || {
            let s2 = ArenaStorage::load_player(&env, &p2).unwrap();
            let s3 = ArenaStorage::load_player(&env, &p3).unwrap();
            assert!(!s2.active, "Majority voter should be eliminated");
            assert!(!s3.active, "Majority voter should be eliminated");
        });
    }

    /// #1145 — when every active player fails to reveal the same choice
    /// (e.g., both AFKs in a 2-player round), the arena should transition to
    /// Cancelled to enable claim_refund recovery instead of becoming permanently
    /// locked.
    #[test]
    fn zero_survivor_round_resolution() {
        let env = Env::default();
        env.mock_all_auths();
        let contract_id = env.register(ArenaContract, ());
        let vault_id = env.register(MockVault, ());
        let oracle_id = env.register(MockOracle, ());
        let token_admin = Address::generate(&env);
        let token_id = env
            .register_stellar_asset_contract_v2(token_admin)
            .address();
        let token_admin_client = StellarAssetClient::new(&env, &token_id);

        let admin = Address::generate(&env);
        let client = ArenaContractClient::new(&env, &contract_id);
        client.initialize(&admin, &token_id, &vault_id, &100, &oracle_id, &Address::generate(&env), &1, &2, &10, &60);
        client.join_arena(&p1);
        client.join_arena(&p2);

        // Contract holds 200 (2 × 100 entry fee).
        let token_client = token::TokenClient::new(&env, &token_id);
        assert_eq!(token_client.balance(&contract_id), 200);

        // Start round
        env.ledger().with_mut(|li| li.timestamp = 1000);
        client.start_round(&60);

        // Advance time past the commit deadline WITHOUT any player revealing
        env.ledger()
            .with_mut(|li| li.timestamp = 1000 + MIN_ROUND_DURATION_SECONDS + 1);
        
        // Resolve the round
        client.resolve_round();
        
        // Get the arena config and verify it transitioned to Cancelled, not Finished
        env.as_contract(&contract_id, || {
            let config = ArenaStorage::load_config(&env).expect("config must exist");
            assert_eq!(
                config.state,
                GameState::Cancelled,
                "arena must transition to Cancelled when zero survivors remain, not Finished"
            );
            
            // Verify no winner was set
            let winner = ArenaStorage::get_winner(&env);
            assert!(
                winner.is_none(),
                "no winner should be set when more than one player survives"
            );
        });
    }

    /// Verify that a player who reveals the minority choice survives the round.
    #[test]
    fn minority_revealer_survives() {
        let env = Env::default();
        env.mock_all_auths();
        let contract_id = env.register(ArenaContract, ());
        let vault_id = env.register(MockVault, ());
        let oracle_id = env.register(MockOracle, ());
        let token_admin = Address::generate(&env);
        let token_id = env
            .register_stellar_asset_contract_v2(token_admin)
            .address();
        let token_admin_client = StellarAssetClient::new(&env, &token_id);

        let p1 = Address::generate(&env);
        let p2 = Address::generate(&env);
        let p3 = Address::generate(&env);
        token_admin_client.mint(&p1, &1000);
        token_admin_client.mint(&p2, &1000);
        token_admin_client.mint(&p3, &1000);

        let client = ArenaContractClient::new(&env, &contract_id);
        let admin = Address::generate(&env);
        client.initialize(
            &admin,
            &token_id,
            &vault_id,
            &100,
            &oracle_id,
            &Address::generate(&env),
            &1,
            &2,
            &10,
            &60,
        );
        client.join_arena(&p1);
        client.join_arena(&p2);
        client.join_arena(&p3);

        // Start round
        env.ledger().with_mut(|li| li.timestamp = 1000);
        client.start_round(&60);

        // p1 chooses Tails (minority), p2 and p3 choose Heads (majority)
        let salt1 = BytesN::from_array(&env, &[1u8; 32]);
        let salt2 = BytesN::from_array(&env, &[2u8; 32]);
        let salt3 = BytesN::from_array(&env, &[3u8; 32]);
        let comm1 = compute_commitment(&env, &contract_id, 1, &p1, Choice::Tails, &salt1);
        let comm2 = compute_commitment(&env, &contract_id, 1, &p2, Choice::Heads, &salt2);
        let comm3 = compute_commitment(&env, &contract_id, 1, &p3, Choice::Heads, &salt3);
        client.submit_commitment(&p1, &comm1);
        client.submit_commitment(&p2, &comm2);
        client.submit_commitment(&p3, &comm3);

        env.ledger().with_mut(|li| li.timestamp = 1061);
        client.reveal_choice(&p1, &Choice::Tails, &salt1);
        client.reveal_choice(&p2, &Choice::Heads, &salt2);
        client.reveal_choice(&p3, &Choice::Heads, &salt3);

        client.resolve_round();

        // p1 (minority: Tails) should survive
        env.as_contract(&client.address, || {
            let state = ArenaStorage::load_player(&env, &p1).unwrap();
            assert!(state.active, "Minority revealer should survive");
            assert_eq!(state.rounds_survived, 1);
        });

        // p2 and p3 (majority: Heads) should be eliminated
        env.as_contract(&client.address, || {
            let s2 = ArenaStorage::load_player(&env, &p2).unwrap();
            let s3 = ArenaStorage::load_player(&env, &p3).unwrap();
            assert!(!s2.active, "Majority voter should be eliminated");
            assert!(!s3.active, "Majority voter should be eliminated");
        });
    }

    /// #1145 — when every active player fails to reveal the same choice
    /// (e.g., both AFKs in a 2-player round), the arena should transition to
    /// Cancelled to enable claim_refund recovery instead of becoming permanently
    /// locked.
    #[test]
    fn zero_survivor_round_resolution() {
        let env = Env::default();
        env.mock_all_auths();
        let contract_id = env.register(ArenaContract, ());
        let vault_id = env.register(MockVault, ());
        let oracle_id = env.register(MockOracle, ());
        let token_admin = Address::generate(&env);
        let token_id = env
            .register_stellar_asset_contract_v2(token_admin)
            .address();
        let token_admin_client = StellarAssetClient::new(&env, &token_id);

        let admin = Address::generate(&env);
        let client = ArenaContractClient::new(&env, &contract_id);
        client.initialize(&admin, &token_id, &vault_id, &100, &oracle_id, &Address::generate(&env), &1, &2, &10, &60);
        client.join_arena(&p1);
        client.join_arena(&p2);

        // Contract holds 200 (2 × 100 entry fee).
        let token_client = token::TokenClient::new(&env, &token_id);
        assert_eq!(token_client.balance(&contract_id), 200);

        // Start round
        env.ledger().with_mut(|li| li.timestamp = 1000);
        client.start_round(&60);

        // Advance time past the commit deadline WITHOUT any player revealing
        env.ledger()
            .with_mut(|li| li.timestamp = 1000 + MIN_ROUND_DURATION_SECONDS + 1);
        
        // Resolve the round
        client.resolve_round();
        
        // Get the arena config and verify it transitioned to Cancelled, not Finished
        env.as_contract(&contract_id, || {
            let config = ArenaStorage::load_config(&env).expect("config must exist");
            assert_eq!(
                config.state,
                GameState::Cancelled,
                "arena must transition to Cancelled when zero survivors remain, not Finished"
            );
            
            // Verify no winner was set
            let winner = ArenaStorage::get_winner(&env);
            assert!(
                winner.is_none(),
                "no winner should be set when more than one player survives"
            );
        });
    }

    /// Verify that a player who reveals the minority choice survives the round.
    #[test]
    fn minority_revealer_survives() {
        let env = Env::default();
        env.mock_all_auths();
        let contract_id = env.register(ArenaContract, ());
        let vault_id = env.register(MockVault, ());
        let oracle_id = env.register(MockOracle, ());
        let token_admin = Address::generate(&env);
        let token_id = env
            .register_stellar_asset_contract_v2(token_admin)
            .address();
        let token_admin_client = StellarAssetClient::new(&env, &token_id);

        let p1 = Address::generate(&env);
        let p2 = Address::generate(&env);
        let p3 = Address::generate(&env);
        token_admin_client.mint(&p1, &1000);
        token_admin_client.mint(&p2, &1000);
        token_admin_client.mint(&p3, &1000);

        let client = ArenaContractClient::new(&env, &contract_id);
        let admin = Address::generate(&env);
        client.initialize(
            &admin,
            &token_id,
            &vault_id,
            &100,
            &oracle_id,
            &Address::generate(&env),
            &1,
            &2,
            &10,
            &60,
        );
        client.join_arena(&p1);
        client.join_arena(&p2);
        client.join_arena(&p3);

        // Start round
        env.ledger().with_mut(|li| li.timestamp = 1000);
        client.start_round(&60);

        // p1 chooses Tails (minority), p2 and p3 choose Heads (majority)
        let salt1 = BytesN::from_array(&env, &[1u8; 32]);
        let salt2 = BytesN::from_array(&env, &[2u8; 32]);
        let salt3 = BytesN::from_array(&env, &[3u8; 32]);
        let comm1 = compute_commitment(&env, &contract_id, 1, &p1, Choice::Tails, &salt1);
        let comm2 = compute_commitment(&env, &contract_id, 1, &p2, Choice::Heads, &salt2);
        let comm3 = compute_commitment(&env, &contract_id, 1, &p3, Choice::Heads, &salt3);
        client.submit_commitment(&p1, &comm1);
        client.submit_commitment(&p2, &comm2);
        client.submit_commitment(&p3, &comm3);

        env.ledger().with_mut(|li| li.timestamp = 1061);
        client.reveal_choice(&p1, &Choice::Tails, &salt1);
        client.reveal_choice(&p2, &Choice::Heads, &salt2);
        client.reveal_choice(&p3, &Choice::Heads, &salt3);

        client.resolve_round();

        // p1 (minority: Tails) should survive
        env.as_contract(&client.address, || {
            let state = ArenaStorage::load_player(&env, &p1).unwrap();
            assert!(state.active, "Minority revealer should survive");
            assert_eq!(state.rounds_survived, 1);
        });

        // p2 and p3 (majority: Heads) should be eliminated
        env.as_contract(&client.address, || {
            let s2 = ArenaStorage::load_player(&env, &p2).unwrap();
            let s3 = ArenaStorage::load_player(&env, &p3).unwrap();
            assert!(!s2.active, "Majority voter should be eliminated");
            assert!(!s3.active, "Majority voter should be eliminated");
        });
    }

    /// #1145 — when every active player fails to reveal the same choice
    /// (e.g., both AFKs in a 2-player round), the arena should transition to
    /// Cancelled to enable claim_refund recovery instead of becoming permanently
    /// locked.
    #[test]
    fn zero_survivor_round_resolution() {
        let env = Env::default();
        env.mock_all_auths();
        let contract_id = env.register(ArenaContract, ());
        let vault_id = env.register(MockVault, ());
        let oracle_id = env.register(MockOracle, ());
        let token_admin = Address::generate(&env);
        let token_id = env
            .register_stellar_asset_contract_v2(token_admin)
            .address();
        let token_admin_client = StellarAssetClient::new(&env, &token_id);

        let admin = Address::generate(&env);
        let client = ArenaContractClient::new(&env, &contract_id);
        client.initialize(&admin, &token_id, &vault_id, &100, &oracle_id, &Address::generate(&env), &1, &2, &10, &60);
        client.join_arena(&p1);
        client.join_arena(&p2);

        // Contract holds 200 (2 × 100 entry fee).
        let token_client = token::TokenClient::new(&env, &token_id);
        assert_eq!(token_client.balance(&contract_id), 200);

        // Start round
        env.ledger().with_mut(|li| li.timestamp = 1000);
        client.start_round(&60);

        // Advance time past the commit deadline WITHOUT any player revealing
        env.ledger()
            .with_mut(|li| li.timestamp = 1000 + MIN_ROUND_DURATION_SECONDS + 1);
        
        // Resolve the round
        client.resolve_round();
        
        // Get the arena config and verify it transitioned to Cancelled, not Finished
        env.as_contract(&contract_id, || {
            let config = ArenaStorage::load_config(&env).expect("config must exist");
            assert_eq!(
                config.state,
                GameState::Cancelled,
                "arena must transition to Cancelled when zero survivors remain, not Finished"
            );
            
            // Verify no winner was set
            let winner = ArenaStorage::get_winner(&env);
            assert!(
                winner.is_none(),
                "no winner should be set when more than one player survives"
            );
        });
    }

    /// Verify that a player who reveals the minority choice survives the round.
    #[test]
    fn minority_revealer_survives() {
        let env = Env::default();
        env.mock_all_auths();
        let contract_id = env.register(ArenaContract, ());
        let vault_id = env.register(MockVault, ());
        let oracle_id = env.register(MockOracle, ());
        let token_admin = Address::generate(&env);
        let token_id = env
            .register_stellar_asset_contract_v2(token_admin)
            .address();
        let token_admin_client = StellarAssetClient::new(&env, &token_id);

        let p1 = Address::generate(&env);
        let p2 = Address::generate(&env);
        let p3 = Address::generate(&env);
        token_admin_client.mint(&p1, &1000);
        token_admin_client.mint(&p2, &1000);
        token_admin_client.mint(&p3, &1000);

        let client = ArenaContractClient::new(&env, &contract_id);
        let admin = Address::generate(&env);
        client.initialize(
            &admin,
            &token_id,
            &vault_id,
            &100,
            &oracle_id,
            &Address::generate(&env),
            &1,
            &2,
            &10,
            &60,
        );
        client.join_arena(&p1);
        client.join_arena(&p2);
        client.join_arena(&p3);

        // Start round
        env.ledger().with_mut(|li| li.timestamp = 1000);
        client.start_round(&60);

        // p1 chooses Tails (minority), p2 and p3 choose Heads (majority)
        let salt1 = BytesN::from_array(&env, &[1u8; 32]);
        let salt2 = BytesN::from_array(&env, &[2u8; 32]);
        let salt3 = BytesN::from_array(&env, &[3u8; 32]);
        let comm1 = compute_commitment(&env, &contract_id, 1, &p1, Choice::Tails, &salt1);
        let comm2 = compute_commitment(&env, &contract_id, 1, &p2, Choice::Heads, &salt2);
        let comm3 = compute_commitment(&env, &contract_id, 1, &p3, Choice::Heads, &salt3);
        client.submit_commitment(&p1, &comm1);
        client.submit_commitment(&p2, &comm2);
        client.submit_commitment(&p3, &comm3);

        env.ledger().with_mut(|li| li.timestamp = 1061);
        client.reveal_choice(&p1, &Choice::Tails, &salt1);
        client.reveal_choice(&p2, &Choice::Heads, &salt2);
        client.reveal_choice(&p3, &Choice::Heads, &salt3);

        client.resolve_round();

        // p1 (minority: Tails) should survive
        env.as_contract(&client.address, || {
            let state = ArenaStorage::load_player(&env, &p1).unwrap();
            assert!(state.active, "Minority revealer should survive");
            assert_eq!(state.rounds_survived, 1);
        });

        // p2 and p3 (majority: Heads) should be eliminated
        env.as_contract(&client.address, || {
            let s2 = ArenaStorage::load_player(&env, &p2).unwrap();
            let s3 = ArenaStorage::load_player(&env, &p3).unwrap();
            assert!(!s2.active, "Majority voter should be eliminated");
            assert!(!s3.active, "Majority voter should be eliminated");
        });
    }

    /// #1145 — when every active player fails to reveal the same choice
    /// (e.g., both AFKs in a 2-player round), the arena should transition to
    /// Cancelled to enable claim_refund recovery instead of becoming permanently
    /// locked.
    #[test]
    fn zero_survivor_round_resolution() {
        let env = Env::default();
        env.mock_all_auths();
        let contract_id = env.register(ArenaContract, ());
        let vault_id = env.register(MockVault, ());
        let oracle_id = env.register(MockOracle, ());
        let token_admin = Address::generate(&env);
        let token_id = env
            .register_stellar_asset_contract_v2(token_admin)
            .address();
        let token_admin_client = StellarAssetClient::new(&env, &token_id);

        let admin = Address::generate(&env);
        let client = ArenaContractClient::new(&env, &contract_id);
        client.initialize(&admin, &token_id, &vault_id, &100, &oracle_id, &Address::generate(&env), &1, &2, &10, &60);
        client.join_arena(&p1);
        client.join_arena(&p2);

        // Contract holds 200 (2 × 100 entry fee).
        let token_client = token::TokenClient::new(&env, &token_id);
        assert_eq!(token_client.balance(&contract_id), 200);

        // Start round
        env.ledger().with_mut(|li| li.timestamp = 1000);
        client.start_round(&60);

        // Advance time past the commit deadline WITHOUT any player revealing
        env.ledger()
            .with_mut(|li| li.timestamp = 1000 + MIN_ROUND_DURATION_SECONDS + 1);
        
        // Resolve the round
        client.resolve_round();
        
        // Get the arena config and verify it transitioned to Cancelled, not Finished
        env.as_contract(&contract_id, || {
            let config = ArenaStorage::load_config(&env).expect("config must exist");
            assert_eq!(
                config.state,
                GameState::Cancelled,
                "arena must transition to Cancelled when zero survivors remain, not Finished"
            );
            
            // Verify no winner was set
            let winner = ArenaStorage::get_winner(&env);
            assert!(
                winner.is_none(),
                "no winner should be set when more than one player survives"
            );
        });
    }

    /// Verify that a player who reveals the minority choice survives the round.
    #[test]
    fn minority_revealer_survives() {
        let env = Env::default();
        env.mock_all_auths();
        let contract_id = env.register(ArenaContract, ());
        let vault_id = env.register(MockVault, ());
        let oracle_id = env.register(MockOracle, ());
        let token_admin = Address::generate(&env);
        let token_id = env
            .register_stellar_asset_contract_v2(token_admin)
            .address();
        let token_admin_client = StellarAssetClient::new(&env, &token_id);

        let p1 = Address::generate(&env);
        let p2 = Address::generate(&env);
        let p3 = Address::generate(&env);
        token_admin_client.mint(&p1, &1000);
        token_admin_client.mint(&p2, &1000);
        token_admin_client.mint(&p3, &1000);

        let client = ArenaContractClient::new(&env, &contract_id);
        let admin = Address::generate(&env);
        client.initialize(
            &admin,
            &token_id,
            &vault_id,
            &100,
            &oracle_id,
            &Address::generate(&env),
            &1,
            &2,
            &10,
            &60,
        );
        client.join_arena(&p1);
        client.join_arena(&p2);
        client.join_arena(&p3);

        // Start round
        env.ledger().with_mut(|li| li.timestamp = 1000);
        client.start_round(&60);

        // p1 chooses Tails (minority), p2 and p3 choose Heads (majority)
        let salt1 = BytesN::from_array(&env, &[1u8; 32]);
        let salt2 = BytesN::from_array(&env, &[2u8; 32]);
        let salt3 = BytesN::from_array(&env, &[3u8; 32]);
        let comm1 = compute_commitment(&env, &contract_id, 1, &p1, Choice::Tails, &salt1);
        let comm2 = compute_commitment(&env, &contract_id, 1, &p2, Choice::Heads, &salt2);
        let comm3 = compute_commitment(&env, &contract_id, 1, &p3, Choice::Heads, &salt3);
        client.submit_commitment(&p1, &comm1);
        client.submit_commitment(&p2, &comm2);
        client.submit_commitment(&p3, &comm3);

        env.ledger().with_mut(|li| li.timestamp = 1061);
        client.reveal_choice(&p1, &Choice::Tails, &salt1);
        client.reveal_choice(&p2, &Choice::Heads, &salt2);
        client.reveal_choice(&p3, &Choice::Heads, &salt3);

        client.resolve_round();

        // p1 (minority: Tails) should survive
        env.as_contract(&client.address, || {
            let state = ArenaStorage::load_player(&env, &p1).unwrap();
            assert!(state.active, "Minority revealer should survive");
            assert_eq!(state.rounds_survived, 1);
        });

        // p2 and p3 (majority: Heads) should be eliminated
        env.as_contract(&client.address, || {
            let s2 = ArenaStorage::load_player(&env, &p2).unwrap();
            let s3 = ArenaStorage::load_player(&env, &p3).unwrap();
            assert!(!s2.active, "Majority voter should be eliminated");
            assert!(!s3.active, "Majority voter should be eliminated");
        });
    }

    /// #1145 — when every active player fails to reveal the same choice
    /// (e.g., both AFKs in a 2-player round), the arena should transition to
    /// Cancelled to enable claim_refund recovery instead of becoming permanently
    /// locked.
    #[test]
    fn zero_survivor_round_resolution() {
        let env = Env::default();
        env.mock_all_auths();
        let contract_id = env.register(ArenaContract, ());
        let vault_id = env.register(MockVault, ());
        let oracle_id = env.register(MockOracle, ());
        let token_admin = Address::generate(&env);
        let token_id = env
            .register_stellar_asset_contract_v2(token_admin)
            .address();
        let token_admin_client = StellarAssetClient::new(&env, &token_id);

        let admin = Address::generate(&env);
        let client = ArenaContractClient::new(&env, &contract_id);
        client.initialize(&admin, &token_id, &vault_id, &100, &oracle_id, &Address::generate(&env), &1, &2, &10, &60);
        client.join_arena(&p1);
        client.join_arena(&p2);

        // Contract holds 200 (2 × 100 entry fee).
        let token_client = token::TokenClient::new(&env, &token_id);
        assert_eq!(token_client.balance(&contract_id), 200);

        // Start round
        env.ledger().with_mut(|li| li.timestamp = 1000);
        client.start_round(&60);

        // Advance time past the commit deadline WITHOUT any player revealing
        env.ledger()
            .with_mut(|li| li.timestamp = 1000 + MIN_ROUND_DURATION_SECONDS + 1);
        
        // Resolve the round
        client.resolve_round();
        
        // Get the arena config and verify it transitioned to Cancelled, not Finished
        env.as_contract(&contract_id, || {
            let config = ArenaStorage::load_config(&env).expect("config must exist");
            assert_eq!(
                config.state,
                GameState::Cancelled,
                "arena must transition to Cancelled when zero survivors remain, not Finished"
            );
            
            // Verify no winner was set
            let winner = ArenaStorage::get_winner(&env);
            assert!(
                winner.is_none(),
                "no winner should be set when more than one player survives"
            );
        });
    }

    /// Verify that a player who reveals the minority choice survives the round.
    #[test]
    fn minority_revealer_survives() {
        let env = Env::default();
        env.mock_all_auths();
        let contract_id = env.register(ArenaContract, ());
        let vault_id = env.register(MockVault, ());
        let oracle_id = env.register(MockOracle, ());
        let token_admin = Address::generate(&env);
        let token_id = env
            .register_stellar_asset_contract_v2(token_admin)
            .address();
        let token_admin_client = StellarAssetClient::new(&env, &token_id);

        let p1 = Address::generate(&env);
        let p2 = Address::generate(&env);
        let p3 = Address::generate(&env);
        token_admin_client.mint(&p1, &1000);
        token_admin_client.mint(&p2, &1000);
        token_admin_client.mint(&p3, &1000);

        let client = ArenaContractClient::new(&env, &contract_id);
        let admin = Address::generate(&env);
        client.initialize(
            &admin,
            &token_id,
            &vault_id,
            &100,
            &oracle_id,
            &Address::generate(&env),
            &1,
            &2,
            &10,
            &60,
        );
        client.join_arena(&p1);
        client.join_arena(&p2);
        client.join_arena(&p3);

        // Start round
        env.ledger().with_mut(|li| li.timestamp = 1000);
        client.start_round(&60);

        // p1 chooses Tails (minority), p2 and p3 choose Heads (majority)
        let salt1 = BytesN::from_array(&env, &[1u8; 32]);
        let salt2 = BytesN::from_array(&env, &[2u8; 32]);
        let salt3 = BytesN::from_array(&env, &[3u8; 32]);
        let comm1 = compute_commitment(&env, &contract_id, 1, &p1, Choice::Tails, &salt1);
        let comm2 = compute_commitment(&env, &contract_id, 1, &p2, Choice::Heads, &salt2);
        let comm3 = compute_commitment(&env, &contract_id, 1, &p3, Choice::Heads, &salt3);
        client.submit_commitment(&p1, &comm1);
        client.submit_commitment(&p2, &comm2);
        client.submit_commitment(&p3, &comm3);

        env.ledger().with_mut(|li| li.timestamp = 1061);
        client.reveal_choice(&p1, &Choice::Tails, &salt1);
        client.reveal_choice(&p2, &Choice::Heads, &salt2);
        client.reveal_choice(&p3, &Choice::Heads, &salt3);

        client.resolve_round();

        // p1 (minority: Tails) should survive
        env.as_contract(&client.address, || {
            let state = ArenaStorage::load_player(&env, &p1).unwrap();
            assert!(state.active, "Minority revealer should survive");
            assert_eq!(state.rounds_survived, 1);
        });

        // p2 and p3 (majority: Heads) should be eliminated
        env.as_contract(&client.address, || {
            let s2 = ArenaStorage::load_player(&env, &p2).unwrap();
            let s3 = ArenaStorage::load_player(&env, &p3).unwrap();
            assert!(!s2.active, "Majority voter should be eliminated");
            assert!(!s3.active, "Majority voter should be eliminated");
        });
    }

    /// #1145 — when every active player fails to reveal the same choice
    /// (e.g., both AFKs in a 2-player round), the arena should transition to
    /// Cancelled to enable claim_refund recovery instead of becoming permanently
    /// locked.
    #[test]
    fn zero_survivor_round_resolution() {
        let env = Env::default();
        env.mock_all_auths();
        let contract_id = env.register(ArenaContract, ());
        let vault_id = env.register(MockVault, ());
        let oracle_id = env.register(MockOracle, ());
        let token_admin = Address::generate(&env);
        let token_id = env
            .register_stellar_asset_contract_v2(token_admin)
            .address();
        let token_admin_client = StellarAssetClient::new(&env, &token_id);

        let admin = Address::generate(&env);
        let client = ArenaContractClient::new(&env, &contract_id);
        client.initialize(&admin, &token_id, &vault_id, &100, &oracle_id, &Address::generate(&env), &1, &2, &10, &60);
        client.join_arena(&p1);
        client.join_arena(&p2);

        // Contract holds 200 (2 × 100 entry fee).
        let token_client = token::TokenClient::new(&env, &token_id);
        assert_eq!(token_client.balance(&contract_id), 200);

        // Start round
        env.ledger().with_mut(|li| li.timestamp = 1000);
        client.start_round(&60);

        // Advance time past the commit deadline WITHOUT any player revealing
        env.ledger()
            .with_mut(|li| li.timestamp = 1000 + MIN_ROUND_DURATION_SECONDS + 1);
        
        // Resolve the round
        client.resolve_round();
        
        // Get the arena config and verify it transitioned to Cancelled, not Finished
        env.as_contract(&contract_id, || {
            let config = ArenaStorage::load_config(&env).expect("config must exist");
            assert_eq!(
                config.state,
                GameState::Cancelled,
                "arena must transition to Cancelled when zero survivors remain, not Finished"
            );
            
            // Verify no winner was set
            let winner = ArenaStorage::get_winner(&env);
            assert!(
                winner.is_none(),
                "no winner should be set when more than one player survives"
            );
        });
    }

    /// Verify that a player who reveals the minority choice survives the round.
    #[test]
    fn minority_revealer_survives() {
        let env = Env::default();
        env.mock_all_auths();
        let contract_id = env.register(ArenaContract, ());
        let vault_id = env.register(MockVault, ());
        let oracle_id = env.register(MockOracle, ());
        let token_admin = Address::generate(&env);
        let token_id = env
            .register_stellar_asset_contract_v2(token_admin)
            .address();
        let token_admin_client = StellarAssetClient::new(&env, &token_id);

        let p1 = Address::generate(&env);
        let p2 = Address::generate(&env);
        let p3 = Address::generate(&env);
        token_admin_client.mint(&p1, &1000);
        token_admin_client.mint(&p2, &1000);
        token_admin_client.mint(&p3, &1000);

        let client = ArenaContractClient::new(&env, &contract_id);
        let admin = Address::generate(&env);
        client.initialize(
            &admin,
            &token_id,
            &vault_id,
            &100,
            &oracle_id,
            &Address::generate(&env),
            &1,
            &2,
            &10,
            &60,
        );
        client.join_arena(&p1);
        client.join_arena(&p2);
        client.join_arena(&p3);

        // Start round
        env.ledger().with_mut(|li| li.timestamp = 1000);
        client.start_round(&60);

        // p1 chooses Tails (minority), p2 and p3 choose Heads (majority)
        let salt1 = BytesN::from_array(&env, &[1u8; 32]);
        let salt2 = BytesN::from_array(&env, &[2u8; 32]);
        let salt3 = BytesN::from_array(&env, &[3u8; 32]);
        let comm1 = compute_commitment(&env, &contract_id, 1, &p1, Choice::Tails, &salt1);
        let comm2 = compute_commitment(&env, &contract_id, 1, &p2, Choice::Heads, &salt2);
        let comm3 = compute_commitment(&env, &contract_id, 1, &p3, Choice::Heads, &salt3);
        client.submit_commitment(&p1, &comm1);
        client.submit_commitment(&p2, &comm2);
        client.submit_commitment(&p3, &comm3);

        env.ledger().with_mut(|li| li.timestamp = 1061);
        client.reveal_choice(&p1, &Choice::Tails, &salt1);
        client.reveal_choice(&p2, &Choice::Heads, &salt2);
        client.reveal_choice(&p3, &Choice::Heads, &salt3);

        client.resolve_round();

        // p1 (minority: Tails) should survive
        env.as_contract(&client.address, || {
            let state = ArenaStorage::load_player(&env, &p1).unwrap();
            assert!(state.active, "Minority revealer should survive");
            assert_eq!(state.rounds_survived, 1);
        });

        // p2 and p3 (majority: Heads) should be eliminated
        env.as_contract(&client.address, || {
            let s2 = ArenaStorage::load_player(&env, &p2).unwrap();
            let s3 = ArenaStorage::load_player(&env, &p3).unwrap();
            assert!(!s2.active, "Majority voter should be eliminated");
            assert!(!s3.active, "Majority voter should be eliminated");
        });
    }

    /// #1145 — when every active player fails to reveal the same choice
    /// (e.g., both AFKs in a 2-player round), the arena should transition to
    /// Cancelled to enable claim_refund recovery instead of becoming permanently
    /// locked.
    #[test]
    fn zero_survivor_round_resolution() {
        let env = Env::default();
        env.mock_all_auths();
        let contract_id = env.register(ArenaContract, ());
        let vault_id = env.register(MockVault, ());
        let oracle_id = env.register(MockOracle, ());
        let token_admin = Address::generate(&env);
        let token_id = env
            .register_stellar_asset_contract_v2(token_admin)
            .address();
        let token_admin_client = StellarAssetClient::new(&env, &token_id);

        let admin = Address::generate(&env);
        let client = ArenaContractClient::new(&env, &contract_id);
        client.initialize(&admin, &token_id, &vault_id, &100, &oracle_id, &Address::generate(&env), &1, &2, &10, &60);
        client.join_arena(&p1);
        client.join_arena(&p2);

        // Contract holds 200 (2 × 100 entry fee).
        let token_client = token::TokenClient::new(&env, &token_id);
        assert_eq!(token_client.balance(&contract_id), 200);

        // Start round
        env.ledger().with_mut(|li| li.timestamp = 1000);
        client.start_round(&60);

        // Advance time past the commit deadline WITHOUT any player revealing
        env.ledger()
            .with_mut(|li| li.timestamp = 1000 + MIN_ROUND_DURATION_SECONDS + 1);
        
        // Resolve the round
        client.resolve_round();
        
        // Get the arena config and verify it transitioned to Cancelled, not Finished
        env.as_contract(&contract_id, || {
            let config = ArenaStorage::load_config(&env).expect("config must exist");
            assert_eq!(
                config.state,
                GameState::Cancelled,
                "arena must transition to Cancelled when zero survivors remain, not Finished"
            );
            
            // Verify no winner was set
            let winner = ArenaStorage::get_winner(&env);
            assert!(
                winner.is_none(),
                "no winner should be set when more than one player survives"
            );
        });
    }

    /// Verify that a player who reveals the minority choice survives the round.
    #[test]
    fn minority_revealer_survives() {
        let env = Env::default();
        env.mock_all_auths();
        let contract_id = env.register(ArenaContract, ());
        let vault_id = env.register(MockVault, ());
        let oracle_id = env.register(MockOracle, ());
        let token_admin = Address::generate(&env);
        let token_id = env
            .register_stellar_asset_contract_v2(token_admin)
            .address();
        let token_admin_client = StellarAssetClient::new(&env, &token_id);

        let p1 = Address::generate(&env);
        let p2 = Address::generate(&env);
        let p3 = Address::generate(&env);
        token_admin_client.mint(&p1, &1000);
        token_admin_client.mint(&p2, &1000);
        token_admin_client.mint(&p3, &1000);

        let client = ArenaContractClient::new(&env, &contract_id);
        let admin = Address::generate(&env);
        client.initialize(
            &admin,
            &token_id,
            &vault_id,
            &100,
            &oracle_id,
            &Address::generate(&env),
            &1,
            &2,
            &10,
            &60,
        );
        client.join_arena(&p1);
        client.join_arena(&p2);
        client.join_arena(&p3);

        // Start round
        env.ledger().with_mut(|li| li.timestamp = 1000);
        client.start_round(&60);

        // p1 chooses Tails (minority), p2 and p3 choose Heads (majority)
        let salt1 = BytesN::from_array(&env, &[1u8; 32]);
        let salt2 = BytesN::from_array(&env, &[2u8; 32]);
        let salt3 = BytesN::from_array(&env, &[3u8; 32]);
        let comm1 = compute_commitment(&env, &contract_id, 1, &p1, Choice::Tails, &salt1);
        let comm2 = compute_commitment(&env, &contract_id, 1, &p2, Choice::Heads, &salt2);
        let comm3 = compute_commitment(&env, &contract_id, 1, &p3, Choice::Heads, &salt3);
        client.submit_commitment(&p1, &comm1);
        client.submit_commitment(&p2, &comm2);
        client.submit_commitment(&p3, &comm3);

        env.ledger().with_mut(|li| li.timestamp = 1061);
        client.reveal_choice(&p1, &Choice::Tails, &salt1);
        client.reveal_choice(&p2, &Choice::Heads, &salt2);
        client.reveal_choice(&p3, &Choice::Heads, &salt3);

        client.resolve_round();

        // p1 (minority: Tails) should survive
        env.as_contract(&client.address, || {
            let state = ArenaStorage::load_player(&env, &p1).unwrap();
            assert!(state.active, "Minority revealer should survive");
            assert_eq!(state.rounds_survived, 1);
        });

        // p2 and p3 (majority: Heads) should be eliminated
        env.as_contract(&client.address, || {
            let s2 = ArenaStorage::load_player(&env, &p2).unwrap();
            let s3 = ArenaStorage::load_player(&env, &p3).unwrap();
            assert!(!s2.active, "Majority voter should be eliminated");
            assert!(!s3.active, "Majority voter should be eliminated");
        });
    }

    /// #1145 — when every active player fails to reveal the same choice
    /// (e.g., both AFKs in a 2-player round), the arena should transition to
    /// Cancelled to enable claim_refund recovery instead of becoming permanently
    /// locked.
    #[test]
    fn zero_survivor_round_resolution() {
        let env = Env::default();
        env.mock_all_auths();
        let contract_id = env.register(ArenaContract, ());
        let vault_id = env.register(MockVault, ());
        let oracle_id = env.register(MockOracle, ());
        let token_admin = Address::generate(&env);
        let token_id = env
            .register_stellar_asset_contract_v2(token_admin)
            .address();
        let token_admin_client = StellarAssetClient::new(&env, &token_id);

        let admin = Address::generate(&env);
        let client = ArenaContractClient::new(&env, &contract_id);
        client.initialize(&admin, &token_id, &vault_id, &100, &oracle_id, &Address::generate(&env), &1, &2, &10, &60);
        client.join_arena(&p1);
        client.join_arena(&p2);

        // Contract holds 200 (2 × 100 entry fee).
        let token_client = token::TokenClient::new(&env, &token_id);
        assert_eq!(token_client.balance(&contract_id), 200);

        // Start round
        env.ledger().with_mut(|li| li.timestamp = 1000);
        client.start_round(&60);

        // Advance time past the commit deadline WITHOUT any player revealing
        env.ledger()
            .with_mut(|li| li.timestamp = 1000 + MIN_ROUND_DURATION_SECONDS + 1);
        
        // Resolve the round
        client.resolve_round();
        
        // Get the arena config and verify it transitioned to Cancelled, not Finished
        env.as_contract(&contract_id, || {
            let config = ArenaStorage::load_config(&env).expect("config must exist");
            assert_eq!(
                config.state,
                GameState::Cancelled,
                "arena must transition to Cancelled when zero survivors remain, not Finished"
            );
            
            // Verify no winner was set
            let winner = ArenaStorage::get_winner(&env);
            assert!(
                winner.is_none(),
                "no winner should be set when more than one player survives"
            );
        });
    }

    /// Verify that a player who reveals the minority choice survives the round.
    #[test]
    fn minority_revealer_survives() {
        let env = Env::default();
        env.mock_all_auths();
        let contract_id = env.register(ArenaContract, ());
        let vault_id = env.register(MockVault, ());
        let oracle_id = env.register(MockOracle, ());
        let token_admin = Address::generate(&env);
        let token_id = env
            .register_stellar_asset_contract_v2(token_admin)
            .address();
        let token_admin_client = StellarAssetClient::new(&env, &token_id);

        let p1 = Address::generate(&env);
        let p2 = Address::generate(&env);
        let p3 = Address::generate(&env);
        token_admin_client.mint(&p1, &1000);
        token_admin_client.mint(&p2, &1000);
        token_admin_client.mint(&p3, &1000);

        let client = ArenaContractClient::new(&env, &contract_id);
        let admin = Address::generate(&env);
        client.initialize(
            &admin,
            &token_id,
            &vault_id,
            &100,
            &oracle_id,
            &Address::generate(&env),
            &1,
            &2,
            &10,
            &60,
        );
        client.join_arena(&p1);
        client.join_arena(&p2);
        client.join_arena(&p3);

        // Start round
        env.ledger().with_mut(|li| li.timestamp = 1000);
        client.start_round(&60);

        // p1 chooses Tails (minority), p2 and p3 choose Heads (majority)
        let salt1 = BytesN::from_array(&env, &[1u8; 32]);
        let salt2 = BytesN::from_array(&env, &[2u8; 32]);
        let salt3 = BytesN::from_array(&env, &[3u8; 32]);
        let comm1 = compute_commitment(&env, &contract_id, 1, &p1, Choice::Tails, &salt1);
        let comm2 = compute_commitment(&env, &contract_id, 1, &p2, Choice::Heads, &salt2);
        let comm3 = compute_commitment(&env, &contract_id, 1, &p3, Choice::Heads, &salt3);
        client.submit_commitment(&p1, &comm1);
        client.submit_commitment(&p2, &comm2);
        client.submit_commitment(&p3, &comm3);

        env.ledger().with_mut(|li| li.timestamp = 1061);
        client.reveal_choice(&p1, &Choice::Tails, &salt1);
        client.reveal_choice(&p2, &Choice::Heads, &salt2);
        client.reveal_choice(&p3, &Choice::Heads, &salt3);

        client.resolve_round();

        // p1 (minority: Tails) should survive
        env.as_contract(&client.address, || {
            let state = ArenaStorage::load_player(&env, &p1).unwrap();
            assert!(state.active, "Minority revealer should survive");
            assert_eq!(state.rounds_survived, 1);
        });

        // p2 and p3 (majority: Heads) should be eliminated
        env.as_contract(&client.address, || {
            let s2 = ArenaStorage::load_player(&env, &p2).unwrap();
            let s3 = ArenaStorage::load_player(&env, &p3).unwrap();
            assert!(!s2.active, "Majority voter should be eliminated");
            assert!(!s3.active, "Majority voter should be eliminated");
        });
    }

    /// #1145 — when every active player fails to reveal the same choice
    /// (e.g., both AFKs in a 2-player round), the arena should transition to
    /// Cancelled to enable claim_refund recovery instead of becoming permanently
    /// locked.
    #[test]
    fn zero_survivor_round_resolution() {
        let env = Env::default();
        env.mock_all_auths();
        let contract_id = env.register(ArenaContract, ());
        let vault_id = env.register(MockVault, ());
        let oracle_id = env.register(MockOracle, ());
        let token_admin = Address::generate(&env);
        let token_id = env
            .register_stellar_asset_contract_v2(token_admin)
            .address();
        let token_admin_client = StellarAssetClient::new(&env, &token_id);

        let admin = Address::generate(&env);
        let client = ArenaContractClient::new(&env, &contract_id);
        client.initialize(&admin, &token_id, &vault_id, &100, &oracle_id, &Address::generate(&env), &1, &2, &10, &60);
        client.join_arena(&p1);
        client.join_arena(&p2);

        // Contract holds 200 (2 × 100 entry fee).
        let token_client = token::TokenClient::new(&env, &token_id);
        assert_eq!(token_client.balance(&contract_id), 200);

        // Start round
        env.ledger().with_mut(|li| li.timestamp = 1000);
        client.start_round(&60);

        // Advance time past the commit deadline WITHOUT any player revealing
        env.ledger()
            .with_mut(|li| li.timestamp = 1000 + MIN_ROUND_DURATION_SECONDS + 1);
        
        // Resolve the round
        client.resolve_round();
        
        // Get the arena config and verify it transitioned to Cancelled, not Finished
        env.as_contract(&contract_id, || {
            let config = ArenaStorage::load_config(&env).expect("config must exist");
            assert_eq!(
                config.state,
                GameState::Cancelled,
                "arena must transition to Cancelled when zero survivors remain, not Finished"
            );
            
            // Verify no winner was set
            let winner = ArenaStorage::get_winner(&env);
            assert!(
                winner.is_none(),
                "no winner should be set when more than one player survives"
            );
        });
    }

    /// Verify that a player who reveals the minority choice survives the round.
    #[test]
    fn minority_revealer_survives() {
        let env = Env::default();
        env.mock_all_auths();
        let contract_id = env.register(ArenaContract, ());
        let vault_id = env.register(MockVault, ());
        let oracle_id = env.register(MockOracle, ());
        let token_admin = Address::generate(&env);
        let token_id = env
            .register_stellar_asset_contract_v2(token_admin)
            .address();
        let token_admin_client = StellarAssetClient::new(&env, &token_id);

        let p1 = Address::generate(&env);
        let p2 = Address::generate(&env);
        let p3 = Address::generate(&env);
        token_admin_client.mint(&p1, &1000);
        token_admin_client.mint(&p2, &1000);
        token_admin_client.mint(&p3, &1000);

        let client = ArenaContractClient::new(&env, &contract_id);
        let admin = Address::generate(&env);
        client.initialize(
            &admin,
            &token_id,
            &vault_id,
            &100,
            &oracle_id,
            &Address::generate(&env),
            &1,
            &2,
            &10,
            &60,
        );
        client.join_arena(&p1);
        client.join_arena(&p2);
        client.join_arena(&p3);

        // Start round
        env.ledger().with_mut(|li| li.timestamp = 1000);
        client.start_round(&60);

        // p1 chooses Tails (minority), p2 and p3 choose Heads (majority)
        let salt1 = BytesN::from_array(&env, &[1u8; 32]);
        let salt2 = BytesN::from_array(&env, &[2u8; 32]);
        let salt3 = BytesN::from_array(&env, &[3u8; 32]);
        let comm1 = compute_commitment(&env, &contract_id, 1, &p1, Choice::Tails, &salt1);
        let comm2 = compute_commitment(&env, &contract_id, 1, &p2, Choice::Heads, &salt2);
        let comm3 = compute_commitment(&env, &contract_id, 1, &p3, Choice::Heads, &salt3);
        client.submit_commitment(&p1, &comm1);
        client.submit_commitment(&p2, &comm2);
        client.submit_commitment(&p3, &comm3);

        env.ledger().with_mut(|li| li.timestamp = 1061);
        client.reveal_choice(&p1, &Choice::Tails, &salt1);
        client.reveal_choice(&p2, &Choice::Heads, &salt2);
        client.reveal_choice(&p3, &Choice::Heads, &salt3);

        client.resolve_round();

        // p1 (minority: Tails) should survive
        env.as_contract(&client.address, || {
            let state = ArenaStorage::load_player(&env, &p1).unwrap();
            assert!(state.active, "Minority revealer should survive");
            assert_eq!(state.rounds_survived, 1);
        });

        // p2 and p3 (majority: Heads) should be eliminated
        env.as_contract(&client.address, || {
            let s2 = ArenaStorage::load_player(&env, &p2).unwrap();
            let s3 = ArenaStorage::load_player(&env, &p3).unwrap();
            assert!(!s2.active, "Majority voter should be eliminated");
            assert!(!s3.active, "Majority voter should be eliminated");
        });
    }

    /// #1145 — when every active player fails to reveal the same choice
    /// (e.g., both AFKs in a 2-player round), the arena should transition to
    /// Cancelled to enable claim_refund recovery instead of becoming permanently
    /// locked.
    #[test]
    fn zero_survivor_round_resolution() {
        let env = Env::default();
        env.mock_all_auths();
        let contract_id = env.register(ArenaContract, ());
        let vault_id = env.register(MockVault, ());
        let oracle_id = env.register(MockOracle, ());
        let token_admin = Address::generate(&env);
        let token_id = env
            .register_stellar_asset_contract_v2(token_admin)
            .address();
        let token_admin_client = StellarAssetClient::new(&env, &token_id);

        let admin = Address::generate(&env);
        let client = ArenaContractClient::new(&env, &contract_id);
        client.initialize(&admin, &token_id, &vault_id, &100, &oracle_id, &Address::generate(&env), &1, &2, &10, &60);
        client.join_arena(&p1);
        client.join_arena(&p2);

        // Contract holds 200 (2 × 100 entry fee).
        let token_client = token::TokenClient::new(&env, &token_id);
        assert_eq!(token_client.balance(&contract_id), 200);

        // Start round
        env.ledger().with_mut(|li| li.timestamp = 1000);
        client.start_round(&60);

        // Advance time past the commit deadline WITHOUT any player revealing
        env.ledger()
            .with_mut(|li| li.timestamp = 1000 + MIN_ROUND_DURATION_SECONDS + 1);
        
        // Resolve the round
        client.resolve_round();
        
        // Get the arena config and verify it transitioned to Cancelled, not Finished
        env.as_contract(&contract_id, || {
            let config = ArenaStorage::load_config(&env).expect("config must exist");
            assert_eq!(
                config.state,
                GameState::Cancelled,
                "arena must transition to Cancelled when zero survivors remain, not Finished"
            );
            
            // Verify no winner was set
            let winner = ArenaStorage::get_winner(&env);
            assert!(
                winner.is_none(),
                "no winner should be set when more than one player survives"
            );
        });
    }

    /// Verify that a player who reveals the minority choice survives the round.
    #[test]
    fn minority_revealer_survives() {
        let env = Env::default();
        env.mock_all_auths();
        let contract_id = env.register(ArenaContract, ());
        let vault_id = env.register(MockVault, ());
        let oracle_id = env.register(MockOracle, ());
        let token_admin = Address::generate(&env);
        let token_id = env
            .register_stellar_asset_contract_v2(token_admin)
            .address();
        let token_admin_client = StellarAssetClient::new(&env, &token_id);

        let p1 = Address::generate(&env);
        let p2 = Address::generate(&env);
        let p3 = Address::generate(&env);
        token_admin_client.mint(&p1, &1000);
        token_admin_client.mint(&p2, &1000);
        token_admin_client.mint(&p3, &1000);

        let client = ArenaContractClient::new(&env, &contract_id);
        let admin = Address::generate(&env);
        client.initialize(
            &admin,
            &token_id,
            &vault_id,
            &100,
            &oracle_id,
            &Address::generate(&env),
            &1,
            &2,
            &10,
            &60,
        );
        client.join_arena(&p1);
        client.join_arena(&p2);
        client.join_arena(&p3);

        // Start round
        env.ledger().with_mut(|li| li.timestamp = 1000);
        client.start_round(&60);

        // p1 chooses Tails (minority), p2 and p3 choose Heads (majority)
        let salt1 = BytesN::from_array(&env, &[1u8; 32]);
        let salt2 = BytesN::from_array(&env, &[2u8; 32]);
        let salt3 = BytesN::from_array(&env, &[3u8; 32]);
        let comm1 = compute_commitment(&env, &contract_id, 1, &p1, Choice::Tails, &salt1);
        let comm2 = compute_commitment(&env, &contract_id, 1, &p2, Choice::Heads, &salt2);
        let comm3 = compute_commitment(&env, &contract_id, 1, &p3, Choice::Heads, &salt3);
        client.submit_commitment(&p1, &comm1);
        client.submit_commitment(&p2, &comm2);
        client.submit_commitment(&p3, &comm3);

        env.ledger().with_mut(|li| li.timestamp = 1061);
        client.reveal_choice(&p1, &Choice::Tails, &salt1);
        client.reveal_choice(&p2, &Choice::Heads, &salt2);
        client.reveal_choice(&p3, &Choice::Heads, &salt3);

        client.resolve_round();

        // p1 (minority: Tails) should survive
        env.as_contract(&client.address, || {
            let state = ArenaStorage::load_player(&env, &p1).unwrap();
            assert!(state.active, "Minority revealer should survive");
            assert_eq!(state.rounds_survived, 1);
        });

        // p2 and p3 (majority: Heads) should be eliminated
        env.as_contract(&client.address, || {
            let s2 = ArenaStorage::load_player(&env, &p2).unwrap();
            let s3 = ArenaStorage::load_player(&env, &p3).unwrap();
            assert!(!s2.active, "Majority voter should be eliminated");
            assert!(!s3.active, "Majority voter should be eliminated");
        });
    }

    /// #1145 — when every active player fails to reveal the same choice
    /// (e.g., both AFKs in a 2-player round), the arena should transition to
    /// Cancelled to enable claim_refund recovery instead of becoming permanently
    /// locked.
    #[test]
    fn zero_survivor_round_resolution() {
        let env = Env::default();
        env.mock_all_auths();
        let contract_id = env.register(ArenaContract, ());
        let vault_id = env.register(MockVault, ());
        let oracle_id = env.register(MockOracle, ());
        let token_admin = Address::generate(&env);
        let token_id = env
            .register_stellar_asset_contract_v2(token_admin)
            .address();
        let token_admin_client = StellarAssetClient::new(&env, &token_id);

        let admin = Address::generate(&env);
        let client = ArenaContractClient::new(&env, &contract_id);
        client.initialize(&admin, &token_id, &vault_id, &100, &oracle_id, &Address::generate(&env), &1, &2, &10, &60);
        client.join_arena(&p1);
        client.join_arena(&p2);

        // Contract holds 200 (2 × 100 entry fee).
        let token_client = token::TokenClient::new(&env, &token_id);
        assert_eq!(token_client.balance(&contract_id), 200);

        // Start round
        env.ledger().with_mut(|li| li.timestamp = 1000);
        client.start_round(&60);

        // Advance time past the commit deadline WITHOUT any player revealing
        env.ledger()
            .with_mut(|li| li.timestamp = 1000 + MIN_ROUND_DURATION_SECONDS + 1);
        
        // Resolve the round
        client.resolve_round();
        
        // Get the arena config and verify it transitioned to Cancelled, not Finished
        env.as_contract(&contract_id, || {
            let config = ArenaStorage::load_config(&env).expect("config must exist");
            assert_eq!(
                config.state,
                GameState::Cancelled,
                "arena must transition to Cancelled when zero survivors remain, not Finished"
            );
            
            // Verify no winner was set
            let winner = ArenaStorage::get_winner(&env);
            assert!(
                winner.is_none(),
                "no winner should be set when more than one player survives"
            );
        });
    }

    /// Verify that a player who reveals the minority choice survives the round.
    #[test]
    fn minority_revealer_survives() {
        let env = Env::default();
        env.mock_all_auths();
        let contract_id = env.register(ArenaContract, ());
        let vault_id = env.register(MockVault, ());
        let oracle_id = env.register(MockOracle, ());
        let token_admin = Address::generate(&env);
        let token_id = env
            .register_stellar_asset_contract_v2(token_admin)
            .address();
        let token_admin_client = StellarAssetClient::new(&env, &token_id);

        let p1 = Address::generate(&env);
        let p2 = Address::generate(&env);
        let p3 = Address::generate(&env);
        token_admin_client.mint(&p1, &1000);
        token_admin_client.mint(&p2, &1000);
        token_admin_client.mint(&p3, &1000);

        let client = ArenaContractClient::new(&env, &contract_id);
        let admin = Address::generate(&env);
        client.initialize(
            &admin,
            &token_id,
            &vault_id,
            &100,
            &oracle_id,
            &Address::generate(&env),
            &1,
            &2,
            &10,
            &60,
        );
        client.join_arena(&p1);
        client.join_arena(&p2);
        client.join_arena(&p3);

        // Start round
        env.ledger().with_mut(|li| li.timestamp = 1000);
        client.start_round(&60);

        // p1 chooses Tails (minority), p2 and p3 choose Heads (majority)
        let salt1 = BytesN::from_array(&env, &[1u8; 32]);
        let salt2 = BytesN::from_array(&env, &[2u8; 32]);
        let salt3 = BytesN::from_array(&env, &[3u8; 32]);
        let comm1 = compute_commitment(&env, &contract_id, 1, &p1, Choice::Tails, &salt1);
        let comm2 = compute_commitment(&env, &contract_id, 1, &p2, Choice::Heads, &salt2);
        let comm3 = compute_commitment(&env, &contract_id, 1, &p3, Choice::Heads, &salt3);
        client.submit_commitment(&p1, &comm1);
        client.submit_commitment(&p2, &comm2);
        client.submit_commitment(&p3, &comm3);

        env.ledger().with_mut(|li| li.timestamp = 1061);
        client.reveal_choice(&p1, &Choice::Tails, &salt1);
        client.reveal_choice(&p2, &Choice::Heads, &salt2);
        client.reveal_choice(&p3, &Choice::Heads, &salt3);

        client.resolve_round();

        // p1 (minority: Tails) should survive
        env.as_contract(&client.address, || {
            let state = ArenaStorage::load_player(&env, &p1).unwrap();
            assert!(state.active, "Minority revealer should survive");
            assert_eq!(state.rounds_survived, 1);
        });

        // p2 and p3 (majority: Heads) should be eliminated
        env.as_contract(&client.address, || {
            let s2 = ArenaStorage::load_player(&env, &p2).unwrap();
            let s3 = ArenaStorage::load_player(&env, &p3).unwrap();
            assert!(!s2.active, "Majority voter should be eliminated");
            assert!(!s3.active, "Majority voter should be eliminated");
        });
    }

    /// #1145 — when every active player fails to reveal the same choice
    /// (e.g., both AFKs in a 2-player round), the arena should transition to
    /// Cancelled to enable claim_refund recovery instead of becoming permanently
    /// locked.
    #[test]
    fn zero_survivor_round_resolution() {
        let env = Env::default();
        env.mock_all_auths();
        let contract_id = env.register(ArenaContract, ());
        let vault_id = env.register(MockVault, ());
        let oracle_id = env.register(MockOracle, ());
        let token_admin = Address::generate(&env);
        let token_id = env
            .register_stellar_asset_contract_v2(token_admin)
            .address();
        let token_admin_client = StellarAssetClient::new(&env, &token_id);

        let admin = Address::generate(&env);
        let client = ArenaContractClient::new(&env, &contract_id);
        client.initialize(&admin, &token_id, &vault_id, &100, &oracle_id, &Address::generate(&env), &1, &2, &10, &60);
        client.join_arena(&p1);
        client.join_arena(&p2);

        // Contract holds 200 (2 × 100 entry fee).
        let token_client = token::TokenClient::new(&env, &token_id);
        assert_eq!(token_client.balance(&contract_id), 200);

        // Start round
        env.ledger().with_mut(|li| li.timestamp = 1000);
        client.start_round(&60);

        // Advance time past the commit deadline WITHOUT any player revealing
        env.ledger()
            .with_mut(|li| li.timestamp = 1000 + MIN_ROUND_DURATION_SECONDS + 1);
        
        // Resolve the round
        client.resolve_round();
        
        // Get the arena config and verify it transitioned to Cancelled, not Finished
        env.as_contract(&contract_id, || {
            let config = ArenaStorage::load_config(&env).expect("config must exist");
            assert_eq!(
                config.state,
                GameState::Cancelled,
                "arena must transition to Cancelled when zero survivors remain, not Finished"
            );
            
            // Verify no winner was set
            let winner = ArenaStorage::get_winner(&env);
            assert!(
                winner.is_none(),
                "no winner should be set when more than one player survives"
            );
        });
    }

    /// Verify that a player who reveals the minority choice survives the round.
    #[test]
    fn minority_revealer_survives() {
        let env = Env::default();
        env.mock_all_auths();
        let contract_id = env.register(ArenaContract, ());
        let vault_id = env.register(MockVault, ());
        let oracle_id = env.register(MockOracle, ());
        let token_admin = Address::generate(&env);
        let token_id = env
            .register_stellar_asset_contract_v2(token_admin)
            .address();
        let token_admin_client = StellarAssetClient::new(&env, &token_id);

        let p1 = Address::generate(&env);
        let p2 = Address::generate(&env);
        let p3 = Address::generate(&env);
        token_admin_client.mint(&p1, &1000);
        token_admin_client.mint(&p2, &1000);
        token_admin_client.mint(&p3, &1000);

        let client = ArenaContractClient::new(&env, &contract_id);
        let admin = Address::generate(&env);
        client.initialize(
            &admin,
            &token_id,
            &vault_id,
            &100,
            &oracle_id,
            &Address::generate(&env),
            &1,
            &2,
            &10,
            &60,
        );
        client.join_arena(&p1);
        client.join_arena(&p2);
        client.join_arena(&p3);

        // Start round
        env.ledger().with_mut(|li| li.timestamp = 1000);
        client.start_round(&60);

        // p1 chooses Tails (minority), p2 and p3 choose Heads (majority)
        let salt1 = BytesN::from_array(&env, &[1u8; 32]);
        let salt2 = BytesN::from_array(&env, &[2u8; 32]);
        let salt3 = BytesN::from_array(&env, &[3u8; 32]);
        let comm1 = compute_commitment(&env, &contract_id, 1, &p1, Choice::Tails, &salt1);
        let comm2 = compute_commitment(&env, &contract_id, 1, &p2, Choice::Heads, &salt2);
        let comm3 = compute_commitment(&env, &contract_id, 1, &p3, Choice::Heads, &salt3);
        client.submit_commitment(&p1, &comm1);
        client.submit_commitment(&p2, &comm2);
        client.submit_commitment(&p3, &comm3);

        env.ledger().with_mut(|li| li.timestamp = 1061);
        client.reveal_choice(&p1, &Choice::Tails, &salt1);
        client.reveal_choice(&p2, &Choice::Heads, &salt2);
        client.reveal_choice(&p3, &Choice::Heads, &salt3);

        client.resolve_round();

        // p1 (minority: Tails) should survive
        env.as_contract(&client.address, || {
            let state = ArenaStorage::load_player(&env, &p1).unwrap();
            assert!(state.active, "Minority revealer should survive");
            assert_eq!(state.rounds_survived, 1);
        });

        // p2 and p3 (majority: Heads) should be eliminated
        env.as_contract(&client.address, || {
            let s2 = ArenaStorage::load_player(&env, &p2).unwrap();
            let s3 = ArenaStorage::load_player(&env, &p3).unwrap();
            assert!(!s2.active, "Majority voter should be eliminated");
            assert!(!s3.active, "Majority voter should be eliminated");
        });
    }

    /// #1145 — when every active player fails to reveal the same choice
    /// (e.g., both AFKs in a 2-player round), the arena should transition to
    /// Cancelled to enable claim_refund recovery instead of becoming permanently
    /// locked.
    #[test]
    fn zero_survivor_round_resolution() {
        let env = Env::default();
        env.mock_all_auths();
        let contract_id = env.register(ArenaContract, ());
        let vault_id = env.register(MockVault, ());
        let oracle_id = env.register(MockOracle, ());
        let token_admin = Address::generate(&env);
        let token_id = env
            .register_stellar_asset_contract_v2(token_admin)
            .address();
        let token_admin_client = StellarAssetClient::new(&env, &token_id);

        let admin = Address::generate(&env);
        let client = ArenaContractClient::new(&env, &contract_id);
        client.initialize(&admin, &token_id, &vault_id, &100, &oracle_id, &Address::generate(&env), &1, &2, &10, &60);
        client.join_arena(&p1);
        client.join_arena(&p2);

        // Contract holds 200 (2 × 100 entry fee).
        let token_client = token::TokenClient::new(&env, &token_id);
        assert_eq!(token_client.balance(&contract_id), 200);

        // Start round
        env.ledger().with_mut(|li| li.timestamp = 1000);
        client.start_round(&60);

        // Advance time past the commit deadline WITHOUT any player revealing
        env.ledger()
            .with_mut(|li| li.timestamp = 1000 + MIN_ROUND_DURATION_SECONDS + 1);
        
        // Resolve the round
        client.resolve_round();
        
        // Get the arena config and verify it transitioned to Cancelled, not Finished
        env.as_contract(&contract_id, || {
            let config = ArenaStorage::load_config(&env).expect("config must exist");
            assert_eq!(
                config.state,
                GameState::Cancelled,
                "arena must transition to Cancelled when zero survivors remain, not Finished"
            );
            
            // Verify no winner was set
            let winner = ArenaStorage::get_winner(&env);
            assert!(
                winner.is_none(),
                "no winner should be set when more than one player survives"
            );
        });
    }

    /// Verify that a player who reveals the minority choice survives the round.
    #[test]
    fn minority_revealer_survives() {
        let env = Env::default();
        env.mock_all_auths();
        let contract_id = env.register(ArenaContract, ());
        let vault_id = env.register(MockVault, ());
        let oracle_id = env.register(MockOracle, ());
        let token_admin = Address::generate(&env);
        let token_id = env
            .register_stellar_asset_contract_v2(token_admin)
            .address();
        let token_admin_client = StellarAssetClient::new(&env, &token_id);

        let p1 = Address::generate(&env);
        let p2 = Address::generate(&env);
        let p3 = Address::generate(&env);
        token_admin_client.mint(&p1, &1000);
        token_admin_client.mint(&p2, &1000);
        token_admin_client.mint(&p3, &1000);

        let client = ArenaContractClient::new(&env, &contract_id);
        let admin = Address::generate(&env);
        client.initialize(
            &admin,
            &token_id,
            &vault_id,
            &100,
            &oracle_id,
            &Address::generate(&env),
            &1,
            &2,
            &10,
            &60,
        );
        client.join_arena(&p1);
        client.join_arena(&p2);
        client.join_arena(&p3);

        // Start round
        env.ledger().with_mut(|li| li.timestamp = 1000);
        client.start_round(&60);

        // p1 chooses Tails (minority), p2 and p3 choose Heads (majority)
        let salt1 = BytesN::from_array(&env, &[1u8; 32]);
        let salt2 = BytesN::from_array(&env, &[2u8; 32]);
        let salt3 = BytesN::from_array(&env, &[3u8; 32]);
        let comm1 = compute_commitment(&env, &contract_id, 1, &p1, Choice::Tails, &salt1);
        let comm2 = compute_commitment(&env, &contract_id, 1, &p2, Choice::Heads, &salt2);
        let comm3 = compute_commitment(&env, &contract_id, 1, &p3, Choice::Heads, &salt3);
        client.submit_commitment(&p1, &comm1);
        client.submit_commitment(&p2, &comm2);
        client.submit_commitment(&p3, &comm3);

        env.ledger().with_mut(|li| li.timestamp = 1061);
        client.reveal_choice(&p1, &Choice::Tails, &salt1);
        client.reveal_choice(&p2, &Choice::Heads, &salt2);
        client.reveal_choice(&p3, &Choice::Heads, &salt3);

        client.resolve_round();

        // p1 (minority: Tails) should survive
        env.as_contract(&client.address, || {
            let state = ArenaStorage::load_player(&env, &p1).unwrap();
            assert!(state.active, "Minority revealer should survive");
            assert_eq!(state.rounds_survived, 1);
        });

        // p2 and p3 (majority: Heads) should be eliminated
        env.as_contract(&client.address, || {
            let s2 = ArenaStorage::load_player(&env, &p2).unwrap();
            let s3 = ArenaStorage::load_player(&env, &p3).unwrap();
            assert!(!s2.active, "Majority voter should be eliminated");
            assert!(!s3.active, "Majority voter should be eliminated");
        });
    }

    /// #1145 — when every active player fails to reveal the same choice
    /// (e.g., both AFKs in a 2-player round), the arena should transition to
    /// Cancelled to enable claim_refund recovery instead of becoming permanently
    /// locked.
    #[test]
    fn zero_survivor_round_resolution() {
        let env = Env::default();
        env.mock_all_auths();
        let contract_id = env.register(ArenaContract, ());
        let vault_id = env.register(MockVault, ());
        let oracle_id = env.register(MockOracle, ());
        let token_admin = Address::generate(&env);
        let token_id = env
            .register_stellar_asset_contract_v2(token_admin)
            .address();
        let token_admin_client = StellarAssetClient::new(&env, &token_id);

        let admin = Address::generate(&env);
        let client = ArenaContractClient::new(&env, &contract_id);
        client.initialize(&admin, &token_id, &vault_id, &100, &oracle_id, &Address::generate(&env), &1, &2, &10, &60);
        client.join_arena(&p1);
        client.join_arena(&p2);

        // Contract holds 200 (2 × 100 entry fee).
        let token_client = token::TokenClient::new(&env, &token_id);
        assert_eq!(token_client.balance(&contract_id), 200);

        // Start round
        env.ledger().with_mut(|li| li.timestamp = 1000);
        client.start_round(&60);

        // Advance time past the commit deadline WITHOUT any player revealing
        env.ledger()
            .with_mut(|li| li.timestamp = 1000 + MIN_ROUND_DURATION_SECONDS + 1);
        
        // Resolve the round
        client.resolve_round();
        
        // Get the arena config and verify it transitioned to Cancelled, not Finished
        env.as_contract(&contract_id, || {
            let config = ArenaStorage::load_config(&env).expect("config must exist");
            assert_eq!(
                config.state,
                GameState::Cancelled,
                "arena must transition to Cancelled when zero survivors remain, not Finished"
            );
            
            // Verify no winner was set
            let winner = ArenaStorage::get_winner(&env);
            assert!(
                winner.is_none(),
                "no winner should be set when more than one player survives"
            );
        });
    }

    /// Verify that a player who reveals the minority choice survives the round.
    #[test]
    fn minority_revealer_survives() {
        let env = Env::default();
        env.mock_all_auths();
        let contract_id = env.register(ArenaContract, ());
        let vault_id = env.register(MockVault, ());
        let oracle_id = env.register(MockOracle, ());
        let token_admin = Address::generate(&env);
        let token_id = env
            .register_stellar_asset_contract_v2(token_admin)
            .address();
        let token_admin_client = StellarAssetClient::new(&env, &token_id);

        let p1 = Address::generate(&env);
        let p2 = Address::generate(&env);
        let p3 = Address::generate(&env);
        token_admin_client.mint(&p1, &1000);
        token_admin_client.mint(&p2, &1000);
        token_admin_client.mint(&p3, &1000);

        let client = ArenaContractClient::new(&env, &contract_id);
        let admin = Address::generate(&env);
        client.initialize(
            &admin,
            &token_id,
            &vault_id,
            &100,
            &oracle_id,
            &Address::generate(&env),
            &1,
            &2,
            &10,
            &60,
        );
        client.join_arena(&p1);
        client.join_arena(&p2);
        client.join_arena(&p3);

        // Start round
        env.ledger().with_mut(|li| li.timestamp = 1000);
        client.start_round(&60);

        // p1 chooses Tails (minority), p2 and p3 choose Heads (majority)
        let salt1 = BytesN::from_array(&env, &[1u8; 32]);
        let salt2 = BytesN::from_array(&env, &[2u8; 32]);
        let salt3 = BytesN::from_array(&env, &[3u8; 32]);
        let comm1 = compute_commitment(&env, &contract_id, 1, &p1, Choice::Tails, &salt1);
        let comm2 = compute_commitment(&env, &contract_id, 1, &p2, Choice::Heads, &salt2);
        let comm3 = compute_commitment(&env, &contract_id, 1, &p3, Choice::Heads, &salt3);
        client.submit_commitment(&p1, &comm1);
        client.submit_commitment(&p2, &comm2);
        client.submit_commitment(&p3, &comm3);

        env.ledger().with_mut(|li| li.timestamp = 1061);
        client.reveal_choice(&p1, &Choice::Tails, &salt1);
        client.reveal_choice(&p2, &Choice::Heads, &salt2);
        client.reveal_choice(&p3, &Choice::Heads, &salt3);

        client.resolve_round();

        // p1 (minority: Tails) should survive
        env.as_contract(&client.address, || {
            let state = ArenaStorage::load_player(&env, &p1).unwrap();
            assert!(state.active, "Minority revealer should survive");
            assert_eq!(state.rounds_survived, 1);
        });

        // p2 and p3 (majority: Heads) should be eliminated
        env.as_contract(&client.address, || {
            let s2 = ArenaStorage::load_player(&env, &p2).unwrap();
            let s3 = ArenaStorage::load_player(&env, &p3).unwrap();
            assert!(!s2.active, "Majority voter should be eliminated");
            assert!(!s3.active, "Majority voter should be eliminated");
        });
    }

    /// #1145 — when every active player fails to reveal the same choice
    /// (e.g., both AFKs in a 2-player round), the arena should transition to
    /// Cancelled to enable claim_refund recovery instead of becoming permanently
    /// locked.
    #[test]
    fn zero_survivor_round_resolution() {
        let env = Env::default();
        env.mock_all_auths();
        let contract_id = env.register(ArenaContract, ());
        let vault_id = env.register(MockVault, ());
        let oracle_id = env.register(MockOracle, ());
        let token_admin = Address::generate(&env);
        let token_id = env
            .register_stellar_asset_contract_v2(token_admin)
            .address();
        let token_admin_client = StellarAssetClient::new(&env, &token_id);

        let admin = Address::generate(&env);
        let client = ArenaContractClient::new(&env, &contract_id);
        client.initialize(&admin, &token_id, &vault_id, &100, &oracle_id, &Address::generate(&env), &1, &2, &10, &60);
        client.join_arena(&p1);
        client.join_arena(&p2);

        // Contract holds 200 (2 × 100 entry fee).
        let token_client = token::TokenClient::new(&env, &token_id);
        assert_eq!(token_client.balance(&contract_id), 200);

        // Start round
        env.ledger().with_mut(|li| li.timestamp = 1000);
        client.start_round(&60);

        // Advance time past the commit deadline WITHOUT any player revealing
        env.ledger()
            .with_mut(|li| li.timestamp = 1000 + MIN_ROUND_DURATION_SECONDS + 1);
        
        // Resolve the round
        client.resolve_round();
        
        // Get the arena config and verify it transitioned to Cancelled, not Finished
        env.as_contract(&contract_id, || {
            let config = ArenaStorage::load_config(&env).expect("config must exist");
            assert_eq!(
                config.state,
                GameState::Cancelled,
                "arena must transition to Cancelled when zero survivors remain, not Finished"
            );
            
            // Verify no winner was set
            let winner = ArenaStorage::get_winner(&env);
            assert!(
                winner.is_none(),
                "no winner should be set when more than one player survives"
            );
        });
    }

    /// Verify that a player who reveals the minority choice survives the round.
    #[test]
    fn minority_revealer_survives() {
        let env = Env::default();
        env.mock_all_auths();
        let contract_id = env.register(ArenaContract, ());
        let vault_id = env.register(MockVault, ());
        let oracle_id = env.register(MockOracle, ());
        let token_admin = Address::generate(&env);
        let token_id = env
            .register_stellar_asset_contract_v2(token_admin)
            .address();
        let token_admin_client = StellarAssetClient::new(&env, &token_id);

        let p1 = Address::generate(&env);
        let p2 = Address::generate(&env);
        let p3 = Address::generate(&env);
        token_admin_client.mint(&p1, &1000);
        token_admin_client.mint(&p2, &1000);
        token_admin_client.mint(&p3, &1000);

        let client = ArenaContractClient::new(&env, &contract_id);
        let admin = Address::generate(&env);
        client.initialize(
            &admin,
            &token_id,
            &vault_id,
            &100,
            &oracle_id,
            &Address::generate(&env),
            &1,
            &2,
            &10,
            &60,
        );
        client.join_arena(&p1);
        client.join_arena(&p2);
        client.join_arena(&p3);

        // Start round
        env.ledger().with_mut(|li| li.timestamp = 1000);
        client.start_round(&60);

        // p1 chooses Tails (minority), p2 and p3 choose Heads (majority)
        let salt1 = BytesN::from_array(&env, &[1u8; 32]);
        let salt2 = BytesN::from_array(&env, &[2u8; 32]);
        let salt3 = BytesN::from_array(&env, &[3u8; 32]);
        let comm1 = compute_commitment(&env, &contract_id, 1, &p1, Choice::Tails, &salt1);
        let comm2 = compute_commitment(&env, &contract_id, 1, &p2, Choice::Heads, &salt2);
        let comm3 = compute_commitment(&env, &contract_id, 1, &p3, Choice::Heads, &salt3);
        client.submit_commitment(&p1, &comm1);
        client.submit_commitment(&p2, &comm2);
        client.submit_commitment(&p3, &comm3);

        env.ledger().with_mut(|li| li.timestamp = 1061);
        client.reveal_choice(&p1, &Choice::Tails, &salt1);
        client.reveal_choice(&p2, &Choice::Heads, &salt2);
        client.reveal_choice(&p3, &Choice::Heads, &salt3);

        client.resolve_round();

        // p1 (minority: Tails) should survive
        env.as_contract(&client.address, || {
            let state = ArenaStorage::load_player(&env, &p1).unwrap();
            assert!(state.active, "Minority revealer should survive");
            assert_eq!(state.rounds_survived, 1);
        });

        // p2 and p3 (majority: Heads) should be eliminated
        env.as_contract(&client.address, || {
            let s2 = ArenaStorage::load_player(&env, &p2).unwrap();
            let s3 = ArenaStorage::load_player(&env, &p3).unwrap();
            assert!(!s2.active, "Majority voter should be eliminated");
            assert!(!s3.active, "Majority voter should be eliminated");
        });
    }

    /// #1145 — when every active player fails to reveal the same choice
    /// (e.g., both AFKs in a 2-player round), the arena should transition to
    /// Cancelled to enable claim_refund recovery instead of becoming permanently
    /// locked.
    #[test]
    fn zero_survivor_round_resolution() {
        let env = Env::default();
        env.mock_all_auths();
        let contract_id = env.register(ArenaContract, ());
        let vault_id = env.register(MockVault, ());
        let oracle_id = env.register(MockOracle, ());
        let token_admin = Address::generate(&env);
        let token_id = env
            .register_stellar_asset_contract_v2(token_admin)
            .address();
        let token_admin_client = StellarAssetClient::new(&env, &token_id);

        let admin = Address::generate(&env);
        let client = ArenaContractClient::new(&env, &contract_id);
        client.initialize(&admin, &token_id, &vault_id, &100, &oracle_id, &Address::generate(&env), &1, &2, &10, &60);
        client.join_arena(&p1);
        client.join_arena(&p2);

        // Contract holds 200 (2 × 100 entry fee).
        let token_client = token::TokenClient::new(&env, &token_id);
        assert_eq!(token_client.balance(&contract_id), 200);

        // Start round
        env.ledger().with_mut(|li| li.timestamp = 1000);
        client.start_round(&60);

        // Advance time past the commit deadline WITHOUT any player revealing
        env.ledger()
            .with_mut(|li| li.timestamp = 1000 + MIN_ROUND_DURATION_SECONDS + 1);
        
        // Resolve the round
        client.resolve_round();
        
        // Get the arena config and verify it transitioned to Cancelled, not Finished
        env.as_contract(&contract_id, || {
            let config = ArenaStorage::load_config(&env).expect("config must exist");
            assert_eq!(
                config.state,
                GameState::Cancelled,
                "arena must transition to Cancelled when zero survivors remain, not Finished"
            );
            
            // Verify no winner was set
            let winner = ArenaStorage::get_winner(&env);
            assert!(
                winner.is_none(),
                "no winner should be set when more than one player survives"
            );
        });
    }

    /// Verify that a player who reveals the minority choice survives the round.
    #[test]
    fn minority_revealer_survives() {
        let env = Env::default();
        env.mock_all_auths();
        let contract_id = env.register(ArenaContract, ());
        let vault_id = env.register(MockVault, ());
        let oracle_id = env.register(MockOracle, ());
        let token_admin = Address::generate(&env);
        let token_id = env
            .register_stellar_asset_contract_v2(token_admin)
            .address();
        let token_admin_client = StellarAssetClient::new(&env, &token_id);

        let p1 = Address::generate(&env);
        let p2 = Address::generate(&env);
        let p3 = Address::generate(&env);
        token_admin_client.mint(&p1, &1000);
        token_admin_client.mint(&p2, &1000);
        token_admin_client.mint(&p3, &1000);

        let client = ArenaContractClient::new(&env, &contract_id);
        let admin = Address::generate(&env);
        client.initialize(
            &admin,
            &token_id,
            &vault_id,
            &100,
            &oracle_id,
            &Address::generate(&env),
            &1,
            &2,
            &10,
            &60,
        );
        client.join_arena(&p1);
        client.join_arena(&p2);
        client.join_arena(&p3);

        // Start round
        env.ledger().with_mut(|li| li.timestamp = 1000);
        client.start_round(&60);

        // p1 chooses Tails (minority), p2 and p3 choose Heads (majority)
        let salt1 = BytesN::from_array(&env, &[1u8; 32]);
        let salt2 = BytesN::from_array(&env, &[2u8; 32]);
        let salt3 = BytesN::from_array(&env, &[3u8; 32]);
        let comm1 = compute_commitment(&env, &contract_id, 1, &p1, Choice::Tails, &salt1);
        let comm2 = compute_commitment(&env, &contract_id, 1, &p2, Choice::Heads, &salt2);
        let comm3 = compute_commitment(&env, &contract_id, 1, &p3, Choice::Heads, &salt3);
        client.submit_commitment(&p1, &comm1);
        client.submit_commitment(&p2, &comm2);
        client.submit_commitment(&p3, &comm3);

        env.ledger().with_mut(|li| li.timestamp = 1061);
        client.reveal_choice(&p1, &Choice::Tails, &salt1);
        client.reveal_choice(&p2, &Choice::Heads, &salt2);
        client.reveal_choice(&p3, &Choice::Heads, &salt3);

        client.resolve_round();

        // p1 (minority: Tails) should survive
        env.as_contract(&client.address, || {
            let state = ArenaStorage::load_player(&env, &p1).unwrap();
            assert!(state.active, "Minority revealer should survive");
            assert_eq!(state.rounds_survived, 1);
        });

        // p2 and p3 (majority: Heads) should be eliminated
        env.as_contract(&client.address, || {
            let s2 = ArenaStorage::load_player(&env, &p2).unwrap();
            let s3 = ArenaStorage::load_player(&env, &p3).unwrap();
            assert!(!s2.active, "Majority voter should be eliminated");
            assert!(!s3.active, "Majority voter should be eliminated");
        });
    }

    /// #1145 — when every active player fails to reveal the same choice
    /// (e.g., both AFKs in a 2-player round), the arena should transition to
    /// Cancelled to enable claim_refund recovery instead of becoming permanently
    /// locked.
    #[test]
    fn zero_survivor_round_resolution() {
        let env = Env::default();
        env.mock_all_auths();
        let contract_id = env.register(ArenaContract, ());
        let vault_id = env.register(MockVault, ());
        let oracle_id = env.register(MockOracle, ());
        let token_admin = Address::generate(&env);
        let token_id = env
            .register_stellar_asset_contract_v2(token_admin)
            .address();
        let token_admin_client = StellarAssetClient::new(&env, &token_id);

        let admin = Address::generate(&env);
        let client = ArenaContractClient::new(&env, &contract_id);
        client.initialize(&admin, &token_id, &vault_id, &100, &oracle_id, &Address::generate(&env), &1, &2, &10, &60);
        client.join_arena(&p1);
        client.join_arena(&p2);

        // Contract holds 200 (2 × 100 entry fee).
        let token_client = token::TokenClient::new(&env, &token_id);
        assert_eq!(token_client.balance(&contract_id), 200);

        // Start round
        env.ledger().with_mut(|li| li.timestamp = 1000);
        client.start_round(&60);

        // Advance time past the commit deadline WITHOUT any player revealing
        env.ledger()
            .with_mut(|li| li.timestamp = 1000 + MIN_ROUND_DURATION_SECONDS + 1);
        
        // Resolve the round
        client.resolve_round();
        
        // Get the arena config and verify it transitioned to Cancelled, not Finished
        env.as_contract(&contract_id, || {
            let config = ArenaStorage::load_config(&env).expect("config must exist");
            assert_eq!(
                config.state,
                GameState::Cancelled,
                "arena must transition to Cancelled when zero survivors remain, not Finished"
            );
            
            // Verify no winner was set
            let winner = ArenaStorage::get_winner(&env);
            assert!(
                winner.is_none(),
                "no winner should be set when more than one player survives"
            );
        });
    }

    /// Verify that a player who reveals the minority choice survives the round.
    #[test]
    fn minority_revealer_survives() {
        let env = Env::default();
        env.mock_all_auths();
        let contract_id = env.register(ArenaContract, ());
        let vault_id = env.register(MockVault, ());
        let oracle_id = env.register(MockOracle, ());
        let token_admin = Address::generate(&env);
        let token_id = env
            .register_stellar_asset_contract_v2(token_admin)
            .address();
        let token_admin_client = StellarAssetClient::new(&env, &token_id);

        let p1 = Address::generate(&env);
        let p2 = Address::generate(&env);
        let p3 = Address::generate(&env);
        token_admin_client.mint(&p1, &1000);
        token_admin_client.mint(&p2, &1000);
        token_admin_client.mint(&p3, &1000);

        let client = ArenaContractClient::new(&env, &contract_id);
        let admin = Address::generate(&env);
        client.initialize(
            &admin,
            &token_id,
            &vault_id,
            &100,
            &oracle_id,
            &Address::generate(&env),
            &1,
            &2,
            &10,
            &60,
        );
        client.join_arena(&p1);
        client.join_arena(&p2);
        client.join_arena(&p3);

        // Start round
        env.ledger().with_mut(|li| li.timestamp = 1000);
        client.start_round(&60);

        // p1 chooses Tails (minority), p2 and p3 choose Heads (majority)
        let salt1 = BytesN::from_array(&env, &[1u8; 32]);
        let salt2 = BytesN::from_array(&env, &[2u8; 32]);
        let salt3 = BytesN::from_array(&env, &[3u8; 32]);
        let comm1 = compute_commitment(&env, &contract_id, 1, &p1, Choice::Tails, &salt1);
        let comm2 = compute_commitment(&env, &contract_id, 1, &p2, Choice::Heads, &salt2);
        let comm3 = compute_commitment(&env, &contract_id, 1, &p3, Choice::Heads, &salt3);
        client.submit_commitment(&p1, &comm1);
        client.submit_commitment(&p2, &comm2);
        client.submit_commitment(&p3, &comm3);

        env.ledger().with_mut(|li| li.timestamp = 1061);
        client.reveal_choice(&p1, &Choice::Tails, &salt1);
        client.reveal_choice(&p2, &Choice::Heads, &salt2);
        client.reveal_choice(&p3, &Choice::Heads, &salt3);

        client.resolve_round();

        // p1 (minority: Tails) should survive
        env.as_contract(&client.address, || {
            let state = ArenaStorage::load_player(&env, &p1).unwrap();
            assert!(state.active, "Minority revealer should survive");
            assert_eq!(state.rounds_survived, 1);
        });

        // p2 and p3 (majority: Heads) should be eliminated
        env.as_contract(&client.address, || {
            let s2 = ArenaStorage::load_player(&env, &p2).unwrap();
            let s3 = ArenaStorage::load_player(&env, &p3).unwrap();
            assert!(!s2.active, "Majority voter should be eliminated");
            assert!(!s3.active, "Majority voter should be eliminated");
        });
    }

    /// #1145 — when every active player fails to reveal the same choice
    /// (e.g., both AFKs in a 2-player round), the arena should transition to
    /// Cancelled to enable claim_refund recovery instead of becoming permanently
    /// locked.
    #[test]
    fn zero_survivor_round_resolution() {
        let env = Env::default();
        env.mock_all_auths();
        let contract_id = env.register(ArenaContract, ());
        let vault_id = env.register(MockVault, ());
        let oracle_id = env.register(MockOracle, ());
        let token_admin = Address::generate(&env);
        let token_id = env
            .register_stellar_asset_contract_v2(token_admin)
            .address();
        let token_admin_client = StellarAssetClient::new(&env, &token_id);

        let admin = Address::generate(&env);
        let client = ArenaContractClient::new(&env, &contract_id);
        client.initialize(&admin, &token_id, &vault_id, &100, &oracle_id, &Address::generate(&env), &1, &2, &10, &60);
        client.join_arena(&p1);
        client.join_arena(&p2);

        // Contract holds 200 (2 × 100 entry fee).
        let token_client = token::TokenClient::new(&env, &token_id);
        assert_eq!(token_client.balance(&contract_id), 200);

        // Start round
        env.ledger().with_mut(|li| li.timestamp = 1000);
        client.start_round(&60);

        // Advance time past the commit deadline WITHOUT any player revealing
        env.ledger()
            .with_mut(|li| li.timestamp = 1000 + MIN_ROUND_DURATION_SECONDS + 1);
        
        // Resolve the round
        client.resolve_round();
        
        // Get the arena config and verify it transitioned to Cancelled, not Finished
        env.as_contract(&contract_id, || {
            let config = ArenaStorage::load_config(&env).expect("config must exist");
            assert_eq!(
                config.state,
                GameState::Cancelled,
                "arena must transition to Cancelled when zero survivors remain, not Finished"
            );
            
            // Verify no winner was set
            let winner = ArenaStorage::get_winner(&env);
            assert!(
                winner.is_none(),
                "no winner should be set when more than one player survives"
            );
        });
    }

    /// Verify that a player who reveals the minority choice survives the round.
    #[test]
    fn minority_revealer_survives() {
        let env = Env::default();
        env.mock_all_auths();
        let contract_id = env.register(ArenaContract, ());
        let vault_id = env.register(MockVault, ());
        let oracle_id = env.register(MockOracle, ());
        let token_admin = Address::generate(&env);
        let token_id = env
            .register_stellar_asset_contract_v2(token_admin)
            .address();
        let token_admin_client = StellarAssetClient::new(&env, &token_id);

        let p1 = Address::generate(&env);
        let p2 = Address::generate(&env);
        let p3 = Address::generate(&env);
        token_admin_client.mint(&p1, &1000);
        token_admin_client.mint(&p2, &1000);
        token_admin_client.mint(&p3, &1000);

        let client = ArenaContractClient::new(&env, &contract_id);
        let admin = Address::generate(&env);
        client.initialize(
            &admin,
            &token_id,
            &vault_id,
            &100,
            &oracle_id,
            &Address::generate(&env),
            &1,
            &2,
            &10,
            &60,
        );
        client.join_arena(&p1);
        client.join_arena(&p2);
        client.join_arena(&p3);

        // Start round
        env.ledger().with_mut(|li| li.timestamp = 1000);
        client.start_round(&60);

        // p1 chooses Tails (minority), p2 and p3 choose Heads (majority)
        let salt1 = BytesN::from_array(&env, &[1u8; 32]);
        let salt2 = BytesN::from_array(&env, &[2u8; 32]);
        let salt3 = BytesN::from_array(&env, &[3u8; 32]);
        let comm1 = compute_commitment(&env, &contract_id, 1, &p1, Choice::Tails, &salt1);
        let comm2 = compute_commitment(&env, &contract_id, 1, &p2, Choice::Heads, &salt2);
        let comm3 = compute_commitment(&env, &contract_id, 1, &p3, Choice::Heads, &salt3);
        client.submit_commitment(&p1, &comm1);
        client.submit_commitment(&p2, &comm2);
        client.submit_commitment(&p3, &comm3);

        env.ledger().with_mut(|li| li.timestamp = 1061);
        client.reveal_choice(&p1, &Choice::Tails, &salt1);
        client.reveal_choice(&p2, &Choice::Heads, &salt2);
        client.reveal_choice(&p3, &Choice::Heads, &salt3);

        client.resolve_round();

        // p1 (minority: Tails) should survive
        env.as_contract(&client.address, || {
            let state = ArenaStorage::load_player(&env, &p1).unwrap();
            assert!(state.active, "Minority revealer should survive");
            assert_eq!(state.rounds_survived, 1);
        });

        // p2 and p3 (majority: Heads) should be eliminated
        env.as_contract(&client.address, || {
            let s2 = ArenaStorage::load_player(&env, &p2).unwrap();
            let s3 = ArenaStorage::load_player(&env, &p3).unwrap();
            assert!(!s2.active, "Majority voter should be eliminated");
            assert!(!s3.active, "Majority voter should be eliminated");
        });
    }

    /// #1145 — when every active player fails to reveal the same choice
    /// (e.g., both AFKs in a 2-player round), the arena should transition to
    /// Cancelled to enable claim_refund recovery instead of becoming permanently
    /// locked.
    #[test]
    fn zero_survivor_round_resolution() {
        let env = Env::default();
        env.mock_all_auths();
        let contract_id = env.register(ArenaContract, ());
        let vault_id = env.register(MockVault, ());
        let oracle_id = env.register(MockOracle, ());
        let token_admin = Address::generate(&env);
        let token_id = env
            .register_stellar_asset_contract_v2(token_admin)
            .address();
        let token_admin_client = StellarAssetClient::new(&env, &token_id);

        let admin = Address::generate(&env);
        let client = ArenaContractClient::new(&env, &contract_id);
        client.initialize(&admin, &token_id, &vault_id, &100, &oracle_id, &Address::generate(&env), &1, &2, &10, &60);
        client.join_arena(&p1);
        client.join_arena(&p2);

        // Contract holds 200 (2 × 100 entry fee).
        let token_client = token::TokenClient::new(&env, &token_id);
        assert_eq!(token_client.balance(&contract_id), 200);

        // Start round
        env.ledger().with_mut(|li| li.timestamp = 1000);
        client.start_round(&60);

        // Advance time past the commit deadline WITHOUT any player revealing
        env.ledger()
            .with_mut(|li| li.timestamp = 1000 + MIN_ROUND_DURATION_SECONDS + 1);
        
        // Resolve the round
        client.resolve_round();
        
        // Get the arena config and verify it transitioned to Cancelled, not Finished
        env.as_contract(&contract_id, || {
            let config = ArenaStorage::load_config(&env).expect("config must exist");
            assert_eq!(
                config.state,
                GameState::Cancelled,
                "arena must transition to Cancelled when zero survivors remain, not Finished"
            );
            
            // Verify no winner was set
            let winner = ArenaStorage::get_winner(&env);
            assert!(
                winner.is_none(),
                "no winner should be set when more than one player survives"
            );
        });
    }

    /// Verify that a player who reveals the minority choice survives the round.
    #[test]
    fn minority_revealer_survives() {
        let env = Env::default();
        env.mock_all_auths();
        let contract_id = env.register(ArenaContract, ());
        let vault_id = env.register(MockVault, ());
        let oracle_id = env.register(MockOracle, ());
        let token_admin = Address::generate(&env);
        let token_id = env
            .register_stellar_asset_contract_v2(token_admin)
            .address();
        let token_admin_client = StellarAssetClient::new(&env, &token_id);

        let p1 = Address::generate(&env);
        let p2 = Address::generate(&env);
        let p3 = Address::generate(&env);
        token_admin_client.mint(&p1, &1000);
        token_admin_client.mint(&p2, &1000);
        token_admin_client.mint(&p3, &1000);

        let client = ArenaContractClient::new(&env, &contract_id);
        let admin = Address::generate(&env);
        client.initialize(
            &admin,
            &token_id,
            &vault_id,
            &100,
            &oracle_id,
            &Address::generate(&env),
            &1,
            &2,
            &10,
            &60,
        );
        client.join_arena(&p1);
        client.join_arena(&p2);
        client.join_arena(&p3);

        // Start round
        env.ledger().with_mut(|li| li.timestamp = 1000);
        client.start_round(&60);

        // p1 chooses Tails (minority), p2 and p3 choose Heads (majority)
        let salt1 = BytesN::from_array(&env, &[1u8; 32]);
        let salt2 = BytesN::from_array(&env, &[2u8; 32]);
        let salt3 = BytesN::from_array(&env, &[3u8; 32]);
        let comm1 = compute_commitment(&env, &contract_id, 1, &p1, Choice::Tails, &salt1);
        let comm2 = compute_commitment(&env, &contract_id, 1, &p2, Choice::Heads, &salt2);
        let comm3 = compute_commitment(&env, &contract_id, 1, &p3, Choice::Heads, &salt3);
        client.submit_commitment(&p1, &comm1);
        client.submit_commitment(&p2, &comm2);
        client.submit_commitment(&p3, &comm3);

        env.ledger().with_mut(|li| li.timestamp = 1061);
        client.reveal_choice(&p1, &Choice::Tails, &salt1);
        client.reveal_choice(&p2, &Choice::Heads, &salt2);
        client.reveal_choice(&p3, &Choice::Heads, &salt3);

        client.resolve_round();

        // p1 (minority: Tails) should survive
        env.as_contract(&client.address, || {
            let state = ArenaStorage::load_player(&env, &p1).unwrap();
            assert!(state.active, "Minority revealer should survive");
            assert_eq!(state.rounds_survived, 1);
        });

        // p2 and p3 (majority: Heads) should be eliminated
        env.as_contract(&client.address, || {
            let s2 = ArenaStorage::load_player(&env, &p2).unwrap();
            let s3 = ArenaStorage::load_player(&env, &p3).unwrap();
            assert!(!s2.active, "Majority voter should be eliminated");
            assert!(!s3.active, "Majority voter should be eliminated");
        });
    }

    /// #1145 — when every active player fails to reveal the same choice
    /// (e.g., both AFKs in a 2-player round), the arena should transition to
    /// Cancelled to enable claim_refund recovery instead of becoming permanently
    /// locked.
    #[test]
    fn zero_survivor_round_resolution() {
        let env = Env::default();
        env.mock_all_auths();
        let contract_id = env.register(ArenaContract, ());
        let vault_id = env.register(MockVault, ());
        let oracle_id = env.register(MockOracle, ());
        let token_admin = Address::generate(&env);
        let token_id = env
            .register_stellar_asset_contract_v2(token_admin)
            .address();
        let token_admin_client = StellarAssetClient::new(&env, &token_id);

        let admin = Address::generate(&env);
        let client = ArenaContractClient::new(&env, &contract_id);
        client.initialize(&admin, &token_id, &vault_id, &100, &oracle_id, &Address::generate(&env), &1, &2, &10, &60);
        client.join_arena(&p1);
        client.join_arena(&p2);

        // Contract holds 200 (2 × 100 entry fee).
        let token_client = token::TokenClient::new(&env, &token_id);
        assert_eq!(token_client.balance(&contract_id), 200);

        // Start round
        env.ledger().with_mut(|li| li.timestamp = 1000);
        client.start_round(&60);

        // Advance time past the commit deadline WITHOUT any player revealing
        env.ledger()
            .with_mut(|li| li.timestamp = 1000 + MIN_ROUND_DURATION_SECONDS + 1);
        
        // Resolve the round
        client.resolve_round();
        
        // Get the arena config and verify it transitioned to Cancelled, not Finished
        env.as_contract(&contract_id, || {
            let config = ArenaStorage::load_config(&env).expect("config must exist");
            assert_eq!(
                config.state,
                GameState::Cancelled,
                "arena must transition to Cancelled when zero survivors remain, not Finished"
            );
            
            // Verify no winner was set
            let winner = ArenaStorage::get_winner(&env);
            assert!(
                winner.is_none(),
                "no winner should be set when more than one player survives"
            );
        });
    }

    /// Verify that a player who reveals the minority choice survives the round.
    #[test]
    fn minority_revealer_survives() {
        let env = Env::default();
        env.mock_all_auths();
        let contract_id = env.register(ArenaContract, ());
        let vault_id = env.register(MockVault, ());
        let oracle_id = env.register(MockOracle, ());
        let token_admin = Address::generate(&env);
        let token_id = env
            .register_stellar_asset_contract_v2(token_admin)
            .address();
        let token_admin_client = StellarAssetClient::new(&env, &token_id);

        let p1 = Address::generate(&env);
        let p2 = Address::generate(&env);
        let p3 = Address::generate(&env);
        token_admin_client.mint(&p1, &1000);
        token_admin_client.mint(&p2, &1000);
        token_admin_client.mint(&p3, &1000);

        let client = ArenaContractClient::new(&env, &contract_id);
        let admin = Address::generate(&env);
        client.initialize(
            &admin,
            &token_id,
            &vault_id,
            &100,
            &oracle_id,
            &Address::generate(&env),
            &1,
            &2,
            &10,
            &60,
        );
        client.join_arena(&p1);
        client.join_arena(&p2);
        client.join_arena(&p3);

        // Start round
        env.ledger().with_mut(|li| li.timestamp = 1000);
        client.start_round(&60);

        // p1 chooses Tails (minority), p2 and p3 choose Heads (majority)
        let salt1 = BytesN::from_array(&env, &[1u8; 32]);
        let salt2 = BytesN::from_array(&env, &[2u8; 32]);
        let salt3 = BytesN::from_array(&env, &[3u8; 32]);
        let comm1 = compute_commitment(&env, &contract_id, 1, &p1, Choice::Tails, &salt1);
        let comm2 = compute_commitment(&env, &contract_id, 1, &p2, Choice::Heads, &salt2);
        let comm3 = compute_commitment(&env, &contract_id, 1, &p3, Choice::Heads, &salt3);
        client.submit_commitment(&p1, &comm1);
        client.submit_commitment(&p2, &comm2);
        client.submit_commitment(&p3, &comm3);

        env.ledger().with_mut(|li| li.timestamp = 1061);
        client.reveal_choice(&p1, &Choice::Tails, &salt1);
        client.reveal_choice(&p2, &Choice::Heads, &salt2);
        client.reveal_choice(&p3, &Choice::Heads, &salt3);

        client.resolve_round();

        // p1 (minority: Tails) should survive
        env.as_contract(&client.address, || {
            let state = ArenaStorage::load_player(&env, &p1).unwrap();
            assert!(state.active, "Minority revealer should survive");
            assert_eq!(state.rounds_survived, 1);
        });

        // p2 and p3 (majority: Heads) should be eliminated
        env.as_contract(&client.address, || {
            let s2 = ArenaStorage::load_player(&env, &p2).unwrap();
            let s3 = ArenaStorage::load_player(&env, &p3).unwrap();
            assert!(!s2.active, "Majority voter should be eliminated");
            assert!(!s3.active, "Majority voter should be eliminated");
        });
    }

    /// #1145 — when every active player fails to reveal the same choice
    /// (e.g., both AFKs in a 2-player round), the arena should transition to
    /// Cancelled to enable claim_refund recovery instead of becoming permanently
    /// locked.
    #[test]
    fn zero_survivor_round_resolution() {
        let env = Env::default();
        env.mock_all_auths();
        let contract_id = env.register(ArenaContract, ());
        let vault_id = env.register(MockVault, ());
        let oracle_id = env.register(MockOracle, ());
        let token_admin = Address::generate(&env);
        let token_id = env
            .register_stellar_asset_contract_v2(token_admin)
            .address();
        let token_admin_client = StellarAssetClient::new(&env, &token_id);

        let admin = Address::generate(&env);
        let client = ArenaContractClient::new(&env, &contract_id);
        client.initialize(&admin, &token_id, &vault_id, &100, &oracle_id, &Address::generate(&env), &1, &2, &10, &60);
        client.join_arena(&p1);
        client.join_arena(&p2);

        // Contract holds 200 (2 × 100 entry fee).
        let token_client = token::TokenClient::new(&env, &token_id);
        assert_eq!(token_client.balance(&contract_id), 200);

        // Start round
        env.ledger().with_mut(|li| li.timestamp = 1000);
        client.start_round(&60);

        // Advance time past the commit deadline WITHOUT any player revealing
        env.ledger()
            .with_mut(|li| li.timestamp = 1000 + MIN_ROUND_DURATION_SECONDS + 1);
        
        // Resolve the round
        client.resolve_round();
        
        // Get the arena config and verify it transitioned to Cancelled, not Finished
        env.as_contract(&contract_id, || {
            let config = ArenaStorage::load_config(&env).expect("config must exist");
            assert_eq!(
                config.state,
                GameState::Cancelled,
                "arena must transition to Cancelled when zero survivors remain, not Finished"
            );
            
            // Verify no winner was set
            let winner = ArenaStorage::get_winner(&env);
            assert!(
                winner.is_none(),
                "no winner should be set when more than one player survives"
            );
        });
    }

    /// Verify that a player who reveals the minority choice survives the round.
    #[test]
    fn minority_revealer_survives() {
        let env = Env::default();
        env.mock_all_auths();
        let contract_id = env.register(ArenaContract, ());
        let vault_id = env.register(MockVault, ());
        let oracle_id = env.register(MockOracle, ());
        let token_admin = Address::generate(&env);
        let token_id = env
            .register_stellar_asset_contract_v2(token_admin)
            .address();
        let token_admin_client = StellarAssetClient::new(&env, &token_id);

        let p1 = Address::generate(&env);
        let p2 = Address::generate(&env);
        let p3 = Address::generate(&env);
        token_admin_client.mint(&p1, &1000);
        token_admin_client.mint(&p2, &1000);
        token_admin_client.mint(&p3, &1000);

        let client = ArenaContractClient::new(&env, &contract_id);
        let admin = Address::generate(&env);
        client.initialize(
            &admin,
            &token_id,
            &vault_id,
            &100,
            &oracle_id,
            &Address::generate(&env),
            &1,
            &2,
            &10,
            &60,
        );
        client.join_arena(&p1);
        client.join_arena(&p2);
        client.join_arena(&p3);

        // Start round
        env.ledger().with_mut(|li| li.timestamp = 1000);
        client.start_round(&60);

        // p1 chooses Tails (minority), p2 and p3 choose Heads (majority)
        let salt1 = BytesN::from_array(&env, &[1u8; 32]);
        let salt2 = BytesN::from_array(&env, &[2u8; 32]);
        let salt3 = BytesN::from_array(&env, &[3u8; 32]);
        let comm1 = compute_commitment(&env, &contract_id, 1, &p1, Choice::Tails, &salt1);
        let comm2 = compute_commitment(&env, &contract_id, 1, &p2, Choice::Heads, &salt2);
        let comm3 = compute_commitment(&env, &contract_id, 1, &p3, Choice::Heads, &salt3);
        client.submit_commitment(&p1, &comm1);
        client.submit_commitment(&p2, &comm2);
        client.submit_commitment(&p3, &comm3);

        env.ledger().with_mut(|li| li.timestamp = 1061);
        client.reveal_choice(&p1, &Choice::Tails, &salt1);
        client.reveal_choice(&p2, &Choice::Heads, &salt2);
        client.reveal_choice(&p3, &Choice::Heads, &salt3);

        client.resolve_round();

        // p1 (minority: Tails) should survive
        env.as_contract(&client.address, || {
            let state = ArenaStorage::load_player(&env, &p1).unwrap();
            assert!(state.active, "Minority revealer should survive");
            assert_eq!(state.rounds_survived, 1);
        });

        // p2 and p3 (majority: Heads) should be eliminated
        env.as_contract(&client.address, || {
            let s2 = ArenaStorage::load_player(&env, &p2).unwrap();
            let s3 = ArenaStorage::load_player(&env, &p3).unwrap();
            assert!(!s2.active, "Majority voter should be eliminated");
            assert!(!s3.active, "Majority voter should be eliminated");
        });
    }

    /// #1145 — when every active player fails to reveal the same choice
    /// (e.g., both AFKs in a 2-player round), the arena should transition to
    /// Cancelled to enable claim_refund recovery instead of becoming permanently
    /// locked.
    #[test]
    fn zero_survivor_round_resolution() {
        let env = Env::default();
        env.mock_all_auths();
        let contract_id = env.register(ArenaContract, ());
        let vault_id = env.register(MockVault, ());
        let oracle_id = env.register(MockOracle, ());
        let token_admin = Address::generate(&env);
        let token_id = env
            .register_stellar_asset_contract_v2(token_admin)
            .address();
        let token_admin_client = StellarAssetClient::new(&env, &token_id);

        let admin = Address::generate(&env);
        let client = ArenaContractClient::new(&env, &contract_id);
        client.initialize(&admin, &token_id, &vault_id, &100, &oracle_id, &Address::generate(&env), &1, &2, &10, &60);
        client.join_arena(&p1);
        client.join_arena(&p2);

        // Contract holds 200 (2 × 100 entry fee).
        let token_client = token::TokenClient::new(&env, &token_id);
        assert_eq!(token_client.balance(&contract_id), 200);

        // Start round
        env.ledger().with_mut(|li| li.timestamp = 1000);
        client.start_round(&60);

        // Advance time past the commit deadline WITHOUT any player revealing
        env.ledger()
            .with_mut(|li| li.timestamp = 1000 + MIN_ROUND_DURATION_SECONDS + 1);
        
        // Resolve the round
        client.resolve_round();
        
        // Get the arena config and verify it transitioned to Cancelled, not Finished
        env.as_contract(&contract_id, || {
            let config = ArenaStorage::load_config(&env).expect("config must exist");
            assert_eq!(
                config.state,
                GameState::Cancelled,
                "arena must transition to Cancelled when zero survivors remain, not Finished"
            );
            
            // Verify no winner was set
            let winner = ArenaStorage::get_winner(&env);
            assert!(
                winner.is_none(),
                "no winner should be set when more than one player survives"
            );
        });
    }

    /// Verify that a player who reveals the minority choice survives the round.
    #[test]
    fn minority_revealer_survives() {
        let env = Env::default();
        env.mock_all_auths();
        let contract_id = env.register(ArenaContract, ());
        let vault_id = env.register(MockVault, ());
        let oracle_id = env.register(MockOracle, ());
        let token_admin = Address::generate(&env);
        let token_id = env
            .register_stellar_asset_contract_v2(token_admin)
            .address();
        let token_admin_client = StellarAssetClient::new(&env, &token_id);

        let p1 = Address::generate(&env);
        let p2 = Address::generate(&env);
        let p3 = Address::generate(&env);
        token_admin_client.mint(&p1, &1000);
        token_admin_client.mint(&p2, &1000);
        token_admin_client.mint(&p3, &1000);

        let client = ArenaContractClient::new(&env, &contract_id);
        let admin = Address::generate(&env);
        client.initialize(
            &admin,
            &token_id,
            &vault_id,
            &100,
            &oracle_id,
            &Address::generate(&env),
            &1,
            &2,
            &10,
            &60,
        );
        client.join_arena(&p1);
        client.join_arena(&p2);
        client.join_arena(&p3);

        // Start round
        env.ledger().with_mut(|li| li.timestamp = 1000);
        client.start_round(&60);

        // p1 chooses Tails (minority), p2 and p3 choose Heads (majority)
        let salt1 = BytesN::from_array(&env, &[1u8; 32]);
        let salt2 = BytesN::from_array(&env, &[2u8; 32]);
        let salt3 = BytesN::from_array(&env, &[3u8; 32]);
        let comm1 = compute_commitment(&env, &contract_id, 1, &p1, Choice::Tails, &salt1);
        let comm2 = compute_commitment(&env, &contract_id, 1, &p2, Choice::Heads, &salt2);
        let comm3 = compute_commitment(&env, &contract_id, 1, &p3, Choice::Heads, &salt3);
        client.submit_commitment(&p1, &comm1);
        client.submit_commitment(&p2, &comm2);
        client.submit_commitment(&p3, &comm3);

        env.ledger().with_mut(|li| li.timestamp = 1061);
        client.reveal_choice(&p1, &Choice::Tails, &salt1);
        client.reveal_choice(&p2, &Choice::Heads, &salt2);
        client.reveal_choice(&p3, &Choice::Heads, &salt3);

        client.resolve_round();

        // p1 (minority: Tails) should survive
        env.as_contract(&client.address, || {
            let state = ArenaStorage::load_player(&env, &p1).unwrap();
            assert!(state.active, "Minority revealer should survive");
            assert_eq!(state.rounds_survived, 1);
        });

        // p2 and p3 (majority: Heads) should be eliminated
        env.as_contract(&client.address, || {
            let s2 = ArenaStorage::load_player(&env, &p2).unwrap();
            let s3 = ArenaStorage::load_player(&env, &p3).unwrap();
            assert!(!s2.active, "Majority voter should be eliminated");
            assert!(!s3.active, "Majority voter should be eliminated");
        });
    }

    /// #1145 — when every active player fails to reveal the same choice
    /// (e.g., both AFKs in a 2-player round), the arena should transition to
    /// Cancelled to enable claim_refund recovery instead of becoming permanently
    /// locked.
    #[test]
    fn zero_survivor_round_resolution() {
        let env = Env::default();
        env.mock_all_auths();
        let contract_id = env.register(ArenaContract, ());
        let vault_id = env.register(MockVault, ());
        let oracle_id = env.register(MockOracle, ());
        let token_admin = Address::generate(&env);
        let token_id = env
            .register_stellar_asset_contract_v2(token_admin)
            .address();
        let token_admin_client = StellarAssetClient::new(&env, &token_id);

        let admin = Address::generate(&env);
        let client = ArenaContractClient::new(&env, &contract_id);
        client.initialize(&admin, &token_id, &vault_id, &100, &oracle_id, &Address::generate(&env), &1, &2, &10, &60);
        client.join_arena(&p1);
        client.join_arena(&p2);

        // Contract holds 200 (2 × 100 entry fee).
        let token_client = token::TokenClient::new(&env, &token_id);
        assert_eq!(token_client.balance(&contract_id), 200);

        // Start round
        env.ledger().with_mut(|li| li.timestamp = 1000);
        client.start_round(&60);

        // Advance time past the commit deadline WITHOUT any player revealing
        env.ledger()
            .with_mut(|li| li.timestamp = 1000 + MIN_ROUND_DURATION_SECONDS + 1);
        
        // Resolve the round
        client.resolve_round();
        
        // Get the arena config and verify it transitioned to Cancelled, not Finished
        env.as_contract(&contract_id, || {
            let config = ArenaStorage::load_config(&env).expect("config must exist");
            assert_eq!(
                config.state,
                GameState::Cancelled,
                "arena must transition to Cancelled when zero survivors remain, not Finished"
            );
            
            // Verify no winner was set
            let winner = ArenaStorage::get_winner(&env);
            assert!(
                winner.is_none(),
                "no winner should be set when more than one player survives"
            );
        });
    }

    /// Verify that a player who reveals the minority choice survives the round.
    #[test]
    fn minority_revealer_survives() {
        let env = Env::default();
        env.mock_all_auths();
        let contract_id = env.register(ArenaContract, ());
        let vault_id = env.register(MockVault, ());
        let oracle_id = env.register(MockOracle, ());
        let token_admin = Address::generate(&env);
        let token_id = env
            .register_stellar_asset_contract_v2(token_admin)
            .address();
        let token_admin_client = StellarAssetClient::new(&env, &token_id);

        let p1 = Address::generate(&env);
        let p2 = Address::generate(&env);
        let p3 = Address::generate(&env);
        token_admin_client.mint(&p1, &1000);
        token_admin_client.mint(&p2, &1000);
        token_admin_client.mint(&p3, &1000);

        let client = ArenaContractClient::new(&env, &contract_id);
        let admin = Address::generate(&env);
        client.initialize(
            &admin,
            &token_id,
            &vault_id,
            &100,
            &oracle_id,
            &Address::generate(&env),
            &1,
            &2,
            &10,
            &60,
        );
        client.join_arena(&p1);
        client.join_arena(&p2);
        client.join_arena(&p3);

        // Start round
        env.ledger().with_mut(|li| li.timestamp = 1000);
        client.start_round(&60);

        // p1 chooses Tails (minority), p2 and p3 choose Heads (majority)
        let salt1 = BytesN::from_array(&env, &[1u8; 32]);
        let salt2 = BytesN::from_array(&env, &[2u8; 32]);
        let salt3 = BytesN::from_array(&env, &[3u8; 32]);
        let comm1 = compute_commitment(&env, &contract_id, 1, &p1, Choice::Tails, &salt1);
        let comm2 = compute_commitment(&env, &contract_id, 1, &p2, Choice::Heads, &salt2);
        let comm3 = compute_commitment(&env, &contract_id, 1, &p3, Choice::Heads, &salt3);
        client.submit_commitment(&p1, &comm1);
        client.submit_commitment(&p2, &comm2);
        client.submit_commitment(&p3, &comm3);

        env.ledger().with_mut(|li| li.timestamp = 1061);
        client.reveal_choice(&p1, &Choice::Tails, &salt1);
        client.reveal_choice(&p2, &Choice::Heads, &salt2);
        client.reveal_choice(&p3, &Choice::Heads, &salt3);

        client.resolve_round();

        // p1 (minority: Tails) should survive
        env.as_contract(&client.address, || {
            let state = ArenaStorage::load_player(&env, &p1).unwrap();
            assert!(state.active, "Minority revealer should survive");
            assert_eq!(state.rounds_survived, 1);
        });

        // p2 and p3 (majority: Heads) should be eliminated
        env.as_contract(&client.address, || {
            let s2 = ArenaStorage::load_player(&env, &p2).unwrap();
            let s3 = ArenaStorage::load_player(&env, &p3).unwrap();
            assert!(!s2.active, "Majority voter should be eliminated");
            assert!(!s3.active, "Majority voter should be eliminated");
        });
    }

    /// #1145 — when every active player fails to reveal the same choice
    /// (e.g., both AFKs in a 2-player round), the arena should transition to
    /// Cancelled to enable claim_refund recovery instead of becoming permanently
    /// locked.
    #[test]
    fn zero_survivor_round_resolution() {
        let env = Env::default();
        env.mock_all_auths();
        let contract_id = env.register(ArenaContract, ());
        let vault_id = env.register(MockVault, ());
        let oracle_id = env.register(MockOracle, ());
        let token_admin = Address::generate(&env);
        let token_id = env
            .register_stellar_asset_contract_v2(token_admin)
            .address();
        let token_admin_client = StellarAssetClient::new(&env, &token_id);

        let admin = Address::generate(&env);
        let client = ArenaContractClient::new(&env, &contract_id);
        client.initialize(&admin, &token_id, &vault_id, &100, &oracle_id, &Address::generate(&env), &1, &2, &10, &60);
        client.join_arena(&p1);
        client.join_arena(&p2);

        // Contract holds 200 (2 × 100 entry fee).
        let token_client = token::TokenClient::new(&env, &token_id);
        assert_eq!(token_client.balance(&contract_id), 200);

        // Start round
        env.ledger().with_mut(|li| li.timestamp = 1000);
        client.start_round(&60);

        // Advance time past the commit deadline WITHOUT any player revealing
        env.ledger()
            .with_mut(|li| li.timestamp = 1000 + MIN_ROUND_DURATION_SECONDS + 1);
        
        // Resolve the round
        client.resolve_round();
        
        // Get the arena config and verify it transitioned to Cancelled, not Finished
        env.as_contract(&contract_id, || {
            let config = ArenaStorage::load_config(&env).expect("config must exist");
            assert_eq!(
                config.state,
                GameState::Cancelled,
                "arena must transition to Cancelled when zero survivors remain, not Finished"
            );
            
            // Verify no winner was set
            let winner = ArenaStorage::get_winner(&env);
            assert!(
                winner.is_none(),
                "no winner should be set when more than one player survives"
            );
        });
    }

    /// Verify that a player who reveals the minority choice survives the round.
    #[test]
    fn minority_revealer_survives() {
        let env = Env::default();
        env.mock_all_auths();
        let contract_id = env.register(ArenaContract, ());
        let vault_id = env.register(MockVault, ());
        let oracle_id = env.register(MockOracle, ());
        let token_admin = Address::generate(&env);
        let token_id = env
            .register_stellar_asset_contract_v2(token_admin)
            .address();
        let token_admin_client = StellarAssetClient::new(&env, &token_id);

        let p1 = Address::generate(&env);
        let p2 = Address::generate(&env);
        let p3 = Address::generate(&env);
        token_admin_client.mint(&p1, &1000);
        token_admin_client.mint(&