#![no_std]

use soroban_sdk::{
    contract, contracterror, contractimpl, contracttype, symbol_short, Address, BytesN, Env, Symbol,
};

// ── Storage keys ──────────────────────────────────────────────────────────────

const ADMIN_KEY: Symbol = symbol_short!("ADMIN");
const PENDING_HASH_KEY: Symbol = symbol_short!("P_HASH");
const EXECUTE_AFTER_KEY: Symbol = symbol_short!("P_AFTER");

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

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct RoundState {
    pub round_number: u32,
    pub round_start_ledger: u32,
    pub round_deadline_ledger: u32,
    pub active: bool,
    pub total_submissions: u32,
    pub timed_out: bool,
}

#[contracttype]
#[derive(Clone)]
enum DataKey {
    Config,
    Round,
    Submission(u32, Address),
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
            },
        );
        bump(&env, &DataKey::Round);

        Ok(())
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
    pub fn submit_choice(env: Env, player: Address, choice: Choice) -> Result<(), ArenaError> {
        env.storage()
            .instance()
            .extend_ttl(GAME_TTL_THRESHOLD, GAME_TTL_EXTEND_TO);
        player.require_auth();

        let mut round = get_round(&env)?;
        if !round.active {
            return Err(ArenaError::NoActiveRound);
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
    /// # Events
    /// Emits `UpgradeProposed(new_wasm_hash, execute_after)`.
    pub fn propose_upgrade(env: Env, new_wasm_hash: BytesN<32>) {
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

        env.events().publish(
            (TOPIC_UPGRADE_PROPOSED,),
            (new_wasm_hash, execute_after),
        );
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
    /// # Events
    /// Emits `UpgradeExecuted(new_wasm_hash)`.
    pub fn execute_upgrade(env: Env) {
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
            .publish((TOPIC_UPGRADE_EXECUTED,), new_wasm_hash.clone());

        env.deployer()
            .update_current_contract_wasm(new_wasm_hash);
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
    /// # Events
    /// Emits `UpgradeCancelled`.
    pub fn cancel_upgrade(env: Env) {
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

        env.events().publish((TOPIC_UPGRADE_CANCELLED,), ());
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

fn bump(env: &Env, key: &DataKey) {
    env.storage()
        .persistent()
        .extend_ttl(key, GAME_TTL_THRESHOLD, GAME_TTL_EXTEND_TO);
}

#[cfg(test)]
mod test;
