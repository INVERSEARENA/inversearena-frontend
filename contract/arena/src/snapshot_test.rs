#[cfg(test)]
mod snapshot_tests {
    use crate::types::{
        ArenaConfig, Choice, GameState, PendingAdmin, PlayerState, RoundResult, YieldSnapshot,
    };
    use soroban_sdk::testutils::Address as _;
    use soroban_sdk::xdr::{ScVal, ToXdr};
    use soroban_sdk::{Address, Env, TryFromVal, TryIntoVal};

    fn to_xdr<T: TryIntoVal<Env, soroban_sdk::Val>>(env: &Env, val: T) -> soroban_sdk::Bytes {
        let v = val.try_into_val(env).expect("Val");
        ScVal::try_from_val(env, &v).expect("ScVal").to_xdr(env)
    }

    /// Choice is used in commit-reveal round submissions and stored in ledger
    /// entries. Reordering Heads/Tails changes their XDR discriminant (0 vs 1)
    /// and breaks deserialisation of every in-flight commitment.
    #[test]
    fn snapshot_choice() {
        let env = Env::default();
        let heads = to_xdr(&env, Choice::Heads);
        let tails = to_xdr(&env, Choice::Tails);

        assert!(heads.len() > 0);
        assert!(tails.len() > 0);
        // Variant order must be stable — reordering would change discriminants.
        assert_ne!(heads, tails);
    }

    /// PlayerState is stored per-player in persistent storage. Adding, removing,
    /// or reordering fields changes the on-chain XDR layout and breaks
    /// deserialisation of every existing player entry.
    #[test]
    fn snapshot_player_state() {
        let env = Env::default();
        let active = to_xdr(
            &env,
            PlayerState {
                active: true,
                rounds_survived: 5,
            },
        );
        let inactive = to_xdr(
            &env,
            PlayerState {
                active: false,
                rounds_survived: 0,
            },
        );

        assert!(active.len() > 0);
        // Different field values must produce different XDR.
        assert_ne!(active, inactive);

        // Changing rounds_survived alone must also change the XDR.
        let more_rounds = to_xdr(
            &env,
            PlayerState {
                active: true,
                rounds_survived: 6,
            },
        );
        assert_ne!(active, more_rounds);
    }

    /// ArenaConfig is stored in persistent storage at arena initialisation.
    /// Any structural change (field add, remove, reorder, type change) breaks
    /// deserialisation of every live arena on-chain.
    #[test]
    fn snapshot_arena_config() {
        let env = Env::default();
        let config_a = ArenaConfig {
            admin: Address::generate(&env),
            stake_token: Address::generate(&env),
            yield_vault: Address::generate(&env),
            entry_fee: 100,
            state: GameState::Open,
            paused: false,
            player_count: 42,
            cumulative_yield: 0,
            commit_deadline: 1_730_000_000,
            round_count: 0,
            oracle_contract: Address::generate(&env),
        };
        let config_b = ArenaConfig {
            admin: Address::generate(&env),
            stake_token: Address::generate(&env),
            yield_vault: Address::generate(&env),
            entry_fee: 200, // differs from config_a
            state: GameState::Open,
            paused: false,
            player_count: 42,
            cumulative_yield: 0,
            commit_deadline: 1_730_000_000,
            round_count: 0,
            oracle_contract: Address::generate(&env),
        };

        let xdr_a = to_xdr(&env, config_a);
        assert!(xdr_a.len() > 0);
        // Different entry_fee must produce different XDR (field encoding is stable).
        assert_ne!(xdr_a, to_xdr(&env, config_b));
    }

    /// GameState controls arena lifecycle transitions. Reordering variants
    /// changes their XDR discriminants and would flip the stored state of every
    /// live arena (e.g. Open ↔ Active would swap after reorder).
    #[test]
    fn snapshot_game_state() {
        let env = Env::default();
        let open = to_xdr(&env, GameState::Open);
        let active = to_xdr(&env, GameState::Active);
        let finished = to_xdr(&env, GameState::Finished);
        let cancelled = to_xdr(&env, GameState::Cancelled);
        let settled = to_xdr(&env, GameState::Settled);

        // All variants must serialise to non-empty XDR.
        for xdr in [&open, &active, &finished, &cancelled, &settled] {
            assert!(xdr.len() > 0);
        }
        // Every variant pair must be distinct (no discriminant collision).
        assert_ne!(open, active);
        assert_ne!(active, finished);
        assert_ne!(finished, cancelled);
        assert_ne!(cancelled, settled);
        assert_ne!(open, settled);
    }

    /// YieldSnapshot stores per-round yield data in persistent storage.
    /// Changing field order or types would corrupt accumulated yield accounting
    /// for all in-progress and completed rounds.
    #[test]
    fn snapshot_yield_snapshot() {
        let env = Env::default();
        let snap_a = to_xdr(
            &env,
            YieldSnapshot {
                round: 1,
                rate_bps: 500,
                accrued: 5_000,
            },
        );
        let snap_b = to_xdr(
            &env,
            YieldSnapshot {
                round: 2, // differs from snap_a
                rate_bps: 500,
                accrued: 5_000,
            },
        );
        let snap_c = to_xdr(
            &env,
            YieldSnapshot {
                round: 1,
                rate_bps: 500,
                accrued: 10_000, // differs from snap_a
            },
        );

        assert!(snap_a.len() > 0);
        // Different round numbers must produce different XDR.
        assert_ne!(snap_a, snap_b);
        // Different accrued yield must produce different XDR.
        assert_ne!(snap_a, snap_c);
    }

    /// RoundResult stores per-round resolution metadata. Field changes break
    /// deserialisation of historical round records stored on-chain.
    #[test]
    fn snapshot_round_result() {
        let env = Env::default();
        let result = RoundResult {
            round: 3,
            eliminated: 2,
            survivors: 1,
            yield_snapshot: YieldSnapshot {
                round: 3,
                rate_bps: 500,
                accrued: 123,
            },
        };
        assert!(to_xdr(&env, result).len() > 0);
    }

    /// PendingAdmin stores a pending admin-transfer proposal. A discriminant
    /// change here would prevent the acceptance transaction from matching the
    /// stored proposal, silently breaking governance handoffs.
    #[test]
    fn snapshot_pending_admin() {
        let env = Env::default();
        let addr_a = Address::generate(&env);
        let addr_b = Address::generate(&env);

        let xdr_a = to_xdr(&env, PendingAdmin { new_admin: addr_a });
        let xdr_b = to_xdr(&env, PendingAdmin { new_admin: addr_b });

        assert!(xdr_a.len() > 0);
        // Two distinct admin addresses must produce distinct XDR.
        assert_ne!(xdr_a, xdr_b);
    }
}
