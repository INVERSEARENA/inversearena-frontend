use soroban_sdk::{Address, Env, contractclient, contracttype};

use crate::events::ArenaEvents;
use crate::types::OracleFreshnessPolicy;

#[allow(dead_code)]
/// Minimal cross-contract client for the yield-rate oracle.
/// Defined locally to avoid linking the oracle crate implementation into
/// the arena WASM (which would create duplicate symbol conflicts).
#[contractclient(name = "OracleContractClient")]
pub trait OracleInterface {
    fn get_current_yield_bps(env: Env) -> u32;
    /// Additive (#1512): mirrors `contract/oracle/src/lib.rs`'s
    /// `OracleReading` field-for-field. A pre-#1512 oracle deployment has no
    /// such entrypoint — `fetch_oracle_reading` treats that call failure as
    /// "no freshness metadata available," not as a hard error (mixed
    /// deployment version compatibility).
    fn get_oracle_reading(env: Env) -> OracleReading;
}

/// Local mirror of `contract/oracle/src/lib.rs`'s `OracleReading`. Duplicated
/// (not imported) for the same "avoid linking the oracle crate" reason as
/// `OracleInterface` above — Soroban structs decode by field name, so this
/// must stay field-for-field identical to the real type.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct OracleReading {
    pub rate_bps: u32,
    pub observed_at: u64,
    pub source_version: u32,
}

/// How stale an oracle reading is relative to an `OracleFreshnessPolicy`.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum OracleFreshness {
    /// Strictly younger than `warn_age_secs`.
    Fresh,
    /// At or above `warn_age_secs` but strictly younger than `max_age_secs` —
    /// still usable, surfaced for alerting.
    Warning,
    /// At or above `max_age_secs`, or no observation was ever recorded
    /// (`observed_at == 0`) — `resolve_round` must refuse to use it.
    Stale,
    /// The oracle instance could not be reached, or does not expose
    /// `get_oracle_reading` at all (pre-#1512 deployment). Freshness cannot
    /// be classified; existing liveness-first behavior applies (see
    /// `fetch_yield_bps`'s doc comment) rather than blocking resolution.
    Unavailable,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum OracleCallOutcome<T> {
    Success(T),
    Failed,
    Unavailable,
}

impl OracleFreshness {
    /// Stable numeric code for event payloads (Soroban events favor small
    /// primitives over enums for indexer-friendliness).
    pub fn as_code(self) -> u32 {
        match self {
            OracleFreshness::Fresh => 0,
            OracleFreshness::Warning => 1,
            OracleFreshness::Stale => 2,
            OracleFreshness::Unavailable => 3,
        }
    }
}

/// Classify an oracle reading's age against a freshness policy.
///
/// `reading = None` (oracle unreachable, or a pre-#1512 deployment with no
/// `get_oracle_reading`) classifies as `Unavailable`, never `Stale` — those
/// are deliberately distinct outcomes (see `OracleFreshness::Unavailable`'s
/// doc comment) so a caller can choose different handling for "can't tell"
/// versus "know it's too old."
///
/// A reading whose `observed_at` is in the future relative to `now` (clock/
/// ledger divergence) is treated as `Stale`, not `Fresh` — a future
/// timestamp is evidence the observation cannot be trusted, the same
/// conclusion as one that is too old, so it must not silently pass as fresh.
pub fn classify_freshness(
    now: u64,
    reading: Option<&OracleReading>,
    policy: &OracleFreshnessPolicy,
) -> OracleFreshness {
    let Some(reading) = reading else {
        return OracleFreshness::Unavailable;
    };
    if reading.observed_at == 0 {
        // No observation has ever been recorded on this oracle instance.
        return OracleFreshness::Stale;
    }
    if reading.observed_at > now {
        return OracleFreshness::Stale;
    }
    let age = now - reading.observed_at;
    if age >= policy.max_age_secs {
        OracleFreshness::Stale
    } else if age >= policy.warn_age_secs {
        OracleFreshness::Warning
    } else {
        OracleFreshness::Fresh
    }
}

/// Fetch the oracle's rate + observation metadata (#1512).
///
/// Returns `None` on any failure layer — unreachable contract, host error,
/// or an oracle deployment that predates `get_oracle_reading` — never
/// panics. Callers must not conflate `None` with a real `Stale` reading;
/// `classify_freshness` keeps them as separate outcomes.
pub fn fetch_oracle_reading(env: &Env, oracle_contract: &Address) -> Option<OracleReading> {
    let client = OracleContractClient::new(env, oracle_contract);
    match client.try_get_oracle_reading() {
        Ok(Ok(reading)) => Some(reading),
        _ => None,
    }
}

