#![no_std]
use soroban_sdk::{Address, Env, Vec, contract, contractimpl, token};

mod storage;
mod types;

use storage::ArenaStorage;
use types::{ArenaConfig, ArenaError, GameState, PendingAdmin, PlayerState};

/// Number of players returned per `get_players` page.
const PAGE_SIZE: u32 = 50;

/// Arena contract — manages round lifecycle, player choices, and elimination logic.
///
/// Implementation is open for contribution. See the issue tracker for:
/// - Round state machine (OPEN → CLOSED → RESOLVED → SETTLED)
/// - Commit-reveal choice submission
/// - Minority-wins elimination logic
/// - Admin controls and upgrade timelock
///
/// Architecture overview: see `ARCHITECTURE.md` in the workspace root.
#[contract]
pub struct ArenaContract;

#[contractimpl]
impl ArenaContract {
    /// Initialise the arena with the given configuration.
    ///
    /// The caller becomes the initial admin. Can only be called once.
    pub fn initialize(
        env: Env,
        admin: Address,
        stake_token: Address,
        entry_fee: i128,
    ) -> Result<(), ArenaError> {
        if ArenaStorage::has_config(&env) {
            return Err(ArenaError::AlreadyInitialised);
        }

        let config = ArenaConfig {
            admin,
            stake_token,
            entry_fee,
            state: GameState::Open,
            player_count: 0,
        };
        ArenaStorage::save_config(&env, &config);

        env.events()
            .publish((soroban_sdk::symbol_short!("init"),), ());

        Ok(())
    }

    /// Cancel an open arena and refund all joined players their entry fee.
    ///
    /// Only callable by the arena admin, and only while the game is still in
    /// `Open` state (i.e. before the first round starts). State is written to
    /// `Cancelled` *before* any token transfers to guard against re-entrancy.
    pub fn cancel_arena(env: Env) -> Result<(), ArenaError> {
        let mut config = ArenaStorage::load_config(&env)?;

        // Require the caller to be the registered admin
        config.admin.require_auth();

        // Guard: cannot cancel a game that has already started
        if config.state != GameState::Open {
            return Err(ArenaError::CannotCancelStartedGame);
        }

        // Transition state first — reentrancy protection
        config.state = GameState::Cancelled;
        ArenaStorage::save_config(&env, &config);

        // Refund every joined player
        let token_client = token::TokenClient::new(&env, &config.stake_token);
        let players = ArenaStorage::load_all_players(&env);
        for player in players.iter() {
            token_client.transfer(&env.current_contract_address(), &player, &config.entry_fee);
            env.events().publish(
                (soroban_sdk::symbol_short!("refunded"), player.clone()),
                config.entry_fee,
            );
        }

        // Top-level cancellation event
        env.events()
            .publish((soroban_sdk::symbol_short!("cancelled"),), ());

        Ok(())
    }

    /// Propose transferring admin to a new address.
    ///
    /// The current admin initiates the transfer. The new admin must call
    /// `accept_admin` to finalise. If a transfer is already pending, this
    /// returns `TransferInProgress`.
    pub fn propose_admin(env: Env, new_admin: Address) -> Result<(), ArenaError> {
        let config = ArenaStorage::load_config(&env)?;

        // Require the caller to be the current admin
        config.admin.require_auth();

        // Cannot transfer to the same address
        if new_admin == config.admin {
            return Err(ArenaError::CannotTransferToSelf);
        }

        // Guard: no pending transfer already in-flight
        if ArenaStorage::load_pending_admin(&env).is_some() {
            return Err(ArenaError::TransferInProgress);
        }

        ArenaStorage::save_pending_admin(
            &env,
            &PendingAdmin {
                new_admin: new_admin.clone(),
            },
        );

        env.events().publish(
            (soroban_sdk::symbol_short!("prop_adm"),),
            (config.admin, new_admin),
        );

        Ok(())
    }

