#[cfg(test)]
mod snapshot_tests {
    use crate::storage::DataKey;
    use soroban_sdk::{Env, TryFromVal, TryIntoVal};
    use soroban_sdk::xdr::{ScVal, ToXdr};

    fn to_xdr<T: TryIntoVal<Env, soroban_sdk::Val>>(env: &Env, val: T) -> soroban_sdk::Bytes {
        let v = val.try_into_val(env).expect("Val");
        ScVal::try_from_val(env, &v).expect("ScVal").to_xdr(env)
    }

    /// DataKey::Paid(u64) is the idempotency guard stored per payout id.
    /// Any change to this enum's discriminant or shape breaks existing ledger
    /// entries, causing already-paid IDs to be treated as unpaid.
    #[test]
    fn snapshot_data_key_paid() {
        let env = Env::default();
        let zero = to_xdr(&env, DataKey::Paid(0u64));
        let one = to_xdr(&env, DataKey::Paid(1u64));
        let max = to_xdr(&env, DataKey::Paid(u64::MAX));

        // All variants must serialise to non-empty XDR.
        assert!(zero.len() > 0);
        // Different values must produce different XDR (no hash collision in the key space).
        assert_ne!(zero, one);
        assert_ne!(one, max);

        // To capture the actual byte arrays for a hard-coded snapshot, run:
        //   cargo test snapshot_data_key_paid -- --nocapture
        // and record the printed hex in place of these structural assertions.
    }
}
