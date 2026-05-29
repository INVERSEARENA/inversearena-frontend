use oracle::OracleContractClient;
use soroban_sdk::{Address, Env};

/// Fetch the current yield rate in basis points from the on-chain oracle.
///
/// Calls `get_current_yield_bps` on the configured oracle contract and returns
/// the rate. Returns `0` if the oracle call fails for any reason — liveness
/// over precision. A 0-bps round uses only the principal, which is correct.
///
/// The oracle contract is a simple admin-settable rate contract (see
/// `contract/oracle/`). Future upgrades can swap in an autonomous feed such as
/// Band Protocol on Stellar or Ondo's own exchange-rate contract.
pub fn fetch_yield_bps(env: &Env, oracle_contract: &Address) -> u32 {
    let client = OracleContractClient::new(env, oracle_contract);
    client
        .try_get_current_yield_bps()
        .unwrap_or(Ok(0))
        .unwrap_or(0)
}

// ── Tests ─────────────────────────────────────────────────────────────────
// Use inline mock oracles so the arena test build does not need to compile
// the oracle crate with soroban-sdk testutils features enabled.

#[cfg(test)]
mod tests {
    use soroban_sdk::{Env, contract, contractimpl};

    /// Mock returning a fixed 500 bps yield rate.
    #[contract]
    struct MockOracle500;

    #[contractimpl]
    impl MockOracle500 {
        pub fn get_current_yield_bps(_env: Env) -> u32 {
            500
        }
    }

    /// Mock with no functions — simulates an unavailable / wrong oracle.
    #[contract]
    struct BadOracle;

    #[contractimpl]
    impl BadOracle {}

    #[test]
    fn fetch_yield_bps_returns_oracle_value() {
        let env = Env::default();
        let oracle_id = env.register(MockOracle500, ());
        let bps = super::fetch_yield_bps(&env, &oracle_id);
        assert_eq!(bps, 500, "expected 500 bps (5%) from mock oracle");
    }

    #[test]
    fn fetch_yield_bps_defaults_zero_on_failure() {
        let env = Env::default();
        let bad_id = env.register(BadOracle, ());
        let bps = super::fetch_yield_bps(&env, &bad_id);
        assert_eq!(bps, 0, "expected 0 bps fallback when oracle fails");
    }
}
