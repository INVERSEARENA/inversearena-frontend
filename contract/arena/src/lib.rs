#![no_std]

use soroban_sdk::{
    Address, Bytes, BytesN, Env, IntoVal, String, Symbol, Vec, contract, contracterror,
    contractimpl, contracttype, panic_with_error, symbol_short, token,
};
#[path = "../../shared/admin_transfer.rs"]
mod admin_transfer_utils;
#[path = "../../shared/upgrade.rs"]
mod upgrade_utils;
use admin_transfer_utils::{
    AdminTransferErrors, AdminTransferKeys, accept_admin_transfer as accept_admin_transfer_flow,
    cancel_admin_transfer as cancel_admin_transfer_flow,
    pending_admin_transfer as pending_admin_transfer_flow,
    propose_admin_transfer as propose_admin_transfer_flow,
};
use upgrade_utils::{
    ExecuteTimePolicy, UpgradeErrors, UpgradeKeys, UpgradeTopics,
    cancel_upgrade as cancel_upgrade_flow, execute_upgrade as execute_upgrade_flow,
    pending_upgrade as pending_upgrade_flow, propose_upgrade as propose_upgrade_flow,
};

mod bounds;
#[cfg(test)]
mod invariants;

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
const PENDING_ADMIN_KEY: Symbol = symbol_short!("P_ADMIN");
const ADMIN_EXPIRY_KEY: Symbol = symbol_short!("A_EXP");
const VAULT_ADDR_KEY: Symbol = symbol_short!("VAULT");
const FALLBACK_VAULT_KEY: Symbol = symbol_short!("F_VAULT");
const VAULT_ACTIVE_KEY: Symbol = symbol_short!("V_ACT");
const VAULT_SHARES_KEY: Symbol = symbol_short!("V_SHARE");
const VAULT_DEPOSITED_KEY: Symbol = symbol_short!("V_DEP");

const ADMIN_TRANSFER_EXPIRY: u64 = 7 * 24 * 60 * 60;

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
const TOPIC_ARENA_STARTED: Symbol = symbol_short!("A_START");
const TOPIC_TIEBREAKER_USED: Symbol = symbol_short!("TIEBRK");

const TOPIC_UPGRADE_PROPOSED: Symbol = symbol_short!("UP_PROP");
const TOPIC_UPGRADE_EXECUTED: Symbol = symbol_short!("UP_EXEC");
const TOPIC_UPGRADE_CANCELLED: Symbol = symbol_short!("UP_CANC");

const TOPIC_YIELD_HARVESTED: Symbol = symbol_short!("Y_HARV");
const TOPIC_VAULT_FALLBACK: Symbol = symbol_short!("V_FALL");
const TOPIC_ADMIN_PROPOSED: Symbol = symbol_short!("AD_PROP");
const TOPIC_ADMIN_ACCEPTED: Symbol = symbol_short!("AD_DONE");
const TOPIC_ADMIN_CANCELLED: Symbol = symbol_short!("AD_CANC");

const TOPIC_FUNDS_DEPOSITED: Symbol = symbol_short!("F_DEP");
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
    AlreadyCommitted = 41,
    DeadlineTooSoon = 42,
    DeadlineTooFar = 43,
    DeadlineNotReached = 44,
    HashMismatch = 45,
    InvalidGracePeriod = 46,
    NotWhitelisted = 47,
    BatchAlreadyInProgress = 48,
    NoBatchInProgress = 49,
    BatchNotComplete = 50,
    Unauthorized = 51,
    NoPendingAdminTransfer = 52,
    AdminTransferExpired = 53,
    VaultNotSet = 54,
}

