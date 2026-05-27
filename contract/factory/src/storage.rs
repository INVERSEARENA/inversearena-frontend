use soroban_sdk::{Address, Env, contracttype, symbol_short};

const ADMIN_KEY: soroban_sdk::Symbol = symbol_short!("ADMIN");
const STAKE_TOKEN_KEY: soroban_sdk::Symbol = symbol_short!("STK_TKN");
const MIN_CREATOR_STAKE_KEY: soroban_sdk::Symbol = symbol_short!("MIN_STK");
const NEXT_ARENA_ID_KEY: soroban_sdk::Symbol = symbol_short!("NEXT_ID");

#[contracttype]
pub enum DataKey {
    CreatorStake(Address),
}

#[contracttype]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct CreatorStakeRecord {
    pub creator: Address,
    pub amount: i128,
}

pub struct FactoryStorage;

impl FactoryStorage {
    pub fn has_admin(env: &Env) -> bool {
        env.storage().instance().has(&ADMIN_KEY)
    }

    pub fn load_admin(env: &Env) -> Option<Address> {
        env.storage().instance().get(&ADMIN_KEY)
    }

    pub fn save_admin(env: &Env, admin: &Address) {
        env.storage().instance().set(&ADMIN_KEY, admin);
    }

    pub fn load_stake_token(env: &Env) -> Option<Address> {
        env.storage().instance().get(&STAKE_TOKEN_KEY)
    }

    pub fn save_stake_token(env: &Env, token: &Address) {
        env.storage().instance().set(&STAKE_TOKEN_KEY, token);
    }

    pub fn load_min_creator_stake(env: &Env) -> i128 {
        env.storage()
            .instance()
            .get(&MIN_CREATOR_STAKE_KEY)
            .unwrap_or(0)
    }

    pub fn save_min_creator_stake(env: &Env, stake: i128) {
        env.storage().instance().set(&MIN_CREATOR_STAKE_KEY, &stake);
    }

    pub fn next_arena_nonce(env: &Env) -> u64 {
        let next = env.storage().instance().get(&NEXT_ARENA_ID_KEY).unwrap_or(0u64);
        env.storage().instance().set(&NEXT_ARENA_ID_KEY, &(next + 1));
        next
    }

    pub fn save_creator_stake(
        env: &Env,
        arena_id: &Address,
        creator: &Address,
        amount: i128,
    ) {
        env.storage().persistent().set(
            &DataKey::CreatorStake(arena_id.clone()),
            &CreatorStakeRecord {
                creator: creator.clone(),
                amount,
            },
        );
    }

    pub fn load_creator_stake(env: &Env, arena_id: &Address) -> Option<CreatorStakeRecord> {
        env.storage()
            .persistent()
            .get(&DataKey::CreatorStake(arena_id.clone()))
    }

    pub fn remove_creator_stake(env: &Env, arena_id: &Address) {
        env.storage()
            .persistent()
            .remove(&DataKey::CreatorStake(arena_id.clone()));
    }
}
