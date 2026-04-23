#![no_std]

use soroban_sdk::{contract, contractimpl, Address, BytesN, Env, String};
pub use soroban_sdk::token;
pub use soroban_sdk::xdr::ToXdr;

pub(crate) mod bounds;
pub(crate) mod errors;
pub(crate) mod events;
pub(crate) mod math;
pub(crate) mod players;
pub(crate) mod rounds;
pub(crate) mod rwa;
pub(crate) mod state;

// Re-export public types so tests and external crates can use `crate::Foo`.
pub use errors::ArenaError;
pub use events::{
    ArenaCancelled, ArenaStateChanged, Choice, ChoiceSubmitted, PlayerEliminated, PlayerJoined,
    RoundResolved, WinnerDeclared,
};
pub use state::{
    ArenaConfig, ArenaMetadata, ArenaSnapshot, ArenaState, ArenaStateView, DataKey, FullStateView,
    RoundState, UserStateView,
};

use state::{
    bump, get_config, get_round, get_state, require_not_paused, set_state,
    CANCELLED_KEY, CAPACITY_KEY, GAME_FINISHED_KEY, PAUSED_KEY, PRIZE_POOL_KEY,
    SURVIVOR_COUNT_KEY, TOKEN_KEY, WINNER_SET_KEY, GAME_TTL_THRESHOLD, GAME_TTL_EXTEND_TO,
};
use events::{
    TOPIC_CLAIM, TOPIC_PAUSED, TOPIC_UNPAUSED, TOPIC_WINNER_SET,
    TOPIC_UPGRADE_PROPOSED, TOPIC_UPGRADE_EXECUTED, TOPIC_UPGRADE_CANCELLED, EVENT_VERSION,
};

const TIMELOCK_PERIOD: u64 = 172_800; // 48 h in seconds

#[contract]
pub struct ArenaContract;

#[contractimpl]
impl ArenaContract {
    pub fn initialize(env: Env, admin: Address) {
        if env.storage().instance().has(&DataKey::ContractAdmin) {
            panic!("already initialized");
        }
        env.storage().instance().set(&DataKey::ContractAdmin, &admin);
        env.storage().instance().extend_ttl(GAME_TTL_THRESHOLD, GAME_TTL_EXTEND_TO);
    }

    pub fn admin(env: Env) -> Address {
        env.storage().instance().get(&DataKey::ContractAdmin).expect("not initialized")
    }

    pub fn set_admin(env: Env, new_admin: Address) {
        let admin = Self::admin(env.clone());
        admin.require_auth();
        env.storage().instance().set(&DataKey::ContractAdmin, &new_admin);
    }

    pub fn init_factory(env: Env, factory: Address, _creator: Address) {
        let admin = Self::admin(env.clone());
        admin.require_auth();
        if env.storage().instance().has(&DataKey::FactoryAddress) {
            panic!("already initialized");
        }
        env.storage().instance().set(&DataKey::FactoryAddress, &factory);
    }

    pub fn init(env: Env, round_speed_in_ledgers: u32, required_stake_amount: i128) -> Result<(), ArenaError> {
        let admin = Self::admin(env.clone());
        admin.require_auth();
        if env.storage().instance().has(&DataKey::Config) {
            return Err(ArenaError::AlreadyInitialized);
        }
        if round_speed_in_ledgers == 0 || round_speed_in_ledgers > bounds::MAX_SPEED_LEDGERS {
            return Err(ArenaError::InvalidRoundSpeed);
        }
        if required_stake_amount < bounds::MIN_REQUIRED_STAKE {
            return Err(ArenaError::InvalidAmount);
        }
        env.storage().instance().extend_ttl(GAME_TTL_THRESHOLD, GAME_TTL_EXTEND_TO);
        env.storage().instance().set(&DataKey::Config, &ArenaConfig {
            round_speed_in_ledgers,
            round_duration_seconds: 0,
            required_stake_amount,
            max_rounds: bounds::DEFAULT_MAX_ROUNDS,
        });
        env.storage().instance().set(&DataKey::Round, &RoundState {
            round_number: 0, round_start_ledger: 0, round_deadline_ledger: 0,
            round_start: 0, round_deadline: 0, active: false,
            total_submissions: 0, timed_out: false, finished: false,
        });
        set_state(&env, ArenaState::Pending);
        Ok(())
    }

    pub fn pause(env: Env) {
        let admin = Self::admin(env.clone());
        admin.require_auth();
        env.storage().instance().set(&PAUSED_KEY, &true);
        env.events().publish((TOPIC_PAUSED,), (EVENT_VERSION,));
    }

    pub fn unpause(env: Env) {
        let admin = Self::admin(env.clone());
        admin.require_auth();
        env.storage().instance().set(&PAUSED_KEY, &false);
        env.events().publish((TOPIC_UNPAUSED,), (EVENT_VERSION,));
    }