#[contracttype]
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
#[repr(u32)]
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
    pub reserve_ratio_bps: u32,
    pub is_private: bool,
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
    pub vault_active: bool,
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
    pub vault_active: bool,
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
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum PlayerStatus {
    Active,
    Elim,
    Winner,
}

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct PlayerSnapshot {
    pub player: Address,
    pub status: PlayerStatus,
    pub eliminated_round: Option<u32>,
    pub choice_this_round: Option<u32>,
    pub total_rounds_survived: u32,
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
pub struct ArenaStarted {
    pub arena_id: u64,
    pub player_count: u32,
    pub prize_pool: i128,
}

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct TiebreakerUsed {
    pub arena_id: u64,
    pub round: u32,
    pub sequence: u32,
    pub winning_side: Choice,
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

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct YieldHarvested {
    pub arena_id: u64,
    pub yield_earned: i128,
    pub final_prize_pool: i128,
}

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct VaultFallbackActivated {
    pub arena_id: u64,
    pub reason: String,
}

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct AdminTransferProposed {
    pub current_admin: Address,
    pub pending_admin: Address,
    pub expires_at: u64,
}

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct AdminTransferCompleted {
    pub old_admin: Address,
    pub new_admin: Address,
}

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct FundsDeposited {
    pub arena_id: u64,
    pub amount: i128,
    pub shares: i128,
    pub vault_address: Address,
}

macro_rules! assert_state {
    ($current:expr, $expected:pat) => {
        match $current {
            $expected => {}
            _ => panic!(
                "Invalid state transition: current state {:?} is not allowed for this operation",
                $current
            ),
        }
    };
}

/// Asserts that `$caller` equals the arena host stored in `CREATOR_KEY`.
/// Returns `Err(ArenaError::Unauthorized)` if the check fails.
macro_rules! assert_is_host {
    ($env:expr, $caller:expr) => {
        match $env.storage().instance().get::<_, Address>(&CREATOR_KEY) {
            Some(host) if host == $caller => {}
            _ => return Err(ArenaError::Unauthorized),
        }
    };
}

/// Asserts that `$player` is an active survivor (not yet eliminated).
/// Returns `Err(ArenaError::Unauthorized)` if the check fails.
macro_rules! assert_is_survivor {
    ($env:expr, $player:expr) => {
        if !$env
            .storage()
            .persistent()
            .has(&DataKey::Survivor($player.clone()))
        {
            return Err(ArenaError::Unauthorized);
        }
    };
}
#[contracttype]
#[derive(Clone)]
enum DataKey {
    Config,
    ArenaId,
    FactoryAddress,
    Round,
    Submission(u32, Address),
    Choices(u64, u32, Address),
    Commitment(u32, Address),
    RoundPlayers(u32),
    AllPlayers,
    Survivor(Address),
    Eliminated(Address),
    ElimRound(Address),
    PrizeClaimed(Address),
    Claimable(Address),
    Winner(Address),
    Refunded(Address),
    Metadata(u64),
    /// In-progress batched round resolution. See [`ResolutionState`].
    Resolution,
}

/// Intermediate tally for a batched round resolution (issue #480).
///
/// Stored under [`DataKey::Resolution`] only while a batched resolve is in
/// flight. `start_resolution` creates it, each `continue_resolution` advances
/// `processed`, and `finalize_resolution` consumes it (then clears the slot).
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ResolutionState {
    /// Round number the batch is resolving — guards against starting a batch
    /// for one round and finalising it for another after a manual round flip.
    pub round_number: u32,
    /// Snapshot of `all_players().len()` at `start_resolution`.
    pub total_players: u32,
    /// Number of players counted so far (cursor into `all_players`).
    pub processed: u32,
    /// Tally of `Choice::Heads` from surviving players counted so far.
    pub heads_count: u32,
    /// Tally of `Choice::Tails` from surviving players counted so far.
    pub tails_count: u32,
}

/// # ArenaContract Access Control Matrix
///
/// | Function              | Admin | Host             | Active Player | Public         |
/// |-----------------------|-------|------------------|---------------|----------------|
/// | initialize / init     |   ✓   |   ✗              |      ✗        |      ✗         |
/// | player_join           |   ✗   |   ✗              |      ✗        |   ✓ (any)      |
/// | submit_choice         |   ✗   |   ✗              |      ✓        |      ✗         |
/// | resolve_round         |   ✓   |   ✓              |      ✗        |   ✓ (deadline) |
/// | cancel_arena          |   ✓   |   ✓ (pending)    |      ✗        |      ✗         |
/// | emergency_recover     |   ✓   |   ✗              |      ✗        |      ✗         |
/// | get_arena_state       |   ✓   |   ✓              |      ✓        |      ✓         |
///
/// Roles:
/// - **Admin**: stored in `ADMIN_KEY`; transferable via two-step `propose_admin`/`accept_admin`.
/// - **Host**: stored in `CREATOR_KEY` via `init_factory`; the pool creator address.
/// - **Active Player**: any address present in `Survivor(_)` persistent storage.
/// - **Public**: no restriction beyond time-based deadline checks.
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
            .unwrap_or_else(|| panic_with_error!(&env, ArenaError::NotInitialized))
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
        Self::init_with_fee(
            env,
            round_speed_in_ledgers,
            required_stake_amount,
            join_deadline,
            0,
        )
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

        env.storage()
            .instance()
            .extend_ttl(GAME_TTL_THRESHOLD, GAME_TTL_EXTEND_TO);
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
                reserve_ratio_bps: 1_000,
                is_private: false,
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
        require_not_paused(&env)?;
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
        require_not_paused(&env)?;
        if !(bounds::MIN_ARENA_PARTICIPANTS..=bounds::MAX_ARENA_PARTICIPANTS).contains(&capacity) {
            return Err(ArenaError::InvalidCapacity);
        }
        env.storage().instance().set(&CAPACITY_KEY, &capacity);
        Ok(())
    }

    pub fn set_winner_yield_share_bps(env: Env, bps: u32) -> Result<(), ArenaError> {
        let admin = Self::admin(env.clone());
        admin.require_auth();
        require_not_paused(&env)?;
        if bps > 10_000 {
            return Err(ArenaError::InvalidAmount);
        }
        let mut config = get_config(&env)?;
        if bps + config.reserve_ratio_bps > 10_000 {
            return Err(ArenaError::InvalidAmount);
        }
        config.winner_yield_share_bps = bps;
        env.storage().instance().set(&DataKey::Config, &config);
        env.storage().instance().set(&WINNER_SHARE_KEY, &bps);
        Ok(())
    }

    pub fn set_reserve_ratio_bps(env: Env, bps: u32) -> Result<(), ArenaError> {
        let admin = Self::admin(env.clone());
        admin.require_auth();
        if bps > 10_000 {
            return Err(ArenaError::InvalidAmount);
        }
        let mut config = get_config(&env)?;
        if bps + config.winner_yield_share_bps > 10_000 {
            return Err(ArenaError::InvalidAmount);
        }
        config.reserve_ratio_bps = bps;
        env.storage().instance().set(&DataKey::Config, &config);
        Ok(())
    }

    pub fn join(env: Env, player: Address, amount: i128) -> Result<(), ArenaError> {
        player.require_auth();
        require_not_paused(&env)?;
        match state(&env) {
            ArenaState::Pending => {}
            ArenaState::Active => return Err(ArenaError::RoundAlreadyActive),
            ArenaState::Completed => return Err(ArenaError::GameAlreadyFinished),
            ArenaState::Cancelled => return Err(ArenaError::AlreadyCancelled),
        }
        let config = get_config(&env)?;
        let arena_id: u64 = env.storage().instance().get(&DataKey::ArenaId).unwrap_or(0);

        if config.is_private {
            if let Some(factory) = env
                .storage()
                .instance()
                .get::<_, Address>(&DataKey::FactoryAddress)
            {
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
        let pool: i128 = env.storage().instance().get(&PRIZE_POOL_KEY).unwrap_or(0);
        env.storage()
            .instance()
            .set(&PRIZE_POOL_KEY, &(pool + amount));
        env.storage().persistent().set(&key, &true);
        bump(&env, &key);
        env.storage()
            .instance()
            .set(&SURVIVOR_COUNT_KEY, &(count + 1));
        let mut players = all_players(&env);
        players.push_back(player.clone());
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

        let updated_count = count + 1;
        if updated_count >= capacity && state(&env) == ArenaState::Pending {
            activate_arena_internal(&env, arena_id, 1, config.round_speed_in_ledgers)?;
            let prize_pool: i128 = env.storage().instance().get(&PRIZE_POOL_KEY).unwrap_or(0);
            env.events().publish(
                (TOPIC_ARENA_STARTED,),
                ArenaStarted {
                    arena_id,
                    player_count: updated_count,
                    prize_pool,
                },
            );
        }
        Ok(())
    }

    pub fn player_join(env: Env, player: Address, arena_id: u64) -> Result<(), ArenaError> {
        let stored_arena_id: u64 = env
            .storage()
            .instance()
            .get(&DataKey::ArenaId)
            .unwrap_or(arena_id);
        if stored_arena_id != arena_id {
            return Err(ArenaError::Unauthorized);
        }
        let config = get_config(&env)?;
        Self::join(env, player, config.required_stake_amount)
    }

    /// Expire an unfilled arena past its join deadline. Callable by anyone.
    pub fn expire_arena(env: Env) -> Result<(), ArenaError> {
        require_not_paused(&env)?;
        let current_state = state(&env);
        match current_state {
            ArenaState::Pending => {}
            ArenaState::Active => return Err(ArenaError::RoundAlreadyActive),
            ArenaState::Completed => return Err(ArenaError::GameAlreadyFinished),
            ArenaState::Cancelled => return Err(ArenaError::AlreadyCancelled),
        }

        let config = get_config(&env)?;
        if env.ledger().timestamp() <= config.join_deadline {
            return Err(ArenaError::DeadlineNotReached);
        }

        let all_players: Vec<Address> = env
            .storage()
            .persistent()
            .get(&DataKey::AllPlayers)
            .unwrap_or(Vec::new(&env));
        let mut refunded_count: u32 = 0;
        if !all_players.is_empty() {
            let token: Address = env
                .storage()
                .instance()
                .get(&TOKEN_KEY)
                .ok_or(ArenaError::TokenNotSet)?;
            let refund_amount = config.required_stake_amount;
            let token_client = token::Client::new(&env, &token);

            for player in all_players.iter() {
                if env
                    .storage()
                    .persistent()
                    .has(&DataKey::Survivor(player.clone()))
                    && !env
                        .storage()
                        .persistent()
                        .has(&DataKey::Refunded(player.clone()))
                {
                    env.storage()
                        .persistent()
                        .set(&DataKey::Refunded(player.clone()), &());
                    bump(&env, &DataKey::Refunded(player.clone()));
                    token_client.transfer(&env.current_contract_address(), &player, &refund_amount);
                    refunded_count += 1;
                }
            }
            env.storage().instance().set(&PRIZE_POOL_KEY, &0i128);
        }

        env.storage().instance().set(&CANCELLED_KEY, &true);
        env.storage().instance().set(&GAME_FINISHED_KEY, &true);
        env.storage()
            .instance()
            .set(&STATE_KEY, &ArenaState::Cancelled);

        let arena_id: u64 = env.storage().instance().get(&DataKey::ArenaId).unwrap_or(0);
        env.events().publish(
            (TOPIC_ARENA_EXPIRED,),
            ArenaExpired {
                arena_id,
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
            .unwrap_or_else(|| panic_with_error!(&env, ArenaError::NotInitialized));
        config.join_deadline
    }

    pub fn set_grace_period_seconds(env: Env, grace_period_seconds: u64) -> Result<(), ArenaError> {
        let admin = Self::admin(env.clone());
        admin.require_auth();
        require_not_paused(&env)?;
        if grace_period_seconds > bounds::MAX_GRACE_PERIOD_SECONDS {
            return Err(ArenaError::InvalidGracePeriod);
        }
        let mut config = get_config(&env)?;
        config.grace_period_seconds = grace_period_seconds;
        env.storage().instance().set(&DataKey::Config, &config);
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
        let arena_id: u64 = env.storage().instance().get(&DataKey::ArenaId).unwrap_or(0);
        activate_arena_internal(
            &env,
            arena_id,
            previous.round_number + 1,
            config.round_speed_in_ledgers,
        )
    }

    pub fn start_arena(env: Env, arena_id: u64) -> Result<RoundState, ArenaError> {
        require_not_paused(&env)?;
        let metadata: ArenaMetadata = env
            .storage()
            .persistent()
            .get(&DataKey::Metadata(arena_id))
            .ok_or(ArenaError::NotInitialized)?;
        metadata.host.require_auth();

        let current_state = state(&env);
        if current_state == ArenaState::Active {
            return Err(ArenaError::RoundAlreadyActive);
        }
        if current_state == ArenaState::Completed {
            return Err(ArenaError::GameAlreadyFinished);
        }
        if current_state == ArenaState::Cancelled {
            return Err(ArenaError::AlreadyCancelled);
        }

        let survivors: u32 = env
            .storage()
            .instance()
            .get(&SURVIVOR_COUNT_KEY)
            .unwrap_or(0);
        if survivors < bounds::MIN_ARENA_PARTICIPANTS {
            return Err(ArenaError::NotEnoughPlayers);
        }

        let config = get_config(&env)?;
        let round = activate_arena_internal(&env, arena_id, 1, config.round_speed_in_ledgers)?;
        let prize_pool: i128 = env.storage().instance().get(&PRIZE_POOL_KEY).unwrap_or(0);
        env.events().publish(
            (TOPIC_ARENA_STARTED,),
            ArenaStarted {
                arena_id,
                player_count: survivors,
                prize_pool,
            },
        );
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
        if !is_active_survivor(&env, &player) {
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
        round_players.push_back(player.clone());
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
        require_not_paused(&env)?;
        let round = get_round(&env)?;
        if !round.active {
            return Err(ArenaError::NoActiveRound);
        }
        if env.ledger().sequence() > round.round_deadline_ledger {
            return Err(ArenaError::NoActiveRound);
        }
        if round.round_number != round_number {
            return Err(ArenaError::WrongRoundNumber);
        }

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
        salt: Bytes,
    ) -> Result<(), ArenaError> {
        use soroban_sdk::xdr::ToXdr;
        let key = DataKey::Commitment(round_number, player.clone());
        let commitment: Option<BytesN<32>> = env.storage().persistent().get(&key);
        if let Some(comm) = commitment {
            let mut bytes = Bytes::new(&env);
            let choice_byte: u8 = match choice {
                Choice::Heads => 0,
                Choice::Tails => 1,
            };
            bytes.append(&Bytes::from_array(&env, &[choice_byte]));
            bytes.append(&salt);
            bytes.append(&player.clone().to_xdr(&env));
            let hash: BytesN<32> = env.crypto().sha256(&bytes).into();
            if hash != comm {
                return Err(ArenaError::HashMismatch);
            }
        } else {
            return Err(ArenaError::HashMismatch);
        }
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
            if !is_active_survivor(&env, &player) {
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
        let resolution_outcome = choose_resolution_outcome(&env, heads, tails);
        emit_tiebreaker_used_if_needed(&env, round.round_number, heads, tails, resolution_outcome);
        let mut survivor_count = 0u32;
        let mut eliminated_count = 0u32;
        for player in players.iter() {
            let survivor_key = DataKey::Survivor(player.clone());
            if !is_active_survivor(&env, &player) {
                continue;
            }
            let player_choice = env.storage().persistent().get(&DataKey::Choices(
                0,
                round.round_number,
                player.clone(),
            ));
            let survives = player_survives(resolution_outcome, player_choice);
            if survives {
                survivor_count += 1;
            } else {
                env.storage().persistent().remove(&survivor_key);
                env.storage()
                    .persistent()
                    .set(&DataKey::Eliminated(player.clone()), &true);
                env.storage()
                    .persistent()
                    .set(&DataKey::ElimRound(player.clone()), &round.round_number);
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

    // ── Batched round resolution (issue #480) ────────────────────────────────
    //
    // `resolve_round` does the entire tally + apply pass in one transaction,
    // which can exceed Soroban's per-tx CPU budget for large arenas (~64
    // players). The trio below splits the tally across multiple transactions
    // so the per-call work stays bounded:
    //
    //   start_resolution(batch_size)    — initialise tally, process first batch
    //   continue_resolution(batch_size) — process next batch (any number of times)
    //   finalize_resolution()           — apply eliminations, clear batch state
    //
    // Small arenas can keep using `resolve_round`; the batched path is a pure
    // alternative entrypoint with no impact on the single-call flow.

    /// Begin a batched round resolution by tallying the first `batch_size`
    /// players from `all_players`. The intermediate tally is persisted under
    /// [`DataKey::Resolution`] and consumed by `finalize_resolution`.
    ///
    /// # Errors
    /// * [`ArenaError::Paused`] — contract is paused.
    /// * [`ArenaError::InvalidAmount`] — `batch_size` is zero or exceeds [`bounds::MAX_BATCH_SIZE`].
    /// * [`ArenaError::NoActiveRound`] — no round is currently active.
    /// * [`ArenaError::RoundDeadlineOverflow`] — deadline + grace overflows.
    /// * [`ArenaError::RoundStillOpen`] — the deadline (plus grace) hasn't elapsed.
    /// * [`ArenaError::BatchAlreadyInProgress`] — a batch is already pending.
    pub fn start_resolution(env: Env, batch_size: u32) -> Result<ResolutionState, ArenaError> {
        require_not_paused(&env)?;
        if batch_size < bounds::MIN_BATCH_SIZE || batch_size > bounds::MAX_BATCH_SIZE {
            return Err(ArenaError::InvalidAmount);
        }
        let round = get_round(&env)?;
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
        if env.storage().instance().has(&DataKey::Resolution) {
            return Err(ArenaError::BatchAlreadyInProgress);
        }

        let players = all_players(&env);
        let mut state = ResolutionState {
            round_number: round.round_number,
            total_players: players.len(),
            processed: 0,
            heads_count: 0,
            tails_count: 0,
        };
        process_tally_batch(&env, &mut state, &players, batch_size);
        env.storage().instance().set(&DataKey::Resolution, &state);
        Ok(state)
    }

    /// Tally the next `batch_size` players from a previously-started batch.
    /// Calling this once `processed == total_players` is a no-op and just
    /// returns the current state — it never errors mid-flight, so callers
    /// can safely retry.
    ///
    /// # Errors
    /// * [`ArenaError::Paused`] — contract is paused.
    /// * [`ArenaError::InvalidAmount`] — `batch_size` is zero or exceeds [`bounds::MAX_BATCH_SIZE`].
    /// * [`ArenaError::NoBatchInProgress`] — `start_resolution` hasn't run.
    pub fn continue_resolution(env: Env, batch_size: u32) -> Result<ResolutionState, ArenaError> {
        require_not_paused(&env)?;
        if batch_size < bounds::MIN_BATCH_SIZE || batch_size > bounds::MAX_BATCH_SIZE {
            return Err(ArenaError::InvalidAmount);
        }
        let mut state: ResolutionState = env
            .storage()
            .instance()
            .get(&DataKey::Resolution)
            .ok_or(ArenaError::NoBatchInProgress)?;
        if state.processed < state.total_players {
            let players = all_players(&env);
            process_tally_batch(&env, &mut state, &players, batch_size);
            env.storage().instance().set(&DataKey::Resolution, &state);
        }
        Ok(state)
    }

    /// Apply eliminations using the completed batched tally and clear the
    /// batch state. Mirrors the bookkeeping at the tail end of
    /// `resolve_round`.
    ///
    /// # Errors
    /// * [`ArenaError::Paused`] — contract is paused.
    /// * [`ArenaError::NoBatchInProgress`] — no batch state to finalise.
    /// * [`ArenaError::BatchNotComplete`] — `processed < total_players`.
    pub fn finalize_resolution(env: Env) -> Result<RoundState, ArenaError> {
        require_not_paused(&env)?;
        let state: ResolutionState = env
            .storage()
            .instance()
            .get(&DataKey::Resolution)
            .ok_or(ArenaError::NoBatchInProgress)?;
        if state.processed < state.total_players {
            return Err(ArenaError::BatchNotComplete);
        }

        let mut round = get_round(&env)?;
        let resolution_outcome =
            choose_resolution_outcome(&env, state.heads_count, state.tails_count);
        emit_tiebreaker_used_if_needed(
            &env,
            state.round_number,
            state.heads_count,
            state.tails_count,
            resolution_outcome,
        );

        let players = all_players(&env);
        let mut survivor_count = 0u32;
        let mut eliminated_count = 0u32;
        for player in players.iter() {
            let survivor_key = DataKey::Survivor(player.clone());
            if !env.storage().persistent().has(&survivor_key) {
                continue;
            }
            let player_choice = env.storage().persistent().get(&DataKey::Choices(
                0,
                state.round_number,
                player.clone(),
            ));
            let survives = player_survives(resolution_outcome, player_choice);
            if survives {
                survivor_count += 1;
            } else {
                env.storage().persistent().remove(&survivor_key);
                env.storage()
                    .persistent()
                    .set(&DataKey::Eliminated(player.clone()), &true);
                env.storage()
                    .persistent()
                    .set(&DataKey::ElimRound(player.clone()), &state.round_number);
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
        env.storage().instance().remove(&DataKey::Resolution);
        env.events().publish(
            (TOPIC_ROUND_RESOLVED,),
            (
                round.round_number,
                state.heads_count,
                state.tails_count,
                eliminated_count,
            ),
        );
        Ok(round)
    }

    /// Read the current batched-resolution state, or `None` if no batch is in
    /// flight. Read-only — useful for the frontend to decide whether to call
    /// `continue_resolution` or `finalize_resolution`.
    pub fn pending_resolution(env: Env) -> Option<ResolutionState> {
        env.storage().instance().get(&DataKey::Resolution)
    }

    pub fn set_winner(
        env: Env,
        player: Address,
        principal_pool: i128,
        yield_earned: i128,
    ) -> Result<(), ArenaError> {
        let admin = Self::admin(env.clone());
        admin.require_auth();
        apply_winner_distribution(&env, player, principal_pool, yield_earned)
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

    pub fn cancel_arena(env: Env, caller: Address) -> Result<(), ArenaError> {
        caller.require_auth();
        require_not_paused(&env)?;
        if Self::is_cancelled(env.clone()) {
            return Err(ArenaError::AlreadyCancelled);
        }
        let admin = Self::admin(env.clone());
        let host: Option<Address> = env.storage().instance().get(&CREATOR_KEY);
        let is_admin = caller == admin;
        let is_host = host.as_ref().map_or(false, |h| h == &caller);
        if !is_admin && !is_host {
            return Err(ArenaError::Unauthorized);
        }
        // Host can only cancel while the arena is still pending (not yet started).
        if is_host && !is_admin && state(&env) != ArenaState::Pending {
            return Err(ArenaError::Unauthorized);
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
        require_not_paused(&env)?;
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
        require_not_paused(&env)?;
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
        let cache = ArenaCache::load(&env)?;
        Ok(cache.arena_state_view())
    }

    pub fn get_user_state(env: Env, player: Address) -> UserStateView {
        PlayerCache::load(&env, &player).user_state_view()
    }

    pub fn get_player_state(env: Env, player: Address) -> PlayerSnapshot {
        let persistent = env.storage().persistent();
        let is_survivor = persistent.has(&DataKey::Survivor(player.clone()));
        let is_winner = persistent.has(&DataKey::Winner(player.clone()));
        let is_eliminated = persistent.has(&DataKey::Eliminated(player.clone()));
        if !is_survivor && !is_winner && !is_eliminated {
            panic_with_error!(&env, ArenaError::Unauthorized);
        }

        let status = if is_winner {
            PlayerStatus::Winner
        } else if is_survivor {
            PlayerStatus::Active
        } else {
            PlayerStatus::Elim
        };

        let round =
            get_round(&env).unwrap_or_else(|_| panic_with_error!(&env, ArenaError::NotInitialized));
        let eliminated_round: Option<u32> = persistent.get(&DataKey::ElimRound(player.clone()));
        let reveal_choice = !round.active || env.ledger().sequence() > round.round_deadline_ledger;
        let choice_this_round: Option<Choice> = if reveal_choice && round.round_number > 0 {
            persistent.get(&DataKey::Choices(0, round.round_number, player.clone()))
        } else {
            None
        };

        let total_rounds_survived = match status {
            PlayerStatus::Winner => round.round_number,
            PlayerStatus::Elim => eliminated_round
                .unwrap_or(round.round_number)
                .saturating_sub(1),
            PlayerStatus::Active => {
                if round.round_number == 0 {
                    0
                } else if round.active {
                    round.round_number - 1
                } else {
                    round.round_number
                }
            }
        };

        PlayerSnapshot {
            player,
            status,
            eliminated_round,
            choice_this_round: choice_this_round.map(|c| match c {
                Choice::Heads => 0,
                Choice::Tails => 1,
            }),
            total_rounds_survived,
        }
    }

    pub fn get_full_state(env: Env, player: Address) -> Result<FullStateView, ArenaError> {
        let cache = ArenaCache::load(&env)?;
        let player_cache = PlayerCache::load(&env, &player);
        Ok(cache.full_state_view(&player_cache))
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
            is_private: false,
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
        propose_upgrade_flow(
            &env,
            UpgradeKeys {
                pending_hash: &PENDING_HASH_KEY,
                execute_after: &EXECUTE_AFTER_KEY,
            },
            UpgradeTopics {
                proposed: &TOPIC_UPGRADE_PROPOSED,
                executed: &TOPIC_UPGRADE_EXECUTED,
                cancelled: &TOPIC_UPGRADE_CANCELLED,
            },
            EVENT_VERSION,
            TIMELOCK_PERIOD,
            &new_wasm_hash,
            ArenaError::UpgradeAlreadyPending,
        )
    }

    pub fn execute_upgrade(env: Env, expected_hash: BytesN<32>) -> Result<(), ArenaError> {
        let admin: Address = env
            .storage()
            .instance()
            .get(&ADMIN_KEY)
            .ok_or(ArenaError::NotInitialized)?;
        admin.require_auth();
        let stored_hash = execute_upgrade_flow(
            &env,
            UpgradeKeys {
                pending_hash: &PENDING_HASH_KEY,
                execute_after: &EXECUTE_AFTER_KEY,
            },
            UpgradeTopics {
                proposed: &TOPIC_UPGRADE_PROPOSED,
                executed: &TOPIC_UPGRADE_EXECUTED,
                cancelled: &TOPIC_UPGRADE_CANCELLED,
            },
            EVENT_VERSION,
            &expected_hash,
            UpgradeErrors {
                no_pending: ArenaError::NoPendingUpgrade,
                timelock_not_expired: ArenaError::TimelockNotExpired,
                hash_mismatch: ArenaError::HashMismatch,
                malformed_state: None,
            },
            ExecuteTimePolicy::StrictlyAfter,
        )?;
        env.deployer().update_current_contract_wasm(stored_hash);
        Ok(())
    }

    pub fn cancel_upgrade(env: Env) -> Result<(), ArenaError> {
        let admin = Self::admin(env.clone());
        admin.require_auth();
        cancel_upgrade_flow(
            &env,
            UpgradeKeys {
                pending_hash: &PENDING_HASH_KEY,
                execute_after: &EXECUTE_AFTER_KEY,
            },
            UpgradeTopics {
                proposed: &TOPIC_UPGRADE_PROPOSED,
                executed: &TOPIC_UPGRADE_EXECUTED,
                cancelled: &TOPIC_UPGRADE_CANCELLED,
            },
            EVENT_VERSION,
            ArenaError::NoPendingUpgrade,
        )
    }

    pub fn pending_upgrade(env: Env) -> Option<(BytesN<32>, u64)> {
        pending_upgrade_flow(
            &env,
            UpgradeKeys {
                pending_hash: &PENDING_HASH_KEY,
                execute_after: &EXECUTE_AFTER_KEY,
            },
        )
    }

    pub fn state(env: Env) -> ArenaState {
        state(&env)
    }

    // ── Vault management (issue #464) ─────────────────────────────────────────

    /// Set the primary RWA yield vault address. Admin-only.
    /// Can only be changed before the first deposit is made.
    pub fn set_vault(env: Env, vault: Address) -> Result<(), ArenaError> {
        let admin = Self::admin(env.clone());
        admin.require_auth();
        if env.storage().instance().has(&VAULT_SHARES_KEY) {
            return Err(ArenaError::TokenConfigurationLocked);
        }
        env.storage().instance().set(&VAULT_ADDR_KEY, &vault);
        Ok(())
    }

    /// Set the fallback vault address. Admin-only.
    /// Used when the primary vault is unavailable.
    pub fn set_fallback_vault(env: Env, fallback: Address) -> Result<(), ArenaError> {
        let admin = Self::admin(env.clone());
        admin.require_auth();
        env.storage().instance().set(&FALLBACK_VAULT_KEY, &fallback);
        Ok(())
    }

    /// Toggle whether the vault integration is active. Admin-only.
    /// Setting `active = false` activates the fallback (hold funds in contract).
    /// Emits `VaultFallbackActivated` when switching to fallback mode.
    pub fn toggle_vault_active(env: Env, active: bool) -> Result<(), ArenaError> {
        let admin = Self::admin(env.clone());
        admin.require_auth();
        if !active {
            let arena_id: u64 = env.storage().instance().get(&DataKey::ArenaId).unwrap_or(0);
            env.events().publish(
                (TOPIC_VAULT_FALLBACK,),
                VaultFallbackActivated {
                    arena_id,
                    reason: String::from_str(&env, "admin_toggled"),
                },
            );
        }
        env.storage().instance().set(&VAULT_ACTIVE_KEY, &active);
        Ok(())
    }

    /// Deposit the entire prize pool into the primary vault. Admin-only.
    /// Stores the returned shares for later withdrawal.
    /// Vault interface expected: `deposit(token: Address, amount: i128) -> i128`.
    pub fn deposit_to_vault(env: Env) -> Result<i128, ArenaError> {
        let admin = Self::admin(env.clone());
        admin.require_auth();
        let vault_addr: Address = env
            .storage()
            .instance()
            .get(&VAULT_ADDR_KEY)
            .ok_or(ArenaError::VaultNotSet)?;
        let vault_active: bool = env
            .storage()
            .instance()
            .get(&VAULT_ACTIVE_KEY)
            .unwrap_or(false);
        if !vault_active {
            return Err(ArenaError::VaultNotSet);
        }
        if env.storage().instance().has(&VAULT_SHARES_KEY) {
            return Err(ArenaError::TokenConfigurationLocked);
        }
        let token_addr: Address = env
            .storage()
            .instance()
            .get(&TOKEN_KEY)
            .ok_or(ArenaError::TokenNotSet)?;
        let prize_pool: i128 = env.storage().instance().get(&PRIZE_POOL_KEY).unwrap_or(0);
        if prize_pool <= 0 {
            return Err(ArenaError::InvalidAmount);
        }
        token::Client::new(&env, &token_addr).transfer(
            &env.current_contract_address(),
            &vault_addr,
            &prize_pool,
        );
        let shares: i128 = env.invoke_contract(
            &vault_addr,
            &soroban_sdk::Symbol::new(&env, "deposit"),
            soroban_sdk::vec![&env, token_addr.into_val(&env), prize_pool.into_val(&env)],
        );
        env.storage().instance().set(&VAULT_SHARES_KEY, &shares);
        env.storage()
            .instance()
            .set(&VAULT_DEPOSITED_KEY, &prize_pool);
        Ok(shares)
    }

    // ── Yield withdrawal and prize pool augmentation (issue #462) ─────────────

    /// Withdraw vault shares and declare the winner, augmenting the prize pool
    /// with any yield earned since deposit.
    ///
    /// Flow:
    /// 1. Withdraw `shares` from the vault → `principal + yield`.
    /// 2. Compute `yield_earned = total_received - total_deposited`.
    /// 3. Emit `YieldHarvested` event.
    /// 4. Call `set_winner` with the computed amounts.
    ///
    /// If vault is inactive or no deposit was made, falls back to awarding
    /// the on-hand principal with zero yield, so winner payout is never blocked.
    pub fn complete_with_yield(env: Env, winner: Address) -> Result<(), ArenaError> {
        let admin = Self::admin(env.clone());
        admin.require_auth();
        if env.storage().instance().has(&WINNER_ADDR_KEY) {
            return Err(ArenaError::WinnerAlreadySet);
        }
        let vault_active: bool = env
            .storage()
            .instance()
            .get(&VAULT_ACTIVE_KEY)
            .unwrap_or(false);
        let has_shares = env.storage().instance().has(&VAULT_SHARES_KEY);
        let deposited: i128 = env
            .storage()
            .instance()
            .get(&VAULT_DEPOSITED_KEY)
            .unwrap_or(0);
        let (principal, yield_earned) = if vault_active && has_shares {
            let vault_addr: Address = env
                .storage()
                .instance()
                .get(&VAULT_ADDR_KEY)
                .ok_or(ArenaError::VaultNotSet)?;
            let shares: i128 = env.storage().instance().get(&VAULT_SHARES_KEY).unwrap_or(0);
            // Vault interface: withdraw(shares: i128) -> i128 (tokens returned)
            let total_received: i128 = env.invoke_contract(
                &vault_addr,
                &soroban_sdk::Symbol::new(&env, "withdraw"),
                soroban_sdk::vec![&env, shares.into_val(&env)],
            );
            let y = (total_received - deposited).max(0);
            (total_received - y, y)
        } else {
            let prize_pool: i128 = env.storage().instance().get(&PRIZE_POOL_KEY).unwrap_or(0);
            (prize_pool, 0)
        };
        let arena_id: u64 = env.storage().instance().get(&DataKey::ArenaId).unwrap_or(0);
        env.events().publish(
            (TOPIC_YIELD_HARVESTED,),
            YieldHarvested {
                arena_id,
                yield_earned,
                final_prize_pool: principal + yield_earned,
            },
        );
        apply_winner_distribution(&env, winner, principal, yield_earned)
    }

    // ── Two-step admin transfer (issue #466) ──────────────────────────────────

    /// Propose a new admin. The pending admin has 7 days to accept.
    /// Only the current admin can call this.
    pub fn propose_admin(env: Env, new_admin: Address) -> Result<(), ArenaError> {
        let admin = Self::admin(env.clone());
        admin.require_auth();
        let expires_at = propose_admin_transfer_flow(
            &env,
            AdminTransferKeys {
                admin: &ADMIN_KEY,
                pending_admin: &PENDING_ADMIN_KEY,
                admin_expiry: &ADMIN_EXPIRY_KEY,
            },
            &new_admin,
            ADMIN_TRANSFER_EXPIRY,
        );
        env.events().publish(
            (TOPIC_ADMIN_PROPOSED,),
            AdminTransferProposed {
                current_admin: admin,
                pending_admin: new_admin,
                expires_at,
            },
        );
        Ok(())
    }

    /// Accept an admin transfer. Must be called by the pending admin within 7 days.
    pub fn accept_admin(env: Env, new_admin: Address) -> Result<(), ArenaError> {
        new_admin.require_auth();
        let old_admin = Self::admin(env.clone());
        accept_admin_transfer_flow(
            &env,
            AdminTransferKeys {
                admin: &ADMIN_KEY,
                pending_admin: &PENDING_ADMIN_KEY,
                admin_expiry: &ADMIN_EXPIRY_KEY,
            },
            &new_admin,
            AdminTransferErrors {
                no_pending: ArenaError::NoPendingAdminTransfer,
                unauthorized: ArenaError::Unauthorized,
                expired: ArenaError::AdminTransferExpired,
            },
        )?;
        env.events().publish(
            (TOPIC_ADMIN_ACCEPTED,),
            AdminTransferCompleted {
                old_admin,
                new_admin,
            },
        );
        Ok(())
    }

    /// Cancel a pending admin transfer. Only the current admin can call this.
    pub fn cancel_admin_transfer(env: Env) -> Result<(), ArenaError> {
        let admin = Self::admin(env.clone());
        admin.require_auth();
        cancel_admin_transfer_flow(
            &env,
            AdminTransferKeys {
                admin: &ADMIN_KEY,
                pending_admin: &PENDING_ADMIN_KEY,
                admin_expiry: &ADMIN_EXPIRY_KEY,
            },
            ArenaError::NoPendingAdminTransfer,
        )?;
        env.events().publish((TOPIC_ADMIN_CANCELLED,), ());
        Ok(())
    }

    /// Return the pending admin address and expiry timestamp, or `None` if no transfer is pending.
    pub fn pending_admin_transfer(env: Env) -> Option<(Address, u64)> {
        pending_admin_transfer_flow(
            &env,
            AdminTransferKeys {
                admin: &ADMIN_KEY,
                pending_admin: &PENDING_ADMIN_KEY,
                admin_expiry: &ADMIN_EXPIRY_KEY,
            },
        )
    }
}

/// Shared winner-distribution logic used by both `set_winner` and `complete_with_yield`.
fn apply_winner_distribution(
    env: &Env,
    player: Address,
    principal_pool: i128,
    yield_earned: i128,
) -> Result<(), ArenaError> {
    if env.storage().instance().has(&WINNER_ADDR_KEY) {
        return Err(ArenaError::WinnerAlreadySet);
    }
    if principal_pool < 0 || yield_earned < 0 {
        return Err(ArenaError::InvalidAmount);
    }
    let config = get_config(env)?;
    let winner_yield = yield_earned
        .checked_mul(config.winner_yield_share_bps as i128)
        .and_then(|v| v.checked_div(BPS_DENOMINATOR))
        .ok_or(ArenaError::InvalidAmount)?;
    let eliminated_yield = yield_earned
        .checked_sub(winner_yield)
        .ok_or(ArenaError::InvalidAmount)?;
    let eliminated = eliminated_players(env);
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
    let arena_id: u64 = env.storage().instance().get(&DataKey::ArenaId).unwrap_or(0);
    env.events().publish(
        (TOPIC_YIELD_DISTRIBUTED,),
        YieldDistributed {
            winner_yield,
            eliminated_yield,
            eliminated_count,
        },
    );
    env.events().publish(
        (TOPIC_WINNER_DECLARED,),
        WinnerDeclared {
            arena_id,
            winner: player,
            prize_pool: principal_pool,
            yield_earned,
            total_rounds: env
                .storage()
                .instance()
                .get::<_, RoundState>(&DataKey::Round)
                .map(|r| r.round_number)
                .unwrap_or(0),
        },
    );
    Ok(())
}

/// Per-call snapshot of the arena's instance-storage fields.
///
/// Read-only entrypoints (`get_arena_state`, `get_full_state`) used to reach
/// into instance storage independently and re-issue overlapping reads — most
/// notably `PRIZE_POOL_KEY` was loaded twice inside `get_arena_state` itself.
/// Loading once into this struct guarantees each ledger key is read at most
/// once per public invocation, lowering simulation cost (issue #481).
///
/// Not a `#[contracttype]` — purely an in-memory cache, never persisted.
struct ArenaCache {
    round: RoundState,
    survivor_count: u32,
    max_capacity: u32,
    prize_pool: i128,
    vault_active: bool,
}

impl ArenaCache {
    fn load(env: &Env) -> Result<Self, ArenaError> {
        let storage = env.storage().instance();
        let round: RoundState = storage
            .get(&DataKey::Round)
            .ok_or(ArenaError::NotInitialized)?;
        let survivor_count: u32 = storage.get(&SURVIVOR_COUNT_KEY).unwrap_or(0);
        let max_capacity: u32 = storage
            .get(&CAPACITY_KEY)
            .unwrap_or(bounds::MAX_ARENA_PARTICIPANTS);
        let prize_pool: i128 = storage.get(&PRIZE_POOL_KEY).unwrap_or(0);
        let vault_active: bool = storage.get(&VAULT_ACTIVE_KEY).unwrap_or(false);
        Ok(Self {
            round,
            survivor_count,
            max_capacity,
            prize_pool,
            vault_active,
        })
    }

    fn arena_state_view(&self) -> ArenaStateView {
        ArenaStateView {
            survivors_count: self.survivor_count,
            max_capacity: self.max_capacity,
            round_number: self.round.round_number,
            current_stake: self.prize_pool,
            potential_payout: self.prize_pool,
            vault_active: self.vault_active,
        }
    }

    fn full_state_view(&self, player: &PlayerCache) -> FullStateView {
        FullStateView {
            survivors_count: self.survivor_count,
            max_capacity: self.max_capacity,
            round_number: self.round.round_number,
            current_stake: self.prize_pool,
            potential_payout: self.prize_pool,
            is_active: player.is_active,
            has_won: player.has_won,
            vault_active: self.vault_active,
        }
    }
}

/// Per-call snapshot of one player's persistent flags. Mirrors `ArenaCache`
/// for player-scoped reads so `get_full_state` makes each persistent lookup
/// at most once.
struct PlayerCache {
    is_active: bool,
    has_won: bool,
}

impl PlayerCache {
    fn load(env: &Env, player: &Address) -> Self {
        let persistent = env.storage().persistent();
        let is_active = persistent.has(&DataKey::Survivor(player.clone()));
        let has_won = persistent.has(&DataKey::Winner(player.clone()));
        Self { is_active, has_won }
    }

    fn user_state_view(&self) -> UserStateView {
        UserStateView {
            is_active: self.is_active,
            has_won: self.has_won,
        }
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

fn get_state(env: &Env) -> ArenaState {
    state(env)
}

fn set_state(env: &Env, new_state: ArenaState) {
    env.storage().instance().set(&STATE_KEY, &new_state);
}

fn activate_arena_internal(
    env: &Env,
    arena_id: u64,
    round_number: u32,
    round_speed_in_ledgers: u32,
) -> Result<RoundState, ArenaError> {
    if state(env) == ArenaState::Pending {
        auto_deposit_entry_fees(env, arena_id)?;
    }

    let start = env.ledger().sequence();
    let deadline = start
        .checked_add(round_speed_in_ledgers)
        .ok_or(ArenaError::RoundDeadlineOverflow)?;
    let round = RoundState {
        round_number,
        round_start_ledger: start,
        round_deadline_ledger: deadline,
        active: true,
        total_submissions: 0,
        timed_out: false,
        finished: false,
    };
    env.storage().instance().set(&DataKey::Round, &round);
    set_state(env, ArenaState::Active);
    Ok(round)
}

fn auto_deposit_entry_fees(env: &Env, arena_id: u64) -> Result<(), ArenaError> {
    if env.storage().instance().has(&VAULT_SHARES_KEY) {
        return Ok(());
    }

    let vault_active: bool = env
        .storage()
        .instance()
        .get(&VAULT_ACTIVE_KEY)
        .unwrap_or(false);
    if !vault_active {
        return Ok(());
    }

    let vault_addr: Address = env
        .storage()
        .instance()
        .get(&VAULT_ADDR_KEY)
        .ok_or(ArenaError::VaultNotSet)?;
    let token_addr: Address = env
        .storage()
        .instance()
        .get(&TOKEN_KEY)
        .ok_or(ArenaError::TokenNotSet)?;
    let config = get_config(env)?;
    let player_count: i128 = env
        .storage()
        .instance()
        .get::<_, u32>(&SURVIVOR_COUNT_KEY)
        .unwrap_or(0) as i128;
    if player_count <= 0 {
        return Ok(());
    }

    let total_depositable = config
        .required_stake_amount
        .checked_mul(player_count)
        .ok_or(ArenaError::InvalidAmount)?;
    let reserve_amount = total_depositable
        .checked_mul(config.reserve_ratio_bps as i128)
        .and_then(|v: i128| v.checked_div(BPS_DENOMINATOR))
        .ok_or(ArenaError::InvalidAmount)?;
    let deposit_amount = total_depositable.saturating_sub(reserve_amount);
    if deposit_amount <= 0 {
        return Ok(());
    }

    token::Client::new(env, &token_addr).transfer(
        &env.current_contract_address(),
        &vault_addr,
        &deposit_amount,
    );
    let shares: i128 = env.invoke_contract(
        &vault_addr,
        &soroban_sdk::Symbol::new(env, "deposit"),
        soroban_sdk::vec![env, token_addr.into_val(env), deposit_amount.into_val(env)],
    );

    env.storage().instance().set(&VAULT_SHARES_KEY, &shares);
    env.storage()
        .instance()
        .set(&VAULT_DEPOSITED_KEY, &deposit_amount);
    env.storage()
        .instance()
        .set(&PRIZE_POOL_KEY, &reserve_amount);
    env.events().publish(
        (TOPIC_FUNDS_DEPOSITED,),
        FundsDeposited {
            arena_id,
            amount: deposit_amount,
            shares,
            vault_address: vault_addr,
        },
    );
    Ok(())
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

/// Tally up to `batch_size` players starting at `state.processed`, advancing
/// the cursor and accumulating heads/tails counts in-place. Players that are
/// not in the survivor set or have no recorded choice are skipped but still
/// counted toward `processed`, so the cursor walks every entry in
/// `all_players` exactly once across the entire batch flow.
fn process_tally_batch(
    env: &Env,
    state: &mut ResolutionState,
    players: &Vec<Address>,
    batch_size: u32,
) {
    let end = state
        .processed
        .saturating_add(batch_size)
        .min(state.total_players);
    for i in state.processed..end {
        if let Some(player) = players.get(i) {
            if is_active_survivor(env, &player) {
                match env.storage().persistent().get(&DataKey::Choices(
                    0,
                    state.round_number,
                    player,
                )) {
                    Some(Choice::Heads) => state.heads_count += 1,
                    Some(Choice::Tails) => state.tails_count += 1,
                    None => {}
                }
            }
        }
    }
    state.processed = end;
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum ResolutionOutcome {
    AllSurvive,
    SurvivingChoice(Choice),
    AllEliminated,
}

fn choose_resolution_outcome(env: &Env, heads: u32, tails: u32) -> ResolutionOutcome {
    match (heads, tails) {
        // No submissions leave the arena unchanged so a keeper/admin can
        // continue the game instead of forcing an artificial elimination.
        (0, 0) => ResolutionOutcome::AllSurvive,
        // If everyone piled onto the same side there is no meaningful
        // minority. Treat it as a draw and eliminate the whole field.
        (0, _) | (_, 0) => ResolutionOutcome::AllEliminated,
        _ if heads == tails => ResolutionOutcome::SurvivingChoice(tiebreaker(env)),
        _ if heads < tails => ResolutionOutcome::SurvivingChoice(Choice::Heads),
        _ => ResolutionOutcome::SurvivingChoice(Choice::Tails),
    }
}

/// Deterministic tiebreaker used only when Heads and Tails tallies are equal.
///
/// This is not cryptographic randomness. It's acceptable here because both
/// sides already have equal support and this only selects one of two
/// symmetric outcomes.
fn tiebreaker(env: &Env) -> Choice {
    if env.ledger().sequence() % 2 == 0 {
        Choice::Heads
    } else {
        Choice::Tails
    }
}

fn emit_tiebreaker_used_if_needed(
    env: &Env,
    round: u32,
    heads: u32,
    tails: u32,
    outcome: ResolutionOutcome,
) {
    if heads == 0 || heads != tails {
        return;
    }
    if let ResolutionOutcome::SurvivingChoice(winning_side) = outcome {
        let arena_id: u64 = env.storage().instance().get(&DataKey::ArenaId).unwrap_or(0);
        env.events().publish(
            (TOPIC_TIEBREAKER_USED,),
            TiebreakerUsed {
                arena_id,
                round,
                sequence: env.ledger().sequence(),
                winning_side,
            },
        );
    }
}

fn player_survives(outcome: ResolutionOutcome, player_choice: Option<Choice>) -> bool {
    match outcome {
        ResolutionOutcome::AllSurvive => true,
        ResolutionOutcome::AllEliminated => false,
        ResolutionOutcome::SurvivingChoice(choice) => player_choice == Some(choice),
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

/// O(1) survivor membership check via a single ledger key lookup.
fn is_active_survivor(env: &Env, player: &Address) -> bool {
    env.storage()
        .persistent()
        .has(&DataKey::Survivor(player.clone()))
}

fn grace_period_to_ledgers(grace_period_seconds: u64) -> u32 {
    // Approximate Stellar ledger close to 5 seconds per ledger.
    ((grace_period_seconds + 4) / 5) as u32
}

mod rwa;

#[cfg(test)]
mod abi_guard;

#[cfg(test)]
mod yield_share_tests {
    use super::*;
    use soroban_sdk::{IntoVal, testutils::Address as _, token::StellarAssetClient};

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

        client.set_token(&token_id);
        client.init(&10u32, &100i128, &0u64);
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
    let all_players: Vec<Address> = env
        .storage()
        .persistent()
        .get(&DataKey::AllPlayers)
        .unwrap_or(Vec::new(env));
    let mut survivors = Vec::new(env);
    for p in all_players.iter() {
        if env
            .storage()
            .persistent()
            .has(&DataKey::Survivor(p.clone()))
        {
            survivors.push_back(p);
        }
    }
    survivors
}

fn get_eliminated(env: &Env) -> Vec<Address> {
    let all_players: Vec<Address> = env
        .storage()
        .persistent()
        .get(&DataKey::AllPlayers)
        .unwrap_or(Vec::new(env));
    let mut eliminated = Vec::new(env);
    for p in all_players.iter() {
        if env
            .storage()
            .persistent()
            .has(&DataKey::Eliminated(p.clone()))
        {
            eliminated.push_back(p);
        }
    }
    eliminated
}

#[cfg(test)]
mod commit_reveal_tests;
#[cfg(test)]
mod expire_arena_tests;
#[cfg(test)]
mod mutation_tests;
#[cfg(test)]
mod snapshot_test;
#[cfg(test)]
mod state_machine_tests;
#[cfg(test)]
mod test;
