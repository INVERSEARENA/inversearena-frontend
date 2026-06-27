#![no_std]
use soroban_sdk::{Address, BytesN, Env, contract, contracterror, contractimpl};

/// On-chain yield rate oracle for InverseArena.
///
/// Stores an admin-updateable yield rate in basis points (bps).
/// The arena contract calls `get_current_yield_bps` once per `resolve_round`
/// to snapshot the current USDY / RWA yield rate.
///
/// The admin updates the rate before each round closes, sourcing the value
/// from Ondo's off-chain API or an on-chain Band Protocol feed.
/// Future upgrades can replace this contract with a fully autonomous oracle.
#[contract]
pub struct OracleContract;

const KEY_ADMIN: soroban_sdk::Symbol = symbol_short!("ADMIN");
const KEY_RATE: soroban_sdk::Symbol = symbol_short!("RATE");
const KEY_MAX_RATE: soroban_sdk::Symbol = symbol_short!("MAX_RATE");

pub const DEFAULT_MAX_YIELD_BPS: u32 = 5_000;

#[contracterror]
#[derive(Copy, Clone, Debug, Eq, PartialEq, PartialOrd, Ord)]
#[repr(u32)]
pub enum OracleError {
    NotInitialized = 1,
    AlreadyInitialized = 2,
    RateTooHigh = 3,
}

#[contractimpl]
impl OracleContract {
    pub fn initialize(env: Env, admin: Address, initial_rate_bps: u32) -> Result<(), OracleError> {
        if env.storage().persistent().has(&KEY_ADMIN) {
            return Err(OracleError::AlreadyInitialized);
        }
        if initial_rate_bps > DEFAULT_MAX_YIELD_BPS {
            return Err(OracleError::RateTooHigh);
        }
        admin.require_auth();
        env.storage().persistent().set(&KEY_ADMIN, &admin);
        env.storage().persistent().set(&KEY_RATE, &initial_rate_bps);
        env.storage().persistent().set(&KEY_MAX_RATE, &DEFAULT_MAX_YIELD_BPS);
        Ok(())
    }

    pub fn set_yield_bps(env: Env, rate_bps: u32) -> Result<(), OracleError> {
        let admin: Address = env.storage().persistent().get(&KEY_ADMIN).ok_or(OracleError::NotInitialized)?;
        let ceiling: u32 = env.storage().persistent().get(&KEY_MAX_RATE).unwrap_or(DEFAULT_MAX_YIELD_BPS);
        if rate_bps > ceiling {
            return Err(OracleError::RateTooHigh);
        }
        admin.require_auth();
        env.storage().persistent().set(&KEY_RATE, &rate_bps);
        env.events().publish((symbol_short!("rate_set"),), rate_bps);
        Ok(())
    }

    pub fn set_max_rate(env: Env, max_rate_bps: u32) -> Result<(), OracleError> {
        let admin: Address = env.storage().persistent().get(&KEY_ADMIN).ok_or(OracleError::NotInitialized)?;
        admin.require_auth();
        env.storage().persistent().set(&KEY_MAX_RATE, &max_rate_bps);
        env.events().publish((symbol_short!("max_set"),), max_rate_bps);
        Ok(())
    }

    pub fn get_max_yield_bps(env: Env) -> u32 {
        env.storage().persistent().get(&KEY_MAX_RATE).unwrap_or(DEFAULT_MAX_YIELD_BPS)
    }

    pub fn upgrade(env: Env, new_wasm_hash: BytesN<32>) -> Result<(), OracleError> {
        let admin: Address = env.storage().persistent().get(&KEY_ADMIN).ok_or(OracleError::NotInitialized)?;
        admin.require_auth();
        env.deployer().update_current_contract_wasm(new_wasm_hash);
        Ok(())
    }

    pub fn get_current_yield_bps(env: Env) -> u32 {
        env.storage().persistent().get(&KEY_RATE).unwrap_or(0)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use soroban_sdk::{Env, testutils::Address as _};

    fn setup(initial_rate: u32) -> (Env, OracleContractClient<'static>) {
        let env = Env::default();
        env.mock_all_auths();
        let contract_id = env.register(OracleContract, ());
        let admin = Address::generate(&env);
        let env_s: &'static Env = unsafe { &*(&env as *const Env) };
        let client = OracleContractClient::new(env_s, &contract_id);
        client.initialize(&admin, &initial_rate);
        (env, client)
    }

    #[test]
    fn get_yield_bps_returns_set_rate() {
        let (_env, client) = setup(500);
        assert_eq!(client.get_current_yield_bps(), 500);
    }

    #[test]
    fn initialize_twice_is_rejected() {
        let (env, client) = setup(500);
        let other = Address::generate(&env);
        assert_eq!(client.try_initialize(&other, &300), Err(Ok(OracleError::AlreadyInitialized)));
        assert_eq!(client.get_current_yield_bps(), 500);
    }

    #[test]
    fn set_yield_bps_updates_rate() {
        let (_env, client) = setup(300);
        client.set_yield_bps(&750);
        assert_eq!(client.get_current_yield_bps(), 750);
    }

    #[test]
    fn upgrade_requires_admin_auth() {
        let (env, client) = setup(500);
        env.set_auths(&[]);
        let wasm = soroban_sdk::BytesN::from_array(&env, &[0u8; 32]);
        assert!(client.try_upgrade(&wasm).is_err());
    }

    #[test]
    fn set_yield_bps_above_ceiling_returns_rate_too_high() {
        let (_env, client) = setup(500);
        assert_eq!(client.try_set_yield_bps(&(DEFAULT_MAX_YIELD_BPS + 1)), Err(Ok(OracleError::RateTooHigh)));
        assert_eq!(client.get_current_yield_bps(), 500);
    }

    #[test]
    fn set_yield_bps_u32_max_returns_rate_too_high() {
        let (_env, client) = setup(500);
        assert_eq!(client.try_set_yield_bps(&u32::MAX), Err(Ok(OracleError::RateTooHigh)));
        assert_eq!(client.get_current_yield_bps(), 500);
    }

    #[test]
    fn set_yield_bps_at_ceiling_is_accepted() {
        let (_env, client) = setup(500);
        client.set_yield_bps(&DEFAULT_MAX_YIELD_BPS);
        assert_eq!(client.get_current_yield_bps(), DEFAULT_MAX_YIELD_BPS);
    }

    #[test]
    fn set_max_rate_raises_ceiling_allows_higher_rate() {
        let (_env, client) = setup(500);
        client.set_max_rate(&7_000);
        assert_eq!(client.get_max_yield_bps(), 7_000);
        client.set_yield_bps(&6_000);
        assert_eq!(client.get_current_yield_bps(), 6_000);
    }

    #[test]
    fn set_max_rate_lowers_ceiling_rejects_previously_valid_rate() {
        let (_env, client) = setup(500);
        client.set_max_rate(&1_000);
        assert_eq!(client.try_set_yield_bps(&2_000), Err(Ok(OracleError::RateTooHigh)));
    }

    #[test]
    fn initialize_above_ceiling_returns_rate_too_high() {
        let env = Env::default();
        env.mock_all_auths();
        let contract_id = env.register(OracleContract, ());
        let admin = Address::generate(&env);
        let env_s: &'static Env = unsafe { &*(&env as *const Env) };
        let client = OracleContractClient::new(env_s, &contract_id);
        assert_eq!(client.try_initialize(&admin, &(DEFAULT_MAX_YIELD_BPS + 1)), Err(Ok(OracleError::RateTooHigh)));
    }
}