    pub fn is_paused(env: Env) -> bool {
        env.storage().instance().get::<_, bool>(&PAUSED_KEY).unwrap_or(false)
    }

    pub fn set_token(env: Env, token: Address) -> Result<(), ArenaError> {
        let admin = Self::admin(env.clone());
        admin.require_auth();
        let survivor_count: u32 = env.storage().instance().get(&SURVIVOR_COUNT_KEY).unwrap_or(0);
        let prize_pool: i128 = env.storage().instance().get(&PRIZE_POOL_KEY).unwrap_or(0);
        if survivor_count > 0 || prize_pool > 0 {
            return Err(ArenaError::TokenConfigurationLocked);
        }
        env.storage().instance().set(&TOKEN_KEY, &token);
        Ok(())
    }

    pub fn set_capacity(env: Env, capacity: u32) -> Result<(), ArenaError> {
        let admin = Self::admin(env.clone());
        admin.require_auth();
        if !(bounds::MIN_ARENA_PARTICIPANTS..=bounds::MAX_ARENA_PARTICIPANTS).contains(&capacity) {
            return Err(ArenaError::InvalidCapacity);
        }
        env.storage().instance().set(&CAPACITY_KEY, &capacity);
        Ok(())
    }

    pub fn set_max_rounds(env: Env, max_rounds: u32) -> Result<(), ArenaError> {
        let admin = Self::admin(env.clone());
        admin.require_auth();
        if max_rounds < bounds::MIN_MAX_ROUNDS || max_rounds > bounds::MAX_MAX_ROUNDS {
            return Err(ArenaError::InvalidMaxRounds);
        }
        let mut config = get_config(&env)?;
        config.max_rounds = max_rounds;
        env.storage().instance().set(&DataKey::Config, &config);
        Ok(())
    }

    pub fn set_winner(env: Env, player: Address, stake: i128, yield_comp: i128) -> Result<(), ArenaError> {
        require_not_paused(&env)?;
        let admin = Self::admin(env.clone());
        admin.require_auth();
        if get_state(&env) != ArenaState::Active {
            return Err(ArenaError::GameNotFinished);
        }
        if !env.storage().persistent().has(&DataKey::Survivor(player.clone())) {
            return Err(ArenaError::NotASurvivor);
        }
        if env.storage().instance().get::<_, bool>(&WINNER_SET_KEY).unwrap_or(false) {
            return Err(ArenaError::WinnerAlreadySet);
        }
        if stake < 0 || yield_comp < 0 {
            return Err(ArenaError::InvalidAmount);
        }
        let prize = stake.checked_add(yield_comp).ok_or(ArenaError::InvalidAmount)?;
        let pool: i128 = env.storage().instance().get(&PRIZE_POOL_KEY).unwrap_or(0);
        env.storage().instance().set(&PRIZE_POOL_KEY, &pool.checked_add(prize).ok_or(ArenaError::InvalidAmount)?);
        env.storage().instance().set(&WINNER_SET_KEY, &true);
        env.storage().persistent().set(&DataKey::Winner(player.clone()), &true);
        bump(&env, &DataKey::Winner(player.clone()));
        env.events().publish((TOPIC_WINNER_SET,), (player, stake, yield_comp, EVENT_VERSION));
        Ok(())
    }

    pub fn join(env: Env, player: Address, amount: i128) -> Result<(), ArenaError> {
        player.require_auth();
        require_not_paused(&env)?;
        if get_state(&env) != ArenaState::Pending {
            return Err(ArenaError::GameAlreadyFinished);
        }
        players::join(&env, player, amount)
    }

    pub fn leave(env: Env, player: Address) -> Result<i128, ArenaError> {
        player.require_auth();
        require_not_paused(&env)?;
        if get_state(&env) != ArenaState::Pending {
            return Err(ArenaError::RoundAlreadyActive);
        }
        let round = get_round(&env)?;
        if round.round_number != 0 {
            return Err(ArenaError::RoundAlreadyActive);
        }
        players::leave(&env, player)
    }

    pub fn cancel_arena(env: Env) -> Result<(), ArenaError> {
        require_not_paused(&env)?;
        let admin = Self::admin(env.clone());
        admin.require_auth();
        players::cancel_arena(&env)
    }

    pub fn is_cancelled(env: Env) -> bool {
        env.storage().instance().get::<_, bool>(&CANCELLED_KEY).unwrap_or(false)
    }

    pub fn start_round(env: Env) -> Result<RoundState, ArenaError> {
        require_not_paused(&env)?;
        rounds::start_round(&env)
    }

    pub fn commit_choice(env: Env, player: Address, round_number: u32, commitment: BytesN<32>) -> Result<(), ArenaError> {
        require_not_paused(&env)?;
        player.require_auth();
        rounds::commit_choice(&env, player, round_number, commitment)
    }

