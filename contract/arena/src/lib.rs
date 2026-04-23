#![no_std]

use soroban_sdk::{
    Address, Bytes, BytesN, Env, String, Symbol, Vec, contract, contracterror, contractimpl,
    contracttype, symbol_short, token,
};

mod bounds;

const ADMIN_KEY: Symbol = symbol_short!("ADMIN");
const TOKEN_KEY: Symbol = symbol_short!("TOKEN");
const CAPACITY_KEY: Symbol = symbol_short!("CAPACITY");
const PRIZE_POOL_KEY: Symbol = symbol_short!("POOL");
const YIELD_KEY: Symbol = symbol_short!("YIELD");
const WINNER_SHARE_KEY: Symbol = symbol_short!("WY_BPS");
const SURVIVOR_COUNT_KEY: Symbol = symbol_short!("S_COUNT");
const CANCELLED_KEY: Symbol = symbol_short!("CANCEL");
const GAME_FINISHED_KEY: Symbol = symbol_short!("FINISHED");
const PAUSED_KEY: Symbol = symbol_short!("PAUSED");
const PENDING_HASH_KEY: Symbol = symbol_short!("P_HASH");
const EXECUTE_AFTER_KEY: Symbol = symbol_short!("P_AFTER");
const STATE_KEY: Symbol = symbol_short!("STATE");
const WINNER_ADDR_KEY: Symbol = symbol_short!("WINNER");
const FACTORY_KEY: Symbol = symbol_short!("FACTORY");
const CREATOR_KEY: Symbol = symbol_short!("CREATOR");

const DEFAULT_WINNER_YIELD_SHARE_BPS: u32 = 7_000;
const BPS_DENOMINATOR: i128 = 10_000;
const TIMELOCK_PERIOD: u64 = 48 * 60 * 60;
const GAME_TTL_THRESHOLD: u32 = 100_000;
const GAME_TTL_EXTEND_TO: u32 = 535_680;

const TOPIC_ROUND_RESOLVED: Symbol = symbol_short!("RSLVD");
const TOPIC_YIELD_DISTRIBUTED: Symbol = symbol_short!("Y_DIST");
const TOPIC_PAUSED: Symbol = symbol_short!("PAUSED");
const TOPIC_UNPAUSED: Symbol = symbol_short!("UNPAUSED");
const TOPIC_LEAVE: Symbol = symbol_short!("LEAVE");
const TOPIC_MAX_ROUNDS: Symbol = symbol_short!("MX_ROUND");
const TOPIC_STATE_CHANGED: Symbol = symbol_short!("ST_CHG");
const TOPIC_PLAYER_JOINED: Symbol = symbol_short!("P_JOIN");
const TOPIC_CHOICE_SUBMITTED: Symbol = symbol_short!("CH_SUB");
const TOPIC_PLAYER_ELIMINATED: Symbol = symbol_short!("P_ELIM");
const TOPIC_WINNER_DECLARED: Symbol = symbol_short!("W_DECL");
const TOPIC_ARENA_CANCELLED: Symbol = symbol_short!("A_CANC");
const TOPIC_ARENA_EXPIRED: Symbol = symbol_short!("A_EXP");

const TOPIC_UPGRADE_PROPOSED: Symbol = symbol_short!("UP_PROP");
const TOPIC_UPGRADE_EXECUTED: Symbol = symbol_short!("UP_EXEC");
const TOPIC_UPGRADE_CANCELLED: Symbol = symbol_short!("UP_CANC");

const TIMELOCK_PERIOD: u64 = 48 * 60 * 60; // 48 hours

const GAME_TTL_THRESHOLD: u32 = 17280; // 1 day
const GAME_TTL_EXTEND_TO: u32 = 120960; // 7 days


const EVENT_VERSION: u32 = 1;

// ── Error codes ───────────────────────────────────────────────────────────────

#[contracterror]
#[derive(Copy, Clone, Debug, Eq, PartialEq, PartialOrd, Ord)]
#[repr(u32)]
pub enum ArenaError {
    AlreadyInitialized = 1,
    InvalidRoundSpeed = 2,
    RoundAlreadyActive = 3,
    NoActiveRound = 4,
    SubmissionWindowClosed = 5,
    SubmissionAlreadyExists = 6,
    RoundStillOpen = 7,
    RoundDeadlineOverflow = 8,
    NotInitialized = 9,
    Paused = 10,
    ArenaFull = 11,
    AlreadyJoined = 12,
    InvalidAmount = 13,
    NoPrizeToClaim = 14,
    AlreadyClaimed = 15,
    ReentrancyGuard = 16,
    NotASurvivor = 17,
    GameAlreadyFinished = 18,
    TokenNotSet = 19,
    MaxSubmissionsPerRound = 20,
    PlayerEliminated = 21,
    WrongRoundNumber = 22,
    NotEnoughPlayers = 23,
    InvalidCapacity = 24,
    NoPendingUpgrade = 25,
    TimelockNotExpired = 26,
    GameNotFinished = 27,
    TokenConfigurationLocked = 28,
    UpgradeAlreadyPending = 29,
    WinnerAlreadySet = 30,
    WinnerNotSet = 31,
    AlreadyCancelled = 32,
    InvalidMaxRounds = 33,
    NameTooLong = 34,
    NameEmpty = 35,
    DescriptionTooLong = 36,
    NoCommitment = 37,
    CommitmentMismatch = 38,
    RevealDeadlinePassed = 39,
    CommitDeadlinePassed = 40,
    AlreadyCommitted = 41,
    DeadlineTooSoon = 42,
    DeadlineTooFar = 43,
    DeadlineNotReached = 44,
    HashMismatch = 45,
    InvalidGracePeriod = 46,
}

