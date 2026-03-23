#![no_std]

use soroban_sdk::{
    contract, contracterror, contractimpl, contracttype, Address, Env,
};

#[contract]
pub struct ArenaContract;

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

#[contractimpl]
impl ArenaContract {
    pub fn init(env: Env, round_speed_in_ledgers: u32) -> Result<(), ArenaError> {
        if storage(&env).has(&DataKey::Config) {
            return Err(ArenaError::AlreadyInitialized);
        }

        if round_speed_in_ledgers == 0 {
            return Err(ArenaError::InvalidRoundSpeed);
        }

        storage(&env).set(
            &DataKey::Config,
            &ArenaConfig {
                round_speed_in_ledgers,
            },
        );

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

        Ok(())
    }

    pub fn start_round(env: Env) -> Result<RoundState, ArenaError> {
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

        Ok(next_round)
    }

    pub fn submit_choice(env: Env, player: Address, choice: Choice) -> Result<(), ArenaError> {
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

        round.total_submissions += 1;
        storage(&env).set(&DataKey::Round, &round);

        Ok(())
    }

    pub fn timeout_round(env: Env) -> Result<RoundState, ArenaError> {
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

        Ok(round)
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
}

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

#[cfg(test)]
mod test;
