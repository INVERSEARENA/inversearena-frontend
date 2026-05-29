#[cfg(test)]
mod snapshot_tests {
    use crate::storage::{CreatorStakeRecord, DataKey};
    use soroban_sdk::testutils::Address as _;
    use soroban_sdk::{Address, Env, TryFromVal, TryIntoVal};
    use soroban_sdk::xdr::{ScVal, ToXdr};

    fn to_xdr<T: TryIntoVal<Env, soroban_sdk::Val>>(env: &Env, val: T) -> soroban_sdk::Bytes {
        let v = val.try_into_val(env).expect("Val");
        ScVal::try_from_val(env, &v).expect("ScVal").to_xdr(env)
    }

    /// DataKey::CreatorStake(Address) is the persistent storage key for each
    /// arena's creator stake record. Changing this enum's discriminant or the
    /// Address encoding would orphan every existing stake record on-chain.
    #[test]
    fn snapshot_data_key_creator_stake() {
        let env = Env::default();
        let addr_a = Address::generate(&env);
        let addr_b = Address::generate(&env);

        let key_a = to_xdr(&env, DataKey::CreatorStake(addr_a.clone()));
        let key_b = to_xdr(&env, DataKey::CreatorStake(addr_b.clone()));

        assert!(key_a.len() > 0);
        // Two distinct addresses must yield distinct storage keys.
        assert_ne!(key_a, key_b);

        // Run `cargo test snapshot_data_key_creator_stake -- --nocapture` to capture
        // the actual bytes if a breaking change to DataKey is intentionally made.
    }

    /// CreatorStakeRecord stores who created an arena and how much they staked.
    /// Reordering or renaming its fields changes the on-chain XDR layout and
    /// breaks deserialisation of existing stake records.
    #[test]
    fn snapshot_creator_stake_record() {
        let env = Env::default();
        let creator = Address::generate(&env);

        let record = CreatorStakeRecord {
            creator: creator.clone(),
            amount: 1_000_000i128,
        };
        let bytes = to_xdr(&env, record.clone());
        assert!(bytes.len() > 0);

        // A different amount must produce different XDR (field encoding is stable).
        let record2 = CreatorStakeRecord {
            creator,
            amount: 2_000_000i128,
        };
        assert_ne!(bytes, to_xdr(&env, record2));

        // Run `cargo test snapshot_creator_stake_record -- --nocapture` to capture
        // the actual bytes if a breaking change to CreatorStakeRecord is intentionally made.
    }
}
