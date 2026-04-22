#![no_std]

mod bounds;
mod invariants;

use soroban_sdk::{
    Address, BytesN, Env, String, Symbol, Vec, contract, contracterror, contractimpl, contracttype,
    symbol_short, token,
};

// ── Storage keys ──────────────────────────────────────────────────────────────

const ADMIN_KEY: Symbol = symbol_short!("ADMIN");
const PAUSED_KEY: Symbol = symbol_short!("PAUSED");
const PENDING_HASH_KEY: Symbol = symbol_short!("P_HASH");
const EXECUTE_AFTER_KEY: Symbol = symbol_short!("P_AFTER");
const SURVIVOR_COUNT_KEY: Symbol = symbol_short!("S_COUNT");
const CAPACITY_KEY: Symbol = symbol_short!("CAPACITY");
const TOKEN_KEY: Symbol = symbol_short!("TOKEN");
const PRIZE_POOL_KEY: Symbol = symbol_short!("PRIZE_P");
const GAME_STATUS_KEY: Symbol = symbol_short!("G_STATUS");
const GAME_FINISHED_KEY: Symbol = symbol_short!("G_FIN");
const WINNER_SET_KEY: Symbol = symbol_short!("W_SET");
const CANCELLED_KEY: Symbol = symbol_short!("CNCL");
const STATE_KEY: Symbol = symbol_short!("STATE");

// ── Timelock: 48 hours in seconds ─────────────────────────────────────────────
const TIMELOCK_PERIOD: u64 = 48 * 60 * 60;

// ── TTL constants ─────────────────────────────────────────────────────────────
const GAME_TTL_THRESHOLD: u32 = 100_000;
const GAME_TTL_EXTEND_TO: u32 = 535_680;

// ── Event topics ──────────────────────────────────────────────────────────────
const TOPIC_UPGRADE_PROPOSED: Symbol = symbol_short!("UP_PROP");
const TOPIC_UPGRADE_EXECUTED: Symbol = symbol_short!("UP_EXEC");
const TOPIC_UPGRADE_CANCELLED: Symbol = symbol_short!("UP_CANC");
const TOPIC_PAUSED: Symbol = symbol_short!("PAUSED");
const TOPIC_UNPAUSED: Symbol = symbol_short!("UNPAUSED");
const TOPIC_ROUND_STARTED: Symbol = symbol_short!("R_START");
const TOPIC_ROUND_TIMEOUT: Symbol = symbol_short!("R_TOUT");
const TOPIC_ROUND_RESOLVED: Symbol = symbol_short!("RSLVD");
const TOPIC_CHOICE_SUBMITTED: Symbol = symbol_short!("CH_SUB");
const TOPIC_WINNER_SET: Symbol = symbol_short!("WIN_SET");
const TOPIC_CLAIM: Symbol = symbol_short!("CLAIM");
const TOPIC_LEAVE: Symbol = symbol_short!("LEAVE");
const TOPIC_CANCELLED: Symbol = symbol_short!("CANCELLED");
const TOPIC_MAX_ROUNDS: Symbol = symbol_short!("MX_ROUND");
const TOPIC_STATE_CHANGED: Symbol = symbol_short!("ST_CHG");

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
}

