#![no_std]
use soroban_sdk::{contract, contractimpl, Address, Env};

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

const RATE_KEY: &str = "RATE";
const ADMIN_KEY: &str = "ADMIN";

#[contractimpl]
impl OracleContract {
    /// Initialise the oracle with an admin and an initial yield rate.
    pub fn initialize(env: Env, admin: Address, initial_rate_bps: u32) {
        admin.require_auth();
        env.storage().persistent().set(&soroban_sdk::symbol_short!("ADMIN"), &admin);
        env.storage().persistent().set(&soroban_sdk::symbol_short!("RATE"), &initial_rate_bps);
    }

    /// Update the current yield rate. Only callable by the admin.
    pub fn set_yield_bps(env: Env, rate_bps: u32) {
        let admin: Address = env
            .storage()
            .persistent()
            .get(&soroban_sdk::symbol_short!("ADMIN"))
            .unwrap_or_else(|| panic!("not initialised"));
        admin.require_auth();
        env.storage().persistent().set(&soroban_sdk::symbol_short!("RATE"), &rate_bps);
        env.events().publish((soroban_sdk::symbol_short!("rate_set"),), rate_bps);
    }

    /// Return the current yield rate in basis points (e.g. 500 = 5.00 % APY).
    /// Returns 0 if the oracle has not been initialised.
    pub fn get_current_yield_bps(env: Env) -> u32 {
        env.storage()
            .persistent()
            .get(&soroban_sdk::symbol_short!("RATE"))
            .unwrap_or(0)
    }
}

const _: &str = RATE_KEY;
const _: &str = ADMIN_KEY;

#[cfg(test)]
mod tests {
    use super::*;
    use soroban_sdk::testutils::Address as _;

    #[test]
    fn get_yield_bps_returns_set_rate() {
        let env = Env::default();
        env.mock_all_auths();
        let contract_id = env.register(OracleContract, ());
        let admin = Address::generate(&env);
        let client = OracleContractClient::new(&env, &contract_id);

        client.initialize(&admin, &500);
        assert_eq!(client.get_current_yield_bps(), 500);
    }

    #[test]
    fn set_yield_bps_updates_rate() {
        let env = Env::default();
        env.mock_all_auths();
        let contract_id = env.register(OracleContract, ());
        let admin = Address::generate(&env);
        let client = OracleContractClient::new(&env, &contract_id);

        client.initialize(&admin, &300);
        client.set_yield_bps(&750);
        assert_eq!(client.get_current_yield_bps(), 750);
    }
}
