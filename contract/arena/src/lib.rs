#![no_std]

use soroban_sdk::{
    Address, BytesN, Env, Symbol, contract, contracterror, contractimpl, contracttype,
    symbol_short, token::{self, Client as TokenClient},
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
// ── Timelock constant: 48 hours in seconds ────────────────────────────────────

const TIMELOCK_PERIOD: u64 = 48 * 60 * 60;

// ── TTL constants (ledgers; mainnet ≈ 5 s/ledger) ────────────────────────────
// Bump entries when remaining TTL falls below ~5.8 days; extend to ~31 days.
// This ensures game state survives the maximum possible round duration.
const GAME_TTL_THRESHOLD: u32 = 100_000; // ~5.8 days
const GAME_TTL_EXTEND_TO: u32 = 535_680; // ~31 days

// ── Event topics ──────────────────────────────────────────────────────────────

const TOPIC_UPGRADE_PROPOSED: Symbol = symbol_short!("UP_PROP");
const TOPIC_UPGRADE_EXECUTED: Symbol = symbol_short!("UP_EXEC");
const TOPIC_UPGRADE_CANCELLED: Symbol = symbol_short!("UP_CANC");
const TOPIC_PAUSED: Symbol = symbol_short!("PAUSED");
const TOPIC_UNPAUSED: Symbol = symbol_short!("UNPAUSED");
const TOPIC_GAME_ENDED: Symbol = symbol_short!("G_END");

/// Event payload version. Include in every event data tuple so consumers
/// can detect schema changes without re-deploying indexers.
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
}

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
}

/// Aggregate view of arena state returned by `get_arena_state`.
///
/// Serialised by Soroban as `ScvMap { ScvSymbol(field) → value }`, which
/// matches the symbol-keyed parsing in the frontend's `stellar-scval-extract.ts`.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ArenaState {
    pub survivors_count: u32,
    pub max_capacity: u32,
    pub round_number: u32,
    pub current_stake: i128,
    pub potential_payout: i128,
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
#[derive(Clone)]
enum DataKey {
    Config,
    Round,
    Submission(u32, Address),
    Survivor(Address),
    /// Soroban token contract used for stake + yield payouts (`claim`).
    Token,
    /// Per-player payout record set by admin (`set_winner`) before `claim`.
    Winner(Address),
    /// Whether this address has already successfully `claim`ed.
    Claimed(Address),
}

// ── Contract ──────────────────────────────────────────────────────────────────

#[contract]
pub struct ArenaContract;

#[contractimpl]
impl ArenaContract {
    // ── Initialisation ───────────────────────────────────────────────────────

