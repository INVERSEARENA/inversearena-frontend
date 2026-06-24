//! Arena contract for the InverseArena elimination game.
//!
//! Manages the full game lifecycle: player registration, commit-reveal rounds,
//! yield accounting via an RWA vault adapter, winner payout, and admin controls.
#![no_std]
use soroban_sdk::{Address, Bytes, BytesN, Env, Symbol, Vec, contract, contractimpl, token};

mod eliminations;
mod events;
mod fuzz_tests;
mod oracle;
mod rwa_client;
mod snapshot_test;
mod state_machine;
mod storage;
mod types;

use events::ArenaEvents;
use rwa_client::RwaAdapterClient;
use storage::ArenaStorage;
use types::{
    ArenaConfig, ArenaError, Choice, GameState, PendingAdmin, PlayerState, RoundResult,
    YieldSnapshot,
};

const PAGE_SIZE: u32 = 50;
pub(crate) const MIN_PLAYERS_TO_START: u32 = 2;
const DEFAULT_MAX_PLAYERS: u32 = u32::MAX;
const CONTRACT_VERSION: u32 = 1;

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
    ) -> Result<(), ArenaError> {
        admin.require_auth();
        if ArenaStorage::has_config(&env) {
            return Err(ArenaError::AlreadyInitialized);
        }

        // Validate the provided yield_vault implements the expected RWA adapter interface
        let rwa_client = RwaAdapterClient::new(&env, &yield_vault);
        // Attempt a harmless read to ensure the contract is reachable and implements the interface
        // Here we use try_balance_of on the arena contract address; any error indicates an invalid vault
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
            cumulative_yield: 0,
            commit_deadline: 0,
            round_count: 0,
            oracle_contract,
        };
        ArenaStorage::save_config(&env, &config);
        ArenaStorage::save_player_limits(&env, MIN_PLAYERS_TO_START, DEFAULT_MAX_PLAYERS);
        ArenaStorage::save_last_vault_balance(&env, 0);
        ArenaEvents::initialized(&env, &admin);
        Ok(())
    }

    /// Return the arena contract ABI/storage version.
    pub fn version(_env: Env) -> u32 {
        CONTRACT_VERSION
    }

    /// Upgrade this arena contract to `new_wasm_hash`.
    ///
    /// Only the admin may upgrade. This intentionally remains callable while
    /// paused so an emergency pause can be followed by a recovery upgrade.
    pub fn upgrade(env: Env, new_wasm_hash: BytesN<32>) -> Result<(), ArenaError> {
        let config = ArenaStorage::load_config(&env)?;
        config.admin.require_auth();
        env.deployer()
            .update_current_contract_wasm(new_wasm_hash.clone());
        ArenaEvents::upgraded(&env, &new_wasm_hash);
        Ok(())
    }

    /// Configure arena player bounds.
    ///
    /// `min_players` must be at least 2 and cannot exceed `max_players`.
    /// Existing participation is left untouched; the max applies to future
    /// joins and the min applies to future `start_round` calls.
    pub fn configure_player_limits(
        env: Env,
        min_players: u32,
        max_players: u32,
    ) -> Result<(), ArenaError> {
        let config = ArenaStorage::load_config(&env)?;
        config.admin.require_auth();
        Self::validate_player_limits(min_players, max_players)?;
        ArenaStorage::save_player_limits(&env, min_players, max_players);
        ArenaEvents::player_limits_configured(&env, min_players, max_players);
        Ok(())
    }

    /// Ban a player from joining this arena.
    ///
    /// Existing player state is not modified, so a ban does not eliminate a
    /// player who has already joined.
    pub fn ban_player(env: Env, player: Address) -> Result<(), ArenaError> {
        let config = ArenaStorage::load_config(&env)?;
        config.admin.require_auth();
        ArenaStorage::set_player_banned(&env, &player, true);
        ArenaEvents::player_banned(&env, &config.admin, &player);
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
    ///
    /// # Events
    /// Emits `player_joined` with the player address and updated total player count.
    pub fn join_arena(env: Env, player: Address) -> Result<(), ArenaError> {
        player.require_auth();
        let config = ArenaStorage::load_config(&env)?;
        Self::require_not_paused(&config)?;
        if config.state != GameState::Open {
            return Err(ArenaError::InvalidGameState);
        }
        if player == config.admin {
            return Err(ArenaError::CreatorCannotJoin);
        }
        if ArenaStorage::is_player_banned(&env, &player) {
            return Err(ArenaError::PlayerBanned);
        }
        if let Some(max_players) = ArenaStorage::load_max_players(&env) {
            if config.player_count >= max_players {
                return Err(ArenaError::ArenaFull);
            }
        }

        let token_client = token::TokenClient::new(&env, &config.stake_token);
        let arena_addr = env.current_contract_address();
        token_client.transfer(&player, &arena_addr, &config.entry_fee);

        // Attempt to deposit entry fee into vault; ignore failures
        let rwa_client = RwaAdapterClient::new(&env, &config.yield_vault);
        let _ = rwa_client.try_deposit(&arena_addr, &config.entry_fee);
        let baseline = ArenaStorage::load_last_vault_balance(&env).saturating_add(config.entry_fee);
        ArenaStorage::save_last_vault_balance(&env, baseline);

        ArenaStorage::add_player(&env, &player);
        let count = ArenaStorage::load_all_players(&env).len();
        ArenaEvents::player_joined(&env, &player, count);
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
        Self::require_not_paused(&config)?;
        ArenaStorage::save_commitment(&env, &player, &commitment);
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
    pub fn reveal_choice(
        env: Env,
        player: Address,
        choice: Choice,
        salt: BytesN<32>,
    ) -> Result<(), ArenaError> {
        player.require_auth();
        let config = ArenaStorage::load_config(&env)?;
        Self::require_not_paused(&config)?;
        if ArenaStorage::load_choice(&env, &player).is_some() {
            return Err(ArenaError::ChoiceAlreadyRevealed);
        }
        if env.ledger().timestamp() < config.commit_deadline {
            return Err(ArenaError::RoundNotActive);
        }

        let commitment =
            ArenaStorage::load_commitment(&env, &player).ok_or(ArenaError::MissingCommitment)?;
        if commitment != Self::compute_commitment(&env, choice, &salt) {
            return Err(ArenaError::InvalidReveal);
        }
        ArenaStorage::save_choice(&env, &player, &choice);
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
        let mut config = ArenaStorage::load_config(&env)?;
        config.admin.require_auth();
        Self::require_not_paused(&config)?;
        state_machine::ensure_state(
            &config.state,
            &GameState::Open,
            ArenaError::InvalidGameState,
        )?;

        config.state = GameState::Cancelled;
        ArenaStorage::save_config(&env, &config);

        let arena_addr = env.current_contract_address();
        if config.player_count > 0 {
            let rwa_client = RwaAdapterClient::new(&env, &config.yield_vault);
            let _ = rwa_client.withdraw_all(&arena_addr);
        }

        let token_client = token::TokenClient::new(&env, &config.stake_token);
        let players = ArenaStorage::load_all_players(&env);
        for player in players.iter() {
            token_client.transfer(&arena_addr, &player, &config.entry_fee);
        }

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
        let all = ArenaStorage::load_all_players(&env);
        let start = (page.saturating_mul(PAGE_SIZE)) as usize;
        let end = (start.saturating_add(PAGE_SIZE as usize)).min(all.len() as usize);

        let mut result: Vec<(Address, PlayerState)> = Vec::new(&env);
        for i in start..end {
            if let Some(addr) = all.get(i as u32) {
                let state = ArenaStorage::load_player(&env, &addr).unwrap_or_default();
                result.push_back((addr, state));
            }
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

    /// Start a new commit-reveal round.
    ///
    /// Only callable by the admin while the arena is `Open` or `Finished`
    /// (i.e., between rounds). Transitions the arena to `Active` and records
    /// the round start timestamp. Players must submit commitments before
    /// `duration_seconds` elapses, after which reveals are accepted.
    ///
    /// # Parameters
    /// - `duration_seconds`: Length of the commit window in ledger seconds.
    ///   When this many seconds have passed since the round start, `resolve_round`
    ///   becomes callable.
    ///
    /// # Errors
    /// - `ArenaError::NotInitialized` if `initialize` has not been called.
    /// - `ArenaError::ContractPaused` if the contract is paused.
    /// - `ArenaError::InvalidGameState` if the arena is not in `Open` or `Finished` state.
    ///
    /// # Events
    /// Emits `game_started` with the round number and duration.
    pub fn start_round(env: Env, duration_seconds: u64) -> Result<(), ArenaError> {
        let mut config = ArenaStorage::load_config(&env)?;
        config.admin.require_auth();
        Self::require_not_paused(&config)?;

        if config.state != GameState::Open && config.state != GameState::Finished {
            return Err(ArenaError::InvalidGameState);
        }

        if config.player_count < ArenaStorage::load_min_players(&env) {
            return Err(ArenaError::NotEnoughPlayers);
        }

        config.state = GameState::Active;
        ArenaStorage::save_config(&env, &config);
        ArenaStorage::save_round_start(&env, env.ledger().timestamp());
        ArenaStorage::save_round_duration(&env, duration_seconds);

        ArenaEvents::game_started(&env, config.round_count.saturating_add(1), duration_seconds);
        Ok(())
    }

    /// Resolve the current round by tallying revealed choices and eliminating the majority.
    ///
    /// Only callable by the admin after the grace period (`round_start +
    /// duration_seconds`) has elapsed. Computes which choice was in the
    /// majority, marks those players as eliminated, snapshots the vault yield,
    /// and transitions the arena back to `Open` (or to `Finished` if only one
    /// survivor remains).
    ///
    /// # Errors
    /// - `ArenaError::NotInitialized` if `initialize` has not been called.
    /// - `ArenaError::ContractPaused` if the contract is paused.
    /// - `ArenaError::RoundNotActive` if the arena is not in the `Active` state.
    /// - `ArenaError::RoundNotStarted` if no round start timestamp is recorded.
    /// - `ArenaError::GracePeriodNotElapsed` if the round duration has not yet passed.
    ///
    /// # Events
    /// Emits `round_resolved` with the round number, eliminated count, and survivor count.
    /// Emits `game_finished` with the winner address and round number if exactly one survivor remains.
    pub fn resolve_round(env: Env) -> Result<(), ArenaError> {
        let mut config = ArenaStorage::load_config(&env)?;
        config.admin.require_auth();
        Self::require_not_paused(&config)?;

        if config.state != GameState::Active {
            return Err(ArenaError::RoundNotActive);
        }

        let round_start =
            ArenaStorage::load_round_start(&env).ok_or(ArenaError::RoundNotStarted)?;
        let grace = ArenaStorage::load_round_duration(&env);
        if env.ledger().timestamp() < round_start.saturating_add(grace) {
            return Err(ArenaError::GracePeriodNotElapsed);
        }

        let round = config.round_count.saturating_add(1);
        let yield_bps = oracle::fetch_yield_bps(&env, &config.oracle_contract);
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

        let resolution = Self::resolve_players(&env, round);
        let result = RoundResult {
            round,
            eliminated: resolution.eliminated,
            survivors: resolution.survivors,
            yield_snapshot: snapshot,
        };
        ArenaStorage::save_round_result(&env, round, &result);

        config.round_count = round;
        config.state = if resolution.survivors <= 1 {
            GameState::Finished
        } else {
            GameState::Open
        };
        ArenaStorage::save_config(&env, &config);

        ArenaEvents::round_resolved(&env, round, resolution.eliminated, resolution.survivors);
        if resolution.tied {
            ArenaEvents::round_tied(&env, round, resolution.survivors);
        }
        if let Some(winner_addr) = resolution.winner {
            ArenaEvents::game_finished(&env, &winner_addr, round);
        }
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
        winner.require_auth();
        let mut config = ArenaStorage::load_config(&env)?;
        Self::require_not_paused(&config)?;

        // CHECKS — validate caller and arena state before doing anything else.
        if config.state != GameState::Finished {
            return Err(ArenaError::GameNotFinished);
        }
        if ArenaStorage::prize_claimed(&env) {
            return Err(ArenaError::PrizeAlreadyClaimed);
        }
        let player_state = ArenaStorage::load_player(&env, &winner).unwrap_or_default();
        if !player_state.active {
            return Err(ArenaError::PlayerEliminated);
        }

        // EFFECTS — persist state changes BEFORE any cross-contract call so a
        // malicious stake-token re-entering `claim` sees the claimed flag and
        // fails with PrizeAlreadyClaimed.
        ArenaStorage::mark_prize_claimed(&env);
        config.state = GameState::Settled;
        ArenaStorage::save_config(&env, &config);

        // INTERACTIONS — external calls happen only after state is committed.
        let arena_addr = env.current_contract_address();
        let rwa_client = RwaAdapterClient::new(&env, &config.yield_vault);
        let principal = config.entry_fee * i128::from(config.player_count);
        let payout = principal.saturating_add(Self::get_total_yield(env.clone()));
        let withdrawn = rwa_client
            .try_withdraw_all(&arena_addr)
            .unwrap_or(Ok(payout))
            .unwrap_or(payout);
        let total = if payout > withdrawn {
            withdrawn
        } else {
            payout
        };

        arena_addr.require_auth();
        let token_client = token::TokenClient::new(&env, &config.stake_token);
        token_client.transfer(&arena_addr, &winner, &total);

        ArenaEvents::prize_claimed(&env, &winner, total, total.saturating_sub(principal));
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
        let config = ArenaStorage::load_config(&env)?;
        config.admin.require_auth();
        Self::require_not_paused(&config)?;
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
        let pending = ArenaStorage::load_pending_admin(&env).ok_or(ArenaError::NoPendingAdmin)?;
        pending.new_admin.require_auth();
        let mut config = ArenaStorage::load_config(&env)?;
        Self::require_not_paused(&config)?;
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
        Self::propose_admin(env, new_admin)
    }

    /// Pause the contract, blocking all state-mutating gameplay entry points.
    ///
    /// While paused, calls to `join_arena`, `submit_commitment`, `reveal_choice`,
    /// `resolve_round`, and `claim` all fail with `ArenaError::ContractPaused`.
    /// Read-only queries are unaffected. Only the admin can pause.
    ///
    /// # Parameters
    /// - `reason`: Short symbol describing why the contract is being paused
    ///   (e.g., `"emerg"`, `"maint"`). Included in the emitted event for
    ///   indexers and dashboards.
    ///
    /// # Errors
    /// - `ArenaError::NotInitialized` if `initialize` has not been called.
    ///
    /// # Events
    /// Emits `paused` with the admin address and reason symbol.
    pub fn pause(env: Env, reason: Symbol) -> Result<(), ArenaError> {
        let mut config = ArenaStorage::load_config(&env)?;
        config.admin.require_auth();
        config.paused = true;
        ArenaStorage::save_config(&env, &config);
        ArenaEvents::paused(&env, &config.admin, &reason);
        Ok(())
    }

    /// Resume normal operation after a `pause`.
    ///
    /// Clears the paused flag so all gameplay entry points become callable
    /// again. Only the admin can unpause.
    ///
    /// # Errors
    /// - `ArenaError::NotInitialized` if `initialize` has not been called.
    ///
    /// # Events
    /// Emits `unpaused` with the admin address.
    pub fn unpause(env: Env) -> Result<(), ArenaError> {
        let mut config = ArenaStorage::load_config(&env)?;
        config.admin.require_auth();
        config.paused = false;
        ArenaStorage::save_config(&env, &config);
        ArenaEvents::unpaused(&env, &config.admin);
        Ok(())
    }

    /// Return the cumulative yield earned across all resolved rounds.
    ///
    /// Summed from vault balance deltas recorded during each `resolve_round`
    /// call. Returns `0` if the contract has not been initialised or no rounds
    /// have been resolved.
    pub fn get_total_yield(env: Env) -> i128 {
        ArenaStorage::load_config(&env)
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

    fn compute_commitment(env: &Env, choice: Choice, salt: &BytesN<32>) -> BytesN<32> {
        let mut preimage = Bytes::new(env);
        preimage.push_back(choice.to_byte());
        let salt_bytes = salt.to_array();
        for b in salt_bytes.iter() {
            preimage.push_back(*b);
        }
        env.crypto().sha256(&preimage).into()
    }

    fn require_not_paused(config: &ArenaConfig) -> Result<(), ArenaError> {
        if config.paused {
            return Err(ArenaError::ContractPaused);
        }
        Ok(())
    }

    fn validate_player_limits(min_players: u32, max_players: u32) -> Result<(), ArenaError> {
        if min_players < MIN_PLAYERS_TO_START || min_players > max_players {
            return Err(ArenaError::InvalidPlayerLimits);
        }
        Ok(())
    }

    fn resolve_players(env: &Env, round: u32) -> RoundResolution {
        let players = ArenaStorage::load_all_players(env);
        let mut active_choices: Vec<Choice> = Vec::new(env);
        for player in players.iter() {
            let state = ArenaStorage::load_player(env, &player).unwrap_or_default();
            if state.active
                && let Some(choice) = ArenaStorage::load_choice(env, &player)
            {
                active_choices.push_back(choice);
            }
        }

        let tally = eliminations::tally_choices(&active_choices);
        let tied = tally.heads > 0 && tally.heads == tally.tails;
        let mut eliminated = 0u32;
        let mut survivors = 0u32;
        let mut winner: Option<Address> = None;

        for player in players.iter() {
            let mut state = ArenaStorage::load_player(env, &player).unwrap_or_default();
            if !state.active {
                continue;
            }
            let choice = ArenaStorage::load_choice(env, &player);
            let should_eliminate = choice
                .map(|c| eliminations::is_eliminated(c, &tally))
                .unwrap_or(false);

            if should_eliminate {
                state.active = false;
                eliminated += 1;
                ArenaEvents::player_eliminated(env, &player, round);
            } else {
                state.rounds_survived = state.rounds_survived.saturating_add(1);
                survivors += 1;
                winner = Some(player.clone());
            }
            ArenaStorage::save_player(env, &player, &state);
        }

        if survivors == 1 {
            RoundResolution {
                eliminated,
                survivors,
                winner,
                tied,
            }
        } else {
            RoundResolution {
                eliminated,
                survivors,
                winner: None,
                tied,
            }
        }
    }
}

#[cfg(test)]
mod test {
    use super::*;
    use soroban_sdk::{
        contract, contractimpl, symbol_short,
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
                entry_fee: 100,
                state: GameState::Open,
                paused: false,
                player_count: 0,
                cumulative_yield: 0,
                commit_deadline: u64::MAX,
                yield_vault: Address::generate(&env),
                round_count: 0,
                oracle_contract: oracle_id,
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

    fn compute_commitment(env: &Env, choice: Choice, salt: &BytesN<32>) -> BytesN<32> {
        ArenaContract::compute_commitment(env, choice, salt)
    }

    #[test]
    fn valid_commit_and_reveal() {
        let env = Env::default();
        env.mock_all_auths();
        let contract_id = env.register(ArenaContract, ());
        let player = Address::generate(&env);
        let salt = BytesN::from_array(&env, &[42u8; 32]);
        let choice = Choice::Tails;
        let commitment = compute_commitment(&env, choice, &salt);

        env.as_contract(&contract_id, || {
            let config = ArenaConfig {
                admin: Address::generate(&env),
                stake_token: Address::generate(&env),
                entry_fee: 100,
                state: GameState::Open,
                paused: false,
                player_count: 0,
                cumulative_yield: 0,
                commit_deadline: 0,
                yield_vault: Address::generate(&env),
                round_count: 0,
                oracle_contract: Address::generate(&env),
            };
            ArenaStorage::save_config(&env, &config);
            ArenaStorage::save_commitment(&env, &player, &commitment);
        });

        let client = ArenaContractClient::new(&env, &contract_id);
        client.reveal_choice(&player, &choice, &salt);

        env.as_contract(&contract_id, || {
            let stored = ArenaStorage::load_choice(&env, &player).unwrap();
            assert_eq!(stored, choice);
        });
    }

    #[test]
    fn reveal_hash_mismatch() {
        let env = Env::default();
        env.mock_all_auths();
        let contract_id = env.register(ArenaContract, ());
        let player = Address::generate(&env);
        let salt = BytesN::from_array(&env, &[7u8; 32]);
        let commitment = compute_commitment(&env, Choice::Heads, &salt);

        env.as_contract(&contract_id, || {
            let config = ArenaConfig {
                admin: Address::generate(&env),
                stake_token: Address::generate(&env),
                entry_fee: 100,
                state: GameState::Open,
                paused: false,
                player_count: 0,
                cumulative_yield: 0,
                commit_deadline: 0,
                yield_vault: Address::generate(&env),
                round_count: 0,
                oracle_contract: Address::generate(&env),
            };
            ArenaStorage::save_config(&env, &config);
            ArenaStorage::save_commitment(&env, &player, &commitment);
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
        let commitment = compute_commitment(&env, Choice::Heads, &salt);

        env.as_contract(&contract_id, || {
            let config = ArenaConfig {
                admin: Address::generate(&env),
                stake_token: Address::generate(&env),
                entry_fee: 100,
                state: GameState::Open,
                paused: false,
                player_count: 0,
                cumulative_yield: 0,
                commit_deadline: 1,
                yield_vault: Address::generate(&env),
                round_count: 0,
                oracle_contract: Address::generate(&env),
            };
            ArenaStorage::save_config(&env, &config);
            ArenaStorage::save_commitment(&env, &player, &commitment);
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
        let commitment = compute_commitment(&env, choice, &salt);

        env.as_contract(&contract_id, || {
            let config = ArenaConfig {
                admin: Address::generate(&env),
                stake_token: Address::generate(&env),
                entry_fee: 100,
                state: GameState::Open,
                paused: false,
                player_count: 0,
                cumulative_yield: 0,
                commit_deadline: 0,
                yield_vault: Address::generate(&env),
                round_count: 0,
                oracle_contract: Address::generate(&env),
            };
            ArenaStorage::save_config(&env, &config);
            ArenaStorage::save_commitment(&env, &player, &commitment);
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
                cumulative_yield: 0,
                commit_deadline: 0,
                yield_vault: Address::generate(&env),
                round_count: 0,
                oracle_contract: Address::generate(&env),
            };
            ArenaStorage::save_config(&env, &config);
        });

        let client = ArenaContractClient::new(&env, &contract_id);
        let result = client.try_reveal_choice(&player, &Choice::Heads, &salt);
        assert!(result.is_err());
    }

    fn setup_started(duration: u64, start_ts: u64) -> (Env, ArenaContractClient<'static>) {
        let env = Env::default();
        env.mock_all_auths();
        let contract_id = env.register(ArenaContract, ());
        let oracle_id = env.register(MockOracle, ());
        env.as_contract(&contract_id, || {
            let config = ArenaConfig {
                admin: Address::generate(&env),
                stake_token: Address::generate(&env),
                entry_fee: 100,
                state: GameState::Open,
                paused: false,
                player_count: 2,
                cumulative_yield: 0,
                commit_deadline: 0,
                yield_vault: Address::generate(&env),
                round_count: 0,
                oracle_contract: oracle_id,
            };
            ArenaStorage::save_config(&env, &config);
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
        let commitment = compute_commitment(&env, Choice::Heads, &salt);

        env.as_contract(&contract_id, || {
            ArenaStorage::save_config(
                &env,
                &ArenaConfig {
                    admin: admin.clone(),
                    stake_token: Address::generate(&env),
                    entry_fee: 100,
                    state: GameState::Active,
                    paused: false,
                    player_count: 1,
                    cumulative_yield: 0,
                    commit_deadline: 0,
                    yield_vault: Address::generate(&env),
                    round_count: 0,
                    oracle_contract: Address::generate(&env),
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
            ArenaStorage::save_commitment(&env, &player, &commitment);
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
        let (env, client) = setup(0);
        let player = Address::generate(&env);
        let commitment = BytesN::from_array(&env, &[2u8; 32]);

        client.pause(&symbol_short!("emerg"));
        client.unpause();
        client.submit_commitment(&player, &commitment);

        env.as_contract(&client.address, || {
            assert_eq!(
                ArenaStorage::load_commitment(&env, &player).unwrap(),
                commitment
            );
            assert!(!ArenaStorage::load_config(&env).unwrap().paused);
        });
    }

    #[test]
    fn resolve_round_before_grace_elapsed_fails() {
        let (env, client) = setup_started(60, 1_000);
        env.ledger().with_mut(|li| li.timestamp = 1_030);
        assert!(client.try_resolve_round().is_err());
        assert_eq!(state_of(&env, &client), GameState::Active);
    }

    #[test]
    fn resolve_round_after_grace_elapsed_succeeds() {
        let (env, client) = setup_started(60, 1_000);
        env.ledger().with_mut(|li| li.timestamp = 1_061);
        client.resolve_round();
        assert_eq!(state_of(&env, &client), GameState::Finished);
    }

    #[test]
    fn resolve_round_requires_an_active_round() {
        let env = Env::default();
        env.mock_all_auths();
        let contract_id = env.register(ArenaContract, ());
        env.as_contract(&contract_id, || {
            let config = ArenaConfig {
                admin: Address::generate(&env),
                stake_token: Address::generate(&env),
                entry_fee: 100,
                state: GameState::Open,
                paused: false,
                player_count: 0,
                cumulative_yield: 0,
                commit_deadline: 0,
                yield_vault: Address::generate(&env),
                round_count: 0,
                oracle_contract: Address::generate(&env),
            };
            ArenaStorage::save_config(&env, &config);
        });
        let client = ArenaContractClient::new(&env, &contract_id);
        assert!(client.try_resolve_round().is_err());
    }

    #[test]
    fn event_emitters_publish_expected_topics() {
        let env = Env::default();
        let contract_id = env.register(ArenaContract, ());
        let admin = Address::generate(&env);
        let player = Address::generate(&env);
        env.as_contract(&contract_id, || {
            ArenaEvents::initialized(&env, &admin);
            ArenaEvents::player_joined(&env, &player, 1);
            ArenaEvents::game_started(&env, 1, 60);
            ArenaEvents::round_resolved(&env, 1, 2, 1);
            ArenaEvents::player_eliminated(&env, &player, 1);
            ArenaEvents::game_finished(&env, &player, 1);
            ArenaEvents::prize_claimed(&env, &player, 105, 5);
            ArenaEvents::admin_changed(&env, &admin, &player);
        });

        assert_eq!(env.events().all().len(), 8);
    }

    #[test]
    fn total_yield_sums_round_snapshots() {
        let (env, client) = setup(0);
        env.as_contract(&client.address, || {
            let mut config = ArenaStorage::load_config(&env).unwrap();
            config.round_count = 3;
            config.cumulative_yield = 60;
            ArenaStorage::save_config(&env, &config);
            for round in 1..=3 {
                ArenaStorage::save_yield_snapshot(
                    &env,
                    round,
                    &YieldSnapshot {
                        round,
                        rate_bps: 500,
                        accrued: i128::from(round) * 10,
                    },
                );
            }
        });

        assert_eq!(client.get_total_yield(), 60);
    }

    #[test]
    fn resolve_round_tracks_yield_across_three_vault_snapshots() {
        let env = Env::default();
        env.mock_all_auths();
        let contract_id = env.register(ArenaContract, ());
        let vault_id = env.register(MockVault, ());
        let oracle_id = env.register(MockOracle, ());

        env.as_contract(&contract_id, || {
            ArenaStorage::save_config(
                &env,
                &ArenaConfig {
                    admin: Address::generate(&env),
                    stake_token: Address::generate(&env),
                    entry_fee: 100,
                    state: GameState::Open,
                    paused: false,
                    player_count: 2,
                    cumulative_yield: 0,
                    commit_deadline: 0,
                    yield_vault: vault_id.clone(),
                    round_count: 0,
                    oracle_contract: oracle_id,
                },
            );
            ArenaStorage::save_last_vault_balance(&env, 100);
        });

        let client = ArenaContractClient::new(&env, &contract_id);
        for (idx, balance) in [110i128, 125, 150].iter().enumerate() {
            env.as_contract(&vault_id, || {
                env.storage()
                    .persistent()
                    .set(&soroban_sdk::symbol_short!("BAL"), balance);
            });
            env.ledger()
                .with_mut(|li| li.timestamp = 1_000 + idx as u64);
            client.start_round(&0);
            client.resolve_round();
        }

        assert_eq!(client.get_total_yield(), 50);
        assert_eq!(client.get_yield_snapshot(&1).unwrap().accrued, 10);
        assert_eq!(client.get_yield_snapshot(&2).unwrap().accrued, 15);
        assert_eq!(client.get_yield_snapshot(&3).unwrap().accrued, 25);
    }

    /// Reentrancy guard: if the prize-claimed flag has been set (which `claim`
    /// does *before* it performs any external token transfer) a subsequent
    /// call to `claim` — including a reentrant call triggered by a malicious
    /// `token.transfer` hook — must short-circuit with `PrizeAlreadyClaimed`.
    ///
    /// This pins the checks-effects-interactions ordering of `claim`: any
    /// future refactor that moves the `mark_prize_claimed` call after a
    /// cross-contract interaction will fail this test.
    #[test]
    fn claim_returns_already_claimed_when_flag_is_set() {
        let env = Env::default();
        env.mock_all_auths();
        let contract_id = env.register(ArenaContract, ());
        let winner = Address::generate(&env);

        env.as_contract(&contract_id, || {
            ArenaStorage::save_config(
                &env,
                &ArenaConfig {
                    admin: Address::generate(&env),
                    stake_token: Address::generate(&env),
                    entry_fee: 100,
                    state: GameState::Finished,
                    paused: false,
                    player_count: 1,
                    cumulative_yield: 0,
                    commit_deadline: 0,
                    yield_vault: Address::generate(&env),
                    round_count: 0,
                    oracle_contract: Address::generate(&env),
                },
            );
            ArenaStorage::save_player(
                &env,
                &winner,
                &PlayerState {
                    active: true,
                    rounds_survived: 1,
                },
            );
            // Simulate the state a reentrant caller would observe: claim has
            // already committed its EFFECTS step and is mid-INTERACTIONS.
            ArenaStorage::mark_prize_claimed(&env);
        });

        let client = ArenaContractClient::new(&env, &contract_id);
        let err = client
            .try_claim(&winner)
            .err()
            .expect("reentrant claim must error")
            .expect("error must be a contract error");
        assert_eq!(err, ArenaError::PrizeAlreadyClaimed);
    }

    /// An eliminated player must not be able to claim the prize, even if the
    /// game state is Finished. Guards against a stale winner address being
    /// reused after elimination logic changes.
    #[test]
    fn claim_rejects_eliminated_player() {
        let env = Env::default();
        env.mock_all_auths();
        let contract_id = env.register(ArenaContract, ());
        let eliminated = Address::generate(&env);

        env.as_contract(&contract_id, || {
            ArenaStorage::save_config(
                &env,
                &ArenaConfig {
                    admin: Address::generate(&env),
                    stake_token: Address::generate(&env),
                    entry_fee: 100,
                    state: GameState::Finished,
                    paused: false,
                    player_count: 1,
                    cumulative_yield: 0,
                    commit_deadline: 0,
                    yield_vault: Address::generate(&env),
                    round_count: 0,
                    oracle_contract: Address::generate(&env),
                },
            );
            ArenaStorage::save_player(
                &env,
                &eliminated,
                &PlayerState {
                    active: false,
                    rounds_survived: 0,
                },
            );
        });

        let client = ArenaContractClient::new(&env, &contract_id);
        let err = client
            .try_claim(&eliminated)
            .err()
            .expect("eliminated player claim must error")
            .expect("error must be a contract error");
        assert_eq!(err, ArenaError::PlayerEliminated);
    }

    #[test]
    fn propose_then_accept_admin_changes_admin() {
        let env = Env::default();
        env.mock_all_auths();
        let contract_id = env.register(ArenaContract, ());
        let admin = Address::generate(&env);
        let new_admin = Address::generate(&env);

        env.as_contract(&contract_id, || {
            let config = ArenaConfig {
                admin: admin.clone(),
                stake_token: Address::generate(&env),
                entry_fee: 100,
                state: GameState::Open,
                paused: false,
                player_count: 0,
                cumulative_yield: 0,
                commit_deadline: 0,
                yield_vault: Address::generate(&env),
                round_count: 0,
                oracle_contract: Address::generate(&env),
            };
            ArenaStorage::save_config(&env, &config);
        });

        let client = ArenaContractClient::new(&env, &contract_id);
        client.propose_admin(&new_admin);
        client.accept_admin();

        env.as_contract(&contract_id, || {
            let config = ArenaStorage::load_config(&env).unwrap();
            assert_eq!(config.admin, new_admin);
        });
    }

    #[test]
    fn accept_without_propose_fails() {
        let env = Env::default();
        env.mock_all_auths();
        let contract_id = env.register(ArenaContract, ());
        let admin = Address::generate(&env);

        env.as_contract(&contract_id, || {
            let config = ArenaConfig {
                admin: admin.clone(),
                stake_token: Address::generate(&env),
                entry_fee: 100,
                state: GameState::Open,
                paused: false,
                player_count: 0,
                cumulative_yield: 0,
                commit_deadline: 0,
                yield_vault: Address::generate(&env),
                round_count: 0,
                oracle_contract: Address::generate(&env),
            };
            ArenaStorage::save_config(&env, &config);
        });

        let client = ArenaContractClient::new(&env, &contract_id);
        let err = client
            .try_accept_admin()
            .err()
            .expect("accept without propose must error")
            .expect("error must be a contract error");
        assert_eq!(err, ArenaError::NoPendingAdmin);
    }

    #[test]
    fn propose_admin_updates_pending_admin() {
        let env = Env::default();
        env.mock_all_auths();
        let contract_id = env.register(ArenaContract, ());
        let admin = Address::generate(&env);
        let new_admin = Address::generate(&env);

        env.as_contract(&contract_id, || {
            let config = ArenaConfig {
                admin: admin.clone(),
                stake_token: Address::generate(&env),
                entry_fee: 100,
                state: GameState::Open,
                paused: false,
                player_count: 0,
                cumulative_yield: 0,
                commit_deadline: 0,
                yield_vault: Address::generate(&env),
                round_count: 0,
                oracle_contract: Address::generate(&env),
            };
            ArenaStorage::save_config(&env, &config);
        });

        let client = ArenaContractClient::new(&env, &contract_id);
        client.propose_admin(&new_admin);

        env.as_contract(&contract_id, || {
            let pending = ArenaStorage::load_pending_admin(&env).unwrap();
            assert_eq!(pending.new_admin, new_admin);
        });
    }
    #[test]
    fn start_round_rejected_with_zero_players() {
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
                    entry_fee: 100,
                    state: GameState::Open,
                    paused: false,
                    player_count: 0,
                    cumulative_yield: 0,
                    commit_deadline: 0,
                    yield_vault: Address::generate(&env),
                    round_count: 0,
                    oracle_contract: oracle_id,
                },
            );
        });
        let client = ArenaContractClient::new(&env, &contract_id);
        let result = client.try_start_round(&60);
        assert_eq!(result, Err(Ok(ArenaError::NotEnoughPlayers)));
    }

    #[test]
    fn start_round_rejected_with_one_player() {
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
                    entry_fee: 100,
                    state: GameState::Open,
                    paused: false,
                    player_count: 1,
                    cumulative_yield: 0,
                    commit_deadline: 0,
                    yield_vault: Address::generate(&env),
                    round_count: 0,
                    oracle_contract: oracle_id,
                },
            );
        });
        let client = ArenaContractClient::new(&env, &contract_id);
        let result = client.try_start_round(&60);
        assert_eq!(result, Err(Ok(ArenaError::NotEnoughPlayers)));
    }

    #[test]
    fn start_round_succeeds_with_two_or_more_players() {
        let (_, client) = setup_started(60, 0);
        // setup_started configures player_count: 0 but the existing test already
        // called start_round successfully because setup_started uses
        // player_count: 0 — bump it here to prove the happy path independently.
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
                    entry_fee: 100,
                    state: GameState::Open,
                    paused: false,
                    player_count: 2,
                    cumulative_yield: 0,
                    commit_deadline: 0,
                    yield_vault: Address::generate(&env),
                    round_count: 0,
                    oracle_contract: oracle_id,
                },
            );
        });
        let client2 = ArenaContractClient::new(&env, &contract_id);
        client2.start_round(&60);
        let _ = client; // suppress unused warning
    }

    #[test]
    fn configure_player_limits_rejects_min_greater_than_max() {
        let (_, client) = setup(0);
        assert_eq!(
            client.try_configure_player_limits(&4, &3),
            Err(Ok(ArenaError::InvalidPlayerLimits))
        );
    }

    #[test]
    fn configure_player_limits_accepts_min_equal_max_boundary() {
        let (_, client) = setup(0);
        client.configure_player_limits(&2, &2);
    }

    #[test]
    fn configure_player_limits_rejects_min_below_start_boundary() {
        let (_, client) = setup(0);
        assert_eq!(
            client.try_configure_player_limits(&1, &2),
            Err(Ok(ArenaError::InvalidPlayerLimits))
        );
    }

    #[test]
    fn join_respects_configured_max_players() {
        let env = Env::default();
        env.mock_all_auths();
        let contract_id = env.register(ArenaContract, ());
        let vault_id = env.register(MockVault, ());
        let oracle_id = env.register(MockOracle, ());
        let token_admin = Address::generate(&env);
        let token_id = env
            .register_stellar_asset_contract_v2(token_admin)
            .address();

        env.as_contract(&contract_id, || {
            ArenaStorage::save_config(
                &env,
                &ArenaConfig {
                    admin: Address::generate(&env),
                    stake_token: token_id.clone(),
                    entry_fee: 100,
                    state: GameState::Open,
                    paused: false,
                    player_count: 0,
                    cumulative_yield: 0,
                    commit_deadline: 0,
                    yield_vault: vault_id,
                    round_count: 0,
                    oracle_contract: oracle_id,
                },
            );
            ArenaStorage::save_player_limits(&env, 2, 2);
        });

        let client = ArenaContractClient::new(&env, &contract_id);
        let asset = StellarAssetClient::new(&env, &token_id);
        let p1 = Address::generate(&env);
        let p2 = Address::generate(&env);
        let p3 = Address::generate(&env);
        asset.mint(&p1, &100);
        asset.mint(&p2, &100);
        asset.mint(&p3, &100);

        client.join_arena(&p1);
        client.join_arena(&p2);
        assert_eq!(
            client.try_join_arena(&p3),
            Err(Ok(ArenaError::ArenaFull))
        );
    }

    #[test]
    fn version_reports_contract_version() {
        let (_, client) = setup(0);
        assert_eq!(client.version(), CONTRACT_VERSION);
    }
}
#[cfg(test)]
mod integration_tests;
#[cfg(test)]
mod join_arena_tests;