#[contracttype]
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum Choice {
    Heads = 0,
    Tails = 1,
}

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ArenaConfig {
    pub round_speed_in_ledgers: u32,
    pub required_stake_amount: i128,
    pub max_rounds: u32,
    pub winner_yield_share_bps: u32,
    pub grace_period_seconds: u64,
    pub join_deadline: u64,
    /// Platform win fee in basis points, snapshotted at arena creation.
    /// Payout uses this value rather than the current global fee so that
    /// fee changes cannot retroactively affect an in-progress game.
    pub win_fee_bps: u32,
}

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct RoundState {
    pub round_number: u32,
    pub round_start_ledger: u32,
    pub round_deadline_ledger: u32,
    pub active: bool,
    pub total_submissions: u32,
    pub timed_out: bool,
    pub finished: bool,
}

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct UserStateView {
    pub is_active: bool,
    pub has_won: bool,
}

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ArenaStateView {
    pub survivors_count: u32,
    pub max_capacity: u32,
    pub round_number: u32,
    pub current_stake: i128,
    pub potential_payout: i128,
}

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct FullStateView {
    pub survivors_count: u32,
    pub max_capacity: u32,
    pub round_number: u32,
    pub current_stake: i128,
    pub potential_payout: i128,
    pub is_active: bool,
    pub has_won: bool,
}

#[contracttype]
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum ArenaState {
    Pending,
    Active,
    Completed,
    Cancelled,
}

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ArenaStateChanged {
    pub old_state: ArenaState,
    pub new_state: ArenaState,
}

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ArenaMetadata {
    pub arena_id: u64,
    pub name: String,
    pub description: Option<String>,
    pub host: Address,
    pub created_at: u64,
    pub is_private: bool,
}

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct YieldDistributed {
    pub winner_yield: i128,
    pub eliminated_yield: i128,
    pub eliminated_count: u32,
}

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct PlayerJoined {
    pub arena_id: u64,
    pub player: Address,
    pub entry_fee: i128,
}

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ChoiceSubmitted {
    pub arena_id: u64,
    pub round: u32,
    pub player: Address,
}

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct RoundResolved {
    pub arena_id: u64,
    pub round: u32,
    pub heads_count: u32,
    pub tails_count: u32,
    pub eliminated: Vec<Address>,
}

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct PlayerEliminated {
    pub arena_id: u64,
    pub round: u32,
    pub player: Address,
    pub choice_made: Choice,
}

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct WinnerDeclared {
    pub arena_id: u64,
    pub winner: Address,
    pub prize_pool: i128,
    pub yield_earned: i128,
    pub total_rounds: u32,
}

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ArenaCancelled {
    pub arena_id: u64,
    pub reason: String,
}

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ArenaExpired {
    pub arena_id: u64,
    pub refunded_players: u32,
}

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ArenaSnapshot {
    pub arena_id: u64,
    pub state: ArenaState,
    pub round_number: u32,
    pub survivors_count: u32,
    pub max_capacity: u32,
    pub current_stake: i128,
    pub potential_payout: i128,
}

macro_rules! assert_state {
    ($current:expr, $expected:pat) => {
        match $current {
            $expected => {},
            _ => panic!("Invalid state transition: current state {:?} is not allowed for this operation", $current),
        }
    };
}

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct FullStateView {
    pub survivors_count: u32,
    pub max_capacity: u32,
    pub round_number: u32,
    pub current_stake: i128,
    pub potential_payout: i128,
    pub is_active: bool,
    pub has_won: bool,
}



#[contracttype]
#[derive(Clone)]
enum DataKey {
    Config,
    Round,
    Submission(u32, Address),
    Choices(u64, u32, Address),
    Commitment(u32, Address),
    RoundPlayers(u32),
    AllPlayers,
    Survivor(Address),
    Eliminated(Address),
    PrizeClaimed(Address),
    Claimable(Address),
    Winner(Address),
    Refunded(Address),
    Metadata(u64),
}

#[contract]
pub struct ArenaContract;

#[contractimpl]
impl ArenaContract {
    pub fn __constructor(env: Env, admin: Address) {
        admin.require_auth();
        env.storage().instance().set(&ADMIN_KEY, &admin);
    }

    pub fn admin(env: Env) -> Address {
        env.storage()
            .instance()
            .get(&ADMIN_KEY)
            .expect("not initialized")
    }

    pub fn set_admin(env: Env, new_admin: Address) {
        let admin = Self::admin(env.clone());
        admin.require_auth();
        env.storage().instance().set(&ADMIN_KEY, &new_admin);
    }

    pub fn init_factory(env: Env, factory: Address, creator: Address) {
        let admin = Self::admin(env.clone());
        admin.require_auth();
        env.storage().instance().set(&FACTORY_KEY, &factory);
        env.storage().instance().set(&CREATOR_KEY, &creator);
    }

    pub fn init(
        env: Env,
        round_speed_in_ledgers: u32,
        required_stake_amount: i128,
        join_deadline: u64,
    ) -> Result<(), ArenaError> {
        Self::init_with_fee(env, round_speed_in_ledgers, required_stake_amount, join_deadline, 0)
    }

