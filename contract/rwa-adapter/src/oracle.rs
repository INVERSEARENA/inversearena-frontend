use soroban_sdk::{Address, Env, contractclient, contracttype};

#[contractclient(name = "OracleContractClient")]
pub trait OracleInterface {
    fn get_current_yield_bps(env: Env) -> u32;
}

/// Effective rate schedule, mirroring `oracle::RateSchedule` (#1570).
/// Field order and types must match the oracle contract exactly.
#[contracttype]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct RateSchedule {
    pub current: u32,
    pub pending: Option<u32>,
    pub effective_at: Option<u64>,
    pub max_delta_bps: u32,
    pub activation_delay: u64,
    pub pending_max_rate: Option<u32>,
    pub pending_max_delta: Option<u32>,
    pub pending_delay: Option<u64>,
    pub params_effective_at: Option<u64>,
}

/// Schedule-reading client for keepers and frontends (#1570).
/// Kept separate from [`OracleInterface`] so existing callers and mocks
/// that only implement `get_current_yield_bps` keep compiling.
#[contractclient(name = "OracleScheduleClient")]
pub trait OracleScheduleInterface {
    fn get_rate_schedule(env: Env) -> RateSchedule;
}

/// Read the currently effective yield rate in bps.
///
/// The oracle bounds each update by `max_delta_bps` and activates it after
/// `activation_delay` (#1570); `get_current_yield_bps` already returns the
/// effective rate, so vault math needs no schedule tracking. Returns `0`
/// when the oracle is unreachable — liveness over precision.
pub fn fetch_yield_bps(env: &Env, oracle_contract: &Address) -> u32 {
    let client = OracleContractClient::new(env, oracle_contract);
    match client.try_get_current_yield_bps() {
        Ok(Ok(bps)) => bps,
        _ => 0,
    }
}

/// Fetch the oracle's full rate schedule (#1570).
///
/// Returns `None` when the oracle is unreachable or is an older deployment
/// without `get_rate_schedule`. Keepers and frontends use this to surface
/// pending rates, activation times, and bounds before they take effect.
pub fn fetch_rate_schedule(env: &Env, oracle_contract: &Address) -> Option<RateSchedule> {
    let client = OracleScheduleClient::new(env, oracle_contract);
    match client.try_get_rate_schedule() {
        Ok(Ok(schedule)) => Some(schedule),
        _ => None,
    }
}
