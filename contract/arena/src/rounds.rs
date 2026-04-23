use soroban_sdk::{token, Address, Env, Vec};
use crate::errors::ArenaError;
use crate::events::{
    Choice, PlayerEliminated, RoundResolved, WinnerDeclared,
    TOPIC_PLAYER_ELIMINATED, TOPIC_ROUND_RESOLVED, TOPIC_WINNER_DECLARED, EVENT_VERSION,
};
use crate::math::{choose_surviving_side, split_prize};
use crate::rwa::call_payout_contract;
use crate::state::{
    bump, get_config, get_round, get_state, set_state,
    ArenaState, DataKey, GAME_FINISHED_KEY, PRIZE_POOL_KEY, SURVIVOR_COUNT_KEY, TOKEN_KEY,
};

pub fn get_round_choices(env: &Env, round: u32) -> soroban_sdk::Map<Address, Choice> {
    env.storage()
        .persistent()
        .get(&DataKey::RoundChoices(round))
        .unwrap_or(soroban_sdk::Map::new(env))
}

pub fn set_round_choices(env: &Env, round: u32, choices: &soroban_sdk::Map<Address, Choice>) {
    let key = DataKey::RoundChoices(round);
    env.storage().persistent().set(&key, choices);
    bump(env, &key);
}

pub fn resolve_round_internal(env: &Env) -> Result<crate::state::RoundState, ArenaError> {
    let mut round = get_round(env)?;
    let config = get_config(env)?;

    if round.round_number > 0 && round.round_number >= config.max_rounds {
        return resolve_max_rounds_draw(env, &mut round);
    }

    let choices = get_round_choices(env, round.round_number);
    let mut heads_count = 0u32;
    let mut tails_count = 0u32;

    for (_, choice) in choices.iter() {
        match choice {
            Choice::Heads => heads_count += 1,
            Choice::Tails => tails_count += 1,
        }
    }

    let surviving_choice = choose_surviving_side(env, heads_count, tails_count);

    let all_players: Vec<Address> = env
        .storage()
        .persistent()
        .get(&DataKey::AllPlayers)
        .unwrap_or(Vec::new(env));

    let mut eliminated_players = Vec::new(env);
    let mut eliminated_count = 0u32;

    for player in all_players.iter() {
        let survivor_key = DataKey::Survivor(player.clone());
        if !env.storage().persistent().has(&survivor_key) {
            continue;
        }
        let player_choice = choices.get(player.clone());
        let survives = match (&surviving_choice, &player_choice) {
            (Some(side), Some(c)) => c == side,
            _ => false,
        };
        if !survives {
            env.storage().persistent().remove(&survivor_key);
            let elim_key = DataKey::Eliminated(player.clone());
            env.storage().persistent().set(&elim_key, &true);
            bump(env, &elim_key);

            let choice_made = player_choice.unwrap_or(Choice::Heads);
            env.events().publish(
                (TOPIC_PLAYER_ELIMINATED,),
                PlayerEliminated {
                    arena_id: 0,
                    round: round.round_number,
                    player: player.clone(),
                    choice_made,
                },
            );
            eliminated_players.push_back(player);
            eliminated_count += 1;
        }
    }

    let survivor_count: u32 = env
        .storage()
        .instance()
        .get(&SURVIVOR_COUNT_KEY)
        .unwrap_or(0);
    let updated = survivor_count.saturating_sub(eliminated_count);
    env.storage().instance().set(&SURVIVOR_COUNT_KEY, &updated);

    if updated <= 1 {
        env.storage().instance().set(&GAME_FINISHED_KEY, &true);
    }
    if updated == 1 {
        declare_winner(env)?;
    } else if updated == 0 {
        handle_draw(env)?;
    }

    round.finished = true;
    env.storage().instance().set(&DataKey::Round, &round);

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
        RoundResolved {
            arena_id: 0,
            round: round.round_number,
            heads_count,
            tails_count,
            eliminated: eliminated_players,
        },
    );

    Ok(round)
}

fn resolve_max_rounds_draw(
    env: &Env,
    round: &mut crate::state::RoundState,
) -> Result<crate::state::RoundState, ArenaError> {
    let all_players: Vec<Address> = env
        .storage()
        .persistent()
        .get(&DataKey::AllPlayers)
        .unwrap_or(Vec::new(env));
    let mut survivors = Vec::new(env);
    for p in all_players.iter() {
        if env.storage().persistent().has(&DataKey::Survivor(p.clone())) {
            survivors.push_back(p);
        }
    }

    let prize: i128 = env.storage().instance().get(&PRIZE_POOL_KEY).unwrap_or(0);
    if !survivors.is_empty() && prize > 0 {
        let token: Address = env
            .storage()
            .instance()
            .get(&TOKEN_KEY)
            .ok_or(ArenaError::TokenNotSet)?;
        let (share, dust) = split_prize(prize, survivors.len())?;
        let token_client = token::Client::new(env, &token);
        for s in survivors.iter() {
            token_client.transfer(&env.current_contract_address(), &s, &share);
        }
        if dust > 0 {
            token_client.transfer(
                &env.current_contract_address(),
                &survivors.get(0).unwrap(),
                &dust,
            );
        }
        env.storage().instance().set(&PRIZE_POOL_KEY, &0i128);
    }

    env.storage().instance().set(&GAME_FINISHED_KEY, &true);
    round.finished = true;
    env.storage().instance().set(&DataKey::Round, round);
    set_state(env, ArenaState::Completed);
    Ok(round.clone())
}