    pub fn init_with_fee(
        env: Env,
        round_speed_in_ledgers: u32,
        required_stake_amount: i128,
        join_deadline: u64,
        win_fee_bps: u32,
    ) -> Result<(), ArenaError> {
        if env.storage().instance().has(&DataKey::Config) {
            return Err(ArenaError::AlreadyInitialized);
        }

        let now = env.ledger().timestamp();
        if join_deadline < now + 3600 {
            return Err(ArenaError::DeadlineTooSoon);
        }
        if join_deadline > now + 604800 {
            return Err(ArenaError::DeadlineTooFar);
        }

        if round_speed_in_ledgers == 0 || round_speed_in_ledgers > bounds::MAX_SPEED_LEDGERS {
            return Err(ArenaError::InvalidRoundSpeed);
        }
        if required_stake_amount < bounds::MIN_REQUIRED_STAKE {
            return Err(ArenaError::InvalidAmount);
        }

        env.storage().instance().extend_ttl(GAME_TTL_THRESHOLD, GAME_TTL_EXTEND_TO);
        env.storage().instance().set(
            &DataKey::Config,
            &ArenaConfig {
                round_speed_in_ledgers,
                required_stake_amount,
                max_rounds: bounds::DEFAULT_MAX_ROUNDS,
                winner_yield_share_bps: DEFAULT_WINNER_YIELD_SHARE_BPS,
                grace_period_seconds: bounds::DEFAULT_GRACE_PERIOD_SECONDS,
                join_deadline,
                win_fee_bps,
            },
        );
        env.storage().instance().set(
            &DataKey::Round,
            &RoundState {
                round_number: 0,
                round_start_ledger: 0,
                round_deadline_ledger: 0,
                active: false,
                total_submissions: 0,
                timed_out: false,
                finished: false,
            },
        );
        env.storage()
            .instance()
            .set(&WINNER_SHARE_KEY, &DEFAULT_WINNER_YIELD_SHARE_BPS);
        env.storage()
            .persistent()
            .set(&DataKey::AllPlayers, &Vec::<Address>::new(&env));
        Ok(())
    }

