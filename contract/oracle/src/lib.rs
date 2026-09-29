#![no_std]
use soroban_sdk::{
    Address, BytesN, Env, contract, contracterror, contractimpl, contracttype, symbol_short,
};

/// On-chain yield rate oracle for InverseArena.
///
/// Stores an admin-updateable yield rate in basis points (bps), alongside the
/// ledger timestamp of the observation that produced it (#1512) so a
/// consumer can classify how fresh that rate actually is instead of trusting
/// a bare number.
///
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
const KEY_PENDING_ADMIN: soroban_sdk::Symbol = symbol_short!("P_ADMIN");
/// Ledger timestamp (seconds) of the observation behind the current `KEY_RATE`
/// value. Absent (reads as `0`) until the first `set_yield_bps`/`initialize`
/// call — a consumer must treat `observed_at == 0` as "no observation has
/// ever been recorded," i.e. maximally stale, not as a real epoch-0 reading.
const KEY_OBSERVED_AT: soroban_sdk::Symbol = symbol_short!("OBS_AT");

pub const DEFAULT_MAX_YIELD_BPS: u32 = 5_000;
pub const MAX_MAX_RATE_BPS: u32 = 10_000;

/// Version of the freshness-metadata shape this deployment exposes via
/// `get_oracle_reading` (#1512). Bumped only if `OracleReading`'s fields
/// change in a way callers must branch on; the plain `get_current_yield_bps`
/// method never changes shape, so it carries no version of its own.
pub const ORACLE_CONTRACT_VERSION: u32 = 1;

#[contracterror]
#[derive(Copy, Clone, Debug, Eq, PartialEq, PartialOrd, Ord)]
#[repr(u32)]
pub enum OracleError {
    NotInitialized = 1,
    AlreadyInitialized = 2,
    RateTooHigh = 3,
    NoPendingAdmin = 4,
}