fn declare_winner(env: &Env) -> Result<(), ArenaError> {
    let all_players: Vec<Address> = env
        .storage()
        .persistent()
        .get(&DataKey::AllPlayers)
        .unwrap_or(Vec::new(env));
    let mut survivors = Vec::new(env);
    for p in all_players.iter() {
        if env.storage().persistent().has(&DataKey::Survivor(p.clone())) {
            survivors.push_back(p);
        }
    }
    if survivors.len() != 1 {
        return Ok(());
    }
    let winner = survivors.get(0).expect("survivor exists");
    env.storage()
        .persistent()
        .set(&DataKey::Winner(winner.clone()), &true);
    bump(env, &DataKey::Winner(winner.clone()));

    let prize_pool: i128 = env.storage().instance().get(&PRIZE_POOL_KEY).unwrap_or(0);
    let yield_earned: i128 = env
        .storage()
        .instance()
        .get(&DataKey::YieldEarned)
        .unwrap_or(0);
    let total_rounds = get_round(env).map(|r| r.round_number).unwrap_or(0);

    env.events().publish(
        (TOPIC_WINNER_DECLARED,),
        WinnerDeclared {
            arena_id: 0,
            winner: winner.clone(),
            prize_pool,
            yield_earned,
            total_rounds,
        },
    );

    call_payout_contract(env, winner, prize_pool, yield_earned);
    set_state(env, ArenaState::Completed);
    Ok(())
}

fn handle_draw(env: &Env) -> Result<(), ArenaError> {
    let all_players: Vec<Address> = env
        .storage()
        .persistent()
        .get(&DataKey::AllPlayers)
        .unwrap_or(Vec::new(env));
    if all_players.is_empty() {
        return Ok(());
    }
    let prize_pool: i128 = env.storage().instance().get(&PRIZE_POOL_KEY).unwrap_or(0);
    if prize_pool > 0 {
        let token: Address = env
            .storage()
            .instance()
            .get(&TOKEN_KEY)
            .ok_or(ArenaError::TokenNotSet)?;
        let (share, dust) = split_prize(prize_pool, all_players.len())?;
        let token_client = token::Client::new(env, &token);
        for player in all_players.iter() {
            token_client.transfer(&env.current_contract_address(), &player, &share);
        }
        if dust > 0 {
            if let Some(first) = all_players.get(0) {
                token_client.transfer(&env.current_contract_address(), &first, &dust);
            }
        }
        env.storage().instance().set(&PRIZE_POOL_KEY, &0i128);
    }
    set_state(env, ArenaState::Completed);
    Ok(())
}

// ── Public entry points called from lib.rs ────────────────────────────────────

use crate::events::{ChoiceSubmitted, TOPIC_CHOICE_SUBMITTED, TOPIC_ROUND_STARTED, TOPIC_ROUND_TIMEOUT};
use crate::bounds;
use soroban_sdk::{Bytes, BytesN, xdr::ToXdr};

pub fn start_round(env: &Env) -> Result<crate::state::RoundState, ArenaError> {
    let current_state = get_state(env);
    if current_state != ArenaState::Pending && current_state != ArenaState::Active {
        return Err(ArenaError::GameAlreadyFinished);
    }
    if env.storage().instance().get::<_, bool>(&GAME_FINISHED_KEY).unwrap_or(false) {
        return Err(ArenaError::GameAlreadyFinished);
    }

    let mut round = get_round(env)?;
    if round.active {
        return Err(ArenaError::RoundAlreadyActive);
    }

    let survivor_count: u32 = env.storage().instance().get(&SURVIVOR_COUNT_KEY).unwrap_or(0);
    if survivor_count < bounds::MIN_ARENA_PARTICIPANTS {
        return Err(ArenaError::NotEnoughPlayers);
    }

    let config = get_config(env)?;
    let round_start_ledger = env.ledger().sequence();
    let commit_deadline_ledger = round_start_ledger
        .checked_add(config.round_speed_in_ledgers)
        .ok_or(ArenaError::RoundDeadlineOverflow)?;
    let reveal_deadline_ledger = commit_deadline_ledger
        .checked_add(config.round_speed_in_ledgers)
        .ok_or(ArenaError::RoundDeadlineOverflow)?;
    let round_start = env.ledger().timestamp();
    let round_deadline = round_start
        .checked_add(config.round_duration_seconds)
        .ok_or(ArenaError::RoundDeadlineOverflow)?;

    let prev_round_number = round.round_number;
    round = crate::state::RoundState {
        round_number: prev_round_number + 1,
        round_start_ledger,
        round_deadline_ledger: commit_deadline_ledger,
        round_start,
        round_deadline,
        active: true,
        total_submissions: 0,
        timed_out: false,
        finished: false,
    };
    env.storage().instance().set(&DataKey::Round, &round);

    if round.round_number == 1 {
        set_state(env, ArenaState::Active);
    }

    env.events().publish(
        (TOPIC_ROUND_STARTED,),
        (round.round_number, round_start_ledger, commit_deadline_ledger, reveal_deadline_ledger, EVENT_VERSION),
    );
    Ok(round)
}