    pub fn reveal_choice(env: Env, player: Address, round_number: u32, choice: Choice, nonce: BytesN<32>) -> Result<(), ArenaError> {
        require_not_paused(&env)?;
        player.require_auth();
        rounds::reveal_choice(&env, player, round_number, choice, nonce)
    }

    pub fn timeout_round(env: Env) -> Result<RoundState, ArenaError> {
        require_not_paused(&env)?;
        rounds::timeout_round(&env)
    }

    pub fn resolve_round(env: Env) -> Result<RoundState, ArenaError> {
        require_not_paused(&env)?;
        rounds::resolve_round(&env)
    }

    pub fn claim(env: Env, winner: Address) -> Result<i128, ArenaError> {
        require_not_paused(&env)?;
        if get_state(&env) != ArenaState::Completed {
            return Err(ArenaError::GameNotFinished);
        }
        winner.require_auth();
        if !env.storage().persistent().has(&DataKey::Survivor(winner.clone())) {
            return Err(ArenaError::NotASurvivor);
        }
        let prize: i128 = env.storage().instance().get(&PRIZE_POOL_KEY).unwrap_or(0);
        if prize <= 0 {
            return Err(ArenaError::NoPrizeToClaim);
        }
        if env.storage().persistent().has(&DataKey::PrizeClaimed(winner.clone())) {
            return Err(ArenaError::AlreadyClaimed);
        }
        env.storage().persistent().set(&DataKey::PrizeClaimed(winner.clone()), &prize);
        bump(&env, &DataKey::PrizeClaimed(winner.clone()));
        env.storage().instance().set(&PRIZE_POOL_KEY, &0i128);
        env.storage().instance().set(&GAME_FINISHED_KEY, &true);
        let token: Address = env.storage().instance().get(&TOKEN_KEY).ok_or(ArenaError::TokenNotSet)?;
        soroban_sdk::token::Client::new(&env, &token).transfer(&env.current_contract_address(), &winner, &prize);
        env.events().publish((TOPIC_CLAIM,), (winner, prize, EVENT_VERSION));
        Ok(prize)
    }

    pub fn set_metadata(env: Env, arena_id: u64, name: String, description: Option<String>, host: Address) -> Result<(), ArenaError> {
        let admin = Self::admin(env.clone());
        admin.require_auth();
        if name.len() == 0 { return Err(ArenaError::NameEmpty); }
        if name.len() > 64 { return Err(ArenaError::NameTooLong); }
        if let Some(ref desc) = description {
            if desc.len() > 256 { return Err(ArenaError::DescriptionTooLong); }
        }
        let metadata = ArenaMetadata { arena_id, name, description, host, created_at: env.ledger().timestamp() };
        env.storage().persistent().set(&DataKey::Metadata(arena_id), &metadata);
        bump(&env, &DataKey::Metadata(arena_id));
        env.storage().instance().set(&DataKey::ArenaId, &arena_id);
        Ok(())
    }

    pub fn get_metadata(env: Env, arena_id: u64) -> Option<ArenaMetadata> {
        env.storage().persistent().get(&DataKey::Metadata(arena_id))
    }

    pub fn get_config(env: Env) -> Result<ArenaConfig, ArenaError> {
        get_config(&env)
    }

    pub fn get_round(env: Env) -> Result<RoundState, ArenaError> {
        get_round(&env)
    }

    pub fn get_choice(env: Env, round_number: u32, player: Address) -> Option<Choice> {
        rounds::get_round_choices(&env, round_number).get(player)
    }

    pub fn get_arena_state(env: Env) -> Result<ArenaSnapshot, ArenaError> {
        let arena_state = get_state(&env);
        let config = get_config(&env)?;
        let round = get_round(&env)?;
        let all_players: soroban_sdk::Vec<Address> = env.storage().persistent().get(&DataKey::AllPlayers).unwrap_or(soroban_sdk::Vec::new(&env));
        let mut survivors = soroban_sdk::Vec::new(&env);
        let mut eliminated = soroban_sdk::Vec::new(&env);
        for p in all_players.iter() {
            if env.storage().persistent().has(&DataKey::Survivor(p.clone())) {
                survivors.push_back(p);
            } else {
                eliminated.push_back(p);
            }
        }
        let prize_pool: i128 = env.storage().instance().get(&PRIZE_POOL_KEY).unwrap_or(0);
        let yield_earned: i128 = env.storage().instance().get(&DataKey::YieldEarned).unwrap_or(0);
        let arena_id: u64 = env.storage().instance().get(&DataKey::ArenaId).unwrap_or(0);
        let winner: Option<Address> = all_players.iter().find(|p| env.storage().persistent().has(&DataKey::Winner(p.clone())));
        Ok(ArenaSnapshot {
            arena_id, state: arena_state, current_round: round.round_number,
            round_deadline: round.round_deadline, total_players: survivors.len() + eliminated.len(),
            survivors, eliminated, prize_pool, yield_earned, winner, config,
        })
    }