/// A yield rate reading together with its observation provenance (#1512).
///
/// Additive: exposed via the new `get_oracle_reading` view alongside the
/// unchanged `get_current_yield_bps`, so an older caller that only knows the
/// latter keeps working unmodified.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct OracleReading {
    pub rate_bps: u32,
    /// Ledger timestamp (seconds) the rate was last set at. `0` means no
    /// observation has ever been recorded on this instance.
    pub observed_at: u64,
    /// This deployment's `ORACLE_CONTRACT_VERSION`, so a caller that reads
    /// more than one oracle instance (e.g. across an upgrade) can tell them
    /// apart instead of assuming every instance shares the same shape.
    pub source_version: u32,
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
        env.storage()
            .persistent()
            .set(&KEY_OBSERVED_AT, &env.ledger().timestamp());
        env.storage()
            .persistent()
            .set(&KEY_MAX_RATE, &DEFAULT_MAX_YIELD_BPS);
        Ok(())
    }

    pub fn set_yield_bps(env: Env, rate_bps: u32) -> Result<(), OracleError> {
        let admin: Address = env
            .storage()
            .persistent()
            .get(&KEY_ADMIN)
            .ok_or(OracleError::NotInitialized)?;
        let ceiling: u32 = env
            .storage()
            .persistent()
            .get(&KEY_MAX_RATE)
            .unwrap_or(DEFAULT_MAX_YIELD_BPS);
        if rate_bps > ceiling {
            return Err(OracleError::RateTooHigh);
        }
        admin.require_auth();
        env.storage().persistent().set(&KEY_RATE, &rate_bps);
        let observed_at = env.ledger().timestamp();
        env.storage()
            .persistent()
            .set(&KEY_OBSERVED_AT, &observed_at);
        // Unchanged shape (bare rate_bps) for existing consumers of this event.
        env.events().publish((symbol_short!("rate_set"),), rate_bps);
        // Additive (#1512): carries the observation timestamp for consumers
        // that need freshness provenance without re-parsing `rate_set`.
        env.events()
            .publish((symbol_short!("rate_obs"),), (rate_bps, observed_at));
        Ok(())
    }

    pub fn set_max_rate(env: Env, max_rate_bps: u32) -> Result<(), OracleError> {
        let admin: Address = env
            .storage()
            .persistent()
            .get(&KEY_ADMIN)
            .ok_or(OracleError::NotInitialized)?;
        if max_rate_bps > MAX_MAX_RATE_BPS {
            return Err(OracleError::RateTooHigh);
        }
        admin.require_auth();
        env.storage().persistent().set(&KEY_MAX_RATE, &max_rate_bps);
        env.events()
            .publish((symbol_short!("max_set"),), max_rate_bps);
        Ok(())
    }

    pub fn get_max_yield_bps(env: Env) -> u32 {
        env.storage()
            .persistent()
            .get(&KEY_MAX_RATE)
            .unwrap_or(DEFAULT_MAX_YIELD_BPS)
    }

    pub fn propose_admin(env: Env, new_admin: Address) -> Result<(), OracleError> {
        let admin: Address = env
            .storage()
            .persistent()
            .get(&KEY_ADMIN)
            .ok_or(OracleError::NotInitialized)?;
        admin.require_auth();
        env.storage()
            .persistent()
            .set(&KEY_PENDING_ADMIN, &new_admin);
        Ok(())
    }

    pub fn accept_admin(env: Env) -> Result<(), OracleError> {
        let pending_admin: Address = env
            .storage()
            .persistent()
            .get(&KEY_PENDING_ADMIN)
            .ok_or(OracleError::NoPendingAdmin)?;
        pending_admin.require_auth();
        let old_admin: Address = env
            .storage()
            .persistent()
            .get(&KEY_ADMIN)
            .ok_or(OracleError::NotInitialized)?;
        env.storage().persistent().set(&KEY_ADMIN, &pending_admin);
        env.storage().persistent().remove(&KEY_PENDING_ADMIN);
        env.events()
            .publish((symbol_short!("adm_chg"),), (old_admin, pending_admin));
        Ok(())
    }

    pub fn upgrade(env: Env, new_wasm_hash: BytesN<32>) -> Result<(), OracleError> {
        let admin: Address = env
            .storage()
            .persistent()
            .get(&KEY_ADMIN)
            .ok_or(OracleError::NotInitialized)?;
        admin.require_auth();
        env.deployer().update_current_contract_wasm(new_wasm_hash);
        Ok(())
    }

    pub fn get_current_yield_bps(env: Env) -> u32 {
        env.storage().persistent().get(&KEY_RATE).unwrap_or(0)
    }

    /// Rate plus observation provenance (#1512): additive alongside
    /// `get_current_yield_bps`, which keeps returning just the bare rate.
    /// `observed_at == 0` means no `set_yield_bps`/`initialize` call has
    /// ever landed on this instance — callers must treat that as maximally
    /// stale, not as a real timestamp.
    pub fn get_oracle_reading(env: Env) -> OracleReading {
        let rate_bps = env.storage().persistent().get(&KEY_RATE).unwrap_or(0);
        let observed_at = env.storage().persistent().get(&KEY_OBSERVED_AT).unwrap_or(0);
        OracleReading {
            rate_bps,
            observed_at,
            source_version: ORACLE_CONTRACT_VERSION,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use soroban_sdk::{
        Env,
        testutils::{Address as _, Ledger as _},
    };

    fn setup(initial_rate: u32) -> (Env, OracleContractClient<'static>) {
        let env = Env::default();
        env.mock_all_auths();
        let contract_id = env.register(OracleContract, ());
        let admin = Address::generate(&env);
        let client = OracleContractClient::new(&env, &contract_id);
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
        assert_eq!(
            client.try_initialize(&other, &300),
            Err(Ok(OracleError::AlreadyInitialized))
        );
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
        assert_eq!(
            client.try_set_yield_bps(&(DEFAULT_MAX_YIELD_BPS + 1)),
            Err(Ok(OracleError::RateTooHigh))
        );
        assert_eq!(client.get_current_yield_bps(), 500);
    }

    #[test]
    fn set_yield_bps_u32_max_returns_rate_too_high() {
        let (_env, client) = setup(500);
        assert_eq!(
            client.try_set_yield_bps(&u32::MAX),
            Err(Ok(OracleError::RateTooHigh))
        );
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
        assert_eq!(
            client.try_set_yield_bps(&2_000),
            Err(Ok(OracleError::RateTooHigh))
        );
    }

    #[test]
    fn initialize_above_ceiling_returns_rate_too_high() {
        let env = Env::default();
        env.mock_all_auths();
        let contract_id = env.register(OracleContract, ());
        let admin = Address::generate(&env);
        let client = OracleContractClient::new(&env, &contract_id);
        assert_eq!(
            client.try_initialize(&admin, &(DEFAULT_MAX_YIELD_BPS + 1)),
            Err(Ok(OracleError::RateTooHigh))
        );
    }

    #[test]
    fn propose_and_accept_admin_flow() {
        let (env, client) = setup(500);
        let new_admin = Address::generate(&env);

        // Only admin can propose
        env.set_auths(&[]);
        assert!(client.try_propose_admin(&new_admin).is_err());

        env.mock_all_auths();
        client.propose_admin(&new_admin);

        // Only new admin can accept
        env.set_auths(&[]);
        assert!(client.try_accept_admin().is_err());

        env.mock_all_auths();
        client.accept_admin();

        // Verify setting yield bps works (requires new admin auth)
        client.set_yield_bps(&600);
        assert_eq!(client.get_current_yield_bps(), 600);
    }

    #[test]
    fn accept_admin_fails_if_none_pending() {
        let (_env, client) = setup(500);
        assert_eq!(
            client.try_accept_admin(),
            Err(Ok(OracleError::NoPendingAdmin))
        );
    }

    #[test]
    fn set_max_rate_above_hard_ceiling_returns_rate_too_high() {
        let (_env, client) = setup(500);
        assert_eq!(
            client.try_set_max_rate(&(MAX_MAX_RATE_BPS + 1)),
            Err(Ok(OracleError::RateTooHigh))
        );
        assert_eq!(client.get_max_yield_bps(), DEFAULT_MAX_YIELD_BPS);
    }

    #[test]
    fn set_max_rate_at_hard_ceiling_is_accepted() {
        let (_env, client) = setup(500);
        client.set_max_rate(&MAX_MAX_RATE_BPS);
        assert_eq!(client.get_max_yield_bps(), MAX_MAX_RATE_BPS);
    }

    // ── Coverage added for issue #1144 ────────────────────────────────────

    #[test]
    fn set_yield_bps_before_initialize_returns_not_initialized() {
        let env = Env::default();
        env.mock_all_auths();
        let contract_id = env.register(OracleContract, ());
        let client = OracleContractClient::new(&env, &contract_id);

        assert_eq!(
            client.try_set_yield_bps(&500),
            Err(Ok(OracleError::NotInitialized))
        );
    }

    #[test]
    fn set_yield_bps_without_admin_auth_is_rejected() {
        let (env, client) = setup(500);

        // Drop mocked auths so the admin's signature is genuinely required;
        // a non-admin caller cannot supply it.
        env.set_auths(&[]);

        let result = client.try_set_yield_bps(&600);
        assert!(
            result.is_err(),
            "set_yield_bps without the admin's authorization must be rejected"
        );
        assert_eq!(
            client.get_current_yield_bps(),
            500,
            "rate must be unchanged after a rejected call"
        );
    }

    // ── Coverage added for issue #1512 (freshness metadata) ───────────────

    #[test]
    fn initialize_records_observed_at() {
        let env = Env::default();
        env.mock_all_auths();
        env.ledger().with_mut(|li| li.timestamp = 1_000);
        let contract_id = env.register(OracleContract, ());
        let admin = Address::generate(&env);
        let client = OracleContractClient::new(&env, &contract_id);
        client.initialize(&admin, &500);

        let reading = client.get_oracle_reading();
        assert_eq!(reading.rate_bps, 500);
        assert_eq!(reading.observed_at, 1_000);
        assert_eq!(reading.source_version, ORACLE_CONTRACT_VERSION);
    }

    #[test]
    fn set_yield_bps_updates_observed_at() {
        let env = Env::default();
        env.mock_all_auths();
        env.ledger().with_mut(|li| li.timestamp = 1_000);
        let contract_id = env.register(OracleContract, ());
        let admin = Address::generate(&env);
        let client = OracleContractClient::new(&env, &contract_id);
        client.initialize(&admin, &500);

        env.ledger().with_mut(|li| li.timestamp = 2_500);
        client.set_yield_bps(&750);

        let reading = client.get_oracle_reading();
        assert_eq!(reading.rate_bps, 750);
        assert_eq!(reading.observed_at, 2_500);
    }

    #[test]
    fn get_oracle_reading_before_initialize_reports_no_observation() {
        let env = Env::default();
        env.mock_all_auths();
        let contract_id = env.register(OracleContract, ());
        let client = OracleContractClient::new(&env, &contract_id);

        let reading = client.get_oracle_reading();
        assert_eq!(reading.rate_bps, 0);
        assert_eq!(
            reading.observed_at, 0,
            "no set_yield_bps/initialize call has ever landed — observed_at must read as 0, not a real timestamp"
        );
    }

    #[test]
    fn set_yield_bps_rejected_above_ceiling_leaves_observed_at_unchanged() {
        let env = Env::default();
        env.mock_all_auths();
        env.ledger().with_mut(|li| li.timestamp = 1_000);
        let contract_id = env.register(OracleContract, ());
        let admin = Address::generate(&env);
        let client = OracleContractClient::new(&env, &contract_id);
        client.initialize(&admin, &500);

        env.ledger().with_mut(|li| li.timestamp = 9_999);
        let _ = client.try_set_yield_bps(&(DEFAULT_MAX_YIELD_BPS + 1));

        let reading = client.get_oracle_reading();
        assert_eq!(
            reading.observed_at, 1_000,
            "a rejected set_yield_bps must not advance the observation timestamp"
        );
    }
}
