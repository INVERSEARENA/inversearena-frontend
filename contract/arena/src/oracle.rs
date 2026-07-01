use soroban_sdk::{Address, Env, contractclient};

use crate::events::ArenaEvents;

#[allow(dead_code)]
/// Minimal cross-contract client for the yield-rate oracle.
/// Defined locally to avoid linking the oracle crate implementation into
/// the arena WASM (which would create duplicate symbol conflicts).
#[contractclient(name = "OracleContractClient")]
pub trait OracleInterface {
    fn get_current_yield_bps(env: Env) -> u32;
}

/// Fetch the current yield rate in basis points from the on-chain oracle.
///
/// Calls `get_current_yield_bps` on the configured oracle contract and returns
/// the rate. Returns `0` if the oracle call fails for any reason — liveness
/// over precision. A 0-bps round uses only the principal, which is correct.
///
/// On failure a `vault_oracle_failed` event is emitted with the oracle address
/// so operators can detect a misconfigured, unreachable, or malfunctioning
/// oracle instead of silently recording 0 yield.
///
/// The oracle contract is a simple admin-settable rate contract (see
/// `contract/oracle/`). Future upgrades can swap in an autonomous feed such as
/// Band Protocol on Stellar or Ondo's own exchange-rate contract.
pub fn fetch_yield_bps(env: &Env, oracle_contract: &Address) -> u32 {
    let client = OracleContractClient::new(env, oracle_contract);
    match client.try_get_current_yield_bps() {
        // Outer `Ok` = the cross-contract call succeeded; inner `Ok` = the
        // oracle returned a well-typed value.
        Ok(Ok(bps)) => bps,
        // Any failure layer (unreachable contract, host error, or a value the
        // arena cannot decode) surfaces an event and falls back to 0 bps.
        _ => {
            ArenaEvents::vault_oracle_failed(env, oracle_contract);
            0
        }
    }
}

// ── Tests ─────────────────────────────────────────────────────────────────
// Use inline mock oracles so the arena test build does not need to compile
// the oracle crate with soroban-sdk testutils features enabled.

#[cfg(test)]
mod tests {
    use soroban_sdk::testutils::Events as _;
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

    /// Empty stand-in for the calling arena, so `fetch_yield_bps` runs inside a
    /// contract context where `env.events().publish` is valid.
    #[contract]
    struct Host;

    #[contractimpl]
    impl Host {}

    #[test]
    fn fetch_yield_bps_returns_oracle_value() {
        let env = Env::default();
        let oracle_id = env.register(MockOracle500, ());
        let host_id = env.register(Host, ());
        let bps = env.as_contract(&host_id, || super::fetch_yield_bps(&env, &oracle_id));
        assert_eq!(bps, 500, "expected 500 bps (5%) from mock oracle");
        assert!(
            env.events().all().is_empty(),
            "the success path must not emit a failure event",
        );
    }

    #[test]
    fn fetch_yield_bps_defaults_zero_on_failure() {
        let env = Env::default();
        let bad_id = env.register(BadOracle, ());
        let host_id = env.register(Host, ());
        let bps = env.as_contract(&host_id, || super::fetch_yield_bps(&env, &bad_id));
        assert_eq!(bps, 0, "expected 0 bps fallback when oracle fails");
    }

    #[test]
    fn fetch_yield_bps_emits_event_on_failure() {
        let env = Env::default();
        let bad_id = env.register(BadOracle, ());
        let host_id = env.register(Host, ());
        let _ = env.as_contract(&host_id, || super::fetch_yield_bps(&env, &bad_id));
        assert_eq!(
            env.events().all().len(),
            1,
            "an oracle failure must surface exactly one event",
        );
    }
}
