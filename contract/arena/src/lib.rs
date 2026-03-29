#![no_std]

mod bounds;
mod invariants;

use soroban_sdk::{
    Address, BytesN, Env, Symbol, Vec, contract, contracterror, contractimpl, contracttype,
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
const TOPIC_WINNER_SET: Symbol = symbol_short!("WIN_SET");
const TOPIC_CLAIM: Symbol = symbol_short!("CLAIM");
const TOPIC_LEAVE: Symbol = symbol_short!("LEAVE");

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

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct UserStateView {
    pub is_active: bool,
    pub has_won: bool,
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
    HeadsSubmitters(u32),
    TailsSubmitters(u32),
    Survivor(Address),
    Eliminated(Address),
    PrizeClaimed(Address),
    Winner(Address),
}


// ── Contract ──────────────────────────────────────────────────────────────────

#[contract]
pub struct ArenaContract;

#[contractimpl]
impl ArenaContract {
    pub fn init(
        env: Env,
        round_speed_in_ledgers: u32,
        required_stake_amount: i128,
    ) -> Result<(), ArenaError> {
        if storage(&env).has(&DataKey::Config) {
            return Err(ArenaError::AlreadyInitialized);
        }
        if round_speed_in_ledgers == 0 || round_speed_in_ledgers > bounds::MAX_SPEED_LEDGERS {
            return Err(ArenaError::InvalidRoundSpeed);
        }
        if required_stake_amount <= 0 {
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
        Ok(())
    }

    pub fn initialize(env: Env, admin: Address) {
        if env.storage().instance().has(&ADMIN_KEY) {
            panic!("already initialized");
        }

        admin.require_auth();

        env.storage().instance().set(&ADMIN_KEY, &admin);
    }

    pub fn init_factory(env: Env, factory: Address, admin: Address) {
        if env.storage().instance().has(&ADMIN_KEY) {
            panic!("already initialized");
        }

        factory.require_auth();

        env.storage().instance().set(&ADMIN_KEY, &admin);
    }

    pub fn admin(env: Env) -> Address {
        env.storage()
            .instance()
            .get(&ADMIN_KEY)
            .expect("not initialized")
    }

    pub fn set_admin(env: Env, new_admin: Address) {
        let admin: Address = env
            .storage()
            .instance()
            .get(&ADMIN_KEY)
            .expect("not initialized");
        admin.require_auth();
        env.storage().instance().set(&ADMIN_KEY, &new_admin);
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
        env.storage().instance().set(&PAUSED_KEY, &false);
        env.events().publish((TOPIC_UNPAUSED,), ());
    }

    pub fn is_paused(env: Env) -> bool {
        env.storage().instance().get(&PAUSED_KEY).unwrap_or(false)
    }

    pub fn set_token(env: Env, token: Address) -> Result<(), ArenaError> {
        // Admin configuration remains available during an emergency pause so the
        // token can be rotated before gameplay resumes.
        let admin: Address = env
            .storage()
            .instance()
            .get(&ADMIN_KEY)
            .expect("not initialized");
        admin.require_auth();
        let survivor_count: u32 = env
            .storage()
            .instance()
            .get(&SURVIVOR_COUNT_KEY)
            .unwrap_or(0u32);
        let prize_pool: i128 = env
            .storage()
            .instance()
            .get(&PRIZE_POOL_KEY)
            .unwrap_or(0i128);
        if survivor_count > 0 || prize_pool > 0 {
            return Err(ArenaError::TokenConfigurationLocked);
        }
        env.storage().instance().set(&TOKEN_KEY, &token);
        Ok(())
    }

    pub fn set_capacity(env: Env, capacity: u32) -> Result<(), ArenaError> {
        let admin: Address = env
            .storage()
            .instance()
            .get(&ADMIN_KEY)
            .ok_or(ArenaError::NotInitialized)?;
        admin.require_auth();
        if !(bounds::MIN_ARENA_PARTICIPANTS..=bounds::MAX_ARENA_PARTICIPANTS).contains(&capacity) {
            return Err(ArenaError::InvalidCapacity);
        }
        env.storage().instance().set(&CAPACITY_KEY, &capacity);
        Ok(())
    }

    pub fn set_winner(
        env: Env,
        player: Address,
        stake: i128,
        yield_comp: i128,
    ) -> Result<(), ArenaError> {
        require_not_paused(&env)?;
        let admin = Self::admin(env.clone());
        admin.require_auth();
        if stake < 0 || yield_comp < 0 {
            return Err(ArenaError::InvalidAmount);
        }
        let prize = stake
            .checked_add(yield_comp)
            .ok_or(ArenaError::InvalidAmount)?;
        storage(&env).set(&DataKey::Winner(player.clone()), &());
        bump(&env, &DataKey::Winner(player.clone()));
        env.storage().instance().set(&PRIZE_POOL_KEY, &prize);
        env.events()
            .publish((TOPIC_WINNER_SET,), (player, stake, yield_comp));
        Ok(())
    }

    pub fn join(env: Env, player: Address, amount: i128) -> Result<(), ArenaError> {
        player.require_auth();
        require_not_paused(&env)?;
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
        if amount <= 0 {
            return Err(ArenaError::InvalidAmount);
        }
        let required_stake_amount = config.required_stake_amount;
        if amount != required_stake_amount {
            return Err(ArenaError::InvalidAmount);
        }
        let survivor_key = DataKey::Survivor(player.clone());
        if storage(&env).has(&survivor_key) {
            return Err(ArenaError::AlreadyJoined);
        }
        let configured_cap: u32 = env.storage().instance().get(&CAPACITY_KEY).unwrap_or(0u32);
        let effective_cap = if configured_cap == 0 {
            bounds::MAX_ARENA_PARTICIPANTS
        } else {
            configured_cap.min(bounds::MAX_ARENA_PARTICIPANTS)
        };
        let count: u32 = env
            .storage()
            .instance()
            .get(&SURVIVOR_COUNT_KEY)
            .unwrap_or(0u32);
        if count >= effective_cap {
            return Err(ArenaError::ArenaFull);
        }
        let token: Address = env
            .storage()
            .instance()
            .get(&TOKEN_KEY)
            .ok_or(ArenaError::TokenNotSet)?;
        // CEI: effects before interaction
        storage(&env).set(&survivor_key, &());
        bump(&env, &survivor_key);
        env.storage()
            .instance()
            .set(&SURVIVOR_COUNT_KEY, &(count + 1));
        let pool: i128 = env
            .storage()
            .instance()
            .get(&PRIZE_POOL_KEY)
            .unwrap_or(0i128);
        env.storage()
            .instance()
            .set(&PRIZE_POOL_KEY, &(pool + amount));
        token::Client::new(&env, &token).transfer(
            &player,
            &env.current_contract_address(),
            &amount,
        );
        Ok(())
    }

    pub fn leave(env: Env, player: Address) -> Result<i128, ArenaError> {
        player.require_auth();
        require_not_paused(&env)?;
        // Only allowed before round 1 starts
        let round = get_round(&env)?;
        if round.round_number != 0 {
            return Err(ArenaError::RoundAlreadyActive);
        }
        let survivor_key = DataKey::Survivor(player.clone());
        if !storage(&env).has(&survivor_key) {
            return Err(ArenaError::NotASurvivor);
        }
        let config = get_config(&env)?;
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
        Ok(refund)
    }

    pub fn start_round(env: Env) -> Result<RoundState, ArenaError> {
        require_not_paused(&env)?;
        if env
            .storage()
            .instance()
            .get::<_, bool>(&GAME_FINISHED_KEY)
            .unwrap_or(false)
        {
            return Err(ArenaError::GameAlreadyFinished);
        }
        env.storage()
            .instance()
            .extend_ttl(GAME_TTL_THRESHOLD, GAME_TTL_EXTEND_TO);
        let config = get_config(&env)?;
        let previous_round = get_round(&env)?;
        if previous_round.active {
            return Err(ArenaError::RoundAlreadyActive);
        }
        let survivor_count: u32 = env
            .storage()
            .instance()
            .get(&SURVIVOR_COUNT_KEY)
            .unwrap_or(0u32);
        if survivor_count < bounds::MIN_ARENA_PARTICIPANTS {
            return Err(ArenaError::NotEnoughPlayers);
        }
        let round_start_ledger = env.ledger().sequence();
        let round_deadline_ledger = round_start_ledger
            .checked_add(config.round_speed_in_ledgers)
            .ok_or(ArenaError::RoundDeadlineOverflow)?;
        let next_round = RoundState {
            round_number: previous_round.round_number + 1,
            round_start_ledger,
            round_deadline_ledger,
            active: true,
            total_submissions: 0,
            timed_out: false,
            finished: false,
        };

        #[cfg(debug_assertions)]
        {
            crate::invariants::check_round_flags(&next_round)
                .expect("start_round: round flags invariant violated");
            crate::invariants::check_round_number_monotonic(
                previous_round.round_number,
                next_round.round_number,
            )
            .expect("start_round: round number monotonic invariant violated");
        }

        storage(&env).set(&DataKey::Round, &next_round);
        bump(&env, &DataKey::Round);
        env.events().publish(
            (TOPIC_ROUND_STARTED,),
            (
                next_round.round_number,
                next_round.round_start_ledger,
                next_round.round_deadline_ledger,
                EVENT_VERSION,
            ),
        );
        Ok(next_round)
    }

    pub fn submit_choice(
        env: Env,
        player: Address,
        round_number: u32,
        choice: Choice,
    ) -> Result<(), ArenaError> {
        require_not_paused(&env)?;
        env.storage()
            .instance()
            .extend_ttl(GAME_TTL_THRESHOLD, GAME_TTL_EXTEND_TO);
        player.require_auth();

        // Verify the player is a registered survivor (i.e. joined the game).
        let eliminated_key = DataKey::Eliminated(player.clone());
        if storage(&env).has(&eliminated_key) {
            return Err(ArenaError::PlayerEliminated);
        }
        let survivor_key = DataKey::Survivor(player.clone());
        if !storage(&env).has(&survivor_key) {
            return Err(ArenaError::NotASurvivor);
        }

        let mut round = get_round(&env)?;
        #[cfg(debug_assertions)]
        let before_submissions = round.total_submissions;

        if !round.active {
            return Err(ArenaError::NoActiveRound);
        }
        if round_number != round.round_number {
            return Err(ArenaError::WrongRoundNumber);
        }
        if env.ledger().sequence() > round.round_deadline_ledger {
            return Err(ArenaError::SubmissionWindowClosed);
        }
        let submission_key = DataKey::Submission(round.round_number, player.clone());
        if storage(&env).has(&submission_key) {
            return Err(ArenaError::SubmissionAlreadyExists);
        }
        if round.total_submissions >= bounds::MAX_SUBMISSIONS_PER_ROUND {
            return Err(ArenaError::MaxSubmissionsPerRound);
        }
        storage(&env).set(&submission_key, &choice);
        bump(&env, &submission_key);
        let submitters_key = match choice {
            Choice::Heads => DataKey::HeadsSubmitters(round.round_number),
            Choice::Tails => DataKey::TailsSubmitters(round.round_number),
        };
        let mut submitters = get_submitters(&env, &submitters_key);
        submitters.push_back(player.clone());
        storage(&env).set(&submitters_key, &submitters);
        bump(&env, &submitters_key);
        round.total_submissions += 1;

        #[cfg(debug_assertions)]
        {
            crate::invariants::check_submission_count_monotonic(
                before_submissions,
                round.total_submissions,
            )
            .expect("submit_choice: submission count monotonic invariant violated");
            crate::invariants::check_round_flags(&round)
                .expect("submit_choice: round flags invariant violated");
        }

        storage(&env).set(&DataKey::Round, &round);
        bump(&env, &DataKey::Round);
        Ok(())
    }

    pub fn timeout_round(env: Env) -> Result<RoundState, ArenaError> {
        require_not_paused(&env)?;
        env.storage()
            .instance()
            .extend_ttl(GAME_TTL_THRESHOLD, GAME_TTL_EXTEND_TO);
        let mut round = get_round(&env)?;
        #[cfg(debug_assertions)]
        let before = round.clone();

        if !round.active {
            return Err(ArenaError::NoActiveRound);
        }
        if env.ledger().sequence() <= round.round_deadline_ledger {
            return Err(ArenaError::RoundStillOpen);
        }
        round.active = false;
        round.timed_out = true;

        #[cfg(debug_assertions)]
        {
            crate::invariants::check_timeout_transition(&before, &round)
                .expect("timeout_round: timeout transition invariant violated");
            crate::invariants::check_round_flags(&round)
                .expect("timeout_round: round flags invariant violated");
            crate::invariants::check_round_number_monotonic(before.round_number, round.round_number)
                .expect("timeout_round: round number monotonic invariant violated");
        }

        storage(&env).set(&DataKey::Round, &round);
        bump(&env, &DataKey::Round);
        env.events().publish(
            (TOPIC_ROUND_TIMEOUT,),
            (round.round_number, round.total_submissions, EVENT_VERSION),
        );
        Ok(round)
    }

    pub fn resolve_round(env: Env) -> Result<RoundState, ArenaError> {
        require_not_paused(&env)?;
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
        #[cfg(debug_assertions)]
        let before_round_number = round.round_number;

        if round.finished {
            return Err(ArenaError::NoActiveRound);
        }
        if round.active {
            if env.ledger().sequence() <= round.round_deadline_ledger {
                return Err(ArenaError::RoundStillOpen);
            }
            round.active = false;
            round.timed_out = true;
        }

        let heads_key = DataKey::HeadsSubmitters(round.round_number);
        let tails_key = DataKey::TailsSubmitters(round.round_number);
        let heads_submitters = get_submitters(&env, &heads_key);
        let tails_submitters = get_submitters(&env, &tails_key);
        let heads_count = heads_submitters.len();
        let tails_count = tails_submitters.len();

        let surviving_choice = choose_surviving_side(&env, heads_count, tails_count);
        let eliminated_players = match surviving_choice {
            Some(Choice::Heads) => tails_submitters,
            Some(Choice::Tails) => heads_submitters,
            None => Vec::new(&env),
        };

        let mut eliminated_count = 0u32;
        for player in eliminated_players.iter() {
            let survivor_key = DataKey::Survivor(player.clone());
            if storage(&env).has(&survivor_key) {
                storage(&env).remove(&survivor_key);
                let eliminated_key = DataKey::Eliminated(player.clone());
                storage(&env).set(&eliminated_key, &true);
                bump(&env, &eliminated_key);
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

        storage(&env).set(&DataKey::Round, &round);
        bump(&env, &DataKey::Round);

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

    pub fn claim(env: Env, winner: Address) -> Result<i128, ArenaError> {
        require_not_paused(&env)?;
        winner.require_auth();
        if !env
            .storage()
            .instance()
            .get::<_, bool>(&GAME_FINISHED_KEY)
            .unwrap_or(false)
        {
            return Err(ArenaError::GameNotFinished);
        }
        // Verify caller is the address designated by set_winner(); any other
        // survivor could otherwise pass require_auth() with their own address
        // and drain the prize pool.
        if !storage(&env).has(&DataKey::Winner(winner.clone())) {
            return Err(ArenaError::NotASurvivor);
        }
        if env
            .storage()
            .instance()
            .get::<_, bool>(&GAME_STATUS_KEY)
            .unwrap_or(false)
        {
            return Err(ArenaError::ReentrancyGuard);
        }
        let prize_key = DataKey::PrizeClaimed(winner.clone());
        if storage(&env).has(&prize_key) {
            return Err(ArenaError::AlreadyClaimed);
        }
        let prize: i128 = env.storage().instance().get(&PRIZE_POOL_KEY).unwrap_or(0);
        if prize <= 0 {
            return Err(ArenaError::NoPrizeToClaim);
        }
        let token: Address = env
            .storage()
            .instance()
            .get(&TOKEN_KEY)
            .ok_or(ArenaError::TokenNotSet)?;
        // CEI: lock, record effects, then interact
        env.storage().instance().set(&GAME_STATUS_KEY, &true);
        storage(&env).set(&prize_key, &prize);
        bump(&env, &prize_key);
        env.storage().instance().set(&PRIZE_POOL_KEY, &0i128);
        token::Client::new(&env, &token).transfer(&env.current_contract_address(), &winner, &prize);
        env.storage().instance().set(&GAME_STATUS_KEY, &false);
        env.storage().instance().set(&GAME_FINISHED_KEY, &true);
        // Mark round as finished after prize is claimed
        if let Some(mut round) = storage(&env).get::<_, RoundState>(&DataKey::Round) {
            round.finished = true;
            storage(&env).set(&DataKey::Round, &round);
            bump(&env, &DataKey::Round);
        }
        env.events()
            .publish((TOPIC_CLAIM,), (winner, prize, EVENT_VERSION));
        Ok(prize)
    }

    pub fn get_config(env: Env) -> Result<ArenaConfig, ArenaError> {
        get_config(&env)
    }

    pub fn get_round(env: Env) -> Result<RoundState, ArenaError> {
        get_round(&env)
    }

    pub fn get_choice(env: Env, round_number: u32, player: Address) -> Option<Choice> {
        storage(&env).get(&DataKey::Submission(round_number, player))
    }

    pub fn get_arena_state(env: Env) -> Result<ArenaStateView, ArenaError> {
        let round = storage(&env)
            .get::<_, RoundState>(&DataKey::Round)
            .unwrap_or(RoundState {
                round_number: 0,
                round_start_ledger: 0,
                round_deadline_ledger: 0,
                active: false,
                total_submissions: 0,
                timed_out: false,
                finished: false,
            });
        let prize_pool: i128 = env.storage().instance().get(&PRIZE_POOL_KEY).unwrap_or(0);
        let max_capacity: u32 = env.storage().instance().get(&CAPACITY_KEY).unwrap_or(0);
        let survivors_count: u32 = env
            .storage()
            .instance()
            .get(&SURVIVOR_COUNT_KEY)
            .unwrap_or(0);
        Ok(ArenaStateView {
            survivors_count,
            max_capacity,
            round_number: round.round_number,
            current_stake: prize_pool,
            potential_payout: prize_pool,
        })
    }

    pub fn get_user_state(env: Env, player: Address) -> UserStateView {
        let is_active = storage(&env).has(&DataKey::Survivor(player.clone()));
        let has_won = storage(&env).has(&DataKey::Winner(player));
        UserStateView { is_active, has_won }
    }

    pub fn get_full_state(env: Env, player: Address) -> Result<FullStateView, ArenaError> {
        // Require initialization — callers must call init() first
        get_round(&env)?;
        let arena_state = Self::get_arena_state(env.clone())?;
        let user_state = Self::get_user_state(env, player);
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

    pub fn propose_upgrade(env: Env, new_wasm_hash: BytesN<32>) -> Result<(), ArenaError> {
        let admin: Address = env
            .storage()
            .instance()
            .get(&ADMIN_KEY)
            .ok_or(ArenaError::NotInitialized)?;
        admin.require_auth();
        let execute_after: u64 = env.ledger().timestamp() + TIMELOCK_PERIOD;
        env.storage()
            .instance()
            .set(&PENDING_HASH_KEY, &new_wasm_hash);
        env.storage()
            .instance()
            .set(&EXECUTE_AFTER_KEY, &execute_after);
        env.events()
            .publish((TOPIC_UPGRADE_PROPOSED,), (new_wasm_hash, execute_after));
        Ok(())
    }

    pub fn execute_upgrade(env: Env) -> Result<(), ArenaError> {
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
        if env.ledger().timestamp() < execute_after {
            return Err(ArenaError::TimelockNotExpired);
        }
        let new_wasm_hash: BytesN<32> = env
            .storage()
            .instance()
            .get(&PENDING_HASH_KEY)
            .ok_or(ArenaError::NoPendingUpgrade)?;
        env.storage().instance().remove(&PENDING_HASH_KEY);
        env.storage().instance().remove(&EXECUTE_AFTER_KEY);
        env.events()
            .publish((TOPIC_UPGRADE_EXECUTED,), new_wasm_hash.clone());
        env.deployer().update_current_contract_wasm(new_wasm_hash);
        Ok(())
    }

    pub fn cancel_upgrade(env: Env) -> Result<(), ArenaError> {
        let admin: Address = env
            .storage()
            .instance()
            .get(&ADMIN_KEY)
            .ok_or(ArenaError::NotInitialized)?;
        admin.require_auth();
        if !env.storage().instance().has(&PENDING_HASH_KEY) {
            return Err(ArenaError::NoPendingUpgrade);
        }
        env.storage().instance().remove(&PENDING_HASH_KEY);
        env.storage().instance().remove(&EXECUTE_AFTER_KEY);
        env.events().publish((TOPIC_UPGRADE_CANCELLED,), ());
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
}

// ── Helpers ───────────────────────────────────────────────────────────────────

fn get_config(env: &Env) -> Result<ArenaConfig, ArenaError> {
    storage(env)
        .get(&DataKey::Config)
        .ok_or(ArenaError::NotInitialized)
}

fn get_round(env: &Env) -> Result<RoundState, ArenaError> {
    storage(env)
        .get(&DataKey::Round)
        .ok_or(ArenaError::NotInitialized)
}

fn storage(env: &Env) -> soroban_sdk::storage::Persistent {
    env.storage().persistent()
}

fn require_not_paused(env: &Env) -> Result<(), ArenaError> {
    if env.storage().instance().get(&PAUSED_KEY).unwrap_or(false) {
        return Err(ArenaError::Paused);
    }
    Ok(())
}

fn get_submitters(env: &Env, key: &DataKey) -> Vec<Address> {
    storage(env).get(key).unwrap_or(Vec::new(env))
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

fn bump(env: &Env, key: &DataKey) {
    env.storage()
        .persistent()
        .extend_ttl(key, GAME_TTL_THRESHOLD, GAME_TTL_EXTEND_TO);
}

#[cfg(test)]
mod abi_guard;
#[cfg(all(test, feature = "integration-tests"))]
mod integration_tests;
#[cfg(test)]
mod test;