/// Effective rate schedule, mirroring `oracle::RateSchedule` (#1570).
/// Field order and types must match the oracle contract exactly.
#[allow(dead_code)]
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
#[allow(dead_code)]
#[contractclient(name = "OracleScheduleClient")]
pub trait OracleScheduleInterface {
    fn get_rate_schedule(env: Env) -> RateSchedule;
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
/// The oracle contract is an admin-settable rate contract with bounded,
/// delayed updates (see `contract/oracle/`): `set_yield_bps` schedules (or,
/// when `activation_delay == 0`, applies) a rate bounded by `max_delta_bps`,
/// and `get_current_yield_bps` returns the currently effective rate. Arena
/// resolution snapshots this effective rate once per round, so consumers never
/// need to track pending values themselves. Future upgrades can swap in an
/// autonomous feed such as Band Protocol on Stellar or Ondo's own
/// exchange-rate contract.
///
/// Pending schedules and bounds are observable via [`fetch_rate_schedule`]
/// so keepers and frontends can react before activation.
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

/// Fetch the oracle's full rate schedule (#1570).
///
/// Returns `None` when the oracle is unreachable or is an older deployment
/// without `get_rate_schedule` — the effective rate from
/// [`fetch_yield_bps`] remains the source of truth for resolution.
/// Keepers and frontends use this to surface pending rates, activation
/// times, and bounds (`max_delta_bps`, `activation_delay`) before they
/// take effect.
#[allow(dead_code)]
pub fn fetch_rate_schedule(env: &Env, oracle_contract: &Address) -> Option<RateSchedule> {
    let client = OracleScheduleClient::new(env, oracle_contract);
    match client.try_get_rate_schedule() {
        Ok(Ok(schedule)) => Some(schedule),
        _ => None,
    }
}

// ── Tests ─────────────────────────────────────────────────────────────────
// Use inline mock oracles so the arena test build does not need to compile
// the oracle crate with soroban-sdk testutils features enabled.

#[cfg(test)]
#[cfg_attr(coverage_nightly, coverage(off))]
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

    /// Mock oracle exposing a pending scheduled rate (#1570).
    ///
    /// Nested in its own module: `#[contractimpl]` generates module-scoped
    /// items named after each method, so a second `get_current_yield_bps`
    /// beside `MockOracle500` would collide.
    mod scheduled_oracle_mock {
        use soroban_sdk::{Env, contract, contractimpl};

        #[contract]
        pub struct MockOracleScheduled;

        #[contractimpl]
        impl MockOracleScheduled {
            pub fn get_current_yield_bps(_env: Env) -> u32 {
                500
            }

            pub fn get_rate_schedule(_env: Env) -> super::super::RateSchedule {
                super::super::RateSchedule {
                    current: 500,
                    pending: Some(700),
                    effective_at: Some(1_100),
                    max_delta_bps: 1_000,
                    activation_delay: 100,
                    pending_max_rate: None,
                    pending_max_delta: None,
                    pending_delay: None,
                    params_effective_at: None,
                }
            }
        }
    }
    use scheduled_oracle_mock::MockOracleScheduled;

    #[test]
    fn fetch_rate_schedule_returns_pending_schedule() {
        let env = Env::default();
        let oracle_id = env.register(MockOracleScheduled, ());
        let host_id = env.register(Host, ());
        let schedule =
            env.as_contract(&host_id, || super::fetch_rate_schedule(&env, &oracle_id));
        let schedule = schedule.expect("schedule must decode from mock oracle");
        assert_eq!(schedule.current, 500);
        assert_eq!(schedule.pending, Some(700));
        assert_eq!(schedule.effective_at, Some(1_100));
    }

    #[test]
    fn fetch_rate_schedule_is_none_for_legacy_oracle() {
        let env = Env::default();
        let bad_id = env.register(BadOracle, ());
        let host_id = env.register(Host, ());
        let schedule =
            env.as_contract(&host_id, || super::fetch_rate_schedule(&env, &bad_id));
        assert!(
            schedule.is_none(),
            "an oracle without get_rate_schedule must yield None, not trap",
        );
    }
}
