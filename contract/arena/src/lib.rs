Warning: truncated output (original token count: 56435)
Total output lines: 5559

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
const CONTRACT_VERSION: u32 = 7;
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
        ArenaStorage::save_player_limits(&env, min_players, max_players);
        ArenaStorage::save_last_vault_balance(&env, 0);
        ArenaEvents::initialized(&env, &admin);
        Ok(())
    }

    /// Return the arena contract ABI/storage version.
    pub fn version(_env: Env) -> u32 {
        CONTRACT_VERSION
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
            ArenaEvents::player_refunded(&env, &player, refund);
        }
        Ok(())
    }

    /// Remove a player's join ban.
    pub fn unban_player(env: Env, player: Address) -> Result<(), ArenaError> {
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
        ArenaStorage::enter_reentrancy_guard(&env)?;
        player.require_auth();
        let config = ArenaStorage::load_config(&env)?;
        Self::require_not_paused(&env, &config)?;
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
        let start_deadline = ArenaStorage::load_start_deadline(&env);
        if start_deadline != 0 && env.ledger().timestamp() >= start_deadline {
            return Err(ArenaError::StartDeadlinePassed);
        }
        if player == config.admin {
            return Err(ArenaError::CreatorCannotJoin);
        }
        if ArenaStorage::is_player_banned(&env, &player) {
            return Err(ArenaError::PlayerBanned);
        }
        // Reject a second join by the same player: charging the entry fee twice
        // and inflating the player count would corrupt the game. A player who
        // has joined already has stored player state.
        if ArenaStorage::load_player(&env, &player).is_some() {
            return Err(ArenaError::AlreadyJoined);
        }
        if let Some(max_players) = ArenaStorage::load_max_players(&env)
            && config.player_count >= max_players
        {
            return Err(ArenaError::ArenaFull);
        }

        let token_client = token::TokenClient::new(&env, &config.stake_token);
        let arena_addr = env.current_contract_address();
        token_client.transfer(&player, &arena_addr, &config.entry_fee);

        // The vault's `deposit` pulls the fee with `transfer(arena, vault, fee)`.
        // The arena is not the direct invoker of that transfer (the vault is),
        // so without this pre-authorisation it fails under real auth and every
        // join reverts with VaultDepositFailed (#1636).
        env.authorize_as_current_contract(soroban_sdk::vec![
            &env,
            InvokerContractAuthEntry::Contract(SubContractInvocation {
                context: ContractContext {
                    contract: config.stake_token.clone(),
                    fn_name: Symbol::new(&env, "transfer"),
                    args: (arena_addr.clone(), config.yield_vault.clone(), config.entry_fee)
                        .into_val(&env),
                },
                sub_invocations: soroban_sdk::vec![&env],
            }),
        ]);

        // Deposit entry fee into vault and return an error if it fails.
        // The token transfer above will be rolled back together with any storage mutations
        // when we return an error, so no funds are permanently locked.
        let rwa_client = RwaAdapterClient::new(&env, &config.yield_vault);
        if rwa_client
            .try_deposit(&arena_addr, &config.entry_fee)
            .is_err()
        {
            return Err(ArenaError::VaultDepositFailed);
        }

        let baseline = ArenaStorage::load_last_vault_balance(&env).saturating_add(config.entry_fee);
        ArenaStorage::save_last_vault_balance(&env, baseline);

        ArenaStorage::add_player(&env, &player);
        let count = ArenaStorage::load_roster_count(&env);
        ArenaEvents::player_joined(&env, &player, count);
        ArenaStorage::exit_reentrancy_guard(&env);
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
    /// extend TTLs, and touches at most four storage entries.
    ///
    /// # Errors
    /// - `ArenaError::NotInitialized` if `initialize` has not been called.
    pub fn get_player_status(env: Env, player: Address) -> Result<PlayerStatus, ArenaError> {
        let config = ArenaStorage::peek_config(&env)?;
        let round_running = config.state == GameState::Active;
        let current_round = if roun…36435 tokens truncated…d(&p1),
            Err(Ok(ArenaError::RefundAlreadyClaimed))
        );
        client.claim_refund(&p2);
        assert_eq!(token_client.balance(&p2), 1000);
        assert_eq!(token_client.balance(&contract_id), 0);
    }

    /// A pause must not turn non-players into refund recipients once the
    /// contract is unpaused again.
    #[test]
    fn claim_refund_rejects_non_players_after_paused_force_cancel() {
        let (env, client, _contract_id, token_client, _p1, _p2) = setup_cancellable_arena();
        let stranger = Address::generate(&env);

        client.pause(&symbol_short!("emerg"));
        client.force_cancel_arena();
        assert_eq!(
            paused_error(client.try_claim_refund(&stranger)),
            ArenaError::ContractPaused
        );

        client.unpause();
        assert_eq!(
            client.try_claim_refund(&stranger),
            Err(Ok(ArenaError::NotAPlayer))
        );
        assert_eq!(token_client.balance(&stranger), 0);
    }

    #[test]
    fn test_leaderboard_sorting() {
        let env = Env::default();
        env.mock_all_auths();
        let contract_id = env.register(ArenaContract, ());
        let oracle_id = env.register(MockOracle, ());

        let admin = Address::generate(&env);
        let _client = ArenaContractClient::new(&env, &contract_id);

        env.as_contract(&contract_id, || {
            let config = ArenaConfig {
                admin,
                stake_token: Address::generate(&env),
                yield_vault: Address::generate(&env),
                entry_fee: 100,
                state: GameState::Active,
                paused: false,
                player_count: 3,
                active_player_count: 3,
                cumulative_yield: 0,
                commit_deadline: 0,
                round_count: 0,
                oracle_contract: oracle_id,
                factory: Address::generate(&env),
                pool_id: 0,
                platform_fee_bps: 1000,
            };
            ArenaStorage::save_config(&env, &config);

            let p1 = Address::generate(&env);
            let p2 = Address::generate(&env);
            let p3 = Address::generate(&env);

            ArenaStorage::add_player(&env, &p1);
            ArenaStorage::add_player(&env, &p2);
            ArenaStorage::add_player(&env, &p3);

            // Mock player survival states: p1 survived 3 rounds, p2 survived 5 rounds, p3 survived 1 round
            ArenaStorage::save_player(
                &env,
                &p1,
                &PlayerState {
                    active: true,
                    rounds_survived: 3,
                },
            );
            ArenaStorage::save_player(
                &env,
                &p2,
                &PlayerState {
                    active: true,
                    rounds_survived: 5,
                },
            );
            ArenaStorage::save_player(
                &env,
                &p3,
                &PlayerState {
                    active: true,
                    rounds_survived: 1,
                },
            );

            // Build leaderboard
            build_leaderboard(&env);

            let leaderboard = ArenaStorage::load_leaderboard(&env);
            assert_eq!(leaderboard.len(), 3);

            // Should be sorted by rounds_survived descending: p2 (5), p1 (3), p3 (1)
            let e0: LeaderboardEntry = leaderboard.get(0).unwrap();
            let e1: LeaderboardEntry = leaderboard.get(1).unwrap();
            let e2: LeaderboardEntry = leaderboard.get(2).unwrap();

            assert_eq!(e0.player, p2);
            assert_eq!(e0.rounds_survived, 5);

            assert_eq!(e1.player, p1);
            assert_eq!(e1.rounds_survived, 3);

            assert_eq!(e2.player, p3);
            assert_eq!(e2.rounds_survived, 1);
        });
    }

    #[test]
    fn test_leaderboard_limit_enforcement() {
        let env = Env::default();
        env.mock_all_auths();
        let contract_id = env.register(ArenaContract, ());
        let oracle_id = env.register(MockOracle, ());
        let admin = Address::generate(&env);
        let client = ArenaContractClient::new(&env, &contract_id);

        env.as_contract(&contract_id, || {
            let config = ArenaConfig {
                admin: admin.clone(),
                stake_token: Address::generate(&env),
                yield_vault: Address::generate(&env),
                entry_fee: 100,
                state: GameState::Active,
                paused: false,
                player_count: 20,
                active_player_count: 20,
                cumulative_yield: 0,
                commit_deadline: 0,
                round_count: 0,
                oracle_contract: oracle_id,
                factory: Address::generate(&env),
                pool_id: 0,
                platform_fee_bps: 1000,
            };
            ArenaStorage::save_config(&env, &config);

            for rounds_survived in 0..20 {
                let player = Address::generate(&env);
                ArenaStorage::add_player(&env, &player);
                ArenaStorage::save_player(
                    &env,
                    &player,
                    &PlayerState {
                        active: true,
                        rounds_survived,
                    },
                );
            }

            assert_eq!(ArenaStorage::load_leaderboard_limit(&env), 100);
            build_leaderboard(&env);
            assert_eq!(ArenaStorage::load_leaderboard(&env).len(), 20);
        });

        client.configure_leaderboard_limit(&10);

        env.as_contract(&contract_id, || {
            assert_eq!(ArenaStorage::load_leaderboard_limit(&env), 10);
            build_leaderboard(&env);

            let leaderboard = ArenaStorage::load_leaderboard(&env);
            assert_eq!(leaderboard.len(), 10);

            for i in 0..10 {
                let entry: LeaderboardEntry = leaderboard.get(i).unwrap();
                assert_eq!(entry.rounds_survived, 19 - i);
            }
        });
    }

    #[test]
    fn configure_leaderboard_limit_rejects_out_of_bounds_without_persisting() {
        let (env, client) = setup(0);
        let contract_id = client.address.clone();

        assert_eq!(
            client.try_configure_leaderboard_limit(&0),
            Err(Ok(ArenaError::InvalidLeaderboardLimit))
        );
        assert_eq!(
            client.try_configure_leaderboard_limit(&(types::MAX_LEADERBOARD_LIMIT + 1)),
            Err(Ok(ArenaError::InvalidLeaderboardLimit))
        );
        assert_eq!(
            client.try_configure_leaderboard_limit(&u32::MAX),
            Err(Ok(ArenaError::InvalidLeaderboardLimit))
        );
        env.as_contract(&contract_id, || {
            assert_eq!(ArenaStorage::load_leaderboard_limit(&env), 100);
        });

        // Boundary values are accepted.
        client.configure_leaderboard_limit(&1);
        client.configure_leaderboard_limit(&types::MAX_LEADERBOARD_LIMIT);
        env.as_contract(&contract_id, || {
            assert_eq!(
                ArenaStorage::load_leaderboard_limit(&env),
                types::MAX_LEADERBOARD_LIMIT
            );
        });
    }

    #[test]
    fn get_platform_fee_bps_defaults_to_1000() {
        let env = Env::default();
        let contract_id = env.register(ArenaContract, ());
        let client = ArenaContractClient::new(&env, &contract_id);
        assert_eq!(client.get_platform_fee_bps(), 1000);
    }

    #[test]
    fn update_platform_fee_rejects_over_max() {
        let (_env, client) = setup(0);
        let result = client.try_update_platform_fee(&1001);
        assert_eq!(result, Err(Ok(ArenaError::InvalidPlatformFee)));
    }

    #[test]
    fn update_platform_fee_updates_stored_value_and_emits_event() {
        let (env, client) = setup(0);
        let admin = env.as_contract(&client.address, || {
            ArenaStorage::load_config(&env).unwrap().admin
        });

        // Check the event from this specific call — env.events().all() only
        // reflects the most recent top-level contract invocation, so nothing
        // else should be called on `client` between this and the assertion.
        client.update_platform_fee(&250);

        let events = env.events().all();
        let expected_topic: soroban_sdk::Vec<Val> =
            (symbol_short!("arena"), symbol_short!("fee_upd"), admin).into_val(&env);
        let has_fee_event = events
            .iter()
            .any(|(contract, topics, _data)| contract == client.address && topics == expected_topic);
        assert!(has_fee_event, "must emit fee_upd event");

        // Verify the stored value directly (bypassing the client so we don't
        // disturb the event recording above with another top-level call).
        env.as_contract(&client.address, || {
            assert_eq!(ArenaStorage::load_platform_fee_bps(&env), 250);
        });
    }

    // ── Coverage added for issue #1512 (freshness policy config) ──────────

    #[test]
    fn get_oracle_contract_returns_configured_oracle() {
        let (env, client) = setup(0);
        let expected = env.as_contract(&client.address, || {
            ArenaStorage::load_config(&env).unwrap().oracle_contract
        });
        assert_eq!(client.get_oracle_contract(), expected);
    }

    #[test]
    fn get_pool_config_returns_the_stored_configuration() {
        let (env, client) = setup(0);
        let (stake_token, yield_vault, entry_fee, oracle, factory) = env
            .as_contract(&client.address, || {
                let config = ArenaStorage::load_config(&env).unwrap();
                ArenaStorage::save_player_limits(&env, 3, 12);
                (
                    config.stake_token,
                    config.yield_vault,
                    config.entry_fee,
                    config.oracle_contract,
                    config.factory,
                )
            });

        let view = client.get_pool_config();
        assert_eq!(view.stake_token, stake_token);
        assert_eq!(view.yield_vault, yield_vault);
        assert_eq!(view.entry_fee, entry_fee);
        assert_eq!(view.oracle_contract, oracle);
        assert_eq!(view.min_players, 3);
        assert_eq!(view.max_players, 12);
        // The duration is only recorded at `start_round`, not `initialize`.
        assert_eq!(view.round_duration, 0);
        assert_eq!(view.start_deadline, 0);
        assert_eq!(view.factory, factory);
    }

    #[test]
    fn get_pool_config_reports_recorded_round_duration_after_start() {
        let (env, client) = setup(0);
        env.as_contract(&client.address, || {
            ArenaStorage::save_player_limits(&env, 2, 2);
            ArenaStorage::save_round_duration(&env, 900);
            ArenaStorage::save_start_deadline(&env, 1_700_000_000);
        });
        let view = client.get_pool_config();
        assert_eq!(view.round_duration, 900);
        assert_eq!(view.start_deadline, 1_700_000_000);
    }

    #[test]
    fn get_pool_config_errors_before_initialize() {
        let env = Env::default();
        let contract_id = env.register(ArenaContract, ());
        let client = ArenaContractClient::new(&env, &contract_id);
        let result = client.try_get_pool_config();
        assert_eq!(result, Err(Ok(ArenaError::NotInitialized)));
    }

    #[test]
    fn get_oracle_freshness_policy_defaults_before_configuration() {
        let (_env, client) = setup(0);
        let policy = client.get_oracle_freshness_policy();
        assert_eq!(policy.max_age_secs, types::DEFAULT_ORACLE_MAX_AGE_SECS);
        assert_eq!(policy.warn_age_secs, types::DEFAULT_ORACLE_WARN_AGE_SECS);
        assert_eq!(policy.version, types::FRESHNESS_POLICY_VERSION);
    }

    #[test]
    fn set_oracle_freshness_policy_updates_stored_value_and_emits_event() {
        let (env, client) = setup(0);
        let admin = env.as_contract(&client.address, || {
            ArenaStorage::load_config(&env).unwrap().admin
        });

        client.set_oracle_freshness_policy(&7_200, &3_600);

        let events = env.events().all();
        let expected_topic: soroban_sdk::Vec<Val> =
            (symbol_short!("arena"), symbol_short!("frsh_pol"), admin).into_val(&env);
        let has_event = events
            .iter()
            .any(|(contract, topics, _data)| contract == client.address && topics == expected_topic);
        assert!(has_event, "must emit frsh_pol event");

        let policy = client.get_oracle_freshness_policy();
        assert_eq!(policy.max_age_secs, 7_200);
        assert_eq!(policy.warn_age_secs, 3_600);
    }

    #[test]
    fn set_oracle_freshness_policy_rejects_warn_greater_than_max() {
        let (_env, client) = setup(0);
        let result = client.try_set_oracle_freshness_policy(&100, &200);
        assert_eq!(result, Err(Ok(ArenaError::InvalidFreshnessPolicy)));
    }

    #[test]
    fn set_oracle_freshness_policy_rejects_zero_max_age() {
        let (_env, client) = setup(0);
        let result = client.try_set_oracle_freshness_policy(&0, &0);
        assert_eq!(result, Err(Ok(ArenaError::InvalidFreshnessPolicy)));
    }

    #[test]
    fn set_oracle_freshness_policy_rejects_above_hard_ceiling() {
        let (_env, client) = setup(0);
        let result = client.try_set_oracle_freshness_policy(
            &(types::MAX_ORACLE_MAX_AGE_SECS + 1),
            &100,
        );
        assert_eq!(result, Err(Ok(ArenaError::InvalidFreshnessPolicy)));
    }

    #[test]
    fn set_oracle_freshness_policy_accepts_equal_warn_and_max() {
        let (_env, client) = setup(0);
        client.set_oracle_freshness_policy(&1_000, &1_000);
        let policy = client.get_oracle_freshness_policy();
        assert_eq!(policy.max_age_secs, 1_000);
        assert_eq!(policy.warn_age_secs, 1_000);
    }

    #[test]
    fn set_oracle_freshness_policy_at_hard_ceiling_is_accepted() {
        let (_env, client) = setup(0);
        client.set_oracle_freshness_policy(&types::MAX_ORACLE_MAX_AGE_SECS, &100);
        assert_eq!(
            client.get_oracle_freshness_policy().max_age_secs,
            types::MAX_ORACLE_MAX_AGE_SECS
        );
    }

    #[test]
    fn update_platform_fee_at_max_boundary_succeeds() {
        let (_env, client) = setup(0);
        client.update_platform_fee(&1000);
        assert_eq!(client.get_platform_fee_bps(), 1000);
    }

    // --- Issue 1: initialize rejects invalid entry fees ---

    #[test]
    fn initialize_rejects_zero_entry_fee() {
        let env = Env::default();
        env.mock_all_auths();
        let contract_id = env.register(ArenaContract, ());
        let oracle_id = env.register(MockOracle, ());
        let vault_id = env.register(MockVault, ());
        let token_admin = Address::generate(&env);
        let token_id = env
            .register_stellar_asset_contract_v2(token_admin)
            .address();

        let admin = Address::generate(&env);
        let client = ArenaContractClient::new(&env, &contract_id);
        let result = client.try_initialize(
            &admin,
            &token_id,
            &vault_id,
            &0,
            &oracle_id,
            &Address::generate(&env),
            &1u32,
            &2u32,
            &10u32,
            &60u64,
        );
        assert_eq!(result, Err(Ok(ArenaError::InvalidEntryFee)));
    }

    #[test]
    fn initialize_rejects_negative_entry_fee() {
        let env = Env::default();
        env.mock_all_auths();
        let contract_id = env.register(ArenaContract, ());
        let oracle_id = env.register(MockOracle, ());
        let vault_id = env.register(MockVault, ());
        let token_admin = Address::generate(&env);
        let token_id = env
            .register_stellar_asset_contract_v2(token_admin)
            .address();

        let admin = Address::generate(&env);
        let client = ArenaContractClient::new(&env, &contract_id);
        let result = client.try_initialize(
            &admin,
            &token_id,
            &vault_id,
            &-1,
            &oracle_id,
            &Address::generate(&env),
            &1u32,
            &2u32,
            &10u32,
            &60u64,
        );
        assert_eq!(result, Err(Ok(ArenaError::InvalidEntryFee)));
    }

    #[test]
    fn initialize_accepts_positive_entry_fee() {
        let env = Env::default();
        env.mock_all_auths();
        let contract_id = env.register(ArenaContract, ());
        let oracle_id = env.register(MockOracle, ());
        let vault_id = env.register(MockVault, ());
        let token_admin = Address::generate(&env);
        let token_id = env
            .register_stellar_asset_contract_v2(token_admin)
            .address();

        let admin = Address::generate(&env);
        let client = ArenaContractClient::new(&env, &contract_id);
        assert!(
            client
                .try_initialize(
                    &admin,
                    &token_id,
                    &vault_id,
                    &1,
                    &oracle_id,
                    &Address::generate(&env),
                    &1u32,
                    &2u32,
                    &10u32,
                    &60u64
                )
                .is_ok()
        );
    }

    // --- Issue 2/4: submit_commitment rejects non-players, eliminated players, and timing violations ---

    #[test]
    fn submit_commitment_rejects_non_player() {
        let env = Env::default();
        env.mock_all_auths();
        let contract_id = env.register(ArenaContract, ());
        let oracle_id = env.register(MockOracle, ());
        let vault_id = env.register(MockVault, ());
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

        // Add two real players and start round so state is Active
        let p1 = Address::generate(&env);
        let p2 = Address::generate(&env);
        token_admin_client.mint(&p1, &1000);
        token_admin_client.mint(&p2, &1000);
        client.join_arena(&p1);
        client.join_arena(&p2);
        env.ledger().with_mut(|li| li.timestamp = 1000);
        client.start_round(&60);

        // A non-player (never joined) tries to submit commitment
        let stranger = Address::generate(&env);
        let commitment = BytesN::from_array(&env, &[1u8; 32]);
        let result = client.try_submit_commitment(&stranger, &commitment);
        assert_eq!(result, Err(Ok(ArenaError::NotAPlayer)));
    }

    #[test]
    fn submit_commitment_rejects_eliminated_player() {
        let env = Env::default();
        env.mock_all_auths();
        let contract_id = env.register(ArenaContract, ());
        let oracle_id = env.register(MockOracle, ());
        let vault_id = env.register(MockVault, ());
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
        token_admin_client.mint(&p1, &1000);
        token_admin_client.mint(&p2, &1000);
        client.join_arena(&p1);
        client.join_arena(&p2);
        env.ledger().with_mut(|li| li.timestamp = 1000);
        client.start_round(&60);

        // Mark p1 as eliminated
        env.as_contract(&contract_id, || {
            ArenaStorage::save_player(
                &env,
                &p1,
                &PlayerState {
                    active: false,
                    rounds_survived: 0,
                },
            );
        });

        let commitment = BytesN::from_array(&env, &[1u8; 32]);
        let result = client.try_submit_commitment(&p1, &commitment);
        assert_eq!(result, Err(Ok(ArenaError::PlayerEliminated)));
    }

    #[test]
    fn submit_commitment_rejects_when_round_not_active() {
        let env = Env::default();
        env.mock_all_auths();
        let contract_id = env.register(ArenaContract, ());
        let oracle_id = env.register(MockOracle, ());
        let vault_id = env.register(MockVault, ());
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

        let player = Address::generate(&env);
        token_admin_client.mint(&player, &1000);
        client.join_arena(&player);

        // Arena is Open (not Active) — commitment should be rejected
        let commitment = BytesN::from_array(&env, &[1u8; 32]);
        let result = client.try_submit_commitment(&player, &commitment);
        assert_eq!(result, Err(Ok(ArenaError::RoundNotActive)));
    }

    #[test]
    fn submit_commitment_rejects_after_deadline() {
        let env = Env::default();
        env.mock_all_auths();
        let contract_id = env.register(ArenaContract, ());
        let oracle_id = env.register(MockOracle, ());
        let vault_id = env.register(MockVault, ());
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
        token_admin_client.mint(&p1, &1000);
        token_admin_client.mint(&p2, &1000);
        client.join_arena(&p1);
        client.join_arena(&p2);

        // Start round
        env.ledger().with_mut(|li| li.timestamp = 1000);
        client.start_round(&60);

        // Advance past deadline
        env.ledger().with_mut(|li| li.timestamp = 1061);

        let commitment = BytesN::from_array(&env, &[1u8; 32]);
        let result = client.try_submit_commitment(&p1, &commitment);
        assert_eq!(result, Err(Ok(ArenaError::CommitPhaseEnded)));
    }

    // --- Issue #953: events emitted for submit_commitment and reveal_choice ---

    #[test]
    fn commitment_submitted_emits_event() {
        let env = Env::default();
        env.mock_all_auths();
        let contract_id = env.register(ArenaContract, ());
        let oracle_id = env.register(MockOracle, ());
        let vault_id = env.register(MockVault, ());
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
        token_admin_client.mint(&p1, &1000);
        token_admin_client.mint(&p2, &1000);
        client.join_arena(&p1);
        client.join_arena(&p2);
        env.ledger().with_mut(|li| li.timestamp = 1000);
        client.start_round(&60);

        let commitment = BytesN::from_array(&env, &[1u8; 32]);
        client.submit_commitment(&p1, &commitment);

        let events = env.events().all();
        let expected_topic: soroban_sdk::Vec<Val> =
            (symbol_short!("arena"), symbol_short!("commit"), p1.clone()).into_val(&env);
        let event_found = events.iter().any(|(contract, topics, _data)| {
            contract == client.address && topics == expected_topic
        });
        assert!(
            event_found,
            "commitment_submitted event must be emitted after submit_commitment"
        );
    }

    #[test]
    fn choice_revealed_emits_event() {
        let env = Env::default();
        env.mock_all_auths();
        let contract_id = env.register(ArenaContract, ());
        let oracle_id = env.register(MockOracle, ());
        let vault_id = env.register(MockVault, ());
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
        token_admin_client.mint(&p1, &1000);
        token_admin_client.mint(&p2, &1000);
        client.join_arena(&p1);
        client.join_arena(&p2);
        env.ledger().with_mut(|li| li.timestamp = 1000);
        client.start_round(&60);

        let salt = BytesN::from_array(&env, &[1u8; 32]);
        let commitment = compute_commitment(&env, &contract_id, 1, &p1, Choice::Heads, &salt);
        client.submit_commitment(&p1, &commitment);
        client.submit_commitment(&p2, &commitment);

        env.ledger().with_mut(|li| li.timestamp = 1061);
        client.reveal_choice(&p1, &Choice::Heads, &salt);

        let events = env.events().all();
        let expected_topic: soroban_sdk::Vec<Val> =
            (symbol_short!("arena"), symbol_short!("reveal"), p1.clone()).into_val(&env);
        let event_found = events.iter().any(|(contract, topics, _data)| {
            contract == client.address && topics == expected_topic
        });
        assert!(
            event_found,
            "choice_revealed event must be emitted after reveal_choice"
        );
    }

    // --- Issue #761: start_round rejects Finished state ---

    #[test]
    fn start_round_rejects_finished_state() {
        let env = Env::default();
        env.mock_all_auths();
        let contract_id = env.register(ArenaContract, ());
        let oracle_id = env.register(MockOracle, ());
        let vault_id = env.register(MockVault, ());
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
        token_admin_client.mint(&p1, &1000);
        token_admin_client.mint(&p2, &1000);
        client.join_arena(&p1);
        client.join_arena(&p2);

        // Force state to Finished
        env.as_contract(&contract_id, || {
            let mut config = ArenaStorage::load_config(&env).unwrap();
            config.state = GameState::Finished;
            ArenaStorage::save_config(&env, &config);
        });

        let result = client.try_start_round(&60);
        assert_eq!(result, Err(Ok(ArenaError::InvalidGameState)));
    }

    // --- Issue 3: choices and commitments cleared after resolve_round ---

    #[test]
    fn choices_and_commitments_cleared_after_resolve_round() {
        let env = Env::default();
        env.mock_all_auths();
        let contract_id = env.register(ArenaContract, ());
        let oracle_id = env.register(MockOracle, ());
        let vault_id = env.register(MockVault, ());
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
        token_admin_client.mint(&p1, &1000);
        token_admin_client.mint(&p2, &1000);
        client.join_arena(&p1);
        client.join_arena(&p2);

        // Round 1: commit and reveal
        env.ledger().with_mut(|li| li.timestamp = 1000);
        client.start_round(&60);
        let salt = BytesN::from_array(&env, &[1u8; 32]);
        let comm = compute_commitment(&env, &contract_id, 1, &p1, Choice::Heads, &salt);
        client.submit_commitment(&p1, &comm);
        client.submit_commitment(&p2, &comm);
        env.ledger().with_mut(|li| li.timestamp = 1061);
        client.reveal_choice(&p1, &Choice::Heads, &salt);
        client.reveal_choice(&p2, &Choice::Heads, &salt);

        // After resolve_round, choices and commitments should be cleared
        client.resolve_round();

        env.as_contract(&contract_id, || {
            assert!(
                ArenaStorage::load_choice(&env, &p1, 1).is_none(),
                "choice should be cleared after resolve_round"
            );
            assert!(
                ArenaStorage::load_commitment(&env, &p1, 1).is_none(),
                "commitment should be cleared after resolve_round"
            );
            assert!(
                ArenaStorage::load_choice(&env, &p2, 1).is_none(),
                "choice should be cleared after resolve_round"
            );
            assert!(
                ArenaStorage::load_commitment(&env, &p2, 1).is_none(),
                "commitment should be cleared after resolve_round"
            );
        });
    }

    #[test]
    fn leaderboard_with_120_players_is_sorted_and_capped() {
        const N: u32 = 120;
        const LIMIT: u32 = 50;

        let env = Env::default();
            env.mock_all_auths();
            let contract_id = env.register(ArenaContract, ());
            let oracle_id = env.register(MockOracle, ());

            env.as_contract(&contract_id, || {
                ArenaStorage::save_config(
                    &env,
                    &ArenaConfig {
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
                    },
                );
                ArenaStorage::save_leaderboard_limit(&env, LIMIT);

                // Player i gets rounds_survived = i, so player N-1 has the highest score.
                for i in 0..N {
                    let player = Address::generate(&env);
                    ArenaStorage::add_player(&env, &player);
                    ArenaStorage::save_player(
                        &env,
                        &player,
                        &PlayerState {
                            active: true,
                            rounds_survived: i,
                        },
                    );
                }

                build_leaderboard(&env);

                let board = ArenaStorage::load_leaderboard(&env);
                assert_eq!(board.len(), LIMIT, "leaderboard must be capped at limit");

                // Entries must be in strictly descending order of rounds_survived.
                let mut prev_rs = u32::MAX;
                for idx in 0..LIMIT {
                    let entry: LeaderboardEntry = board.get(idx).unwrap();
                    assert!(
                        entry.rounds_survived <= prev_rs,
                        "leaderboard not sorted descending at index {idx}"
                    );
                    prev_rs = entry.rounds_survived;
                }

                // Top entry must have the maximum rounds_survived.
                assert_eq!(
                    board.get(0).unwrap().rounds_survived,
                    N - 1,
                    "first entry must have the highest rounds_survived"
                );
            });
        }

    #[test]
    fn start_round_rejects_duration_below_minimum() {
        let (_env, client) = setup(2);
        let err = client
            .try_start_round(&(MIN_ROUND_DURATION_SECONDS - 1))
            .err()
            .expect("duration below minimum must be rejected")
            .expect("error must be a contract error");
        assert_eq!(err, ArenaError::InvalidDuration);
    }

    #[test]
    fn start_round_rejects_duration_above_maximum() {
        let (_env, client) = setup(2);
        let err = client
            .try_start_round(&(MAX_ROUND_DURATION_SECONDS + 1))
            .err()
            .expect("duration above maximum must be rejected")
            .expect("error must be a contract error");
        assert_eq!(err, ArenaError::InvalidDuration);
    }

    #[test]
    fn start_round_rejects_u64_max_duration() {
        // Regression test: u64::MAX duration would set commit_deadline unreachably
        // far in the future, locking all player funds indefinitely. This is the
        // exact fund-lock scenario the MAX_ROUND_DURATION_SECONDS constant's
        // comment warns about.
        let (_env, client) = setup(2);
        let err = client
            .try_start_round(&u64::MAX)
            .err()
            .expect("u64::MAX duration must be rejected")
            .expect("error must be a contract error");
        assert_eq!(
            err,
            ArenaError::InvalidDuration,
            "u64::MAX must be rejected, not cause indefinite fund lock"
        );
    }

    #[test]
    fn start_round_accepts_minimum_valid_duration() {
        let (_env, client) = setup(2);
        let result = client.try_start_round(&MIN_ROUND_DURATION_SECONDS);
        assert!(
            result.is_ok(),
            "minimum valid duration must be accepted"
        );
    }

    #[test]
    fn start_round_accepts_maximum_valid_duration() {
        let (_env, client) = setup(2);
        let result = client.try_start_round(&MAX_ROUND_DURATION_SECONDS);
        assert!(
            result.is_ok(),
            "maximum valid duration must be accepted"
        );
    }

    #[test]
    fn resolve_round_with_zero_survivors_transitions_to_cancelled() {
        // Regression test: when all remaining active players fail to reveal their choice
        // (e.g., both AFKs in a 2-player round), the arena should transition to Cancelled
        // to enable claim_refund recovery instead of becoming permanently locked.
        let (env, client) = setup(2);
        
        // Whitelist and set up arena
        env.mock_all_auths();
        let admin = Address::generate(&env);
        let players: [Address; 2] = [Address::generate(&env), Address::generate(&env)];
        
        let oracle_id = env.register(MockOracle, ());
        let vault_id = env.register(MockVault, ());
        let stake_token = Address::generate(&env);
        
        env.as_contract(&client.address, || {
            let config = ArenaConfig {
                admin: admin.clone(),
                stake_token: stake_token.clone(),
                entry_fee: 100,
                state: GameState::Open,
                paused: false,
                player_count: 2,
                active_player_count: 2,
                cumulative_yield: 0,
                commit_deadline: 0,
                yield_vault: vault_id.clone(),
                round_count: 0,
                oracle_contract: oracle_id.clone(),
                factory: Address::generate(&env),
                pool_id: 0,
                platform_fee_bps: 1000,
            };
            ArenaStorage::save_config(&env, &config);
            ArenaStorage::save_player_limits(&env, 2, 2);
            
            for player in players.iter() {
                ArenaStorage::add_player(&env, &player);
            }
        });
        
        // Start a round
        env.ledger().with_mut(|li| li.timestamp = 1000);
        client.start_round(&MIN_ROUND_DURATION_SECONDS);

        // Advance time past the commit deadline WITHOUT any player revealing
        env.ledger()
            .with_mut(|li| li.timestamp = 1000 + MIN_ROUND_DURATION_SECONDS + 1);
        
        // Resolve the round
        client.resolve_round();
        
        // Get the arena config and verify it transitioned to Cancelled, not Finished
        env.as_contract(&client.address, || {
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
                "no winner should be set in zero-survivor scenario"
            );
        });
    }
} // close mod test
#[cfg(test)]
mod integration_tests;
#[cfg(test)]
mod join_arena_tests;
#[cfg(test)]
mod lobby_tests;
#[cfg(test)]
mod player_status_tests;
#[cfg(test)]
mod global_pause_tests;
#[cfg(test)]
#[cfg_attr(coverage_nightly, coverage(off))]
mod commitment_vectors;
#[cfg(test)]
mod temp_storage_tests;
#[cfg(test)]
mod auth_tests;
#[cfg(test)]
mod conservation_tests;
#[cfg(test)]
mod settlement_security_tests;
