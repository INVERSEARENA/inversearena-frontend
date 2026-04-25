use soroban_sdk::{BytesN, Env, Symbol};

#[derive(Clone, Copy)]
pub enum ExecuteTimePolicy {
    AtOrAfter,
    StrictlyAfter,
}

#[derive(Clone, Copy)]
pub struct UpgradeKeys<'a> {
    pub pending_hash: &'a Symbol,
    pub execute_after: &'a Symbol,
}

#[derive(Clone, Copy)]
pub struct UpgradeTopics<'a> {
    pub proposed: &'a Symbol,
    pub executed: &'a Symbol,
    pub cancelled: &'a Symbol,
}

#[derive(Clone, Copy)]
pub struct UpgradeErrors<E> {
    pub no_pending: E,
    pub timelock_not_expired: E,
    pub hash_mismatch: E,
    pub malformed_state: Option<E>,
}

pub fn propose_upgrade<E: Copy>(
    env: &Env,
    keys: UpgradeKeys<'_>,
    topics: UpgradeTopics<'_>,
    event_version: u32,
    timelock_period: u64,
    new_wasm_hash: &BytesN<32>,
    upgrade_already_pending: E,
) -> Result<(), E> {
    if env.storage().instance().has(keys.pending_hash) {
        return Err(upgrade_already_pending);
    }

    let execute_after = env.ledger().timestamp() + timelock_period;
    env.storage()
        .instance()
        .set(keys.pending_hash, new_wasm_hash);
    env.storage()
        .instance()
        .set(keys.execute_after, &execute_after);
    env.events().publish(
        (topics.proposed.clone(),),
        (event_version, new_wasm_hash.clone(), execute_after),
    );
    Ok(())
}

pub fn execute_upgrade<E: Copy>(
    env: &Env,
    keys: UpgradeKeys<'_>,
    topics: UpgradeTopics<'_>,
    event_version: u32,
    expected_hash: &BytesN<32>,
    errors: UpgradeErrors<E>,
    time_policy: ExecuteTimePolicy,
) -> Result<BytesN<32>, E> {
    let has_pending_hash = env.storage().instance().has(keys.pending_hash);
    let has_execute_after = env.storage().instance().has(keys.execute_after);
    let missing_state_error = errors.malformed_state.unwrap_or(errors.no_pending);
    match (has_pending_hash, has_execute_after) {
        (false, false) => return Err(errors.no_pending),
        (true, false) | (false, true) => return Err(missing_state_error),
        (true, true) => {}
    }

    let execute_after: u64 = env
        .storage()
        .instance()
        .get(keys.execute_after)
        .ok_or(missing_state_error)?;

    let timelock_not_expired = match time_policy {
        ExecuteTimePolicy::AtOrAfter => env.ledger().timestamp() < execute_after,
        ExecuteTimePolicy::StrictlyAfter => env.ledger().timestamp() <= execute_after,
    };
    if timelock_not_expired {
        return Err(errors.timelock_not_expired);
    }

    let stored_hash: BytesN<32> = env
        .storage()
        .instance()
        .get(keys.pending_hash)
        .ok_or(missing_state_error)?;
    if stored_hash != *expected_hash {
        return Err(errors.hash_mismatch);
    }

    env.storage().instance().remove(keys.pending_hash);
    env.storage().instance().remove(keys.execute_after);
    env.events().publish(
        (topics.executed.clone(),),
        (event_version, stored_hash.clone()),
    );
    Ok(stored_hash)
}

pub fn cancel_upgrade<E: Copy>(
    env: &Env,
    keys: UpgradeKeys<'_>,
    topics: UpgradeTopics<'_>,
    event_version: u32,
    no_pending: E,
) -> Result<(), E> {
    if !env.storage().instance().has(keys.pending_hash) {
        return Err(no_pending);
    }

    env.storage().instance().remove(keys.pending_hash);
    env.storage().instance().remove(keys.execute_after);
    env.events()
        .publish((topics.cancelled.clone(),), (event_version,));
    Ok(())
}

pub fn pending_upgrade(env: &Env, keys: UpgradeKeys<'_>) -> Option<(BytesN<32>, u64)> {
    let hash: Option<BytesN<32>> = env.storage().instance().get(keys.pending_hash);
    let after: Option<u64> = env.storage().instance().get(keys.execute_after);
    match (hash, after) {
        (Some(hash), Some(after)) => Some((hash, after)),
        _ => None,
    }
}