// ── Types ─────────────────────────────────────────────────────────────────────

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum Choice {
    Heads,
    Tails,
}

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ArenaConfig {
    pub round_speed_in_ledgers: u32,
    pub required_stake_amount: i128,
    pub max_rounds: u32,
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
pub struct ArenaStateView {
    pub survivors_count: u32,
    pub max_capacity: u32,
    pub round_number: u32,
    pub current_stake: i128,
    pub potential_payout: i128,
}

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

impl ArenaState {
    pub fn is_terminal_state(&self) -> bool {
        matches!(self, ArenaState::Completed | ArenaState::Cancelled)
    }
}

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ArenaStateChanged {
    pub old_state: ArenaState,
    pub new_state: ArenaState,
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

/// Human-readable metadata attached to an arena instance.
#[contracttype]
#[derive(Clone, Debug)]
pub struct ArenaMetadata {
    /// Application-level arena identifier (assigned by the factory or the host).
    pub arena_id: u64,
    /// Display name — max 64 bytes UTF-8.
    pub name: String,
    /// Optional description — max 256 bytes UTF-8.
    pub description: Option<String>,
    /// Address that created / hosts the arena.
    pub host: Address,
    /// Ledger timestamp at the moment metadata was stored.
    pub created_at: u64,
}

#[contracttype]
#[derive(Clone)]
enum DataKey {
    Config,
    Round,
    Submission(u32, Address),
    HeadsSubmitters(u32),
    TailsSubmitters(u32),
    Survivor(Address),
    Eliminated(Address),
    PrizeClaimed(Address),
    Winner(Address),
    AllPlayers,
    Refunded(Address),
    State,
    Metadata(u64),
}


// ── Contract ──────────────────────────────────────────────────────────────────

#[contract]
pub struct ArenaContract;

#[contractimpl]
impl ArenaContract {
    pub fn create_arena(
        env: Env,
        arena_id: u64,
        host: Address,
        admin: Address,
        token: Address,
        capacity: u32,
        round_speed_in_ledgers: u32,
        required_stake_amount: i128,
        start_deadline: u64,
    ) -> Result<(), ArenaError> {
        if storage(&env).has(&DataKey::Config(arena_id)) {
            return Err(ArenaError::AlreadyInitialized);
        }
        if round_speed_in_ledgers == 0 || round_speed_in_ledgers > bounds::MAX_SPEED_LEDGERS {
            return Err(ArenaError::InvalidRoundSpeed);
        }
        if required_stake_amount < bounds::MIN_REQUIRED_STAKE {
            return Err(ArenaError::InvalidAmount);
        }
        env.storage()
            .instance()
            .extend_ttl(GAME_TTL_THRESHOLD, GAME_TTL_EXTEND_TO);
        storage(&env).set(
            &DataKey::Config,
            &ArenaConfig {
                round_speed_in_ledgers,
                required_stake_amount,
                max_rounds: bounds::DEFAULT_MAX_ROUNDS,
            },
        );
        bump(&env, &DataKey::Config);
        storage(&env).set(
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
        bump(&env, &DataKey::Round);
        set_state(&env, ArenaState::Pending);
        Ok(())
    }

    pub fn initialize(env: Env, admin: Address) {
        if env.storage().instance().has(&ADMIN_KEY) {
            panic!("already initialized");
        }

        let config = ArenaConfig {
            round_speed_in_ledgers,
            required_stake_amount,
        };
        let round = RoundState {
            round_number: 0,
            round_start_ledger: 0,
            round_deadline_ledger: 0,
            active: false,
            total_submissions: 0,
            timed_out: false,
            finished: false,
        };
        let state = ArenaState {
            admin,
            token,
            capacity,
            prize_pool: 0,
            game_finished: false,
            winner_set: false,
            paused: false,
            round,
        };

        set_config(&env, arena_id, &config);
        set_state(&env, arena_id, &state);
        set_players(&env, arena_id, &Vec::new(&env));
        set_survivors(&env, arena_id, &Vec::new(&env));
        set_eliminated(&env, arena_id, &Vec::new(&env));

        Ok(())
    }

    pub fn initialize(env: Env, admin: Address) {
        if storage(&env).has(&DataKey::ContractAdmin) {
            panic!("already initialized");
        }
        admin.require_auth();
        storage(&env).set(&DataKey::ContractAdmin, &admin);
        bump(&env, &DataKey::ContractAdmin);
    }

    pub fn admin(env: Env) -> Address {
        storage(&env)
            .get(&DataKey::ContractAdmin)
            .expect("not initialized")
    }

    pub fn set_admin(env: Env, new_admin: Address) {
        let admin: Address = Self::admin(env.clone());
        admin.require_auth();
        storage(&env).set(&DataKey::ContractAdmin, &new_admin);
        bump(&env, &DataKey::ContractAdmin);
    }

    pub fn pause_arena(env: Env, arena_id: u64) -> Result<(), ArenaError> {
        let mut state = get_state(&env, arena_id)?;
        state.admin.require_auth();
        state.paused = true;
        set_state(&env, arena_id, &state);
        env.events().publish((TOPIC_PAUSED, arena_id), (EVENT_VERSION,));
        Ok(())
    }

    pub fn unpause_arena(env: Env, arena_id: u64) -> Result<(), ArenaError> {
        let mut state = get_state(&env, arena_id)?;
        state.admin.require_auth();
        state.paused = false;
        set_state(&env, arena_id, &state);
        env.events().publish((TOPIC_UNPAUSED, arena_id), (EVENT_VERSION,));
        Ok(())
    }

    pub fn is_arena_paused(env: Env, arena_id: u64) -> bool {
        get_state(&env, arena_id).map(|s| s.paused).unwrap_or(false)
    }

    pub fn set_arena_token(env: Env, arena_id: u64, token: Address) -> Result<(), ArenaError> {
        let mut state = get_state(&env, arena_id)?;
        state.admin.require_auth();
        
        let survivors = get_survivors(&env, arena_id);
        if survivors.len() > 0 || state.prize_pool > 0 {
            return Err(ArenaError::TokenConfigurationLocked);
        }
        state.token = token;
        set_state(&env, arena_id, &state);
        Ok(())
    }

    pub fn set_arena_capacity(env: Env, arena_id: u64, capacity: u32) -> Result<(), ArenaError> {
        let mut state = get_state(&env, arena_id)?;
        state.admin.require_auth();

        if !(bounds::MIN_ARENA_PARTICIPANTS..=bounds::MAX_ARENA_PARTICIPANTS).contains(&capacity) {
            return Err(ArenaError::InvalidCapacity);
        }
        state.capacity = capacity;
        set_state(&env, arena_id, &state);
        Ok(())
    }

    pub fn set_winner(
        env: Env,
        arena_id: u64,
        player: Address,
        stake: i128,
        yield_comp: i128,
    ) -> Result<(), ArenaError> {
        require_not_paused(&env)?;
        let current_state = get_state(&env);
        assert_state!(current_state, ArenaState::Active);
        let admin = Self::admin(env.clone());
        admin.require_auth();
        if !storage(&env).has(&DataKey::Survivor(player.clone())) {
            return Err(ArenaError::NotASurvivor);
        }

        if state.winner_set {
            return Err(ArenaError::WinnerAlreadySet);
        }
        if stake < 0 || yield_comp < 0 {
            return Err(ArenaError::InvalidAmount);
        }
        let prize = stake
            .checked_add(yield_comp)
            .ok_or(ArenaError::InvalidAmount)?;

        state.winner_set = true;
        state.prize_pool = state
            .prize_pool
            .checked_add(prize)
            .ok_or(ArenaError::InvalidAmount)?;
        
        set_state(&env, arena_id, &state);

        env.events()
            .publish((TOPIC_WINNER_SET, arena_id), (player, stake, yield_comp, EVENT_VERSION));
        Ok(())
    }

    pub fn join_arena(env: Env, arena_id: u64, player: Address, amount: i128) -> Result<(), ArenaError> {
        player.require_auth();
        require_not_paused(&env)?;
        let current_state = get_state(&env);
        assert_state!(current_state, ArenaState::Pending);
        // Ensure the arena has been configured before accepting deposits
        let config = get_config(&env)?;
        if env
            .storage()
            .instance()
            .get::<_, bool>(&GAME_FINISHED_KEY)
            .unwrap_or(false)
        {
            return Err(ArenaError::GameAlreadyFinished);
        }
        if state.game_finished {
            return Err(ArenaError::GameAlreadyFinished);
        }
        let config = get_config(&env, arena_id)?;
        if amount != config.required_stake_amount {
            return Err(ArenaError::InvalidAmount);
        }

        let mut survivors = get_survivors(&env, arena_id);
        if survivors.contains(&player) {
            return Err(ArenaError::AlreadyJoined);
        }

        if survivors.len() >= state.capacity {
            return Err(ArenaError::ArenaFull);
        }

        // CEI: effects before interaction
        storage(&env).set(&survivor_key, &());
        bump(&env, &survivor_key);
        env.storage()
            .instance()
            .set(&SURVIVOR_COUNT_KEY, &(count + 1));
            
        let mut players: Vec<Address> = env.storage().instance().get(&PLAYERS_KEY).unwrap_or(Vec::new(&env));
        players.push_back(player.clone());
        env.storage().instance().set(&PLAYERS_KEY, &players);

        let pool: i128 = env
            .storage()
            .instance()
            .get(&PRIZE_POOL_KEY)
            .unwrap_or(0i128);
        env.storage()
            .instance()
            .set(&PRIZE_POOL_KEY, &(pool + amount));
        // Track all players who have ever joined for cancel_arena refund iteration.
        let mut all_players: Vec<Address> = storage(&env)
            .get(&DataKey::AllPlayers)
            .unwrap_or(Vec::new(&env));
        all_players.push_back(player.clone());
        storage(&env).set(&DataKey::AllPlayers, &all_players);
        bump(&env, &DataKey::AllPlayers);
        token::Client::new(&env, &token).transfer(
            &player,
            &env.current_contract_address(),
            &amount,
        );
        Ok(())
    }

    /// Cancel the arena and refund all surviving players their entry fee.
    ///
    /// The admin (which serves as the arena host) may cancel at any time
    /// before game completion.  Players who have already been refunded (via a
    /// previous partial cancel call) are skipped so the function is safe to
    /// re-invoke after a simulated mid-execution failure.
    ///
    /// # Errors
    /// * [`ArenaError::AlreadyCancelled`] — arena was already fully cancelled.
    /// * [`ArenaError::GameAlreadyFinished`] — game completed normally; cannot cancel.
    /// * [`ArenaError::NotInitialized`] — contract has not been initialized.
    ///
    /// # Authorization
    /// Requires auth from the admin address.
    pub fn cancel_arena(env: Env) -> Result<(), ArenaError> {
        require_not_paused(&env)?;
        let admin: Address = env
            .storage()
            .instance()
            .get(&ADMIN_KEY)
            .ok_or(ArenaError::NotInitialized)?;
        admin.require_auth();

        if env
            .storage()
            .instance()
            .get::<_, bool>(&CANCELLED_KEY)
            .unwrap_or(false)
        {
            return Err(ArenaError::AlreadyCancelled);
        }
        if env
            .storage()
            .instance()
            .get::<_, bool>(&GAME_FINISHED_KEY)
            .unwrap_or(false)
        {
            return Err(ArenaError::GameAlreadyFinished);
        }

        let all_players: Vec<Address> = storage(&env)
            .get(&DataKey::AllPlayers)
            .unwrap_or(Vec::new(&env));

        if !all_players.is_empty() {
            let config = get_config(&env)?;
            let token: Address = env
                .storage()
                .instance()
                .get(&TOKEN_KEY)
                .ok_or(ArenaError::TokenNotSet)?;
            let refund_amount = config.required_stake_amount;
            let token_client = token::Client::new(&env, &token);

            for player in all_players.iter() {
                // Only refund players who are still survivors and have not yet
                // been refunded (idempotency guard).
                if storage(&env).has(&DataKey::Survivor(player.clone()))
                    && !storage(&env).has(&DataKey::Refunded(player.clone()))
                {
                    // CEI: record the refund flag before transferring tokens.
                    storage(&env).set(&DataKey::Refunded(player.clone()), &());
                    bump(&env, &DataKey::Refunded(player.clone()));
                    token_client.transfer(
                        &env.current_contract_address(),
                        &player,
                        &refund_amount,
                    );
                }
            }

            env.storage().instance().set(&PRIZE_POOL_KEY, &0i128);
        }

        env.storage().instance().set(&CANCELLED_KEY, &true);
        env.storage().instance().set(&GAME_FINISHED_KEY, &true);

        env.events()
            .publish((TOPIC_CANCELLED,), (EVENT_VERSION,));

        Ok(())
    }

    /// Set the maximum number of rounds before a forced-draw resolution.
    ///
    /// Must be in range [`bounds::MIN_MAX_ROUNDS`, `bounds::MAX_MAX_ROUNDS`].
    ///
    /// # Authorization
    /// Requires admin signature.
    pub fn set_max_rounds(env: Env, max_rounds: u32) -> Result<(), ArenaError> {
        let admin: Address = env
            .storage()
            .instance()
            .get(&ADMIN_KEY)
            .ok_or(ArenaError::NotInitialized)?;
        admin.require_auth();

        if max_rounds < bounds::MIN_MAX_ROUNDS || max_rounds > bounds::MAX_MAX_ROUNDS {
            return Err(ArenaError::InvalidMaxRounds);
        }

        let mut config = get_config(&env)?;
        config.max_rounds = max_rounds;
        storage(&env).set(&DataKey::Config, &config);
        bump(&env, &DataKey::Config);
        Ok(())
    }

    /// Return whether the arena has been cancelled.
    pub fn is_cancelled(env: Env) -> bool {
        env.storage()
            .instance()
            .get::<_, bool>(&CANCELLED_KEY)
            .unwrap_or(false)
    }

    pub fn leave(env: Env, player: Address) -> Result<i128, ArenaError> {
        player.require_auth();
        require_not_paused(&env)?;
        let current_state = get_state(&env);
        assert_state!(current_state, ArenaState::Pending);
        // Only allowed before round 1 starts
        let round = get_round(&env)?;
        if round.round_number != 0 {
            return Err(ArenaError::RoundAlreadyActive);
        }
        if state.round.round_number != 0 {
            return Err(ArenaError::RoundAlreadyActive);
        }

        let mut survivors = get_survivors(&env, arena_id);
        let index = survivors.first_index_of(&player).ok_or(ArenaError::NotASurvivor)?;
        survivors.remove(index);
        set_survivors(&env, arena_id, &survivors);

        let config = get_config(&env, arena_id)?;
        let refund = config.required_stake_amount;
        let token: Address = env
            .storage()
            .instance()
            .get(&TOKEN_KEY)
            .ok_or(ArenaError::TokenNotSet)?;
        // CEI: effects before interaction
        storage(&env).remove(&survivor_key);
        let count: u32 = env
            .storage()
            .instance()
            .get(&SURVIVOR_COUNT_KEY)
            .unwrap_or(0u32);
        env.storage()
            .instance()
            .set(&SURVIVOR_COUNT_KEY, &count.saturating_sub(1));
            
        let mut players: Vec<Address> = env.storage().instance().get(&PLAYERS_KEY).unwrap_or(Vec::new(&env));
        if let Some(i) = players.first_index_of(player.clone()) {
            players.remove(i);
        }
        env.storage().instance().set(&PLAYERS_KEY, &players);

        let pool: i128 = env
            .storage()
            .instance()
            .get(&PRIZE_POOL_KEY)
            .unwrap_or(0i128);
        env.storage()
            .instance()
            .set(&PRIZE_POOL_KEY, &(pool - refund));
        token::Client::new(&env, &token).transfer(&env.current_contract_address(), &player, &refund);
        env.events().publish((TOPIC_LEAVE,), (player, refund));

        state.prize_pool = state
            .prize_pool
            .checked_sub(refund)
            .ok_or(ArenaError::InvalidAmount)?;
        set_state(&env, arena_id, &state);

        token::Client::new(&env, &state.token).transfer(&env.current_contract_address(), &player, &refund);
        env.events().publish((TOPIC_LEAVE, arena_id), (player, refund));
        Ok(refund)
    }

    pub fn start_round(env: Env) -> Result<RoundState, ArenaError> {
        require_not_paused(&env)?;
        let current_state = get_state(&env);
        assert_state!(current_state, ArenaState::Pending | ArenaState::Active);
        if env
            .storage()
            .instance()
            .get::<_, bool>(&GAME_FINISHED_KEY)
            .unwrap_or(false)
        {
            return Err(ArenaError::GameAlreadyFinished);
        }
        if state.round.active {
            return Err(ArenaError::RoundAlreadyActive);
        }

        let survivors = get_survivors(&env, arena_id);
        if survivors.len() < bounds::MIN_ARENA_PARTICIPANTS {
            return Err(ArenaError::NotEnoughPlayers);
        }

        let config = get_config(&env, arena_id)?;
        let round_start_ledger = env.ledger().sequence();
        let round_deadline_ledger = round_start_ledger
            .checked_add(config.round_speed_in_ledgers)
            .ok_or(ArenaError::RoundDeadlineOverflow)?;

        let previous_round_number = state.round.round_number;
        state.round = RoundState {
            round_number: previous_round_number + 1,
            round_start_ledger,
            round_deadline_ledger,
            active: true,
            total_submissions: 0,
            timed_out: false,
            finished: false,
        };

        #[cfg(debug_assertions)]
        {
            crate::invariants::check_round_flags(&state.round)
                .expect("start_round: round flags invariant violated");
            crate::invariants::check_round_number_monotonic(
                previous_round_number,
                state.round.round_number,
            )
            .expect("start_round: round number monotonic invariant violated");
        }

        storage(&env).set(&DataKey::Round, &next_round);
        bump(&env, &DataKey::Round);

        if next_round.round_number == 1 {
            set_state(&env, ArenaState::Active);
        }

        env.events().publish(
            (TOPIC_ROUND_STARTED, arena_id),
            (
                state.round.round_number,
                state.round.round_start_ledger,
                state.round.round_deadline_ledger,
                EVENT_VERSION,
            ),
        );
        Ok(state.round)
    }

    pub fn submit_choice(
        env: Env,
        arena_id: u64,
        player: Address,
        round_number: u32,
        choice: Choice,
    ) -> Result<(), ArenaError> {
        require_not_paused(&env)?;
        let current_state = get_state(&env);
        assert_state!(current_state, ArenaState::Active);
        env.storage()
            .instance()
            .extend_ttl(GAME_TTL_THRESHOLD, GAME_TTL_EXTEND_TO);
        player.require_auth();

        let eliminated = get_eliminated(&env, arena_id);
        if eliminated.contains(&player) {
            return Err(ArenaError::PlayerEliminated);
        }
        let survivors = get_survivors(&env, arena_id);
        if !survivors.contains(&player) {
            return Err(ArenaError::NotASurvivor);
        }

        #[cfg(debug_assertions)]
        let before_submissions = state.round.total_submissions;

        if !state.round.active {
            return Err(ArenaError::NoActiveRound);
        }
        if round_number != state.round.round_number {
            return Err(ArenaError::WrongRoundNumber);
        }
        if env.ledger().sequence() > state.round.round_deadline_ledger {
            return Err(ArenaError::SubmissionWindowClosed);
        }

        let mut choices = get_round_choices(&env, arena_id, state.round.round_number);
        if choices.contains_key(player.clone()) {
            return Err(ArenaError::SubmissionAlreadyExists);
        }
        if state.round.total_submissions >= bounds::MAX_SUBMISSIONS_PER_ROUND {
            return Err(ArenaError::MaxSubmissionsPerRound);
        }

        choices.set(player.clone(), choice);
        set_round_choices(&env, arena_id, state.round.round_number, &choices);

        state.round.total_submissions += 1;

        let sub_count: u32 = env.storage().instance().get(&SUBMITTED_COUNT_KEY).unwrap_or(0);
        env.storage().instance().set(&SUBMITTED_COUNT_KEY, &(sub_count + 1));

        #[cfg(debug_assertions)]
        {
            crate::invariants::check_submission_count_monotonic(
                before_submissions,
                state.round.total_submissions,
            )
            .expect("submit_choice: submission count monotonic invariant violated");
            crate::invariants::check_round_flags(&state.round)
                .expect("submit_choice: round flags invariant violated");
        }

        storage(&env).set(&DataKey::Round, &round);
        bump(&env, &DataKey::Round);

        // Emit without the choice value to preserve submission privacy.
        env.events().publish(
            (TOPIC_CHOICE_SUBMITTED,),
            (player, round.round_number, EVENT_VERSION),
        );
        // Auto-advance: when every active survivor has submitted, resolve immediately.
        let survivor_count: u32 = env
            .storage()
            .instance()
            .get(&SURVIVOR_COUNT_KEY)
            .unwrap_or(0u32);
        if survivor_count > 0 && round.total_submissions == survivor_count {
            round.active = false;
            storage(&env).set(&DataKey::Round, &round);
            bump(&env, &DataKey::Round);
            resolve_round_internal(&env)?;
        }

        Ok(())
    }

    pub fn timeout_round(env: Env) -> Result<RoundState, ArenaError> {
        require_not_paused(&env)?;
        let current_state = get_state(&env);
        assert_state!(current_state, ArenaState::Active);
        env.storage()
            .instance()
            .extend_ttl(GAME_TTL_THRESHOLD, GAME_TTL_EXTEND_TO);
        let mut round = get_round(&env)?;
        #[cfg(debug_assertions)]
        let before = state.round.clone();

        if !state.round.active {
            return Err(ArenaError::NoActiveRound);
        }
        if env.ledger().sequence() <= state.round.round_deadline_ledger {
            return Err(ArenaError::RoundStillOpen);
        }
        state.round.active = false;
        state.round.timed_out = true;

        #[cfg(debug_assertions)]
        {
            crate::invariants::check_timeout_transition(&before, &state.round)
                .expect("timeout_round: timeout transition invariant violated");
            crate::invariants::check_round_flags(&state.round)
                .expect("timeout_round: round flags invariant violated");
            crate::invariants::check_round_number_monotonic(before.round_number, state.round.round_number)
                .expect("timeout_round: round number monotonic invariant violated");
        }

        set_state(&env, arena_id, &state);
        env.events().publish(
            (TOPIC_ROUND_TIMEOUT, arena_id),
            (state.round.round_number, state.round.total_submissions, EVENT_VERSION),
        );
        Ok(round)
    }

    pub fn resolve_round(env: Env) -> Result<RoundState, ArenaError> {
        require_not_paused(&env)?;
        let current_state = get_state(&env);
        assert_state!(current_state, ArenaState::Active);
        env.storage()
            .instance()
            .extend_ttl(GAME_TTL_THRESHOLD, GAME_TTL_EXTEND_TO);
        if env
            .storage()
            .instance()
            .get::<_, bool>(&GAME_FINISHED_KEY)
            .unwrap_or(false)
        {
            return Err(ArenaError::GameAlreadyFinished);
        }
        let mut round = get_round(&env)?;

        if state.round.finished {
            return Err(ArenaError::NoActiveRound);
        }
        if state.round.active {
            if env.ledger().sequence() <= state.round.round_deadline_ledger {
                return Err(ArenaError::RoundStillOpen);
            }
            round.active = false;
            round.timed_out = true;
            storage(&env).set(&DataKey::Round, &round);
            bump(&env, &DataKey::Round);
        }

        resolve_round_internal(&env)
    }

    pub fn claim(env: Env, winner: Address) -> Result<i128, ArenaError> {
        require_not_paused(&env)?;
        let current_state = get_state(&env);
        assert_state!(current_state, ArenaState::Completed);
        winner.require_auth();
        if !state.game_finished {
            return Err(ArenaError::GameNotFinished);
        }

        let survivors = get_survivors(&env, arena_id);
        if state.winner_set {
            // If winner is set by admin, verify.
            // Note: In this refactored version, we don't store individual winner flags,
            // we assume the admin sets the prize pool and we might need a way to verify the winner.
            // For now, let's assume the winner must be one of the survivors if only 1 remains.
        }

        if survivors.len() == 1 && survivors.contains(&winner) {
            // Fallback: exactly one survivor remains
        } else if survivors.len() > 1 {
             return Err(ArenaError::WinnerNotSet);
        } else if !survivors.contains(&winner) {
             return Err(ArenaError::NotASurvivor);
        }

        let prize = state.prize_pool;
        if prize <= 0 {
            return Err(ArenaError::NoPrizeToClaim);
        }

        // CEI: effects before interaction
        state.prize_pool = 0;
        state.game_finished = true;
        state.round.finished = true;
        set_state(&env, arena_id, &state);

        token::Client::new(&env, &state.token).transfer(&env.current_contract_address(), &winner, &prize);
        
        env.events()
            .publish((TOPIC_CLAIM, arena_id), (winner, prize, EVENT_VERSION));
        Ok(prize)
    }

    pub fn cancel_arena(env: Env, arena_id: u64) -> Result<(), ArenaError> {
        let mut state = get_state(&env, arena_id)?;
        state.admin.require_auth();
        
        if state.round.round_number > 0 {
            return Err(ArenaError::RoundAlreadyActive);
        }

        let survivors = get_survivors(&env, arena_id);
        let config = get_config(&env, arena_id)?;
        let refund_amount = config.required_stake_amount;

        for player in survivors.iter() {
            token::Client::new(&env, &state.token).transfer(
                &env.current_contract_address(),
                &player,
                &refund_amount,
            );
        }

        state.game_finished = true;
        state.prize_pool = 0;
        set_state(&env, arena_id, &state);

        Ok(())
    }

    pub fn get_config(env: Env, arena_id: u64) -> Result<ArenaConfig, ArenaError> {
        get_config(&env, arena_id)
    }

    pub fn get_round(env: Env, arena_id: u64) -> Result<RoundState, ArenaError> {
        get_state(&env, arena_id).map(|s| s.round)
    }

    pub fn get_choice(env: Env, arena_id: u64, round_number: u32, player: Address) -> Option<Choice> {
        get_round_choices(&env, arena_id, round_number).get(player)
    }

    pub fn get_arena_state(env: Env, arena_id: u64) -> Result<ArenaStateView, ArenaError> {
        let state = get_state(&env, arena_id)?;
        Ok(ArenaStateView {
            survivors_count: get_survivors(&env, arena_id).len(),
            max_capacity: state.capacity,
            round_number: state.round.round_number,
            current_stake: state.prize_pool,
            potential_payout: state.prize_pool,
        })
    }

    pub fn get_user_state(env: Env, arena_id: u64, player: Address) -> UserStateView {
        let survivors = get_survivors(&env, arena_id);
        let is_active = survivors.contains(&player);
        // Simplified has_won: if game finished and player is the last survivor
        let state = get_state(&env, arena_id).ok();
        let has_won = state.map(|s| s.game_finished && is_active && survivors.len() == 1).unwrap_or(false);
        UserStateView { is_active, has_won }
    }

    pub fn get_full_state(env: Env, arena_id: u64, player: Address) -> Result<FullStateView, ArenaError> {
        let arena_state = Self::get_arena_state(env.clone(), arena_id)?;
        let user_state = Self::get_user_state(env, arena_id, player);
        Ok(FullStateView {
            survivors_count: arena_state.survivors_count,
            max_capacity: arena_state.max_capacity,
            round_number: arena_state.round_number,
            current_stake: arena_state.current_stake,
            potential_payout: arena_state.potential_payout,
            is_active: user_state.is_active,
            has_won: user_state.has_won,
        })
    }

    /// Store human-readable metadata for this arena instance.
    ///
    /// # Errors
    /// * `NameEmpty`           — `name` has zero bytes.
    /// * `NameTooLong`         — `name` exceeds 64 bytes.
    /// * `DescriptionTooLong`  — `description` exceeds 256 bytes.
    ///
    /// # Authorization
    /// Requires admin signature.
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
            panic_with_error!(&env, ArenaError::NameEmpty);
        }
        if name.len() > 64 {
            panic_with_error!(&env, ArenaError::NameTooLong);
        }
        if let Some(ref desc) = description {
            if desc.len() > 256 {
                panic_with_error!(&env, ArenaError::DescriptionTooLong);
            }
        }

        let metadata = ArenaMetadata {
            arena_id,
            name,
            description,
            host,
            created_at: env.ledger().timestamp(),
        };

        storage(&env).set(&DataKey::Metadata(arena_id), &metadata);
        bump(&env, &DataKey::Metadata(arena_id));
        Ok(())
    }

    /// Return the stored metadata for the given `arena_id`, or `None` if not set.
    ///
    /// No authorization required — metadata is public.
    pub fn get_metadata(env: Env, arena_id: u64) -> Option<ArenaMetadata> {
        storage(&env).get(&DataKey::Metadata(arena_id))
    }

    pub fn propose_upgrade(env: Env, new_wasm_hash: BytesN<32>) -> Result<(), ArenaError> {
        let admin: Address = storage(&env)
            .get(&DataKey::ContractAdmin)
            .ok_or(ArenaError::NotInitialized)?;
        admin.require_auth();
        if storage(&env).has(&DataKey::UpgradeHash) {
            return Err(ArenaError::UpgradeAlreadyPending);
        }
        let execute_after: u64 = env.ledger().timestamp() + TIMELOCK_PERIOD;
        storage(&env).set(&DataKey::UpgradeHash, &new_wasm_hash);
        storage(&env).set(&DataKey::UpgradeTimestamp, &execute_after);
        bump(&env, &DataKey::UpgradeHash);
        bump(&env, &DataKey::UpgradeTimestamp);
        env.events().publish(
            (TOPIC_UPGRADE_PROPOSED,),
            (EVENT_VERSION, new_wasm_hash, execute_after),
        );
        Ok(())
    }

    pub fn execute_upgrade(env: Env) -> Result<(), ArenaError> {
        let admin: Address = storage(&env)
            .get(&DataKey::ContractAdmin)
            .ok_or(ArenaError::NotInitialized)?;
        admin.require_auth();
        let execute_after: u64 = storage(&env)
            .get(&DataKey::UpgradeTimestamp)
            .ok_or(ArenaError::NoPendingUpgrade)?;
        if env.ledger().timestamp() < execute_after {
            return Err(ArenaError::TimelockNotExpired);
        }
        let new_wasm_hash: BytesN<32> = storage(&env)
            .get(&DataKey::UpgradeHash)
            .ok_or(ArenaError::NoPendingUpgrade)?;
        storage(&env).remove(&DataKey::UpgradeHash);
        storage(&env).remove(&DataKey::UpgradeTimestamp);
        env.events().publish(
            (TOPIC_UPGRADE_EXECUTED,),
            (EVENT_VERSION, new_wasm_hash.clone()),
        );
        env.deployer().update_current_contract_wasm(new_wasm_hash);
        Ok(())
    }

    pub fn cancel_upgrade(env: Env) -> Result<(), ArenaError> {
        let admin: Address = storage(&env)
            .get(&DataKey::ContractAdmin)
            .ok_or(ArenaError::NotInitialized)?;
        admin.require_auth();
        if !storage(&env).has(&DataKey::UpgradeHash) {
            return Err(ArenaError::NoPendingUpgrade);
        }
        storage(&env).remove(&DataKey::UpgradeHash);
        storage(&env).remove(&DataKey::UpgradeTimestamp);
        env.events()
            .publish((TOPIC_UPGRADE_CANCELLED,), (EVENT_VERSION,));
        Ok(())
    }

    pub fn pending_upgrade(env: Env) -> Option<(BytesN<32>, u64)> {
        let hash: Option<BytesN<32>> = storage(&env).get(&DataKey::UpgradeHash);
        let after: Option<u64> = storage(&env).get(&DataKey::UpgradeTimestamp);
        match (hash, after) {
            (Some(h), Some(a)) => Some((h, a)),
            _ => None,
        }
    }

    pub fn cancel_arena(env: Env) -> Result<(), ArenaError> {
        let admin: Address = env
            .storage()
            .instance()
            .get(&ADMIN_KEY)
            .ok_or(ArenaError::NotInitialized)?;
        admin.require_auth();

        let current_state = get_state(&env);
        assert_state!(current_state, ArenaState::Pending | ArenaState::Active);

        set_state(&env, ArenaState::Cancelled);
        Ok(())
    }

    pub fn state(env: Env) -> ArenaState {
        get_state(&env)
    }
}

// ── Helpers ───────────────────────────────────────────────────────────────────

/// Core resolution logic shared by `resolve_round()` (deadline path) and the
/// auto-advance path in `submit_choice()` (all-submitted path).
///
/// Expects the round to already have `active = false` in storage before being
/// called.  Always sets `round.finished = true` on return so a second call is
/// safely rejected by the `round.finished` guard in `resolve_round()`.
fn resolve_round_internal(env: &Env) -> Result<RoundState, ArenaError> {
    let mut round = get_round(env)?;
    let config = get_config(env)?;

    // Max-rounds forced-draw: surviving players split the prize pool equally.
    if round.round_number > 0 && round.round_number >= config.max_rounds {
        let survivors = collect_survivors(env);
        let survivor_count = survivors.len() as i128;
        let prize_pool: i128 = env
            .storage()
            .instance()
            .get(&PRIZE_POOL_KEY)
            .unwrap_or(0i128);

        if survivor_count > 0 && prize_pool > 0 {
            let token: Address = env
                .storage()
                .instance()
                .get(&TOKEN_KEY)
                .ok_or(ArenaError::TokenNotSet)?;
            let share = prize_pool / survivor_count;
            let dust = prize_pool % survivor_count;
            let token_client = token::Client::new(env, &token);

            for survivor in survivors.iter() {
                token_client.transfer(&env.current_contract_address(), &survivor, &share);
            }
            // Any indivisible dust goes to the first survivor.
            if dust > 0 {
                let first = survivors.get(0).expect("survivor list non-empty");
                token_client.transfer(&env.current_contract_address(), &first, &dust);
            }
            env.storage().instance().set(&PRIZE_POOL_KEY, &0i128);
        }

        env.storage().instance().set(&GAME_FINISHED_KEY, &true);
        round.finished = true;
        storage(env).set(&DataKey::Round, &round);
        bump(env, &DataKey::Round);

        env.events().publish(
            (TOPIC_MAX_ROUNDS,),
            (round.round_number, survivors.len(), EVENT_VERSION),
        );
        return Ok(round);
    }

    #[cfg(debug_assertions)]
    let before_round_number = round.round_number;

    let heads_key = DataKey::HeadsSubmitters(round.round_number);
    let tails_key = DataKey::TailsSubmitters(round.round_number);
    let heads_submitters = get_submitters(env, &heads_key);
    let tails_submitters = get_submitters(env, &tails_key);
    let heads_count = heads_submitters.len();
    let tails_count = tails_submitters.len();

    let surviving_choice = choose_surviving_side(env, heads_count, tails_count);
    let eliminated_players = match surviving_choice {
        Some(Choice::Heads) => tails_submitters,
        Some(Choice::Tails) => heads_submitters,
        None => Vec::new(env),
    };

    let mut eliminated_count = 0u32;
    for player in eliminated_players.iter() {
        let survivor_key = DataKey::Survivor(player.clone());
        if storage(env).has(&survivor_key) {
            storage(env).remove(&survivor_key);
            let eliminated_key = DataKey::Eliminated(player.clone());
            storage(env).set(&eliminated_key, &true);
            bump(env, &eliminated_key);
            eliminated_count += 1;
        }
    }

    let survivor_count: u32 = env
        .storage()
        .instance()
        .get(&SURVIVOR_COUNT_KEY)
        .unwrap_or(0u32);
    let updated_survivor_count = survivor_count
        .checked_sub(eliminated_count)
        .ok_or(ArenaError::InvalidAmount)?;
    env.storage()
        .instance()
        .set(&SURVIVOR_COUNT_KEY, &updated_survivor_count);
    if updated_survivor_count <= 1 {
        env.storage().instance().set(&GAME_FINISHED_KEY, &true);
    }
    // Always mark the round resolved so a second call (deadline fallback after
    // auto-advance, or duplicate resolve_round calls) is rejected cleanly.
    round.finished = true;

    #[cfg(debug_assertions)]
    {
        crate::invariants::check_round_flags(&round)
            .expect("resolve_round: round flags invariant violated");
        crate::invariants::check_round_number_monotonic(
            before_round_number,
            round.round_number,
        )
        .expect("resolve_round: round number monotonic invariant violated");
    }

    storage(env).set(&DataKey::Round, &round);
    bump(env, &DataKey::Round);

    if env
        .storage()
        .instance()
        .get::<_, bool>(&GAME_FINISHED_KEY)
        .unwrap_or(false)
    {
        set_state(env, ArenaState::Completed);
    }

    env.events().publish(
        (TOPIC_ROUND_RESOLVED,),
        (
            round.round_number,
            heads_count,
            tails_count,
            outcome_symbol(&surviving_choice),
            eliminated_count,
            updated_survivor_count,
            EVENT_VERSION,
        ),
    );

    Ok(round)
}

fn get_config(env: &Env) -> Result<ArenaConfig, ArenaError> {
    storage(env)
        .get(&DataKey::Config)
        .ok_or(ArenaError::NotInitialized)
}

fn set_config(env: &Env, arena_id: u64, config: &ArenaConfig) {
    let key = DataKey::Config(arena_id);
    storage(env).set(&key, config);
    bump(env, &key);
}

fn get_state(env: &Env, arena_id: u64) -> Result<ArenaState, ArenaError> {
    storage(env)
        .get(&DataKey::State(arena_id))
        .ok_or(ArenaError::NotInitialized)
}

fn set_state(env: &Env, arena_id: u64, state: &ArenaState) {
    let key = DataKey::State(arena_id);
    storage(env).set(&key, state);
    bump(env, &key);
}

fn get_players(env: &Env, arena_id: u64) -> Vec<Address> {
    storage(env)
        .get(&DataKey::Players(arena_id))
        .unwrap_or(Vec::new(env))
}

fn set_players(env: &Env, arena_id: u64, players: &Vec<Address>) {
    let key = DataKey::Players(arena_id);
    storage(env).set(&key, players);
    bump(env, &key);
}

fn get_survivors(env: &Env, arena_id: u64) -> Vec<Address> {
    storage(env)
        .get(&DataKey::Survivors(arena_id))
        .unwrap_or(Vec::new(env))
}

fn set_survivors(env: &Env, arena_id: u64, survivors: &Vec<Address>) {
    let key = DataKey::Survivors(arena_id);
    storage(env).set(&key, survivors);
    bump(env, &key);
}

fn get_eliminated(env: &Env, arena_id: u64) -> Vec<Address> {
    storage(env)
        .get(&DataKey::Eliminated(arena_id))
        .unwrap_or(Vec::new(env))
}

fn set_eliminated(env: &Env, arena_id: u64, eliminated: &Vec<Address>) {
    let key = DataKey::Eliminated(arena_id);
    storage(env).set(&key, eliminated);
    bump(env, &key);
}

fn get_round_choices(env: &Env, arena_id: u64, round: u32) -> soroban_sdk::Map<Address, Choice> {
    storage(env)
        .get(&DataKey::RoundChoices(arena_id, round))
        .unwrap_or(soroban_sdk::Map::new(env))
}

fn set_round_choices(env: &Env, arena_id: u64, round: u32, choices: &soroban_sdk::Map<Address, Choice>) {
    let key = DataKey::RoundChoices(arena_id, round);
    storage(env).set(&key, choices);
    bump(env, &key);
}

/// Collect all addresses from the `AllPlayers` list that are still registered
/// as survivors (i.e. have not been eliminated yet).
fn collect_survivors(env: &Env) -> Vec<Address> {
    let all_players: Vec<Address> = storage(env)
        .get(&DataKey::AllPlayers)
        .unwrap_or(Vec::new(env));
    let mut survivors = Vec::new(env);
    for player in all_players.iter() {
        if storage(env).has(&DataKey::Survivor(player.clone())) {
            survivors.push_back(player);
        }
    }
    survivors
}

fn choose_surviving_side(env: &Env, heads_count: u32, tails_count: u32) -> Option<Choice> {
    match (heads_count, tails_count) {
        (0, 0) => None,
        (0, _) => Some(Choice::Tails),
        (_, 0) => Some(Choice::Heads),
        _ if heads_count == tails_count => {
            if (env.prng().r#gen::<u64>() & 1) == 0 {
                Some(Choice::Heads)
            } else {
                Some(Choice::Tails)
            }
        }
        _ if heads_count < tails_count => Some(Choice::Heads),
        _ => Some(Choice::Tails),
    }
}

fn outcome_symbol(outcome: &Option<Choice>) -> Symbol {
    match outcome {
        Some(Choice::Heads) => symbol_short!("HEADS"),
        Some(Choice::Tails) => symbol_short!("TAILS"),
        None => symbol_short!("NONE"),
    }
}

fn get_state(env: &Env) -> ArenaState {
    storage(env)
        .get(&DataKey::State)
        .unwrap_or(ArenaState::Pending)
}

fn set_state(env: &Env, new_state: ArenaState) {
    let old_state = get_state(env);
    if old_state == new_state {
        return;
    }
    storage(env).set(&DataKey::State, &new_state);
    env.events().publish(
        (TOPIC_STATE_CHANGED,),
        ArenaStateChanged {
            old_state,
            new_state,
        },
    );
}

fn bump(env: &Env, key: &DataKey) {
    env.storage()
        .persistent()
        .extend_ttl(key, GAME_TTL_THRESHOLD, GAME_TTL_EXTEND_TO);
}

#[cfg(test)]
mod abi_guard;
#[cfg(test)]
mod auto_advance_tests;
#[cfg(all(test, feature = "integration-tests"))]
mod integration_tests;
#[cfg(test)]
mod metadata_tests;
#[cfg(test)]
mod state_machine_tests;
#[cfg(test)]
mod submit_choice_tests;
#[cfg(test)]
mod test;