    /// Initialise the arena contract. Must be called exactly once after deployment.
    ///
    /// # Arguments
    /// * `env` - The Soroban environment.
    /// * `round_speed_in_ledgers` - Number of ledgers each round lasts. Must be > 0.
    ///
    /// # Errors
    /// * [`ArenaError::AlreadyInitialized`] — Contract has already been initialised.
    /// * [`ArenaError::InvalidRoundSpeed`] — `round_speed_in_ledgers` is zero.
    ///
    /// # Authorization
    /// None — permissionless; caller is responsible for calling immediately after deploy.
    pub fn init(env: Env, round_speed_in_ledgers: u32) -> Result<(), ArenaError> {
        if storage(&env).has(&DataKey::Config) {
            return Err(ArenaError::AlreadyInitialized);
        }

        if round_speed_in_ledgers == 0 {
            return Err(ArenaError::InvalidRoundSpeed);
        }

        env.storage()
            .instance()
            .extend_ttl(GAME_TTL_THRESHOLD, GAME_TTL_EXTEND_TO);

        storage(&env).set(
            &DataKey::Config,
            &ArenaConfig {
                round_speed_in_ledgers,
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

    // ── Token and Payouts ────────────────────────────────────────────────────

    pub fn set_token(env: Env, token: Address) {
        require_not_paused(&env).unwrap();
        let admin: Address = env
            .storage()
            .instance()
            .get(&ADMIN_KEY)
            .expect("not initialized");
        admin.require_auth();
        env.storage().instance().set(&TOKEN_KEY, &token);
    }

    pub fn set_winner(env: Env, player: Address, stake: i128, yield_comp: i128) {
        require_not_paused(&env).unwrap();
        let admin: Address = env
            .storage()
            .instance()
            .get(&ADMIN_KEY)
            .expect("not initialized");
        admin.require_auth();
        storage(&env).set(&DataKey::Winner(player.clone()), &(stake, yield_comp));
        bump(&env, &DataKey::Winner(player));
    }

    pub fn claim(env: Env, player: Address) -> Result<(), ArenaError> {
        require_not_paused(&env)?;
        env.storage()
            .instance()
            .extend_ttl(GAME_TTL_THRESHOLD, GAME_TTL_EXTEND_TO);
        player.require_auth();

        if storage(&env).has(&DataKey::Claimed(player.clone())) {
            return Err(ArenaError::AlreadyClaimed);
        }

        let winner_data: Option<(i128, i128)> = storage(&env).get(&DataKey::Winner(player.clone()));
        match winner_data {
            Some((stake, yield_comp)) => {
                // Effects: Mark as claimed and remove winner record BEFORE interaction.
                storage(&env).set(&DataKey::Claimed(player.clone()), &true);
                bump(&env, &DataKey::Claimed(player.clone()));
                storage(&env).remove(&DataKey::Winner(player.clone()));

                let mut round = get_round(&env)?;
                round.finished = true;
                storage(&env).set(&DataKey::Round, &round);
                bump(&env, &DataKey::Round);

                // Interactions: Perform the transfer.
                let token: Address = env
                    .storage()
                    .instance()
                    .get(&TOKEN_KEY)
                    .expect("token not set");
                let token_client = token::Client::new(&env, &token);

                let total_payout = stake + yield_comp;
                token_client.transfer(&env.current_contract_address(), &player, &total_payout);

                Ok(())
            }
            None => Err(ArenaError::NoPrizeToClaim),
        }
    }

    // ── Admin ────────────────────────────────────────────────────────────────

    /// Set the admin address. Must be called once after deployment before any
    /// upgrade functions can be used.
    ///
    /// # Arguments
    /// * `env` - The Soroban environment.
    /// * `admin` - Address to designate as the contract administrator.
    ///
    /// # Errors
    /// Panics with `"already initialized"` if an admin has already been set.
    ///
    /// # Authorization
    /// None — permissionless; must be called immediately after deploy.
    pub fn initialize(env: Env, admin: Address) {
        if env.storage().instance().has(&ADMIN_KEY) {
            panic!("already initialized");
        }
        env.storage().instance().set(&ADMIN_KEY, &admin);
    }

    /// Return the current admin address.
    ///
    /// # Arguments
    /// * `env` - The Soroban environment.
    ///
    /// # Errors
    /// Panics with `"not initialized"` if `initialize` has not been called.
    ///
    /// # Authorization
    /// None — read-only, open to any caller.
    pub fn admin(env: Env) -> Address {
        env.storage()
            .instance()
            .get(&ADMIN_KEY)
            .expect("not initialized")
    }

    /// Set a new admin address. Only the current admin can call this.
    pub fn set_admin(env: Env, new_admin: Address) {
        let admin: Address = env
            .storage()
            .instance()
            .get(&ADMIN_KEY)
            .expect("not initialized");
        admin.require_auth();
        env.storage().instance().set(&ADMIN_KEY, &new_admin);
    }

    /// Pause the contract. Admin-only.
    pub fn pause(env: Env) {
        let admin = Self::admin(env.clone());
        admin.require_auth();
        env.storage().instance().set(&PAUSED_KEY, &true);
        env.events().publish((TOPIC_PAUSED,), (EVENT_VERSION,));
    }

    /// Unpause the contract. Admin-only.
    pub fn unpause(env: Env) {
        let admin = Self::admin(env.clone());
        admin.require_auth();
        env.storage().instance().set(&PAUSED_KEY, &false);
        env.events().publish((TOPIC_UNPAUSED,), (EVENT_VERSION,));
    }

    /// Return whether the contract is paused.
    pub fn is_paused(env: Env) -> bool {
        env.storage().instance().get(&PAUSED_KEY).unwrap_or(false)
    }

    /// Set the maximum player capacity for this arena. Admin-only.
    ///
    /// # Authorization
    /// Requires admin signature.
    pub fn set_capacity(env: Env, capacity: u32) {
        let admin: Address = env
            .storage()
            .instance()
            .get(&ADMIN_KEY)
            .expect("not initialized");
        admin.require_auth();
        env.storage().instance().set(&CAPACITY_KEY, &capacity);
    }

    /// Return a snapshot of the arena's live state.
    ///
    /// Pure read — no storage writes, safe to call via simulation.
    /// Serialises as `ScvMap { Symbol → Val }` matching the frontend parser in
    /// `stellar-scval-extract.ts`.
    pub fn get_arena_state(env: Env) -> ArenaState {
        let survivors_count: u32 = env
            .storage()
            .instance()
            .get(&SURVIVOR_COUNT_KEY)
            .unwrap_or(0u32);
        let max_capacity: u32 = env
            .storage()
            .instance()
            .get(&CAPACITY_KEY)
            .unwrap_or(0u32);
        let round_number: u32 = storage(&env)
            .get::<_, RoundState>(&DataKey::Round)
            .map(|r| r.round_number)
            .unwrap_or(0u32);

        ArenaState {
            survivors_count,
            max_capacity,
            round_number,
            // The contract uses per-player Winner records rather than a global
            // prize pool, so these aggregate financials are not tracked on-chain.
            current_stake: 0,
            potential_payout: 0,
        }
    }

    pub fn join(env: Env, player: Address, amount: i128) -> Result<(), ArenaError> {
        player.require_auth();

        if amount <= 0 {
            return Err(ArenaError::InvalidAmount);
        }

        let survivor_key = DataKey::Survivor(player.clone());
        if storage(&env).has(&survivor_key) {
            return Err(ArenaError::AlreadyJoined);
        }

        // Token must be configured before players can join.
        let token: Address = env
            .storage()
            .instance()
            .get(&TOKEN_KEY)
            .ok_or(ArenaError::TokenNotSet)?;

        // Pull stake from player into this contract.
        token::Client::new(&env, &token).transfer(&player, &env.current_contract_address(), &amount);

        // Register survivor.
        storage(&env).set(&survivor_key, &());
        bump(&env, &survivor_key);

        // Increment survivor count.
        let count: u32 = env
            .storage()
            .instance()
            .get(&SURVIVOR_COUNT_KEY)
            .unwrap_or(0u32);
        env.storage()
            .instance()
            .set(&SURVIVOR_COUNT_KEY, &(count + 1));

        // Accumulate prize pool.
        let pool: i128 = env
            .storage()
            .instance()
            .get(&PRIZE_POOL_KEY)
            .unwrap_or(0i128);
        env.storage()
            .instance()
            .set(&PRIZE_POOL_KEY, &(pool + amount));

        Ok(())
    }

    // ── Round state machine ──────────────────────────────────────────────────

    /// Start a new round. Increments the round counter and opens the submission window.
    ///
    /// # Arguments
    /// * `env` - The Soroban environment.
    ///
    /// # Errors
    /// * [`ArenaError::NotInitialized`] — `initialize` has not been called.
    /// * [`ArenaError::RoundAlreadyActive`] — A round is currently in progress.
    /// * [`ArenaError::RoundDeadlineOverflow`] — Ledger sequence + round speed overflows `u32`.
    ///
    /// # Authorization
    /// None — any caller may start a round once the previous one has ended.
    ///
    /// # Events
    /// None emitted directly; callers should observe the returned [`RoundState`].
    pub fn start_round(env: Env) -> Result<RoundState, ArenaError> {
        require_not_paused(&env)?;
        env.storage()
            .instance()
            .extend_ttl(GAME_TTL_THRESHOLD, GAME_TTL_EXTEND_TO);

        let config = get_config(&env)?;
        let previous_round = get_round(&env)?;

        if previous_round.active {
            return Err(ArenaError::RoundAlreadyActive);
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

        storage(&env).set(&DataKey::Round, &next_round);
        bump(&env, &DataKey::Round);

        Ok(next_round)
    }

    /// Submit a player's choice for the active round.
    ///
    /// # Arguments
    /// * `env` - The Soroban environment.
    /// * `player` - Address of the player submitting a choice.
    /// * `choice` - [`Choice::Heads`] or [`Choice::Tails`].
    ///
    /// # Errors
    /// * [`ArenaError::NotInitialized`] — Contract not initialised.
    /// * [`ArenaError::NoActiveRound`] — No round is currently active.
    /// * [`ArenaError::SubmissionWindowClosed`] — Current ledger is past the round deadline.
    /// * [`ArenaError::SubmissionAlreadyExists`] — `player` already submitted in this round.
    ///
    /// # Authorization
    /// Requires `player.require_auth()` — the transaction must be signed by `player`.
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

        let mut round = get_round(&env)?;
        if !round.active {
            return Err(ArenaError::NoActiveRound);
        }

        if round_number != round.round_number {
            return Err(ArenaError::RoundDeadlineOverflow);
        }

        let current_ledger = env.ledger().sequence();
        if current_ledger > round.round_deadline_ledger {
            return Err(ArenaError::SubmissionWindowClosed);
        }

        let submission_key = DataKey::Submission(round.round_number, player);
        if storage(&env).has(&submission_key) {
            return Err(ArenaError::SubmissionAlreadyExists);
        }

        storage(&env).set(&submission_key, &choice);
        bump(&env, &submission_key);

        round.total_submissions += 1;
        storage(&env).set(&DataKey::Round, &round);
        bump(&env, &DataKey::Round);

        Ok(())
    }

    /// Mark the active round as timed-out once its deadline has passed.
    ///
    /// # Arguments
    /// * `env` - The Soroban environment.
    ///
    /// # Errors
    /// * [`ArenaError::NotInitialized`] — Contract not initialised.
    /// * [`ArenaError::NoActiveRound`] — No round is currently active.
    /// * [`ArenaError::RoundStillOpen`] — The round deadline has not yet been reached.
    ///
    /// # Authorization
    /// None — any caller may trigger a timeout once the deadline has passed.
    pub fn timeout_round(env: Env) -> Result<RoundState, ArenaError> {
        require_not_paused(&env)?;
        env.storage()
            .instance()
            .extend_ttl(GAME_TTL_THRESHOLD, GAME_TTL_EXTEND_TO);

        let mut round = get_round(&env)?;
        if !round.active {
            return Err(ArenaError::NoActiveRound);
        }

        let current_ledger = env.ledger().sequence();
        if current_ledger <= round.round_deadline_ledger {
            return Err(ArenaError::RoundStillOpen);
        }

        round.active = false;
        round.timed_out = true;
        storage(&env).set(&DataKey::Round, &round);
        bump(&env, &DataKey::Round);

        Ok(round)
    }

    /// Return the current [`ArenaConfig`].
    ///
    /// # Arguments
    /// * `env` - The Soroban environment.
    ///
    /// # Errors
    /// * [`ArenaError::NotInitialized`] — `initialize` has not been called.
    ///
    /// # Authorization
    /// None — read-only, open to any caller.
    pub fn get_config(env: Env) -> Result<ArenaConfig, ArenaError> {
        get_config(&env)
    }

    /// Return the current [`RoundState`].
    ///
    /// # Arguments
    /// * `env` - The Soroban environment.
    ///
    /// # Errors
    /// * [`ArenaError::NotInitialized`] — `initialize` has not been called.
    ///
    /// # Authorization
    /// None — read-only, open to any caller.
    pub fn get_round(env: Env) -> Result<RoundState, ArenaError> {
        get_round(&env)
    }

    /// Return the choice a player submitted for a given round, or `None` if they did not submit.
    ///
    /// # Arguments
    /// * `env` - The Soroban environment.
    /// * `round_number` - The round to query.
    /// * `player` - Address of the player to look up.
    ///
    /// # Authorization
    /// None — read-only, open to any caller.
    pub fn get_choice(env: Env, round_number: u32, player: Address) -> Option<Choice> {
        storage(&env).get(&DataKey::Submission(round_number, player))
    }

    // ── Upgrade mechanism ────────────────────────────────────────────────────

    // ── Emergency Pause Policy ───────────────────────────────────────────────
    //
    // Governance/upgrade functions (`propose_upgrade`, `execute_upgrade`,
    // `cancel_upgrade`) are EXEMPT from the global pause check.
    //
    // Rationale: A global pause is an emergency safety measure. If it also
    // blocked upgrade/recovery functions, a paused contract could become
    // permanently locked with no way out. Admin must always be able to propose,
    // execute, or cancel an upgrade — even while the contract is paused — so
    // that recovery or corrective upgrades remain possible.
    //
    // All other state-mutating functions (`start_round`, `submit_choice`,
    // `timeout_round`, `join`, `claim`) continue to require the contract to be
    // unpaused before proceeding.
    // ────────────────────────────────────────────────────────────────────────

    /// Propose a WASM upgrade. The new hash is stored together with the
    /// earliest timestamp at which `execute_upgrade` may be called (now + 48 h).
    ///
    /// # Arguments
    /// * `env` - The Soroban environment.
    /// * `new_wasm_hash` - 32-byte hash of the new contract WASM to deploy.
    ///
    /// # Errors
    /// Panics with `"not initialized"` if the contract has not been initialized.
    ///
    /// # Authorization
    /// Requires admin signature (`admin.require_auth()`).
    ///
    /// # Pause Policy
    /// **Exempt from pause.** This function may be called by the admin even when
    /// the contract is paused, allowing upgrade proposals during an emergency.
    ///
    /// # Events
    /// Emits `UpgradeProposed(new_wasm_hash, execute_after)`.
    pub fn propose_upgrade(env: Env, new_wasm_hash: BytesN<32>) {
        // NOTE: pause check intentionally omitted — governance functions are
        // exempt so that admin can always initiate a recovery upgrade.
        let admin: Address = env
            .storage()
            .instance()
            .get(&ADMIN_KEY)
            .expect("not initialized");
        admin.require_auth();

        let execute_after: u64 = env.ledger().timestamp() + TIMELOCK_PERIOD;
        env.storage()
            .instance()
            .set(&PENDING_HASH_KEY, &new_wasm_hash);
        env.storage()
            .instance()
            .set(&EXECUTE_AFTER_KEY, &execute_after);

        env.events()
            .publish((TOPIC_UPGRADE_PROPOSED,), (EVENT_VERSION, new_wasm_hash, execute_after));
    }

    /// Execute a previously proposed upgrade after the 48-hour timelock.
    ///
    /// # Arguments
    /// * `env` - The Soroban environment.
    ///
    /// # Errors
    /// Panics with `"not initialized"` if admin is not set.
    /// Panics with `"no pending upgrade"` if no proposal exists.
    /// Panics with `"timelock has not expired"` if called before the timelock elapses.
    ///
    /// # Authorization
    /// Requires admin signature (`admin.require_auth()`).
    ///
    /// # Pause Policy
    /// **Exempt from pause.** This function may be called by the admin even when
    /// the contract is paused, enabling deployment of a recovery upgrade.
    ///
    /// # Events
    /// Emits `UpgradeExecuted(new_wasm_hash)`.
    pub fn execute_upgrade(env: Env) {
        // NOTE: pause check intentionally omitted — see Emergency Pause Policy.
        let admin: Address = env
            .storage()
            .instance()
            .get(&ADMIN_KEY)
            .expect("not initialized");
        admin.require_auth();

        let execute_after: u64 = env
            .storage()
            .instance()
            .get(&EXECUTE_AFTER_KEY)
            .expect("no pending upgrade");

        if env.ledger().timestamp() < execute_after {
            panic!("timelock has not expired");
        }

        let new_wasm_hash: BytesN<32> = env
            .storage()
            .instance()
            .get(&PENDING_HASH_KEY)
            .expect("no pending upgrade");

        // Clear pending state before upgrading.
        env.storage().instance().remove(&PENDING_HASH_KEY);
        env.storage().instance().remove(&EXECUTE_AFTER_KEY);

        env.events()
            .publish((TOPIC_UPGRADE_EXECUTED,), (EVENT_VERSION, new_wasm_hash.clone()));

        env.deployer().update_current_contract_wasm(new_wasm_hash);
    }

    /// Cancel a pending upgrade proposal. Admin-only.
    ///
    /// # Arguments
    /// * `env` - The Soroban environment.
    ///
    /// # Errors
    /// Panics with `"not initialized"` if admin is not set.
    /// Panics with `"no pending upgrade to cancel"` if no proposal exists.
    ///
    /// # Authorization
    /// Requires admin signature (`admin.require_auth()`).
    ///
    /// # Pause Policy
    /// **Exempt from pause.** This function may be called by the admin even when
    /// the contract is paused, allowing cancellation of an incorrect proposal
    /// before executing a correct recovery upgrade.
    ///
    /// # Events
    /// Emits `UpgradeCancelled`.
    pub fn cancel_upgrade(env: Env) {
        // NOTE: pause check intentionally omitted — see Emergency Pause Policy.
        let admin: Address = env
            .storage()
            .instance()
            .get(&ADMIN_KEY)
            .expect("not initialized");
        admin.require_auth();

        if !env.storage().instance().has(&PENDING_HASH_KEY) {
            panic!("no pending upgrade to cancel");
        }

        env.storage().instance().remove(&PENDING_HASH_KEY);
        env.storage().instance().remove(&EXECUTE_AFTER_KEY);

        env.events().publish((TOPIC_UPGRADE_CANCELLED,), (EVENT_VERSION,));
    }

    /// Return the pending WASM hash and the earliest execution timestamp,
    /// or `None` if no upgrade has been proposed.
    ///
    /// # Arguments
    /// * `env` - The Soroban environment.
    ///
    /// # Authorization
    /// None — read-only, open to any caller.
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

fn bump(env: &Env, key: &DataKey) {
    env.storage()
        .persistent()
        .extend_ttl(key, GAME_TTL_THRESHOLD, GAME_TTL_EXTEND_TO);
}

#[cfg(test)]
mod test;

#[cfg(test)]
mod integration_tests;
