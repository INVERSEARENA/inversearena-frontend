use soroban_sdk::{token, Address, Env, String, Vec};
use crate::errors::ArenaError;
use crate::events::{ArenaCancelled, PlayerJoined, TOPIC_ARENA_CANCELLED, TOPIC_CANCELLED, TOPIC_LEAVE, TOPIC_PLAYER_JOINED, EVENT_VERSION};
use crate::state::{
    bump, get_config, set_state, ArenaState, DataKey,
    CANCELLED_KEY, CAPACITY_KEY, GAME_FINISHED_KEY, PRIZE_POOL_KEY, SURVIVOR_COUNT_KEY, TOKEN_KEY,
};
use crate::bounds;

pub fn join(env: &Env, player: Address, amount: i128) -> Result<(), ArenaError> {
    let config = get_config(env)?;
    if amount != config.required_stake_amount {
        return Err(ArenaError::InvalidAmount);
    }

    let survivor_key = DataKey::Survivor(player.clone());
    if env.storage().persistent().has(&survivor_key) {
        return Err(ArenaError::AlreadyJoined);
    }

    let capacity: u32 = env.storage().instance().get(&CAPACITY_KEY).unwrap_or(bounds::MAX_ARENA_PARTICIPANTS);
    let count: u32 = env.storage().instance().get(&SURVIVOR_COUNT_KEY).unwrap_or(0);
    if count >= capacity {
        return Err(ArenaError::ArenaFull);
    }

    let token: Address = env.storage().instance().get(&TOKEN_KEY).ok_or(ArenaError::TokenNotSet)?;
    token::Client::new(env, &token).transfer(&player, &env.current_contract_address(), &amount);

    env.storage().persistent().set(&survivor_key, &());
    bump(env, &survivor_key);
    env.storage().instance().set(&SURVIVOR_COUNT_KEY, &(count + 1));

    let pool: i128 = env.storage().instance().get(&PRIZE_POOL_KEY).unwrap_or(0);
    env.storage().instance().set(&PRIZE_POOL_KEY, &pool.checked_add(amount).ok_or(ArenaError::InvalidAmount)?);

    let mut all_players: Vec<Address> = env.storage().persistent().get(&DataKey::AllPlayers).unwrap_or(Vec::new(env));
    all_players.push_back(player.clone());
    env.storage().persistent().set(&DataKey::AllPlayers, &all_players);
    bump(env, &DataKey::AllPlayers);

    let arena_id: u64 = env.storage().instance().get(&DataKey::ArenaId).unwrap_or(0);
    env.events().publish(
        (TOPIC_PLAYER_JOINED,),
        PlayerJoined { arena_id, player, entry_fee: amount },
    );
    Ok(())
}

pub fn leave(env: &Env, player: Address) -> Result<i128, ArenaError> {
    let survivor_key = DataKey::Survivor(player.clone());
    if !env.storage().persistent().has(&survivor_key) {
        return Err(ArenaError::NotASurvivor);
    }

    let config = get_config(env)?;
    let refund = config.required_stake_amount;
    let token: Address = env.storage().instance().get(&TOKEN_KEY).ok_or(ArenaError::TokenNotSet)?;

    env.storage().persistent().remove(&survivor_key);
    let count: u32 = env.storage().instance().get(&SURVIVOR_COUNT_KEY).unwrap_or(0);
    env.storage().instance().set(&SURVIVOR_COUNT_KEY, &count.saturating_sub(1));

    let mut all_players: Vec<Address> = env.storage().persistent().get(&DataKey::AllPlayers).unwrap_or(Vec::new(env));
    if let Some(i) = all_players.first_index_of(&player) {
        all_players.remove(i);
    }
    env.storage().persistent().set(&DataKey::AllPlayers, &all_players);
    bump(env, &DataKey::AllPlayers);

    let pool: i128 = env.storage().instance().get(&PRIZE_POOL_KEY).unwrap_or(0);
    env.storage().instance().set(&PRIZE_POOL_KEY, &pool.saturating_sub(refund));
    token::Client::new(env, &token).transfer(&env.current_contract_address(), &player, &refund);
    env.events().publish((TOPIC_LEAVE,), (player, refund, EVENT_VERSION));

    Ok(refund)
}

pub fn cancel_arena(env: &Env) -> Result<(), ArenaError> {
    if env.storage().instance().get::<_, bool>(&CANCELLED_KEY).unwrap_or(false) {
        return Err(ArenaError::AlreadyCancelled);
    }
    if env.storage().instance().get::<_, bool>(&GAME_FINISHED_KEY).unwrap_or(false) {
        return Err(ArenaError::GameAlreadyFinished);
    }

    let all_players: Vec<Address> = env.storage().persistent().get(&DataKey::AllPlayers).unwrap_or(Vec::new(env));
    if !all_players.is_empty() {
        let config = get_config(env)?;
        let token: Address = env.storage().instance().get(&TOKEN_KEY).ok_or(ArenaError::TokenNotSet)?;
        let refund_amount = config.required_stake_amount;
        let token_client = token::Client::new(env, &token);

        for player in all_players.iter() {
            if env.storage().persistent().has(&DataKey::Survivor(player.clone()))
                && !env.storage().persistent().has(&DataKey::Refunded(player.clone()))
            {
                env.storage().persistent().set(&DataKey::Refunded(player.clone()), &());
                bump(env, &DataKey::Refunded(player.clone()));
                token_client.transfer(&env.current_contract_address(), &player, &refund_amount);
            }
        }
        env.storage().instance().set(&PRIZE_POOL_KEY, &0i128);
    }

    env.storage().instance().set(&CANCELLED_KEY, &true);
    env.storage().instance().set(&GAME_FINISHED_KEY, &true);
    set_state(env, ArenaState::Cancelled);

    let arena_id: u64 = env.storage().instance().get(&DataKey::ArenaId).unwrap_or(0);
    env.events().publish(
        (TOPIC_ARENA_CANCELLED,),
        ArenaCancelled { arena_id, reason: String::from_str(env, "Cancelled by admin") },
    );
    env.events().publish((TOPIC_CANCELLED,), (EVENT_VERSION,));

    Ok(())
}