    pub fn set_token(env: Env, token: Address) -> Result<(), ArenaError> {
        let admin = Self::admin(env.clone());
        admin.require_auth();
        let survivors_count: u32 = env
            .storage()
            .instance()
            .get(&SURVIVOR_COUNT_KEY)
            .unwrap_or(0);
        if survivors_count > 0 {
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

    pub fn set_winner_yield_share_bps(env: Env, bps: u32) -> Result<(), ArenaError> {
        let admin = Self::admin(env.clone());
        admin.require_auth();
        if bps > 10_000 {
            return Err(ArenaError::InvalidAmount);
        }
        let mut config = get_config(&env)?;
        config.winner_yield_share_bps = bps;
        env.storage().instance().set(&DataKey::Config, &config);
        env.storage().instance().set(&WINNER_SHARE_KEY, &bps);
        Ok(())
    }

    pub fn join(env: Env, player: Address, amount: i128) -> Result<(), ArenaError> {
        player.require_auth();
        require_not_paused(&env)?;
        if Self::is_cancelled(env.clone()) {
            return Err(ArenaError::AlreadyCancelled);
        }
        let config = get_config(&env)?;
        let arena_id = env.storage().instance().get(&DataKey::ArenaId).unwrap_or(0);
        
        if config.is_private {
            if let Some(factory) = env.storage().instance().get::<_, Address>(&DataKey::FactoryAddress) {
                let is_whitelisted = env.invoke_contract::<bool>(
                    &factory,
                    &soroban_sdk::Symbol::new(&env, "is_whitelisted"),
                    soroban_sdk::vec![&env, arena_id.into_val(&env), player.clone().into_val(&env)],
                );
                if !is_whitelisted {
                    return Err(ArenaError::NotWhitelisted);
                }
            }
        }

        if amount != config.required_stake_amount {
            return Err(ArenaError::InvalidAmount);
        }
        let key = DataKey::Survivor(player.clone());
        if env.storage().persistent().has(&key)
            || env
                .storage()
                .persistent()
                .has(&DataKey::Eliminated(player.clone()))
        {
            return Err(ArenaError::AlreadyJoined);
        }
        let capacity = capacity(&env);
        let count: u32 = env
            .storage()
            .instance()
            .get(&SURVIVOR_COUNT_KEY)
            .unwrap_or(0);
        if count >= capacity {
            return Err(ArenaError::ArenaFull);
        }
        let token_id: Address = env
            .storage()
            .instance()
            .get(&TOKEN_KEY)
            .ok_or(ArenaError::TokenNotSet)?;
        token::Client::new(&env, &token_id).transfer(
            &player,
            &env.current_contract_address(),
            &amount,
        );
        env.storage().persistent().set(&key, &true);
        bump(&env, &key);
        env.storage()
            .instance()
            .set(&SURVIVOR_COUNT_KEY, &(count + 1));
        let mut players = all_players(&env);
        players.push_back(player);
        env.storage()
            .persistent()
            .set(&DataKey::AllPlayers, &players);
        
        env.events().publish(
            (TOPIC_PLAYER_JOINED,),
            PlayerJoined {
                arena_id,
                player: player.clone(),
                entry_fee: amount,
            },
        );
        Ok(())
    }

    /// Expire an unfilled arena past its join deadline. Callable by anyone.
    pub fn expire_arena(env: Env) -> Result<(), ArenaError> {
        let current_state = get_state(&env);
        assert_state!(current_state, ArenaState::Pending);

        let config = get_config(&env)?;
        if env.ledger().timestamp() <= config.join_deadline {
            return Err(ArenaError::DeadlineNotReached);
        }

        let all_players: Vec<Address> = env.storage().persistent().get(&DataKey::AllPlayers).unwrap_or(Vec::new(&env));
        let mut refunded_count: u32 = 0;
        if !all_players.is_empty() {
            let token: Address = env.storage().instance().get(&TOKEN_KEY).ok_or(ArenaError::TokenNotSet)?;
            let refund_amount = config.required_stake_amount;
            let token_client = token::Client::new(&env, &token);

            for player in all_players.iter() {
                if env.storage().persistent().has(&DataKey::Survivor(player.clone()))
                    && !env.storage().persistent().has(&DataKey::Refunded(player.clone()))
                {
                    env.storage().persistent().set(&DataKey::Refunded(player.clone()), &());
                    bump(&env, &DataKey::Refunded(player.clone()));
                    token_client.transfer(&env.current_contract_address(), &player, &refund_amount);
                    refunded_count += 1;
                }
            }
            env.storage().instance().set(&PRIZE_POOL_KEY, &0i128);
        }

        env.storage().instance().set(&CANCELLED_KEY, &true);
        env.storage().instance().set(&GAME_FINISHED_KEY, &true);
        set_state(&env, ArenaState::Cancelled);

        env.events().publish(
            (TOPIC_ARENA_EXPIRED,),
            ArenaExpired {
                arena_id: 0,
                refunded_players: refunded_count,
            },
        );

        Ok(())
    }

    /// Return the join deadline timestamp stored in the config.
    pub fn get_join_deadline(env: Env) -> u64 {
        let config: ArenaConfig = env
            .storage()
            .instance()
            .get(&DataKey::Config)
            .expect("not initialized");
        config.join_deadline
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

    pub fn set_grace_period_seconds(env: Env, grace_period_seconds: u64) -> Result<(), ArenaError> {
        let admin = Self::admin(env.clone());
        admin.require_auth();
        if grace_period_seconds > bounds::MAX_GRACE_PERIOD_SECONDS {
            return Err(ArenaError::InvalidGracePeriod);
        }
        let mut config = get_config(&env)?;
        config.grace_period_seconds = grace_period_seconds;
        env.storage().instance().set(&DataKey::Config, &config);
        Ok(())
    }

    pub fn is_cancelled(env: Env) -> bool {
        env.storage().instance().get::<_, bool>(&CANCELLED_KEY).unwrap_or(false)
    }

    pub fn leave(env: Env, player: Address) -> Result<i128, ArenaError> {
        player.require_auth();
        require_not_paused(&env)?;
        let current_state = get_state(&env);
        assert_state!(current_state, ArenaState::Pending);

        let round = get_round(&env)?;
        if round.round_number != 0 {
            return Err(ArenaError::RoundAlreadyActive);
        }

        let survivor_key = DataKey::Survivor(player.clone());
        if !env.storage().persistent().has(&survivor_key) {
            return Err(ArenaError::NotASurvivor);
        }

        let config = get_config(&env)?;
        let refund = config.required_stake_amount;
        let token: Address = env.storage().instance().get(&TOKEN_KEY).ok_or(ArenaError::TokenNotSet)?;

        env.storage().persistent().remove(&survivor_key);
        let count: u32 = env.storage().instance().get(&SURVIVOR_COUNT_KEY).unwrap_or(0);
        env.storage().instance().set(&SURVIVOR_COUNT_KEY, &count.saturating_sub(1));
            
        let mut all_players: Vec<Address> = env.storage().persistent().get(&DataKey::AllPlayers).unwrap_or(Vec::new(&env));
        if let Some(i) = all_players.first_index_of(&player) {
            all_players.remove(i);
        }
        env.storage().persistent().set(&DataKey::AllPlayers, &all_players);
        bump(&env, &DataKey::AllPlayers);

        let pool: i128 = env.storage().instance().get(&PRIZE_POOL_KEY).unwrap_or(0);
        env.storage()
            .instance()
            .set(&PRIZE_POOL_KEY, &(pool + amount));
        Ok(())
    }

    pub fn start_round(env: Env) -> Result<RoundState, ArenaError> {
        require_not_paused(&env)?;
        let config = get_config(&env)?;
        let previous = get_round(&env)?;
        if previous.active {
            return Err(ArenaError::RoundAlreadyActive);
        }
        let survivors: u32 = env
            .storage()
            .instance()
            .get(&SURVIVOR_COUNT_KEY)
            .unwrap_or(0);
        if survivors < 2 {
            return Err(ArenaError::NotEnoughPlayers);
        }
        let start = env.ledger().sequence();
        let deadline = start
            .checked_add(config.round_speed_in_ledgers)
            .ok_or(ArenaError::RoundDeadlineOverflow)?;
        let round = RoundState {
            round_number: previous.round_number + 1,
            round_start_ledger: start,
            round_deadline_ledger: deadline,
            active: true,
            total_submissions: 0,
            timed_out: false,
            finished: false,
        };
        env.storage().instance().set(&DataKey::Round, &round);
        env.storage()
            .instance()
            .set(&STATE_KEY, &ArenaState::Active);
        Ok(round)
    }

    pub fn submit_choice(
        env: Env,
        player: Address,
        round_number: u32,
        choice: Choice,
    ) -> Result<(), ArenaError> {
        player.require_auth();
        require_not_paused(&env)?;
        let mut round = get_round(&env)?;
        if !round.active {
            return Err(ArenaError::NoActiveRound);
        }
        if round.round_number != round_number {
            return Err(ArenaError::WrongRoundNumber);
        }
        let config = get_config(&env)?;
        let grace_ledgers = grace_period_to_ledgers(config.grace_period_seconds);
        let effective_deadline = round
            .round_deadline_ledger
            .checked_add(grace_ledgers)
            .ok_or(ArenaError::RoundDeadlineOverflow)?;
        if env.ledger().sequence() > effective_deadline {
            return Err(ArenaError::SubmissionWindowClosed);
        }
        if !env
            .storage()
            .persistent()
            .has(&DataKey::Survivor(player.clone()))
        {
            return Err(ArenaError::PlayerEliminated);
        }
        let key = DataKey::Choices(0, round_number, player.clone());
        if env.storage().persistent().has(&key) {
            return Err(ArenaError::SubmissionAlreadyExists);
        }
        env.storage().persistent().set(&key, &choice);
        bump(&env, &key);
        let players_key = DataKey::RoundPlayers(round_number);
        let mut round_players: Vec<Address> = env
            .storage()
            .persistent()
            .get(&players_key)
            .unwrap_or(Vec::new(&env));
        round_players.push_back(player);
        env.storage().persistent().set(&players_key, &round_players);
        round.total_submissions += 1;
        env.storage().instance().set(&DataKey::Round, &round);
        Ok(())
    }

    pub fn commit_choice(
        env: Env,
        player: Address,
        round_number: u32,
        commitment: BytesN<32>,
    ) -> Result<(), ArenaError> {
        player.require_auth();
        let key = DataKey::Commitment(round_number, player);
        if env.storage().persistent().has(&key) {
            return Err(ArenaError::AlreadyCommitted);
        }
        env.storage().persistent().set(&key, &commitment);
        bump(&env, &key);
        Ok(())
    }

    pub fn reveal_choice(
        env: Env,
        player: Address,
        round_number: u32,
        choice: Choice,
        _salt: Bytes,
    ) -> Result<(), ArenaError> {
        Self::submit_choice(env, player, round_number, choice)
    }

    pub fn timeout_round(env: Env) -> Result<RoundState, ArenaError> {
        require_not_paused(&env)?;
        let mut round = get_round(&env)?;
        if !round.active {
            return Err(ArenaError::NoActiveRound);
        }
        if env.ledger().sequence() <= round.round_deadline_ledger {
            return Err(ArenaError::RoundStillOpen);
        }
        round.active = false;
        round.timed_out = true;
        env.storage().instance().set(&DataKey::Round, &round);
        Ok(round)
    }

    pub fn resolve_round(env: Env) -> Result<RoundState, ArenaError> {
        require_not_paused(&env)?;
        let mut round = get_round(&env)?;
        let config = get_config(&env)?;
        if !round.active {
            return Err(ArenaError::NoActiveRound);
        }
        let grace_ledgers = grace_period_to_ledgers(config.grace_period_seconds);
        let resolve_after = round
            .round_deadline_ledger
            .checked_add(grace_ledgers)
            .ok_or(ArenaError::RoundDeadlineOverflow)?;
        if env.ledger().sequence() <= resolve_after {
            return Err(ArenaError::RoundStillOpen);
        }
        let players = all_players(&env);
        let mut heads = 0u32;
        let mut tails = 0u32;
        for player in players.iter() {
            if !env
                .storage()
                .persistent()
                .has(&DataKey::Survivor(player.clone()))
            {
                continue;
            }
            match env
                .storage()
                .persistent()
                .get(&DataKey::Choices(0, round.round_number, player))
            {
                Some(Choice::Heads) => heads += 1,
                Some(Choice::Tails) => tails += 1,
                None => {}
            }
        }
        let surviving_choice = choose_surviving_side(&env, heads, tails);
        let mut survivor_count = 0u32;
        let mut eliminated_count = 0u32;
        for player in players.iter() {
            let survivor_key = DataKey::Survivor(player.clone());
            if !env.storage().persistent().has(&survivor_key) {
                continue;
            }
            let player_choice = env
                .storage()
                .persistent()
                .get(&DataKey::Choices(0, round.round_number, player.clone()));
            let survives = surviving_choice.is_none() || player_choice == surviving_choice;
            if survives {
                survivor_count += 1;
            } else {
                env.storage().persistent().remove(&survivor_key);
                env.storage()
                    .persistent()
                    .set(&DataKey::Eliminated(player.clone()), &true);
                eliminated_count += 1;
            }
        }
        env.storage()
            .instance()
            .set(&SURVIVOR_COUNT_KEY, &survivor_count);
        round.active = false;
        round.finished = true;
        env.storage().instance().set(&DataKey::Round, &round);
        if survivor_count <= 1 {
            env.storage()
                .instance()
                .set(&STATE_KEY, &ArenaState::Completed);
        }
        env.events().publish(
            (TOPIC_ROUND_RESOLVED,),
            (round.round_number, heads, tails, eliminated_count),
        );
        Ok(round)
    }

    pub fn set_winner(
        env: Env,
        player: Address,
        principal_pool: i128,
        yield_earned: i128,
    ) -> Result<(), ArenaError> {
        let admin = Self::admin(env.clone());
        admin.require_auth();
        if env.storage().instance().has(&WINNER_ADDR_KEY) {
            return Err(ArenaError::WinnerAlreadySet);
        }
        if principal_pool < 0 || yield_earned < 0 {
            return Err(ArenaError::InvalidAmount);
        }
        let config = get_config(&env)?;
        let winner_yield = yield_earned
            .checked_mul(config.winner_yield_share_bps as i128)
            .and_then(|v| v.checked_div(BPS_DENOMINATOR))
            .ok_or(ArenaError::InvalidAmount)?;
        let eliminated_yield = yield_earned
            .checked_sub(winner_yield)
            .ok_or(ArenaError::InvalidAmount)?;
        let eliminated = eliminated_players(&env);
        let eliminated_count = eliminated.len();
        let per_eliminated = if eliminated_count == 0 {
            0
        } else {
            eliminated_yield / eliminated_count as i128
        };
        let winner_amount = principal_pool
            .checked_add(winner_yield)
            .ok_or(ArenaError::InvalidAmount)?;
        env.storage()
            .persistent()
            .set(&DataKey::Claimable(player.clone()), &winner_amount);
        env.storage()
            .persistent()
            .set(&DataKey::Winner(player.clone()), &true);
        env.storage().instance().set(&WINNER_ADDR_KEY, &player);
        env.storage()
            .instance()
            .set(&PRIZE_POOL_KEY, &principal_pool);
        env.storage().instance().set(&YIELD_KEY, &yield_earned);
        for eliminated_player in eliminated.iter() {
            env.storage()
                .persistent()
                .set(&DataKey::Claimable(eliminated_player), &per_eliminated);
        }
        env.storage()
            .instance()
            .set(&STATE_KEY, &ArenaState::Completed);
        env.events().publish(
            (TOPIC_YIELD_DISTRIBUTED,),
            YieldDistributed {
                winner_yield,
                eliminated_yield,
                eliminated_count,
            },
        );
        Ok(())
    }

    pub fn claim(env: Env, player: Address) -> Result<i128, ArenaError> {
        player.require_auth();
        let claim_key = DataKey::Claimable(player.clone());
        let amount: i128 = env.storage().persistent().get(&claim_key).unwrap_or(0);
        if amount <= 0 {
            return Err(ArenaError::NoPrizeToClaim);
        }
        let claimed_key = DataKey::PrizeClaimed(player.clone());
        if env.storage().persistent().has(&claimed_key) {
            return Err(ArenaError::AlreadyClaimed);
        }
        env.storage().persistent().set(&claimed_key, &amount);
        env.storage().persistent().remove(&claim_key);
        if let Some(token_id) = env.storage().instance().get::<_, Address>(&TOKEN_KEY) {
            token::Client::new(&env, &token_id).transfer(
                &env.current_contract_address(),
                &player,
                &amount,
            );
        }
        Ok(amount)
    }

    pub fn cancel_arena(env: Env) -> Result<(), ArenaError> {
        let admin = Self::admin(env.clone());
        admin.require_auth();
        require_not_paused(&env)?;
        if Self::is_cancelled(env.clone()) {
            return Err(ArenaError::AlreadyCancelled);
        }
        if state(&env) == ArenaState::Completed {
            return Err(ArenaError::GameAlreadyFinished);
        }
        let token_id: Option<Address> = env.storage().instance().get(&TOKEN_KEY);
        let config = get_config(&env)?;
        if let Some(token_id) = token_id {
            let token_client = token::Client::new(&env, &token_id);
            for player in all_players(&env).iter() {
                if env
                    .storage()
                    .persistent()
                    .has(&DataKey::Survivor(player.clone()))
                {
                    token_client.transfer(
                        &env.current_contract_address(),
                        &player,
                        &config.required_stake_amount,
                    );
                }
            }
        }
        env.storage().instance().set(&CANCELLED_KEY, &true);
        env.storage()
            .instance()
            .set(&STATE_KEY, &ArenaState::Cancelled);
        Ok(())
    }

    pub fn is_cancelled(env: Env) -> bool {
        env.storage()
            .instance()
            .get(&CANCELLED_KEY)
            .unwrap_or(false)
    }

    pub fn leave(env: Env, player: Address) -> Result<(), ArenaError> {
        player.require_auth();
        if !env
            .storage()
            .persistent()
            .has(&DataKey::Survivor(player.clone()))
        {
            return Err(ArenaError::NotASurvivor);
        }
        env.storage()
            .persistent()
            .remove(&DataKey::Survivor(player));
        let count: u32 = env
            .storage()
            .instance()
            .get(&SURVIVOR_COUNT_KEY)
            .unwrap_or(0);
        env.storage()
            .instance()
            .set(&SURVIVOR_COUNT_KEY, &count.saturating_sub(1));
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

    pub fn get_config(env: Env) -> Result<ArenaConfig, ArenaError> {
        get_config(&env)
    }

    pub fn get_round(env: Env) -> Result<RoundState, ArenaError> {
        get_round(&env)
    }

    pub fn get_choice(env: Env, round_number: u32, player: Address) -> Option<Choice> {
        env.storage()
            .persistent()
            .get(&DataKey::Choices(0, round_number, player))
    }

    pub fn get_arena_state(env: Env) -> Result<ArenaStateView, ArenaError> {
        let round = get_round(&env)?;
        Ok(ArenaStateView {
            survivors_count: env
                .storage()
                .instance()
                .get(&SURVIVOR_COUNT_KEY)
                .unwrap_or(0),
            max_capacity: capacity(&env),
            round_number: round.round_number,
            current_stake: env.storage().instance().get(&PRIZE_POOL_KEY).unwrap_or(0),
            potential_payout: env.storage().instance().get(&PRIZE_POOL_KEY).unwrap_or(0),
        })
    }

    pub fn get_user_state(env: Env, player: Address) -> UserStateView {
        let is_active = env
            .storage()
            .persistent()
            .has(&DataKey::Survivor(player.clone()));
        let has_won = env.storage().persistent().has(&DataKey::Winner(player));
        UserStateView { is_active, has_won }
    }

    pub fn get_full_state(env: Env, player: Address) -> Result<FullStateView, ArenaError> {
        let arena = Self::get_arena_state(env.clone())?;
        let user = Self::get_user_state(env, player);
        Ok(FullStateView {
            survivors_count: arena.survivors_count,
            max_capacity: arena.max_capacity,
            round_number: arena.round_number,
            current_stake: arena.current_stake,
            potential_payout: arena.potential_payout,
            is_active: user.is_active,
            has_won: user.has_won,
        })
    }

    pub fn set_metadata(
        env: Env,
        arena_id: u64,
        name: String,
        description: Option<String>,
        host: Address,
    ) -> Result<(), ArenaError> {
        let admin = Self::admin(env.clone());
        admin.require_auth();
        if name.len() == 0 {
            return Err(ArenaError::NameEmpty);
        }
        if name.len() > 64 {
            return Err(ArenaError::NameTooLong);
        }
        if let Some(ref text) = description {
            if text.len() > 256 {
                return Err(ArenaError::DescriptionTooLong);
            }
        }
        let metadata = ArenaMetadata {
            arena_id,
            name,
            description,
            host,
            created_at: env.ledger().timestamp(),
            is_private: get_config(&env).map(|c| c.is_private).unwrap_or(false),
        };
        env.storage()
            .persistent()
            .set(&DataKey::Metadata(arena_id), &metadata);
        Ok(())
    }

    pub fn get_metadata(env: Env, arena_id: u64) -> Option<ArenaMetadata> {
        env.storage().persistent().get(&DataKey::Metadata(arena_id))
    }

    pub fn pause(env: Env) {
        let admin = Self::admin(env.clone());
        admin.require_auth();
        env.storage().instance().set(&PAUSED_KEY, &true);
        env.events().publish((TOPIC_PAUSED,), ());
    }

    pub fn unpause(env: Env) {
        let admin = Self::admin(env.clone());
        admin.require_auth();
        env.storage().instance().remove(&PAUSED_KEY);
        env.events().publish((TOPIC_UNPAUSED,), ());
    }

    pub fn is_paused(env: Env) -> bool {
        env.storage().instance().get(&PAUSED_KEY).unwrap_or(false)
    }

    pub fn propose_upgrade(env: Env, new_wasm_hash: BytesN<32>) -> Result<(), ArenaError> {
        let admin = Self::admin(env.clone());
        admin.require_auth();
        if env.storage().instance().has(&PENDING_HASH_KEY) {
            return Err(ArenaError::UpgradeAlreadyPending);
        }
        let execute_after = env.ledger().timestamp() + TIMELOCK_PERIOD;
        env.storage()
            .instance()
            .set(&PENDING_HASH_KEY, &new_wasm_hash);
        env.storage()
            .instance()
            .set(&EXECUTE_AFTER_KEY, &execute_after);
        Ok(())
    }

    pub fn execute_upgrade(env: Env, expected_hash: BytesN<32>) -> Result<(), ArenaError> {
        let admin: Address = env
            .storage()
            .instance()
            .get(&ADMIN_KEY)
            .ok_or(ArenaError::NotInitialized)?;
        admin.require_auth();
        let execute_after: u64 = env
            .storage()
            .instance()
            .get(&EXECUTE_AFTER_KEY)
            .ok_or(ArenaError::NoPendingUpgrade)?;
        if env.ledger().timestamp() <= execute_after {
            return Err(ArenaError::TimelockNotExpired);
        }
        let stored_hash: BytesN<32> = env
            .storage()
            .instance()
            .get(&PENDING_HASH_KEY)
            .ok_or(ArenaError::NoPendingUpgrade)?;
        if stored_hash != expected_hash {
            return Err(ArenaError::HashMismatch);
        }
        env.storage().instance().remove(&PENDING_HASH_KEY);
        env.storage().instance().remove(&EXECUTE_AFTER_KEY);
        env.events().publish(
            (TOPIC_UPGRADE_EXECUTED,),
            (EVENT_VERSION, stored_hash.clone()),
        );
        env.deployer().update_current_contract_wasm(stored_hash);
        Ok(())
    }

    pub fn cancel_upgrade(env: Env) -> Result<(), ArenaError> {
        let admin = Self::admin(env.clone());
        admin.require_auth();
        if !env.storage().instance().has(&PENDING_HASH_KEY) {
            return Err(ArenaError::NoPendingUpgrade);
        }
        env.storage().instance().remove(&PENDING_HASH_KEY);
        env.storage().instance().remove(&EXECUTE_AFTER_KEY);
        Ok(())
    }

    pub fn pending_upgrade(env: Env) -> Option<(BytesN<32>, u64)> {
        let hash: Option<BytesN<32>> = env.storage().instance().get(&PENDING_HASH_KEY);
        let after: Option<u64> = env.storage().instance().get(&EXECUTE_AFTER_KEY);
        match (hash, after) {
            (Some(h), Some(a)) => Some((h, a)),
            _ => None,
        }
    }

    pub fn state(env: Env) -> ArenaState {
        state(&env)
    }
}

fn get_config(env: &Env) -> Result<ArenaConfig, ArenaError> {
    env.storage()
        .instance()
        .get(&DataKey::Config)
        .ok_or(ArenaError::NotInitialized)
}

fn get_round(env: &Env) -> Result<RoundState, ArenaError> {
    env.storage()
        .instance()
        .get(&DataKey::Round)
        .ok_or(ArenaError::NotInitialized)
}

fn state(env: &Env) -> ArenaState {
    env.storage()
        .instance()
        .get(&STATE_KEY)
        .unwrap_or(ArenaState::Pending)
}

fn capacity(env: &Env) -> u32 {
    env.storage()
        .instance()
        .get(&CAPACITY_KEY)
        .unwrap_or(bounds::MAX_ARENA_PARTICIPANTS)
}

fn all_players(env: &Env) -> Vec<Address> {
    env.storage()
        .persistent()
        .get(&DataKey::AllPlayers)
        .unwrap_or(Vec::new(env))
}

fn eliminated_players(env: &Env) -> Vec<Address> {
    let mut eliminated = Vec::new(env);
    for player in all_players(env).iter() {
        if env
            .storage()
            .persistent()
            .has(&DataKey::Eliminated(player.clone()))
        {
            eliminated.push_back(player);
        }
    }
    eliminated
}

fn choose_surviving_side(env: &Env, heads: u32, tails: u32) -> Option<Choice> {
    match (heads, tails) {
        (0, 0) => None,
        (0, _) => Some(Choice::Tails),
        (_, 0) => Some(Choice::Heads),
        _ if heads == tails => {
            if env.ledger().sequence() % 2 == 0 {
                Some(Choice::Heads)
            } else {
                Some(Choice::Tails)
            }
        }
        _ if heads < tails => Some(Choice::Heads),
        _ => Some(Choice::Tails),
    }
}

fn require_not_paused(env: &Env) -> Result<(), ArenaError> {
    if env.storage().instance().get(&PAUSED_KEY).unwrap_or(false) {
        return Err(ArenaError::Paused);
    }
    Ok(())
}

fn bump(env: &Env, key: &DataKey) {
    env.storage()
        .persistent()
        .extend_ttl(key, GAME_TTL_THRESHOLD, GAME_TTL_EXTEND_TO);
}

fn grace_period_to_ledgers(grace_period_seconds: u64) -> u32 {
    // Approximate Stellar ledger close to 5 seconds per ledger.
    ((grace_period_seconds + 4) / 5) as u32
}

#[cfg(test)]
mod abi_guard;

#[cfg(test)]
mod yield_share_tests {
    use super::*;
    use soroban_sdk::{testutils::Address as _, token::StellarAssetClient};

    fn setup(bps: u32) -> (Env, ArenaContractClient<'static>, Address, Vec<Address>) {
        let env = Env::default();
        env.mock_all_auths();
        let admin = Address::generate(&env);
        let token_admin = Address::generate(&env);
        let token_id = env
            .register_stellar_asset_contract_v2(token_admin.clone())
            .address();
        let token = StellarAssetClient::new(&env, &token_id);
        let contract_id = env.register(ArenaContract, ());
        let client = ArenaContractClient::new(&env, &contract_id);
        client.initialize(&admin);
        client.set_token(&token_id);
        client.init(&10u32, &100i128);
        client.set_winner_yield_share_bps(&bps);

        let players = Vec::from_array(
            &env,
            [
                Address::generate(&env),
                Address::generate(&env),
                Address::generate(&env),
            ],
        );
        for player in players.iter() {
            token.mint(&player, &1_000i128);
            client.join(&player, &100i128);
        }
        token.mint(&client.address, &100i128);
        env.as_contract(&client.address, || {
            env.storage()
                .persistent()
                .set(&DataKey::Eliminated(players.get(1).unwrap()), &true);
            env.storage()
                .persistent()
                .set(&DataKey::Eliminated(players.get(2).unwrap()), &true);
        });

        let env_static: &'static Env = unsafe { &*(&env as *const Env) };
        (
            env,
            ArenaContractClient::new(env_static, &contract_id),
            token_id,
            players,
        )
    }

    #[test]
    fn default_split_claims_70_30_yield() {
        let (_env, client, _token_id, players) = setup(7_000);
        let winner = players.get(0).unwrap();
        let eliminated = players.get(1).unwrap();

        client.set_winner(&winner, &300i128, &100i128);

        assert_eq!(client.claim(&winner), 370);
        assert_eq!(client.claim(&eliminated), 15);
    }

    #[test]
    fn full_winner_share_leaves_no_eliminated_yield() {
        let (_env, client, _token_id, players) = setup(10_000);
        let winner = players.get(0).unwrap();
        let eliminated = players.get(1).unwrap();

        client.set_winner(&winner, &300i128, &100i128);

        assert_eq!(client.claim(&winner), 400);
        assert_eq!(
            client.try_claim(&eliminated),
            Err(Ok(ArenaError::NoPrizeToClaim))
        );
    }

    #[test]
    fn half_split_divides_eliminated_yield_evenly() {
        let (_env, client, _token_id, players) = setup(5_000);
        let winner = players.get(0).unwrap();
        let eliminated = players.get(2).unwrap();

        client.set_winner(&winner, &300i128, &100i128);

        assert_eq!(client.claim(&winner), 350);
        assert_eq!(client.claim(&eliminated), 25);
    }
}

fn get_survivors(env: &Env) -> Vec<Address> {
    let all_players: Vec<Address> = env.storage().persistent().get(&DataKey::AllPlayers).unwrap_or(Vec::new(env));
    let mut survivors = Vec::new(env);
    for p in all_players.iter() {
        if env.storage().persistent().has(&DataKey::Survivor(p.clone())) {
            survivors.push_back(p);
        }
    }
    survivors
}

fn get_eliminated(env: &Env) -> Vec<Address> {
    let all_players: Vec<Address> = env.storage().persistent().get(&DataKey::AllPlayers).unwrap_or(Vec::new(env));
    let mut eliminated = Vec::new(env);
    for p in all_players.iter() {
        if env.storage().persistent().has(&DataKey::Eliminated(p.clone())) {
            eliminated.push_back(p);
        }
    }
    eliminated
}

#[cfg(test)]
mod abi_guard;
// #[cfg(test)]
// mod auto_advance_tests;
// #[cfg(all(test, feature = "integration-tests"))]
// mod integration_tests;
// #[cfg(test)]
// mod metadata_tests;
// #[cfg(test)]
// mod state_machine_tests;
// #[cfg(test)]
// mod submit_choice_tests;
#[cfg(test)]
mod commit_reveal_tests;
#[cfg(test)]
mod expire_arena_tests;
#[cfg(test)]
mod mutation_tests;
#[cfg(test)]
mod state_machine_tests;
#[cfg(test)]
mod test;
