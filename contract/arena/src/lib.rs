#![no_std]
use soroban_sdk::{Address, Bytes, BytesN, Env, Vec, contract, contractimpl, token};

mod eliminations;
mod snapshot_test;
mod state_machine;
mod storage;
mod types;

use storage::ArenaStorage;
use types::{ArenaError, Choice, GameState, PlayerState};

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
    /// Cancel an open arena and refund all joined players their entry fee.
    ///
    /// Only callable by the arena admin, and only while the game is still in
    /// `Open` state (i.e. before the first round starts). State is written to
    /// `Cancelled` *before* any token transfers to guard against re-entrancy.
    pub fn cancel_arena(env: Env) -> Result<(), ArenaError> {
        let mut config = ArenaStorage::load_config(&env)?;

        // Require the caller to be the registered admin
        config.admin.require_auth();

        // Guard: cannot cancel a game that has already started. The legal
        // Open → Cancelled transition is enforced by the state machine module.
        state_machine::ensure_state(
            &config.state,
            &GameState::Open,
            ArenaError::CannotCancelStartedGame,
        )?;

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

    /// Commit a hidden choice via its hash during the commit phase.
    ///
    /// `commitment` must be `sha256(choice.to_byte() | salt)` computed
    /// off-chain by the player. The contract stores only the hash; the
    /// actual choice and salt must be revealed later via [`reveal_choice`].
    pub fn commit_choice(env: Env, player: Address, commitment: BytesN<32>) -> Result<(), ArenaError> {
        player.require_auth();

        let config = ArenaStorage::load_config(&env)?;

        if env.ledger().timestamp() >= config.commit_deadline {
            return Err(ArenaError::CommitPhaseEnded);
        }

        ArenaStorage::save_commitment(&env, &player, &commitment);

        env.events()
            .publish((soroban_sdk::symbol_short!("committed"), player), ());

        Ok(())
    }

    /// Reveal a previously committed choice with its salt.
    ///
    /// The contract computes `sha256(choice.to_byte() | salt)` and verifies
    /// it matches the commitment stored during [`commit_choice`].
    pub fn reveal_choice(
        env: Env,
        player: Address,
        choice: Choice,
        salt: BytesN<32>,
    ) -> Result<(), ArenaError> {
        player.require_auth();

        let config = ArenaStorage::load_config(&env)?;

        if env.ledger().timestamp() < config.commit_deadline {
            return Err(ArenaError::RevealPhaseNotActive);
        }

        let stored = ArenaStorage::load_commitment(&env, &player)
            .ok_or(ArenaError::NoCommitmentFound)?;

        if ArenaStorage::has_revealed(&env, &player) {
            return Err(ArenaError::AlreadyRevealed);
        }

        let mut preimage = Bytes::new(&env);
        preimage.push_back(choice.to_byte());
        let salt_bytes = salt.to_array();
        for b in salt_bytes.iter() {
            preimage.push_back(*b);
        }

        let computed: BytesN<32> = env.crypto().sha256(&preimage).into();
        if computed != stored {
            return Err(ArenaError::HashMismatch);
        }

        ArenaStorage::save_choice(&env, &player, &choice);

        env.events()
            .publish((soroban_sdk::symbol_short!("revealed"), player), ());

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

    /// Start a round, opening the submission window (#689).
    ///
    /// Records the round start timestamp and the minimum grace period
    /// (`duration_seconds`) that must elapse before [`resolve_round`] can be
    /// called. Only the admin may start a round, and only from `Open`.
    pub fn start_round(env: Env, duration_seconds: u64) -> Result<(), ArenaError> {
        let mut config = ArenaStorage::load_config(&env)?;
        config.admin.require_auth();

        if config.state != GameState::Open {
            return Err(ArenaError::CannotCancelStartedGame);
        }

        config.state = GameState::Active;
        ArenaStorage::save_config(&env, &config);
        ArenaStorage::save_round_start(&env, env.ledger().timestamp());
        ArenaStorage::save_round_duration(&env, duration_seconds);

        env.events()
            .publish((soroban_sdk::symbol_short!("started"),), duration_seconds);
        Ok(())
    }

    /// Resolve the current round, enforcing the on-chain timelock (#689).
    ///
    /// Rejects with [`ArenaError::GracePeriodNotElapsed`] unless at least
    /// `duration_seconds` have passed since the round started — so an admin
    /// cannot resolve a round before players have had the window to act.
    pub fn resolve_round(env: Env) -> Result<(), ArenaError> {
        let mut config = ArenaStorage::load_config(&env)?;
        config.admin.require_auth();

        if config.state != GameState::Active {
            return Err(ArenaError::RoundNotActive);
        }

        let round_start =
            ArenaStorage::load_round_start(&env).ok_or(ArenaError::RoundNotStarted)?;
        let grace = ArenaStorage::load_round_duration(&env);
        if env.ledger().timestamp() < round_start.saturating_add(grace) {
            return Err(ArenaError::GracePeriodNotElapsed);
        }

        config.state = GameState::Finished;
        ArenaStorage::save_config(&env, &config);

        env.events()
            .publish((soroban_sdk::symbol_short!("resolved"),), ());
        Ok(())
    }
}

#[cfg(test)]
mod test {
    use super::*;
    use crate::types::ArenaConfig;
    use soroban_sdk::testutils::{Address as _, Ledger as _};

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
                commit_deadline: u64::MAX,
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

    fn compute_commitment(env: &Env, choice: Choice, salt: &BytesN<32>) -> BytesN<32> {
        let mut preimage = Bytes::new(env);
        preimage.push_back(choice.to_byte());
        let salt_bytes = salt.to_array();
        for b in salt_bytes.iter() {
            preimage.push_back(*b);
        }
        env.crypto().sha256(&preimage).into()
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
                player_count: 0,
                commit_deadline: 0,
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
                player_count: 0,
                commit_deadline: 0,
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
                player_count: 0,
                commit_deadline: 1,
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
                player_count: 0,
                commit_deadline: 0,
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
                player_count: 0,
                commit_deadline: 0,
            };
            ArenaStorage::save_config(&env, &config);
        });

        let client = ArenaContractClient::new(&env, &contract_id);
        let result = client.try_reveal_choice(&player, &Choice::Heads, &salt);
        assert!(result.is_err());
    }

    // ── #689: admin timelock on resolve_round ──────────────────────────────

    fn setup_started(duration: u64, start_ts: u64) -> (Env, ArenaContractClient<'static>) {
        let env = Env::default();
        env.mock_all_auths();
        let contract_id = env.register(ArenaContract, ());
        env.as_contract(&contract_id, || {
            let config = ArenaConfig {
                admin: Address::generate(&env),
                stake_token: Address::generate(&env),
                entry_fee: 100,
                state: GameState::Open,
                player_count: 0,
                commit_deadline: 0,
            };
            ArenaStorage::save_config(&env, &config);
        });
        let client = ArenaContractClient::new(&env, &contract_id);
        env.ledger().with_mut(|li| li.timestamp = start_ts);
        client.start_round(&duration);
        (env, client)
    }

    fn state_of(env: &Env, client: &ArenaContractClient) -> GameState {
        env.as_contract(&client.address, || ArenaStorage::load_config(env).unwrap().state)
    }

    #[test]
    fn resolve_round_before_grace_elapsed_fails() {
        let (env, client) = setup_started(60, 1_000);
        // Only 30s have passed; the 60s grace window has not elapsed.
        env.ledger().with_mut(|li| li.timestamp = 1_030);
        assert!(client.try_resolve_round().is_err());
        // State is unchanged — still Active.
        assert_eq!(state_of(&env, &client), GameState::Active);
    }

    #[test]
    fn resolve_round_after_grace_elapsed_succeeds() {
        let (env, client) = setup_started(60, 1_000);
        // Past the grace window.
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
                player_count: 0,
                commit_deadline: 0,
            };
            ArenaStorage::save_config(&env, &config);
        });
        let client = ArenaContractClient::new(&env, &contract_id);
        // Never started → not Active → rejected.
        assert!(client.try_resolve_round().is_err());
    }
}
