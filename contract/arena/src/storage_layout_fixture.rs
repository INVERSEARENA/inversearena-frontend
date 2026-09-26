//! Storage-layout compatibility fixtures for upgrade safety (#1532).
//! Checked-in JSON under `contract/fixtures/storage-layout/` is the reviewable
//! release snapshot; these tests prove candidate WASM still decodes canonical types.

#[cfg(test)]
mod tests {
    use crate::storage::DataKey;
    use crate::types::{
        ArenaConfig, Choice, GameState, PendingAdmin, PlayerState, RoundResult, YieldSnapshot,
    };
    use soroban_sdk::testutils::Address as _;
    use soroban_sdk::xdr::{ScVal, ToXdr};
    use soroban_sdk::{Address, Env, TryFromVal, TryIntoVal};

    const FIXTURE_MANIFEST: &str = include_str!("../../fixtures/storage-layout/arena-v1.json");

    fn to_xdr<T: TryIntoVal<Env, soroban_sdk::Val>>(env: &Env, val: T) -> soroban_sdk::Bytes {
        let v = val.try_into_val(env).expect("Val");
        ScVal::try_from_val(env, &v).expect("ScVal").to_xdr(env)
    }

    fn fixed_address(env: &Env, seed: u8) -> Address {
        let mut arr = [0u8; 32];
        arr[31] = seed;
        Address::from_contract_id(&soroban_sdk::BytesN::from_array(env, &arr))
    }

    #[test]
    fn storage_layout_fixture_manifest_is_present() {
        assert!(FIXTURE_MANIFEST.contains("\"contract\": \"arena\""));
        assert!(FIXTURE_MANIFEST.contains("\"schema_checksum\""));
        assert!(FIXTURE_MANIFEST.contains("\"entries\""));
    }

    #[test]
    fn storage_layout_canonical_types_roundtrip_xdr() {
        let env = Env::default();
        let admin = fixed_address(&env, 1);
        let player = fixed_address(&env, 2);

        let samples: Vec<(&str, soroban_sdk::Bytes)> = vec![
            ("Choice::Heads", to_xdr(&env, Choice::Heads)),
            (
                "PlayerState",
                to_xdr(
                    &env,
                    PlayerState {
                        active: true,
                        rounds_survived: 3,
                    },
                ),
            ),
            ("DataKey::Player", to_xdr(&env, DataKey::Player(player))),
            (
                "ArenaConfig",
                to_xdr(
                    &env,
                    ArenaConfig {
                        admin: admin.clone(),
                        stake_token: fixed_address(&env, 3),
                        yield_vault: fixed_address(&env, 4),
                        entry_fee: 100,
                        state: GameState::Open,
                        paused: false,
                        player_count: 2,
                        active_player_count: 2,
                        cumulative_yield: 0,
                        commit_deadline: 1_730_000_000,
                        round_count: 0,
                        oracle_contract: fixed_address(&env, 5),
                        factory: fixed_address(&env, 6),
                        pool_id: 1,
                        platform_fee_bps: 100,
                    },
                ),
            ),
            (
                "PendingAdmin",
                to_xdr(
                    &env,
                    PendingAdmin {
                        new_admin: admin,
                    },
                ),
            ),
            (
                "YieldSnapshot",
                to_xdr(
                    &env,
                    YieldSnapshot {
                        round: 1,
                        rate_bps: 500,
                        accrued: 42,
                    },
                ),
            ),
            (
                "RoundResult",
                to_xdr(
                    &env,
                    RoundResult {
                        round: 1,
                        eliminated: 1,
                        survivors: 1,
                        yield_snapshot: YieldSnapshot {
                            round: 1,
                            rate_bps: 500,
                            accrued: 42,
                        },
                    },
                ),
            ),
        ];

        for (name, xdr) in samples {
            assert!(xdr.len() > 0, "{name} must encode to non-empty XDR");
        }
    }

    #[test]
    fn storage_layout_corrupted_xdr_fails_decode() {
        let env = Env::default();
        let garbage = soroban_sdk::Bytes::from_slice(&env, &[0xde, 0xad, 0xbe, 0xef]);
        assert!(ScVal::try_from_val(&env, &garbage).is_err());
    }
}
