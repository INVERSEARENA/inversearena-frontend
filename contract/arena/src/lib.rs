#![no_std]
use soroban_sdk::{Address, Bytes, BytesN, Env, Vec, contract, contractimpl, token};

mod eliminations;
mod events;
mod fuzz_tests;
mod oracle;
mod snapshot_test;
mod state_machine;
mod storage;
mod types;

use events::ArenaEvents;
use rwa_adapter::RwaAdapterClient;
use storage::ArenaStorage;
use types::{ArenaConfig, ArenaError, Choice, GameState, PlayerState, RoundResult, YieldSnapshot};

const PAGE_SIZE: u32 = 50;

#[contract]
pub struct ArenaContract;

#[contractimpl]
impl ArenaContract {
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

        let config = ArenaConfig {
            admin: admin.clone(),
            stake_token,
            yield_vault,
            entry_fee,
            state: GameState::Open,
            player_count: 0,
            commit_deadline: 0,
            round_count: 0,
            oracle_contract,
        };
        ArenaStorage::save_config(&env, &config);
        ArenaStorage::save_last_vault_balance(&env, 0);
        ArenaEvents::initialized(&env, &admin);
        Ok(())
    }

    pub fn join_arena(env: Env, player: Address) -> Result<(), ArenaError> {
        player.require_auth();
        let config = ArenaStorage::load_config(&env)?;
        if config.state != GameState::Open {
            return Err(ArenaError::CannotCancelStartedGame);
        }

        let token_client = token::TokenClient::new(&env, &config.stake_token);
        let arena_addr = env.current_contract_address();
        token_client.transfer(&player, &arena_addr, &config.entry_fee);

        let rwa_client = RwaAdapterClient::new(&env, &config.yield_vault);
        let _ = rwa_client.try_deposit(&arena_addr, &config.entry_fee);
        let baseline = ArenaStorage::load_last_vault_balance(&env).saturating_add(config.entry_fee);
        ArenaStorage::save_last_vault_balance(&env, baseline);

        ArenaStorage::add_player(&env, &player);
        let count = ArenaStorage::load_all_players(&env).len();
        ArenaEvents::player_joined(&env, &player, count);
        Ok(())
    }

    pub fn submit_commitment(
        env: Env,
        player: Address,
        commitment: BytesN<32>,
    ) -> Result<(), ArenaError> {
        player.require_auth();
        ArenaStorage::save_commitment(&env, &player, &commitment);
        Ok(())
    }

    pub fn reveal_choice(
        env: Env,
        player: Address,
        choice: Choice,
        salt: BytesN<32>,
    ) -> Result<(), ArenaError> {
        player.require_auth();
        if ArenaStorage::load_choice(&env, &player).is_some() {
            return Err(ArenaError::ChoiceAlreadyRevealed);
        }
        if env.ledger().timestamp() < ArenaStorage::load_config(&env)?.commit_deadline {
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

    pub fn cancel_arena(env: Env) -> Result<(), ArenaError> {
        let mut config = ArenaStorage::load_config(&env)?;
        config.admin.require_auth();
        state_machine::ensure_state(
            &config.state,
            &GameState::Open,
            ArenaError::CannotCancelStartedGame,
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

    pub fn player_count(env: Env) -> u32 {
        ArenaStorage::load_config(&env)
            .map(|c| c.player_count)
            .unwrap_or(0)
    }

    pub fn start_round(env: Env, duration_seconds: u64) -> Result<(), ArenaError> {
        let mut config = ArenaStorage::load_config(&env)?;
        config.admin.require_auth();

        if config.state != GameState::Open && config.state != GameState::Finished {
            return Err(ArenaError::CannotCancelStartedGame);
        }

        config.state = GameState::Active;
        ArenaStorage::save_config(&env, &config);
        ArenaStorage::save_round_start(&env, env.ledger().timestamp());
        ArenaStorage::save_round_duration(&env, duration_seconds);

        ArenaEvents::game_started(&env, config.round_count.saturating_add(1), duration_seconds);
        Ok(())
    }

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

        let round = config.round_count.saturating_add(1);
        let yield_bps = oracle::fetch_yield_bps(&env, &config.oracle_contract);
        let arena_addr = env.current_contract_address();
        let rwa_client = RwaAdapterClient::new(&env, &config.yield_vault);
        let previous_balance = ArenaStorage::load_last_vault_balance(&env);
        let vault_balance = rwa_client
            .try_balance_of(&arena_addr)
            .unwrap_or(Ok(previous_balance))
            .unwrap_or(previous_balance);
        let accrued = vault_balance.saturating_sub(previous_balance);
        let snapshot = YieldSnapshot {
            round,
            rate_bps: yield_bps,
            accrued,
        };

        ArenaStorage::save_round_yield_bps(&env, round, yield_bps);
        ArenaStorage::save_yield_snapshot(&env, round, &snapshot);
        ArenaStorage::save_last_vault_balance(&env, vault_balance);

        let (eliminated, survivors, winner) = Self::resolve_players(&env, round);
        let result = RoundResult {
            round,
            eliminated,
            survivors,
            yield_snapshot: snapshot,
        };
        ArenaStorage::save_round_result(&env, round, &result);

        config.round_count = round;
        config.state = if survivors <= 1 {
            GameState::Finished
        } else {
            GameState::Open
        };
        ArenaStorage::save_config(&env, &config);

        ArenaEvents::round_resolved(&env, round, eliminated, survivors);
        if let Some(winner_addr) = winner {
            ArenaEvents::game_finished(&env, &winner_addr, round);
        }
        Ok(())
    }

    pub fn claim(env: Env, winner: Address) -> Result<(), ArenaError> {
        winner.require_auth();
        let mut config = ArenaStorage::load_config(&env)?;

        if config.state != GameState::Finished {
            return Err(ArenaError::GameNotFinished);
        }

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

        config.state = GameState::Settled;
        ArenaStorage::save_config(&env, &config);
        ArenaEvents::prize_claimed(&env, &winner, total, total.saturating_sub(principal));
        Ok(())
    }

    pub fn change_admin(env: Env, new_admin: Address) -> Result<(), ArenaError> {
        let mut config = ArenaStorage::load_config(&env)?;
        config.admin.require_auth();
        let old_admin = config.admin.clone();
        config.admin = new_admin.clone();
        ArenaStorage::save_config(&env, &config);
        ArenaEvents::admin_changed(&env, &old_admin, &new_admin);
        Ok(())
    }

    pub fn get_total_yield(env: Env) -> i128 {
        let round_count = ArenaStorage::load_config(&env)
            .map(|c| c.round_count)
            .unwrap_or(0);
        let mut total = 0i128;
        let mut round = 1u32;
        while round <= round_count {
            if let Some(snapshot) = ArenaStorage::load_yield_snapshot(&env, round) {
                total = total.saturating_add(snapshot.accrued);
            }
            round += 1;
        }
        total
    }

    pub fn get_yield_snapshot(env: Env, round: u32) -> Option<YieldSnapshot> {
        ArenaStorage::load_yield_snapshot(&env, round)
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

    fn resolve_players(env: &Env, round: u32) -> (u32, u32, Option<Address>) {
        let players = ArenaStorage::load_all_players(env);
        let mut active_choices: Vec<Choice> = Vec::new(env);
        for player in players.iter() {
            let state = ArenaStorage::load_player(env, &player).unwrap_or_default();
            if state.active {
                if let Some(choice) = ArenaStorage::load_choice(env, &player) {
                    active_choices.push_back(choice);
                }
            }
        }

        let tally = eliminations::tally_choices(&active_choices);
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
            (eliminated, survivors, winner)
        } else {
            (eliminated, survivors, None)
        }
    }
}

#[cfg(test)]
mod test {
    use super::*;
    use soroban_sdk::{
        contract, contractimpl,
        testutils::{Address as _, Events as _, Ledger as _},
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
                player_count: 0,
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
                player_count: 0,
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
                player_count: 0,
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
                player_count: 0,
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
                player_count: 0,
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
                player_count: 0,
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
                player_count: 0,
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
                player_count: 0,
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
                    player_count: 1,
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
}