    pub fn get_arena_state_view(env: Env) -> Result<ArenaStateView, ArenaError> {
        let round = get_round(&env)?;
        let count: u32 = env.storage().instance().get(&SURVIVOR_COUNT_KEY).unwrap_or(0);
        let capacity: u32 = env.storage().instance().get(&CAPACITY_KEY).unwrap_or(bounds::MAX_ARENA_PARTICIPANTS);
        let prize: i128 = env.storage().instance().get(&PRIZE_POOL_KEY).unwrap_or(0);
        Ok(ArenaStateView {
            survivors_count: count, max_capacity: capacity,
            round_number: round.round_number, current_stake: prize, potential_payout: prize,
        })
    }

    pub fn get_user_state(env: Env, player: Address) -> UserStateView {
        let is_active = env.storage().persistent().has(&DataKey::Survivor(player.clone()));
        let finished = env.storage().instance().get::<_, bool>(&GAME_FINISHED_KEY).unwrap_or(false);
        let winner = env.storage().persistent().has(&DataKey::Winner(player));
        UserStateView { is_active, has_won: finished && winner }
    }

    pub fn get_full_state(env: Env, player: Address) -> Result<FullStateView, ArenaError> {
        let arena = Self::get_arena_state_view(env.clone())?;
        let user = Self::get_user_state(env, player);
        Ok(FullStateView {
            survivors_count: arena.survivors_count, max_capacity: arena.max_capacity,
            round_number: arena.round_number, current_stake: arena.current_stake,
            potential_payout: arena.potential_payout, is_active: user.is_active, has_won: user.has_won,
        })
    }

    pub fn state(env: Env) -> ArenaState {
        get_state(&env)
    }

    pub fn propose_upgrade(env: Env, new_wasm_hash: BytesN<32>) -> Result<(), ArenaError> {
        let admin = Self::admin(env.clone());
        admin.require_auth();
        if env.storage().instance().has(&DataKey::UpgradeHash) {
            return Err(ArenaError::UpgradeAlreadyPending);
        }
        let execute_after: u64 = env.ledger().timestamp() + TIMELOCK_PERIOD;
        env.storage().instance().set(&DataKey::UpgradeHash, &new_wasm_hash);
        env.storage().instance().set(&DataKey::UpgradeTimestamp, &execute_after);
        env.events().publish((TOPIC_UPGRADE_PROPOSED,), (EVENT_VERSION, new_wasm_hash, execute_after));
        Ok(())
    }

    pub fn execute_upgrade(env: Env) -> Result<(), ArenaError> {
        let admin = Self::admin(env.clone());
        admin.require_auth();
        let execute_after: u64 = env.storage().instance().get(&DataKey::UpgradeTimestamp).ok_or(ArenaError::NoPendingUpgrade)?;
        if env.ledger().timestamp() < execute_after {
            return Err(ArenaError::TimelockNotExpired);
        }
        let new_wasm_hash: BytesN<32> = env.storage().instance().get(&DataKey::UpgradeHash).ok_or(ArenaError::NoPendingUpgrade)?;
        env.storage().instance().remove(&DataKey::UpgradeHash);
        env.storage().instance().remove(&DataKey::UpgradeTimestamp);
        env.events().publish((TOPIC_UPGRADE_EXECUTED,), (EVENT_VERSION, new_wasm_hash.clone()));
        env.deployer().update_current_contract_wasm(new_wasm_hash);
        Ok(())
    }

    pub fn cancel_upgrade(env: Env) -> Result<(), ArenaError> {
        let admin = Self::admin(env.clone());
        admin.require_auth();
        if !env.storage().instance().has(&DataKey::UpgradeHash) {
            return Err(ArenaError::NoPendingUpgrade);
        }
        env.storage().instance().remove(&DataKey::UpgradeHash);
        env.storage().instance().remove(&DataKey::UpgradeTimestamp);
        env.events().publish((TOPIC_UPGRADE_CANCELLED,), (EVENT_VERSION,));
        Ok(())
    }

    pub fn pending_upgrade(env: Env) -> Option<(BytesN<32>, u64)> {
        let hash: Option<BytesN<32>> = env.storage().instance().get(&DataKey::UpgradeHash);
        let after: Option<u64> = env.storage().instance().get(&DataKey::UpgradeTimestamp);
        match (hash, after) {
            (Some(h), Some(a)) => Some((h, a)),
            _ => None,
        }
    }
}

pub(crate) mod invariants;

#[cfg(test)]
mod abi_guard;
#[cfg(test)]
mod commit_reveal_tests;
