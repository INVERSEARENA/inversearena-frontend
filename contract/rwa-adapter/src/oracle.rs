use soroban_sdk::{Address, Env, contractclient};

#[contractclient(name = "OracleContractClient")]
pub trait OracleInterface {
    fn get_current_yield_bps(env: Env) -> u32;
}

pub fn fetch_yield_bps(env: &Env, oracle_contract: &Address) -> u32 {
    let client = OracleContractClient::new(env, oracle_contract);
    match client.try_get_current_yield_bps() {
        Ok(Ok(bps)) => bps,
        _ => 0,
    }
}
