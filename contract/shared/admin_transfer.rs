use soroban_sdk::{Address, Env, Symbol};

#[derive(Clone, Copy)]
pub struct AdminTransferKeys<'a> {
    pub admin: &'a Symbol,
    pub pending_admin: &'a Symbol,
    pub admin_expiry: &'a Symbol,
}

#[derive(Clone, Copy)]
pub struct AdminTransferErrors<E> {
    pub no_pending: E,
    pub unauthorized: E,
    pub expired: E,
}

pub fn propose_admin_transfer(
    env: &Env,
    keys: AdminTransferKeys<'_>,
    new_admin: &Address,
    transfer_expiry_seconds: u64,
) -> u64 {
    let expires_at = env.ledger().timestamp() + transfer_expiry_seconds;
    env.storage().instance().set(keys.pending_admin, new_admin);
    env.storage().instance().set(keys.admin_expiry, &expires_at);
    expires_at
}

pub fn accept_admin_transfer<E: Copy>(
    env: &Env,
    keys: AdminTransferKeys<'_>,
    new_admin: &Address,
    errors: AdminTransferErrors<E>,
) -> Result<(), E> {
    let pending: Address = env
        .storage()
        .instance()
        .get(keys.pending_admin)
        .ok_or(errors.no_pending)?;
    if pending != *new_admin {
        return Err(errors.unauthorized);
    }

    let expires_at: u64 = env
        .storage()
        .instance()
        .get(keys.admin_expiry)
        .ok_or(errors.no_pending)?;
    if env.ledger().timestamp() > expires_at {
        env.storage().instance().remove(keys.pending_admin);
        env.storage().instance().remove(keys.admin_expiry);
        return Err(errors.expired);
    }

    env.storage().instance().set(keys.admin, new_admin);
    env.storage().instance().remove(keys.pending_admin);
    env.storage().instance().remove(keys.admin_expiry);
    Ok(())
}

pub fn cancel_admin_transfer<E: Copy>(
    env: &Env,
    keys: AdminTransferKeys<'_>,
    no_pending: E,
) -> Result<(), E> {
    if !env.storage().instance().has(keys.pending_admin) {
        return Err(no_pending);
    }

    env.storage().instance().remove(keys.pending_admin);
    env.storage().instance().remove(keys.admin_expiry);
    Ok(())
}

pub fn pending_admin_transfer(env: &Env, keys: AdminTransferKeys<'_>) -> Option<(Address, u64)> {
    let addr: Option<Address> = env.storage().instance().get(keys.pending_admin);
    let exp: Option<u64> = env.storage().instance().get(keys.admin_expiry);
    match (addr, exp) {
        (Some(a), Some(e)) => Some((a, e)),
        _ => None,
    }
}