pub fn commit_choice(env: &Env, player: Address, round_number: u32, commitment: BytesN<32>) -> Result<(), ArenaError> {
    let round = get_round(env)?;
    if !round.active || round.round_number != round_number {
        return Err(ArenaError::WrongRoundNumber);
    }
    if env.ledger().sequence() > round.round_deadline_ledger {
        return Err(ArenaError::CommitDeadlinePassed);
    }
    if !env.storage().persistent().has(&DataKey::Survivor(player.clone())) {
        return Err(ArenaError::NotASurvivor);
    }
    let key = DataKey::Commitment(round_number, player.clone());
    if env.storage().persistent().has(&key) {
        return Err(ArenaError::AlreadyCommitted);
    }
    env.storage().persistent().set(&key, &commitment);
    bump(env, &key);
    Ok(())
}

pub fn reveal_choice(env: &Env, player: Address, round_number: u32, choice: Choice, nonce: BytesN<32>) -> Result<(), ArenaError> {
    let mut round = get_round(env)?;
    if !round.active || round.round_number != round_number {
        return Err(ArenaError::WrongRoundNumber);
    }
    if env.ledger().sequence() <= round.round_deadline_ledger {
        return Err(ArenaError::SubmissionWindowClosed);
    }
    let config = get_config(env)?;
    let reveal_deadline = round.round_deadline_ledger
        .checked_add(config.round_speed_in_ledgers)
        .ok_or(ArenaError::RoundDeadlineOverflow)?;
    if env.ledger().sequence() > reveal_deadline {
        return Err(ArenaError::RevealDeadlinePassed);
    }

    let key = DataKey::Commitment(round_number, player.clone());
    let commitment: BytesN<32> = env.storage().persistent().get(&key).ok_or(ArenaError::NoCommitment)?;

    let choice_byte: u8 = match choice { Choice::Heads => 0, Choice::Tails => 1 };
    let mut bytes = Bytes::new(env);
    bytes.append(&Bytes::from_array(env, &[choice_byte]));
    bytes.append(&nonce.into());
    bytes.append(&player.clone().to_xdr(env));
    let hash: BytesN<32> = env.crypto().sha256(&bytes).into();
    if hash != commitment {
        return Err(ArenaError::CommitmentMismatch);
    }

    let mut choices = get_round_choices(env, round_number);
    if choices.contains_key(player.clone()) {
        return Err(ArenaError::SubmissionAlreadyExists);
    }
    choices.set(player.clone(), choice);
    set_round_choices(env, round_number, &choices);

    round.total_submissions += 1;
    env.storage().instance().set(&DataKey::Round, &round);

    env.events().publish(
        (TOPIC_CHOICE_SUBMITTED,),
        ChoiceSubmitted { arena_id: 0, round: round.round_number, player },
    );

    let survivor_count: u32 = env.storage().instance().get(&SURVIVOR_COUNT_KEY).unwrap_or(0);
    if survivor_count > 0 && round.total_submissions >= survivor_count {
        round.active = false;
        env.storage().instance().set(&DataKey::Round, &round);
        resolve_round_internal(env)?;
    }
    Ok(())
}

pub fn timeout_round(env: &Env) -> Result<crate::state::RoundState, ArenaError> {
    let mut round = get_round(env)?;
    if !round.active {
        return Err(ArenaError::NoActiveRound);
    }
    if env.ledger().sequence() <= round.round_deadline_ledger {
        return Err(ArenaError::RoundStillOpen);
    }
    round.active = false;
    round.timed_out = true;
    env.storage().instance().set(&DataKey::Round, &round);
    env.events().publish(
        (TOPIC_ROUND_TIMEOUT,),
        (round.round_number, round.total_submissions, EVENT_VERSION),
    );
    Ok(round)
}

pub fn resolve_round(env: &Env) -> Result<crate::state::RoundState, ArenaError> {
    let mut round = get_round(env)?;
    if round.finished {
        return Err(ArenaError::NoActiveRound);
    }
    if round.active {
        if env.ledger().sequence() <= round.round_deadline_ledger {
            return Err(ArenaError::RoundStillOpen);
        }
        round.active = false;
        round.timed_out = true;
        env.storage().instance().set(&DataKey::Round, &round);
    }
    resolve_round_internal(env)
}