    /// Accept a pending admin transfer.
    ///
    /// Only the proposed new admin can call this. On success, the pending
    /// transfer is cleared and the caller becomes the admin.
    pub fn accept_admin(env: Env) -> Result<(), ArenaError> {
        let pending = ArenaStorage::load_pending_admin(&env)
            .ok_or(ArenaError::NoPendingTransfer)?;

        // Require the caller to be the proposed new admin
        pending.new_admin.require_auth();

        let mut config = ArenaStorage::load_config(&env)?;
        config.admin = pending.new_admin.clone();
        ArenaStorage::save_config(&env, &config);
        ArenaStorage::clear_pending_admin(&env);

        env.events().publish(
            (soroban_sdk::symbol_short!("adm_chg"),),
            pending.new_admin,
        );

        Ok(())
    }

    /// Cancel a pending admin transfer.
    ///
    /// Only the current admin can cancel a pending proposal.
    pub fn cancel_admin_transfer(env: Env) -> Result<(), ArenaError> {
        let config = ArenaStorage::load_config(&env)?;

        // Require the caller to be the current admin
        config.admin.require_auth();

        if ArenaStorage::load_pending_admin(&env).is_none() {
            return Err(ArenaError::NoPendingTransfer);
        }

        ArenaStorage::clear_pending_admin(&env);

        env.events()
            .publish((soroban_sdk::symbol_short!("can_adm"),), ());

        Ok(())
    }

    /// Returns a paginated list of all players with their current state.
    ///
    /// `page` is 0-indexed; the page size is [`PAGE_SIZE`] (50). Players are
    /// returned in join order, so a given player appears on exactly one page
    /// for a stable players list. Pages beyond the end return an empty list.
    ///
    /// Intended for indexers, analytics tools, and the backend event processor
    /// to perform an initial state sync without replaying the event log.
    pub fn get_players(env: Env, page: u32) -> Vec<(Address, PlayerState)> {
        let all = ArenaStorage::load_all_players(&env);
        let len = all.len();
        let start = page.saturating_mul(PAGE_SIZE);
        let end = start.saturating_add(PAGE_SIZE).min(len);

        let mut result: Vec<(Address, PlayerState)> = Vec::new(&env);
        let mut i = start;
        while i < end {
            let addr = all.get(i).unwrap();
            let state = ArenaStorage::load_player(&env, &addr).unwrap_or_default();
            result.push_back((addr, state));
            i += 1;
        }
        result
    }

    /// Returns the total number of players who have joined this arena.
    pub fn player_count(env: Env) -> u32 {
        ArenaStorage::load_config(&env)
            .map(|c| c.player_count)
            .unwrap_or(0)
    }
}

#[cfg(test)]
mod test {
    use super::*;
    use crate::types::ArenaConfig;
    use soroban_sdk::testutils::Address as _;

    /// Register the contract and seed `n` joined players, returning the client.
    fn setup(n: u32) -> (Env, ArenaContractClient<'static>) {
        let env = Env::default();
        let contract_id = env.register(ArenaContract, ());

        env.as_contract(&contract_id, || {
            let config = ArenaConfig {
                admin: Address::generate(&env),
                stake_token: Address::generate(&env),
                entry_fee: 100,
                state: GameState::Open,
                player_count: 0,
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
        // The joined player is recorded as active with no rounds survived yet.
        let (_addr, state) = page0.get(0).unwrap();
        assert!(state.active);
        assert_eq!(state.rounds_survived, 0);

        // No second page.
        assert_eq!(client.get_players(&1).len(), 0);
    }

    #[test]
    fn fifty_one_players_cross_page_boundary() {
        let (_env, client) = setup(51);
        assert_eq!(client.player_count(), 51);

        let page0 = client.get_players(&0);
        let page1 = client.get_players(&1);
        let page2 = client.get_players(&2);

        assert_eq!(page0.len(), PAGE_SIZE); // 50
        assert_eq!(page1.len(), 1);
        assert_eq!(page2.len(), 0);

        // Pagination is consistent: no player appears on two pages.
        for (addr1, _) in page1.iter() {
            for (addr0, _) in page0.iter() {
                assert_ne!(addr0, addr1);
            }
        }

        // The two pages together cover every player exactly once.
        assert_eq!(page0.len() + page1.len(), client.player_count());
    }
}
